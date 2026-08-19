import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { compileBrief, type BriefInput, type CompiledBrief } from "./brief.js";
import {
  ContextThresholdsSchema,
  IdentifierSchema,
  type ContextThresholds,
} from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import type { LinkEventFrame } from "./link.js";
import { ResolvedModelRouteSchema } from "./model.js";
import { SourceAnchorSchema } from "./plan.js";
import type { ProjectionRegistry } from "./projection.js";
import { SessionReconciler, type SessionRuntime } from "./reconcile.js";
import {
  createReport,
  ReportSchema,
  ReportStore,
  type Report,
} from "./report.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type AgentSessionProfile,
  type ReadSessionInfo,
} from "./seat.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  SessionSandboxSchema,
  type SessionIdentity,
  type SessionRecord,
} from "./session.js";
import { syncDirectory, writeJsonAtomic, type ProjectStore } from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const TextSchema = z.string().trim().min(1).max(4_000);
const TextListSchema = z.array(TextSchema).max(64);
const HandoffIdSchema = z.string().regex(/^handoff-[a-f0-9]{16}$/);

export const ContextPressureLevelSchema = z.enum([
  "normal",
  "warning",
  "handoff",
  "stop",
]);
export type ContextPressureLevel = z.infer<typeof ContextPressureLevelSchema>;

export const ContextPressureSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    context_window: z.number().int().positive(),
    fraction: z.number().finite().nonnegative(),
    percent: z.number().finite().nonnegative(),
    level: ContextPressureLevelSchema,
    mutating_phase_allowed: z.boolean(),
  })
  .strict()
  .superRefine((pressure, context) => {
    const fraction = pressure.tokens / pressure.context_window;
    if (Math.abs(pressure.fraction - fraction) > Number.EPSILON * 16) {
      context.addIssue({
        code: "custom",
        path: ["fraction"],
        message: "must equal tokens divided by context_window",
      });
    }
    if (Math.abs(pressure.percent - fraction * 100) > Number.EPSILON * 1_600) {
      context.addIssue({
        code: "custom",
        path: ["percent"],
        message: "must equal fraction multiplied by 100",
      });
    }
    if (pressure.mutating_phase_allowed !== (pressure.level !== "stop")) {
      context.addIssue({
        code: "custom",
        path: ["mutating_phase_allowed"],
        message: "must be false exactly at the stop level",
      });
    }
  });
export type ContextPressure = z.infer<typeof ContextPressureSchema>;

export function classifyContextPressure(
  usage: { readonly tokens: number; readonly contextWindow: number },
  rawThresholds: ContextThresholds,
): ContextPressure {
  const thresholds = ContextThresholdsSchema.parse(rawThresholds);
  const tokens = z.number().int().nonnegative().parse(usage.tokens);
  const contextWindow = z.number().int().positive().parse(usage.contextWindow);
  const fraction = tokens / contextWindow;
  const level: ContextPressureLevel =
    fraction >= thresholds.stop_fraction
      ? "stop"
      : fraction >= thresholds.handoff_fraction
        ? "handoff"
        : fraction >= thresholds.warn_fraction
          ? "warning"
          : "normal";
  return ContextPressureSchema.parse({
    tokens,
    context_window: contextWindow,
    fraction,
    percent: fraction * 100,
    level,
    mutating_phase_allowed: level !== "stop",
  });
}

function samePressure(left: ContextPressure, right: ContextPressure): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requirePressurePolicy(
  pressure: ContextPressure,
  thresholds: ContextThresholds,
  contextWindow: number,
  code: string,
): ContextPressure {
  const expectedWindow = z.number().int().positive().parse(contextWindow);
  const expected = classifyContextPressure(
    { tokens: pressure.tokens, contextWindow: expectedWindow },
    thresholds,
  );
  if (
    pressure.context_window !== expectedWindow ||
    !samePressure(pressure, expected)
  ) {
    throw new OrchestratorError(
      code,
      "Pi client context pressure does not match the host model and policy",
    );
  }
  return pressure;
}

export function parseContextPressureEvent(
  frame: LinkEventFrame,
  thresholds: ContextThresholds,
  contextWindow: number,
): { readonly identity: SessionIdentity; readonly pressure: ContextPressure } {
  if (frame.payload.event !== "context-pressure") {
    throw new OrchestratorError(
      "invalid_context_event",
      `Expected a context-pressure event, received '${frame.payload.event}'`,
    );
  }
  const pressure = requirePressurePolicy(
    ContextPressureSchema.parse(frame.payload.data),
    thresholds,
    contextWindow,
    "invalid_context_event",
  );
  return {
    identity: SessionIdentitySchema.parse(frame.identity),
    pressure,
  };
}

export const HandoffRequestSchema = z
  .object({
    source: z.enum(["manual", "context-pressure"]),
    reason: TextSchema,
    pressure: ContextPressureSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.source === "context-pressure" &&
      !["handoff", "stop"].includes(request.pressure?.level ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["pressure"],
        message:
          "an automatic Handoff request requires handoff or stop pressure",
      });
    }
  });
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

export function parseHandoffRequestEvent(
  frame: LinkEventFrame,
  thresholds: ContextThresholds,
  contextWindow: number,
): { readonly identity: SessionIdentity; readonly request: HandoffRequest } {
  if (frame.payload.event !== "handoff-requested") {
    throw new OrchestratorError(
      "invalid_handoff_event",
      `Expected a handoff-requested event, received '${frame.payload.event}'`,
    );
  }
  const request = HandoffRequestSchema.parse(frame.payload.data);
  if (request.pressure) {
    requirePressurePolicy(
      request.pressure,
      thresholds,
      contextWindow,
      "invalid_handoff_event",
    );
  }
  return {
    identity: SessionIdentitySchema.parse(frame.identity),
    request,
  };
}

export const HandoffCheckpointSchema = z
  .object({
    task: IdentifierSchema.optional(),
    source_digest: DigestSchema,
    patch_digest: DigestSchema.optional(),
    completed: TextListSchema,
    current_state: z.string().trim().min(1).max(16_000),
    blockers: TextListSchema,
    next_action: TextSchema,
    source_anchors: z.array(SourceAnchorSchema).min(1).max(128),
  })
  .strict();
export type HandoffCheckpoint = z.infer<typeof HandoffCheckpointSchema>;

function markdownList(values: readonly string[]): string {
  return values.length === 0
    ? "None."
    : values.map((value) => `- ${value}`).join("\n");
}

export function renderHandoffCheckpoint(
  rawCheckpoint: HandoffCheckpoint,
): string {
  const checkpoint = HandoffCheckpointSchema.parse(rawCheckpoint);
  const metadata = [
    "---",
    ...(checkpoint.task ? [`task: ${checkpoint.task}`] : []),
    `source_digest: ${checkpoint.source_digest}`,
    ...(checkpoint.patch_digest
      ? [`patch_digest: ${checkpoint.patch_digest}`]
      : []),
    "---",
  ].join("\n");
  return `${metadata}

# Completed

${markdownList(checkpoint.completed)}

# Current State

${checkpoint.current_state}

# Blockers

${markdownList(checkpoint.blockers)}

# Next Action

${checkpoint.next_action}

# Source Anchors

${
  checkpoint.source_anchors.length === 0
    ? "None."
    : checkpoint.source_anchors
        .map((anchor) => `- ${canonicalJson(anchor)}`)
        .join("\n")
}
`;
}

export function createHandoffReport(input: {
  readonly id: string;
  readonly identity: SessionIdentity;
  readonly checkpoint: HandoffCheckpoint;
  readonly createdAt: Date;
}): Report {
  const id = HandoffIdSchema.parse(input.id);
  const identity = SessionIdentitySchema.parse(input.identity);
  const checkpoint = HandoffCheckpointSchema.parse(input.checkpoint);
  return createReport({
    id,
    kind: "handoff",
    run: identity.run,
    seat: identity.seat,
    session: identity.session,
    epoch: identity.epoch,
    ...(checkpoint.task ? { task: checkpoint.task } : {}),
    source_digest: checkpoint.source_digest,
    ...(checkpoint.patch_digest
      ? { patch_digest: checkpoint.patch_digest }
      : {}),
    content: renderHandoffCheckpoint(checkpoint),
    created_at: input.createdAt.toISOString(),
  });
}

export function compileHandoffBrief(input: {
  readonly from: SessionIdentity;
  readonly to: SessionIdentity;
  readonly report: Report;
  readonly brief: Omit<BriefInput, "identity" | "handoff">;
}): CompiledBrief {
  const from = SessionIdentitySchema.parse(input.from);
  const to = SessionIdentitySchema.parse(input.to);
  const report = ReportSchema.parse(input.report);
  if (
    report.kind !== "handoff" ||
    report.run !== from.run ||
    report.seat !== from.seat ||
    report.session !== from.session ||
    report.epoch !== from.epoch
  ) {
    throw new OrchestratorError(
      "handoff_report_mismatch",
      "Handoff Report does not identify the predecessor Session",
    );
  }
  if (
    to.run !== from.run ||
    to.seat !== from.seat ||
    to.session === from.session ||
    to.epoch !== from.epoch + 1
  ) {
    throw new OrchestratorError(
      "handoff_identity_mismatch",
      "Replacement Session must preserve Run and Seat and advance one epoch",
    );
  }
  if (report.task !== undefined && report.task !== input.brief.task.id) {
    throw new OrchestratorError(
      "handoff_task_mismatch",
      `Handoff Report Task '${report.task}' does not match '${input.brief.task.id}'`,
    );
  }
  return compileBrief({
    ...input.brief,
    identity: to,
    handoff: report,
  });
}

const BriefBindingSchema = z
  .object({
    planDigest: DigestSchema,
    roleDigest: DigestSchema,
    taskDigest: DigestSchema,
    decisionsDigest: DigestSchema,
    sourceDigests: z.record(z.string(), DigestSchema),
    reviewDigest: DigestSchema.optional(),
    handoffDigest: DigestSchema.optional(),
    identity: SessionIdentitySchema,
  })
  .strict();

export const HandoffBriefArtifactSchema = z
  .object({
    version: z.literal(1),
    content: z.string().min(1),
    digest: DigestSchema,
    estimatedTokens: z.number().int().positive(),
    budgetTokens: z.number().int().positive(),
    omissions: z.array(z.string().min(1)),
    binding: BriefBindingSchema,
  })
  .strict();
export type HandoffBriefArtifact = z.infer<typeof HandoffBriefArtifactSchema>;

export const HandoffTriggerSchema = z.enum([
  "manual",
  "context-pressure",
  "recovery",
]);
export type HandoffTrigger = z.infer<typeof HandoffTriggerSchema>;

const HandoffLaunchBindingSchema = z
  .object({
    profile: z.enum(["read", "write"]),
    source_digest: DigestSchema,
    policy_digest: DigestSchema,
    model: ResolvedModelRouteSchema,
    context: ContextThresholdsSchema,
    pi_version: z.string().min(1),
    client_version: z.string().min(1),
  })
  .strict();
export type HandoffLaunchBinding = z.infer<typeof HandoffLaunchBindingSchema>;

const HandoffIntentWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: HandoffIdSchema,
    run: IdentifierSchema,
    seat: IdentifierSchema,
    from: SessionIdentitySchema,
    to: SessionIdentitySchema,
    trigger: HandoffTriggerSchema,
    reason: TextSchema,
    pressure: ContextPressureSchema.optional(),
    checkpoint: HandoffCheckpointSchema,
    checkpoint_digest: DigestSchema,
    report_id: HandoffIdSchema,
    report_digest: DigestSchema,
    brief_digest: DigestSchema,
    launch: HandoffLaunchBindingSchema,
    created_at: TimestampSchema,
  })
  .strict();

export const HandoffIntentSchema = HandoffIntentWithoutDigestSchema.extend({
  intent_digest: DigestSchema,
}).strict();
export type HandoffIntent = z.infer<typeof HandoffIntentSchema>;

const HandoffResultWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: HandoffIdSchema,
    run: IdentifierSchema,
    seat: IdentifierSchema,
    from: SessionIdentitySchema,
    to: SessionIdentitySchema,
    intent_digest: DigestSchema,
    report_digest: DigestSchema,
    brief_digest: DigestSchema,
    sandbox: SessionSandboxSchema,
    activated_at: TimestampSchema,
  })
  .strict();

export const HandoffResultSchema = HandoffResultWithoutDigestSchema.extend({
  result_digest: DigestSchema,
}).strict();
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

function contentDigest(
  domain: string,
  value: Readonly<Record<string, unknown>>,
): Digest {
  return digestParts(domain, [["record", canonicalJson(value)]]);
}

function validateIntent(raw: unknown): HandoffIntent {
  const intent = HandoffIntentSchema.parse(raw);
  const { intent_digest: _digest, ...content } = intent;
  if (
    intent.intent_digest !==
    contentDigest("pi-orchestrator/handoff-intent/v1", content)
  ) {
    throw new OrchestratorError(
      "handoff_store_corrupt",
      `Handoff '${intent.id}' has an invalid intent digest`,
    );
  }
  if (
    intent.checkpoint_digest !==
    digestParts("pi-orchestrator/handoff-checkpoint/v1", [
      ["checkpoint", canonicalJson(intent.checkpoint)],
    ])
  ) {
    throw new OrchestratorError(
      "handoff_store_corrupt",
      `Handoff '${intent.id}' has an invalid checkpoint digest`,
    );
  }
  if (
    intent.run !== intent.from.run ||
    intent.run !== intent.to.run ||
    intent.seat !== intent.from.seat ||
    intent.seat !== intent.to.seat ||
    intent.to.epoch !== intent.from.epoch + 1 ||
    intent.to.session === intent.from.session
  ) {
    throw new OrchestratorError(
      "handoff_store_corrupt",
      `Handoff '${intent.id}' has invalid Session identities`,
    );
  }
  if (
    intent.trigger === "context-pressure" &&
    !["handoff", "stop"].includes(intent.pressure?.level ?? "")
  ) {
    throw new OrchestratorError(
      "handoff_store_corrupt",
      `Handoff '${intent.id}' has no qualifying context pressure`,
    );
  }
  return intent;
}

function validateResult(raw: unknown): HandoffResult {
  const result = HandoffResultSchema.parse(raw);
  const { result_digest: _digest, ...content } = result;
  if (
    result.result_digest !==
    contentDigest("pi-orchestrator/handoff-result/v1", content)
  ) {
    throw new OrchestratorError(
      "handoff_store_corrupt",
      `Handoff '${result.id}' has an invalid result digest`,
    );
  }
  return result;
}

function toBriefArtifact(brief: CompiledBrief): HandoffBriefArtifact {
  const artifact = HandoffBriefArtifactSchema.parse({
    version: 1,
    ...brief,
  });
  if (
    digestParts("pi-orchestrator/brief/v1", [
      ["brief.md", artifact.content],
    ]) !== artifact.digest
  ) {
    throw new OrchestratorError(
      "invalid_brief_digest",
      "Replacement Brief content does not match its digest",
    );
  }
  return artifact;
}

function fromBriefArtifact(artifact: HandoffBriefArtifact): CompiledBrief {
  return {
    content: artifact.content,
    digest: artifact.digest as Digest,
    estimatedTokens: artifact.estimatedTokens,
    budgetTokens: artifact.budgetTokens,
    omissions: artifact.omissions,
    binding: {
      planDigest: artifact.binding.planDigest as Digest,
      roleDigest: artifact.binding.roleDigest as Digest,
      taskDigest: artifact.binding.taskDigest as Digest,
      decisionsDigest: artifact.binding.decisionsDigest as Digest,
      sourceDigests: Object.fromEntries(
        Object.entries(artifact.binding.sourceDigests).map(([name, digest]) => [
          name,
          digest as Digest,
        ]),
      ),
      ...(artifact.binding.reviewDigest
        ? { reviewDigest: artifact.binding.reviewDigest as Digest }
        : {}),
      ...(artifact.binding.handoffDigest
        ? { handoffDigest: artifact.binding.handoffDigest as Digest }
        : {}),
      identity: artifact.binding.identity,
    },
  };
}

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

export interface StoredHandoff {
  readonly intent: HandoffIntent;
  readonly brief: CompiledBrief;
  readonly result?: HandoffResult;
}

export class HandoffStore {
  readonly directory: string;

  constructor(runDirectory: string) {
    this.directory = path.join(path.resolve(runDirectory), "handoffs");
  }

  private operationDirectory(seat: string, id: string): string {
    return path.join(
      this.directory,
      IdentifierSchema.parse(seat),
      HandoffIdSchema.parse(id),
    );
  }

  async get(seat: string, id: string): Promise<StoredHandoff | undefined> {
    const directory = this.operationDirectory(seat, id);
    let intentSource: string;
    try {
      intentSource = await readFile(
        path.join(directory, "intent.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const intent = validateIntent(JSON.parse(intentSource) as unknown);
      const artifact = HandoffBriefArtifactSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, "brief.json"), "utf8"),
        ) as unknown,
      );
      const brief = fromBriefArtifact(artifact);
      toBriefArtifact(brief);
      if (
        intent.seat !== IdentifierSchema.parse(seat) ||
        intent.id !== HandoffIdSchema.parse(id) ||
        intent.brief_digest !== brief.digest
      ) {
        throw new OrchestratorError(
          "handoff_store_corrupt",
          `Handoff identity or Brief does not match ${directory}`,
        );
      }
      let result: HandoffResult | undefined;
      try {
        result = validateResult(
          JSON.parse(
            await readFile(
              path.join(directory, "result", "result.json"),
              "utf8",
            ),
          ) as unknown,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (result) requireResultIntent(result, intent);
      return { intent, brief, ...(result ? { result } : {}) };
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(
        "handoff_store_corrupt",
        `Invalid Handoff evidence at ${directory}`,
        { cause: error },
      );
    }
  }

  async prepare(
    requestedIntent: HandoffIntent,
    requestedBrief: CompiledBrief,
  ): Promise<StoredHandoff> {
    const intent = validateIntent(requestedIntent);
    const brief = fromBriefArtifact(toBriefArtifact(requestedBrief));
    if (intent.brief_digest !== brief.digest) {
      throw new OrchestratorError(
        "handoff_intent_mismatch",
        `Handoff '${intent.id}' does not bind its replacement Brief`,
      );
    }
    const existing = await this.get(intent.seat, intent.id);
    if (existing) {
      if (
        canonicalJson(existing.intent) !== canonicalJson(intent) ||
        canonicalJson(existing.brief) !== canonicalJson(brief)
      ) {
        throw new OrchestratorError(
          "handoff_intent_conflict",
          `Handoff '${intent.id}' already has another intent`,
        );
      }
      return existing;
    }

    const parent = path.dirname(
      this.operationDirectory(intent.seat, intent.id),
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, `.${intent.id}-`));
    try {
      await writeJsonAtomic(path.join(staging, "intent.json"), intent);
      await writeJsonAtomic(
        path.join(staging, "brief.json"),
        toBriefArtifact(brief),
      );
      try {
        await rename(staging, this.operationDirectory(intent.seat, intent.id));
        await syncDirectory(parent);
        return { intent, brief };
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.get(intent.seat, intent.id);
        if (
          !raced ||
          canonicalJson(raced.intent) !== canonicalJson(intent) ||
          canonicalJson(raced.brief) !== canonicalJson(brief)
        ) {
          throw new OrchestratorError(
            "handoff_intent_conflict",
            `Handoff '${intent.id}' raced with another intent`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async complete(requested: HandoffResult): Promise<HandoffResult> {
    const result = validateResult(requested);
    const stored = await this.get(result.seat, result.id);
    if (!stored) {
      throw new OrchestratorError(
        "handoff_intent_missing",
        `Handoff '${result.id}' has no durable intent`,
      );
    }
    requireResultIntent(result, stored.intent);
    if (stored.result) {
      if (canonicalJson(stored.result) !== canonicalJson(result)) {
        throw new OrchestratorError(
          "handoff_result_conflict",
          `Handoff '${result.id}' already has another result`,
        );
      }
      return stored.result;
    }

    const operation = this.operationDirectory(result.seat, result.id);
    const staging = await mkdtemp(path.join(operation, ".result-"));
    try {
      await writeJsonAtomic(path.join(staging, "result.json"), result);
      try {
        await rename(staging, path.join(operation, "result"));
        await syncDirectory(operation);
        return result;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.get(result.seat, result.id);
        if (
          !raced?.result ||
          canonicalJson(raced.result) !== canonicalJson(result)
        ) {
          throw new OrchestratorError(
            "handoff_result_conflict",
            `Handoff '${result.id}' raced with another result`,
          );
        }
        return raced.result;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function requireResultIntent(
  result: HandoffResult,
  intent: HandoffIntent,
): void {
  if (
    result.id !== intent.id ||
    result.run !== intent.run ||
    result.seat !== intent.seat ||
    !sameSessionIdentity(result.from, intent.from) ||
    !sameSessionIdentity(result.to, intent.to) ||
    result.intent_digest !== intent.intent_digest ||
    result.report_digest !== intent.report_digest ||
    result.brief_digest !== intent.brief_digest
  ) {
    throw new OrchestratorError(
      "handoff_result_mismatch",
      `Handoff result '${result.id}' does not match its intent`,
    );
  }
}

type HandoffProjectStore = Pick<
  ProjectStore,
  "readRun" | "runDirectory" | "updateRun"
>;

export interface HandoffSession extends SessionRuntime {
  readonly info: ReadSessionInfo;
}

export type HandoffSessionLauncher = (input: {
  readonly identity: SessionIdentity;
  readonly brief: CompiledBrief;
}) => Promise<HandoffSession>;

export type HandoffBriefCompiler = (input: {
  readonly identity: SessionIdentity;
  readonly report: Report;
}) => CompiledBrief;

type HandoffPaneOptions = Omit<
  Parameters<ProjectionRegistry["ensurePane"]>[0],
  "identity"
>;

export interface RunHandoffOptions {
  readonly store: HandoffProjectStore;
  readonly reconciler: SessionReconciler;
  readonly expected: SessionIdentity;
  readonly replacementSession?: string;
  readonly trigger: HandoffTrigger;
  readonly reason: string;
  readonly checkpoint: HandoffCheckpoint;
  readonly pressure?: ContextPressure;
  readonly launch: HandoffLaunchBinding;
  readonly compileBrief: HandoffBriefCompiler;
  readonly launchSession: HandoffSessionLauncher;
  readonly fromRuntime?: SessionRuntime;
  readonly toRuntime?: HandoffSession;
  readonly pane?: HandoffPaneOptions;
  readonly policyDirectory?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface RunHandoffResult {
  readonly intent: HandoffIntent;
  readonly report: Report;
  readonly brief: CompiledBrief;
  readonly result: HandoffResult;
  readonly runtime?: HandoffSession;
  readonly reused: boolean;
}

function handoffIdentifiers(input: {
  readonly expected: SessionIdentity;
  readonly replacementSession?: string;
  readonly trigger: HandoffTrigger;
  readonly reason: string;
  readonly checkpoint: HandoffCheckpoint;
  readonly pressure?: ContextPressure;
  readonly launch: HandoffLaunchBinding;
}): { readonly id: string; readonly replacementSession: string } {
  const fingerprint = digestParts("pi-orchestrator/handoff-operation/v1", [
    [
      "operation",
      canonicalJson({
        expected: input.expected,
        replacement_session: input.replacementSession ?? null,
        trigger: input.trigger,
        reason: input.reason,
        checkpoint: input.checkpoint,
        pressure: input.pressure ?? null,
        launch: input.launch,
      }),
    ],
  ]).slice("sha256:".length, "sha256:".length + 16);
  return {
    id: `handoff-${fingerprint}`,
    replacementSession: IdentifierSchema.parse(
      input.replacementSession ?? `session-${fingerprint}`,
    ),
  };
}

function createIntent(input: {
  readonly id: string;
  readonly from: SessionIdentity;
  readonly to: SessionIdentity;
  readonly trigger: HandoffTrigger;
  readonly reason: string;
  readonly pressure?: ContextPressure;
  readonly checkpoint: HandoffCheckpoint;
  readonly report: Report;
  readonly brief: CompiledBrief;
  readonly launch: HandoffLaunchBinding;
  readonly createdAt: string;
}): HandoffIntent {
  const content = HandoffIntentWithoutDigestSchema.parse({
    version: 1,
    id: input.id,
    run: input.from.run,
    seat: input.from.seat,
    from: input.from,
    to: input.to,
    trigger: input.trigger,
    reason: input.reason,
    ...(input.pressure ? { pressure: input.pressure } : {}),
    checkpoint: input.checkpoint,
    checkpoint_digest: digestParts("pi-orchestrator/handoff-checkpoint/v1", [
      ["checkpoint", canonicalJson(input.checkpoint)],
    ]),
    report_id: input.report.id,
    report_digest: digestParts("pi-orchestrator/handoff-report/v1", [
      ["report", canonicalJson(input.report)],
    ]),
    brief_digest: input.brief.digest,
    launch: input.launch,
    created_at: input.createdAt,
  });
  return validateIntent({
    ...content,
    intent_digest: contentDigest("pi-orchestrator/handoff-intent/v1", content),
  });
}

function createResult(input: {
  readonly intent: HandoffIntent;
  readonly sandbox: ReadSessionInfo["sandbox"];
  readonly activatedAt: string;
}): HandoffResult {
  const content = HandoffResultWithoutDigestSchema.parse({
    version: 1,
    id: input.intent.id,
    run: input.intent.run,
    seat: input.intent.seat,
    from: input.intent.from,
    to: input.intent.to,
    intent_digest: input.intent.intent_digest,
    report_digest: input.intent.report_digest,
    brief_digest: input.intent.brief_digest,
    sandbox: {
      id: input.sandbox.id,
      name: input.sandbox.name,
      workspace: input.sandbox.workspace,
    },
    activated_at: input.activatedAt,
  });
  return validateResult({
    ...content,
    result_digest: contentDigest("pi-orchestrator/handoff-result/v1", content),
  });
}

function requireFreshBrief(
  brief: CompiledBrief,
  identity: SessionIdentity,
  report: Report,
): CompiledBrief {
  const artifact = toBriefArtifact(brief);
  const expectedHandoffDigest = digestParts(
    "pi-orchestrator/handoff-context/v1",
    [["handoff", canonicalJson(report)]],
  );
  if (
    !sameSessionIdentity(artifact.binding.identity, identity) ||
    artifact.binding.handoffDigest !== expectedHandoffDigest
  ) {
    throw new OrchestratorError(
      "handoff_brief_stale",
      "Replacement Brief is not bound to the new Session and Handoff Report",
    );
  }
  return fromBriefArtifact(artifact);
}

function requireReportRequest(report: Report, expected: Report): void {
  if (canonicalJson(report) !== canonicalJson(expected)) {
    throw new OrchestratorError(
      "handoff_report_conflict",
      `Handoff Report '${expected.id}' does not match the requested checkpoint`,
    );
  }
}

function requireIntentRequest(input: {
  readonly stored: HandoffIntent;
  readonly requested: HandoffIntent;
}): void {
  if (canonicalJson(input.stored) !== canonicalJson(input.requested)) {
    throw new OrchestratorError(
      "handoff_intent_conflict",
      `Handoff '${input.requested.id}' does not match its durable request`,
    );
  }
}

function requireReplacementState(
  current: SessionRecord | null,
  intent: HandoffIntent,
): void {
  if (
    !current ||
    !sameSessionIdentity(current.identity, intent.to) ||
    current.replaces?.session !== intent.from.session ||
    current.replaces.reason !== intent.reason
  ) {
    throw new OrchestratorError(
      "handoff_session_conflict",
      `Seat '${intent.seat}' is not at the intended replacement epoch`,
    );
  }
}

function sameSandbox(
  left: {
    readonly id: string;
    readonly name: string;
    readonly workspace: string;
  },
  right: {
    readonly id: string;
    readonly name: string;
    readonly workspace: string;
  },
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.workspace === right.workspace
  );
}

function requireCompletedState(
  completed: SessionRecord | undefined,
  intent: HandoffIntent,
  result: HandoffResult,
): void {
  requireReplacementState(completed ?? null, intent);
  if (!completed?.sandbox || !sameSandbox(completed.sandbox, result.sandbox)) {
    throw new OrchestratorError(
      "handoff_result_mismatch",
      `Handoff result '${result.id}' does not match the durable replacement Sandbox`,
    );
  }
}

function requireRuntimeBinding(
  runtime: HandoffSession,
  intent: HandoffIntent,
): void {
  const info = runtime.info;
  if (
    !sameSessionIdentity(runtime.identity, intent.to) ||
    !sameSessionIdentity(info.identity, intent.to) ||
    info.profile !== intent.launch.profile ||
    info.sourceDigest !== intent.launch.source_digest ||
    info.policyDigest !== intent.launch.policy_digest ||
    info.briefDigest !== intent.brief_digest ||
    canonicalJson(info.context) !== canonicalJson(intent.launch.context) ||
    canonicalJson(info.model) !== canonicalJson(intent.launch.model) ||
    info.inference?.model !== intent.launch.model.pi_model ||
    info.piVersion !== intent.launch.pi_version ||
    info.clientVersion !== intent.launch.client_version ||
    info.openshell.status.gateway !== intent.launch.model.gateway
  ) {
    throw new OrchestratorError(
      "handoff_session_mismatch",
      "Replacement Session does not match the durable Handoff binding",
    );
  }
}

async function optionalReport(
  reports: ReportStore,
  id: string,
): Promise<Report | undefined> {
  try {
    return await reports.get(id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runHandoff(
  options: RunHandoffOptions,
): Promise<RunHandoffResult> {
  const expected = SessionIdentitySchema.parse(options.expected);
  const trigger = HandoffTriggerSchema.parse(options.trigger);
  const reason = TextSchema.parse(options.reason);
  const checkpoint = HandoffCheckpointSchema.parse(options.checkpoint);
  const pressure = options.pressure
    ? ContextPressureSchema.parse(options.pressure)
    : undefined;
  const launch = HandoffLaunchBindingSchema.parse(options.launch);
  if (checkpoint.source_digest !== launch.source_digest) {
    throw new OrchestratorError(
      "handoff_source_mismatch",
      "Handoff checkpoint source does not match the replacement source",
    );
  }
  if (pressure) {
    requirePressurePolicy(
      pressure,
      launch.context,
      launch.model.context_window,
      "handoff_pressure_mismatch",
    );
  }
  if (
    trigger === "context-pressure" &&
    !["handoff", "stop"].includes(pressure?.level ?? "")
  ) {
    throw new OrchestratorError(
      "handoff_pressure_required",
      "A context-pressure Handoff requires handoff or stop pressure",
    );
  }
  const identifiers = handoffIdentifiers({
    expected,
    ...(options.replacementSession
      ? { replacementSession: options.replacementSession }
      : {}),
    trigger,
    reason,
    checkpoint,
    ...(pressure ? { pressure } : {}),
    launch,
  });
  const to = SessionIdentitySchema.parse({
    run: expected.run,
    seat: expected.seat,
    session: identifiers.replacementSession,
    epoch: expected.epoch + 1,
  });
  const handoffs = new HandoffStore(options.store.runDirectory(expected.run));
  const reports = new ReportStore(options.store.runDirectory(expected.run));
  let stored = await handoffs.get(expected.seat, identifiers.id);
  let report: Report;
  let brief: CompiledBrief;

  if (stored) {
    report = await reports.get(stored.intent.report_id);
    const expectedReport = createHandoffReport({
      id: identifiers.id,
      identity: expected,
      checkpoint,
      createdAt: new Date(report.created_at),
    });
    requireReportRequest(report, expectedReport);
    brief = requireFreshBrief(
      options.compileBrief({ identity: to, report }),
      to,
      report,
    );
    const requested = createIntent({
      id: identifiers.id,
      from: expected,
      to,
      trigger,
      reason,
      ...(pressure ? { pressure } : {}),
      checkpoint,
      report,
      brief,
      launch,
      createdAt: stored.intent.created_at,
    });
    requireIntentRequest({ stored: stored.intent, requested });
    if (canonicalJson(stored.brief) !== canonicalJson(brief)) {
      throw new OrchestratorError(
        "handoff_brief_stale",
        `Handoff '${stored.intent.id}' replacement Brief has changed`,
      );
    }
  } else {
    const priorReport = await optionalReport(reports, identifiers.id);
    report =
      priorReport ??
      createHandoffReport({
        id: identifiers.id,
        identity: expected,
        checkpoint,
        createdAt: (options.now ?? (() => new Date()))(),
      });
    const expectedReport = createHandoffReport({
      id: identifiers.id,
      identity: expected,
      checkpoint,
      createdAt: new Date(report.created_at),
    });
    requireReportRequest(report, expectedReport);
    await reports.put(report);
    brief = requireFreshBrief(
      options.compileBrief({ identity: to, report }),
      to,
      report,
    );
    const intent = createIntent({
      id: identifiers.id,
      from: expected,
      to,
      trigger,
      reason,
      ...(pressure ? { pressure } : {}),
      checkpoint,
      report,
      brief,
      launch,
      createdAt: report.created_at,
    });
    stored = await handoffs.prepare(intent, brief);
  }

  if (stored.result) {
    const run = await options.store.readRun(expected.run);
    requireCompletedState(
      run.sessions[stored.intent.to.session],
      stored.intent,
      stored.result,
    );
    if (options.toRuntime) {
      requireRuntimeBinding(options.toRuntime, stored.intent);
      if (!sameSandbox(options.toRuntime.info.sandbox, stored.result.sandbox)) {
        throw new OrchestratorError(
          "handoff_result_mismatch",
          `Live replacement Session does not match Handoff result '${stored.result.id}'`,
        );
      }
    }
    return {
      intent: stored.intent,
      report,
      brief: stored.brief,
      result: stored.result,
      ...(options.toRuntime ? { runtime: options.toRuntime } : {}),
      reused: true,
    };
  }

  const seat = await options.reconciler.registry.get(expected.seat);
  if (seat.session && sameSessionIdentity(seat.session.identity, expected)) {
    await options.reconciler.replace({
      expected,
      session: stored.intent.to.session,
      reason,
      ...(options.fromRuntime ? { runtime: options.fromRuntime } : {}),
    });
  } else {
    requireReplacementState(seat.session, stored.intent);
  }

  const replacement = await options.reconciler.registry.requireCurrent(to);
  let runtime = options.toRuntime;
  if (runtime) {
    requireRuntimeBinding(runtime, stored.intent);
  } else if (replacement.sandbox) {
    try {
      runtime = (await options.reconciler.recover({
        identity: to,
        profile: launch.profile,
        model: launch.model,
        briefDigest: stored.intent.brief_digest,
        context: launch.context,
        piVersion: launch.pi_version,
        clientVersion: launch.client_version,
        ...(options.policyDirectory
          ? { policyDirectory: options.policyDirectory }
          : {}),
        ...(options.startupTimeoutMs
          ? { startupTimeoutMs: options.startupTimeoutMs }
          : {}),
        ...(options.turnTimeoutMs
          ? { turnTimeoutMs: options.turnTimeoutMs }
          : {}),
      })) as HandoffSession;
    } catch (error) {
      throw new OrchestratorError(
        "handoff_replacement_recovery_failed",
        `Cannot recover replacement Session '${to.session}' from its durable Sandbox`,
        { cause: error },
      );
    }
    requireRuntimeBinding(runtime, stored.intent);
  } else {
    const launched = await options.launchSession({
      identity: to,
      brief: stored.brief,
    });
    try {
      requireRuntimeBinding(launched, stored.intent);
      runtime = launched;
    } catch (error) {
      await launched.stop().catch(() => undefined);
      throw error;
    }
  }

  try {
    await options.reconciler.activate(runtime, options.pane);
  } catch (error) {
    const current = await options.reconciler.registry.requireCurrent(to);
    if (current.sandbox) {
      await options.reconciler.mailbox.detach(to).catch(() => undefined);
      await runtime.release().catch(() => undefined);
    } else {
      await runtime.stop().catch(() => undefined);
    }
    throw error;
  }

  const current = await options.reconciler.registry.requireCurrent(to);
  if (current.status !== "active" || !current.sandbox) {
    throw new OrchestratorError(
      "handoff_activation_failed",
      `Replacement Session '${to.session}' did not become active`,
    );
  }
  const result = await handoffs.complete(
    createResult({
      intent: stored.intent,
      sandbox: runtime.info.sandbox,
      activatedAt: (options.now ?? (() => new Date()))().toISOString(),
    }),
  );
  return {
    intent: stored.intent,
    report,
    brief: stored.brief,
    result,
    runtime,
    reused: false,
  };
}

export type RecoverTerminatedSessionOptions = Omit<
  RunHandoffOptions,
  "trigger" | "pressure" | "fromRuntime"
>;

export function recoverTerminatedSession(
  options: RecoverTerminatedSessionOptions,
): Promise<RunHandoffResult> {
  return runHandoff({
    ...options,
    trigger: "recovery",
  });
}

export function defaultHandoffLaunchBinding(input: {
  readonly profile: AgentSessionProfile;
  readonly sourceDigest: Digest;
  readonly policyDigest: Digest;
  readonly model: HandoffLaunchBinding["model"];
  readonly context: ContextThresholds;
  readonly piVersion?: string;
  readonly clientVersion?: string;
}): HandoffLaunchBinding {
  return HandoffLaunchBindingSchema.parse({
    profile: input.profile,
    source_digest: input.sourceDigest,
    policy_digest: input.policyDigest,
    model: input.model,
    context: input.context,
    pi_version: input.piVersion ?? PI_RUNTIME_VERSION,
    client_version: input.clientVersion ?? PI_CLIENT_VERSION,
  });
}
