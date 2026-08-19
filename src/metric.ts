import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema, ModelAliasSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { ModelLocalitySchema, type ModelPricing } from "./local.js";
import { SessionIdentitySchema, type SessionIdentity } from "./session.js";
import { syncDirectory, writeJsonAtomic } from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const MetricIdSchema = z.string().regex(/^metric-[a-f0-9]{16}$/);
const MillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const TokenSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const NormalizedUsageSchema = z
  .object({
    input_tokens: TokenSchema,
    output_tokens: TokenSchema,
    cache_read_tokens: TokenSchema,
    cache_write_tokens: TokenSchema,
    total_tokens: TokenSchema,
    measured: z
      .array(z.enum(["input", "output", "cache-read", "cache-write", "total"]))
      .max(5)
      .refine((values) => new Set(values).size === values.length, {
        message: "measured token categories must be unique",
      }),
  })
  .strict();
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;

const MetricModelSchema = z
  .object({
    alias: ModelAliasSchema,
    pi_model: z.string().min(1).max(256),
    locality: ModelLocalitySchema,
  })
  .strict();

const ContextPressureMetricSchema = z
  .object({
    tokens: TokenSchema,
    context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fraction: z.number().finite().nonnegative(),
    percent: z.number().finite().nonnegative(),
    level: z.enum(["normal", "warning", "handoff", "stop"]),
    mutating_phase_allowed: z.boolean(),
  })
  .strict();

const ModelTurnMetricSchema = z
  .object({
    kind: z.literal("model-turn"),
    identity: SessionIdentitySchema,
    task: IdentifierSchema.optional(),
    model: MetricModelSchema,
    message_ids: z
      .array(IdentifierSchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "message IDs must be unique",
      }),
    outcome: z.enum(["success", "failure"]),
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    duration_ms: MillisecondsSchema,
    usage: NormalizedUsageSchema,
    raw_usage_digest: DigestSchema,
    estimated_cost_usd: z.number().finite().nonnegative().nullable(),
    error_code: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const SandboxStartupMetricSchema = z
  .object({
    kind: z.literal("sandbox-startup"),
    identity: SessionIdentitySchema,
    profile: z.enum(["read", "write"]),
    model: MetricModelSchema.optional(),
    outcome: z.enum(["success", "failure"]),
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    duration_ms: MillisecondsSchema,
    error_code: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

const LinkFailureMetricSchema = z
  .object({
    kind: z.literal("link-failure"),
    identity: SessionIdentitySchema,
    operation: z.enum([
      "connect",
      "deliver",
      "receive",
      "reconnect",
      "ping",
      "turn",
    ]),
    error_code: z.string().trim().min(1).max(160),
  })
  .strict();

const MessageDeliveryMetricSchema = z
  .object({
    kind: z.literal("message-delivery"),
    identity: SessionIdentitySchema,
    message: IdentifierSchema,
    acknowledgement: z.enum(["queued", "duplicate"]),
    message_created_at: TimestampSchema,
    acknowledged_at: TimestampSchema,
    latency_ms: MillisecondsSchema,
  })
  .strict();

const ContextPressureObservationSchema = z
  .object({
    kind: z.literal("context-pressure"),
    identity: SessionIdentitySchema,
    pressure: ContextPressureMetricSchema,
  })
  .strict();

export const HumanActionSchema = z.enum([
  "scope-expansion",
  "gate-waiver",
  "security-policy-expansion",
  "other",
]);
export type HumanAction = z.infer<typeof HumanActionSchema>;

const HumanInterventionMetricSchema = z
  .object({
    kind: z.literal("human-intervention"),
    action: HumanActionSchema,
    actor: z.string().trim().min(1).max(320),
    task: IdentifierSchema.optional(),
    rationale: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const MetricPayloadSchema = z.discriminatedUnion("kind", [
  ModelTurnMetricSchema,
  SandboxStartupMetricSchema,
  LinkFailureMetricSchema,
  MessageDeliveryMetricSchema,
  ContextPressureObservationSchema,
  HumanInterventionMetricSchema,
]);
export type MetricPayload = z.infer<typeof MetricPayloadSchema>;

const MetricObservationContentSchema = z
  .object({
    version: z.literal(1),
    run: IdentifierSchema,
    observed_at: TimestampSchema,
    metric: MetricPayloadSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    const metric = observation.metric;
    if ("identity" in metric && metric.identity.run !== observation.run) {
      context.addIssue({
        code: "custom",
        path: ["metric", "identity", "run"],
        message: `must equal observation Run '${observation.run}'`,
      });
    }
    if (metric.kind === "model-turn" || metric.kind === "sandbox-startup") {
      if (Date.parse(metric.ended_at) < Date.parse(metric.started_at)) {
        context.addIssue({
          code: "custom",
          path: ["metric", "ended_at"],
          message: "must not precede started_at",
        });
      }
      const expected = elapsedMilliseconds(metric.started_at, metric.ended_at);
      if (metric.duration_ms !== expected) {
        context.addIssue({
          code: "custom",
          path: ["metric", "duration_ms"],
          message: "must equal the elapsed timestamp duration",
        });
      }
      if (
        (metric.outcome === "failure") !==
        (metric.error_code !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["metric", "error_code"],
          message: "must be present exactly for a failed operation",
        });
      }
    }
    if (metric.kind === "message-delivery") {
      if (
        Date.parse(metric.acknowledged_at) <
        Date.parse(metric.message_created_at)
      ) {
        context.addIssue({
          code: "custom",
          path: ["metric", "acknowledged_at"],
          message: "must not precede Message creation",
        });
      }
      const expected = elapsedMilliseconds(
        metric.message_created_at,
        metric.acknowledged_at,
      );
      if (metric.latency_ms !== expected) {
        context.addIssue({
          code: "custom",
          path: ["metric", "latency_ms"],
          message: "must equal Message creation through acknowledgement time",
        });
      }
    }
    if (metric.kind === "context-pressure") {
      const fraction = metric.pressure.tokens / metric.pressure.context_window;
      if (Math.abs(metric.pressure.fraction - fraction) > Number.EPSILON * 16) {
        context.addIssue({
          code: "custom",
          path: ["metric", "pressure", "fraction"],
          message: "must equal tokens divided by context_window",
        });
      }
      if (
        Math.abs(metric.pressure.percent - fraction * 100) >
        Number.EPSILON * 1_600
      ) {
        context.addIssue({
          code: "custom",
          path: ["metric", "pressure", "percent"],
          message: "must equal fraction multiplied by 100",
        });
      }
      if (
        metric.pressure.mutating_phase_allowed !==
        (metric.pressure.level !== "stop")
      ) {
        context.addIssue({
          code: "custom",
          path: ["metric", "pressure", "mutating_phase_allowed"],
          message: "must be false exactly at the stop level",
        });
      }
    }
  });
type MetricObservationContent = z.infer<typeof MetricObservationContentSchema>;

export const MetricObservationSchema = z
  .object({
    version: z.literal(1),
    id: MetricIdSchema,
    run: IdentifierSchema,
    observed_at: TimestampSchema,
    metric: MetricPayloadSchema,
    record_digest: DigestSchema,
  })
  .strict();
export type MetricObservation = z.infer<typeof MetricObservationSchema>;

function elapsedMilliseconds(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function observationDigest(content: MetricObservationContent): Digest {
  return digestParts("pi-orchestrator/metric-observation/v1", [
    ["observation", canonicalJson(content)],
  ]);
}

function validateObservation(value: unknown): MetricObservation {
  const observation = MetricObservationSchema.parse(value);
  const content = MetricObservationContentSchema.parse({
    version: observation.version,
    run: observation.run,
    observed_at: observation.observed_at,
    metric: observation.metric,
  });
  const digest = observationDigest(content);
  const id = `metric-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  if (observation.record_digest !== digest || observation.id !== id) {
    throw new OrchestratorError(
      "metric_store_corrupt",
      `Metric observation '${observation.id}' has an invalid digest`,
    );
  }
  return observation;
}

export function createMetricObservation(input: {
  readonly run: string;
  readonly observedAt: Date;
  readonly metric: MetricPayload;
}): MetricObservation {
  const content = MetricObservationContentSchema.parse({
    version: 1,
    run: input.run,
    observed_at: input.observedAt.toISOString(),
    metric: input.metric,
  });
  const recordDigest = observationDigest(content);
  return MetricObservationSchema.parse({
    ...content,
    id: `metric-${recordDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    record_digest: recordDigest,
  });
}

function tokenValue(
  usage: Readonly<Record<string, unknown>>,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}

export function normalizeModelUsage(
  usage: Readonly<Record<string, unknown>>,
): NormalizedUsage {
  const input = tokenValue(usage, ["input", "input_tokens", "prompt_tokens"]);
  const output = tokenValue(usage, [
    "output",
    "output_tokens",
    "completion_tokens",
  ]);
  const cacheRead = tokenValue(usage, [
    "cacheRead",
    "cache_read",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);
  const cacheWrite = tokenValue(usage, [
    "cacheWrite",
    "cache_write",
    "cache_write_tokens",
    "cache_creation_input_tokens",
  ]);
  const explicitTotal = tokenValue(usage, ["totalTokens", "total_tokens"]);
  const measured = [
    ...(input !== undefined ? (["input"] as const) : []),
    ...(output !== undefined ? (["output"] as const) : []),
    ...(cacheRead !== undefined ? (["cache-read"] as const) : []),
    ...(cacheWrite !== undefined ? (["cache-write"] as const) : []),
    ...(explicitTotal !== undefined ? (["total"] as const) : []),
  ];
  return NormalizedUsageSchema.parse({
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    cache_read_tokens: cacheRead ?? 0,
    cache_write_tokens: cacheWrite ?? 0,
    total_tokens:
      explicitTotal ??
      (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    measured,
  });
}

function roundedCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export function estimateModelCost(
  usage: NormalizedUsage,
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing || usage.measured.every((category) => category === "total")) {
    return null;
  }
  return roundedCost(
    (usage.input_tokens * pricing.input_per_million +
      usage.output_tokens * pricing.output_per_million +
      usage.cache_read_tokens * pricing.cache_read_per_million +
      usage.cache_write_tokens * pricing.cache_write_per_million) /
      1_000_000,
  );
}

function metricModel(input: {
  readonly alias: string;
  readonly pi_model: string;
  readonly locality: string;
}) {
  return MetricModelSchema.parse({
    alias: input.alias,
    pi_model: input.pi_model,
    locality: input.locality,
  });
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code.slice(0, 160);
  }
  return "unknown-error";
}

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

export interface SessionMetricRecorder {
  recordModelTurn(input: {
    readonly identity: SessionIdentity;
    readonly task?: string;
    readonly model: {
      readonly alias: string;
      readonly pi_model: string;
      readonly locality: string;
      readonly pricing?: ModelPricing | undefined;
    };
    readonly messageIds: readonly string[];
    readonly outcome: "success" | "failure";
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly usage?: Readonly<Record<string, unknown>>;
    readonly error?: unknown;
  }): Promise<MetricObservation>;
  recordSandboxStartup(input: {
    readonly identity: SessionIdentity;
    readonly profile: "read" | "write";
    readonly model?: {
      readonly alias: string;
      readonly pi_model: string;
      readonly locality: string;
    };
    readonly outcome: "success" | "failure";
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly error?: unknown;
  }): Promise<MetricObservation>;
  recordLinkFailure(input: {
    readonly identity: SessionIdentity;
    readonly operation:
      "connect" | "deliver" | "receive" | "reconnect" | "ping" | "turn";
    readonly occurredAt: Date;
    readonly error: unknown;
  }): Promise<MetricObservation>;
}

export class MetricStore implements SessionMetricRecorder {
  readonly directory: string;
  readonly runId: string;

  constructor(runDirectory: string, runId: string) {
    this.directory = path.join(
      path.resolve(runDirectory),
      "metrics",
      "observations",
    );
    this.runId = IdentifierSchema.parse(runId);
  }

  private observationDirectory(id: string): string {
    return path.join(this.directory, MetricIdSchema.parse(id));
  }

  async get(id: string): Promise<MetricObservation | undefined> {
    const parsedId = MetricIdSchema.parse(id);
    const filePath = path.join(
      this.observationDirectory(parsedId),
      "record.json",
    );
    try {
      const observation = validateObservation(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (observation.id !== parsedId || observation.run !== this.runId) {
        throw new OrchestratorError(
          "metric_store_corrupt",
          `Metric observation identity does not match ${filePath}`,
        );
      }
      return observation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(
        "metric_store_corrupt",
        `Invalid Metric observation at ${filePath}`,
        { cause: error },
      );
    }
  }

  async put(requested: MetricObservation): Promise<MetricObservation> {
    const observation = validateObservation(requested);
    if (observation.run !== this.runId) {
      throw new OrchestratorError(
        "metric_run_conflict",
        `Metric observation '${observation.id}' belongs to Run '${observation.run}', not '${this.runId}'`,
      );
    }
    const existing = await this.get(observation.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(observation)) {
        throw new OrchestratorError(
          "metric_observation_conflict",
          `Metric observation '${observation.id}' already has other content`,
        );
      }
      return existing;
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(
      path.join(this.directory, `.${observation.id}-`),
    );
    try {
      await writeJsonAtomic(path.join(staging, "record.json"), observation);
      try {
        await rename(staging, this.observationDirectory(observation.id));
        await syncDirectory(this.directory);
        return observation;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.get(observation.id);
        if (!raced || canonicalJson(raced) !== canonicalJson(observation)) {
          throw new OrchestratorError(
            "metric_observation_conflict",
            `Metric observation '${observation.id}' raced with other content`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async record(input: {
    readonly observedAt: Date;
    readonly metric: MetricPayload;
  }): Promise<MetricObservation> {
    return this.put(
      createMetricObservation({
        run: this.runId,
        observedAt: input.observedAt,
        metric: input.metric,
      }),
    );
  }

  async list(): Promise<MetricObservation[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const observations: MetricObservation[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !MetricIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "metric_store_corrupt",
          `Unexpected Metric store entry '${path.join(this.directory, entry.name)}'`,
        );
      }
      const observation = await this.get(entry.name);
      if (!observation) {
        throw new OrchestratorError(
          "metric_store_corrupt",
          `Metric observation '${entry.name}' has no record`,
        );
      }
      observations.push(observation);
    }
    return observations.sort(
      (left, right) =>
        left.observed_at.localeCompare(right.observed_at) ||
        left.id.localeCompare(right.id),
    );
  }

  recordModelTurn(
    input: Parameters<SessionMetricRecorder["recordModelTurn"]>[0],
  ): Promise<MetricObservation> {
    const usage = normalizeModelUsage(input.usage ?? {});
    const endedAt = input.endedAt.toISOString();
    return this.record({
      observedAt: input.endedAt,
      metric: {
        kind: "model-turn",
        identity: input.identity,
        ...(input.task ? { task: input.task } : {}),
        model: metricModel(input.model),
        message_ids: [...input.messageIds],
        outcome: input.outcome,
        started_at: input.startedAt.toISOString(),
        ended_at: endedAt,
        duration_ms: elapsedMilliseconds(
          input.startedAt.toISOString(),
          endedAt,
        ),
        usage,
        raw_usage_digest: digestParts("pi-orchestrator/model-usage/v1", [
          ["usage", canonicalJson(input.usage ?? {})],
        ]),
        estimated_cost_usd: estimateModelCost(usage, input.model.pricing),
        ...(input.outcome === "failure"
          ? { error_code: errorCode(input.error) }
          : {}),
      },
    });
  }

  recordSandboxStartup(
    input: Parameters<SessionMetricRecorder["recordSandboxStartup"]>[0],
  ): Promise<MetricObservation> {
    const endedAt = input.endedAt.toISOString();
    return this.record({
      observedAt: input.endedAt,
      metric: {
        kind: "sandbox-startup",
        identity: input.identity,
        profile: input.profile,
        ...(input.model ? { model: metricModel(input.model) } : {}),
        outcome: input.outcome,
        started_at: input.startedAt.toISOString(),
        ended_at: endedAt,
        duration_ms: elapsedMilliseconds(
          input.startedAt.toISOString(),
          endedAt,
        ),
        ...(input.outcome === "failure"
          ? { error_code: errorCode(input.error) }
          : {}),
      },
    });
  }

  recordLinkFailure(
    input: Parameters<SessionMetricRecorder["recordLinkFailure"]>[0],
  ): Promise<MetricObservation> {
    return this.record({
      observedAt: input.occurredAt,
      metric: {
        kind: "link-failure",
        identity: input.identity,
        operation: input.operation,
        error_code: errorCode(input.error),
      },
    });
  }

  recordMessageDelivery(input: {
    readonly identity: SessionIdentity;
    readonly message: string;
    readonly acknowledgement: "queued" | "duplicate";
    readonly messageCreatedAt: Date;
    readonly acknowledgedAt: Date;
  }): Promise<MetricObservation> {
    return this.record({
      observedAt: input.acknowledgedAt,
      metric: {
        kind: "message-delivery",
        identity: input.identity,
        message: input.message,
        acknowledgement: input.acknowledgement,
        message_created_at: input.messageCreatedAt.toISOString(),
        acknowledged_at: input.acknowledgedAt.toISOString(),
        latency_ms: Math.max(
          0,
          input.acknowledgedAt.getTime() - input.messageCreatedAt.getTime(),
        ),
      },
    });
  }

  recordContextPressure(input: {
    readonly identity: SessionIdentity;
    readonly pressure: z.input<typeof ContextPressureMetricSchema>;
    readonly observedAt: Date;
  }): Promise<MetricObservation> {
    return this.record({
      observedAt: input.observedAt,
      metric: {
        kind: "context-pressure",
        identity: input.identity,
        pressure: ContextPressureMetricSchema.parse(input.pressure),
      },
    });
  }

  recordHumanIntervention(input: {
    readonly action: HumanAction;
    readonly actor: string;
    readonly task?: string;
    readonly rationale?: string;
    readonly observedAt: Date;
  }): Promise<MetricObservation> {
    return this.record({
      observedAt: input.observedAt,
      metric: {
        kind: "human-intervention",
        action: input.action,
        actor: input.actor,
        ...(input.task ? { task: input.task } : {}),
        ...(input.rationale ? { rationale: input.rationale } : {}),
      },
    });
  }
}
