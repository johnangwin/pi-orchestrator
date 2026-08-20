import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_CLIENT_VERSION } from "../src/agent.js";
import type { BriefInput } from "../src/brief.js";
import { DEFAULT_CONTEXT_THRESHOLDS } from "../src/config.js";
import { sha256, type Digest } from "../src/digest.js";
import {
  compileHandoffBrief,
  defaultHandoffLaunchBinding,
  HandoffStore,
  recoverTerminatedSession,
  runHandoff,
  type HandoffSession,
  type HandoffSessionLauncher,
  type RunHandoffOptions,
} from "../src/handoff.js";
import type { ResolvedModelRoute } from "../src/model.js";
import { MetricStore } from "../src/metric.js";
import type { OpenShellPreflight, OpenShellSandbox } from "../src/openshell.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { ProjectionRegistry } from "../src/projection.js";
import {
  SessionReconciler,
  type SessionLifecycleOpenShell,
} from "../src/reconcile.js";
import { AgentRegistry } from "../src/registry.js";
import type { SessionIdentity } from "../src/session.js";
import { ProjectStore } from "../src/state.js";
import type { PermissionCeiling } from "../src/permission.js";
import {
  createFixtureProject,
  createPlan,
  fixtureModelRoute,
  fixturePermissionCeiling,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
} from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const model: ResolvedModelRoute = fixtureModelRoute(
  "local-code",
  {
    gateway: "code",
    pi_model: "local-code",
    context_window: 131_072,
    max_tokens: 8_192,
  },
  "openshell-code",
);
const handoffPermissionCeiling = fixturePermissionCeiling(
  { kind: "task", task: "bounded-change" },
  "implementer",
);

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: "0.0.106",
  installedVersion: "0.0.106",
  versionMatches: true,
  status: {
    authentication: { provider: "mTLS", status: "authenticated" },
    gateway: model.gateway,
    server: "https://127.0.0.1:17670",
    status: "connected",
    version: "0.0.106",
  },
};

function sandbox(index: number): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-18 12:00:00",
    current_policy_version: 1,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    labels: {},
    name: `pio-handoff-${index}`,
    phase: "Ready",
    resource_version: 1,
    workspace: "default",
  };
}

interface Fixture {
  readonly root: string;
  readonly store: ProjectStore;
  readonly registry: AgentRegistry;
  readonly reconciler: SessionReconciler;
  readonly expected: SessionIdentity;
  readonly brief: Omit<BriefInput, "identity" | "handoff">;
  readonly sourceDigest: Digest;
  readonly policyDigest: Digest;
  readonly permissionCeiling: PermissionCeiling;
}

async function fixture(
  status: "active" | "failed" = "active",
): Promise<Fixture> {
  const root = await createFixtureProject();
  roots.push(root);
  const planDirectory = await createPlan(root);
  const project = await loadProject(root);
  const plan = await loadPlan(planDirectory, catalogFromConfig(project.config));
  const permissionCeiling = handoffPermissionCeiling;
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-test-"));
  roots.push(home);
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: root,
  });
  await store.writeRun({
    version: 2,
    id: "run-one",
    project_id: project.config.project.id,
    plan_id: plan.id,
    plan_revision: plan.revision,
    plan_digest: plan.digest,
    permission_policy_digest: fixturePermissionPolicyDigest(project),
    routing_policy_digest: fixtureRoutingPolicyDigest(project),
    base_commit: "0123456789abcdef",
    branch: "orchestrator/run-one",
    worktree: path.join(root, "worktree"),
    status: "active",
    tasks: {},
    created_at: "2026-08-18T12:00:00.000Z",
    updated_at: "2026-08-18T12:00:00.000Z",
  });
  const registry = new AgentRegistry(store, "run-one");
  await registry.register({
    agent: "implementer",
    role: "implementer",
    profile: model.profile,
  });
  const initial = await registry.start({
    agent: "implementer",
    session: "session-one",
    route: model,
    permissionCeilingDigest: permissionCeiling.permission_ceiling_digest,
  });
  await registry.transition(
    initial.identity,
    status === "failed"
      ? { status: "failed", reason: "The Pi process terminated." }
      : { status: "active" },
  );

  const openshell = {
    listSandboxes: () => Promise.resolve([]),
    deleteSandbox: () => Promise.resolve(),
  } as unknown as SessionLifecycleOpenShell;
  const projection = new ProjectionRegistry(
    store,
    "run-one",
    {} as ConstructorParameters<typeof ProjectionRegistry>[2],
  );
  const reconciler = new SessionReconciler(
    store,
    "run-one",
    openshell,
    projection,
  );
  const sourceDigest = sha256("current source");
  const policyDigest = sha256("write policy");
  const role = project.roles.get("implementer")!;
  return {
    root,
    store,
    registry,
    reconciler,
    expected: initial.identity,
    sourceDigest,
    policyDigest,
    permissionCeiling,
    brief: {
      agents: project.agents,
      role,
      model,
      permissionCeiling,
      task: plan.tasks[0]!,
      plan,
      decisions: [],
      dependencyReports: [],
      skills: role.definition.skills.map((name) => project.skills.get(name)!),
      outputContract: "Continue the approved Task and update its Report.",
      sourceAnchors: [
        {
          path: "src/fixture.ts",
          symbol: "fixture",
          reason: "Defines the current implementation boundary.",
        },
      ],
      sourceDigests: { "src/fixture.ts": sha256("current source") },
      contextLimitTokens: model.context_window,
    },
  };
}

function launcher(input: {
  readonly sourceDigest: Digest;
  readonly policyDigest: Digest;
  readonly failures?: number;
  readonly calls: { value: number };
}): HandoffSessionLauncher {
  return async ({ identity, brief }) => {
    input.calls.value += 1;
    if (input.calls.value <= (input.failures ?? 0)) {
      throw new Error("injected launch interruption");
    }
    const actual = sandbox(input.calls.value);
    const info = {
      sandbox: actual,
      permissionCeiling: handoffPermissionCeiling,
      identity,
      sourceDigest: input.sourceDigest,
      profile: "write" as const,
      policyDigest: input.policyDigest,
      readPolicyDigest: input.policyDigest,
      openshell: preflight,
      piVersion: "0.84.2",
      clientVersion: PI_CLIENT_VERSION,
      context: DEFAULT_CONTEXT_THRESHOLDS,
      model,
      inference: { provider: "fixture", model: model.pi_model },
      briefDigest: brief.digest,
      inputs: [],
    };
    const session: HandoffSession = {
      identity,
      info,
      deliver: () => Promise.resolve("queued"),
      ping: () => Promise.resolve("nonce"),
      release: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    return session;
  };
}

function options(
  context: Fixture,
  launchSession: HandoffSessionLauncher,
): Omit<RunHandoffOptions, "trigger"> {
  const checkpoint = {
    task: "bounded-change",
    source_digest: context.sourceDigest,
    completed: ["Inspected the current implementation."],
    current_state:
      "The approved Task is active; no host mutation is hidden in the Session.",
    blockers: [],
    next_action: "Continue from the named source anchor.",
    source_anchors: [
      {
        path: "src/fixture.ts",
        symbol: "fixture",
        reason: "Resume implementation here.",
      },
    ],
  };
  return {
    store: context.store,
    reconciler: context.reconciler,
    expected: context.expected,
    reason: "Replace the disposable Session from durable state.",
    checkpoint,
    launch: defaultHandoffLaunchBinding({
      profile: "write",
      permissionCeilingDigest:
        context.permissionCeiling.permission_ceiling_digest,
      sourceDigest: context.sourceDigest,
      policyDigest: context.policyDigest,
      model,
      context: DEFAULT_CONTEXT_THRESHOLDS,
    }),
    compileBrief: ({ identity, report }) =>
      compileHandoffBrief({
        from: context.expected,
        to: identity,
        report,
        brief: context.brief,
      }),
    launchSession,
    now: () => new Date("2026-08-18T12:30:00.000Z"),
  };
}

describe("Handoff lifecycle", () => {
  it("records host-validated context pressure as a Run metric", async () => {
    const context = await fixture();
    const calls = { value: 0 };
    try {
      const pressure = {
        tokens: 98_304,
        context_window: 131_072,
        fraction: 0.75,
        percent: 75,
        level: "handoff" as const,
        mutating_phase_allowed: true,
      };
      await runHandoff({
        ...options(
          context,
          launcher({
            sourceDigest: context.sourceDigest,
            policyDigest: context.policyDigest,
            calls,
          }),
        ),
        trigger: "context-pressure",
        pressure,
      });
      await expect(
        new MetricStore(
          context.store.runDirectory("run-one"),
          "run-one",
        ).list(),
      ).resolves.toMatchObject([
        {
          metric: {
            kind: "context-pressure",
            identity: context.expected,
            pressure,
          },
        },
      ]);
    } finally {
      await context.store.close();
    }
  });

  it("recovers a terminated Session from a durable checkpoint without its transcript", async () => {
    const context = await fixture("failed");
    const calls = { value: 0 };
    try {
      const result = await recoverTerminatedSession(
        options(
          context,
          launcher({
            sourceDigest: context.sourceDigest,
            policyDigest: context.policyDigest,
            calls,
          }),
        ),
      );

      expect(result.intent).toMatchObject({
        trigger: "recovery",
        from: { session: "session-one", generation: 1 },
        to: { generation: 2 },
      });
      expect(result.report.content).toContain("# Current State");
      expect(result.brief.content).toContain("## Current Handoff");
      expect(result.brief.content).toContain("Generation: 2");
      expect(result.brief.content).not.toContain("PREDECESSOR TRANSCRIPT");
      expect(result.result.sandbox).toEqual({
        id: result.runtime!.info.sandbox.id,
        name: result.runtime!.info.sandbox.name,
        workspace: result.runtime!.info.sandbox.workspace,
      });
      expect((await context.registry.get("implementer")).session).toMatchObject(
        {
          identity: result.intent.to,
          route: model,
          status: "active",
          replaces: {
            session: "session-one",
            reason: result.intent.reason,
          },
        },
      );
      expect(
        (await context.store.readRun("run-one")).sessions["session-one"],
      ).toMatchObject({
        status: "failed",
        termination_reason: "The Pi process terminated.",
      });
      expect(calls.value).toBe(1);

      const handoffStore = new HandoffStore(
        context.store.runDirectory("run-one"),
      );
      const persisted = await handoffStore.get("implementer", result.intent.id);
      expect(persisted?.result?.result_digest).toBe(
        result.result.result_digest,
      );
      await expect(handoffStore.list()).resolves.toMatchObject([
        { intent: { id: result.intent.id }, result: result.result },
      ]);
      expect(
        await readFile(
          path.join(
            context.store.runDirectory("run-one"),
            "reports",
            `${result.intent.id}.json`,
          ),
          "utf8",
        ),
      ).toContain(result.report.content_digest);

      const retry = await recoverTerminatedSession(
        options(
          context,
          launcher({
            sourceDigest: context.sourceDigest,
            policyDigest: context.policyDigest,
            calls,
          }),
        ),
      );
      expect(retry.reused).toBe(true);
      expect(retry.result).toEqual(result.result);
      expect(calls.value).toBe(1);

      await context.registry.replace({
        expected: result.intent.to,
        session: "session-three",
        reason: "A later replacement completed.",
        route: model,
        permissionCeilingDigest:
          context.permissionCeiling.permission_ceiling_digest,
      });
      await expect(
        recoverTerminatedSession(
          options(
            context,
            launcher({
              sourceDigest: context.sourceDigest,
              policyDigest: context.policyDigest,
              calls,
            }),
          ),
        ),
      ).resolves.toMatchObject({ reused: true, result: result.result });
      expect(calls.value).toBe(1);
    } finally {
      await context.store.close();
    }
  });

  it("resumes after interruption between generation replacement and Session launch", async () => {
    const context = await fixture();
    const calls = { value: 0 };
    const launchSession = launcher({
      sourceDigest: context.sourceDigest,
      policyDigest: context.policyDigest,
      failures: 1,
      calls,
    });
    const request = {
      ...options(context, launchSession),
      trigger: "manual" as const,
    };
    try {
      await expect(runHandoff(request)).rejects.toThrow(
        "injected launch interruption",
      );
      expect((await context.registry.get("implementer")).session).toMatchObject(
        {
          identity: { generation: 2 },
          status: "starting",
          sandbox: null,
        },
      );

      const resumed = await runHandoff(request);
      expect(resumed.result.to.generation).toBe(2);
      expect(resumed.runtime).toBeDefined();
      expect((await context.registry.get("implementer")).session?.status).toBe(
        "active",
      );
      expect(calls.value).toBe(2);
    } finally {
      await context.store.close();
    }
  });

  it("rejects replacement source drift before changing the Session generation", async () => {
    const context = await fixture();
    const calls = { value: 0 };
    const base = options(
      context,
      launcher({
        sourceDigest: context.sourceDigest,
        policyDigest: context.policyDigest,
        calls,
      }),
    );
    const request = {
      ...base,
      trigger: "manual" as const,
      checkpoint: {
        ...base.checkpoint,
        source_digest: sha256("other source"),
      },
    };
    try {
      await expect(runHandoff(request)).rejects.toMatchObject({
        code: "handoff_source_mismatch",
      });
      expect((await context.registry.get("implementer")).session).toMatchObject(
        {
          identity: context.expected,
          status: "active",
        },
      );
      expect(calls.value).toBe(0);
    } finally {
      await context.store.close();
    }
  });
});
