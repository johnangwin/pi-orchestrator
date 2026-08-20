import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { estimateTokens, type Decision } from "./brief.js";
import {
  runPlanningConsultations,
  type RunPlanningConsultationsResult,
} from "./consultation.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import type { LocalConfig } from "./local.js";
import { MessageSchema } from "./message.js";
import {
  resolveRoleModelRoute,
  ResolvedModelRouteSchema,
  type ResolvedModelRoute,
} from "./model.js";
import type { OpenShellPreflight } from "./openshell.js";
import {
  PlanningStore,
  requireCleanPlanningProject,
  type PlanningDecisionRecord,
  type PlanningQuestionnaire,
  type PlanningQuestionnaireRecord,
  type PlanningSession,
  type PlanningSessionLauncher,
  type PlanningState,
} from "./planning.js";
import { loadSandboxPolicy } from "./policy.js";
import {
  resolveRolePermissionCeiling,
  roleHasReadSource,
  type PermissionCeiling,
} from "./permission.js";
import {
  PlanTaskSchema,
  SourceAnchorSchema,
  TasksFileSchema,
  catalogFromConfig,
  loadPlan,
  validatePlanDraft,
  type SourceAnchor,
  type ValidatedPlanDraft,
} from "./plan.js";
import type { Project } from "./project.js";
import {
  createReport,
  ReportSchema,
  ReportStore,
  type Report,
} from "./report.js";
import type { LoadedRole } from "./role.js";
import {
  bundledPiPolicyDirectory,
  startReadSession,
  type ReadSessionInfo,
  type ReadSessionOpenShell,
} from "./agent.js";
import {
  ModelTurnResultSchema,
  SessionIdentitySchema,
  sameSessionIdentity,
  type ModelTurnResult,
  type SessionIdentity,
} from "./session.js";
import {
  createPlanningSource,
  isReadOnlySourceWorkspace,
  planningSourcePaths,
  verifyPlanningSource,
  workspaceProjectionMatches,
  WorkspaceSessionProjectionSchema,
  type PlanningSource,
  type PlanningSourceManifest,
  type SourceWorkspaceFactory,
} from "./source.js";
import type { ProjectStore } from "./state.js";
import { syncDirectory, writeJsonAtomic } from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const HumanTextSchema = z.string().trim().min(1).max(16_384);
const BoundedTextSchema = z.string().trim().min(1).max(4_000);
const TextListSchema = z.array(BoundedTextSchema).max(64);
const PlanningStageSchema = z.enum(["critique", "synthesis"]);
export type PlanningStage = z.infer<typeof PlanningStageSchema>;

const CritiqueFindingSchema = z
  .object({
    id: IdentifierSchema,
    finding: BoundedTextSchema,
    evidence: z.array(SourceAnchorSchema).min(1).max(32),
    required_correction: BoundedTextSchema,
  })
  .strict();

export const PlanningCritiqueSchema = z
  .object({
    version: z.literal(1),
    role: z.literal("critic"),
    verdict: z.enum(["accept", "revise"]),
    conclusion: HumanTextSchema,
    strengths: TextListSchema,
    blocking_findings: z.array(CritiqueFindingSchema).max(32),
    tensions: TextListSchema,
    improvements: TextListSchema,
    source_anchors: z.array(SourceAnchorSchema).min(1).max(128),
    unresolved_questions: TextListSchema,
  })
  .strict()
  .superRefine((critique, context) => {
    const ids = critique.blocking_findings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["blocking_findings"],
        message: "finding identifiers must be unique",
      });
    }
    if (
      (critique.verdict === "accept") !==
      (critique.blocking_findings.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message:
          "accept requires no blocking findings and revise requires at least one",
      });
    }
  });
export type PlanningCritique = z.infer<typeof PlanningCritiqueSchema>;

const CritiqueResolutionSchema = z
  .object({
    finding: IdentifierSchema,
    resolution: BoundedTextSchema,
  })
  .strict();

export const PlanSynthesisOutputSchema = z
  .object({
    version: z.literal(1),
    role: z.literal("lead"),
    plan_id: IdentifierSchema,
    revision: z.number().int().positive(),
    plan_markdown: z
      .string()
      .trim()
      .min(1)
      .max(32 * 1024)
      .transform((value) => `${value}\n`),
    tasks: z.array(PlanTaskSchema).min(1).max(128),
    critique_resolutions: z.array(CritiqueResolutionSchema).max(32),
    synthesis_summary: HumanTextSchema,
    source_anchors: z.array(SourceAnchorSchema).min(1).max(128),
  })
  .strict()
  .superRefine((output, context) => {
    const taskIds = output.tasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Task identifiers must be unique",
      });
    }
    const findingIds = output.critique_resolutions.map(
      (resolution) => resolution.finding,
    );
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        path: ["critique_resolutions"],
        message: "Critique finding resolutions must be unique",
      });
    }
  });
export type PlanSynthesisOutput = z.infer<typeof PlanSynthesisOutputSchema>;

const PlanningBriefArtifactSchema = z
  .object({
    version: z.literal(1),
    content: z.string().min(1),
    digest: DigestSchema,
  })
  .strict();
type PlanningBriefArtifact = z.infer<typeof PlanningBriefArtifactSchema>;

const PlanningStageRequestWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: IdentifierSchema,
    stage: PlanningStageSchema,
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    goal_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    decisions_digest: DigestSchema,
    consultations: z
      .object({
        architecture: DigestSchema,
        quant: DigestSchema,
      })
      .strict(),
    critique_digest: DigestSchema.nullable(),
    base_commit: GitCommitSchema,
    source_digest: DigestSchema,
    source_entries: z.number().int().positive(),
    role: z.object({ name: IdentifierSchema, digest: DigestSchema }).strict(),
    permission_ceiling_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    policy_digest: DigestSchema,
    brief_digest: DigestSchema,
    message_id: IdentifierSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.stage === "critique") !== (request.critique_digest === null)) {
      context.addIssue({
        code: "custom",
        path: ["critique_digest"],
        message: "must be absent for criticism and present for synthesis",
      });
    }
  });

export const PlanningStageRequestSchema =
  PlanningStageRequestWithoutDigestSchema.extend({
    request_digest: DigestSchema,
  }).strict();
export type PlanningStageRequest = z.infer<typeof PlanningStageRequestSchema>;

const PlanningTurnSchema = ModelTurnResultSchema.pick({
  message_ids: true,
  model_profile: true,
  requested_model: true,
  response_model: true,
  stop_reason: true,
  truncated: true,
  usage: true,
});

const PlanningCritiqueRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: IdentifierSchema,
    stage: z.literal("critique"),
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    request_digest: DigestSchema,
    goal_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    decisions_digest: DigestSchema,
    consultations: z
      .object({
        architecture: DigestSchema,
        quant: DigestSchema,
      })
      .strict(),
    base_commit: GitCommitSchema,
    source_digest: DigestSchema,
    role_digest: DigestSchema,
    permission_ceiling_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    policy_digest: DigestSchema,
    brief_digest: DigestSchema,
    sandbox: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        workspace: z.string().min(1),
        projection: WorkspaceSessionProjectionSchema.optional(),
      })
      .strict(),
    output: PlanningCritiqueSchema,
    response: z
      .string()
      .min(1)
      .max(56 * 1024),
    response_digest: DigestSchema,
    turn: PlanningTurnSchema,
    report: ReportSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const PlanningCritiqueRecordSchema =
  PlanningCritiqueRecordWithoutDigestSchema.extend({
    record_digest: DigestSchema,
  }).strict();
export type PlanningCritiqueRecord = z.infer<
  typeof PlanningCritiqueRecordSchema
>;

const PlanDraftManifestWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: IdentifierSchema,
    plan: z
      .object({
        id: IdentifierSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    base_commit: GitCommitSchema,
    source_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    consultations: z
      .object({
        architecture: DigestSchema,
        quant: DigestSchema,
      })
      .strict(),
    critique_digest: DigestSchema,
    plan_markdown_digest: DigestSchema,
    tasks_yaml_digest: DigestSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const PlanDraftManifestSchema =
  PlanDraftManifestWithoutDigestSchema.extend({
    manifest_digest: DigestSchema,
  }).strict();
export type PlanDraftManifest = z.infer<typeof PlanDraftManifestSchema>;

const PlanSynthesisRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: IdentifierSchema,
    stage: z.literal("synthesis"),
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    request_digest: DigestSchema,
    goal_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    decisions_digest: DigestSchema,
    consultations: z
      .object({
        architecture: DigestSchema,
        quant: DigestSchema,
      })
      .strict(),
    critique_digest: DigestSchema,
    base_commit: GitCommitSchema,
    source_digest: DigestSchema,
    role_digest: DigestSchema,
    permission_ceiling_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    policy_digest: DigestSchema,
    brief_digest: DigestSchema,
    sandbox: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        workspace: z.string().min(1),
        projection: WorkspaceSessionProjectionSchema.optional(),
      })
      .strict(),
    output: PlanSynthesisOutputSchema,
    response: z
      .string()
      .min(1)
      .max(56 * 1024),
    response_digest: DigestSchema,
    turn: PlanningTurnSchema,
    draft: PlanDraftManifestSchema,
    report: ReportSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const PlanSynthesisRecordSchema =
  PlanSynthesisRecordWithoutDigestSchema.extend({
    record_digest: DigestSchema,
  }).strict();
export type PlanSynthesisRecord = z.infer<typeof PlanSynthesisRecordSchema>;

export interface CompiledPlanningStageBrief {
  readonly content: string;
  readonly digest: Digest;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly omissions: readonly string[];
}

export interface RunPlanSynthesisOptions {
  readonly store: Pick<ProjectStore, "planningDirectory">;
  readonly project: Project;
  readonly local: LocalConfig;
  readonly clients: Readonly<{
    critic: ReadSessionOpenShell;
    lead: ReadSessionOpenShell;
  }>;
  readonly planningId: string;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly nonce?: (stage: PlanningStage, attempt: number) => string;
  readonly launchSession?: PlanningSessionLauncher;
  readonly workspaceFactory?: SourceWorkspaceFactory;
}

export interface RunPlanSynthesisResult {
  readonly state: PlanningState;
  readonly critique: {
    readonly request: PlanningStageRequest;
    readonly record: PlanningCritiqueRecord;
    readonly reused: boolean;
  };
  readonly synthesis: {
    readonly request: PlanningStageRequest;
    readonly record: PlanSynthesisRecord;
    readonly plan: ValidatedPlanDraft;
    readonly directory: string;
    readonly reused: boolean;
  };
}

const CRITIQUE_OUTPUT_CONTRACT = `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "version": 1,
  "role": "critic",
  "verdict": "accept",
  "conclusion": "independent conclusion",
  "strengths": ["well-supported aspect"],
  "blocking_findings": [{
    "id": "stable-finding-id",
    "finding": "material problem",
    "evidence": [{"path":"tracked/file","symbol":"optional symbol","reason":"evidence"}],
    "required_correction": "what Lead synthesis must correct"
  }],
  "tensions": ["conflict between specialist conclusions"],
  "improvements": ["non-blocking improvement"],
  "source_anchors": [{"path":"tracked/file","symbol":"optional symbol","reason":"evidence"}],
  "unresolved_questions": ["question that cannot be resolved from supplied evidence"]
}

Inspect /workspace/project. Evaluate the frozen Architecture and Quant Reports against the goal, questionnaire, accepted Decisions, current repository, and non-goals. Use verdict "accept" only with zero blocking_findings; otherwise use "revise". Use only tracked paths in evidence and source_anchors. Return no prose outside the object.`;

const SYNTHESIS_OUTPUT_CONTRACT = `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "version": 1,
  "role": "lead",
  "plan_id": "descriptive-plan-id",
  "revision": 1,
  "plan_markdown": "# Plan name\\n\\n## Context\\n...",
  "tasks": [{
    "id": "descriptive-task-id",
    "title": "Bounded task title",
    "role": "implementer",
    "goal": "bounded implementation goal",
    "depends": [],
    "write_paths": ["src"],
    "scope": ["src/**"],
    "non_goals": ["explicit exclusion"],
    "acceptance": ["observable acceptance criterion"],
    "checks": ["registered-check-id"],
    "reviews": ["spec", "architecture", "quality"]
  }],
  "critique_resolutions": [{"finding":"stable-finding-id","resolution":"how the draft resolves it"}],
  "synthesis_summary": "how the evidence became this Plan",
  "source_anchors": [{"path":"tracked/file","symbol":"optional symbol","reason":"evidence"}]
}

The plan_markdown value must contain these sections in order: Context, Goal, Non-goals, Current structure, Proposed direction, Architecture, Quantitative implications, Risks, Open questions. Use only configured Roles and registered Check identifiers shown in the Brief. Every Task must require spec, architecture, and quality Reviews; also require quant when the Quant Report says applicability is material. Resolve every blocking critic finding exactly once. Keep Tasks bounded, preserve explicit non-goals, and do not implement future architecture prematurely. Return no prose outside the object.`;

function section(title: string, content: string): string {
  return `## ${title}\n\n${content.trim()}\n`;
}

function decisionsDigest(records: readonly PlanningDecisionRecord[]): Digest {
  return digestParts("pi-orchestrator/planning-synthesis-decisions/v1", [
    ["decisions", canonicalJson(records)],
  ]);
}

function consultationDigests(consultations: RunPlanningConsultationsResult): {
  readonly architecture: Digest;
  readonly quant: Digest;
} {
  return {
    architecture: consultations.consultations.find(
      (item) => item.role === "architecture",
    )!.record.record_digest as Digest,
    quant: consultations.consultations.find((item) => item.role === "quant")!
      .record.record_digest as Digest,
  };
}

function planningBriefDigest(content: string): Digest {
  return digestParts("pi-orchestrator/planning-stage-brief/v1", [
    ["brief.md", content],
  ]);
}

function stageRequestDigest(
  request: z.infer<typeof PlanningStageRequestWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-stage-request/v1", [
    ["request", canonicalJson(request)],
  ]);
}

function critiqueRecordDigest(
  record: z.infer<typeof PlanningCritiqueRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-critique-record/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function draftManifestDigest(
  manifest: z.infer<typeof PlanDraftManifestWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/plan-draft-manifest/v1", [
    ["manifest", canonicalJson(manifest)],
  ]);
}

function synthesisRecordDigest(
  record: z.infer<typeof PlanSynthesisRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/plan-synthesis-record/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function consultationReports(
  consultations: RunPlanningConsultationsResult,
): string {
  return consultations.consultations
    .map(
      (item) =>
        `### ${item.role}\n\nRecord digest: ${item.record.record_digest}\nReport digest: ${item.record.report.content_digest}\n\n${item.record.report.content}`,
    )
    .join("\n\n");
}

function configuredPlanningCatalog(project: Project): string {
  return canonicalJson({
    roles: project.config.roles,
    checks: project.config.checks,
  });
}

export function compileCritiqueBrief(input: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaire;
  readonly decisions: readonly Decision[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly source: PlanningSourceManifest;
  readonly contextLimitTokens: number;
}): CompiledPlanningStageBrief {
  return compileStageBrief({
    title: "Independent Planning Critique Brief",
    identity: input.identity,
    project: input.project,
    role: input.role,
    permissionCeiling: input.permissionCeiling,
    model: input.model,
    state: input.state,
    questionnaire: input.questionnaire,
    decisions: input.decisions,
    consultations: input.consultations,
    source: input.source,
    contextLimitTokens: input.contextLimitTokens,
    outputContract: CRITIQUE_OUTPUT_CONTRACT,
  });
}

export function compileSynthesisBrief(input: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaire;
  readonly decisions: readonly Decision[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique: PlanningCritiqueRecord;
  readonly source: PlanningSourceManifest;
  readonly contextLimitTokens: number;
}): CompiledPlanningStageBrief {
  return compileStageBrief({
    title: "Lead Plan Synthesis Brief",
    identity: input.identity,
    project: input.project,
    role: input.role,
    permissionCeiling: input.permissionCeiling,
    model: input.model,
    state: input.state,
    questionnaire: input.questionnaire,
    decisions: input.decisions,
    consultations: input.consultations,
    critique: input.critique,
    source: input.source,
    contextLimitTokens: input.contextLimitTokens,
    outputContract: SYNTHESIS_OUTPUT_CONTRACT,
  });
}

function compileStageBrief(input: {
  readonly title: string;
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaire;
  readonly decisions: readonly Decision[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique?: PlanningCritiqueRecord;
  readonly source: PlanningSourceManifest;
  readonly contextLimitTokens: number;
  readonly outputContract: string;
}): CompiledPlanningStageBrief {
  const budgetTokens = Math.max(
    1,
    Math.floor(
      input.contextLimitTokens * input.project.config.context.initial_fraction,
    ),
  );
  const required = [
    section(
      "Identity",
      `Planning: ${input.identity.run}\nAgent: ${input.identity.agent}\nSession: ${input.identity.session}\nGeneration: ${input.identity.generation}`,
    ),
    section("Project Instructions", input.project.agents),
    section(
      "Role",
      `${canonicalJson(input.role.definition)}\n\n${input.role.body}`,
    ),
    section(
      "Permission Ceiling",
      `Digest: ${input.permissionCeiling.permission_ceiling_digest}\n\n${canonicalJson({ source: input.permissionCeiling.source, write_lease: input.permissionCeiling.write_lease, pi_tools: input.permissionCeiling.pi_tools, actions: input.permissionCeiling.actions, assignment: input.permissionCeiling.assignment })}`,
    ),
    section(
      "Model Profile",
      `Profile: ${input.model.profile}\nRoute digest: ${input.model.route_digest}\nConcrete model: ${input.model.pi_model}\nLocality: ${input.model.locality}`,
    ),
    section("Goal", input.state.goal),
    section("Repository Questionnaire", canonicalJson(input.questionnaire)),
    section(
      "Accepted Decisions",
      input.decisions.length === 0
        ? "None."
        : input.decisions.map((decision) => canonicalJson(decision)).join("\n"),
    ),
    section(
      "Frozen Consultation Reports",
      consultationReports(input.consultations),
    ),
    ...(input.critique
      ? [
          section(
            "Frozen Independent Critique",
            `Record digest: ${input.critique.record_digest}\nReport digest: ${input.critique.report.content_digest}\n\n${input.critique.report.content}`,
          ),
          section(
            "Configured Plan Catalog",
            configuredPlanningCatalog(input.project),
          ),
        ]
      : []),
    section(
      "Repository Evidence",
      `The exact committed repository is mounted read-only at /workspace/project.\nCommit: ${input.source.commit}\nSource digest: ${input.source.source_digest}\nTracked entries: ${input.source.entries.length}`,
    ),
    section("Required Output", input.outputContract),
  ];
  let content = `# ${input.title}\n\n${required.join("\n")}`;
  const omissions: string[] = [];
  for (const name of input.role.definition.skills) {
    const skill = input.project.skills.get(name);
    if (!skill) {
      throw new OrchestratorError(
        "unknown_skill",
        `Planning Role references unavailable Skill '${name}'`,
      );
    }
    const candidate = section(`Skill: ${skill.name}`, skill.content);
    if (estimateTokens(`${content}\n${candidate}`) <= budgetTokens) {
      content += `\n${candidate}`;
    } else {
      omissions.push(
        `Skill '${skill.name}' content omitted; retrieve ${skill.path} if required.`,
      );
    }
  }
  if (estimateTokens(content) > budgetTokens) {
    omissions.push(
      `Required context exceeds the initial Brief budget of ${budgetTokens} estimated tokens; constraints were preserved without truncation.`,
    );
  }
  if (omissions.length > 0) {
    content += `\n${section(
      "Explicit Omissions",
      omissions.map((omission) => `- ${omission}`).join("\n"),
    )}`;
  }
  return {
    content,
    digest: planningBriefDigest(content),
    estimatedTokens: estimateTokens(content),
    budgetTokens,
    omissions,
  };
}

function parseJsonObject(text: string, stage: PlanningStage): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fence?.[1] ?? trimmed;
  try {
    const value: unknown = JSON.parse(source);
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("response is not an object");
    }
    return value;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_planning_stage_output",
      `${stage} Session did not return exactly one valid JSON object`,
      { cause: error },
    );
  }
}

function validateAnchors(
  anchors: readonly SourceAnchor[],
  sourcePaths?: ReadonlySet<string>,
): void {
  if (!sourcePaths) return;
  const unknown = anchors
    .map((anchor) => anchor.path)
    .filter((anchorPath) => !sourcePaths.has(anchorPath));
  if (unknown.length > 0) {
    throw new OrchestratorError(
      "invalid_source_anchor",
      `Planning stage references paths absent from the exact source snapshot: ${[...new Set(unknown)].join(", ")}`,
    );
  }
}

export function parsePlanningCritique(
  text: string,
  sourcePaths?: ReadonlySet<string>,
): PlanningCritique {
  const result = PlanningCritiqueSchema.safeParse(
    parseJsonObject(text, "critique"),
  );
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_planning_stage_output",
      `Invalid planning critique: ${result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "critique"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }
  validateAnchors(result.data.source_anchors, sourcePaths);
  for (const finding of result.data.blocking_findings) {
    validateAnchors(finding.evidence, sourcePaths);
  }
  return result.data;
}

export function parsePlanSynthesisOutput(
  text: string,
  sourcePaths?: ReadonlySet<string>,
): PlanSynthesisOutput {
  const result = PlanSynthesisOutputSchema.safeParse(
    parseJsonObject(text, "synthesis"),
  );
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_planning_stage_output",
      `Invalid Plan synthesis: ${result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "synthesis"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }
  validateAnchors(result.data.source_anchors, sourcePaths);
  return result.data;
}

function readOptional(filePath: string): Promise<string | undefined> {
  return readFile(filePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

function parseStored<T>(
  schema: z.ZodType<T>,
  source: string,
  filePath: string,
): T {
  try {
    return schema.parse(JSON.parse(source) as unknown);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_synthesis_store",
      `Invalid planning synthesis evidence at ${filePath}`,
      { cause: error },
    );
  }
}

async function putImmutableJson<T>(
  filePath: string,
  value: T,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.parse(value);
  const existingSource = await readOptional(filePath);
  if (existingSource !== undefined) {
    const existing = parseStored(schema, existingSource, filePath);
    if (canonicalJson(existing) !== canonicalJson(parsed)) {
      throw new OrchestratorError(
        "synthesis_evidence_conflict",
        `Immutable synthesis evidence already exists at ${filePath}`,
      );
    }
    return existing;
  }
  await writeJsonAtomic(filePath, parsed);
  return parsed;
}

async function writeTextAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function putImmutableText(
  filePath: string,
  content: string,
): Promise<void> {
  const existing = await readOptional(filePath);
  if (existing !== undefined) {
    if (existing !== content) {
      throw new OrchestratorError(
        "plan_draft_conflict",
        `Immutable Plan draft already exists at ${filePath}`,
      );
    }
    return;
  }
  await writeTextAtomic(filePath, content);
}

class SynthesisStore {
  private readonly reports: ReportStore;

  constructor(
    private readonly planning: PlanningStore,
    private readonly planningId: string,
  ) {
    this.reports = new ReportStore(planning.directory(planningId));
  }

  private draftRoot(): string {
    return path.join(this.planning.directory(this.planningId), "draft");
  }

  draftDirectory(planId: string): string {
    return path.join(this.draftRoot(), IdentifierSchema.parse(planId));
  }

  private attemptDirectory(stage: PlanningStage, attempt: number): string {
    return path.join(
      this.planning.directory(this.planningId),
      stage,
      "attempts",
      String(z.number().int().positive().parse(attempt)),
    );
  }

  async findPrepared(
    stage: PlanningStage,
    attempt: number,
  ): Promise<
    | {
        readonly request: PlanningStageRequest;
        readonly brief: PlanningBriefArtifact;
      }
    | undefined
  > {
    const directory = this.attemptDirectory(stage, attempt);
    const [requestSource, briefSource] = await Promise.all([
      readOptional(path.join(directory, "request.json")),
      readOptional(path.join(directory, "brief.json")),
    ]);
    if (requestSource === undefined && briefSource === undefined)
      return undefined;
    if (requestSource === undefined || briefSource === undefined) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        `${stage} attempt ${attempt} is only partially prepared`,
      );
    }
    const request = parseStored(
      PlanningStageRequestSchema,
      requestSource,
      path.join(directory, "request.json"),
    );
    const brief = parseStored(
      PlanningBriefArtifactSchema,
      briefSource,
      path.join(directory, "brief.json"),
    );
    const { request_digest: storedDigest, ...unsigned } = request;
    if (
      stageRequestDigest(unsigned) !== storedDigest ||
      planningBriefDigest(brief.content) !== brief.digest ||
      request.brief_digest !== brief.digest ||
      request.stage !== stage ||
      request.attempt !== attempt
    ) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        `${stage} attempt ${attempt} has invalid prepared evidence`,
      );
    }
    return { request, brief };
  }

  async prepare(
    request: PlanningStageRequest,
    brief: CompiledPlanningStageBrief,
  ): Promise<void> {
    const directory = this.attemptDirectory(request.stage, request.attempt);
    await mkdir(directory, { recursive: true });
    await putImmutableJson(
      path.join(directory, "brief.json"),
      PlanningBriefArtifactSchema.parse({
        version: 1,
        content: brief.content,
        digest: brief.digest,
      }),
      PlanningBriefArtifactSchema,
    );
    await putImmutableJson(
      path.join(directory, "request.json"),
      request,
      PlanningStageRequestSchema,
    );
  }

  async critique(attempt: number): Promise<PlanningCritiqueRecord | undefined> {
    const filePath = path.join(
      this.attemptDirectory("critique", attempt),
      "record.json",
    );
    const source = await readOptional(filePath);
    if (source === undefined) return undefined;
    const record = parseStored(PlanningCritiqueRecordSchema, source, filePath);
    const { record_digest: storedDigest, ...unsigned } = record;
    const output = parsePlanningCritique(record.response);
    const expectedReport = createCritiqueReport(record, output);
    if (
      critiqueRecordDigest(unsigned) !== storedDigest ||
      sha256(record.response) !== record.response_digest ||
      canonicalJson(output) !== canonicalJson(record.output) ||
      canonicalJson(expectedReport) !== canonicalJson(record.report)
    ) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        `Critique attempt ${attempt} has invalid Report evidence`,
      );
    }
    return record;
  }

  async putCritique(
    record: PlanningCritiqueRecord,
  ): Promise<PlanningCritiqueRecord> {
    const stored = await putImmutableJson(
      path.join(
        this.attemptDirectory("critique", record.attempt),
        "record.json",
      ),
      record,
      PlanningCritiqueRecordSchema,
    );
    await this.reports.put(stored.report);
    return stored;
  }

  async synthesis(attempt: number): Promise<PlanSynthesisRecord | undefined> {
    const filePath = path.join(
      this.attemptDirectory("synthesis", attempt),
      "record.json",
    );
    const source = await readOptional(filePath);
    if (source === undefined) return undefined;
    const record = parseStored(PlanSynthesisRecordSchema, source, filePath);
    const { record_digest: storedDigest, ...unsigned } = record;
    const output = parsePlanSynthesisOutput(record.response);
    const expectedReport = createSynthesisReport(record, output);
    const { manifest_digest: storedManifestDigest, ...unsignedManifest } =
      record.draft;
    if (
      synthesisRecordDigest(unsigned) !== storedDigest ||
      sha256(record.response) !== record.response_digest ||
      canonicalJson(output) !== canonicalJson(record.output) ||
      canonicalJson(expectedReport) !== canonicalJson(record.report) ||
      draftManifestDigest(unsignedManifest) !== storedManifestDigest
    ) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        `Synthesis attempt ${attempt} has invalid draft evidence`,
      );
    }
    return record;
  }

  async putSynthesis(
    record: PlanSynthesisRecord,
    plan: ValidatedPlanDraft,
  ): Promise<PlanSynthesisRecord> {
    const stored = await putImmutableJson(
      path.join(
        this.attemptDirectory("synthesis", record.attempt),
        "record.json",
      ),
      record,
      PlanSynthesisRecordSchema,
    );
    await this.reports.put(stored.report);
    const draftDirectory = this.draftDirectory(plan.id);
    await putImmutableText(path.join(draftDirectory, "plan.md"), plan.markdown);
    await putImmutableText(
      path.join(draftDirectory, "tasks.yaml"),
      plan.tasksYaml,
    );
    await putImmutableJson(
      path.join(this.draftRoot(), "manifest.json"),
      stored.draft,
      PlanDraftManifestSchema,
    );
    return stored;
  }

  async requireCritiqueReport(record: PlanningCritiqueRecord): Promise<void> {
    const report = await this.reports.put(record.report);
    if (canonicalJson(report) !== canonicalJson(record.report)) {
      throw new OrchestratorError(
        "synthesis_report_conflict",
        "Critique Report differs from its evidence record",
      );
    }
  }

  async requireSynthesisArtifacts(
    record: PlanSynthesisRecord,
    plan: ValidatedPlanDraft,
  ): Promise<void> {
    await this.putSynthesis(record, plan);
    const [markdown, tasksYaml, manifestSource] = await Promise.all([
      readFile(path.join(this.draftDirectory(plan.id), "plan.md"), "utf8"),
      readFile(path.join(this.draftDirectory(plan.id), "tasks.yaml"), "utf8"),
      readFile(path.join(this.draftRoot(), "manifest.json"), "utf8"),
    ]);
    const manifest = parseStored(
      PlanDraftManifestSchema,
      manifestSource,
      path.join(this.draftRoot(), "manifest.json"),
    );
    if (
      markdown !== plan.markdown ||
      tasksYaml !== plan.tasksYaml ||
      canonicalJson(manifest) !== canonicalJson(record.draft)
    ) {
      throw new OrchestratorError(
        "plan_draft_conflict",
        "Stored Plan draft does not match its synthesis evidence",
      );
    }
  }
}

function requireRole(project: Project, stage: PlanningStage): LoadedRole {
  const name = stage === "critique" ? "reviewer" : "lead";
  const role = project.roles.get(name);
  if (!role) {
    throw new OrchestratorError(
      "planning_stage_role_not_found",
      `${stage} requires the '${name}' Role`,
    );
  }
  if (
    !roleHasReadSource(role.definition) ||
    role.definition.permissions.write_lease !== "never"
  ) {
    throw new OrchestratorError(
      "invalid_planning_stage_role",
      `The '${name}' Role must explicitly permit read-only source access`,
    );
  }
  return role;
}

function requirePreflight(
  preflight: OpenShellPreflight,
  model: ResolvedModelRoute,
  stage: PlanningStage,
): void {
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      `${stage} requires an exact OpenShell version pin`,
    );
  }
  if (preflight.status.gateway !== model.gateway) {
    throw new OrchestratorError(
      "model_gateway_mismatch",
      `${stage} model '${model.profile}' requires gateway '${model.gateway}', but the client reached '${preflight.status.gateway}'`,
    );
  }
}

function requireSessionBinding(input: {
  readonly info: ReadSessionInfo;
  readonly identity: SessionIdentity;
  readonly source: PlanningSource;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly policyDigest: Digest;
  readonly brief: CompiledPlanningStageBrief;
  readonly stage: PlanningStage;
}): void {
  if (
    input.info.profile !== "read" ||
    input.info.permissionCeiling.permission_ceiling_digest !==
      input.permissionCeiling.permission_ceiling_digest ||
    !sameSessionIdentity(input.info.identity, input.identity) ||
    input.info.sourceDigest !== input.source.manifest.source_digest ||
    !workspaceProjectionMatches(input.source, input.info.sandbox.projection) ||
    input.info.policyDigest !== input.policyDigest ||
    input.info.briefDigest !== input.brief.digest ||
    canonicalJson(input.info.model) !== canonicalJson(input.model) ||
    input.info.inference?.model !== input.model.pi_model
  ) {
    throw new OrchestratorError(
      "planning_stage_session_mismatch",
      `${input.stage} Session does not match its source, Brief, model, policy, or identity`,
    );
  }
  requirePreflight(input.info.openshell, input.model, input.stage);
}

function createStageRequest(input: {
  readonly stage: PlanningStage;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisions: readonly PlanningDecisionRecord[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique?: PlanningCritiqueRecord;
  readonly attempt: number;
  readonly identity: SessionIdentity;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledPlanningStageBrief;
  readonly messageId: string;
  readonly now: Date;
}): PlanningStageRequest {
  const unsigned = PlanningStageRequestWithoutDigestSchema.parse({
    version: 1,
    planning: input.state.id,
    stage: input.stage,
    attempt: input.attempt,
    identity: input.identity,
    goal_digest: input.state.goal_digest,
    questionnaire_digest: input.questionnaire.record_digest,
    decisions_digest: decisionsDigest(input.decisions),
    consultations: consultationDigests(input.consultations),
    critique_digest: input.critique?.record_digest ?? null,
    base_commit: input.state.base_commit,
    source_digest: input.state.source_digest,
    source_entries: input.state.source_entries,
    role: { name: input.role.definition.name, digest: input.role.digest },
    permission_ceiling_digest:
      input.permissionCeiling.permission_ceiling_digest,
    model: input.model,
    policy_digest: input.policyDigest,
    brief_digest: input.brief.digest,
    message_id: input.messageId,
    created_at: input.now.toISOString(),
  });
  return PlanningStageRequestSchema.parse({
    ...unsigned,
    request_digest: stageRequestDigest(unsigned),
  });
}

function requireCurrentRequest(input: {
  readonly request: PlanningStageRequest;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisions: readonly PlanningDecisionRecord[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique?: PlanningCritiqueRecord;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledPlanningStageBrief;
}): void {
  const expectedAgent = input.request.stage === "critique" ? "critic" : "lead";
  if (
    input.request.planning !== input.state.id ||
    input.request.goal_digest !== input.state.goal_digest ||
    input.request.questionnaire_digest !== input.questionnaire.record_digest ||
    input.request.decisions_digest !== decisionsDigest(input.decisions) ||
    canonicalJson(input.request.consultations) !==
      canonicalJson(consultationDigests(input.consultations)) ||
    input.request.critique_digest !== (input.critique?.record_digest ?? null) ||
    input.request.base_commit !== input.state.base_commit ||
    input.request.source_digest !== input.state.source_digest ||
    input.request.source_entries !== input.state.source_entries ||
    input.request.role.name !== input.role.definition.name ||
    input.request.role.digest !== input.role.digest ||
    input.request.permission_ceiling_digest !==
      input.permissionCeiling.permission_ceiling_digest ||
    canonicalJson(input.request.model) !== canonicalJson(input.model) ||
    input.request.policy_digest !== input.policyDigest ||
    input.request.brief_digest !== input.brief.digest ||
    input.request.identity.run !== input.state.id ||
    input.request.identity.agent !== expectedAgent
  ) {
    throw new OrchestratorError(
      "planning_stage_attempt_stale",
      `${input.request.stage} attempt ${input.request.attempt} no longer matches its inputs`,
    );
  }
}

function renderAnchors(anchors: readonly SourceAnchor[]): string {
  return anchors.map((anchor) => `- ${canonicalJson(anchor)}`).join("\n");
}

function renderCritique(output: PlanningCritique): string {
  return `# Conclusion\n\n${output.conclusion}\n\n# Verdict\n\n${output.verdict}\n\n# Strengths\n\n${output.strengths.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Blocking Findings\n\n${output.blocking_findings.map((finding) => `## ${finding.id}\n\n${finding.finding}\n\nRequired correction: ${finding.required_correction}\n\n${renderAnchors(finding.evidence)}`).join("\n\n") || "None."}\n\n# Tensions\n\n${output.tensions.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Improvements\n\n${output.improvements.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Evidence\n\n${renderAnchors(output.source_anchors)}\n\n# Uncertainty\n\n${output.unresolved_questions.map((item) => `- ${item}`).join("\n") || "None."}\n`;
}

function renderSynthesis(
  output: PlanSynthesisOutput,
  planDigest: Digest,
): string {
  return `# Summary\n\n${output.synthesis_summary}\n\n# Plan\n\n${output.plan_id} revision ${output.revision}\n\nPlan digest: ${planDigest}\n\n# Critique Resolutions\n\n${output.critique_resolutions.map((item) => `- ${item.finding}: ${item.resolution}`).join("\n") || "None."}\n\n# Source Anchors\n\n${renderAnchors(output.source_anchors)}\n`;
}

function createCritiqueReport(
  record: Pick<
    PlanningCritiqueRecord,
    | "planning"
    | "identity"
    | "source_digest"
    | "created_at"
    | "permission_ceiling_digest"
    | "model"
  >,
  output: PlanningCritique,
): Report {
  return createReport({
    id: "planning-critique",
    kind: "consultation",
    run: record.planning,
    agent: record.identity.agent,
    session: record.identity.session,
    generation: record.identity.generation,
    permission_ceiling_digest: record.permission_ceiling_digest,
    model_profile: record.model.profile,
    route_digest: record.model.route_digest,
    source_digest: record.source_digest,
    content: renderCritique(output),
    created_at: record.created_at,
  });
}

function createSynthesisReport(
  record: Pick<
    PlanSynthesisRecord,
    | "planning"
    | "identity"
    | "source_digest"
    | "created_at"
    | "draft"
    | "permission_ceiling_digest"
    | "model"
  >,
  output: PlanSynthesisOutput,
): Report {
  return createReport({
    id: "plan-synthesis",
    kind: "consultation",
    run: record.planning,
    agent: record.identity.agent,
    session: record.identity.session,
    generation: record.identity.generation,
    permission_ceiling_digest: record.permission_ceiling_digest,
    model_profile: record.model.profile,
    route_digest: record.model.route_digest,
    source_digest: record.source_digest,
    content: renderSynthesis(output, record.draft.plan.digest as Digest),
    created_at: record.created_at,
  });
}

function createCritiqueRecord(input: {
  readonly request: PlanningStageRequest;
  readonly session: ReadSessionInfo;
  readonly output: PlanningCritique;
  readonly turn: ModelTurnResult;
  readonly now: Date;
}): PlanningCritiqueRecord {
  const reportInput = {
    planning: input.request.planning,
    identity: input.request.identity,
    permission_ceiling_digest: input.request.permission_ceiling_digest,
    model: input.request.model,
    source_digest: input.request.source_digest,
    created_at: input.now.toISOString(),
  };
  const unsigned = PlanningCritiqueRecordWithoutDigestSchema.parse({
    version: 1,
    planning: input.request.planning,
    stage: "critique",
    attempt: input.request.attempt,
    identity: input.request.identity,
    request_digest: input.request.request_digest,
    goal_digest: input.request.goal_digest,
    questionnaire_digest: input.request.questionnaire_digest,
    decisions_digest: input.request.decisions_digest,
    consultations: input.request.consultations,
    base_commit: input.request.base_commit,
    source_digest: input.request.source_digest,
    role_digest: input.request.role.digest,
    permission_ceiling_digest: input.request.permission_ceiling_digest,
    model: input.request.model,
    policy_digest: input.request.policy_digest,
    brief_digest: input.request.brief_digest,
    sandbox: {
      id: input.session.sandbox.id,
      name: input.session.sandbox.name,
      workspace: input.session.sandbox.workspace,
      ...(input.session.sandbox.projection
        ? { projection: input.session.sandbox.projection }
        : {}),
    },
    output: input.output,
    response: input.turn.text,
    response_digest: sha256(input.turn.text),
    turn: {
      message_ids: input.turn.message_ids,
      model_profile: input.turn.model_profile,
      requested_model: input.turn.requested_model,
      ...(input.turn.response_model
        ? { response_model: input.turn.response_model }
        : {}),
      stop_reason: input.turn.stop_reason,
      truncated: input.turn.truncated,
      usage: input.turn.usage,
    },
    report: createCritiqueReport(reportInput, input.output),
    created_at: input.now.toISOString(),
  });
  return PlanningCritiqueRecordSchema.parse({
    ...unsigned,
    record_digest: critiqueRecordDigest(unsigned),
  });
}

function createDraftManifest(input: {
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique: PlanningCritiqueRecord;
  readonly plan: ValidatedPlanDraft;
  readonly now: Date;
}): PlanDraftManifest {
  const unsigned = PlanDraftManifestWithoutDigestSchema.parse({
    version: 1,
    planning: input.state.id,
    plan: {
      id: input.plan.id,
      revision: input.plan.revision,
      digest: input.plan.digest,
    },
    base_commit: input.state.base_commit,
    source_digest: input.state.source_digest,
    questionnaire_digest: input.questionnaire.record_digest,
    consultations: consultationDigests(input.consultations),
    critique_digest: input.critique.record_digest,
    plan_markdown_digest: sha256(input.plan.markdown),
    tasks_yaml_digest: sha256(input.plan.tasksYaml),
    created_at: input.now.toISOString(),
  });
  return PlanDraftManifestSchema.parse({
    ...unsigned,
    manifest_digest: draftManifestDigest(unsigned),
  });
}

function createSynthesisRecord(input: {
  readonly request: PlanningStageRequest;
  readonly session: ReadSessionInfo;
  readonly output: PlanSynthesisOutput;
  readonly plan: ValidatedPlanDraft;
  readonly manifest: PlanDraftManifest;
  readonly turn: ModelTurnResult;
  readonly now: Date;
}): PlanSynthesisRecord {
  const reportInput = {
    planning: input.request.planning,
    identity: input.request.identity,
    permission_ceiling_digest: input.request.permission_ceiling_digest,
    model: input.request.model,
    source_digest: input.request.source_digest,
    created_at: input.now.toISOString(),
    draft: input.manifest,
  };
  const unsigned = PlanSynthesisRecordWithoutDigestSchema.parse({
    version: 1,
    planning: input.request.planning,
    stage: "synthesis",
    attempt: input.request.attempt,
    identity: input.request.identity,
    request_digest: input.request.request_digest,
    goal_digest: input.request.goal_digest,
    questionnaire_digest: input.request.questionnaire_digest,
    decisions_digest: input.request.decisions_digest,
    consultations: input.request.consultations,
    critique_digest: input.request.critique_digest,
    base_commit: input.request.base_commit,
    source_digest: input.request.source_digest,
    role_digest: input.request.role.digest,
    permission_ceiling_digest: input.request.permission_ceiling_digest,
    model: input.request.model,
    policy_digest: input.request.policy_digest,
    brief_digest: input.request.brief_digest,
    sandbox: {
      id: input.session.sandbox.id,
      name: input.session.sandbox.name,
      workspace: input.session.sandbox.workspace,
      ...(input.session.sandbox.projection
        ? { projection: input.session.sandbox.projection }
        : {}),
    },
    output: input.output,
    response: input.turn.text,
    response_digest: sha256(input.turn.text),
    turn: {
      message_ids: input.turn.message_ids,
      model_profile: input.turn.model_profile,
      requested_model: input.turn.requested_model,
      ...(input.turn.response_model
        ? { response_model: input.turn.response_model }
        : {}),
      stop_reason: input.turn.stop_reason,
      truncated: input.turn.truncated,
      usage: input.turn.usage,
    },
    draft: input.manifest,
    report: createSynthesisReport(reportInput, input.output),
    created_at: input.now.toISOString(),
  });
  return PlanSynthesisRecordSchema.parse({
    ...unsigned,
    record_digest: synthesisRecordDigest(unsigned),
  });
}

function requireCritiqueRecord(
  state: PlanningState,
  request: PlanningStageRequest,
  record: PlanningCritiqueRecord,
  sourcePaths: ReadonlySet<string>,
): void {
  const output = parsePlanningCritique(record.response, sourcePaths);
  if (
    record.planning !== state.id ||
    record.attempt !== request.attempt ||
    record.request_digest !== request.request_digest ||
    record.goal_digest !== state.goal_digest ||
    record.questionnaire_digest !== state.questionnaire_digest ||
    record.decisions_digest !== request.decisions_digest ||
    canonicalJson(record.consultations) !==
      canonicalJson(request.consultations) ||
    record.base_commit !== state.base_commit ||
    record.source_digest !== state.source_digest ||
    !sameSessionIdentity(record.identity, request.identity) ||
    record.role_digest !== request.role.digest ||
    record.permission_ceiling_digest !== request.permission_ceiling_digest ||
    canonicalJson(record.model) !== canonicalJson(request.model) ||
    record.policy_digest !== request.policy_digest ||
    record.brief_digest !== request.brief_digest ||
    canonicalJson(record.output) !== canonicalJson(output) ||
    !record.turn.message_ids.includes(request.message_id) ||
    record.turn.model_profile !== request.model.profile ||
    record.turn.requested_model !== request.model.pi_model ||
    record.turn.truncated ||
    state.critique.attempts !== request.attempt ||
    state.critique.current_request_digest !== request.request_digest ||
    (state.critique.record_digest !== null &&
      state.critique.record_digest !== record.record_digest) ||
    (state.critique.report_digest !== null &&
      state.critique.report_digest !== record.report.content_digest)
  ) {
    throw new OrchestratorError(
      "planning_critique_stale",
      "Stored planning critique no longer matches its exact evidence",
    );
  }
}

async function validateSynthesisPlan(input: {
  readonly project: Project;
  readonly output: PlanSynthesisOutput;
  readonly critique: PlanningCritiqueRecord;
  readonly consultations: RunPlanningConsultationsResult;
}): Promise<ValidatedPlanDraft> {
  const expectedFindings = input.critique.output.blocking_findings
    .map((finding) => finding.id)
    .sort();
  const actualFindings = input.output.critique_resolutions
    .map((resolution) => resolution.finding)
    .sort();
  if (canonicalJson(expectedFindings) !== canonicalJson(actualFindings)) {
    throw new OrchestratorError(
      "invalid_plan_synthesis",
      "Lead synthesis must resolve every blocking critic finding exactly once",
    );
  }
  const quant = input.consultations.consultations.find(
    (item) => item.role === "quant",
  )!.record.output;
  if (quant.role !== "quant") {
    throw new OrchestratorError(
      "invalid_consultation_store",
      "Quant consultation contains another output Role",
    );
  }
  const requiredReviews = ["spec", "architecture", "quality"] as const;
  for (const task of input.output.tasks) {
    for (const lens of requiredReviews) {
      if (!task.reviews.includes(lens)) {
        throw new OrchestratorError(
          "invalid_plan_synthesis",
          `Task '${task.id}' must require the ${lens} Review`,
        );
      }
    }
    if (quant.applicability === "material" && !task.reviews.includes("quant")) {
      throw new OrchestratorError(
        "invalid_plan_synthesis",
        `Task '${task.id}' must require the quant Review`,
      );
    }
  }
  const tasksFile = TasksFileSchema.parse({
    version: 2,
    plan: { id: input.output.plan_id, revision: input.output.revision },
    tasks: input.output.tasks,
  });
  const tasksYaml = stringify(tasksFile, { lineWidth: 0 });
  const plan = validatePlanDraft(
    {
      id: input.output.plan_id,
      markdown: input.output.plan_markdown,
      tasksYaml,
    },
    catalogFromConfig(input.project.config),
  );
  const existingDirectory = path.join(
    input.project.root,
    "docs",
    "plans",
    plan.id,
  );
  const existing = await stat(existingDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const expectedRevision = existing
    ? (
        await loadPlan(
          existingDirectory,
          catalogFromConfig(input.project.config),
        )
      ).revision + 1
    : 1;
  if (plan.revision !== expectedRevision) {
    throw new OrchestratorError(
      "invalid_plan_synthesis",
      `Plan '${plan.id}' must use revision ${expectedRevision}, not ${plan.revision}`,
    );
  }
  return plan;
}

function requireSynthesisRecord(
  state: PlanningState,
  request: PlanningStageRequest,
  record: PlanSynthesisRecord,
  sourcePaths: ReadonlySet<string>,
): void {
  const output = parsePlanSynthesisOutput(record.response, sourcePaths);
  if (
    record.planning !== state.id ||
    record.attempt !== request.attempt ||
    record.request_digest !== request.request_digest ||
    record.goal_digest !== state.goal_digest ||
    record.questionnaire_digest !== state.questionnaire_digest ||
    record.decisions_digest !== request.decisions_digest ||
    canonicalJson(record.consultations) !==
      canonicalJson(request.consultations) ||
    record.critique_digest !== request.critique_digest ||
    record.base_commit !== state.base_commit ||
    record.source_digest !== state.source_digest ||
    !sameSessionIdentity(record.identity, request.identity) ||
    record.role_digest !== request.role.digest ||
    record.permission_ceiling_digest !== request.permission_ceiling_digest ||
    canonicalJson(record.model) !== canonicalJson(request.model) ||
    record.policy_digest !== request.policy_digest ||
    record.brief_digest !== request.brief_digest ||
    canonicalJson(record.output) !== canonicalJson(output) ||
    !record.turn.message_ids.includes(request.message_id) ||
    record.turn.model_profile !== request.model.profile ||
    record.turn.requested_model !== request.model.pi_model ||
    record.turn.truncated ||
    state.synthesis.attempts !== request.attempt ||
    state.synthesis.current_request_digest !== request.request_digest ||
    (state.synthesis.record_digest !== null &&
      state.synthesis.record_digest !== record.record_digest) ||
    (state.synthesis.report_digest !== null &&
      state.synthesis.report_digest !== record.report.content_digest) ||
    (state.synthesis.plan_digest !== null &&
      state.synthesis.plan_digest !== record.draft.plan.digest)
  ) {
    throw new OrchestratorError(
      "plan_synthesis_stale",
      "Stored Plan synthesis no longer matches its exact evidence",
    );
  }
}

async function runTurn(input: {
  readonly options: RunPlanSynthesisOptions;
  readonly stage: PlanningStage;
  readonly client: ReadSessionOpenShell;
  readonly snapshot: PlanningSource;
  readonly request: PlanningStageRequest;
  readonly brief: CompiledPlanningStageBrief;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly policyDigest: Digest;
  readonly state: PlanningState;
  readonly references: readonly string[];
}): Promise<{
  readonly session: ReadSessionInfo;
  readonly turn: ModelTurnResult;
}> {
  let session: PlanningSession | undefined;
  let result:
    | { readonly session: ReadSessionInfo; readonly turn: ModelTurnResult }
    | undefined;
  let primaryError: unknown;
  try {
    const launch = input.options.launchSession ?? startReadSession;
    session = await launch({
      client: input.client,
      identity: input.request.identity,
      ...(isReadOnlySourceWorkspace(input.snapshot)
        ? { workspace: input.snapshot }
        : { snapshot: input.snapshot }),
      permissionCeiling: input.permissionCeiling,
      model: input.model,
      brief: input.brief,
      context: input.options.project.config.context,
      policyDirectory: path.resolve(
        input.options.policyDirectory ?? bundledPiPolicyDirectory(),
      ),
      ...(input.options.imageContext
        ? { imageContext: input.options.imageContext }
        : {}),
      ...(input.options.startupTimeoutMs
        ? { startupTimeoutMs: input.options.startupTimeoutMs }
        : {}),
      ...(input.options.turnTimeoutMs
        ? { turnTimeoutMs: input.options.turnTimeoutMs }
        : {}),
    });
    requireSessionBinding({
      info: session.info,
      identity: input.request.identity,
      source: input.snapshot,
      model: input.model,
      permissionCeiling: input.permissionCeiling,
      policyDigest: input.policyDigest,
      brief: input.brief,
      stage: input.stage,
    });
    const message = MessageSchema.parse({
      version: 2,
      id: input.request.message_id,
      run: input.state.id,
      from: { host: true },
      to: {
        agent: input.request.identity.agent,
        session: input.request.identity.session,
        generation: input.request.identity.generation,
      },
      type: input.stage === "critique" ? "planning-critique" : "plan-synthesis",
      priority: "normal",
      reply_to: null,
      body: {
        action: input.stage,
        goal: input.state.goal,
        source_digest: input.state.source_digest,
        questionnaire_digest: input.request.questionnaire_digest,
        consultation_digests: input.request.consultations,
        critique_digest: input.request.critique_digest,
        brief_digest: input.brief.digest,
        instruction:
          input.stage === "critique"
            ? "Independently criticize the frozen planning evidence and return the required object."
            : "Synthesize the frozen evidence into the required Plan draft object.",
      },
      references: input.references,
      created_at: (input.options.now ?? (() => new Date()))().toISOString(),
    });
    const turn = ModelTurnResultSchema.parse(await session.run(message));
    if (
      !turn.message_ids.includes(message.id) ||
      turn.model_profile !== input.model.profile ||
      turn.requested_model !== input.model.pi_model
    ) {
      throw new OrchestratorError(
        "planning_stage_turn_mismatch",
        `${input.stage} result does not match Message '${message.id}' and route '${input.model.profile}/${input.model.pi_model}'`,
      );
    }
    if (turn.truncated) {
      throw new OrchestratorError(
        "planning_stage_output_truncated",
        `${input.stage} exceeded the bounded model-turn output`,
      );
    }
    const latestCommit = await requireCleanPlanningProject(
      input.options.project,
    );
    if (latestCommit !== input.state.base_commit) {
      throw new OrchestratorError(
        "planning_source_stale",
        `Repository commit changed while the ${input.stage} Session was running`,
      );
    }
    await verifyPlanningSource(input.snapshot);
    result = { session: session.info, turn };
  } catch (error) {
    primaryError = error;
  } finally {
    if (session) {
      try {
        await session.stop();
      } catch (error) {
        if (primaryError === undefined) primaryError = error;
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return result!;
}

async function executeCritique(input: {
  readonly options: RunPlanSynthesisOptions;
  readonly planning: PlanningStore;
  readonly evidence: SynthesisStore;
  readonly snapshot: PlanningSource;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisions: readonly PlanningDecisionRecord[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly state: PlanningState;
  readonly policyDigest: Digest;
}): Promise<{
  readonly state: PlanningState;
  readonly request: PlanningStageRequest;
  readonly record: PlanningCritiqueRecord;
  readonly reused: boolean;
}> {
  let state = input.state;
  const role = requireRole(input.options.project, "critique");
  const permissionCeiling = resolveRolePermissionCeiling({
    role,
    assignment: {
      kind: "review",
      task: state.id,
      lens: "architecture",
    },
    localPolicy: input.options.local.permissions,
  });
  const model = resolveRoleModelRoute(
    input.options.project.config,
    input.options.local,
    role.definition.name,
  );
  const sourcePaths = planningSourcePaths(input.snapshot.manifest);
  const currentBrief = (
    request: PlanningStageRequest,
    stored: PlanningBriefArtifact,
  ): CompiledPlanningStageBrief => {
    const brief = compileCritiqueBrief({
      identity: request.identity,
      project: input.options.project,
      role,
      permissionCeiling,
      model,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisions.map((record) => record.decision),
      consultations: input.consultations,
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    if (brief.digest !== stored.digest || brief.content !== stored.content) {
      throw new OrchestratorError(
        "planning_stage_attempt_stale",
        `Critique attempt ${request.attempt} has a stale Brief`,
      );
    }
    requireCurrentRequest({
      request,
      state,
      questionnaire: input.questionnaire,
      decisions: input.decisions,
      consultations: input.consultations,
      role,
      permissionCeiling,
      model,
      policyDigest: input.policyDigest,
      brief,
    });
    return brief;
  };

  if (state.critique.record_digest !== null) {
    const [prepared, record] = await Promise.all([
      input.evidence.findPrepared("critique", state.critique.attempts),
      input.evidence.critique(state.critique.attempts),
    ]);
    if (
      !prepared ||
      !record ||
      record.record_digest !== state.critique.record_digest
    ) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        "Planning state references a missing critique",
      );
    }
    currentBrief(prepared.request, prepared.brief);
    requireCritiqueRecord(state, prepared.request, record, sourcePaths);
    await input.evidence.requireCritiqueReport(record);
    return { state, request: prepared.request, record, reused: true };
  }

  if (state.critique.attempts > 0) {
    const record = await input.evidence.critique(state.critique.attempts);
    if (record) {
      const prepared = await input.evidence.findPrepared(
        "critique",
        state.critique.attempts,
      );
      if (!prepared) {
        throw new OrchestratorError(
          "invalid_synthesis_store",
          "Stored critique is missing its request",
        );
      }
      currentBrief(prepared.request, prepared.brief);
      requireCritiqueRecord(state, prepared.request, record, sourcePaths);
      await input.evidence.requireCritiqueReport(record);
      state = await input.planning.publishCritique({
        expected: state,
        attempt: record.attempt,
        requestDigest: record.request_digest as Digest,
        recordDigest: record.record_digest as Digest,
        reportDigest: record.report.content_digest as Digest,
        now: (input.options.now ?? (() => new Date()))(),
      });
      return { state, request: prepared.request, record, reused: true };
    }
  }

  const client = input.options.clients.critic;
  const preflight = await client.preflight();
  requirePreflight(preflight, model, "critique");
  if (!client.getInferenceRoute) {
    throw new OrchestratorError(
      "openshell_inference_unavailable",
      "Criticism requires an inspectable inference route",
    );
  }
  const inference = await client.getInferenceRoute();
  if (inference.model !== model.pi_model) {
    throw new OrchestratorError(
      "model_route_mismatch",
      `OpenShell gateway '${model.gateway}' routes '${inference.model ?? "nothing"}', not '${model.pi_model}'`,
    );
  }
  const attempt = state.critique.attempts + 1;
  const prepared = await input.evidence.findPrepared("critique", attempt);
  let request: PlanningStageRequest;
  let brief: CompiledPlanningStageBrief;
  if (prepared) {
    request = prepared.request;
    brief = currentBrief(request, prepared.brief);
  } else {
    const nonce = z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .parse(
        input.options.nonce?.("critique", attempt) ??
          randomBytes(4).toString("hex"),
      );
    const identity = SessionIdentitySchema.parse({
      run: state.id,
      agent: "critic",
      session: `critic-${attempt}-${nonce}`,
      generation: attempt,
    });
    brief = compileCritiqueBrief({
      identity,
      project: input.options.project,
      role,
      permissionCeiling,
      model,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisions.map((record) => record.decision),
      consultations: input.consultations,
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    request = createStageRequest({
      stage: "critique",
      state,
      questionnaire: input.questionnaire,
      decisions: input.decisions,
      consultations: input.consultations,
      attempt,
      identity,
      role,
      permissionCeiling,
      model,
      policyDigest: input.policyDigest,
      brief,
      messageId: `critique-request-${attempt}-${nonce}`,
      now: (input.options.now ?? (() => new Date()))(),
    });
    await input.evidence.prepare(request, brief);
  }
  state = await input.planning.beginCritique({
    expected: state,
    attempt,
    requestDigest: request.request_digest as Digest,
    now: (input.options.now ?? (() => new Date()))(),
  });
  const turn = await runTurn({
    options: input.options,
    stage: "critique",
    client,
    snapshot: input.snapshot,
    request,
    brief,
    model,
    permissionCeiling,
    policyDigest: input.policyDigest,
    state,
    references: input.questionnaire.questionnaire.repository.anchors.map(
      (anchor) => anchor.path,
    ),
  });
  const output = parsePlanningCritique(turn.turn.text, sourcePaths);
  let record = createCritiqueRecord({
    request,
    session: turn.session,
    output,
    turn: turn.turn,
    now: (input.options.now ?? (() => new Date()))(),
  });
  record = await input.evidence.putCritique(record);
  state = await input.planning.publishCritique({
    expected: state,
    attempt,
    requestDigest: request.request_digest as Digest,
    recordDigest: record.record_digest as Digest,
    reportDigest: record.report.content_digest as Digest,
    now: (input.options.now ?? (() => new Date()))(),
  });
  return { state, request, record, reused: false };
}

async function executeSynthesis(input: {
  readonly options: RunPlanSynthesisOptions;
  readonly planning: PlanningStore;
  readonly evidence: SynthesisStore;
  readonly snapshot: PlanningSource;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisions: readonly PlanningDecisionRecord[];
  readonly consultations: RunPlanningConsultationsResult;
  readonly critique: PlanningCritiqueRecord;
  readonly state: PlanningState;
  readonly policyDigest: Digest;
}): Promise<{
  readonly state: PlanningState;
  readonly request: PlanningStageRequest;
  readonly record: PlanSynthesisRecord;
  readonly plan: ValidatedPlanDraft;
  readonly reused: boolean;
}> {
  let state = input.state;
  const role = requireRole(input.options.project, "synthesis");
  const permissionCeiling = resolveRolePermissionCeiling({
    role,
    assignment: { kind: "run" },
    localPolicy: input.options.local.permissions,
  });
  const model = resolveRoleModelRoute(
    input.options.project.config,
    input.options.local,
    role.definition.name,
  );
  const sourcePaths = planningSourcePaths(input.snapshot.manifest);
  const currentBrief = (
    request: PlanningStageRequest,
    stored: PlanningBriefArtifact,
  ): CompiledPlanningStageBrief => {
    const brief = compileSynthesisBrief({
      identity: request.identity,
      project: input.options.project,
      role,
      permissionCeiling,
      model,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisions.map((record) => record.decision),
      consultations: input.consultations,
      critique: input.critique,
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    if (brief.digest !== stored.digest || brief.content !== stored.content) {
      throw new OrchestratorError(
        "planning_stage_attempt_stale",
        `Synthesis attempt ${request.attempt} has a stale Brief`,
      );
    }
    requireCurrentRequest({
      request,
      state,
      questionnaire: input.questionnaire,
      decisions: input.decisions,
      consultations: input.consultations,
      critique: input.critique,
      role,
      permissionCeiling,
      model,
      policyDigest: input.policyDigest,
      brief,
    });
    return brief;
  };

  if (state.synthesis.record_digest !== null) {
    const [prepared, record] = await Promise.all([
      input.evidence.findPrepared("synthesis", state.synthesis.attempts),
      input.evidence.synthesis(state.synthesis.attempts),
    ]);
    if (
      !prepared ||
      !record ||
      record.record_digest !== state.synthesis.record_digest
    ) {
      throw new OrchestratorError(
        "invalid_synthesis_store",
        "Planning state references a missing synthesis record",
      );
    }
    currentBrief(prepared.request, prepared.brief);
    requireSynthesisRecord(state, prepared.request, record, sourcePaths);
    const plan = await validateSynthesisPlan({
      project: input.options.project,
      output: record.output,
      critique: input.critique,
      consultations: input.consultations,
    });
    if (plan.digest !== record.draft.plan.digest) {
      throw new OrchestratorError(
        "plan_synthesis_stale",
        "Stored Plan draft digest is no longer reproducible",
      );
    }
    await input.evidence.requireSynthesisArtifacts(record, plan);
    return { state, request: prepared.request, record, plan, reused: true };
  }

  if (state.synthesis.attempts > 0) {
    const record = await input.evidence.synthesis(state.synthesis.attempts);
    if (record) {
      const prepared = await input.evidence.findPrepared(
        "synthesis",
        state.synthesis.attempts,
      );
      if (!prepared) {
        throw new OrchestratorError(
          "invalid_synthesis_store",
          "Stored Plan synthesis is missing its request",
        );
      }
      currentBrief(prepared.request, prepared.brief);
      requireSynthesisRecord(state, prepared.request, record, sourcePaths);
      const plan = await validateSynthesisPlan({
        project: input.options.project,
        output: record.output,
        critique: input.critique,
        consultations: input.consultations,
      });
      if (plan.digest !== record.draft.plan.digest) {
        throw new OrchestratorError(
          "plan_synthesis_stale",
          "Stored Plan draft digest is no longer reproducible",
        );
      }
      await input.evidence.requireSynthesisArtifacts(record, plan);
      state = await input.planning.publishSynthesis({
        expected: state,
        attempt: record.attempt,
        requestDigest: record.request_digest as Digest,
        recordDigest: record.record_digest as Digest,
        reportDigest: record.report.content_digest as Digest,
        planDigest: plan.digest,
        now: (input.options.now ?? (() => new Date()))(),
      });
      return { state, request: prepared.request, record, plan, reused: true };
    }
  }

  const client = input.options.clients.lead;
  const preflight = await client.preflight();
  requirePreflight(preflight, model, "synthesis");
  if (!client.getInferenceRoute) {
    throw new OrchestratorError(
      "openshell_inference_unavailable",
      "Plan synthesis requires an inspectable inference route",
    );
  }
  const inference = await client.getInferenceRoute();
  if (inference.model !== model.pi_model) {
    throw new OrchestratorError(
      "model_route_mismatch",
      `OpenShell gateway '${model.gateway}' routes '${inference.model ?? "nothing"}', not '${model.pi_model}'`,
    );
  }
  const attempt = state.synthesis.attempts + 1;
  const prepared = await input.evidence.findPrepared("synthesis", attempt);
  let request: PlanningStageRequest;
  let brief: CompiledPlanningStageBrief;
  if (prepared) {
    request = prepared.request;
    brief = currentBrief(request, prepared.brief);
  } else {
    const nonce = z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .parse(
        input.options.nonce?.("synthesis", attempt) ??
          randomBytes(4).toString("hex"),
      );
    const identity = SessionIdentitySchema.parse({
      run: state.id,
      agent: "lead",
      session: `synthesis-${attempt}-${nonce}`,
      generation: state.attempts + attempt,
    });
    brief = compileSynthesisBrief({
      identity,
      project: input.options.project,
      role,
      permissionCeiling,
      model,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisions.map((record) => record.decision),
      consultations: input.consultations,
      critique: input.critique,
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    request = createStageRequest({
      stage: "synthesis",
      state,
      questionnaire: input.questionnaire,
      decisions: input.decisions,
      consultations: input.consultations,
      critique: input.critique,
      attempt,
      identity,
      role,
      permissionCeiling,
      model,
      policyDigest: input.policyDigest,
      brief,
      messageId: `synthesis-request-${attempt}-${nonce}`,
      now: (input.options.now ?? (() => new Date()))(),
    });
    await input.evidence.prepare(request, brief);
  }
  state = await input.planning.beginSynthesis({
    expected: state,
    attempt,
    requestDigest: request.request_digest as Digest,
    now: (input.options.now ?? (() => new Date()))(),
  });
  const turn = await runTurn({
    options: input.options,
    stage: "synthesis",
    client,
    snapshot: input.snapshot,
    request,
    brief,
    model,
    permissionCeiling,
    policyDigest: input.policyDigest,
    state,
    references: input.questionnaire.questionnaire.repository.anchors.map(
      (anchor) => anchor.path,
    ),
  });
  const output = parsePlanSynthesisOutput(turn.turn.text, sourcePaths);
  const plan = await validateSynthesisPlan({
    project: input.options.project,
    output,
    critique: input.critique,
    consultations: input.consultations,
  });
  const createdAt = (input.options.now ?? (() => new Date()))();
  const manifest = createDraftManifest({
    state,
    questionnaire: input.questionnaire,
    consultations: input.consultations,
    critique: input.critique,
    plan,
    now: createdAt,
  });
  let record = createSynthesisRecord({
    request,
    session: turn.session,
    output,
    plan,
    manifest,
    turn: turn.turn,
    now: createdAt,
  });
  record = await input.evidence.putSynthesis(record, plan);
  state = await input.planning.publishSynthesis({
    expected: state,
    attempt,
    requestDigest: request.request_digest as Digest,
    recordDigest: record.record_digest as Digest,
    reportDigest: record.report.content_digest as Digest,
    planDigest: plan.digest,
    now: (input.options.now ?? (() => new Date()))(),
  });
  return { state, request, record, plan, reused: false };
}

export async function runPlanSynthesis(
  options: RunPlanSynthesisOptions,
): Promise<RunPlanSynthesisResult> {
  const consultations = await runPlanningConsultations({
    store: options.store,
    project: options.project,
    local: options.local,
    planningId: options.planningId,
    ...(options.policyDirectory
      ? { policyDirectory: options.policyDirectory }
      : {}),
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
    ...(options.workspaceFactory
      ? { workspaceFactory: options.workspaceFactory }
      : {}),
  });
  const baseCommit = await requireCleanPlanningProject(options.project);
  const snapshot = await createPlanningSource({
    projectRoot: options.project.root,
    projectId: options.project.config.project.id,
    workspaceId: options.planningId,
    commit: baseCommit,
    local: options.local,
    restrictedPaths: options.project.config.restricted_paths,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
    ...(options.workspaceFactory
      ? { workspaceFactory: options.workspaceFactory }
      : {}),
  });
  try {
    const planning = new PlanningStore(options.store);
    let state = await planning.get(options.planningId);
    if (
      state.base_commit !== baseCommit ||
      state.source_digest !== snapshot.manifest.source_digest ||
      ![
        "consulted",
        "criticizing",
        "criticized",
        "synthesizing",
        "drafted",
      ].includes(state.status)
    ) {
      throw new OrchestratorError(
        "planning_not_consulted",
        `Planning request '${state.id}' is not ready for synthesis`,
      );
    }
    const storedSource = await planning.source(state.id);
    if (canonicalJson(storedSource) !== canonicalJson(snapshot.manifest)) {
      throw new OrchestratorError(
        "planning_source_stale",
        `Planning request '${state.id}' source evidence changed`,
      );
    }
    const questionnaire = (await planning.currentQuestionnaire(state.id))
      .record;
    const decisions = await planning.decisions(state.id);
    const policyDirectory = path.resolve(
      options.policyDirectory ?? bundledPiPolicyDirectory(),
    );
    const policy = await loadSandboxPolicy(
      "read",
      path.join(policyDirectory, "read.yaml"),
    );
    const evidence = new SynthesisStore(planning, state.id);
    const critique = await executeCritique({
      options,
      planning,
      evidence,
      snapshot,
      questionnaire,
      decisions,
      consultations,
      state,
      policyDigest: policy.digest,
    });
    state = critique.state;
    const synthesis = await executeSynthesis({
      options,
      planning,
      evidence,
      snapshot,
      questionnaire,
      decisions,
      consultations,
      critique: critique.record,
      state,
      policyDigest: policy.digest,
    });
    return {
      state: synthesis.state,
      critique: {
        request: critique.request,
        record: critique.record,
        reused: critique.reused,
      },
      synthesis: {
        request: synthesis.request,
        record: synthesis.record,
        plan: synthesis.plan,
        directory: evidence.draftDirectory(synthesis.plan.id),
        reused: synthesis.reused,
      },
    };
  } finally {
    await snapshot.dispose();
  }
}
