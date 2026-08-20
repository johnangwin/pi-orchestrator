import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CheckStore, type CheckRecord } from "./check.js";
import { CommitStore } from "./commit.js";
import {
  IdentifierSchema,
  ModelProfileSchema,
  type ModelProfile,
} from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { HandoffStore, type StoredHandoff } from "./handoff.js";
import { ModelLocalitySchema } from "./local.js";
import { Mailbox, messageLifecycles, type Message } from "./message.js";
import {
  estimateModelCost,
  MetricStore,
  normalizeModelUsage,
  type MetricObservation,
  type NormalizedUsage,
} from "./metric.js";
import { ReportStore } from "./report.js";
import { ReviewStore, type ReviewRecord } from "./review.js";
import { sameSessionIdentity, SessionStatusSchema } from "./session.js";
import {
  syncDirectory,
  writeJsonAtomic,
  type ProjectStore,
  type RunState,
} from "./state.js";
import { RunStatusSchema, TaskStatusSchema } from "./task.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MillisecondsSchema = CountSchema;
const CostSchema = z.number().finite().nonnegative();
const RunReportIdSchema = z.string().regex(/^run-report-[a-f0-9]{16}$/);

const DurationSummarySchema = z
  .object({
    count: CountSchema,
    total_ms: MillisecondsSchema,
    average_ms: MillisecondsSchema,
    p95_ms: MillisecondsSchema,
    max_ms: MillisecondsSchema,
  })
  .strict();

const TaskCountsSchema = z
  .object(
    Object.fromEntries(
      TaskStatusSchema.options.map((status) => [status, CountSchema]),
    ) as Record<(typeof TaskStatusSchema.options)[number], typeof CountSchema>,
  )
  .strict();

const SessionCountsSchema = z
  .object(
    Object.fromEntries(
      SessionStatusSchema.options.map((status) => [status, CountSchema]),
    ) as Record<
      (typeof SessionStatusSchema.options)[number],
      typeof CountSchema
    >,
  )
  .strict();

const MessageCountsSchema = z
  .object(
    Object.fromEntries(
      messageLifecycles.map((status) => [status, CountSchema]),
    ) as Record<(typeof messageLifecycles)[number], typeof CountSchema>,
  )
  .strict();

const ModelMetricSchema = z
  .object({
    turns: CountSchema,
    input_tokens: CountSchema,
    output_tokens: CountSchema,
    cache_read_tokens: CountSchema,
    cache_write_tokens: CountSchema,
    total_tokens: CountSchema,
    estimated_cost_usd: CostSchema,
  })
  .strict();

const LocalityMetricsSchema = z
  .object(
    Object.fromEntries(
      ModelLocalitySchema.options.map((locality) => [
        locality,
        ModelMetricSchema,
      ]),
    ) as Record<
      (typeof ModelLocalitySchema.options)[number],
      typeof ModelMetricSchema
    >,
  )
  .strict();

const ContextLevelCountsSchema = z
  .object({
    normal: CountSchema,
    warning: CountSchema,
    handoff: CountSchema,
    stop: CountSchema,
  })
  .strict();

const HandoffTriggerCountsSchema = z
  .object({
    manual: CountSchema,
    "context-pressure": CountSchema,
    recovery: CountSchema,
  })
  .strict();

const HumanActionCountsSchema = z
  .object({
    approval: CountSchema,
    commit: CountSchema,
    manual_handoff: CountSchema,
    scope_expansion: CountSchema,
    gate_waiver: CountSchema,
    security_policy_expansion: CountSchema,
    other: CountSchema,
  })
  .strict();

const RunMetricsContentSchema = z
  .object({
    version: z.literal(1),
    run: z
      .object({
        id: IdentifierSchema,
        project: IdentifierSchema,
        plan: IdentifierSchema,
        plan_revision: z.number().int().positive(),
        plan_digest: DigestSchema,
        base_commit: z.string().min(1),
        status: RunStatusSchema,
        started_at: TimestampSchema,
        ended_at: TimestampSchema.nullable(),
        as_of: TimestampSchema,
        wall_clock_ms: MillisecondsSchema,
        state_digest: DigestSchema,
      })
      .strict(),
    tasks: z
      .object({
        total: CountSchema,
        by_status: TaskCountsSchema,
        implementation_attempts: CountSchema,
        review_rounds: CountSchema,
      })
      .strict(),
    sessions: z
      .object({
        total: CountSchema,
        by_status: SessionCountsSchema,
        replacements: CountSchema,
        duration: DurationSummarySchema,
      })
      .strict(),
    models: z
      .object({
        turns: CountSchema,
        successful_turns: CountSchema,
        failed_turns: CountSchema,
        measured_turns: CountSchema,
        unmeasured_turns: CountSchema,
        priced_turns: CountSchema,
        unpriced_turns: CountSchema,
        input_tokens: CountSchema,
        output_tokens: CountSchema,
        cache_read_tokens: CountSchema,
        cache_write_tokens: CountSchema,
        total_tokens: CountSchema,
        estimated_cost_usd: CostSchema,
        by_profile: z.partialRecord(ModelProfileSchema, ModelMetricSchema),
        by_locality: LocalityMetricsSchema,
      })
      .strict(),
    context: z
      .object({
        observations: CountSchema,
        by_level: ContextLevelCountsSchema,
        highest_level: z
          .enum(["normal", "warning", "handoff", "stop"])
          .nullable(),
        peak_tokens: CountSchema,
        peak_fraction: z.number().finite().nonnegative(),
        peak_percent: z.number().finite().nonnegative(),
      })
      .strict(),
    sandboxes: z
      .object({
        startups: CountSchema,
        successful: CountSchema,
        failed: CountSchema,
        duration: DurationSummarySchema,
      })
      .strict(),
    links: z.object({ failures: CountSchema }).strict(),
    messages: z
      .object({
        total: CountSchema,
        by_lifecycle: MessageCountsSchema,
        deliveries: CountSchema,
        delivery_latency: DurationSummarySchema,
      })
      .strict(),
    checks: z
      .object({
        total: CountSchema,
        passed: CountSchema,
        failed: CountSchema,
        duration: DurationSummarySchema,
      })
      .strict(),
    reviews: z
      .object({
        total: CountSchema,
        passed: CountSchema,
        rework: CountSchema,
        blocked: CountSchema,
        blocking_findings: CountSchema,
        duration: DurationSummarySchema,
      })
      .strict(),
    handoffs: z
      .object({
        total: CountSchema,
        completed: CountSchema,
        pending: CountSchema,
        by_trigger: HandoffTriggerCountsSchema,
      })
      .strict(),
    reports: z
      .object({
        total: CountSchema,
        by_kind: z
          .object({
            implementation: CountSchema,
            consultation: CountSchema,
            review: CountSchema,
            handoff: CountSchema,
          })
          .strict(),
      })
      .strict(),
    human_interventions: z
      .object({
        total: CountSchema,
        by_action: HumanActionCountsSchema,
      })
      .strict(),
    evidence: z
      .object({
        observations: CountSchema,
        checks: CountSchema,
        reviews: CountSchema,
        handoffs: CountSchema,
        reports: CountSchema,
        commits: CountSchema,
        messages: CountSchema,
        approvals: CountSchema,
        digest: DigestSchema,
      })
      .strict(),
  })
  .strict();
type RunMetricsContent = z.infer<typeof RunMetricsContentSchema>;

export const RunMetricsSchema = RunMetricsContentSchema.extend({
  metrics_digest: DigestSchema,
}).strict();
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

interface ModelSample {
  readonly key: string;
  readonly profile: ModelProfile;
  readonly locality: (typeof ModelLocalitySchema.options)[number];
  readonly outcome: "success" | "failure";
  readonly usage: NormalizedUsage;
  readonly estimatedCostUsd: number | null;
}

type MetricsProjectStore = Pick<
  ProjectStore,
  "read" | "readRun" | "runDirectory"
>;

function elapsed(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function durationSummary(
  values: readonly number[],
): z.infer<typeof DurationSummarySchema> {
  if (values.length === 0) {
    return { count: 0, total_ms: 0, average_ms: 0, p95_ms: 0, max_ms: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return DurationSummarySchema.parse({
    count: sorted.length,
    total_ms: total,
    average_ms: Math.round(total / sorted.length),
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max_ms: sorted.at(-1),
  });
}

function enumCounts<const T extends readonly string[]>(
  values: T,
): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<
    T[number],
    number
  >;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function emptyModelMetric(): z.infer<typeof ModelMetricSchema> {
  return {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
}

function addModelSample(
  metric: z.infer<typeof ModelMetricSchema>,
  sample: ModelSample,
): void {
  metric.turns += 1;
  metric.input_tokens += sample.usage.input_tokens;
  metric.output_tokens += sample.usage.output_tokens;
  metric.cache_read_tokens += sample.usage.cache_read_tokens;
  metric.cache_write_tokens += sample.usage.cache_write_tokens;
  metric.total_tokens += sample.usage.total_tokens;
  metric.estimated_cost_usd = roundCost(
    metric.estimated_cost_usd + (sample.estimatedCostUsd ?? 0),
  );
}

function modelObservationSample(
  observation: MetricObservation,
): ModelSample | undefined {
  const metric = observation.metric;
  if (metric.kind !== "model-turn") return undefined;
  return {
    key: `${metric.identity.session}:${metric.message_ids.join(",")}`,
    profile: metric.model.profile,
    locality: metric.model.locality,
    outcome: metric.outcome,
    usage: metric.usage,
    estimatedCostUsd: metric.estimated_cost_usd,
  };
}

function reviewSample(review: ReviewRecord): ModelSample {
  const usage = normalizeModelUsage(review.turn.usage);
  return {
    key: `${review.identity.session}:${review.turn.message_id}`,
    profile: review.model.profile,
    locality: review.model.locality,
    outcome: "success",
    usage,
    estimatedCostUsd: estimateModelCost(usage, review.model.pricing),
  };
}

function metricDigest(content: RunMetricsContent): Digest {
  return digestParts("pi-orchestrator/run-metrics/v1", [
    ["metrics", canonicalJson(content)],
  ]);
}

function validateRunMetrics(value: unknown): RunMetrics {
  const metrics = RunMetricsSchema.parse(value);
  const { metrics_digest: _digest, ...content } = metrics;
  if (
    metrics.metrics_digest !==
    metricDigest(RunMetricsContentSchema.parse(content))
  ) {
    throw new OrchestratorError(
      "run_metrics_corrupt",
      `Run metrics for '${metrics.run.id}' have an invalid digest`,
    );
  }
  return metrics;
}

function evidenceDigest(input: {
  readonly runStateDigest: string;
  readonly observations: readonly MetricObservation[];
  readonly checks: readonly CheckRecord[];
  readonly reviews: readonly ReviewRecord[];
  readonly handoffs: readonly StoredHandoff[];
  readonly reports: readonly unknown[];
  readonly commits: readonly { readonly record_digest: string }[];
  readonly messages: readonly {
    readonly lifecycle: string;
    readonly message: Message;
  }[];
  readonly approval: unknown;
}): Digest {
  return digestParts("pi-orchestrator/run-metric-evidence/v1", [
    ["run-state", input.runStateDigest],
    [
      "observations",
      canonicalJson(
        input.observations.map((item) => item.record_digest).sort(),
      ),
    ],
    [
      "checks",
      canonicalJson(input.checks.map((item) => item.record_digest).sort()),
    ],
    [
      "reviews",
      canonicalJson(input.reviews.map((item) => item.record_digest).sort()),
    ],
    [
      "handoffs",
      canonicalJson(
        input.handoffs
          .map(
            (item) => item.result?.result_digest ?? item.intent.intent_digest,
          )
          .sort(),
      ),
    ],
    [
      "reports",
      canonicalJson(input.reports.map((item) => canonicalJson(item)).sort()),
    ],
    [
      "commits",
      canonicalJson(input.commits.map((item) => item.record_digest).sort()),
    ],
    [
      "messages",
      canonicalJson(input.messages.map((item) => canonicalJson(item)).sort()),
    ],
    ["approval", canonicalJson(input.approval)],
  ]);
}

function runEnd(run: RunState): string | null {
  return run.status === "complete" || run.status === "stopped"
    ? run.updated_at
    : null;
}

export async function collectRunMetrics(input: {
  readonly store: MetricsProjectStore;
  readonly runId: string;
  readonly now?: Date;
}): Promise<RunMetrics> {
  const runId = IdentifierSchema.parse(input.runId);
  const asOf = input.now ?? new Date();
  const [project, run] = await Promise.all([
    input.store.read(),
    input.store.readRun(runId),
  ]);
  if (run.project_id !== project.id) {
    throw new OrchestratorError(
      "run_project_conflict",
      `Run '${run.id}' belongs to Project '${run.project_id}', not '${project.id}'`,
    );
  }
  const runDirectory = input.store.runDirectory(run.id);
  const [observations, checks, reviews, handoffs, reports, commits, messages] =
    await Promise.all([
      new MetricStore(runDirectory, run.id).list(),
      new CheckStore(runDirectory).listResults(),
      new ReviewStore(runDirectory).listResults(),
      new HandoffStore(runDirectory).list(),
      new ReportStore(runDirectory).list(),
      new CommitStore(runDirectory).listResults(),
      new Mailbox(runDirectory).list(),
    ]);

  const messagesById = new Map(
    messages.map((stored) => [stored.message.id, stored.message]),
  );
  for (const observation of observations) {
    const metric = observation.metric;
    if ("identity" in metric) {
      const session = run.sessions[metric.identity.session];
      const observedModel =
        metric.kind === "model-turn"
          ? metric.model
          : metric.kind === "sandbox-startup"
            ? metric.model
            : undefined;
      if (
        !session ||
        !sameSessionIdentity(session.identity, metric.identity) ||
        (observedModel !== undefined &&
          (observedModel.profile !== session.route.profile ||
            observedModel.route_digest !== session.route.route_digest))
      ) {
        throw new OrchestratorError(
          "metric_identity_stale",
          `Metric observation '${observation.id}' does not match a durable Run Session`,
        );
      }
    }
    if ("task" in metric && metric.task && !run.tasks[metric.task]) {
      throw new OrchestratorError(
        "metric_task_unknown",
        `Metric observation '${observation.id}' references unknown Task '${metric.task}'`,
      );
    }
    if (metric.kind === "message-delivery") {
      const message = messagesById.get(metric.message);
      if (
        !message ||
        message.to.agent !== metric.identity.agent ||
        message.to.session !== metric.identity.session ||
        message.to.generation !== metric.identity.generation ||
        message.created_at !== metric.message_created_at
      ) {
        throw new OrchestratorError(
          "metric_message_mismatch",
          `Metric observation '${observation.id}' does not match its durable Message`,
        );
      }
    }
  }
  for (const check of checks) {
    if (check.run !== run.id || !run.tasks[check.task]) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Check '${check.id}' does not belong to Run '${run.id}'`,
      );
    }
  }
  for (const review of reviews) {
    const session = run.sessions[review.identity.session];
    if (
      review.run !== run.id ||
      !run.tasks[review.task] ||
      !session ||
      !sameSessionIdentity(session.identity, review.identity) ||
      review.model.profile !== session.route.profile ||
      review.model.route_digest !== session.route.route_digest
    ) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Review '${review.id}' does not belong to Run '${run.id}'`,
      );
    }
  }
  for (const handoff of handoffs) {
    const predecessor = run.sessions[handoff.intent.from.session];
    const successor = run.sessions[handoff.intent.to.session];
    if (
      handoff.intent.run !== run.id ||
      !predecessor ||
      !sameSessionIdentity(predecessor.identity, handoff.intent.from) ||
      handoff.intent.launch.model.profile !== predecessor.route.profile ||
      handoff.intent.launch.model.route_digest !==
        predecessor.route.route_digest ||
      (handoff.result !== undefined &&
        (!successor ||
          !sameSessionIdentity(successor.identity, handoff.intent.to) ||
          successor.route.route_digest !==
            handoff.intent.launch.model.route_digest))
    ) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Handoff '${handoff.intent.id}' does not belong to Run '${run.id}'`,
      );
    }
  }
  for (const report of reports) {
    const session = run.sessions[report.session];
    if (
      report.run !== run.id ||
      (report.task !== undefined && !run.tasks[report.task]) ||
      !session ||
      session.identity.agent !== report.agent ||
      session.identity.generation !== report.generation ||
      session.permission_ceiling_digest !== report.permission_ceiling_digest ||
      session.route.profile !== report.model_profile ||
      session.route.route_digest !== report.route_digest
    ) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Report '${report.id}' does not belong to Run '${run.id}'`,
      );
    }
  }
  for (const commit of commits) {
    if (commit.run !== run.id || !run.tasks[commit.task]) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Commit '${commit.id}' does not belong to Run '${run.id}'`,
      );
    }
  }
  for (const stored of messages) {
    if (stored.message.run !== run.id) {
      throw new OrchestratorError(
        "metric_evidence_mismatch",
        `Message '${stored.message.id}' does not belong to Run '${run.id}'`,
      );
    }
  }

  const stateDigest = digestParts("pi-orchestrator/run-state/v1", [
    ["state", canonicalJson(run)],
  ]);
  const taskCounts = enumCounts(TaskStatusSchema.options);
  let implementationAttempts = 0;
  let reviewRounds = 0;
  for (const task of Object.values(run.tasks)) {
    taskCounts[task.status] += 1;
    implementationAttempts += task.implementation_attempts;
    reviewRounds += task.review_rounds;
  }

  const sessionCounts = enumCounts(SessionStatusSchema.options);
  const sessionDurations: number[] = [];
  let replacements = 0;
  for (const session of Object.values(run.sessions)) {
    sessionCounts[session.status] += 1;
    if (session.replaces) replacements += 1;
    sessionDurations.push(
      elapsed(session.created_at, session.ended_at ?? asOf.toISOString()),
    );
  }

  const samples = new Map<string, ModelSample>();
  for (const observation of observations) {
    const sample = modelObservationSample(observation);
    if (sample) samples.set(sample.key, sample);
  }
  for (const review of reviews) {
    const sample = reviewSample(review);
    if (!samples.has(sample.key)) samples.set(sample.key, sample);
  }
  const byProfile: Record<string, z.infer<typeof ModelMetricSchema>> = {};
  const byLocality = Object.fromEntries(
    ModelLocalitySchema.options.map((locality) => [
      locality,
      emptyModelMetric(),
    ]),
  ) as z.infer<typeof LocalityMetricsSchema>;
  const modelTotals = emptyModelMetric();
  let successfulTurns = 0;
  let failedTurns = 0;
  let measuredTurns = 0;
  let pricedTurns = 0;
  for (const sample of samples.values()) {
    if (sample.outcome === "success") successfulTurns += 1;
    else failedTurns += 1;
    if (sample.usage.measured.length > 0) measuredTurns += 1;
    if (sample.estimatedCostUsd !== null) pricedTurns += 1;
    const profileMetric = (byProfile[sample.profile] ??= emptyModelMetric());
    addModelSample(profileMetric, sample);
    addModelSample(byLocality[sample.locality], sample);
    addModelSample(modelTotals, sample);
  }

  const contextCounts = enumCounts([
    "normal",
    "warning",
    "handoff",
    "stop",
  ] as const);
  const pressureByKey = new Map<
    string,
    {
      readonly tokens: number;
      readonly fraction: number;
      readonly percent: number;
      readonly level: keyof typeof contextCounts;
    }
  >();
  for (const observation of observations) {
    if (observation.metric.kind !== "context-pressure") continue;
    const metric = observation.metric;
    pressureByKey.set(
      `${metric.identity.session}:${metric.identity.generation}:${observation.observed_at}:${metric.pressure.tokens}`,
      metric.pressure,
    );
  }
  for (const handoff of handoffs) {
    if (!handoff.intent.pressure) continue;
    pressureByKey.set(
      `${handoff.intent.from.session}:${handoff.intent.from.generation}:${handoff.intent.created_at}:${handoff.intent.pressure.tokens}`,
      handoff.intent.pressure,
    );
  }
  const levelOrder = ["normal", "warning", "handoff", "stop"] as const;
  let highestLevel: (typeof levelOrder)[number] | null = null;
  let peakTokens = 0;
  let peakFraction = 0;
  let peakPercent = 0;
  for (const pressure of pressureByKey.values()) {
    contextCounts[pressure.level] += 1;
    if (
      highestLevel === null ||
      levelOrder.indexOf(pressure.level) > levelOrder.indexOf(highestLevel)
    ) {
      highestLevel = pressure.level;
    }
    peakTokens = Math.max(peakTokens, pressure.tokens);
    peakFraction = Math.max(peakFraction, pressure.fraction);
    peakPercent = Math.max(peakPercent, pressure.percent);
  }

  const sandboxMetrics = observations.filter(
    (observation) => observation.metric.kind === "sandbox-startup",
  );
  const sandboxDurations = sandboxMetrics.map(
    (observation) =>
      (
        observation.metric as Extract<
          MetricObservation["metric"],
          { kind: "sandbox-startup" }
        >
      ).duration_ms,
  );
  const linkFailures = observations.filter(
    (observation) => observation.metric.kind === "link-failure",
  ).length;
  const deliveryMetrics = observations.filter(
    (observation) => observation.metric.kind === "message-delivery",
  );
  const deliveryLatencies = deliveryMetrics.map(
    (observation) =>
      (
        observation.metric as Extract<
          MetricObservation["metric"],
          { kind: "message-delivery" }
        >
      ).latency_ms,
  );

  const messageCounts = enumCounts(messageLifecycles);
  for (const message of messages) messageCounts[message.lifecycle] += 1;
  const checkDurations = checks.map((check) =>
    elapsed(check.started_at, check.ended_at),
  );
  const reviewDurations = reviews.map((review) =>
    elapsed(review.started_at, review.ended_at),
  );
  const reviewVerdicts = { pass: 0, rework: 0, blocked: 0 };
  let blockingFindings = 0;
  for (const review of reviews) {
    reviewVerdicts[review.verdict] += 1;
    blockingFindings += review.assessment.blocking_findings.length;
  }

  const handoffTriggers = enumCounts([
    "manual",
    "context-pressure",
    "recovery",
  ] as const);
  for (const handoff of handoffs) handoffTriggers[handoff.intent.trigger] += 1;
  const reportKinds = {
    implementation: 0,
    consultation: 0,
    review: 0,
    handoff: 0,
  };
  for (const report of reports) reportKinds[report.kind] += 1;

  const humanActions = {
    approval: 0,
    commit: commits.length,
    manual_handoff: handoffTriggers.manual,
    scope_expansion: 0,
    gate_waiver: 0,
    security_policy_expansion: 0,
    other: 0,
  };
  const approval = project.approvals[run.plan_id];
  if (
    approval?.plan_revision === run.plan_revision &&
    approval.plan_digest === run.plan_digest &&
    approval.base_commit === run.base_commit
  ) {
    humanActions.approval = 1;
  }
  for (const observation of observations) {
    if (observation.metric.kind !== "human-intervention") continue;
    const action = observation.metric.action.replaceAll("-", "_") as
      "scope_expansion" | "gate_waiver" | "security_policy_expansion" | "other";
    humanActions[action] += 1;
  }

  const endedAt = runEnd(run);
  const evidence = {
    observations: observations.length,
    checks: checks.length,
    reviews: reviews.length,
    handoffs: handoffs.length,
    reports: reports.length,
    commits: commits.length,
    messages: messages.length,
    approvals: humanActions.approval,
    digest: evidenceDigest({
      runStateDigest: stateDigest,
      observations,
      checks,
      reviews,
      handoffs,
      reports,
      commits,
      messages,
      approval: approval ?? null,
    }),
  };
  const content = RunMetricsContentSchema.parse({
    version: 1,
    run: {
      id: run.id,
      project: run.project_id,
      plan: run.plan_id,
      plan_revision: run.plan_revision,
      plan_digest: run.plan_digest,
      base_commit: run.base_commit,
      status: run.status,
      started_at: run.created_at,
      ended_at: endedAt,
      as_of: asOf.toISOString(),
      wall_clock_ms: elapsed(run.created_at, endedAt ?? asOf.toISOString()),
      state_digest: stateDigest,
    },
    tasks: {
      total: Object.keys(run.tasks).length,
      by_status: taskCounts,
      implementation_attempts: implementationAttempts,
      review_rounds: reviewRounds,
    },
    sessions: {
      total: Object.keys(run.sessions).length,
      by_status: sessionCounts,
      replacements,
      duration: durationSummary(sessionDurations),
    },
    models: {
      turns: samples.size,
      successful_turns: successfulTurns,
      failed_turns: failedTurns,
      measured_turns: measuredTurns,
      unmeasured_turns: samples.size - measuredTurns,
      priced_turns: pricedTurns,
      unpriced_turns: samples.size - pricedTurns,
      input_tokens: modelTotals.input_tokens,
      output_tokens: modelTotals.output_tokens,
      cache_read_tokens: modelTotals.cache_read_tokens,
      cache_write_tokens: modelTotals.cache_write_tokens,
      total_tokens: modelTotals.total_tokens,
      estimated_cost_usd: modelTotals.estimated_cost_usd,
      by_profile: Object.fromEntries(
        Object.entries(byProfile).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      by_locality: byLocality,
    },
    context: {
      observations: pressureByKey.size,
      by_level: contextCounts,
      highest_level: highestLevel,
      peak_tokens: peakTokens,
      peak_fraction: peakFraction,
      peak_percent: peakPercent,
    },
    sandboxes: {
      startups: sandboxMetrics.length,
      successful: sandboxMetrics.filter(
        (observation) =>
          observation.metric.kind === "sandbox-startup" &&
          observation.metric.outcome === "success",
      ).length,
      failed: sandboxMetrics.filter(
        (observation) =>
          observation.metric.kind === "sandbox-startup" &&
          observation.metric.outcome === "failure",
      ).length,
      duration: durationSummary(sandboxDurations),
    },
    links: { failures: linkFailures },
    messages: {
      total: messages.length,
      by_lifecycle: messageCounts,
      deliveries: deliveryMetrics.length,
      delivery_latency: durationSummary(deliveryLatencies),
    },
    checks: {
      total: checks.length,
      passed: checks.filter((check) => check.verdict === "pass").length,
      failed: checks.filter((check) => check.verdict === "fail").length,
      duration: durationSummary(checkDurations),
    },
    reviews: {
      total: reviews.length,
      passed: reviewVerdicts.pass,
      rework: reviewVerdicts.rework,
      blocked: reviewVerdicts.blocked,
      blocking_findings: blockingFindings,
      duration: durationSummary(reviewDurations),
    },
    handoffs: {
      total: handoffs.length,
      completed: handoffs.filter((handoff) => handoff.result !== undefined)
        .length,
      pending: handoffs.filter((handoff) => handoff.result === undefined)
        .length,
      by_trigger: handoffTriggers,
    },
    reports: {
      total: reports.length,
      by_kind: reportKinds,
    },
    human_interventions: {
      total: Object.values(humanActions).reduce((sum, count) => sum + count, 0),
      by_action: humanActions,
    },
    evidence,
  });
  return RunMetricsSchema.parse({
    ...content,
    metrics_digest: metricDigest(content),
  });
}

function compactDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

function money(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 6 : 2)}`;
}

export function formatRunMetrics(metrics: RunMetrics): string {
  const parsed = validateRunMetrics(metrics);
  return [
    `Run ${parsed.run.id}: ${parsed.run.status}`,
    `  wall clock: ${compactDuration(parsed.run.wall_clock_ms)}`,
    `  Tasks: ${parsed.tasks.total} (${parsed.tasks.implementation_attempts} implementation attempts, ${parsed.tasks.review_rounds} Review rounds)`,
    `  Sessions: ${parsed.sessions.total} (${parsed.sessions.replacements} replacements)`,
    `  models: ${parsed.models.turns} turns, ${parsed.models.total_tokens} tokens, ${money(parsed.models.estimated_cost_usd)} known estimated cost (${parsed.models.unpriced_turns} unpriced)`,
    `  Checks: ${parsed.checks.passed} pass, ${parsed.checks.failed} fail`,
    `  Reviews: ${parsed.reviews.passed} pass, ${parsed.reviews.rework} rework, ${parsed.reviews.blocked} blocked (${parsed.reviews.blocking_findings} blocking findings)`,
    `  Handoffs: ${parsed.handoffs.completed} complete, ${parsed.handoffs.pending} pending`,
    `  Messages: ${parsed.messages.total} (${parsed.messages.deliveries} measured deliveries)`,
    `  human interventions: ${parsed.human_interventions.total}`,
    `  evidence: ${parsed.evidence.digest}`,
  ].join("\n");
}

export function renderRunReport(metrics: RunMetrics): string {
  const parsed = validateRunMetrics(metrics);
  const taskStates = Object.entries(parsed.tasks.by_status)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
  const locality = ModelLocalitySchema.options
    .map((name) => `${name}: ${parsed.models.by_locality[name].turns}`)
    .join(", ");
  return `# Run Report: ${parsed.run.id}

Generated: ${parsed.run.as_of}

## Identity

- Project: ${parsed.run.project}
- Plan: ${parsed.run.plan} revision ${parsed.run.plan_revision}
- Plan digest: ${parsed.run.plan_digest}
- Base commit: ${parsed.run.base_commit}
- Run status: ${parsed.run.status}
- Wall clock: ${compactDuration(parsed.run.wall_clock_ms)}

## Work

- Tasks: ${parsed.tasks.total} (${taskStates || "none"})
- Implementation attempts: ${parsed.tasks.implementation_attempts}
- Review rounds: ${parsed.tasks.review_rounds}
- Sessions: ${parsed.sessions.total}
- Session replacements: ${parsed.sessions.replacements}
- Handoffs: ${parsed.handoffs.completed} complete, ${parsed.handoffs.pending} pending

## Model Use

- Turns: ${parsed.models.turns} (${parsed.models.successful_turns} successful, ${parsed.models.failed_turns} failed)
- Tokens: ${parsed.models.total_tokens} total (${parsed.models.input_tokens} input, ${parsed.models.output_tokens} output, ${parsed.models.cache_read_tokens} cache read, ${parsed.models.cache_write_tokens} cache write)
- Locality: ${locality}
- Known estimated cost: ${money(parsed.models.estimated_cost_usd)}
- Pricing coverage: ${parsed.models.priced_turns} priced, ${parsed.models.unpriced_turns} unpriced

## Verification

- Checks: ${parsed.checks.passed} pass, ${parsed.checks.failed} fail
- Check duration: ${compactDuration(parsed.checks.duration.total_ms)} aggregate
- Reviews: ${parsed.reviews.passed} pass, ${parsed.reviews.rework} rework, ${parsed.reviews.blocked} blocked
- Blocking findings: ${parsed.reviews.blocking_findings}
- Review duration: ${compactDuration(parsed.reviews.duration.total_ms)} aggregate

## Reliability

- Sandbox startups: ${parsed.sandboxes.successful} successful, ${parsed.sandboxes.failed} failed
- Sandbox startup p95: ${compactDuration(parsed.sandboxes.duration.p95_ms)}
- Link failures: ${parsed.links.failures}
- Messages: ${parsed.messages.total}
- Measured Message deliveries: ${parsed.messages.deliveries}
- Message delivery p95: ${compactDuration(parsed.messages.delivery_latency.p95_ms)}
- Peak context: ${parsed.context.peak_percent.toFixed(1)}% (${parsed.context.highest_level ?? "unobserved"})

## Human Control

- Interventions: ${parsed.human_interventions.total}
- Plan approvals: ${parsed.human_interventions.by_action.approval}
- Task commits: ${parsed.human_interventions.by_action.commit}
- Manual Handoffs: ${parsed.human_interventions.by_action.manual_handoff}
- Gate waivers: ${parsed.human_interventions.by_action.gate_waiver}
- Scope expansions: ${parsed.human_interventions.by_action.scope_expansion}
- Security-policy expansions: ${parsed.human_interventions.by_action.security_policy_expansion}

## Evidence

- Run state: ${parsed.run.state_digest}
- Evidence set: ${parsed.evidence.digest}
- Metrics: ${parsed.metrics_digest}
- Observations: ${parsed.evidence.observations}
- Checks: ${parsed.evidence.checks}
- Reviews: ${parsed.evidence.reviews}
- Handoffs: ${parsed.evidence.handoffs}
- Reports: ${parsed.evidence.reports}
- Commits: ${parsed.evidence.commits}
- Messages: ${parsed.evidence.messages}
- Plan approvals: ${parsed.evidence.approvals}

## Retrospective

This report records reproducible measurements only. Human conclusions and project-specific proving-run answers have not been recorded.
`;
}

const RunReportMarkdownSchema = z
  .object({
    path: z.literal("report.md"),
    byte_count: CountSchema,
    content_digest: DigestSchema,
  })
  .strict();

const RunReportRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: RunReportIdSchema,
    run: IdentifierSchema,
    metrics: RunMetricsSchema,
    metrics_digest: DigestSchema,
    markdown: RunReportMarkdownSchema,
    generated_at: TimestampSchema,
  })
  .strict();

export const RunReportRecordSchema = RunReportRecordWithoutDigestSchema.extend({
  record_digest: DigestSchema,
}).strict();
export type RunReportRecord = z.infer<typeof RunReportRecordSchema>;

function runReportRecordDigest(
  content: z.infer<typeof RunReportRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/run-report/v1", [
    ["record", canonicalJson(content)],
  ]);
}

function createRunReportRecord(
  metrics: RunMetrics,
  markdown: string,
): RunReportRecord {
  const parsedMetrics = validateRunMetrics(metrics);
  const bytes = Buffer.from(markdown, "utf8");
  const content = RunReportRecordWithoutDigestSchema.parse({
    version: 1,
    id: `run-report-${parsedMetrics.metrics_digest.slice("sha256:".length, "sha256:".length + 16)}`,
    run: parsedMetrics.run.id,
    metrics: parsedMetrics,
    metrics_digest: parsedMetrics.metrics_digest,
    markdown: {
      path: "report.md",
      byte_count: bytes.byteLength,
      content_digest: sha256(bytes),
    },
    generated_at: parsedMetrics.run.as_of,
  });
  return RunReportRecordSchema.parse({
    ...content,
    record_digest: runReportRecordDigest(content),
  });
}

function validateRunReportRecord(value: unknown): RunReportRecord {
  const record = RunReportRecordSchema.parse(value);
  validateRunMetrics(record.metrics);
  const { record_digest: _digest, ...content } = record;
  const parsedContent = RunReportRecordWithoutDigestSchema.parse(content);
  const expectedId = `run-report-${record.metrics.metrics_digest.slice("sha256:".length, "sha256:".length + 16)}`;
  if (
    record.record_digest !== runReportRecordDigest(parsedContent) ||
    record.id !== expectedId ||
    record.run !== record.metrics.run.id ||
    record.metrics_digest !== record.metrics.metrics_digest ||
    record.generated_at !== record.metrics.run.as_of
  ) {
    throw new OrchestratorError(
      "run_report_corrupt",
      `Run report '${record.id}' has an invalid binding`,
    );
  }
  return record;
}

async function writeDurableMarkdown(
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

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

export interface PublishedRunReport {
  readonly record: RunReportRecord;
  readonly markdown: string;
  readonly created: boolean;
  readonly directory: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export class RunReportStore {
  readonly directory: string;
  readonly runId: string;

  constructor(runDirectory: string, runId: string) {
    this.directory = path.join(
      path.resolve(runDirectory),
      "metrics",
      "reports",
    );
    this.runId = IdentifierSchema.parse(runId);
  }

  private reportDirectory(id: string): string {
    return path.join(this.directory, RunReportIdSchema.parse(id));
  }

  async get(id: string): Promise<PublishedRunReport | undefined> {
    const parsedId = RunReportIdSchema.parse(id);
    const directory = this.reportDirectory(parsedId);
    try {
      const record = validateRunReportRecord(
        JSON.parse(
          await readFile(path.join(directory, "report.json"), "utf8"),
        ) as unknown,
      );
      const markdown = await readFile(
        path.join(directory, record.markdown.path),
        "utf8",
      );
      const bytes = Buffer.from(markdown, "utf8");
      if (
        record.id !== parsedId ||
        record.run !== this.runId ||
        bytes.byteLength !== record.markdown.byte_count ||
        sha256(bytes) !== record.markdown.content_digest ||
        renderRunReport(record.metrics) !== markdown
      ) {
        throw new OrchestratorError(
          "run_report_corrupt",
          `Run report '${parsedId}' has invalid Markdown or identity`,
        );
      }
      return {
        record,
        markdown,
        created: false,
        directory,
        jsonPath: path.join(directory, "report.json"),
        markdownPath: path.join(directory, record.markdown.path),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(
        "run_report_corrupt",
        `Invalid Run report at ${directory}`,
        { cause: error },
      );
    }
  }

  async publish(requested: RunMetrics): Promise<PublishedRunReport> {
    const metrics = validateRunMetrics(requested);
    if (metrics.run.id !== this.runId) {
      throw new OrchestratorError(
        "run_report_conflict",
        `Metrics belong to Run '${metrics.run.id}', not '${this.runId}'`,
      );
    }
    const markdown = renderRunReport(metrics);
    const record = createRunReportRecord(metrics, markdown);
    const existing = await this.get(record.id);
    if (existing) {
      if (
        canonicalJson(existing.record) !== canonicalJson(record) ||
        existing.markdown !== markdown
      ) {
        throw new OrchestratorError(
          "run_report_conflict",
          `Run report '${record.id}' already has other content`,
        );
      }
      return existing;
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(this.directory, `.${record.id}-`));
    try {
      const jsonPath = path.join(staging, "report.json");
      const markdownPath = path.join(staging, record.markdown.path);
      await writeJsonAtomic(jsonPath, record);
      await writeDurableMarkdown(markdownPath, markdown);
      await Promise.all([chmod(jsonPath, 0o400), chmod(markdownPath, 0o400)]);
      try {
        const directory = this.reportDirectory(record.id);
        await rename(staging, directory);
        await syncDirectory(this.directory);
        return {
          record,
          markdown,
          created: true,
          directory,
          jsonPath: path.join(directory, "report.json"),
          markdownPath: path.join(directory, record.markdown.path),
        };
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.get(record.id);
        if (
          !raced ||
          canonicalJson(raced.record) !== canonicalJson(record) ||
          raced.markdown !== markdown
        ) {
          throw new OrchestratorError(
            "run_report_conflict",
            `Run report '${record.id}' raced with other content`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
