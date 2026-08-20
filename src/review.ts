import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitPatchWorktree, loadPreparedPatch } from "./apply.js";
import { requireFreshApproval } from "./approval.js";
import { ArtifactStore } from "./artifact.js";
import {
  DecisionSchema,
  compileBrief,
  type BriefReviewCheck,
  type CompiledBrief,
  type Decision,
} from "./brief.js";
import {
  CheckStore,
  createCheckSource,
  type CheckRecord,
  type CheckSource,
} from "./check.js";
import {
  IdentifierSchema,
  ReviewLensSchema,
  type ReviewLens,
} from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { GitCommitSchema } from "./git.js";
import type { LocalConfig } from "./local.js";
import { Mailbox, MessageSchema, type MessageLifecycle } from "./message.js";
import { MetricStore } from "./metric.js";
import {
  ResolvedModelRouteSchema,
  resolveReviewModelRoute,
  type ResolvedModelRoute,
} from "./model.js";
import type { OpenShellPreflight } from "./openshell.js";
import {
  catalogFromConfig,
  loadPlan,
  type LoadedPlan,
  type PlanTask,
} from "./plan.js";
import type { VerifiedPatch } from "./patch.js";
import {
  permissionRuntimeState,
  projectPermissionPolicyDigest,
  resolveRolePermissionCeiling,
  roleHasReadSource,
  type PermissionCeiling,
} from "./permission.js";
import { loadSandboxPolicy } from "./policy.js";
import { loadProject, type Project } from "./project.js";
import { AgentRegistry } from "./registry.js";
import type { LoadedRole } from "./role.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  bundledPiPolicyDirectory,
  startReadSession,
  type ReadSessionInfo,
  type ReadSessionOpenShell,
  type StartReadSessionOptions,
} from "./agent.js";
import {
  ModelTurnResultSchema,
  SessionIdentitySchema,
  SessionSandboxSchema,
  type ModelTurnResult,
  type SessionIdentity,
} from "./session.js";
import {
  syncDirectory,
  writeJsonAtomic,
  type ProjectRecord,
  type ProjectStore,
  type RunState,
  type TaskRecord,
} from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const ReviewJobIdSchema = z.string().regex(/^review-[a-f0-9]{16}$/);
const ReviewTextSchema = z.string().trim().min(1).max(16_000);
const ReviewListSchema = z.array(z.string().trim().min(1).max(4_000)).max(64);
const REVIEW_PATCH_PATH = "/workspace/input/review.patch" as const;

const REVIEW_LENS_QUESTIONS: Readonly<Record<ReviewLens, string>> = {
  spec: "Does the implementation satisfy the approved Task, its acceptance criteria, and its non-goals?",
  architecture:
    "Is the implementation consistent with the Project's current architecture and intended direction without prematurely implementing the future?",
  quality:
    "Is the implementation correct, maintainable, secure, and adequately tested?",
  quant:
    "Are the quantitative definitions, units, assumptions, calculations, causal constraints, and conclusions correct? Independently reproduce material quantities where practical.",
};

export const ReviewFindingSchema = z
  .object({
    location: z.string().trim().min(1).max(2_000),
    failure_scenario: z.string().trim().min(1).max(4_000),
    evidence: z.string().trim().min(1).max(4_000),
    required_correction: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewAssessmentSchema = z
  .object({
    verdict: z.enum(["pass", "rework", "blocked"]),
    conclusion: ReviewTextSchema,
    blocking_findings: z.array(ReviewFindingSchema).max(64),
    improvements: ReviewListSchema,
    evidence: ReviewListSchema,
    uncertainty: ReviewListSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    if (
      assessment.verdict === "pass" &&
      assessment.blocking_findings.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocking_findings"],
        message: "a passing Review cannot contain blocking findings",
      });
    }
    if (
      assessment.verdict !== "pass" &&
      assessment.blocking_findings.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocking_findings"],
        message: "a non-passing Review requires a blocking finding",
      });
    }
  });
export type ReviewAssessment = z.infer<typeof ReviewAssessmentSchema>;

const ReviewCheckBindingSchema = z
  .object({
    check: IdentifierSchema,
    record_digest: DigestSchema,
  })
  .strict();
export type ReviewCheckBinding = z.infer<typeof ReviewCheckBindingSchema>;

const ReviewIntentWithoutMetadataSchema = z
  .object({
    version: z.literal(1),
    run: IdentifierSchema,
    task: IdentifierSchema,
    lens: ReviewLensSchema,
    round: z.number().int().positive(),
    plan_digest: DigestSchema,
    input_commit: GitCommitSchema,
    task_source_digest: DigestSchema,
    source_digest: DigestSchema,
    diff_digest: DigestSchema,
    checks: z.array(ReviewCheckBindingSchema).min(1),
    role_digest: DigestSchema,
    brief_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    identity: SessionIdentitySchema,
    sandbox: SessionSandboxSchema,
    policy_digest: DigestSchema,
    pi_version: z.string().min(1),
    client_version: z.string().min(1),
    message: IdentifierSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      new Set(intent.checks.map((check) => check.check)).size !==
      intent.checks.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "must contain unique Check identifiers",
      });
    }
  });

export const ReviewIntentSchema = ReviewIntentWithoutMetadataSchema.extend({
  id: ReviewJobIdSchema,
  binding_digest: DigestSchema,
  prepared_at: TimestampSchema,
}).strict();
export type ReviewIntent = z.infer<typeof ReviewIntentSchema>;

const ReviewReportSchema = z
  .object({
    path: z.literal("report.md"),
    byte_count: z
      .number()
      .int()
      .positive()
      .max(256 * 1024),
    content_digest: DigestSchema,
  })
  .strict();

const ReviewTurnSchema = z
  .object({
    message_id: IdentifierSchema,
    model_alias: ResolvedModelRouteSchema.shape.alias,
    requested_model: z.string().min(1),
    response_model: z.string().min(1).optional(),
    stop_reason: z.string().min(1),
    usage: z.record(z.string(), z.unknown()),
  })
  .strict();

const ReviewOpenShellSchema = z
  .object({
    cli_version: z.string().min(1),
    gateway: z.string().min(1),
    gateway_version: z.string().min(1),
  })
  .strict();

const ReviewRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: ReviewJobIdSchema,
    run: IdentifierSchema,
    task: IdentifierSchema,
    lens: ReviewLensSchema,
    round: z.number().int().positive(),
    verdict: z.enum(["pass", "rework", "blocked"]),
    assessment: ReviewAssessmentSchema,
    plan_digest: DigestSchema,
    input_commit: GitCommitSchema,
    task_source_digest: DigestSchema,
    source_digest: DigestSchema,
    diff_digest: DigestSchema,
    checks: z.array(ReviewCheckBindingSchema).min(1),
    role_digest: DigestSchema,
    brief_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    identity: SessionIdentitySchema,
    sandbox: SessionSandboxSchema,
    policy_digest: DigestSchema,
    pi_version: z.string().min(1),
    client_version: z.string().min(1),
    openshell: ReviewOpenShellSchema,
    turn: ReviewTurnSchema,
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    report: ReviewReportSchema,
    intent_digest: DigestSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.verdict !== record.assessment.verdict) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "must equal the structured assessment verdict",
      });
    }
    if (Date.parse(record.ended_at) < Date.parse(record.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["ended_at"],
        message: "must not precede started_at",
      });
    }
    if (
      record.turn.model_alias !== record.model.alias ||
      record.turn.requested_model !== record.model.pi_model
    ) {
      context.addIssue({
        code: "custom",
        path: ["turn"],
        message: "must match the routed Review model",
      });
    }
  });

export const ReviewRecordSchema = ReviewRecordWithoutDigestSchema.extend({
  record_digest: DigestSchema,
}).strict();
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const REVIEW_OUTPUT_CONTRACT = `Return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "verdict": "pass" | "rework" | "blocked",
  "conclusion": "concise conclusion",
  "blocking_findings": [
    {
      "location": "path:line or evidence boundary",
      "failure_scenario": "concrete failure",
      "evidence": "specific evidence",
      "required_correction": "required correction"
    }
  ],
  "improvements": ["non-blocking improvement"],
  "evidence": ["evidence considered"],
  "uncertainty": ["remaining uncertainty"]
}
A pass must have no blocking findings. A rework or blocked verdict must have at least one complete blocking finding. Do not add prose outside the JSON object.`;

export function parseReviewAssessment(text: string): ReviewAssessment {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  try {
    return ReviewAssessmentSchema.parse(JSON.parse(source) as unknown);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_review_output",
      "Reviewer output is not one valid structured Review object",
      { cause: error },
    );
  }
}

function intentDigest(
  intent: z.infer<typeof ReviewIntentWithoutMetadataSchema>,
): Digest {
  return digestParts("pi-orchestrator/review-intent/v1", [
    ["intent", canonicalJson(intent)],
  ]);
}

function createIntent(
  input: z.input<typeof ReviewIntentWithoutMetadataSchema>,
  now: Date,
): ReviewIntent {
  const parsed = ReviewIntentWithoutMetadataSchema.parse(input);
  const bindingDigest = intentDigest(parsed);
  return ReviewIntentSchema.parse({
    ...parsed,
    id: `review-${bindingDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    binding_digest: bindingDigest,
    prepared_at: now.toISOString(),
  });
}

function validateIntent(value: unknown): ReviewIntent {
  const parsed = ReviewIntentSchema.parse(value);
  const {
    id,
    binding_digest: bindingDigest,
    prepared_at: _preparedAt,
    ...input
  } = parsed;
  const expected = intentDigest(ReviewIntentWithoutMetadataSchema.parse(input));
  const expectedId = `review-${expected.slice("sha256:".length, "sha256:".length + 16)}`;
  if (bindingDigest !== expected || id !== expectedId) {
    throw new OrchestratorError(
      "review_store_corrupt",
      `Review intent '${id}' has an invalid binding digest`,
    );
  }
  return parsed;
}

function recordDigest(
  record: z.infer<typeof ReviewRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/review-record/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function createRecord(
  input: z.input<typeof ReviewRecordWithoutDigestSchema>,
): ReviewRecord {
  const parsed = ReviewRecordWithoutDigestSchema.parse(input);
  return ReviewRecordSchema.parse({
    ...parsed,
    record_digest: recordDigest(parsed),
  });
}

function validateRecordDigest(value: unknown): ReviewRecord {
  const parsed = ReviewRecordSchema.parse(value);
  const { record_digest: digest, ...input } = parsed;
  if (recordDigest(ReviewRecordWithoutDigestSchema.parse(input)) !== digest) {
    throw new OrchestratorError(
      "review_store_corrupt",
      `Review record '${parsed.id}' has an invalid digest`,
    );
  }
  return parsed;
}

function intentRecordBinding(intent: ReviewIntent): unknown {
  return {
    id: intent.id,
    run: intent.run,
    task: intent.task,
    lens: intent.lens,
    round: intent.round,
    plan_digest: intent.plan_digest,
    input_commit: intent.input_commit,
    task_source_digest: intent.task_source_digest,
    source_digest: intent.source_digest,
    diff_digest: intent.diff_digest,
    checks: intent.checks,
    role_digest: intent.role_digest,
    brief_digest: intent.brief_digest,
    model: intent.model,
    identity: intent.identity,
    sandbox: intent.sandbox,
    policy_digest: intent.policy_digest,
    pi_version: intent.pi_version,
    client_version: intent.client_version,
    message: intent.message,
    intent_digest: intent.binding_digest,
  };
}

function recordIntentBinding(record: ReviewRecord): unknown {
  return {
    id: record.id,
    run: record.run,
    task: record.task,
    lens: record.lens,
    round: record.round,
    plan_digest: record.plan_digest,
    input_commit: record.input_commit,
    task_source_digest: record.task_source_digest,
    source_digest: record.source_digest,
    diff_digest: record.diff_digest,
    checks: record.checks,
    role_digest: record.role_digest,
    brief_digest: record.brief_digest,
    model: record.model,
    identity: record.identity,
    sandbox: record.sandbox,
    policy_digest: record.policy_digest,
    pi_version: record.pi_version,
    client_version: record.client_version,
    message: record.turn.message_id,
    intent_digest: record.intent_digest,
  };
}

function requireRecordIntent(record: ReviewRecord, intent: ReviewIntent): void {
  if (
    canonicalJson(recordIntentBinding(record)) !==
    canonicalJson(intentRecordBinding(intent))
  ) {
    throw new OrchestratorError(
      "review_result_mismatch",
      `Review result '${record.id}' does not match its durable intent`,
    );
  }
}

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function writeDurableFile(
  filePath: string,
  content: string,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ReviewStore {
  readonly directory: string;

  constructor(runDirectory: string) {
    this.directory = path.join(path.resolve(runDirectory), "reviews");
  }

  private jobDirectory(task: string, lens: ReviewLens, job: string): string {
    return path.join(
      this.directory,
      IdentifierSchema.parse(task),
      ReviewLensSchema.parse(lens),
      ReviewJobIdSchema.parse(job),
    );
  }

  async getIntent(
    task: string,
    lens: ReviewLens,
    job: string,
  ): Promise<ReviewIntent | undefined> {
    const filePath = path.join(
      this.jobDirectory(task, lens, job),
      "intent.json",
    );
    try {
      return validateIntent(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Invalid Review intent at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async prepare(requested: ReviewIntent): Promise<ReviewIntent> {
    const parsed = validateIntent(requested);
    const existing = await this.getIntent(parsed.task, parsed.lens, parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new OrchestratorError(
          "review_intent_conflict",
          `Review job '${parsed.id}' already has another intent`,
        );
      }
      return existing;
    }

    const parent = path.dirname(
      this.jobDirectory(parsed.task, parsed.lens, parsed.id),
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, `.${parsed.id}-`));
    try {
      await writeJsonAtomic(path.join(staging, "intent.json"), parsed);
      try {
        await rename(
          staging,
          this.jobDirectory(parsed.task, parsed.lens, parsed.id),
        );
        await syncDirectory(parent);
        return parsed;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.getIntent(parsed.task, parsed.lens, parsed.id);
        if (!raced || canonicalJson(raced) !== canonicalJson(parsed)) {
          throw new OrchestratorError(
            "review_intent_conflict",
            `Review job '${parsed.id}' raced with another intent`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async validateResult(
    jobDirectory: string,
    record: ReviewRecord,
  ): Promise<ReviewRecord> {
    const parsed = validateRecordDigest(record);
    const reportPath = path.join(jobDirectory, "result", parsed.report.path);
    const report = await readFile(reportPath).catch((error: unknown) => {
      throw new OrchestratorError(
        "review_store_corrupt",
        `Review record '${parsed.id}' has no durable report`,
        { cause: error },
      );
    });
    if (
      report.byteLength !== parsed.report.byte_count ||
      sha256(report) !== parsed.report.content_digest
    ) {
      throw new OrchestratorError(
        "review_store_corrupt",
        `Review record '${parsed.id}' has an invalid report`,
      );
    }
    return parsed;
  }

  async getResult(
    task: string,
    lens: ReviewLens,
    job: string,
  ): Promise<ReviewRecord | undefined> {
    const expectedTask = IdentifierSchema.parse(task);
    const expectedLens = ReviewLensSchema.parse(lens);
    const expectedJob = ReviewJobIdSchema.parse(job);
    const jobDirectory = this.jobDirectory(
      expectedTask,
      expectedLens,
      expectedJob,
    );
    const filePath = path.join(jobDirectory, "result", "record.json");
    try {
      const record = ReviewRecordSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (
        record.task !== expectedTask ||
        record.lens !== expectedLens ||
        record.id !== expectedJob
      ) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Review result identity does not match ${filePath}`,
        );
      }
      return this.validateResult(jobDirectory, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Invalid Review result at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async findResultByDigest(
    task: string,
    lens: ReviewLens,
    digest: string,
  ): Promise<ReviewRecord | undefined> {
    const expectedTask = IdentifierSchema.parse(task);
    const expectedLens = ReviewLensSchema.parse(lens);
    const expectedDigest = DigestSchema.parse(digest);
    const directory = path.join(this.directory, expectedTask, expectedLens);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let found: ReviewRecord | undefined;
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !ReviewJobIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Unexpected Review store entry '${path.join(directory, entry.name)}'`,
        );
      }
      const record = await this.getResult(
        expectedTask,
        expectedLens,
        entry.name,
      );
      if (!record || record.record_digest !== expectedDigest) continue;
      if (found) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Review evidence digest '${expectedDigest}' is duplicated`,
        );
      }
      found = record;
    }
    return found;
  }

  async listResults(): Promise<ReviewRecord[]> {
    let taskEntries;
    try {
      taskEntries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ReviewRecord[] = [];
    for (const taskEntry of taskEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (taskEntry.name.startsWith(".")) continue;
      if (
        !taskEntry.isDirectory() ||
        !IdentifierSchema.safeParse(taskEntry.name).success
      ) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Unexpected Review Task entry '${path.join(this.directory, taskEntry.name)}'`,
        );
      }
      const taskDirectory = path.join(this.directory, taskEntry.name);
      const lensEntries = await readdir(taskDirectory, {
        withFileTypes: true,
      });
      for (const lensEntry of lensEntries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (lensEntry.name.startsWith(".")) continue;
        const parsedLens = ReviewLensSchema.safeParse(lensEntry.name);
        if (!lensEntry.isDirectory() || !parsedLens.success) {
          throw new OrchestratorError(
            "review_store_corrupt",
            `Unexpected Review Lens entry '${path.join(taskDirectory, lensEntry.name)}'`,
          );
        }
        const lensDirectory = path.join(taskDirectory, lensEntry.name);
        const jobEntries = await readdir(lensDirectory, {
          withFileTypes: true,
        });
        for (const jobEntry of jobEntries.sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (jobEntry.name.startsWith(".")) continue;
          if (
            !jobEntry.isDirectory() ||
            !ReviewJobIdSchema.safeParse(jobEntry.name).success
          ) {
            throw new OrchestratorError(
              "review_store_corrupt",
              `Unexpected Review job entry '${path.join(lensDirectory, jobEntry.name)}'`,
            );
          }
          const record = await this.getResult(
            taskEntry.name,
            parsedLens.data,
            jobEntry.name,
          );
          if (record) records.push(record);
        }
      }
    }
    return records.sort(
      (left, right) =>
        left.started_at.localeCompare(right.started_at) ||
        left.id.localeCompare(right.id),
    );
  }

  async findIntentByDigest(
    task: string,
    lens: ReviewLens,
    digest: string,
  ): Promise<ReviewIntent | undefined> {
    const expectedTask = IdentifierSchema.parse(task);
    const expectedLens = ReviewLensSchema.parse(lens);
    const expectedDigest = DigestSchema.parse(digest);
    const directory = path.join(this.directory, expectedTask, expectedLens);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let found: ReviewIntent | undefined;
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !ReviewJobIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Unexpected Review store entry '${path.join(directory, entry.name)}'`,
        );
      }
      const intent = await this.getIntent(
        expectedTask,
        expectedLens,
        entry.name,
      );
      if (!intent || intent.binding_digest !== expectedDigest) continue;
      if (found) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Review intent digest '${expectedDigest}' is duplicated`,
        );
      }
      found = intent;
    }
    return found;
  }

  async putResult(options: {
    readonly intent: ReviewIntent;
    readonly record: ReviewRecord;
    readonly report: string;
  }): Promise<ReviewRecord> {
    const intent = validateIntent(options.intent);
    const record = validateRecordDigest(options.record);
    const durableIntent = await this.getIntent(
      intent.task,
      intent.lens,
      intent.id,
    );
    if (
      !durableIntent ||
      canonicalJson(durableIntent) !== canonicalJson(intent)
    ) {
      throw new OrchestratorError(
        "review_intent_conflict",
        `Review job '${intent.id}' does not have the expected durable intent`,
      );
    }
    requireRecordIntent(record, intent);
    const report = Buffer.from(options.report, "utf8");
    if (
      record.report.byte_count !== report.byteLength ||
      record.report.content_digest !== sha256(report)
    ) {
      throw new OrchestratorError(
        "review_result_mismatch",
        `Review report '${record.id}' does not match its record`,
      );
    }

    const jobDirectory = this.jobDirectory(intent.task, intent.lens, intent.id);
    const existing = await this.getResult(intent.task, intent.lens, intent.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new OrchestratorError(
          "review_result_conflict",
          `Review job '${intent.id}' already has another result`,
        );
      }
      return existing;
    }
    const staging = await mkdtemp(path.join(jobDirectory, ".result-"));
    try {
      await writeDurableFile(path.join(staging, "report.md"), options.report);
      await writeJsonAtomic(path.join(staging, "record.json"), record);
      await Promise.all([
        chmod(path.join(staging, "report.md"), 0o400),
        chmod(path.join(staging, "record.json"), 0o400),
      ]);
      try {
        await rename(staging, path.join(jobDirectory, "result"));
        await syncDirectory(jobDirectory);
        return record;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.getResult(intent.task, intent.lens, intent.id);
        if (!raced || canonicalJson(raced) !== canonicalJson(record)) {
          throw new OrchestratorError(
            "review_result_conflict",
            `Review job '${intent.id}' raced with another result`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export type ReviewProjectStore = Pick<
  ProjectStore,
  "read" | "readRun" | "runDirectory" | "updateRun"
>;

export interface ReviewSession {
  readonly info: ReadSessionInfo;
  run(
    message: z.infer<typeof MessageSchema>,
    timeoutMs?: number,
  ): Promise<ModelTurnResult>;
  stop(): Promise<void>;
}

export type ReviewSessionLauncher = (
  options: StartReadSessionOptions,
) => Promise<ReviewSession>;

export interface RunReviewOptions {
  readonly store: ReviewProjectStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly runId: string;
  readonly taskId: string;
  readonly lens: ReviewLens;
  readonly local: LocalConfig;
  readonly client: ReadSessionOpenShell;
  readonly decisions?: readonly Decision[];
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly launchSession?: ReviewSessionLauncher;
}

export interface RunReviewResult {
  readonly intent: ReviewIntent;
  readonly record: ReviewRecord;
  readonly reused: boolean;
  readonly task: TaskRecord;
}

export type RunRequiredReviewsOptions = Omit<
  RunReviewOptions,
  "client" | "lens" | "nonce"
> & {
  readonly clients: Readonly<Partial<Record<ReviewLens, ReadSessionOpenShell>>>;
  readonly nonce?: (lens: ReviewLens) => string;
};

export interface RunRequiredReviewsResult {
  readonly required: readonly ReviewLens[];
  readonly verdict: "pass" | "rework" | "blocked";
  readonly reviews: readonly RunReviewResult[];
  readonly task: TaskRecord;
}

function requireRunBinding(options: {
  readonly run: RunState;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly projectRecord: ProjectRecord;
}): void {
  const permissionPolicyDigest = projectPermissionPolicyDigest(
    options.project.roles,
  );
  if (
    options.run.project_id !== options.project.config.project.id ||
    path.resolve(options.projectRecord.root) !== options.project.root
  ) {
    throw new OrchestratorError(
      "run_project_conflict",
      `Run '${options.run.id}' does not belong to the loaded Project`,
    );
  }
  if (
    options.run.plan_id !== options.plan.id ||
    options.run.plan_revision !== options.plan.revision ||
    options.run.plan_digest !== options.plan.digest
  ) {
    throw new OrchestratorError(
      "run_plan_stale",
      `Run '${options.run.id}' is not bound to the loaded Plan revision`,
    );
  }
  if (options.run.permission_policy_digest !== permissionPolicyDigest) {
    throw new OrchestratorError(
      "run_permission_policy_stale",
      `Run '${options.run.id}' was approved under another Role permission policy`,
    );
  }
  requireFreshApproval(options.projectRecord.approvals[options.plan.id], {
    planId: options.run.plan_id,
    planRevision: options.run.plan_revision,
    planDigest: options.run.plan_digest as Digest,
    permissionPolicyDigest,
    baseCommit: options.run.base_commit,
  });
}

function findTask(plan: LoadedPlan, taskId: string): PlanTask {
  const parsed = IdentifierSchema.parse(taskId);
  const task = plan.tasks.find((candidate) => candidate.id === parsed);
  if (!task) {
    throw new OrchestratorError(
      "task_not_found",
      `Plan '${plan.id}' has no Task '${parsed}'`,
    );
  }
  return task;
}

function requireAppliedTask(run: RunState, task: PlanTask): TaskRecord {
  const state = run.tasks[task.id];
  if (
    !state?.input_commit ||
    !state.input_source_digest ||
    !state.output_source_digest ||
    !state.diff_digest ||
    state.patch_application?.state !== "applied" ||
    state.patch_application.host_diff_digest !== state.diff_digest
  ) {
    throw new OrchestratorError(
      "task_patch_missing",
      `Task '${task.id}' has no exact applied Patch ready for Review`,
    );
  }
  return state;
}

function gateKey(lens: ReviewLens): string {
  return IdentifierSchema.parse(`review-${lens}`);
}

function checkGateKey(check: string): string {
  return IdentifierSchema.parse(`check-${check}`);
}

function taskBinding(task: TaskRecord): unknown {
  return {
    input_commit: task.input_commit,
    input_source_digest: task.input_source_digest,
    output_source_digest: task.output_source_digest,
    diff_digest: task.diff_digest,
    patch_application: task.patch_application,
  };
}

function assertTaskBinding(
  current: TaskRecord,
  expected: TaskRecord,
  taskId: string,
): void {
  if (
    canonicalJson(taskBinding(current)) !== canonicalJson(taskBinding(expected))
  ) {
    throw new OrchestratorError(
      "review_stale",
      `Task '${taskId}' source or diff changed while the Review was running`,
    );
  }
}

async function currentProjectAndPlan(options: {
  readonly project: Project;
  readonly plan: LoadedPlan;
}): Promise<{ readonly project: Project; readonly plan: LoadedPlan }> {
  const project = await loadProject(options.project.root);
  if (project.config.project.id !== options.project.config.project.id) {
    throw new OrchestratorError(
      "review_stale",
      "Project identity changed while preparing Review evidence",
    );
  }
  const plan = await loadPlan(
    options.plan.directory,
    catalogFromConfig(project.config),
  );
  if (plan.digest !== options.plan.digest) {
    throw new OrchestratorError(
      "review_stale",
      "The approved Plan changed while preparing Review evidence",
    );
  }
  return { project, plan };
}

async function collectChecks(options: {
  readonly store: ReviewProjectStore;
  readonly project: Project;
  readonly run: RunState;
  readonly task: PlanTask;
  readonly taskState: TaskRecord;
}): Promise<CheckRecord[]> {
  const checks = new CheckStore(options.store.runDirectory(options.run.id));
  const records: CheckRecord[] = [];
  for (const check of options.task.checks) {
    const definition = options.project.config.checks[check];
    if (!definition) {
      throw new OrchestratorError(
        "review_check_stale",
        `Registered Check '${check}' no longer exists`,
      );
    }
    const gate = options.taskState.gates[checkGateKey(check)];
    if (gate?.status !== "pass" || !gate.digest) {
      throw new OrchestratorError(
        "review_checks_incomplete",
        `Task '${options.task.id}' has no passing evidence for Check '${check}'`,
      );
    }
    const record = await checks.findResultByDigest(
      options.task.id,
      check,
      gate.digest,
    );
    if (
      !record ||
      record.verdict !== "pass" ||
      record.run !== options.run.id ||
      record.task !== options.task.id ||
      record.check !== check ||
      record.plan_digest !== options.run.plan_digest ||
      record.input_commit !== options.taskState.input_commit ||
      record.task_source_digest !== options.taskState.output_source_digest ||
      record.diff_digest !== options.taskState.diff_digest ||
      canonicalJson({ argv: record.argv, cwd: record.cwd }) !==
        canonicalJson({ argv: definition.argv, cwd: definition.cwd ?? "." })
    ) {
      throw new OrchestratorError(
        "review_check_stale",
        `Check '${check}' evidence does not match the current Review source`,
      );
    }
    records.push(record);
  }
  return records;
}

function checkBindings(records: readonly CheckRecord[]): ReviewCheckBinding[] {
  return records.map((record) => ({
    check: record.check,
    record_digest: record.record_digest,
  }));
}

function briefChecks(records: readonly CheckRecord[]): BriefReviewCheck[] {
  return records.map((record) => ({
    check: record.check,
    verdict: "pass",
    argv: record.argv,
    cwd: record.cwd,
    exitCode: record.exit_code,
    recordDigest: record.record_digest as Digest,
  }));
}

function compileReviewBrief(options: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly task: PlanTask;
  readonly lens: ReviewLens;
  readonly plan: LoadedPlan;
  readonly decisions: readonly Decision[];
  readonly patch: VerifiedPatch;
  readonly checks: readonly CheckRecord[];
  readonly source: CheckSource;
  readonly model: ResolvedModelRoute;
}): CompiledBrief {
  const skillNames = [
    ...options.role.definition.skills,
    ...(options.lens === "quant" &&
    !options.role.definition.skills.includes("quant")
      ? ["quant"]
      : []),
  ];
  const skills = skillNames.map((name) => {
    const skill = options.project.skills.get(name);
    if (!skill) {
      throw new OrchestratorError(
        "unknown_skill",
        `Reviewer Role references unavailable Skill '${name}'`,
      );
    }
    return skill;
  });
  return compileBrief({
    identity: options.identity,
    agents: options.project.agents,
    role: options.role,
    permissionCeiling: options.permissionCeiling,
    task: options.task,
    plan: options.plan,
    decisions: options.decisions,
    dependencyReports: [],
    skills,
    outputContract: `Lens question: ${REVIEW_LENS_QUESTIONS[options.lens]}\n\n${REVIEW_OUTPUT_CONTRACT}`,
    sourceAnchors: options.patch.bundle.changes.map((change) => ({
      path: change.path,
      reason: "Changed by the exact Patch under Review.",
    })),
    sourceDigests: {
      plan: options.plan.digest,
      source: options.source.manifest.source_digest as Digest,
      task: options.source.manifest.task_source_digest as Digest,
      diff: options.source.manifest.diff_digest as Digest,
      patch: sha256(options.patch.patch),
      ...Object.fromEntries(
        options.checks.map((check) => [
          `check-${check.check}`,
          check.record_digest as Digest,
        ]),
      ),
    },
    review: {
      lens: options.lens,
      diff: {
        path: REVIEW_PATCH_PATH,
        digest: sha256(options.patch.patch),
      },
      checks: briefChecks(options.checks),
    },
    contextLimitTokens: options.model.context_window,
    initialFraction: options.project.config.context.initial_fraction,
  });
}

async function inspectExactWorktree(options: {
  readonly project: Project;
  readonly run: RunState;
  readonly task: TaskRecord;
  readonly patch: Awaited<ReturnType<typeof loadPreparedPatch>>["value"];
}): Promise<void> {
  let observed;
  try {
    observed = await new GitPatchWorktree().inspect({
      repository: options.project.root,
      worktree: options.run.worktree,
      branch: options.run.branch,
      inputCommit: options.task.input_commit!,
      patch: options.patch,
    });
  } catch (error) {
    throw new OrchestratorError(
      "review_stale",
      "Run worktree changed outside the exact applied Patch under Review",
      { cause: error },
    );
  }
  if (
    observed.state !== "applied" ||
    observed.hostDiffDigest !== options.task.diff_digest ||
    observed.resultSourceDigest !== options.task.output_source_digest
  ) {
    throw new OrchestratorError(
      "review_stale",
      "Run worktree does not match the exact applied Patch under Review",
    );
  }
}

function requirePinnedPreflight(
  preflight: OpenShellPreflight,
  model: ResolvedModelRoute,
): void {
  if (
    !preflight.requiredVersion ||
    preflight.versionMatches !== true ||
    preflight.requiredVersion !== preflight.installedVersion ||
    preflight.installedVersion !== preflight.status.version
  ) {
    throw new OrchestratorError(
      "review_openshell_unpinned",
      "Authoritative Reviews require an exact, matching OpenShell version pin",
    );
  }
  if (preflight.status.gateway !== model.gateway) {
    throw new OrchestratorError(
      "model_gateway_mismatch",
      `Review model '${model.alias}' requires gateway '${model.gateway}', not '${preflight.status.gateway}'`,
    );
  }
}

function requireReviewRole(project: Project) {
  const role = project.roles.get("reviewer");
  if (
    !role ||
    !roleHasReadSource(role.definition) ||
    role.definition.permissions.write_lease !== "never" ||
    role.definition.lifetime !== "review"
  ) {
    throw new OrchestratorError(
      "invalid_reviewer_role",
      "The reviewer Role must be read-only and Review-scoped",
    );
  }
  return role;
}

async function ensureReviewRound(options: {
  readonly store: ReviewProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly expected: TaskRecord;
  readonly limit: number;
}): Promise<TaskRecord> {
  const updated = await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertTaskBinding(current, options.expected, options.task.id);
    if (current.status !== "reviewing") {
      throw new OrchestratorError(
        "task_not_reviewing",
        `Task '${options.task.id}' must be reviewing before a Review starts`,
      );
    }
    const hasCurrentReview = options.task.reviews.some((lens) => {
      const gate = current.gates[gateKey(lens)];
      return gate !== undefined && gate.status !== "stale";
    });
    if (hasCurrentReview) return run;
    if (current.review_rounds >= options.limit) {
      throw new OrchestratorError(
        "review_round_limit",
        `Task '${options.task.id}' exhausted its Review rounds`,
      );
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.task.id]: {
          ...current,
          review_rounds: current.review_rounds + 1,
        },
      },
    };
  });
  return updated.tasks[options.task.id]!;
}

async function recordPendingGate(options: {
  readonly store: ReviewProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly expected: TaskRecord;
  readonly intent: ReviewIntent;
  readonly timestamp: string;
}): Promise<void> {
  await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertTaskBinding(current, options.expected, options.task.id);
    if (current.review_rounds !== options.intent.round) {
      throw new OrchestratorError(
        "review_stale",
        `Review '${options.intent.id}' belongs to another Review round`,
      );
    }
    if (current.status !== "reviewing") {
      throw new OrchestratorError(
        "task_not_reviewing",
        `Task '${options.task.id}' left Review before evidence was requested`,
      );
    }
    const key = gateKey(options.intent.lens);
    const existing = current.gates[key];
    if (existing?.status === "pass" || existing?.status === "fail") {
      throw new OrchestratorError(
        "review_gate_conflict",
        `Review Gate '${key}' already contains completed evidence`,
      );
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.task.id]: {
          ...current,
          gates: {
            ...current.gates,
            [key]: {
              status: "pending",
              digest: options.intent.binding_digest,
              updated_at: options.timestamp,
            },
          },
        },
      },
    };
  });
}

async function finalizeGate(options: {
  readonly store: ReviewProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly expected: TaskRecord;
  readonly intent: ReviewIntent;
  readonly record: ReviewRecord;
  readonly timestamp: string;
}): Promise<TaskRecord> {
  const updated = await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertTaskBinding(current, options.expected, options.task.id);
    if (current.review_rounds !== options.intent.round) {
      throw new OrchestratorError(
        "review_stale",
        `Review '${options.intent.id}' belongs to another Review round`,
      );
    }
    for (const check of options.task.checks) {
      const binding = options.intent.checks.find(
        (candidate) => candidate.check === check,
      );
      const gate = current.gates[checkGateKey(check)];
      if (
        !binding ||
        gate?.status !== "pass" ||
        gate.digest !== binding.record_digest
      ) {
        throw new OrchestratorError(
          "review_check_stale",
          `Check '${check}' changed while Review '${options.intent.id}' was running`,
        );
      }
    }
    const key = gateKey(options.record.lens);
    const existing = current.gates[key];
    const gateStatus = options.record.verdict === "pass" ? "pass" : "fail";
    if (
      existing?.status === gateStatus &&
      existing.digest === options.record.record_digest
    ) {
      return run;
    }
    if (
      existing?.status !== "pending" ||
      existing.digest !== options.intent.binding_digest
    ) {
      throw new OrchestratorError(
        "review_gate_conflict",
        `Review Gate '${key}' no longer matches '${options.intent.id}'`,
      );
    }
    const status =
      options.record.verdict === "pass"
        ? "reviewing"
        : options.record.verdict === "rework"
          ? "rework"
          : "blocked";
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.task.id]: {
          ...current,
          status,
          gates: {
            ...current.gates,
            [key]: {
              status: gateStatus,
              digest: options.record.record_digest,
              updated_at: options.timestamp,
            },
          },
        },
      },
    };
  });
  return updated.tasks[options.task.id]!;
}

function renderList(items: readonly string[]): string {
  return items.length === 0
    ? "None."
    : items.map((item) => `- ${item}`).join("\n");
}

export function renderReviewReport(options: {
  readonly intent: ReviewIntent;
  readonly assessment: ReviewAssessment;
}): string {
  const findings =
    options.assessment.blocking_findings.length === 0
      ? "None."
      : options.assessment.blocking_findings
          .map(
            (finding, index) =>
              `## Finding ${index + 1}\n\nLocation: ${finding.location}\n\nFailure scenario: ${finding.failure_scenario}\n\nEvidence: ${finding.evidence}\n\nRequired correction: ${finding.required_correction}`,
          )
          .join("\n\n");
  return `---
run: ${options.intent.run}
task: ${options.intent.task}
lens: ${options.intent.lens}
verdict: ${options.assessment.verdict}
plan_digest: ${options.intent.plan_digest}
diff_digest: ${options.intent.diff_digest}
---

# Conclusion

${options.assessment.conclusion}

# Blocking Findings

${findings}

# Improvements

${renderList(options.assessment.improvements)}

# Evidence

${renderList(options.assessment.evidence)}

# Uncertainty

${renderList(options.assessment.uncertainty)}
`;
}

function requireSourceChecks(
  source: CheckSource,
  checks: readonly CheckRecord[],
): void {
  for (const check of checks) {
    if (check.source_digest !== source.manifest.source_digest) {
      throw new OrchestratorError(
        "review_check_stale",
        `Check '${check.check}' evaluated another reconstructed source`,
      );
    }
  }
}

function requireCurrentRecord(options: {
  readonly record: ReviewRecord;
  readonly run: RunState;
  readonly task: PlanTask;
  readonly taskState: TaskRecord;
  readonly source: CheckSource;
  readonly checks: readonly CheckRecord[];
  readonly roleDigest: Digest;
  readonly briefDigest: Digest;
  readonly model: ResolvedModelRoute;
  readonly policyDigest: Digest;
}): void {
  const record = options.record;
  const expectedChecks = checkBindings(options.checks);
  if (
    record.run !== options.run.id ||
    record.task !== options.task.id ||
    record.plan_digest !== options.run.plan_digest ||
    record.input_commit !== options.taskState.input_commit ||
    record.task_source_digest !== options.taskState.output_source_digest ||
    record.source_digest !== options.source.manifest.source_digest ||
    record.diff_digest !== options.taskState.diff_digest ||
    record.round !== options.taskState.review_rounds ||
    canonicalJson(record.checks) !== canonicalJson(expectedChecks) ||
    record.role_digest !== options.roleDigest ||
    record.brief_digest !== options.briefDigest ||
    canonicalJson(record.model) !== canonicalJson(options.model) ||
    record.policy_digest !== options.policyDigest ||
    record.pi_version !== PI_RUNTIME_VERSION ||
    record.client_version !== PI_CLIENT_VERSION
  ) {
    throw new OrchestratorError(
      "review_stale",
      `Review '${record.id}' does not match the current Plan, source, Checks, Role, model, or policy`,
    );
  }
}

async function moveMessageIfPresent(
  mailbox: Mailbox,
  id: string,
  to: MessageLifecycle,
): Promise<void> {
  const stored = await mailbox.find(id);
  if (!stored || stored.lifecycle === to) return;
  await mailbox.move(id, stored.lifecycle, to);
}

async function allocateReviewSession(options: {
  readonly registry: AgentRegistry;
  readonly lens: ReviewLens;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly nonce: string;
}) {
  const agentId = IdentifierSchema.parse(`review-${options.lens}`);
  await options.registry.register({
    agent: agentId,
    role: "reviewer",
    model: options.model.alias,
  });
  const agent = await options.registry.get(agentId);
  const sessionId = IdentifierSchema.parse(
    `review-${options.lens}-${options.nonce}`,
  );
  if (agent.record.session === null) {
    return options.registry.start({
      agent: agentId,
      session: sessionId,
      permissionCeilingDigest:
        options.permissionCeiling.permission_ceiling_digest,
    });
  }
  if (!agent.session || !["stopped", "failed"].includes(agent.session.status)) {
    throw new OrchestratorError(
      "review_session_active",
      `Review Agent '${agentId}' already has a nonterminal Session`,
    );
  }
  return options.registry.replace({
    expected: agent.session.identity,
    session: sessionId,
    reason: "Fresh independent Review attempt",
    permissionCeilingDigest:
      options.permissionCeiling.permission_ceiling_digest,
  });
}

async function failSession(
  registry: AgentRegistry,
  identity: SessionIdentity,
  reason: string,
): Promise<void> {
  const current = await registry
    .requireCurrent(identity)
    .catch(() => undefined);
  if (!current || ["stopped", "failed"].includes(current.status)) return;
  await registry.transition(identity, {
    status: "failed",
    reason: reason.slice(0, 2_000),
  });
}

async function settleRecoveredSession(options: {
  readonly client: ReadSessionOpenShell;
  readonly registry: AgentRegistry;
  readonly intent: ReviewIntent;
}): Promise<void> {
  let current;
  try {
    current = await options.registry.requireCurrent(options.intent.identity);
  } catch (error) {
    if (error instanceof OrchestratorError && error.code === "stale_session") {
      return;
    }
    throw error;
  }
  if (current.status === "stopped") return;
  if (
    !current.sandbox ||
    canonicalJson(current.sandbox) !== canonicalJson(options.intent.sandbox)
  ) {
    throw new OrchestratorError(
      "review_session_mismatch",
      `Recovered Review Session '${options.intent.identity.session}' no longer matches its Sandbox`,
    );
  }
  await options.client.deleteSandbox(options.intent.sandbox.name, {
    missingOk: true,
  });
  if (current.status !== "failed") {
    await options.registry.transition(options.intent.identity, {
      status: "stopped",
      reason: "Independent Review recovered from durable evidence",
    });
  }
}

export async function runReview(
  options: RunReviewOptions,
): Promise<RunReviewResult> {
  const now = options.now ?? (() => new Date());
  const lens = ReviewLensSchema.parse(options.lens);
  const [projectRecord, initialRun, current] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
    currentProjectAndPlan({ project: options.project, plan: options.plan }),
  ]);
  requireRunBinding({
    run: initialRun,
    project: current.project,
    plan: current.plan,
    projectRecord,
  });
  const task = findTask(current.plan, options.taskId);
  if (!task.reviews.includes(lens)) {
    throw new OrchestratorError(
      "review_not_required",
      `Task '${task.id}' does not require the '${lens}' Review Lens`,
    );
  }
  const taskState = requireAppliedTask(initialRun, task);
  const role = requireReviewRole(current.project);
  const permissionCeiling = resolveRolePermissionCeiling({
    role,
    assignment: { kind: "review", task: task.id, lens },
    localPolicy: options.local.permissions,
  });
  const decisions = z.array(DecisionSchema).parse(options.decisions ?? []);
  const model = resolveReviewModelRoute(
    current.project.config,
    options.local,
    lens,
    role.definition.inference,
  );
  const policyDirectory = path.resolve(
    options.policyDirectory ?? bundledPiPolicyDirectory(),
  );
  const policy = await loadSandboxPolicy(
    "read",
    path.join(policyDirectory, "read.yaml"),
  );
  const preflight = await options.client.preflight();
  requirePinnedPreflight(preflight, model);

  const artifacts = new ArtifactStore(
    options.store.runDirectory(initialRun.id),
  );
  const patch = await loadPreparedPatch({
    store: artifacts,
    projectRoot: current.project.root,
    application: taskState.patch_application!,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  await inspectExactWorktree({
    project: current.project,
    run: initialRun,
    task: taskState,
    patch: patch.value,
  });
  const checks = await collectChecks({
    store: options.store,
    project: current.project,
    run: initialRun,
    task,
    taskState,
  });
  const source = await createCheckSource({
    projectRoot: current.project.root,
    inputCommit: taskState.input_commit!,
    taskSourceDigest: taskState.output_source_digest!,
    diffDigest: taskState.diff_digest!,
    patch: patch.value,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });

  try {
    requireSourceChecks(source, checks);
    const reviews = new ReviewStore(options.store.runDirectory(initialRun.id));
    const mailbox = new Mailbox(options.store.runDirectory(initialRun.id));
    const metrics = new MetricStore(
      options.store.runDirectory(initialRun.id),
      initialRun.id,
    );
    const registry = new AgentRegistry(options.store, initialRun.id, now);
    const existingGate = taskState.gates[gateKey(lens)];
    if (
      (existingGate?.status === "pass" || existingGate?.status === "fail") &&
      existingGate.digest
    ) {
      const existing = await reviews.findResultByDigest(
        task.id,
        lens,
        existingGate.digest,
      );
      if (!existing) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Review Gate '${gateKey(lens)}' references missing evidence`,
        );
      }
      const expectedBrief = compileReviewBrief({
        identity: existing.identity,
        project: current.project,
        role,
        permissionCeiling,
        task,
        lens,
        plan: current.plan,
        decisions,
        patch: patch.value,
        checks,
        source,
        model,
      });
      requireCurrentRecord({
        record: existing,
        run: initialRun,
        task,
        taskState,
        source,
        checks,
        roleDigest: role.digest,
        briefDigest: expectedBrief.digest,
        model,
        policyDigest: policy.digest,
      });
      const intent = await reviews.getIntent(task.id, lens, existing.id);
      if (!intent) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Review '${existing.id}' has no durable intent`,
        );
      }
      requireRecordIntent(existing, intent);
      await settleRecoveredSession({
        client: options.client,
        registry,
        intent,
      });
      await moveMessageIfPresent(mailbox, intent.message, "answered");
      return {
        intent,
        record: existing,
        reused: true,
        task: taskState,
      };
    }
    if (existingGate?.status === "pending" && existingGate.digest) {
      const pendingIntent = await reviews.findIntentByDigest(
        task.id,
        lens,
        existingGate.digest,
      );
      if (!pendingIntent) {
        throw new OrchestratorError(
          "review_store_corrupt",
          `Pending Review Gate '${gateKey(lens)}' references missing intent`,
        );
      }
      const pendingResult = await reviews.getResult(
        task.id,
        lens,
        pendingIntent.id,
      );
      if (pendingResult) {
        const expectedBrief = compileReviewBrief({
          identity: pendingResult.identity,
          project: current.project,
          role,
          permissionCeiling,
          task,
          lens,
          plan: current.plan,
          decisions,
          patch: patch.value,
          checks,
          source,
          model,
        });
        requireCurrentRecord({
          record: pendingResult,
          run: initialRun,
          task,
          taskState,
          source,
          checks,
          roleDigest: role.digest,
          briefDigest: expectedBrief.digest,
          model,
          policyDigest: policy.digest,
        });
        requireRecordIntent(pendingResult, pendingIntent);
        await settleRecoveredSession({
          client: options.client,
          registry,
          intent: pendingIntent,
        });
        const finalized = await finalizeGate({
          store: options.store,
          runId: initialRun.id,
          task,
          expected: taskState,
          intent: pendingIntent,
          record: pendingResult,
          timestamp: now().toISOString(),
        });
        await moveMessageIfPresent(mailbox, pendingIntent.message, "answered");
        return {
          intent: pendingIntent,
          record: pendingResult,
          reused: true,
          task: finalized,
        };
      }
    }

    const roundTask = await ensureReviewRound({
      store: options.store,
      runId: initialRun.id,
      task,
      expected: taskState,
      limit: current.project.config.attempts.review,
    });
    const rawNonce = (
      options.nonce ?? (() => randomBytes(4).toString("hex"))
    )();
    const nonce = z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .parse(rawNonce);
    const sessionRecord = await allocateReviewSession({
      registry,
      lens,
      model,
      permissionCeiling,
      nonce,
    });
    const identity = sessionRecord.identity;
    const brief = compileReviewBrief({
      identity,
      project: current.project,
      role,
      permissionCeiling,
      task,
      lens,
      plan: current.plan,
      decisions,
      patch: patch.value,
      checks,
      source,
      model,
    });
    const message = MessageSchema.parse({
      version: 2,
      id: `review-request-${lens}-${nonce}`,
      run: initialRun.id,
      from: { host: true },
      to: {
        agent: identity.agent,
        session: identity.session,
        generation: identity.generation,
      },
      type: "review-request",
      priority: "normal",
      reply_to: null,
      body: {
        action: "review",
        task: task.id,
        lens,
        brief_digest: brief.digest,
        instruction:
          "Perform the independent Review using only the frozen Brief and source, then return the required structured object.",
      },
      references: patch.value.bundle.changes.map((change) => change.path),
      created_at: now().toISOString(),
    });
    let session: ReviewSession | undefined;
    let intent: ReviewIntent | undefined;
    const patchInput = {
      name: path.posix.basename(REVIEW_PATCH_PATH),
      content: patch.value.patch,
      digest: sha256(patch.value.patch),
    } as const;
    const patchInputConfig = {
      path: REVIEW_PATCH_PATH,
      byte_count: patch.value.patch.byteLength,
      digest: patchInput.digest,
    } as const;
    try {
      session = await (options.launchSession ?? startReadSession)({
        client: options.client,
        identity,
        workspaceSource: source,
        permissionCeiling,
        model,
        brief,
        context: current.project.config.context,
        inputs: [patchInput],
        metrics,
        task: task.id,
        currentActionState: async () =>
          permissionRuntimeState({
            ceiling: permissionCeiling,
            identity,
            run: await options.store.readRun(initialRun.id),
          }),
        now,
        policyDirectory,
        ...(options.imageContext ? { imageContext: options.imageContext } : {}),
        ...(options.startupTimeoutMs
          ? { startupTimeoutMs: options.startupTimeoutMs }
          : {}),
        ...(options.turnTimeoutMs
          ? { turnTimeoutMs: options.turnTimeoutMs }
          : {}),
      });
      if (
        session.info.profile !== "read" ||
        session.info.permissionCeiling.permission_ceiling_digest !==
          permissionCeiling.permission_ceiling_digest ||
        canonicalJson(session.info.identity) !== canonicalJson(identity) ||
        session.info.sourceDigest !== source.manifest.source_digest ||
        session.info.policyDigest !== policy.digest ||
        session.info.briefDigest !== brief.digest ||
        canonicalJson(session.info.inputs) !==
          canonicalJson([patchInputConfig]) ||
        canonicalJson(session.info.model) !== canonicalJson(model) ||
        session.info.inference?.model !== model.pi_model
      ) {
        throw new OrchestratorError(
          "review_session_mismatch",
          "Fresh Review Session does not match its source, Brief, model, or policy",
        );
      }
      requirePinnedPreflight(session.info.openshell, model);
      await registry.bindSandbox(identity, {
        id: session.info.sandbox.id,
        name: session.info.sandbox.name,
        workspace: session.info.sandbox.workspace,
      });
      await registry.transition(identity, { status: "active" });
      const sessionSandbox = SessionSandboxSchema.parse({
        id: session.info.sandbox.id,
        name: session.info.sandbox.name,
        workspace: session.info.sandbox.workspace,
      });
      intent = await reviews.prepare(
        createIntent(
          {
            version: 1,
            run: initialRun.id,
            task: task.id,
            lens,
            round: roundTask.review_rounds,
            plan_digest: initialRun.plan_digest,
            input_commit: taskState.input_commit!,
            task_source_digest: taskState.output_source_digest!,
            source_digest: source.manifest.source_digest,
            diff_digest: taskState.diff_digest!,
            checks: checkBindings(checks),
            role_digest: role.digest,
            brief_digest: brief.digest,
            model,
            identity,
            sandbox: sessionSandbox,
            policy_digest: policy.digest,
            pi_version: session.info.piVersion,
            client_version: session.info.clientVersion,
            message: message.id,
          },
          now(),
        ),
      );
      await recordPendingGate({
        store: options.store,
        runId: initialRun.id,
        task,
        expected: taskState,
        intent,
        timestamp: now().toISOString(),
      });
      await mailbox.put(message);
      const startedAt = now().toISOString();
      const turn = ModelTurnResultSchema.parse(
        await session.run(message, options.turnTimeoutMs),
      );
      await moveMessageIfPresent(mailbox, message.id, "queued");
      if (
        !turn.message_ids.includes(message.id) ||
        turn.model_alias !== model.alias ||
        turn.requested_model !== model.pi_model
      ) {
        throw new OrchestratorError(
          "review_turn_mismatch",
          `Reviewer result does not match Message '${message.id}' and route '${model.alias}/${model.pi_model}'`,
        );
      }
      if (turn.truncated) {
        throw new OrchestratorError(
          "review_output_truncated",
          `Reviewer output exceeded the Link result limit for '${intent.id}'`,
        );
      }
      const assessment = parseReviewAssessment(turn.text);

      const [latestProjectRecord, latestRun, latest] = await Promise.all([
        options.store.read(),
        options.store.readRun(initialRun.id),
        currentProjectAndPlan({ project: current.project, plan: current.plan }),
      ]);
      requireRunBinding({
        run: latestRun,
        project: latest.project,
        plan: latest.plan,
        projectRecord: latestProjectRecord,
      });
      const latestTask = requireAppliedTask(latestRun, task);
      assertTaskBinding(latestTask, taskState, task.id);
      await inspectExactWorktree({
        project: latest.project,
        run: latestRun,
        task: latestTask,
        patch: patch.value,
      });
      const latestChecks = await collectChecks({
        store: options.store,
        project: latest.project,
        run: latestRun,
        task,
        taskState: latestTask,
      });
      if (
        canonicalJson(checkBindings(latestChecks)) !==
        canonicalJson(intent.checks)
      ) {
        throw new OrchestratorError(
          "review_check_stale",
          "Check evidence changed while the Review was running",
        );
      }
      const latestRole = requireReviewRole(latest.project);
      const latestModel = resolveReviewModelRoute(
        latest.project.config,
        options.local,
        lens,
        latestRole.definition.inference,
      );
      const latestPermissionCeiling = resolveRolePermissionCeiling({
        role: latestRole,
        assignment: { kind: "review", task: task.id, lens },
        localPolicy: options.local.permissions,
      });
      const latestBrief = compileReviewBrief({
        identity,
        project: latest.project,
        role: latestRole,
        permissionCeiling: latestPermissionCeiling,
        task,
        lens,
        plan: latest.plan,
        decisions,
        patch: patch.value,
        checks: latestChecks,
        source,
        model: latestModel,
      });
      const latestPolicy = await loadSandboxPolicy(
        "read",
        path.join(policyDirectory, "read.yaml"),
      );
      if (
        latestRole.digest !== intent.role_digest ||
        latestPermissionCeiling.permission_ceiling_digest !==
          permissionCeiling.permission_ceiling_digest ||
        latestBrief.digest !== intent.brief_digest ||
        canonicalJson(latestModel) !== canonicalJson(intent.model) ||
        latestPolicy.digest !== intent.policy_digest
      ) {
        throw new OrchestratorError(
          "review_stale",
          "Reviewer Brief, model route, or read policy changed while the Review was running",
        );
      }
      const durableSession = await registry.requireCurrent(identity);
      if (
        durableSession.status !== "active" ||
        canonicalJson(durableSession.sandbox) !== canonicalJson(intent.sandbox)
      ) {
        throw new OrchestratorError(
          "stale_session",
          `Review Session '${identity.session}' is no longer current and active`,
        );
      }

      const report = renderReviewReport({ intent, assessment });
      const reportBytes = Buffer.from(report, "utf8");
      const endedAt = now().toISOString();
      const record = createRecord({
        version: 1,
        id: intent.id,
        run: intent.run,
        task: intent.task,
        lens: intent.lens,
        round: intent.round,
        verdict: assessment.verdict,
        assessment,
        plan_digest: intent.plan_digest,
        input_commit: intent.input_commit,
        task_source_digest: intent.task_source_digest,
        source_digest: intent.source_digest,
        diff_digest: intent.diff_digest,
        checks: intent.checks,
        role_digest: intent.role_digest,
        brief_digest: intent.brief_digest,
        model: intent.model,
        identity: intent.identity,
        sandbox: intent.sandbox,
        policy_digest: intent.policy_digest,
        pi_version: intent.pi_version,
        client_version: intent.client_version,
        openshell: {
          cli_version: session.info.openshell.installedVersion,
          gateway: session.info.openshell.status.gateway,
          gateway_version: session.info.openshell.status.version,
        },
        turn: {
          message_id: message.id,
          model_alias: turn.model_alias,
          requested_model: turn.requested_model,
          ...(turn.response_model
            ? { response_model: turn.response_model }
            : {}),
          stop_reason: turn.stop_reason,
          usage: turn.usage,
        },
        started_at: startedAt,
        ended_at: endedAt,
        report: {
          path: "report.md",
          byte_count: reportBytes.byteLength,
          content_digest: sha256(reportBytes),
        },
        intent_digest: intent.binding_digest,
      });
      const stored = await reviews.putResult({ intent, record, report });
      const finalized = await finalizeGate({
        store: options.store,
        runId: initialRun.id,
        task,
        expected: taskState,
        intent,
        record: stored,
        timestamp: now().toISOString(),
      });
      await moveMessageIfPresent(mailbox, message.id, "answered");
      await session.stop();
      await registry.transition(identity, {
        status: "stopped",
        reason: "Independent Review completed",
      });
      return { intent, record: stored, reused: false, task: finalized };
    } catch (error) {
      const cleanup: string[] = [];
      await moveMessageIfPresent(mailbox, message.id, "expired").catch(
        (cleanupError: unknown) => {
          cleanup.push(`Message: ${formatUnknownError(cleanupError)}`);
        },
      );
      await session?.stop().catch((cleanupError: unknown) => {
        cleanup.push(`Sandbox: ${formatUnknownError(cleanupError)}`);
      });
      await failSession(
        registry,
        identity,
        `Review failed: ${formatUnknownError(error)}`,
      ).catch((cleanupError: unknown) => {
        cleanup.push(`Session: ${formatUnknownError(cleanupError)}`);
      });
      if (cleanup.length > 0) {
        throw new OrchestratorError(
          "review_cleanup_failed",
          `Review failed (${formatUnknownError(error)}); cleanup also failed: ${cleanup.join("; ")}`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    await source.dispose();
  }
}

export async function runRequiredReviews(
  options: RunRequiredReviewsOptions,
): Promise<RunRequiredReviewsResult> {
  const task = findTask(options.plan, options.taskId);
  const required = [...task.reviews];
  if (new Set(required).size !== required.length) {
    throw new OrchestratorError(
      "invalid_plan",
      `Task '${task.id}' contains duplicate Review Lenses`,
    );
  }
  const missing = required.filter((lens) => !options.clients[lens]);
  if (missing.length > 0) {
    throw new OrchestratorError(
      "review_client_missing",
      `Task '${task.id}' has no OpenShell client for required Review Lenses: ${missing.join(", ")}`,
    );
  }

  const { clients, nonce, ...shared } = options;
  const reviews: RunReviewResult[] = [];
  for (const lens of required) {
    const result = await runReview({
      ...shared,
      lens,
      client: clients[lens]!,
      ...(nonce ? { nonce: () => nonce(lens) } : {}),
    });
    reviews.push(result);
    if (result.record.verdict !== "pass") {
      return {
        required,
        verdict: result.record.verdict,
        reviews,
        task: result.task,
      };
    }
  }

  return {
    required,
    verdict: "pass",
    reviews,
    task: reviews.at(-1)!.task,
  };
}
