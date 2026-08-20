import { chmod, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Mailbox, MessageSchema } from "../src/message.js";
import { MetricStore } from "../src/metric.js";
import { createReport, ReportStore } from "../src/report.js";
import {
  collectRunMetrics,
  renderRunReport,
  RunReportStore,
} from "../src/summary.js";
import { createAppliedFixture, passFixtureChecks } from "./applied-fixture.js";
import { passFixtureReviews } from "./review-fixture.js";

describe("Run metrics and reports", () => {
  it("aggregates validated durable evidence into immutable JSON and Markdown", async () => {
    const fixture = await createAppliedFixture();
    try {
      const checks = await passFixtureChecks(fixture);
      const reviews = await passFixtureReviews(fixture);
      const run = await fixture.store.readRun(fixture.runId);
      const implementation = run.sessions["implementation-one"]!;
      const baseTime = new Date(
        Math.max(Date.now(), Date.parse(implementation.created_at)) + 60_000,
      );
      const at = (offsetMs: number) => new Date(baseTime.getTime() + offsetMs);
      const runDirectory = fixture.store.runDirectory(fixture.runId);
      const metrics = new MetricStore(runDirectory, fixture.runId);
      const mailbox = new Mailbox(runDirectory);
      const message = MessageSchema.parse({
        version: 2,
        id: "implementation-metric-request",
        run: fixture.runId,
        from: { host: true },
        to: {
          agent: implementation.identity.agent,
          session: implementation.identity.session,
          generation: implementation.identity.generation,
        },
        type: "implementation-request",
        priority: "normal",
        reply_to: null,
        body: { action: "measure" },
        references: ["src/fixture.ts"],
        created_at: at(0).toISOString(),
      });
      await mailbox.put(message);
      await metrics.recordMessageDelivery({
        identity: implementation.identity,
        message: message.id,
        acknowledgement: "queued",
        messageCreatedAt: at(0),
        acknowledgedAt: at(2_000),
      });
      await metrics.recordSandboxStartup({
        identity: implementation.identity,
        profile: "write",
        model: {
          profile: implementation.route.profile,
          route_digest: implementation.route.route_digest,
          pi_model: implementation.route.pi_model,
          locality: implementation.route.locality,
        },
        outcome: "success",
        startedAt: at(0),
        endedAt: at(3_000),
      });
      await metrics.recordModelTurn({
        identity: implementation.identity,
        task: fixture.task.id,
        model: {
          profile: implementation.route.profile,
          route_digest: implementation.route.route_digest,
          pi_model: implementation.route.pi_model,
          locality: implementation.route.locality,
          pricing: {
            currency: "USD",
            input_per_million: 1,
            output_per_million: 2,
            cache_read_per_million: 0,
            cache_write_per_million: 0,
          },
        },
        messageIds: [message.id],
        outcome: "success",
        startedAt: at(3_000),
        endedAt: at(8_000),
        usage: { input: 1_000, output: 100 },
      });
      await metrics.recordContextPressure({
        identity: implementation.identity,
        pressure: {
          tokens: 80_000,
          context_window: 100_000,
          fraction: 0.8,
          percent: 80,
          level: "handoff",
          mutating_phase_allowed: true,
        },
        observedAt: at(8_000),
      });
      await metrics.recordLinkFailure({
        identity: implementation.identity,
        operation: "reconnect",
        occurredAt: at(9_000),
        error: { code: "link_disconnected" },
      });
      await metrics.recordHumanIntervention({
        action: "scope-expansion",
        actor: "fixture",
        task: fixture.task.id,
        rationale: "Synthetic reporting evidence.",
        observedAt: at(10_000),
      });
      await new ReportStore(runDirectory).put(
        createReport({
          id: "consultation-metric",
          kind: "consultation",
          run: fixture.runId,
          agent: implementation.identity.agent,
          session: implementation.identity.session,
          generation: implementation.identity.generation,
          permission_ceiling_digest: implementation.permission_ceiling_digest,
          model_profile: implementation.route.profile,
          route_digest: implementation.route.route_digest,
          task: fixture.task.id,
          content: "# Conclusion\n\nSynthetic durable consultation evidence.\n",
          created_at: at(11_000).toISOString(),
        }),
      );

      const snapshot = await collectRunMetrics({
        store: fixture.store,
        runId: fixture.runId,
        now: at(20_000),
      });
      expect(snapshot).toMatchObject({
        run: { id: fixture.runId },
        checks: { total: checks.length, passed: checks.length, failed: 0 },
        reviews: {
          total: reviews.length,
          passed: reviews.length,
          blocking_findings: 0,
        },
        models: {
          turns: reviews.length + 1,
          priced_turns: 1,
          unpriced_turns: reviews.length,
          total_tokens: 1_400,
          estimated_cost_usd: 0.0012,
        },
        context: {
          observations: 1,
          highest_level: "handoff",
          peak_percent: 80,
        },
        sandboxes: { startups: 1, successful: 1, failed: 0 },
        links: { failures: 1 },
        messages: { total: reviews.length + 1, deliveries: 1 },
        reports: { total: 1, by_kind: { consultation: 1 } },
        human_interventions: {
          total: 2,
          by_action: { approval: 1, scope_expansion: 1 },
        },
      });
      expect(snapshot.models.by_locality.local.turns).toBe(1);
      expect(snapshot.models.by_locality.remote.turns).toBe(reviews.length);
      expect(snapshot.messages.delivery_latency.p95_ms).toBe(2_000);
      expect(snapshot.metrics_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const markdown = renderRunReport(snapshot);
      expect(markdown).toContain(`# Run Report: ${fixture.runId}`);
      expect(markdown).toContain("## Retrospective");
      expect(markdown).toContain("project-specific proving-run answers");

      const reports = new RunReportStore(runDirectory, fixture.runId);
      const first = await reports.publish(snapshot);
      expect(first.created).toBe(true);
      expect(first.markdown).toBe(markdown);
      expect(first.record.metrics_digest).toBe(snapshot.metrics_digest);
      const retry = await reports.publish(snapshot);
      expect(retry.created).toBe(false);
      expect(retry.record).toEqual(first.record);

      await chmod(first.markdownPath, 0o600);
      await writeFile(first.markdownPath, "tampered\n", "utf8");
      await expect(reports.get(first.record.id)).rejects.toMatchObject({
        code: "run_report_corrupt",
      });
    } finally {
      await fixture.dispose();
    }
  }, 15_000);

  it("rejects observations bound to a missing Session", async () => {
    const fixture = await createAppliedFixture();
    try {
      const metrics = new MetricStore(
        fixture.store.runDirectory(fixture.runId),
        fixture.runId,
      );
      await metrics.recordLinkFailure({
        identity: {
          run: fixture.runId,
          agent: "implementer",
          session: "missing-session",
          generation: 1,
        },
        operation: "connect",
        occurredAt: new Date(),
        error: { code: "link_connect_failed" },
      });
      await expect(
        collectRunMetrics({ store: fixture.store, runId: fixture.runId }),
      ).rejects.toMatchObject({ code: "metric_identity_stale" });
    } finally {
      await fixture.dispose();
    }
  });
});
