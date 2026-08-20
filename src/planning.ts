import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DecisionSchema, estimateTokens, type Decision } from "./brief.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import type { LocalConfig } from "./local.js";
import { MessageSchema, type Message } from "./message.js";
import {
  resolveRoleModelRoute,
  ResolvedModelRouteSchema,
  type ResolvedModelRoute,
} from "./model.js";
import type { OpenShellPreflight } from "./openshell.js";
import { loadSandboxPolicy } from "./policy.js";
import {
  resolveRolePermissionCeiling,
  roleHasReadSource,
  type PermissionCeiling,
} from "./permission.js";
import { SourceAnchorSchema } from "./plan.js";
import type { Project } from "./project.js";
import { gitHead, gitOutput } from "./project.js";
import type { LoadedRole } from "./role.js";
import {
  bundledPiPolicyDirectory,
  startReadSession,
  type ReadSessionInfo,
  type ReadSessionOpenShell,
  type StartReadSessionOptions,
} from "./agent.js";
import {
  ModelTurnResultSchema,
  SessionIdentitySchema,
  sameSessionIdentity,
  type ModelTurnResult,
  type SessionIdentity,
} from "./session.js";
import {
  PlanningSourceManifestSchema,
  createPlanningSource,
  isReadOnlySourceWorkspace,
  planningSourceBytes,
  planningSourcePaths,
  verifyPlanningSource,
  workspaceProjectionMatches,
  WorkspaceSessionProjectionSchema,
  type PlanningSource,
  type PlanningSourceManifest,
  type SourceWorkspaceFactory,
} from "./source.js";
import type { ProjectStore } from "./state.js";
import { writeJsonAtomic } from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const PlanningIdSchema = IdentifierSchema.max(96);
const PlanningQuestionIdSchema = IdentifierSchema.max(80);
const PlanningOptionIdSchema = IdentifierSchema.max(64);
const HumanTextSchema = z.string().trim().min(1).max(16_384);

export const PlanningQuestionOptionSchema = z
  .object({
    id: PlanningOptionIdSchema,
    label: z.string().trim().min(1).max(240),
    tradeoff: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type PlanningQuestionOption = z.infer<
  typeof PlanningQuestionOptionSchema
>;

export const PlanningQuestionSchema = z
  .object({
    id: PlanningQuestionIdSchema,
    scope: z.enum(["project", "run"]),
    question: z.string().trim().min(1).max(2_000),
    why: z.string().trim().min(1).max(2_000),
    options: z.array(PlanningQuestionOptionSchema).min(2).max(4),
    recommendation: PlanningOptionIdSchema,
    allow_free_form: z.literal(true),
  })
  .strict()
  .superRefine((question, context) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "option identifiers must be unique",
      });
    }
    if (!optionIds.includes(question.recommendation)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "must identify one of the supplied options",
      });
    }
  });
export type PlanningQuestion = z.infer<typeof PlanningQuestionSchema>;

export const PlanningQuestionnaireSchema = z
  .object({
    version: z.literal(1),
    repository: z
      .object({
        summary: z.string().trim().min(1).max(8_000),
        current_structure: z
          .array(z.string().trim().min(1).max(2_000))
          .min(1)
          .max(64),
        anchors: z.array(SourceAnchorSchema).min(1).max(128),
      })
      .strict(),
    questions: z.array(PlanningQuestionSchema).max(5),
    assumptions: z.array(z.string().trim().min(1).max(2_000)).max(32),
  })
  .strict()
  .superRefine((questionnaire, context) => {
    const questionIds = questionnaire.questions.map((question) => question.id);
    if (new Set(questionIds).size !== questionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "question identifiers must be unique",
      });
    }
  });
export type PlanningQuestionnaire = z.infer<typeof PlanningQuestionnaireSchema>;

export const PlanningStatusSchema = z.enum([
  "drafting",
  "awaiting-answers",
  "answered",
  "consulting",
  "consulted",
  "criticizing",
  "criticized",
  "synthesizing",
  "drafted",
]);
export type PlanningStatus = z.infer<typeof PlanningStatusSchema>;

export const PlanningConsultationRoleSchema = z.enum(["architecture", "quant"]);
export type PlanningConsultationRole = z.infer<
  typeof PlanningConsultationRoleSchema
>;
export const planningConsultationRoles = PlanningConsultationRoleSchema.options;

const PlanningConsultationProgressSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    current_request_digest: DigestSchema.nullable(),
    record_digest: DigestSchema.nullable(),
    report_digest: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (
      (progress.attempts === 0) !==
      (progress.current_request_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_request_digest"],
        message: "must exist exactly after a consultation attempt starts",
      });
    }
    if (
      (progress.record_digest === null) !==
      (progress.report_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["report_digest"],
        message: "must exist exactly with the consultation record digest",
      });
    }
    if (progress.record_digest !== null && progress.attempts === 0) {
      context.addIssue({
        code: "custom",
        path: ["record_digest"],
        message: "cannot exist before a consultation attempt",
      });
    }
  });

export type PlanningConsultationProgress = z.infer<
  typeof PlanningConsultationProgressSchema
>;

function emptyConsultationProgress(): PlanningConsultationProgress {
  return {
    attempts: 0,
    current_request_digest: null,
    record_digest: null,
    report_digest: null,
  };
}

const PlanningConsultationsSchema = z
  .object({
    architecture: PlanningConsultationProgressSchema,
    quant: PlanningConsultationProgressSchema,
  })
  .strict();

const PlanningSynthesisProgressSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    current_request_digest: DigestSchema.nullable(),
    record_digest: DigestSchema.nullable(),
    report_digest: DigestSchema.nullable(),
    plan_digest: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (
      (progress.attempts === 0) !==
      (progress.current_request_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_request_digest"],
        message: "must exist exactly after a synthesis attempt starts",
      });
    }
    const published = [
      progress.record_digest,
      progress.report_digest,
      progress.plan_digest,
    ].filter((value) => value !== null).length;
    if (published !== 0 && published !== 3) {
      context.addIssue({
        code: "custom",
        path: ["plan_digest"],
        message: "record, Report, and Plan digests must be published together",
      });
    }
    if (progress.record_digest !== null && progress.attempts === 0) {
      context.addIssue({
        code: "custom",
        path: ["record_digest"],
        message: "cannot exist before a synthesis attempt",
      });
    }
  });

type PlanningSynthesisProgress = z.infer<
  typeof PlanningSynthesisProgressSchema
>;

function emptySynthesisProgress(): PlanningSynthesisProgress {
  return {
    attempts: 0,
    current_request_digest: null,
    record_digest: null,
    report_digest: null,
    plan_digest: null,
  };
}

export const PlanningStateSchema = z
  .object({
    version: z.literal(2),
    id: PlanningIdSchema,
    project_id: IdentifierSchema,
    goal: HumanTextSchema,
    goal_digest: DigestSchema,
    base_commit: GitCommitSchema,
    source_digest: DigestSchema,
    source_entries: z.number().int().positive(),
    status: PlanningStatusSchema,
    attempts: z.number().int().nonnegative(),
    current_request_digest: DigestSchema.nullable(),
    questionnaire_digest: DigestSchema.nullable(),
    decisions: z.record(PlanningQuestionIdSchema, DigestSchema),
    consultations: PlanningConsultationsSchema.default({
      architecture: emptyConsultationProgress(),
      quant: emptyConsultationProgress(),
    }),
    critique: PlanningConsultationProgressSchema.default(
      emptyConsultationProgress(),
    ),
    synthesis: PlanningSynthesisProgressSchema.default(
      emptySynthesisProgress(),
    ),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.attempts === 0 && state.current_request_digest !== null) {
      context.addIssue({
        code: "custom",
        path: ["current_request_digest"],
        message: "cannot exist before the first attempt",
      });
    }
    if (state.attempts > 0 && state.current_request_digest === null) {
      context.addIssue({
        code: "custom",
        path: ["current_request_digest"],
        message: "is required after an attempt starts",
      });
    }
    const hasQuestionnaire = state.questionnaire_digest !== null;
    if ((state.status !== "drafting") !== hasQuestionnaire) {
      context.addIssue({
        code: "custom",
        path: ["questionnaire_digest"],
        message: "must exist exactly when questionnaire drafting is complete",
      });
    }
    if (
      ![
        "answered",
        "consulting",
        "consulted",
        "criticizing",
        "criticized",
        "synthesizing",
        "drafted",
      ].includes(state.status) &&
      Object.keys(state.decisions).length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "cannot be published before all answers are accepted",
      });
    }
    const progress = planningConsultationRoles.map(
      (role) => state.consultations[role],
    );
    const started = progress.some((item) => item.attempts > 0);
    const completed = progress.filter(
      (item) => item.record_digest !== null,
    ).length;
    if (
      ["drafting", "awaiting-answers", "answered"].includes(state.status) &&
      started
    ) {
      context.addIssue({
        code: "custom",
        path: ["consultations"],
        message: "cannot start before accepted answers enter consultation",
      });
    }
    if (state.status === "consulting" && (!started || completed === 2)) {
      context.addIssue({
        code: "custom",
        path: ["consultations"],
        message: "must contain an incomplete consultation attempt",
      });
    }
    if (
      [
        "consulted",
        "criticizing",
        "criticized",
        "synthesizing",
        "drafted",
      ].includes(state.status) &&
      completed !== 2
    ) {
      context.addIssue({
        code: "custom",
        path: ["consultations"],
        message: "must contain both completed consultation Reports",
      });
    }
    const critiqueStarted = state.critique.attempts > 0;
    const critiqueComplete = state.critique.record_digest !== null;
    const synthesisStarted = state.synthesis.attempts > 0;
    const synthesisComplete = state.synthesis.record_digest !== null;
    if (
      [
        "drafting",
        "awaiting-answers",
        "answered",
        "consulting",
        "consulted",
      ].includes(state.status) &&
      (critiqueStarted || synthesisStarted)
    ) {
      context.addIssue({
        code: "custom",
        path: ["critique"],
        message: "cannot start before both consultations are complete",
      });
    }
    if (
      state.status === "criticizing" &&
      (!critiqueStarted || critiqueComplete || synthesisStarted)
    ) {
      context.addIssue({
        code: "custom",
        path: ["critique"],
        message: "must contain an incomplete critic attempt",
      });
    }
    if (
      state.status === "criticized" &&
      (!critiqueComplete || synthesisStarted)
    ) {
      context.addIssue({
        code: "custom",
        path: ["critique"],
        message: "must contain a completed critique before synthesis",
      });
    }
    if (
      state.status === "synthesizing" &&
      (!critiqueComplete || !synthesisStarted || synthesisComplete)
    ) {
      context.addIssue({
        code: "custom",
        path: ["synthesis"],
        message: "must contain an incomplete synthesis attempt",
      });
    }
    if (
      state.status === "drafted" &&
      (!critiqueComplete || !synthesisComplete)
    ) {
      context.addIssue({
        code: "custom",
        path: ["synthesis"],
        message: "must contain a completed critique and Plan draft",
      });
    }
  });
export type PlanningState = z.infer<typeof PlanningStateSchema>;

const PlanningBriefArtifactSchema = z
  .object({
    version: z.literal(1),
    content: z.string().min(1),
    digest: DigestSchema,
  })
  .strict();
type PlanningBriefArtifact = z.infer<typeof PlanningBriefArtifactSchema>;
const PlanningRequestWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: PlanningIdSchema,
    project_id: IdentifierSchema,
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    goal_digest: DigestSchema,
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
  .strict();

export const PlanningRequestSchema = PlanningRequestWithoutDigestSchema.extend({
  request_digest: DigestSchema,
}).strict();
export type PlanningRequest = z.infer<typeof PlanningRequestSchema>;

const PlanningTurnSchema = ModelTurnResultSchema.pick({
  message_ids: true,
  model_profile: true,
  requested_model: true,
  response_model: true,
  stop_reason: true,
  truncated: true,
  usage: true,
});

const PlanningQuestionnaireRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: PlanningIdSchema,
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    request_digest: DigestSchema,
    goal_digest: DigestSchema,
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
    questionnaire: PlanningQuestionnaireSchema,
    response: z
      .string()
      .min(1)
      .max(32 * 1024),
    response_digest: DigestSchema,
    turn: PlanningTurnSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const PlanningQuestionnaireRecordSchema =
  PlanningQuestionnaireRecordWithoutDigestSchema.extend({
    record_digest: DigestSchema,
  }).strict();
export type PlanningQuestionnaireRecord = z.infer<
  typeof PlanningQuestionnaireRecordSchema
>;

const PlanningAnswerSchema = z
  .object({
    question: PlanningQuestionIdSchema,
    kind: z.enum(["option", "free-form"]),
    value: HumanTextSchema,
    option: IdentifierSchema.nullable(),
  })
  .strict();
export type PlanningAnswer = z.infer<typeof PlanningAnswerSchema>;

const PlanningDecisionRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: PlanningIdSchema,
    questionnaire_digest: DigestSchema,
    question_digest: DigestSchema,
    accepted_by: HumanTextSchema,
    answer: PlanningAnswerSchema,
    decision: DecisionSchema,
  })
  .strict();

export const PlanningDecisionRecordSchema =
  PlanningDecisionRecordWithoutDigestSchema.extend({
    record_digest: DigestSchema,
  }).strict();
export type PlanningDecisionRecord = z.infer<
  typeof PlanningDecisionRecordSchema
>;

export const PLANNING_OUTPUT_CONTRACT = `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "version": 1,
  "repository": {
    "summary": "concise repository-aware summary",
    "current_structure": ["observed structure and constraints"],
    "anchors": [{"path":"relative/tracked/file","symbol":"optional symbol","reason":"why this evidence matters"}]
  },
  "questions": [{
    "id": "descriptive-question-id",
    "scope": "run",
    "question": "one material choice the repository cannot resolve",
    "why": "why this choice changes the design",
    "options": [
      {"id":"conservative","label":"short choice","tradeoff":"main consequence"},
      {"id":"target","label":"different choice","tradeoff":"different consequence"}
    ],
    "recommendation": "conservative",
    "allow_free_form": true
  }],
  "assumptions": ["explicit assumption grounded in repository evidence"]
}

Inspect /workspace/project with repository tools before answering. Ask zero to five questions. Set each scope to either "project" or "run". Every question must offer two to four materially different options, explain the main tradeoff, recommend one option, and permit free-form input. Do not ask anything the repository resolves. Use only tracked file paths present in the supplied source snapshot as anchors. Return no prose outside the JSON object.`;

export interface CompiledPlanningBrief {
  readonly content: string;
  readonly digest: Digest;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly omissions: readonly string[];
  readonly permissionCeilingDigest: Digest;
}

export interface PlanningSession {
  readonly info: ReadSessionInfo;
  run(message: Message): Promise<ModelTurnResult>;
  stop(): Promise<void>;
}

export type PlanningSessionLauncher = (
  options: StartReadSessionOptions,
) => Promise<PlanningSession>;

export type PlanningProjectStore = Pick<ProjectStore, "planningDirectory">;

export interface RunPlanningOptions {
  readonly store: PlanningProjectStore;
  readonly project: Project;
  readonly local: LocalConfig;
  readonly client: ReadSessionOpenShell;
  readonly goal: string;
  readonly planningId?: string;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly launchSession?: PlanningSessionLauncher;
  readonly workspaceFactory?: SourceWorkspaceFactory;
}

export interface RunPlanningResult {
  readonly state: PlanningState;
  readonly request: PlanningRequest;
  readonly record: PlanningQuestionnaireRecord;
  readonly reused: boolean;
}

export interface AnswerPlanningOptions {
  readonly store: PlanningProjectStore;
  readonly project: Project;
  readonly planningId: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly acceptedBy: string;
  readonly now?: Date;
}

export interface AnswerPlanningResult {
  readonly state: PlanningState;
  readonly decisions: readonly PlanningDecisionRecord[];
  readonly reused: boolean;
}

function planningStateDigest(goal: string): Digest {
  return digestParts("pi-orchestrator/planning-goal/v1", [["goal", goal]]);
}

function requestDigest(
  request: z.infer<typeof PlanningRequestWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-request/v1", [
    ["request", canonicalJson(request)],
  ]);
}

function questionnaireRecordDigest(
  record: z.infer<typeof PlanningQuestionnaireRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-questionnaire/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function decisionRecordDigest(
  record: z.infer<typeof PlanningDecisionRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-decision/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function planningSection(title: string, content: string): string {
  return `## ${title}\n\n${content.trim()}\n`;
}

export function compilePlanningBrief(input: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly goal: string;
  readonly source: PlanningSourceManifest;
  readonly contextLimitTokens: number;
}): CompiledPlanningBrief {
  const budgetTokens = Math.max(
    1,
    Math.floor(
      input.contextLimitTokens * input.project.config.context.initial_fraction,
    ),
  );
  const required = [
    planningSection(
      "Identity",
      `Planning: ${input.identity.run}\nAgent: ${input.identity.agent}\nSession: ${input.identity.session}\nGeneration: ${input.identity.generation}`,
    ),
    planningSection("Project Instructions", input.project.agents),
    planningSection(
      "Role",
      `${canonicalJson(input.role.definition)}\n\n${input.role.body}`,
    ),
    planningSection(
      "Permission Ceiling",
      `Digest: ${input.permissionCeiling.permission_ceiling_digest}\n\n${canonicalJson({ source: input.permissionCeiling.source, write_lease: input.permissionCeiling.write_lease, pi_tools: input.permissionCeiling.pi_tools, actions: input.permissionCeiling.actions, assignment: input.permissionCeiling.assignment })}`,
    ),
    planningSection(
      "Model Profile",
      `Profile: ${input.model.profile}\nRoute digest: ${input.model.route_digest}\nConcrete model: ${input.model.pi_model}\nLocality: ${input.model.locality}`,
    ),
    planningSection("Goal", input.goal),
    planningSection(
      "Repository Evidence",
      `The exact committed repository is mounted read-only at /workspace/project.\nCommit: ${input.source.commit}\nSource digest: ${input.source.source_digest}\nTracked entries: ${input.source.entries.length}\nTracked bytes: ${planningSourceBytes(input.source)}`,
    ),
    planningSection("Required Output", PLANNING_OUTPUT_CONTRACT),
  ];
  let content = `# Planning Questionnaire Brief\n\n${required.join("\n")}`;
  const omissions: string[] = [];
  for (const name of input.role.definition.skills) {
    const skill = input.project.skills.get(name);
    if (!skill) {
      throw new OrchestratorError(
        "unknown_skill",
        `Planning Role references unavailable Skill '${name}'`,
      );
    }
    const candidate = planningSection(`Skill: ${skill.name}`, skill.content);
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
    content += `\n${planningSection(
      "Explicit Omissions",
      omissions.map((omission) => `- ${omission}`).join("\n"),
    )}`;
  }
  return {
    content,
    digest: digestParts("pi-orchestrator/planning-brief/v1", [
      ["brief.md", content],
    ]),
    estimatedTokens: estimateTokens(content),
    budgetTokens,
    omissions,
    permissionCeilingDigest: input.permissionCeiling.permission_ceiling_digest,
  };
}

function parseJsonObject(text: string): unknown {
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
      "invalid_planning_output",
      "Planning Session did not return exactly one valid JSON object",
      { cause: error },
    );
  }
}

export function parsePlanningQuestionnaire(
  text: string,
  sourcePaths?: ReadonlySet<string>,
): PlanningQuestionnaire {
  const result = PlanningQuestionnaireSchema.safeParse(parseJsonObject(text));
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_planning_output",
      `Invalid planning questionnaire: ${result.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "questionnaire"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }
  if (sourcePaths) {
    const unknown = result.data.repository.anchors
      .map((anchor) => anchor.path)
      .filter((anchorPath) => !sourcePaths.has(anchorPath));
    if (unknown.length > 0) {
      throw new OrchestratorError(
        "invalid_source_anchor",
        `Planning questionnaire references paths absent from the exact source snapshot: ${[...new Set(unknown)].join(", ")}`,
      );
    }
  }
  return result.data;
}

function parseStored<T>(
  schema: z.ZodType<T>,
  source: string,
  filePath: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_planning_store",
      `Invalid JSON in ${filePath}`,
      { cause: error },
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_planning_store",
      `Invalid ${filePath}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parsePlanningState(source: string, filePath: string): PlanningState {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return parseStored(PlanningStateSchema, source, filePath);
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    raw.version === 1
  ) {
    throw new OrchestratorError(
      "unsupported_state_version",
      `Planning state at ${filePath} uses unsupported schema version 1; unfinished v0.2 planning operations are not migrated or resumed automatically`,
    );
  }
  return parseStored(PlanningStateSchema, source, filePath);
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function putImmutable<T>(
  filePath: string,
  value: T,
  schema: z.ZodType<T>,
  conflictCode: string,
): Promise<T> {
  const parsed = schema.parse(value);
  const existingSource = await readOptional(filePath);
  if (existingSource !== undefined) {
    const existing = parseStored(schema, existingSource, filePath);
    if (canonicalJson(existing) !== canonicalJson(parsed)) {
      throw new OrchestratorError(
        conflictCode,
        `Immutable planning evidence already exists at ${filePath} with other content`,
      );
    }
    return existing;
  }
  await writeJsonAtomic(filePath, parsed);
  return parsed;
}

export class PlanningStore {
  constructor(private readonly projectStore: PlanningProjectStore) {}

  directory(id: string): string {
    return this.projectStore.planningDirectory(PlanningIdSchema.parse(id));
  }

  private stateFile(id: string): string {
    return path.join(this.directory(id), "state.json");
  }

  private sourceFile(id: string): string {
    return path.join(this.directory(id), "source.json");
  }

  private attemptDirectory(id: string, attempt: number): string {
    return path.join(
      this.directory(id),
      "attempts",
      String(z.number().int().positive().parse(attempt)),
    );
  }

  private decisionFile(id: string, question: string): string {
    return path.join(
      this.directory(id),
      "decisions",
      `${PlanningQuestionIdSchema.parse(question)}.json`,
    );
  }

  async get(id: string): Promise<PlanningState> {
    const filePath = this.stateFile(id);
    const source = await readOptional(filePath);
    if (source === undefined) {
      throw new OrchestratorError(
        "planning_not_found",
        `Planning request '${id}' does not exist`,
      );
    }
    return parsePlanningState(source, filePath);
  }

  async list(): Promise<PlanningState[]> {
    const root = path.join(
      path.dirname(this.projectStore.planningDirectory("probe")),
    );
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const states: PlanningState[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !PlanningIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "invalid_planning_store",
          `Unexpected planning state entry '${entry.name}'`,
        );
      }
      states.push(await this.get(entry.name));
    }
    return states;
  }

  async ensure(input: {
    readonly id: string;
    readonly projectId: string;
    readonly goal: string;
    readonly baseCommit: string;
    readonly source: PlanningSourceManifest;
    readonly now: Date;
  }): Promise<{ readonly state: PlanningState; readonly created: boolean }> {
    const id = PlanningIdSchema.parse(input.id);
    const source = PlanningSourceManifestSchema.parse(input.source);
    const goal = HumanTextSchema.parse(input.goal);
    const existingSource = await readOptional(this.stateFile(id));
    if (existingSource !== undefined) {
      const existing = parsePlanningState(existingSource, this.stateFile(id));
      if (
        existing.project_id !== input.projectId ||
        existing.goal !== goal ||
        existing.goal_digest !== planningStateDigest(goal)
      ) {
        throw new OrchestratorError(
          "planning_conflict",
          `Planning request '${id}' already represents another goal or Project`,
        );
      }
      if (
        existing.base_commit !== input.baseCommit ||
        existing.source_digest !== source.source_digest
      ) {
        throw new OrchestratorError(
          "planning_source_stale",
          `Planning request '${id}' is bound to another repository revision; start a new planning ID`,
        );
      }
      await this.requireSource(id, source);
      return { state: existing, created: false };
    }

    const timestamp = input.now.toISOString();
    const state = PlanningStateSchema.parse({
      version: 2,
      id,
      project_id: input.projectId,
      goal,
      goal_digest: planningStateDigest(goal),
      base_commit: input.baseCommit,
      source_digest: source.source_digest,
      source_entries: source.entries.length,
      status: "drafting",
      attempts: 0,
      current_request_digest: null,
      questionnaire_digest: null,
      decisions: {},
      consultations: {
        architecture: emptyConsultationProgress(),
        quant: emptyConsultationProgress(),
      },
      critique: emptyConsultationProgress(),
      synthesis: emptySynthesisProgress(),
      created_at: timestamp,
      updated_at: timestamp,
    });
    await mkdir(this.directory(id), { recursive: true });
    await putImmutable(
      this.sourceFile(id),
      source,
      PlanningSourceManifestSchema,
      "planning_source_conflict",
    );
    await writeJsonAtomic(this.stateFile(id), state);
    return { state, created: true };
  }

  private async requireSource(
    id: string,
    expected: PlanningSourceManifest,
  ): Promise<PlanningSourceManifest> {
    const filePath = this.sourceFile(id);
    const source = await readOptional(filePath);
    if (source === undefined) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${id}' is missing its source manifest`,
      );
    }
    const stored = parseStored(PlanningSourceManifestSchema, source, filePath);
    if (canonicalJson(stored) !== canonicalJson(expected)) {
      throw new OrchestratorError(
        "planning_source_conflict",
        `Planning request '${id}' source manifest changed`,
      );
    }
    return stored;
  }

  async source(id: string): Promise<PlanningSourceManifest> {
    const state = await this.get(id);
    const filePath = this.sourceFile(state.id);
    const source = await readOptional(filePath);
    if (source === undefined) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${state.id}' is missing its source manifest`,
      );
    }
    const manifest = parseStored(
      PlanningSourceManifestSchema,
      source,
      filePath,
    );
    if (
      manifest.commit !== state.base_commit ||
      manifest.source_digest !== state.source_digest ||
      manifest.entries.length !== state.source_entries
    ) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${state.id}' source manifest does not match its state`,
      );
    }
    return manifest;
  }

  async getRequest(id: string, attempt: number): Promise<PlanningRequest> {
    const filePath = path.join(
      this.attemptDirectory(id, attempt),
      "request.json",
    );
    const source = await readOptional(filePath);
    if (source === undefined) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${id}' attempt ${attempt} is missing its request`,
      );
    }
    const request = parseStored(PlanningRequestSchema, source, filePath);
    const { request_digest: storedDigest, ...unsigned } = request;
    if (requestDigest(unsigned) !== storedDigest) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${id}' attempt ${attempt} has an invalid digest`,
      );
    }
    return request;
  }

  async findPreparedAttempt(
    id: string,
    attempt: number,
  ): Promise<
    | {
        readonly request: PlanningRequest;
        readonly brief: PlanningBriefArtifact;
      }
    | undefined
  > {
    const directory = this.attemptDirectory(id, attempt);
    const [requestSource, briefSource] = await Promise.all([
      readOptional(path.join(directory, "request.json")),
      readOptional(path.join(directory, "brief.json")),
    ]);
    if (requestSource === undefined && briefSource === undefined) {
      return undefined;
    }
    if (requestSource === undefined || briefSource === undefined) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${id}' attempt ${attempt} is only partially prepared`,
      );
    }
    const request = await this.getRequest(id, attempt);
    const briefPath = path.join(directory, "brief.json");
    const brief = parseStored(
      PlanningBriefArtifactSchema,
      briefSource,
      briefPath,
    );
    if (
      digestParts("pi-orchestrator/planning-brief/v1", [
        ["brief.md", brief.content],
      ]) !== brief.digest ||
      brief.digest !== request.brief_digest
    ) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${id}' attempt ${attempt} has invalid Brief evidence`,
      );
    }
    return { request, brief };
  }

  async beginAttempt(input: {
    readonly state: PlanningState;
    readonly request: PlanningRequest;
    readonly brief: Pick<CompiledPlanningBrief, "content" | "digest">;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.state.id);
    if (canonicalJson(current) !== canonicalJson(input.state)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before the next attempt`,
      );
    }
    if (current.status !== "drafting") return current;
    if (input.request.attempt !== current.attempts + 1) {
      throw new OrchestratorError(
        "planning_attempt_conflict",
        `Planning request '${current.id}' expected attempt ${current.attempts + 1}`,
      );
    }
    const { request_digest: storedRequestDigest, ...unsignedRequest } =
      input.request;
    if (
      requestDigest(unsignedRequest) !== storedRequestDigest ||
      input.request.planning !== current.id ||
      input.request.project_id !== current.project_id ||
      input.request.goal_digest !== current.goal_digest ||
      input.request.base_commit !== current.base_commit ||
      input.request.source_digest !== current.source_digest ||
      input.request.source_entries !== current.source_entries ||
      input.request.identity.run !== current.id ||
      input.request.identity.agent !== "lead" ||
      input.request.identity.generation !== input.request.attempt ||
      input.request.brief_digest !== input.brief.digest
    ) {
      throw new OrchestratorError(
        "planning_attempt_conflict",
        `Planning attempt ${input.request.attempt} does not match request '${current.id}'`,
      );
    }
    const briefArtifact = PlanningBriefArtifactSchema.parse({
      version: 1,
      content: input.brief.content,
      digest: input.brief.digest,
    });
    if (
      digestParts("pi-orchestrator/planning-brief/v1", [
        ["brief.md", briefArtifact.content],
      ]) !== briefArtifact.digest
    ) {
      throw new OrchestratorError(
        "invalid_planning_brief",
        "Planning Brief content does not match its digest",
      );
    }
    const directory = this.attemptDirectory(current.id, input.request.attempt);
    await mkdir(directory, { recursive: true });
    await putImmutable(
      path.join(directory, "brief.json"),
      briefArtifact,
      PlanningBriefArtifactSchema,
      "planning_attempt_conflict",
    );
    await putImmutable(
      path.join(directory, "request.json"),
      input.request,
      PlanningRequestSchema,
      "planning_attempt_conflict",
    );
    const next = PlanningStateSchema.parse({
      ...current,
      attempts: input.request.attempt,
      current_request_digest: input.request.request_digest,
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async getQuestionnaire(
    id: string,
    attempt?: number,
  ): Promise<PlanningQuestionnaireRecord | undefined> {
    const state = await this.get(id);
    const selectedAttempt = attempt ?? state.attempts;
    if (selectedAttempt === 0) return undefined;
    const filePath = path.join(
      this.attemptDirectory(state.id, selectedAttempt),
      "questionnaire.json",
    );
    const source = await readOptional(filePath);
    if (source === undefined) return undefined;
    const record = parseStored(
      PlanningQuestionnaireRecordSchema,
      source,
      filePath,
    );
    const { record_digest: storedDigest, ...unsigned } = record;
    if (
      questionnaireRecordDigest(unsigned) !== storedDigest ||
      sha256(record.response) !== record.response_digest
    ) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning questionnaire '${record.planning}' has invalid content digests`,
      );
    }
    return record;
  }

  async currentQuestionnaire(id: string): Promise<{
    readonly request: PlanningRequest;
    readonly record: PlanningQuestionnaireRecord;
  }> {
    return currentQuestionnaire(this, await this.get(id));
  }

  async publishQuestionnaire(input: {
    readonly expected: PlanningState;
    readonly record: PlanningQuestionnaireRecord;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before questionnaire publication`,
      );
    }
    const request = await this.getRequest(current.id, input.record.attempt);
    const { record_digest: storedRecordDigest, ...unsignedRecord } =
      input.record;
    if (
      questionnaireRecordDigest(unsignedRecord) !== storedRecordDigest ||
      sha256(input.record.response) !== input.record.response_digest ||
      current.status !== "drafting" ||
      current.attempts !== input.record.attempt ||
      current.current_request_digest !== request.request_digest ||
      input.record.request_digest !== request.request_digest
    ) {
      throw new OrchestratorError(
        "planning_attempt_conflict",
        `Questionnaire does not match the active attempt for '${current.id}'`,
      );
    }
    requireQuestionnaireRecord(current, request, input.record);
    const directory = this.attemptDirectory(current.id, input.record.attempt);
    const record = await putImmutable(
      path.join(directory, "questionnaire.json"),
      input.record,
      PlanningQuestionnaireRecordSchema,
      "planning_questionnaire_conflict",
    );
    const next = PlanningStateSchema.parse({
      ...current,
      status:
        record.questionnaire.questions.length === 0
          ? "answered"
          : "awaiting-answers",
      questionnaire_digest: record.record_digest,
      decisions: {},
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async putDecision(
    planningId: string,
    record: PlanningDecisionRecord,
  ): Promise<PlanningDecisionRecord> {
    const { record_digest: storedDigest, ...unsigned } = record;
    if (decisionRecordDigest(unsigned) !== storedDigest) {
      throw new OrchestratorError(
        "invalid_planning_decision",
        `Planning Decision '${record.answer.question}' has an invalid digest`,
      );
    }
    return putImmutable(
      this.decisionFile(planningId, record.answer.question),
      record,
      PlanningDecisionRecordSchema,
      "planning_decision_conflict",
    );
  }

  async findDecision(
    planningId: string,
    question: string,
  ): Promise<PlanningDecisionRecord | undefined> {
    const filePath = this.decisionFile(planningId, question);
    const source = await readOptional(filePath);
    if (source === undefined) return undefined;
    const record = parseStored(PlanningDecisionRecordSchema, source, filePath);
    const { record_digest: storedDigest, ...unsigned } = record;
    if (decisionRecordDigest(unsigned) !== storedDigest) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning Decision '${question}' has an invalid content digest`,
      );
    }
    return record;
  }

  async decisions(id: string): Promise<PlanningDecisionRecord[]> {
    const state = await this.get(id);
    const records: PlanningDecisionRecord[] = [];
    for (const question of Object.keys(state.decisions).sort()) {
      const filePath = this.decisionFile(state.id, question);
      const source = await readOptional(filePath);
      if (source === undefined) {
        throw new OrchestratorError(
          "invalid_planning_store",
          `Planning Decision '${question}' is missing`,
        );
      }
      const record = parseStored(
        PlanningDecisionRecordSchema,
        source,
        filePath,
      );
      const { record_digest: storedDigest, ...unsigned } = record;
      if (
        decisionRecordDigest(unsigned) !== storedDigest ||
        state.decisions[question] !== storedDigest
      ) {
        throw new OrchestratorError(
          "invalid_planning_store",
          `Planning Decision '${question}' has invalid content or state binding`,
        );
      }
      records.push(record);
    }
    return records;
  }

  async finishAnswers(input: {
    readonly expected: PlanningState;
    readonly records: readonly PlanningDecisionRecord[];
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before Decision publication`,
      );
    }
    if (current.status !== "awaiting-answers") {
      throw new OrchestratorError(
        "planning_not_awaiting_answers",
        `Planning request '${current.id}' is ${current.status}`,
      );
    }
    const questionnaire = await this.getQuestionnaire(
      current.id,
      current.attempts,
    );
    if (
      !questionnaire ||
      questionnaire.record_digest !== current.questionnaire_digest
    ) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${current.id}' has no current questionnaire`,
      );
    }
    const expectedQuestions = questionnaire.questionnaire.questions
      .map((question) => question.id)
      .sort();
    const actualQuestions = input.records
      .map((record) => record.answer.question)
      .sort();
    if (canonicalJson(expectedQuestions) !== canonicalJson(actualQuestions)) {
      throw new OrchestratorError(
        "invalid_planning_answers",
        "Published Decisions do not answer the exact questionnaire",
      );
    }
    for (const record of input.records) {
      const stored = await this.findDecision(
        current.id,
        record.answer.question,
      );
      if (
        !stored ||
        canonicalJson(stored) !== canonicalJson(record) ||
        stored.questionnaire_digest !== questionnaire.record_digest
      ) {
        throw new OrchestratorError(
          "planning_decision_conflict",
          `Planning Decision '${record.answer.question}' is not exact durable evidence`,
        );
      }
    }
    const decisions = Object.fromEntries(
      input.records.map((record) => [
        record.answer.question,
        record.record_digest,
      ]),
    );
    const next = PlanningStateSchema.parse({
      ...current,
      status: "answered",
      decisions,
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async beginConsultation(input: {
    readonly expected: PlanningState;
    readonly role: PlanningConsultationRole;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before consultation`,
      );
    }
    const role = PlanningConsultationRoleSchema.parse(input.role);
    if (!["answered", "consulting"].includes(current.status)) {
      throw new OrchestratorError(
        "planning_not_answered",
        `Planning request '${current.id}' is ${current.status}`,
      );
    }
    const progress = current.consultations[role];
    if (progress.record_digest !== null) return current;
    if (input.attempt !== progress.attempts + 1) {
      throw new OrchestratorError(
        "consultation_attempt_conflict",
        `${role} consultation expected attempt ${progress.attempts + 1}`,
      );
    }
    const next = PlanningStateSchema.parse({
      ...current,
      status: "consulting",
      consultations: {
        ...current.consultations,
        [role]: {
          attempts: input.attempt,
          current_request_digest: input.requestDigest,
          record_digest: null,
          report_digest: null,
        },
      },
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async publishConsultation(input: {
    readonly expected: PlanningState;
    readonly role: PlanningConsultationRole;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly recordDigest: Digest;
    readonly reportDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before consultation publication`,
      );
    }
    const role = PlanningConsultationRoleSchema.parse(input.role);
    const progress = current.consultations[role];
    if (
      current.status !== "consulting" ||
      progress.attempts !== input.attempt ||
      progress.current_request_digest !== input.requestDigest ||
      progress.record_digest !== null ||
      progress.report_digest !== null
    ) {
      throw new OrchestratorError(
        "consultation_attempt_conflict",
        `${role} consultation does not match its active attempt`,
      );
    }
    const consultations = {
      ...current.consultations,
      [role]: {
        ...progress,
        record_digest: input.recordDigest,
        report_digest: input.reportDigest,
      },
    };
    const complete = planningConsultationRoles.every(
      (name) => consultations[name].record_digest !== null,
    );
    const next = PlanningStateSchema.parse({
      ...current,
      status: complete ? "consulted" : "consulting",
      consultations,
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async beginCritique(input: {
    readonly expected: PlanningState;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before criticism`,
      );
    }
    if (!["consulted", "criticizing"].includes(current.status)) {
      throw new OrchestratorError(
        "planning_not_consulted",
        `Planning request '${current.id}' is ${current.status}`,
      );
    }
    if (current.critique.record_digest !== null) return current;
    if (input.attempt !== current.critique.attempts + 1) {
      throw new OrchestratorError(
        "critique_attempt_conflict",
        `Critique expected attempt ${current.critique.attempts + 1}`,
      );
    }
    const next = PlanningStateSchema.parse({
      ...current,
      status: "criticizing",
      critique: {
        attempts: input.attempt,
        current_request_digest: input.requestDigest,
        record_digest: null,
        report_digest: null,
      },
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async publishCritique(input: {
    readonly expected: PlanningState;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly recordDigest: Digest;
    readonly reportDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before critique publication`,
      );
    }
    if (
      current.status !== "criticizing" ||
      current.critique.attempts !== input.attempt ||
      current.critique.current_request_digest !== input.requestDigest ||
      current.critique.record_digest !== null ||
      current.critique.report_digest !== null
    ) {
      throw new OrchestratorError(
        "critique_attempt_conflict",
        "Critique does not match its active attempt",
      );
    }
    const next = PlanningStateSchema.parse({
      ...current,
      status: "criticized",
      critique: {
        ...current.critique,
        record_digest: input.recordDigest,
        report_digest: input.reportDigest,
      },
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async beginSynthesis(input: {
    readonly expected: PlanningState;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (!["criticized", "synthesizing"].includes(current.status)) {
      throw new OrchestratorError(
        "planning_not_criticized",
        `Planning request '${current.id}' is ${current.status}`,
      );
    }
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before synthesis`,
      );
    }
    if (current.synthesis.record_digest !== null) return current;
    if (input.attempt !== current.synthesis.attempts + 1) {
      throw new OrchestratorError(
        "synthesis_attempt_conflict",
        `Synthesis expected attempt ${current.synthesis.attempts + 1}`,
      );
    }
    const next = PlanningStateSchema.parse({
      ...current,
      status: "synthesizing",
      synthesis: {
        attempts: input.attempt,
        current_request_digest: input.requestDigest,
        record_digest: null,
        report_digest: null,
        plan_digest: null,
      },
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }

  async publishSynthesis(input: {
    readonly expected: PlanningState;
    readonly attempt: number;
    readonly requestDigest: Digest;
    readonly recordDigest: Digest;
    readonly reportDigest: Digest;
    readonly planDigest: Digest;
    readonly now: Date;
  }): Promise<PlanningState> {
    const current = await this.get(input.expected.id);
    if (canonicalJson(current) !== canonicalJson(input.expected)) {
      throw new OrchestratorError(
        "planning_state_conflict",
        `Planning request '${current.id}' changed before Plan draft publication`,
      );
    }
    if (
      current.status !== "synthesizing" ||
      current.synthesis.attempts !== input.attempt ||
      current.synthesis.current_request_digest !== input.requestDigest ||
      current.synthesis.record_digest !== null ||
      current.synthesis.report_digest !== null ||
      current.synthesis.plan_digest !== null
    ) {
      throw new OrchestratorError(
        "synthesis_attempt_conflict",
        "Plan synthesis does not match its active attempt",
      );
    }
    const next = PlanningStateSchema.parse({
      ...current,
      status: "drafted",
      synthesis: {
        ...current.synthesis,
        record_digest: input.recordDigest,
        report_digest: input.reportDigest,
        plan_digest: input.planDigest,
      },
      updated_at: input.now.toISOString(),
    });
    await writeJsonAtomic(this.stateFile(current.id), next);
    return next;
  }
}

export function planningIdForGoal(goal: string): string {
  const parsed = HumanTextSchema.parse(goal);
  const slug =
    parsed
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "change";
  return PlanningIdSchema.parse(
    `plan-${slug}-${sha256(parsed).slice("sha256:".length, "sha256:".length + 8)}`,
  );
}

export async function requireCleanPlanningProject(
  project: Project,
): Promise<string> {
  const status = await gitOutput(project.root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new OrchestratorError(
      "dirty_project",
      "Repository-aware planning requires a clean checkout so every observation binds to the exact base commit",
    );
  }
  return gitHead(project.root);
}

function requirePlanningRole(project: Project): LoadedRole {
  const role = project.roles.get("lead");
  if (!role) {
    throw new OrchestratorError(
      "planning_role_not_found",
      "Repository-aware planning requires the 'lead' Role",
    );
  }
  if (
    !roleHasReadSource(role.definition) ||
    role.definition.permissions.write_lease !== "never"
  ) {
    throw new OrchestratorError(
      "invalid_planning_role",
      "The planning Lead must explicitly permit read-only source access",
    );
  }
  return role;
}

function requirePlanningPreflight(
  preflight: OpenShellPreflight,
  model: ResolvedModelRoute,
): void {
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "Planning requires an exact OpenShell version pin",
    );
  }
  if (preflight.status.gateway !== model.gateway) {
    throw new OrchestratorError(
      "model_gateway_mismatch",
      `Planning model '${model.profile}' requires gateway '${model.gateway}', but the client reached '${preflight.status.gateway}'`,
    );
  }
}

function createPlanningRequest(input: {
  readonly state: PlanningState;
  readonly attempt: number;
  readonly identity: SessionIdentity;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledPlanningBrief;
  readonly messageId: string;
  readonly now: Date;
}): PlanningRequest {
  const unsigned = PlanningRequestWithoutDigestSchema.parse({
    version: 1,
    planning: input.state.id,
    project_id: input.state.project_id,
    attempt: input.attempt,
    identity: input.identity,
    goal_digest: input.state.goal_digest,
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
  return PlanningRequestSchema.parse({
    ...unsigned,
    request_digest: requestDigest(unsigned),
  });
}

function requireCurrentPlanningRequest(input: {
  readonly state: PlanningState;
  readonly request: PlanningRequest;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: Pick<CompiledPlanningBrief, "content" | "digest">;
}): void {
  if (
    input.request.planning !== input.state.id ||
    input.request.project_id !== input.state.project_id ||
    input.request.goal_digest !== input.state.goal_digest ||
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
    input.request.identity.agent !== "lead" ||
    input.request.identity.generation !== input.request.attempt
  ) {
    throw new OrchestratorError(
      "planning_attempt_stale",
      `Prepared planning attempt ${input.request.attempt} no longer matches its Project inputs`,
    );
  }
}

function createQuestionnaireRecord(input: {
  readonly request: PlanningRequest;
  readonly session: ReadSessionInfo;
  readonly questionnaire: PlanningQuestionnaire;
  readonly turn: ModelTurnResult;
  readonly now: Date;
}): PlanningQuestionnaireRecord {
  const unsigned = PlanningQuestionnaireRecordWithoutDigestSchema.parse({
    version: 1,
    planning: input.request.planning,
    attempt: input.request.attempt,
    identity: input.request.identity,
    request_digest: input.request.request_digest,
    goal_digest: input.request.goal_digest,
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
    questionnaire: input.questionnaire,
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
    created_at: input.now.toISOString(),
  });
  return PlanningQuestionnaireRecordSchema.parse({
    ...unsigned,
    record_digest: questionnaireRecordDigest(unsigned),
  });
}

function requireSessionBinding(input: {
  readonly info: ReadSessionInfo;
  readonly identity: SessionIdentity;
  readonly source: PlanningSource;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly policyDigest: Digest;
  readonly brief: CompiledPlanningBrief;
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
      "planning_session_mismatch",
      "Planning Session does not match its source, Brief, model, policy, or identity",
    );
  }
  requirePlanningPreflight(input.info.openshell, input.model);
}

function requireQuestionnaireRecord(
  state: PlanningState,
  request: PlanningRequest,
  record: PlanningQuestionnaireRecord,
): void {
  if (
    record.planning !== state.id ||
    record.attempt !== state.attempts ||
    record.request_digest !== state.current_request_digest ||
    record.request_digest !== request.request_digest ||
    record.goal_digest !== state.goal_digest ||
    record.base_commit !== state.base_commit ||
    record.source_digest !== state.source_digest ||
    !sameSessionIdentity(record.identity, request.identity) ||
    record.role_digest !== request.role.digest ||
    record.permission_ceiling_digest !== request.permission_ceiling_digest ||
    canonicalJson(record.model) !== canonicalJson(request.model) ||
    record.policy_digest !== request.policy_digest ||
    record.brief_digest !== request.brief_digest ||
    !record.turn.message_ids.includes(request.message_id) ||
    record.turn.model_profile !== request.model.profile ||
    record.turn.requested_model !== request.model.pi_model ||
    record.turn.truncated
  ) {
    throw new OrchestratorError(
      "planning_questionnaire_stale",
      `Stored questionnaire no longer matches Planning request '${state.id}'`,
    );
  }
}

async function currentQuestionnaire(
  store: PlanningStore,
  state: PlanningState,
): Promise<{
  readonly request: PlanningRequest;
  readonly record: PlanningQuestionnaireRecord;
}> {
  if (state.attempts === 0 || state.current_request_digest === null) {
    throw new OrchestratorError(
      "invalid_planning_store",
      `Planning request '${state.id}' has no questionnaire attempt`,
    );
  }
  const request = await store.getRequest(state.id, state.attempts);
  const record = await store.getQuestionnaire(state.id, state.attempts);
  if (!record) {
    throw new OrchestratorError(
      "invalid_planning_store",
      `Planning request '${state.id}' is missing its questionnaire`,
    );
  }
  requireQuestionnaireRecord(state, request, record);
  if (
    state.questionnaire_digest !== null &&
    state.questionnaire_digest !== record.record_digest
  ) {
    throw new OrchestratorError(
      "invalid_planning_store",
      `Planning request '${state.id}' state references another questionnaire`,
    );
  }
  return { request, record };
}

export async function runPlanningQuestionnaire(
  options: RunPlanningOptions,
): Promise<RunPlanningResult> {
  const now = options.now ?? (() => new Date());
  const goal = HumanTextSchema.parse(options.goal);
  const planningId = PlanningIdSchema.parse(
    options.planningId ?? planningIdForGoal(goal),
  );
  const baseCommit = await requireCleanPlanningProject(options.project);
  const snapshot = await createPlanningSource({
    projectRoot: options.project.root,
    projectId: options.project.config.project.id,
    workspaceId: planningId,
    commit: baseCommit,
    local: options.local,
    restrictedPaths: options.project.config.restricted_paths,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
    ...(options.workspaceFactory
      ? { workspaceFactory: options.workspaceFactory }
      : {}),
  });
  try {
    const store = new PlanningStore(options.store);
    const ensured = await store.ensure({
      id: planningId,
      projectId: options.project.config.project.id,
      goal,
      baseCommit,
      source: snapshot.manifest,
      now: now(),
    });
    let state = ensured.state;
    if (state.status !== "drafting") {
      const existing = await currentQuestionnaire(store, state);
      return { state, ...existing, reused: true };
    }

    if (state.attempts > 0) {
      const recovered = await store.getQuestionnaire(state.id, state.attempts);
      if (recovered) {
        const request = await store.getRequest(state.id, state.attempts);
        requireQuestionnaireRecord(state, request, recovered);
        state = await store.publishQuestionnaire({
          expected: state,
          record: recovered,
          now: now(),
        });
        return { state, request, record: recovered, reused: true };
      }
    }

    const role = requirePlanningRole(options.project);
    const permissionCeiling = resolveRolePermissionCeiling({
      role,
      assignment: { kind: "run" },
      localPolicy: options.local.permissions,
    });
    const model = resolveRoleModelRoute(
      options.project.config,
      options.local,
      role.definition.name,
    );
    const policyDirectory = path.resolve(
      options.policyDirectory ?? bundledPiPolicyDirectory(),
    );
    const [policy, preflight] = await Promise.all([
      loadSandboxPolicy("read", path.join(policyDirectory, "read.yaml")),
      options.client.preflight(),
    ]);
    requirePlanningPreflight(preflight, model);
    if (!options.client.getInferenceRoute) {
      throw new OrchestratorError(
        "openshell_inference_unavailable",
        "Planning requires an inspectable OpenShell inference route",
      );
    }
    const inference = await options.client.getInferenceRoute();
    if (inference.model !== model.pi_model) {
      throw new OrchestratorError(
        "model_route_mismatch",
        `OpenShell gateway '${model.gateway}' routes '${inference.model ?? "nothing"}', not '${model.pi_model}'`,
      );
    }

    const attempt = state.attempts + 1;
    const prepared = await store.findPreparedAttempt(state.id, attempt);
    let request: PlanningRequest;
    let brief: CompiledPlanningBrief;
    if (prepared) {
      request = prepared.request;
      brief = compilePlanningBrief({
        identity: request.identity,
        project: options.project,
        role,
        permissionCeiling,
        model,
        goal,
        source: snapshot.manifest,
        contextLimitTokens: model.context_window,
      });
      if (
        prepared.brief.digest !== brief.digest ||
        prepared.brief.content !== brief.content
      ) {
        throw new OrchestratorError(
          "planning_attempt_stale",
          `Prepared planning attempt ${attempt} has a stale Brief`,
        );
      }
      requireCurrentPlanningRequest({
        state,
        request,
        role,
        permissionCeiling,
        model,
        policyDigest: policy.digest,
        brief,
      });
    } else {
      const rawNonce = (
        options.nonce ?? (() => randomBytes(4).toString("hex"))
      )();
      const nonce = z
        .string()
        .regex(/^[a-f0-9]{8}$/)
        .parse(rawNonce);
      const identity = SessionIdentitySchema.parse({
        run: planningId,
        agent: "lead",
        session: `planning-${attempt}-${nonce}`,
        generation: attempt,
      });
      brief = compilePlanningBrief({
        identity,
        project: options.project,
        role,
        permissionCeiling,
        model,
        goal,
        source: snapshot.manifest,
        contextLimitTokens: model.context_window,
      });
      request = createPlanningRequest({
        state,
        attempt,
        identity,
        role,
        permissionCeiling,
        model,
        policyDigest: policy.digest,
        brief,
        messageId: `planning-request-${attempt}-${nonce}`,
        now: now(),
      });
    }
    state = await store.beginAttempt({
      state,
      request,
      brief,
      now: now(),
    });
    const identity = request.identity;
    const messageId = request.message_id;

    let session: PlanningSession | undefined;
    let record: PlanningQuestionnaireRecord | undefined;
    let primaryError: unknown;
    try {
      const launch: PlanningSessionLauncher =
        options.launchSession ?? startReadSession;
      const launched = await launch({
        client: options.client,
        identity,
        ...(isReadOnlySourceWorkspace(snapshot)
          ? { workspace: snapshot }
          : { snapshot }),
        permissionCeiling,
        model,
        brief,
        context: options.project.config.context,
        policyDirectory,
        ...(options.imageContext ? { imageContext: options.imageContext } : {}),
        ...(options.startupTimeoutMs
          ? { startupTimeoutMs: options.startupTimeoutMs }
          : {}),
        ...(options.turnTimeoutMs
          ? { turnTimeoutMs: options.turnTimeoutMs }
          : {}),
      });
      session = launched;
      requireSessionBinding({
        info: launched.info,
        identity,
        source: snapshot,
        model,
        permissionCeiling,
        policyDigest: policy.digest,
        brief,
      });
      const message = MessageSchema.parse({
        version: 2,
        id: messageId,
        run: planningId,
        from: { host: true },
        to: {
          agent: "lead",
          session: identity.session,
          generation: identity.generation,
        },
        type: "planning-request",
        priority: "normal",
        reply_to: null,
        body: {
          action: "inspect-and-question",
          goal,
          source_digest: snapshot.manifest.source_digest,
          brief_digest: brief.digest,
          instruction:
            "Inspect the repository first, then return the required questionnaire object.",
        },
        references: [],
        created_at: now().toISOString(),
      });
      const turn = ModelTurnResultSchema.parse(await launched.run(message));
      if (
        !turn.message_ids.includes(message.id) ||
        turn.model_profile !== model.profile ||
        turn.requested_model !== model.pi_model
      ) {
        throw new OrchestratorError(
          "planning_turn_mismatch",
          `Planning result does not match Message '${message.id}' and route '${model.profile}/${model.pi_model}'`,
        );
      }
      if (turn.truncated) {
        throw new OrchestratorError(
          "planning_output_truncated",
          "Planning questionnaire exceeded the bounded model-turn output",
        );
      }
      const questionnaire = parsePlanningQuestionnaire(
        turn.text,
        planningSourcePaths(snapshot.manifest),
      );
      const latestCommit = await requireCleanPlanningProject(options.project);
      if (latestCommit !== baseCommit) {
        throw new OrchestratorError(
          "planning_source_stale",
          "Repository commit changed while the planning Session was running",
        );
      }
      await verifyPlanningSource(snapshot);
      record = createQuestionnaireRecord({
        request,
        session: launched.info,
        questionnaire,
        turn,
        now: now(),
      });
      state = await store.publishQuestionnaire({
        expected: state,
        record,
        now: now(),
      });
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
    return { state, request, record: record!, reused: false };
  } finally {
    await snapshot.dispose();
  }
}

function normalizedAnswers(
  questionnaire: PlanningQuestionnaire,
  answers: Readonly<Record<string, string>>,
): Map<string, string> {
  const expected = questionnaire.questions.map((question) => question.id);
  const supplied = Object.keys(answers);
  const missing = expected.filter((id) => answers[id] === undefined);
  const unknown = supplied.filter((id) => !expected.includes(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new OrchestratorError(
      "invalid_planning_answers",
      [
        missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
        unknown.length > 0 ? `unknown: ${unknown.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  return new Map(
    expected.map((id) => [id, HumanTextSchema.parse(answers[id])]),
  );
}

function createDecisionRecord(input: {
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly question: PlanningQuestion;
  readonly answer: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}): PlanningDecisionRecord {
  const option = input.question.options.find(
    (candidate) => candidate.id === input.answer,
  );
  const resolved = option?.label ?? input.answer;
  const answer = PlanningAnswerSchema.parse({
    question: input.question.id,
    kind: option ? "option" : "free-form",
    value: resolved,
    option: option?.id ?? null,
  });
  const decision = DecisionSchema.parse({
    id: `${input.state.id}-${input.question.id}`,
    scope: input.question.scope,
    statement: `${input.question.question} Answer: ${resolved}`,
    rationale: option
      ? `Human selected '${option.label}'. Tradeoff: ${option.tradeoff}`
      : `Human supplied a free-form answer to: ${input.question.question}`,
    accepted_at: input.acceptedAt,
  });
  const unsigned = PlanningDecisionRecordWithoutDigestSchema.parse({
    version: 1,
    planning: input.state.id,
    questionnaire_digest: input.questionnaire.record_digest,
    question_digest: digestParts("pi-orchestrator/planning-question/v1", [
      ["question", canonicalJson(input.question)],
    ]),
    accepted_by: input.acceptedBy,
    answer,
    decision,
  });
  return PlanningDecisionRecordSchema.parse({
    ...unsigned,
    record_digest: decisionRecordDigest(unsigned),
  });
}

export async function answerPlanningQuestionnaire(
  options: AnswerPlanningOptions,
): Promise<AnswerPlanningResult> {
  const planningId = PlanningIdSchema.parse(options.planningId);
  const baseCommit = await requireCleanPlanningProject(options.project);
  const store = new PlanningStore(options.store);
  const state = await store.get(planningId);
  if (
    state.project_id !== options.project.config.project.id ||
    state.base_commit !== baseCommit
  ) {
    throw new OrchestratorError(
      "planning_source_stale",
      `Planning request '${state.id}' no longer matches the exact repository commit`,
    );
  }
  const { record } = await currentQuestionnaire(store, state);
  const answers = normalizedAnswers(record.questionnaire, options.answers);
  if (state.status === "answered") {
    const existing = await store.decisions(state.id);
    const byQuestion = new Map(
      existing.map((decision) => [decision.answer.question, decision]),
    );
    for (const [question, answer] of answers) {
      const stored = byQuestion.get(question);
      const option = record.questionnaire.questions
        .find((candidate) => candidate.id === question)!
        .options.find((candidate) => candidate.id === answer);
      if (
        !stored ||
        stored.answer.value !== (option?.label ?? answer) ||
        stored.answer.option !== (option?.id ?? null)
      ) {
        throw new OrchestratorError(
          "planning_decision_conflict",
          `Planning request '${state.id}' already has different accepted answers`,
        );
      }
    }
    return { state, decisions: existing, reused: true };
  }
  if (state.status !== "awaiting-answers") {
    throw new OrchestratorError(
      "planning_not_awaiting_answers",
      `Planning request '${state.id}' is ${state.status}`,
    );
  }
  const acceptedAt = (options.now ?? new Date()).toISOString();
  const acceptedBy = HumanTextSchema.parse(options.acceptedBy);
  const decisions: PlanningDecisionRecord[] = [];
  let created = false;
  for (const question of record.questionnaire.questions) {
    const suppliedAnswer = answers.get(question.id)!;
    const existing = await store.findDecision(state.id, question.id);
    if (existing) {
      const expected = createDecisionRecord({
        state,
        questionnaire: record,
        question,
        answer: suppliedAnswer,
        acceptedBy: existing.accepted_by,
        acceptedAt: existing.decision.accepted_at,
      });
      if (canonicalJson(existing) !== canonicalJson(expected)) {
        throw new OrchestratorError(
          "planning_decision_conflict",
          `Planning Decision '${question.id}' already records another answer`,
        );
      }
      decisions.push(existing);
      continue;
    }
    created = true;
    decisions.push(
      await store.putDecision(
        state.id,
        createDecisionRecord({
          state,
          questionnaire: record,
          question,
          answer: suppliedAnswer,
          acceptedBy,
          acceptedAt,
        }),
      ),
    );
  }
  const next = await store.finishAnswers({
    expected: state,
    records: decisions,
    now: options.now ?? new Date(),
  });
  return { state: next, decisions, reused: !created };
}

export async function planningDecisions(
  store: PlanningProjectStore,
  planningId: string,
): Promise<readonly Decision[]> {
  return (await new PlanningStore(store).decisions(planningId)).map(
    (record) => record.decision,
  );
}
