import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { estimateTokens, type Decision } from "./brief.js";
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
  PlanningConsultationRoleSchema,
  PlanningStore,
  planningConsultationRoles,
  requireCleanPlanningProject,
  type PlanningConsultationRole,
  type PlanningDecisionRecord,
  type PlanningQuestionnaire,
  type PlanningQuestionnaireRecord,
  type PlanningSession,
  type PlanningSessionLauncher,
  type PlanningState,
} from "./planning.js";
import { loadSandboxPolicy } from "./policy.js";
import { SourceAnchorSchema, type SourceAnchor } from "./plan.js";
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
} from "./seat.js";
import {
  ModelTurnResultSchema,
  SessionIdentitySchema,
  sameSessionIdentity,
  type ModelTurnResult,
  type SessionIdentity,
} from "./session.js";
import {
  createSourceSnapshot,
  verifySourceSnapshot,
  type SourceSnapshot,
  type SourceSnapshotManifest,
} from "./snapshot.js";
import type { ProjectStore } from "./state.js";
import { writeJsonAtomic } from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const HumanTextSchema = z.string().trim().min(1).max(16_384);
const BoundedTextSchema = z.string().trim().min(1).max(4_000);
const TextListSchema = z.array(BoundedTextSchema).max(64);

const ConsultationAlternativeSchema = z
  .object({
    kind: z.enum(["conservative", "target"]),
    summary: BoundedTextSchema,
    tradeoffs: z.array(BoundedTextSchema).min(1).max(16),
  })
  .strict();

export const ArchitectureConsultationSchema = z
  .object({
    version: z.literal(1),
    role: z.literal("architecture"),
    conclusion: HumanTextSchema,
    current_constraints: z.array(BoundedTextSchema).min(1).max(64),
    alternatives: z.array(ConsultationAlternativeSchema).length(2),
    recommendation: z.enum(["conservative", "target"]),
    risks: TextListSchema,
    source_anchors: z.array(SourceAnchorSchema).min(1).max(128),
    unresolved_questions: TextListSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const kinds = value.alternatives.map((alternative) => alternative.kind);
    if (new Set(kinds).size !== 2) {
      context.addIssue({
        code: "custom",
        path: ["alternatives"],
        message: "must contain one conservative and one target alternative",
      });
    }
  });
export type ArchitectureConsultation = z.infer<
  typeof ArchitectureConsultationSchema
>;

const QuantDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    meaning: BoundedTextSchema,
    unit: z.string().trim().min(1).max(240),
  })
  .strict();

export const QuantConsultationSchema = z
  .object({
    version: z.literal(1),
    role: z.literal("quant"),
    applicability: z.enum(["material", "none"]),
    conclusion: HumanTextSchema,
    evidence: HumanTextSchema,
    definitions: z.array(QuantDefinitionSchema).max(64),
    assumptions: TextListSchema,
    analyses: TextListSchema,
    risks: TextListSchema,
    required_verification: z.array(BoundedTextSchema).min(1).max(64),
    source_anchors: z.array(SourceAnchorSchema).min(1).max(128),
    unresolved_questions: TextListSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.applicability === "material" &&
      value.definitions.length === 0 &&
      value.assumptions.length === 0 &&
      value.analyses.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["analyses"],
        message:
          "material quantitative impact requires a definition, assumption, or analysis",
      });
    }
  });
export type QuantConsultation = z.infer<typeof QuantConsultationSchema>;

export const PlanningConsultationOutputSchema = z.discriminatedUnion("role", [
  ArchitectureConsultationSchema,
  QuantConsultationSchema,
]);
export type PlanningConsultationOutput = z.infer<
  typeof PlanningConsultationOutputSchema
>;

const ConsultationBriefArtifactSchema = z
  .object({
    version: z.literal(1),
    content: z.string().min(1),
    digest: DigestSchema,
  })
  .strict();
type ConsultationBriefArtifact = z.infer<
  typeof ConsultationBriefArtifactSchema
>;

const ConsultationRequestWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: z.string().min(1),
    role: PlanningConsultationRoleSchema,
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    goal_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    decisions_digest: DigestSchema,
    base_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    source_digest: DigestSchema,
    source_entries: z.number().int().positive(),
    role_definition: z
      .object({ name: z.string().min(1), digest: DigestSchema })
      .strict(),
    model: ResolvedModelRouteSchema,
    policy_digest: DigestSchema,
    brief_digest: DigestSchema,
    message_id: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const ConsultationRequestSchema =
  ConsultationRequestWithoutDigestSchema.extend({
    request_digest: DigestSchema,
  }).strict();
export type ConsultationRequest = z.infer<typeof ConsultationRequestSchema>;

const ConsultationTurnSchema = ModelTurnResultSchema.pick({
  message_ids: true,
  model_alias: true,
  requested_model: true,
  response_model: true,
  stop_reason: true,
  truncated: true,
  usage: true,
});

const ConsultationRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    planning: z.string().min(1),
    role: PlanningConsultationRoleSchema,
    attempt: z.number().int().positive(),
    identity: SessionIdentitySchema,
    request_digest: DigestSchema,
    goal_digest: DigestSchema,
    questionnaire_digest: DigestSchema,
    decisions_digest: DigestSchema,
    base_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    source_digest: DigestSchema,
    role_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    policy_digest: DigestSchema,
    brief_digest: DigestSchema,
    sandbox: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        workspace: z.string().min(1),
      })
      .strict(),
    output: PlanningConsultationOutputSchema,
    response: z
      .string()
      .min(1)
      .max(56 * 1024),
    response_digest: DigestSchema,
    turn: ConsultationTurnSchema,
    report: ReportSchema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const ConsultationRecordSchema =
  ConsultationRecordWithoutDigestSchema.extend({
    record_digest: DigestSchema,
  }).strict();
export type ConsultationRecord = z.infer<typeof ConsultationRecordSchema>;

export interface CompiledConsultationBrief {
  readonly content: string;
  readonly digest: Digest;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly omissions: readonly string[];
}

export interface RunPlanningConsultationsOptions {
  readonly store: Pick<ProjectStore, "planningDirectory">;
  readonly project: Project;
  readonly local: LocalConfig;
  readonly clients?: Readonly<
    Partial<Record<PlanningConsultationRole, ReadSessionOpenShell>>
  >;
  readonly planningId: string;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly nonce?: (role: PlanningConsultationRole, attempt: number) => string;
  readonly launchSession?: PlanningSessionLauncher;
}

export interface PlanningConsultationResult {
  readonly role: PlanningConsultationRole;
  readonly request: ConsultationRequest;
  readonly record: ConsultationRecord;
  readonly reused: boolean;
}

export interface RunPlanningConsultationsResult {
  readonly state: PlanningState;
  readonly consultations: readonly PlanningConsultationResult[];
}

const roleNames: Readonly<Record<PlanningConsultationRole, string>> = {
  architecture: "architect",
  quant: "quant",
};

const outputContracts: Readonly<Record<PlanningConsultationRole, string>> = {
  architecture: `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "version": 1,
  "role": "architecture",
  "conclusion": "recommended architectural direction",
  "current_constraints": ["repository-grounded constraint"],
  "alternatives": [
    {"kind":"conservative","summary":"smallest coherent change","tradeoffs":["main consequence"]},
    {"kind":"target","summary":"cleaner intended direction","tradeoffs":["main consequence"]}
  ],
  "recommendation": "conservative",
  "risks": ["material risk"],
  "source_anchors": [{"path":"tracked/file","symbol":"optional symbol","reason":"evidence"}],
  "unresolved_questions": ["question for later synthesis"]
}

Inspect /workspace/project. Distinguish current architecture from intended direction and do not introduce speculative abstractions. Use only tracked paths in source_anchors. Return no prose outside the object.`,
  quant: `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "version": 1,
  "role": "quant",
  "applicability": "material",
  "conclusion": "quantitative conclusion",
  "evidence": "why quantitative semantics are material or not applicable",
  "definitions": [{"name":"quantity","meaning":"precise definition","unit":"unit"}],
  "assumptions": ["explicit assumption"],
  "analyses": ["calculation, causal constraint, or sensitivity result"],
  "risks": ["quantitative risk"],
  "required_verification": ["deterministic or independent verification"],
  "source_anchors": [{"path":"tracked/file","symbol":"optional symbol","reason":"evidence"}],
  "unresolved_questions": ["question for later synthesis"]
}

Inspect /workspace/project. Set applicability to "none" when the change has no material quantitative semantics, and provide repository evidence plus a verification that preserves that conclusion. Check definitions, units, assumptions, causality, and boundary behavior when applicable. Use only tracked paths in source_anchors. Return no prose outside the object.`,
};

function section(title: string, content: string): string {
  return `## ${title}\n\n${content.trim()}\n`;
}

function decisionsDigest(records: readonly PlanningDecisionRecord[]): Digest {
  return digestParts("pi-orchestrator/planning-consultation-decisions/v1", [
    ["decisions", canonicalJson(records)],
  ]);
}

function briefDigest(content: string): Digest {
  return digestParts("pi-orchestrator/planning-consultation-brief/v1", [
    ["brief.md", content],
  ]);
}

function requestDigest(
  value: z.infer<typeof ConsultationRequestWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-consultation-request/v1", [
    ["request", canonicalJson(value)],
  ]);
}

function recordDigest(
  value: z.infer<typeof ConsultationRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/planning-consultation-record/v1", [
    ["record", canonicalJson(value)],
  ]);
}

export function compileConsultationBrief(input: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly consultationRole: PlanningConsultationRole;
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaire;
  readonly decisions: readonly Decision[];
  readonly source: SourceSnapshotManifest;
  readonly contextLimitTokens: number;
}): CompiledConsultationBrief {
  const budgetTokens = Math.max(
    1,
    Math.floor(
      input.contextLimitTokens * input.project.config.context.initial_fraction,
    ),
  );
  const required = [
    section(
      "Identity",
      `Planning: ${input.identity.run}\nSeat: ${input.identity.seat}\nSession: ${input.identity.session}\nEpoch: ${input.identity.epoch}`,
    ),
    section("Project Instructions", input.project.agents),
    section(
      "Role",
      `${canonicalJson(input.role.definition)}\n\n${input.role.body}`,
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
      "Repository Evidence",
      `The exact committed repository is mounted read-only at /workspace/project.\nCommit: ${input.source.commit}\nSource digest: ${input.source.source_digest}\nTracked entries: ${input.source.entries.length}`,
    ),
    section("Required Output", outputContracts[input.consultationRole]),
  ];
  let content = `# ${input.role.definition.name} Planning Consultation Brief\n\n${required.join("\n")}`;
  const omissions: string[] = [];
  for (const name of input.role.definition.skills) {
    const skill = input.project.skills.get(name);
    if (!skill) {
      throw new OrchestratorError(
        "unknown_skill",
        `Consultation Role references unavailable Skill '${name}'`,
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
    digest: briefDigest(content),
    estimatedTokens: estimateTokens(content),
    budgetTokens,
    omissions,
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
      "invalid_consultation_output",
      "Consultation Session did not return exactly one valid JSON object",
      { cause: error },
    );
  }
}

export function parseConsultationOutput(
  role: PlanningConsultationRole,
  text: string,
  sourcePaths?: ReadonlySet<string>,
): PlanningConsultationOutput {
  const parsedRole = PlanningConsultationRoleSchema.parse(role);
  const schema =
    parsedRole === "architecture"
      ? ArchitectureConsultationSchema
      : QuantConsultationSchema;
  const result = schema.safeParse(parseJsonObject(text));
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_consultation_output",
      `Invalid ${parsedRole} consultation: ${result.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "consultation"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }
  if (sourcePaths) {
    const unknown = result.data.source_anchors
      .map((anchor) => anchor.path)
      .filter((anchorPath) => !sourcePaths.has(anchorPath));
    if (unknown.length > 0) {
      throw new OrchestratorError(
        "invalid_source_anchor",
        `Consultation references paths absent from the exact source snapshot: ${[...new Set(unknown)].join(", ")}`,
      );
    }
  }
  return PlanningConsultationOutputSchema.parse(result.data);
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
      "invalid_consultation_store",
      `Invalid consultation evidence at ${filePath}`,
      { cause: error },
    );
  }
}

async function putImmutable<T>(
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
        "consultation_evidence_conflict",
        `Immutable consultation evidence already exists at ${filePath}`,
      );
    }
    return existing;
  }
  await writeJsonAtomic(filePath, parsed);
  return parsed;
}

class ConsultationStore {
  private readonly reports: ReportStore;

  constructor(
    private readonly planning: PlanningStore,
    private readonly planningId: string,
  ) {
    this.reports = new ReportStore(planning.directory(planningId));
  }

  private attemptDirectory(
    role: PlanningConsultationRole,
    attempt: number,
  ): string {
    return path.join(
      this.planning.directory(this.planningId),
      "consultations",
      PlanningConsultationRoleSchema.parse(role),
      "attempts",
      String(z.number().int().positive().parse(attempt)),
    );
  }

  async findPrepared(
    role: PlanningConsultationRole,
    attempt: number,
  ): Promise<
    | {
        readonly request: ConsultationRequest;
        readonly brief: ConsultationBriefArtifact;
      }
    | undefined
  > {
    const directory = this.attemptDirectory(role, attempt);
    const [requestSource, briefSource] = await Promise.all([
      readOptional(path.join(directory, "request.json")),
      readOptional(path.join(directory, "brief.json")),
    ]);
    if (requestSource === undefined && briefSource === undefined)
      return undefined;
    if (requestSource === undefined || briefSource === undefined) {
      throw new OrchestratorError(
        "invalid_consultation_store",
        `${role} consultation attempt ${attempt} is only partially prepared`,
      );
    }
    const requestPath = path.join(directory, "request.json");
    const briefPath = path.join(directory, "brief.json");
    const request = parseStored(
      ConsultationRequestSchema,
      requestSource,
      requestPath,
    );
    const brief = parseStored(
      ConsultationBriefArtifactSchema,
      briefSource,
      briefPath,
    );
    const { request_digest: storedRequestDigest, ...unsignedRequest } = request;
    if (
      requestDigest(unsignedRequest) !== storedRequestDigest ||
      briefDigest(brief.content) !== brief.digest ||
      request.brief_digest !== brief.digest
    ) {
      throw new OrchestratorError(
        "invalid_consultation_store",
        `${role} consultation attempt ${attempt} has invalid prepared evidence`,
      );
    }
    return { request, brief };
  }

  async prepare(
    request: ConsultationRequest,
    brief: CompiledConsultationBrief,
  ): Promise<void> {
    const directory = this.attemptDirectory(request.role, request.attempt);
    await mkdir(directory, { recursive: true });
    await putImmutable(
      path.join(directory, "brief.json"),
      ConsultationBriefArtifactSchema.parse({
        version: 1,
        content: brief.content,
        digest: brief.digest,
      }),
      ConsultationBriefArtifactSchema,
    );
    await putImmutable(
      path.join(directory, "request.json"),
      request,
      ConsultationRequestSchema,
    );
  }

  async record(
    role: PlanningConsultationRole,
    attempt: number,
  ): Promise<ConsultationRecord | undefined> {
    const filePath = path.join(
      this.attemptDirectory(role, attempt),
      "record.json",
    );
    const source = await readOptional(filePath);
    if (source === undefined) return undefined;
    const record = parseStored(ConsultationRecordSchema, source, filePath);
    const { record_digest: storedDigest, ...unsigned } = record;
    const parsedOutput = parseConsultationOutput(record.role, record.response);
    const expectedReport = createReport({
      id: `${record.role}-consultation`,
      kind: "consultation",
      run: record.planning,
      seat: record.identity.seat,
      session: record.identity.session,
      epoch: record.identity.epoch,
      source_digest: record.source_digest,
      content: renderReport(parsedOutput),
      created_at: record.created_at,
    });
    if (
      recordDigest(unsigned) !== storedDigest ||
      sha256(record.response) !== record.response_digest ||
      canonicalJson(parsedOutput) !== canonicalJson(record.output) ||
      canonicalJson(expectedReport) !== canonicalJson(record.report)
    ) {
      throw new OrchestratorError(
        "invalid_consultation_store",
        `${role} consultation attempt ${attempt} has invalid Report evidence`,
      );
    }
    return record;
  }

  async putRecord(record: ConsultationRecord): Promise<ConsultationRecord> {
    const stored = await putImmutable(
      path.join(
        this.attemptDirectory(record.role, record.attempt),
        "record.json",
      ),
      record,
      ConsultationRecordSchema,
    );
    await this.reports.put(stored.report);
    return stored;
  }

  async requireReport(record: ConsultationRecord): Promise<Report> {
    const report = await this.reports.put(record.report);
    if (canonicalJson(report) !== canonicalJson(record.report)) {
      throw new OrchestratorError(
        "consultation_report_conflict",
        `${record.role} consultation Report differs from its evidence record`,
      );
    }
    return report;
  }
}

function requireRole(
  project: Project,
  role: PlanningConsultationRole,
): LoadedRole {
  const expected = roleNames[role];
  const loaded = project.roles.get(expected);
  if (!loaded) {
    throw new OrchestratorError(
      "consultation_role_not_found",
      `Planning consultation requires the '${expected}' Role`,
    );
  }
  if (
    loaded.definition.name !== expected ||
    loaded.definition.access !== "read" ||
    loaded.definition.sandbox !== "read"
  ) {
    throw new OrchestratorError(
      "invalid_consultation_role",
      `The '${expected}' Role must use read access and the read Sandbox profile`,
    );
  }
  return loaded;
}

function requirePreflight(
  preflight: OpenShellPreflight,
  model: ResolvedModelRoute,
): void {
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "Planning consultation requires an exact OpenShell version pin",
    );
  }
  if (preflight.status.gateway !== model.gateway) {
    throw new OrchestratorError(
      "model_gateway_mismatch",
      `Consultation model '${model.alias}' requires gateway '${model.gateway}', but the client reached '${preflight.status.gateway}'`,
    );
  }
}

function requireSessionBinding(input: {
  readonly info: ReadSessionInfo;
  readonly identity: SessionIdentity;
  readonly source: SourceSnapshot;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledConsultationBrief;
}): void {
  if (
    input.info.profile !== "read" ||
    !sameSessionIdentity(input.info.identity, input.identity) ||
    input.info.sourceDigest !== input.source.manifest.source_digest ||
    input.info.policyDigest !== input.policyDigest ||
    input.info.briefDigest !== input.brief.digest ||
    canonicalJson(input.info.model) !== canonicalJson(input.model) ||
    input.info.inference?.model !== input.model.pi_model
  ) {
    throw new OrchestratorError(
      "consultation_session_mismatch",
      "Consultation Session does not match its source, Brief, model, policy, or identity",
    );
  }
  requirePreflight(input.info.openshell, input.model);
}

function createRequest(input: {
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisionRecords: readonly PlanningDecisionRecord[];
  readonly role: PlanningConsultationRole;
  readonly loadedRole: LoadedRole;
  readonly attempt: number;
  readonly identity: SessionIdentity;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledConsultationBrief;
  readonly messageId: string;
  readonly now: Date;
}): ConsultationRequest {
  const unsigned = ConsultationRequestWithoutDigestSchema.parse({
    version: 1,
    planning: input.state.id,
    role: input.role,
    attempt: input.attempt,
    identity: input.identity,
    goal_digest: input.state.goal_digest,
    questionnaire_digest: input.questionnaire.record_digest,
    decisions_digest: decisionsDigest(input.decisionRecords),
    base_commit: input.state.base_commit,
    source_digest: input.state.source_digest,
    source_entries: input.state.source_entries,
    role_definition: {
      name: input.loadedRole.definition.name,
      digest: input.loadedRole.digest,
    },
    model: input.model,
    policy_digest: input.policyDigest,
    brief_digest: input.brief.digest,
    message_id: input.messageId,
    created_at: input.now.toISOString(),
  });
  return ConsultationRequestSchema.parse({
    ...unsigned,
    request_digest: requestDigest(unsigned),
  });
}

function requireCurrentRequest(input: {
  readonly state: PlanningState;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisionRecords: readonly PlanningDecisionRecord[];
  readonly request: ConsultationRequest;
  readonly loadedRole: LoadedRole;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
  readonly brief: CompiledConsultationBrief;
}): void {
  const role = input.request.role;
  if (
    input.request.planning !== input.state.id ||
    input.request.goal_digest !== input.state.goal_digest ||
    input.request.questionnaire_digest !== input.questionnaire.record_digest ||
    input.request.decisions_digest !== decisionsDigest(input.decisionRecords) ||
    input.request.base_commit !== input.state.base_commit ||
    input.request.source_digest !== input.state.source_digest ||
    input.request.source_entries !== input.state.source_entries ||
    input.request.role_definition.name !== roleNames[role] ||
    input.request.role_definition.name !== input.loadedRole.definition.name ||
    input.request.role_definition.digest !== input.loadedRole.digest ||
    canonicalJson(input.request.model) !== canonicalJson(input.model) ||
    input.request.policy_digest !== input.policyDigest ||
    input.request.brief_digest !== input.brief.digest ||
    input.request.identity.run !== input.state.id ||
    input.request.identity.seat !== roleNames[role] ||
    input.request.identity.epoch !== input.request.attempt
  ) {
    throw new OrchestratorError(
      "consultation_attempt_stale",
      `${role} consultation attempt ${input.request.attempt} no longer matches its inputs`,
    );
  }
}

function renderAnchors(anchors: readonly SourceAnchor[]): string {
  return anchors.map((anchor) => `- ${canonicalJson(anchor)}`).join("\n");
}

function renderReport(output: PlanningConsultationOutput): string {
  if (output.role === "architecture") {
    return `# Conclusion\n\n${output.conclusion}\n\n# Current Constraints\n\n${output.current_constraints.map((item) => `- ${item}`).join("\n")}\n\n# Alternatives\n\n${output.alternatives.map((item) => `## ${item.kind}\n\n${item.summary}\n\n${item.tradeoffs.map((tradeoff) => `- ${tradeoff}`).join("\n")}`).join("\n\n")}\n\n# Recommendation\n\n${output.recommendation}\n\n# Risks\n\n${output.risks.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Evidence\n\n${renderAnchors(output.source_anchors)}\n\n# Uncertainty\n\n${output.unresolved_questions.map((item) => `- ${item}`).join("\n") || "None."}\n`;
  }
  return `# Conclusion\n\n${output.conclusion}\n\n# Applicability\n\n${output.applicability}: ${output.evidence}\n\n# Definitions\n\n${output.definitions.map((item) => `- ${item.name} [${item.unit}]: ${item.meaning}`).join("\n") || "None."}\n\n# Assumptions\n\n${output.assumptions.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Analysis\n\n${output.analyses.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Risks\n\n${output.risks.map((item) => `- ${item}`).join("\n") || "None."}\n\n# Required Verification\n\n${output.required_verification.map((item) => `- ${item}`).join("\n")}\n\n# Evidence\n\n${renderAnchors(output.source_anchors)}\n\n# Uncertainty\n\n${output.unresolved_questions.map((item) => `- ${item}`).join("\n") || "None."}\n`;
}

function createRecord(input: {
  readonly request: ConsultationRequest;
  readonly session: ReadSessionInfo;
  readonly output: PlanningConsultationOutput;
  readonly turn: ModelTurnResult;
  readonly now: Date;
}): ConsultationRecord {
  const report = createReport({
    id: `${input.request.role}-consultation`,
    kind: "consultation",
    run: input.request.planning,
    seat: input.request.identity.seat,
    session: input.request.identity.session,
    epoch: input.request.identity.epoch,
    source_digest: input.request.source_digest,
    content: renderReport(input.output),
    created_at: input.now.toISOString(),
  });
  const unsigned = ConsultationRecordWithoutDigestSchema.parse({
    version: 1,
    planning: input.request.planning,
    role: input.request.role,
    attempt: input.request.attempt,
    identity: input.request.identity,
    request_digest: input.request.request_digest,
    goal_digest: input.request.goal_digest,
    questionnaire_digest: input.request.questionnaire_digest,
    decisions_digest: input.request.decisions_digest,
    base_commit: input.request.base_commit,
    source_digest: input.request.source_digest,
    role_digest: input.request.role_definition.digest,
    model: input.request.model,
    policy_digest: input.request.policy_digest,
    brief_digest: input.request.brief_digest,
    sandbox: {
      id: input.session.sandbox.id,
      name: input.session.sandbox.name,
      workspace: input.session.sandbox.workspace,
    },
    output: input.output,
    response: input.turn.text,
    response_digest: sha256(input.turn.text),
    turn: {
      message_ids: input.turn.message_ids,
      model_alias: input.turn.model_alias,
      requested_model: input.turn.requested_model,
      ...(input.turn.response_model
        ? { response_model: input.turn.response_model }
        : {}),
      stop_reason: input.turn.stop_reason,
      truncated: input.turn.truncated,
      usage: input.turn.usage,
    },
    report,
    created_at: input.now.toISOString(),
  });
  return ConsultationRecordSchema.parse({
    ...unsigned,
    record_digest: recordDigest(unsigned),
  });
}

function requireRecord(
  state: PlanningState,
  request: ConsultationRequest,
  record: ConsultationRecord,
  sourcePaths: ReadonlySet<string>,
): void {
  const progress = state.consultations[request.role];
  const parsedOutput = parseConsultationOutput(
    request.role,
    record.response,
    sourcePaths,
  );
  if (
    record.planning !== state.id ||
    record.role !== request.role ||
    record.output.role !== request.role ||
    canonicalJson(record.output) !== canonicalJson(parsedOutput) ||
    record.attempt !== request.attempt ||
    record.request_digest !== request.request_digest ||
    record.goal_digest !== state.goal_digest ||
    record.questionnaire_digest !== state.questionnaire_digest ||
    record.decisions_digest !== request.decisions_digest ||
    record.base_commit !== state.base_commit ||
    record.source_digest !== state.source_digest ||
    !sameSessionIdentity(record.identity, request.identity) ||
    record.role_digest !== request.role_definition.digest ||
    canonicalJson(record.model) !== canonicalJson(request.model) ||
    record.policy_digest !== request.policy_digest ||
    record.brief_digest !== request.brief_digest ||
    !record.turn.message_ids.includes(request.message_id) ||
    record.turn.model_alias !== request.model.alias ||
    record.turn.requested_model !== request.model.pi_model ||
    record.turn.truncated ||
    progress.attempts !== request.attempt ||
    progress.current_request_digest !== request.request_digest ||
    (progress.record_digest !== null &&
      progress.record_digest !== record.record_digest) ||
    (progress.report_digest !== null &&
      progress.report_digest !== record.report.content_digest)
  ) {
    throw new OrchestratorError(
      "consultation_record_stale",
      `${request.role} consultation Report no longer matches its planning evidence`,
    );
  }
}

async function executeRole(input: {
  readonly options: RunPlanningConsultationsOptions;
  readonly planning: PlanningStore;
  readonly evidence: ConsultationStore;
  readonly snapshot: SourceSnapshot;
  readonly questionnaire: PlanningQuestionnaireRecord;
  readonly decisionRecords: readonly PlanningDecisionRecord[];
  readonly state: PlanningState;
  readonly role: PlanningConsultationRole;
  readonly policyDigest: Digest;
}): Promise<{
  readonly state: PlanningState;
  readonly result: PlanningConsultationResult;
}> {
  let state = input.state;
  const progress = state.consultations[input.role];
  const loadedRole = requireRole(input.options.project, input.role);
  const model = resolveRoleModelRoute(
    input.options.project.config,
    input.options.local,
    loadedRole.definition.name,
    loadedRole.definition.inference,
  );
  const currentBrief = (
    request: ConsultationRequest,
    stored: ConsultationBriefArtifact,
  ): CompiledConsultationBrief => {
    const brief = compileConsultationBrief({
      identity: request.identity,
      project: input.options.project,
      role: loadedRole,
      consultationRole: input.role,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisionRecords.map((record) => record.decision),
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    if (brief.digest !== stored.digest || brief.content !== stored.content) {
      throw new OrchestratorError(
        "consultation_attempt_stale",
        `${input.role} consultation attempt ${request.attempt} has a stale Brief`,
      );
    }
    requireCurrentRequest({
      state,
      questionnaire: input.questionnaire,
      decisionRecords: input.decisionRecords,
      request,
      loadedRole,
      model,
      policyDigest: input.policyDigest,
      brief,
    });
    return brief;
  };
  if (progress.record_digest !== null) {
    const record = await input.evidence.record(input.role, progress.attempts);
    if (!record || record.record_digest !== progress.record_digest) {
      throw new OrchestratorError(
        "invalid_consultation_store",
        `${input.role} consultation state references a missing Report`,
      );
    }
    const prepared = await input.evidence.findPrepared(
      input.role,
      progress.attempts,
    );
    if (!prepared) {
      throw new OrchestratorError(
        "invalid_consultation_store",
        `${input.role} consultation is missing its request`,
      );
    }
    currentBrief(prepared.request, prepared.brief);
    requireRecord(
      state,
      prepared.request,
      record,
      new Set(input.snapshot.manifest.entries.map((entry) => entry.path)),
    );
    await input.evidence.requireReport(record);
    return {
      state,
      result: {
        role: input.role,
        request: prepared.request,
        record,
        reused: true,
      },
    };
  }

  if (progress.attempts > 0) {
    const recovered = await input.evidence.record(
      input.role,
      progress.attempts,
    );
    if (recovered) {
      const prepared = await input.evidence.findPrepared(
        input.role,
        progress.attempts,
      );
      if (!prepared) {
        throw new OrchestratorError(
          "invalid_consultation_store",
          `${input.role} consultation is missing its request`,
        );
      }
      currentBrief(prepared.request, prepared.brief);
      requireRecord(
        state,
        prepared.request,
        recovered,
        new Set(input.snapshot.manifest.entries.map((entry) => entry.path)),
      );
      await input.evidence.requireReport(recovered);
      state = await input.planning.publishConsultation({
        expected: state,
        role: input.role,
        attempt: recovered.attempt,
        requestDigest: recovered.request_digest as Digest,
        recordDigest: recovered.record_digest as Digest,
        reportDigest: recovered.report.content_digest as Digest,
        now: (input.options.now ?? (() => new Date()))(),
      });
      return {
        state,
        result: {
          role: input.role,
          request: prepared.request,
          record: recovered,
          reused: true,
        },
      };
    }
  }

  const client = input.options.clients?.[input.role];
  if (!client) {
    throw new OrchestratorError(
      "consultation_incomplete",
      `${input.role} consultation requires a fresh Session before synthesis`,
    );
  }
  const preflight = await client.preflight();
  requirePreflight(preflight, model);
  if (!client.getInferenceRoute) {
    throw new OrchestratorError(
      "openshell_inference_unavailable",
      `${input.role} consultation requires an inspectable inference route`,
    );
  }
  const inference = await client.getInferenceRoute();
  if (inference.model !== model.pi_model) {
    throw new OrchestratorError(
      "model_route_mismatch",
      `OpenShell gateway '${model.gateway}' routes '${inference.model ?? "nothing"}', not '${model.pi_model}'`,
    );
  }

  const attempt = progress.attempts + 1;
  const prepared = await input.evidence.findPrepared(input.role, attempt);
  let request: ConsultationRequest;
  let brief: CompiledConsultationBrief;
  if (prepared) {
    request = prepared.request;
    brief = compileConsultationBrief({
      identity: request.identity,
      project: input.options.project,
      role: loadedRole,
      consultationRole: input.role,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisionRecords.map((record) => record.decision),
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    if (
      brief.digest !== prepared.brief.digest ||
      brief.content !== prepared.brief.content
    ) {
      throw new OrchestratorError(
        "consultation_attempt_stale",
        `${input.role} consultation attempt ${attempt} has a stale Brief`,
      );
    }
    requireCurrentRequest({
      state,
      questionnaire: input.questionnaire,
      decisionRecords: input.decisionRecords,
      request,
      loadedRole,
      model,
      policyDigest: input.policyDigest,
      brief,
    });
  } else {
    const nonce = z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .parse(
        input.options.nonce?.(input.role, attempt) ??
          randomBytes(4).toString("hex"),
      );
    const identity = SessionIdentitySchema.parse({
      run: state.id,
      seat: roleNames[input.role],
      session: `consult-${input.role}-${attempt}-${nonce}`,
      epoch: attempt,
    });
    brief = compileConsultationBrief({
      identity,
      project: input.options.project,
      role: loadedRole,
      consultationRole: input.role,
      state,
      questionnaire: input.questionnaire.questionnaire,
      decisions: input.decisionRecords.map((record) => record.decision),
      source: input.snapshot.manifest,
      contextLimitTokens: model.context_window,
    });
    request = createRequest({
      state,
      questionnaire: input.questionnaire,
      decisionRecords: input.decisionRecords,
      role: input.role,
      loadedRole,
      attempt,
      identity,
      model,
      policyDigest: input.policyDigest,
      brief,
      messageId: `consult-${input.role}-${attempt}-${nonce}`,
      now: (input.options.now ?? (() => new Date()))(),
    });
    await input.evidence.prepare(request, brief);
  }
  state = await input.planning.beginConsultation({
    expected: state,
    role: input.role,
    attempt,
    requestDigest: request.request_digest as Digest,
    now: (input.options.now ?? (() => new Date()))(),
  });

  let session: PlanningSession | undefined;
  let record: ConsultationRecord | undefined;
  let primaryError: unknown;
  try {
    const launch = input.options.launchSession ?? startReadSession;
    session = await launch({
      client,
      identity: request.identity,
      snapshot: input.snapshot,
      model,
      brief,
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
      identity: request.identity,
      source: input.snapshot,
      model,
      policyDigest: input.policyDigest,
      brief,
    });
    const message = MessageSchema.parse({
      version: 1,
      id: request.message_id,
      run: state.id,
      from: { host: true },
      to: {
        seat: request.identity.seat,
        session: request.identity.session,
        epoch: request.identity.epoch,
      },
      type: "consultation",
      priority: "normal",
      reply_to: null,
      body: {
        action: "analyze-planning",
        role: input.role,
        goal: state.goal,
        source_digest: state.source_digest,
        questionnaire_digest: input.questionnaire.record_digest,
        decisions_digest: request.decisions_digest,
        brief_digest: brief.digest,
        instruction:
          "Inspect the repository and return the required independent consultation object.",
      },
      references: input.questionnaire.questionnaire.repository.anchors.map(
        (anchor) => anchor.path,
      ),
      created_at: (input.options.now ?? (() => new Date()))().toISOString(),
    });
    const turn = ModelTurnResultSchema.parse(await session.run(message));
    if (
      !turn.message_ids.includes(message.id) ||
      turn.model_alias !== model.alias ||
      turn.requested_model !== model.pi_model
    ) {
      throw new OrchestratorError(
        "consultation_turn_mismatch",
        `Consultation result does not match Message '${message.id}' and route '${model.alias}/${model.pi_model}'`,
      );
    }
    if (turn.truncated) {
      throw new OrchestratorError(
        "consultation_output_truncated",
        `${input.role} consultation exceeded the bounded model-turn output`,
      );
    }
    const output = parseConsultationOutput(
      input.role,
      turn.text,
      new Set(input.snapshot.manifest.entries.map((entry) => entry.path)),
    );
    const latestCommit = await requireCleanPlanningProject(
      input.options.project,
    );
    if (latestCommit !== state.base_commit) {
      throw new OrchestratorError(
        "planning_source_stale",
        "Repository commit changed while a consultation Session was running",
      );
    }
    await verifySourceSnapshot(input.snapshot);
    record = createRecord({
      request,
      session: session.info,
      output,
      turn,
      now: (input.options.now ?? (() => new Date()))(),
    });
    record = await input.evidence.putRecord(record);
    state = await input.planning.publishConsultation({
      expected: state,
      role: input.role,
      attempt,
      requestDigest: request.request_digest as Digest,
      recordDigest: record.record_digest as Digest,
      reportDigest: record.report.content_digest as Digest,
      now: (input.options.now ?? (() => new Date()))(),
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
  return {
    state,
    result: { role: input.role, request, record: record!, reused: false },
  };
}

export async function runPlanningConsultations(
  options: RunPlanningConsultationsOptions,
): Promise<RunPlanningConsultationsResult> {
  const baseCommit = await requireCleanPlanningProject(options.project);
  const snapshot = await createSourceSnapshot({
    projectRoot: options.project.root,
    commit: baseCommit,
    paths: ["."],
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  try {
    const planning = new PlanningStore(options.store);
    let state = await planning.get(options.planningId);
    if (
      state.base_commit !== baseCommit ||
      state.source_digest !== snapshot.manifest.source_digest
    ) {
      throw new OrchestratorError(
        "planning_source_stale",
        `Planning request '${state.id}' is bound to another repository revision`,
      );
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
      ].includes(state.status)
    ) {
      throw new OrchestratorError(
        "planning_not_answered",
        `Planning request '${state.id}' is ${state.status}`,
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
    if (questionnaire.record_digest !== state.questionnaire_digest) {
      throw new OrchestratorError(
        "invalid_planning_store",
        `Planning request '${state.id}' does not reference its questionnaire`,
      );
    }
    const decisionRecords = await planning.decisions(state.id);
    const policyDirectory = path.resolve(
      options.policyDirectory ?? bundledPiPolicyDirectory(),
    );
    const policy = await loadSandboxPolicy(
      "read",
      path.join(policyDirectory, "read.yaml"),
    );
    const evidence = new ConsultationStore(planning, state.id);
    const consultations: PlanningConsultationResult[] = [];
    for (const role of planningConsultationRoles) {
      const executed = await executeRole({
        options,
        planning,
        evidence,
        snapshot,
        questionnaire,
        decisionRecords,
        state,
        role,
        policyDigest: policy.digest,
      });
      state = executed.state;
      consultations.push(executed.result);
    }
    return { state, consultations };
  } finally {
    await snapshot.dispose();
  }
}
