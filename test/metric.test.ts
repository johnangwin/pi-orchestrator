import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimateModelCost,
  MetricStore,
  normalizeModelUsage,
} from "../src/metric.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-metric-"));
  roots.push(root);
  return root;
}

const identity = {
  run: "run-one",
  seat: "implementer",
  session: "session-one",
  epoch: 1,
} as const;

describe("Metric observations", () => {
  it("normalizes provider usage and estimates only configured cost", () => {
    const usage = normalizeModelUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      total_tokens: 175,
    });
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_write_tokens: 5,
      total_tokens: 175,
      measured: ["input", "output", "cache-read", "cache-write", "total"],
    });
    expect(
      estimateModelCost(usage, {
        currency: "USD",
        input_per_million: 2,
        output_per_million: 4,
        cache_read_per_million: 0.5,
        cache_write_per_million: 3,
      }),
    ).toBe(0.000425);
    expect(
      estimateModelCost(normalizeModelUsage({ total_tokens: 20 }), {
        currency: "USD",
        input_per_million: 2,
        output_per_million: 4,
        cache_read_per_million: 0,
        cache_write_per_million: 0,
      }),
    ).toBeNull();
  });

  it("stores immutable, digest-validated observations idempotently", async () => {
    const root = await temporary();
    const store = new MetricStore(root, identity.run);
    const observedAt = new Date("2026-08-18T18:00:03.000Z");
    const first = await store.recordModelTurn({
      identity,
      task: "bounded-change",
      model: {
        alias: "code",
        pi_model: "local-code",
        locality: "local",
        pricing: {
          currency: "USD",
          input_per_million: 1,
          output_per_million: 2,
          cache_read_per_million: 0,
          cache_write_per_million: 0,
        },
      },
      messageIds: ["implementation-request"],
      outcome: "success",
      startedAt: new Date("2026-08-18T18:00:00.000Z"),
      endedAt: observedAt,
      usage: { input: 100, output: 25 },
    });
    await store.recordSandboxStartup({
      identity,
      profile: "write",
      model: {
        alias: "code",
        pi_model: "local-code",
        locality: "local",
      },
      outcome: "success",
      startedAt: new Date("2026-08-18T17:59:58.000Z"),
      endedAt: new Date("2026-08-18T18:00:00.000Z"),
    });
    await store.recordContextPressure({
      identity,
      pressure: {
        tokens: 75_000,
        context_window: 100_000,
        fraction: 0.75,
        percent: 75,
        level: "handoff",
        mutating_phase_allowed: true,
      },
      observedAt,
    });
    await store.recordLinkFailure({
      identity,
      operation: "reconnect",
      occurredAt: observedAt,
      error: { code: "link_disconnected" },
    });
    await store.recordHumanIntervention({
      action: "gate-waiver",
      actor: "fixture",
      task: "bounded-change",
      rationale: "Exercise the metric contract.",
      observedAt,
    });

    const retried = await store.recordModelTurn({
      identity,
      task: "bounded-change",
      model: {
        alias: "code",
        pi_model: "local-code",
        locality: "local",
        pricing: {
          currency: "USD",
          input_per_million: 1,
          output_per_million: 2,
          cache_read_per_million: 0,
          cache_write_per_million: 0,
        },
      },
      messageIds: ["implementation-request"],
      outcome: "success",
      startedAt: new Date("2026-08-18T18:00:00.000Z"),
      endedAt: observedAt,
      usage: { input: 100, output: 25 },
    });
    expect(retried).toEqual(first);
    expect(await store.list()).toHaveLength(5);

    const recordPath = path.join(store.directory, first.id, "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    record.record_digest = `sha256:${"0".repeat(64)}`;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    await expect(store.get(first.id)).rejects.toMatchObject({
      code: "metric_store_corrupt",
    });
  });

  it("rejects a negative measured duration", async () => {
    const store = new MetricStore(await temporary(), identity.run);
    await expect(
      store.recordSandboxStartup({
        identity,
        profile: "write",
        outcome: "failure",
        startedAt: new Date("2026-08-18T18:00:01.000Z"),
        endedAt: new Date("2026-08-18T18:00:00.000Z"),
        error: new Error("failed"),
      }),
    ).rejects.toThrow("must not precede started_at");
  });
});
