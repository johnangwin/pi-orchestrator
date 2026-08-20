import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { sha256 } from "../src/digest.js";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import type { Message } from "../src/message.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import { loadSandboxPolicy } from "../src/policy.js";
import {
  ReviewStore,
  parseReviewAssessment,
  runRequiredReviews,
  runReview,
  type ReviewAssessment,
  type ReviewSession,
  type ReviewSessionLauncher,
} from "../src/review.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type ReadSessionOpenShell,
  type StartReadSessionOptions,
} from "../src/agent.js";
import { fixtureTask } from "./fixture.js";
import {
  createAppliedFixture,
  passFixtureChecks,
  type AppliedFixture,
} from "./applied-fixture.js";

const fixtures: AppliedFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function localConfig(): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    openshell: {
      command: "openshell",
      required_version: "0.0.106",
      workspace: "default",
      gateways: {
        review: "review-gateway",
        quant: "quant-gateway",
      },
    },
    models: {
      review: {
        gateway: "review",
        pi_model: "fixture-reviewer",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 131_072,
        max_tokens: 16_384,
        reasoning: true,
      },
      quant: {
        gateway: "quant",
        pi_model: "fixture-quant",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 131_072,
        max_tokens: 16_384,
        reasoning: true,
      },
    },
  });
}

function preflight(gateway = "review-gateway"): OpenShellPreflight {
  return {
    command: "openshell",
    requiredVersion: "0.0.106",
    installedVersion: "0.0.106",
    versionMatches: true,
    status: {
      authentication: { provider: "fixture", status: "authenticated" },
      gateway,
      server: "https://openshell.example.test",
      status: "connected",
      version: "0.0.106",
    },
  };
}

function reviewClient(
  gateway = "review-gateway",
  onDelete?: (sandbox: string) => void,
): ReadSessionOpenShell {
  const unused = (): never => {
    throw new Error("The fake Review launcher owns this operation");
  };
  return {
    preflight: () => Promise.resolve(preflight(gateway)),
    getInferenceRoute: () =>
      Promise.resolve({
        provider: "fixture",
        model:
          gateway === "quant-gateway" ? "fixture-quant" : "fixture-reviewer",
      }),
    createSandbox: async () => unused(),
    waitForSandbox: async () => unused(),
    execSandbox: async (): Promise<ProcessResult> => unused(),
    startServiceForward: async (): Promise<OpenShellForward> => unused(),
    deleteSandbox: async (sandbox) => {
      if (!onDelete) return unused();
      onDelete(sandbox);
    },
  };
}

const passingAssessment: ReviewAssessment = {
  verdict: "pass",
  conclusion: "The bounded change satisfies this Lens.",
  blocking_findings: [],
  improvements: [],
  evidence: ["The exact changed source and passing Check were inspected."],
  uncertainty: [],
};

function failingAssessment(
  verdict: "rework" | "blocked" = "rework",
): ReviewAssessment {
  return {
    verdict,
    conclusion: "The change cannot pass this Lens.",
    blocking_findings: [
      {
        location: "src/fixture.ts:1",
        failure_scenario: "The exported contract has the wrong value.",
        evidence: "The exact Patch changes the value without coverage.",
        required_correction: "Restore the required value and add coverage.",
      },
    ],
    improvements: [],
    evidence: ["The changed source was inspected."],
    uncertainty: [],
  };
}

class FakeReviewRuntime {
  readonly launches: StartReadSessionOptions[] = [];
  readonly messages: Message[] = [];
  readonly briefs: string[] = [];
  readonly sourceDigests: string[] = [];
  readonly sandboxIds: string[] = [];
  stopCalls = 0;
  responses: string[] = [JSON.stringify(passingAssessment)];
  onRun: (() => void | Promise<void>) | undefined;

  readonly launch: ReviewSessionLauncher = async (options) => {
    const index = this.launches.length + 1;
    this.launches.push(options);
    if (!options.workspaceSource || !options.model || !options.brief) {
      throw new Error(
        "Review Session is missing frozen source, model, or Brief",
      );
    }
    await readFile(options.workspaceSource.archivePath);
    this.briefs.push(options.brief.content);
    this.sourceDigests.push(options.workspaceSource.sourceDigest);
    const id = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
    this.sandboxIds.push(id);
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-18 17:00:00",
      current_policy_version: 1,
      id,
      labels: {},
      name: `pio-review-${index}`,
      phase: "Ready",
      resource_version: 1,
      workspace: "reviews",
    };
    const policy = await loadSandboxPolicy(
      "read",
      path.join(options.policyDirectory!, "read.yaml"),
    );
    const model = options.model;
    const inputs = (options.inputs ?? []).map((input) => ({
      path: `/workspace/input/${input.name}`,
      byte_count:
        typeof input.content === "string"
          ? Buffer.byteLength(input.content, "utf8")
          : input.content.byteLength,
      digest: input.digest,
    }));
    const info = {
      sandbox,
      permissionCeiling: options.permissionCeiling,
      identity: options.identity,
      sourceDigest: options.workspaceSource.sourceDigest,
      profile: "read" as const,
      policyDigest: policy.digest,
      readPolicyDigest: policy.digest,
      openshell: preflight(model.gateway),
      piVersion: PI_RUNTIME_VERSION,
      clientVersion: PI_CLIENT_VERSION,
      model,
      inference: { provider: "fixture", model: model.pi_model },
      briefDigest: options.brief.digest,
      inputs,
    };
    const session: ReviewSession = {
      info,
      run: async (message) => {
        this.messages.push(message);
        await this.onRun?.();
        const text = this.responses.shift();
        if (text === undefined) throw new Error("No fake Review response");
        return {
          message_ids: [message.id],
          model_alias: model.alias,
          requested_model: model.pi_model,
          response_model: model.pi_model,
          stop_reason: "stop",
          text,
          truncated: false,
          usage: { input: 100, output: 50 },
        };
      },
      stop: async () => {
        this.stopCalls += 1;
      },
    };
    return session;
  };
}

async function checked(task = fixtureTask()): Promise<AppliedFixture> {
  const fixture = await createAppliedFixture({ task });
  fixtures.push(fixture);
  await passFixtureChecks(fixture);
  return fixture;
}

function execute(
  fixture: AppliedFixture,
  runtime: FakeReviewRuntime,
  options: {
    readonly lens?: "spec" | "architecture" | "quality" | "quant";
    readonly gateway?: string;
    readonly nonce?: () => string;
    readonly client?: ReadSessionOpenShell;
  } = {},
) {
  return runReview({
    store: fixture.store,
    project: fixture.project,
    plan: fixture.plan,
    runId: fixture.runId,
    taskId: fixture.task.id,
    lens: options.lens ?? "spec",
    local: localConfig(),
    client: options.client ?? reviewClient(options.gateway),
    launchSession: runtime.launch,
    nonce: options.nonce ?? (() => "12345678"),
    now: () => new Date("2026-08-18T17:00:00.000Z"),
  });
}

function executeRequired(
  fixture: AppliedFixture,
  runtime: FakeReviewRuntime,
  options: {
    readonly clients?: Partial<
      Record<
        "spec" | "architecture" | "quality" | "quant",
        ReadSessionOpenShell
      >
    >;
    readonly nonce?: (
      lens: "spec" | "architecture" | "quality" | "quant",
    ) => string;
  } = {},
) {
  return runRequiredReviews({
    store: fixture.store,
    project: fixture.project,
    plan: fixture.plan,
    runId: fixture.runId,
    taskId: fixture.task.id,
    local: localConfig(),
    clients: options.clients ?? {
      spec: reviewClient(),
      architecture: reviewClient(),
      quality: reviewClient(),
      quant: reviewClient("quant-gateway"),
    },
    launchSession: runtime.launch,
    nonce: options.nonce ?? (() => "12345678"),
    now: () => new Date("2026-08-18T17:00:00.000Z"),
  });
}

describe("authoritative Reviews", { timeout: 15_000 }, () => {
  it("runs a fresh read-only Review and reuses exact immutable evidence", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    const first = await execute(fixture, runtime);

    expect(first).toMatchObject({
      reused: false,
      record: {
        lens: "spec",
        verdict: "pass",
        plan_digest: fixture.plan.digest,
        model: {
          alias: "review",
          gateway: "review-gateway",
          pi_model: "fixture-reviewer",
        },
        openshell: {
          cli_version: "0.0.106",
          gateway: "review-gateway",
          gateway_version: "0.0.106",
        },
      },
      task: { status: "reviewing", review_rounds: 1 },
    });
    expect(first.task.gates["review-spec"]).toEqual({
      status: "pass",
      digest: first.record.record_digest,
      updated_at: "2026-08-18T17:00:00.000Z",
    });
    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]).toMatchObject({
      identity: first.record.identity,
      workspaceSource: {
        sourceDigest: first.record.source_digest,
      },
    });
    expect(runtime.briefs[0]).toContain("Lens: spec");
    expect(runtime.briefs[0]).toContain("Current diff:");
    expect(runtime.launches[0]?.inputs).toMatchObject([
      {
        name: "review.patch",
        digest: sha256(fixture.patch.value.patch),
      },
    ]);
    expect(runtime.briefs[0]).toContain('"check":"project-test"');
    expect(runtime.briefs[0]).toContain("## Dependency Reports\n\nNone.");
    expect(runtime.messages[0]?.to).toEqual({
      agent: "review-spec",
      session: first.record.identity.session,
      generation: 1,
    });
    expect(runtime.stopCalls).toBe(1);

    const mailbox = await import("../src/message.js").then(({ Mailbox }) =>
      new Mailbox(fixture.store.runDirectory(fixture.runId)).find(
        runtime.messages[0]!.id,
      ),
    );
    expect(mailbox?.lifecycle).toBe("answered");
    const session = (await fixture.store.readRun(fixture.runId)).sessions[
      first.record.identity.session
    ];
    expect(session).toMatchObject({
      status: "stopped",
      sandbox: first.record.sandbox,
      termination_reason: "Independent Review completed",
    });

    const reportPath = path.join(
      fixture.store.runDirectory(fixture.runId),
      "reviews",
      fixture.task.id,
      "spec",
      first.record.id,
      "result",
      "report.md",
    );
    expect(await readFile(reportPath, "utf8")).toContain("# Conclusion");

    const reused = await execute(fixture, runtime);
    expect(reused.reused).toBe(true);
    expect(reused.record).toEqual(first.record);
    expect(runtime.launches).toHaveLength(1);
  });

  it("keeps Lens Reviews independent and never includes prior findings", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    runtime.responses = [
      JSON.stringify({
        ...passingAssessment,
        conclusion: "SPEC-PRIVATE-FINDING-MARKER",
      }),
      JSON.stringify(passingAssessment),
    ];
    const nonces = ["11111111", "22222222"];

    const spec = await execute(fixture, runtime, {
      lens: "spec",
      nonce: () => nonces.shift()!,
    });
    const quality = await execute(fixture, runtime, {
      lens: "quality",
      nonce: () => nonces.shift()!,
    });

    expect(spec.record.identity.session).not.toBe(
      quality.record.identity.session,
    );
    expect(spec.record.sandbox.id).not.toBe(quality.record.sandbox.id);
    expect(runtime.briefs[1]).toContain("Lens: quality");
    expect(runtime.briefs[1]).not.toContain("SPEC-PRIVATE-FINDING-MARKER");
    expect(quality.task.gates["review-spec"]?.status).toBe("pass");
    expect(quality.task.gates["review-quality"]?.status).toBe("pass");
    expect(quality.task.review_rounds).toBe(1);
  });

  it("recovers a published result whose pending Gate update was interrupted", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    const first = await execute(fixture, runtime);
    await fixture.store.updateRun(fixture.runId, (run) => ({
      ...run,
      tasks: {
        ...run.tasks,
        [fixture.task.id]: {
          ...run.tasks[fixture.task.id]!,
          status: "reviewing",
          gates: {
            ...run.tasks[fixture.task.id]!.gates,
            "review-spec": {
              status: "pending",
              digest: first.intent.binding_digest,
              updated_at: "2026-08-18T17:00:00.000Z",
            },
          },
        },
      },
    }));

    const recovered = await execute(fixture, runtime);
    expect(recovered.reused).toBe(true);
    expect(recovered.record).toEqual(first.record);
    expect(recovered.task.gates["review-spec"]).toMatchObject({
      status: "pass",
      digest: first.record.record_digest,
    });
    expect(runtime.launches).toHaveLength(1);
  });

  it("stops a still-active Review Session while recovering durable evidence", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    const first = await execute(fixture, runtime);
    await fixture.store.updateRun(fixture.runId, (run) => ({
      ...run,
      sessions: {
        ...run.sessions,
        [first.record.identity.session]: {
          ...run.sessions[first.record.identity.session]!,
          status: "active",
          termination_reason: null,
          ended_at: null,
        },
      },
      tasks: {
        ...run.tasks,
        [fixture.task.id]: {
          ...run.tasks[fixture.task.id]!,
          status: "reviewing",
          gates: {
            ...run.tasks[fixture.task.id]!.gates,
            "review-spec": {
              status: "pending",
              digest: first.intent.binding_digest,
              updated_at: "2026-08-18T17:00:00.000Z",
            },
          },
        },
      },
    }));
    const deleted: string[] = [];

    const recovered = await execute(fixture, runtime, {
      client: reviewClient("review-gateway", (sandbox) =>
        deleted.push(sandbox),
      ),
    });

    expect(recovered.reused).toBe(true);
    expect(deleted).toEqual([first.record.sandbox.name]);
    expect(
      (await fixture.store.readRun(fixture.runId)).sessions[
        first.record.identity.session
      ],
    ).toMatchObject({
      status: "stopped",
      termination_reason: "Independent Review recovered from durable evidence",
    });
  });

  it("maps rework and blocked verdicts to authoritative Task states", async () => {
    const reworkFixture = await checked();
    const reworkRuntime = new FakeReviewRuntime();
    reworkRuntime.responses = [JSON.stringify(failingAssessment("rework"))];
    const rework = await execute(reworkFixture, reworkRuntime);
    expect(rework.record.verdict).toBe("rework");
    expect(rework.task.status).toBe("rework");
    expect(rework.task.gates["review-spec"]?.status).toBe("fail");

    const blockedFixture = await checked();
    const blockedRuntime = new FakeReviewRuntime();
    blockedRuntime.responses = [JSON.stringify(failingAssessment("blocked"))];
    const blocked = await execute(blockedFixture, blockedRuntime);
    expect(blocked.record.verdict).toBe("blocked");
    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.gates["review-spec"]?.status).toBe("fail");
  });

  it("expires invalid output and retries in a fresh Session without a new round", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    runtime.responses = ["not JSON", JSON.stringify(passingAssessment)];
    const nonces = ["11111111", "22222222"];

    await expect(
      execute(fixture, runtime, { nonce: () => nonces.shift()! }),
    ).rejects.toMatchObject({ code: "invalid_review_output" });
    const failed = await fixture.store.readRun(fixture.runId);
    expect(failed.tasks[fixture.task.id]).toMatchObject({
      status: "reviewing",
      review_rounds: 1,
      gates: { "review-spec": { status: "pending" } },
    });
    expect(failed.sessions["review-spec-11111111"]?.status).toBe("failed");

    const passed = await execute(fixture, runtime, {
      nonce: () => nonces.shift()!,
    });
    expect(passed.record.identity).toMatchObject({
      agent: "review-spec",
      session: "review-spec-22222222",
      generation: 2,
    });
    expect(passed.task.review_rounds).toBe(1);
    expect(runtime.launches).toHaveLength(2);
    expect(runtime.stopCalls).toBe(2);
  });

  it("rejects Check evidence changed during a model turn", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    runtime.onRun = async () => {
      await fixture.store.updateRun(fixture.runId, (run) => ({
        ...run,
        tasks: {
          ...run.tasks,
          [fixture.task.id]: {
            ...run.tasks[fixture.task.id]!,
            gates: {
              ...run.tasks[fixture.task.id]!.gates,
              "check-project-test": {
                status: "pass",
                digest: sha256("different Check evidence"),
                updated_at: "2026-08-18T17:00:00.000Z",
              },
            },
          },
        },
      }));
    };

    await expect(execute(fixture, runtime)).rejects.toMatchObject({
      code: "review_check_stale",
    });
    expect(runtime.stopCalls).toBe(1);
    expect(
      (await fixture.store.readRun(fixture.runId)).sessions[
        "review-spec-12345678"
      ]?.status,
    ).toBe("failed");
  });

  it("rejects a registered Check definition changed during inference", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    runtime.onRun = async () => {
      const configPath = path.join(
        fixture.root,
        ".agents",
        "orchestrator.yaml",
      );
      const config = parse(await readFile(configPath, "utf8")) as {
        checks: Record<string, { argv: string[] }>;
      };
      config.checks["project-test"] = { argv: ["node", "--version"] };
      await writeFile(configPath, stringify(config), "utf8");
    };

    await expect(execute(fixture, runtime)).rejects.toMatchObject({
      code: "review_check_stale",
    });
    expect(runtime.stopCalls).toBe(1);
  });

  it("rejects Project instructions changed during inference", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    runtime.onRun = () =>
      writeFile(
        path.join(fixture.root, "AGENTS.md"),
        "# Changed Project Instructions\n",
        "utf8",
      );

    await expect(execute(fixture, runtime)).rejects.toMatchObject({
      code: "review_stale",
    });
    expect(runtime.stopCalls).toBe(1);
  });

  it("rejects previously passing evidence after host worktree drift", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    await execute(fixture, runtime);
    await writeFile(
      path.join(fixture.worktree, "src", "fixture.ts"),
      "export const fixture = 'drifted';\n",
      "utf8",
    );

    await expect(execute(fixture, runtime)).rejects.toMatchObject({
      code: "review_stale",
    });
    expect(runtime.launches).toHaveLength(1);
  });

  it("routes the Quant Lens through the configured Quant gateway", async () => {
    const fixture = await checked(fixtureTask({ reviews: ["quant"] }));
    const runtime = new FakeReviewRuntime();

    const result = await execute(fixture, runtime, {
      lens: "quant",
      gateway: "quant-gateway",
    });
    expect(result.record.model).toMatchObject({
      alias: "quant",
      gateway: "quant-gateway",
      pi_model: "fixture-quant",
    });
    expect(result.record.identity.agent).toBe("review-quant");
    expect(runtime.briefs[0]).toContain("Lens: quant");
  });

  it("fails before Session launch when Checks are incomplete or the Lens is absent", async () => {
    const unchecked = await createAppliedFixture();
    fixtures.push(unchecked);
    const runtime = new FakeReviewRuntime();
    await expect(execute(unchecked, runtime)).rejects.toMatchObject({
      code: "review_checks_incomplete",
    });
    expect(runtime.launches).toHaveLength(0);

    const checkedFixture = await checked();
    await expect(
      execute(checkedFixture, runtime, { lens: "architecture" }),
    ).rejects.toMatchObject({ code: "review_not_required" });
    expect(runtime.launches).toHaveLength(0);
  });

  it("detects tampered durable Review reports", async () => {
    const fixture = await checked();
    const runtime = new FakeReviewRuntime();
    const result = await execute(fixture, runtime);
    const reportPath = path.join(
      fixture.store.runDirectory(fixture.runId),
      "reviews",
      fixture.task.id,
      "spec",
      result.record.id,
      "result",
      "report.md",
    );
    await chmod(reportPath, 0o600);
    await writeFile(reportPath, "tampered\n", "utf8");

    const reviews = new ReviewStore(fixture.store.runDirectory(fixture.runId));
    await expect(
      reviews.getResult(fixture.task.id, "spec", result.record.id),
    ).rejects.toMatchObject({ code: "review_store_corrupt" });
  });

  it("runs every required Lens independently and reuses the complete set", async () => {
    const fixture = await checked(
      fixtureTask({
        reviews: ["spec", "architecture", "quality", "quant"],
      }),
    );
    const runtime = new FakeReviewRuntime();
    runtime.responses = [
      JSON.stringify({
        ...passingAssessment,
        conclusion: "SPEC-PRIVATE-RESULT",
      }),
      JSON.stringify({
        ...passingAssessment,
        conclusion: "ARCHITECTURE-PRIVATE-RESULT",
      }),
      JSON.stringify({
        ...passingAssessment,
        conclusion: "QUALITY-PRIVATE-RESULT",
      }),
      JSON.stringify({
        ...passingAssessment,
        conclusion: "QUANT-PRIVATE-RESULT",
      }),
    ];

    const first = await executeRequired(fixture, runtime);

    expect(first.verdict).toBe("pass");
    expect(first.required).toEqual([
      "spec",
      "architecture",
      "quality",
      "quant",
    ]);
    expect(first.reviews.map((review) => review.record.lens)).toEqual(
      first.required,
    );
    expect(first.reviews.map((review) => review.record.model.alias)).toEqual([
      "review",
      "review",
      "review",
      "quant",
    ]);
    expect(
      new Set(first.reviews.map((review) => review.record.identity.session))
        .size,
    ).toBe(4);
    expect(new Set(runtime.sandboxIds).size).toBe(4);
    expect(first.reviews.every((review) => review.record.round === 1)).toBe(
      true,
    );
    expect(first.task).toMatchObject({ status: "reviewing", review_rounds: 1 });
    expect(
      first.required.map((lens) => first.task.gates[`review-${lens}`]?.status),
    ).toEqual(["pass", "pass", "pass", "pass"]);
    expect(runtime.briefs[1]).not.toContain("SPEC-PRIVATE-RESULT");
    expect(runtime.briefs[2]).not.toContain("ARCHITECTURE-PRIVATE-RESULT");
    expect(runtime.briefs[3]).not.toContain("QUALITY-PRIVATE-RESULT");
    expect(runtime.briefs[0]).toContain(
      "Does the implementation satisfy the approved Task",
    );
    expect(runtime.briefs[1]).toContain(
      "consistent with the Project's current architecture",
    );
    expect(runtime.briefs[2]).toContain(
      "correct, maintainable, secure, and adequately tested",
    );
    expect(runtime.briefs[3]).toContain(
      "Independently reproduce material quantities",
    );
    expect(runtime.briefs[3]).toContain("## Skill: quant");

    const reused = await executeRequired(fixture, runtime);
    expect(reused.verdict).toBe("pass");
    expect(reused.reviews.every((review) => review.reused)).toBe(true);
    expect(runtime.launches).toHaveLength(4);
  });

  it("reuses passed Lenses and retries only the failed Session generation", async () => {
    const fixture = await checked(
      fixtureTask({ reviews: ["spec", "architecture", "quality"] }),
    );
    const runtime = new FakeReviewRuntime();
    runtime.responses = [JSON.stringify(passingAssessment), "not JSON"];
    const firstNonces = ["11111111", "22222222"];

    await expect(
      executeRequired(fixture, runtime, {
        nonce: () => firstNonces.shift()!,
      }),
    ).rejects.toMatchObject({ code: "invalid_review_output" });
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id],
    ).toMatchObject({
      status: "reviewing",
      review_rounds: 1,
      gates: {
        "review-spec": { status: "pass" },
        "review-architecture": { status: "pending" },
      },
    });

    runtime.responses = [
      JSON.stringify(passingAssessment),
      JSON.stringify(passingAssessment),
    ];
    const retryNonces = ["33333333", "44444444"];
    const retry = await executeRequired(fixture, runtime, {
      nonce: () => retryNonces.shift()!,
    });

    expect(retry.verdict).toBe("pass");
    expect(retry.reviews.map((review) => review.reused)).toEqual([
      true,
      false,
      false,
    ]);
    expect(retry.reviews[1]?.record.identity).toMatchObject({
      agent: "review-architecture",
      session: "review-architecture-33333333",
      generation: 2,
    });
    expect(retry.task.review_rounds).toBe(1);
    expect(runtime.launches).toHaveLength(4);
  });

  it("halts the required set on a non-passing verdict", async () => {
    const fixture = await checked(
      fixtureTask({ reviews: ["spec", "architecture", "quality"] }),
    );
    const runtime = new FakeReviewRuntime();
    runtime.responses = [
      JSON.stringify(passingAssessment),
      JSON.stringify(failingAssessment("rework")),
    ];

    const result = await executeRequired(fixture, runtime);

    expect(result.verdict).toBe("rework");
    expect(result.reviews.map((review) => review.record.lens)).toEqual([
      "spec",
      "architecture",
    ]);
    expect(result.task.status).toBe("rework");
    expect(result.task.gates["review-quality"]).toBeUndefined();
    expect(runtime.launches).toHaveLength(2);
  });

  it("requires every Lens client before starting the set", async () => {
    const fixture = await checked(
      fixtureTask({ reviews: ["spec", "quality"] }),
    );
    const runtime = new FakeReviewRuntime();

    await expect(
      executeRequired(fixture, runtime, {
        clients: { spec: reviewClient() },
      }),
    ).rejects.toMatchObject({ code: "review_client_missing" });
    expect(runtime.launches).toHaveLength(0);
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]
        ?.review_rounds,
    ).toBe(0);
  });
});

describe("Review output parsing", () => {
  it("accepts a single JSON fence and rejects contradictory verdicts", () => {
    expect(
      parseReviewAssessment(
        `\`\`\`json\n${JSON.stringify(passingAssessment)}\n\`\`\``,
      ),
    ).toEqual(passingAssessment);
    expect(() =>
      parseReviewAssessment(
        JSON.stringify({
          ...passingAssessment,
          blocking_findings: failingAssessment().blocking_findings,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_review_output" }));
  });
});
