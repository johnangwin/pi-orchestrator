import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CmuxEnsureResult,
  CmuxPaneBinding,
  CmuxPaneCreationIntent,
  CmuxProjection,
  CmuxReconciliation,
  CmuxWorkspaceBinding,
  EnsureCmuxPaneOptions,
  EnsureCmuxWorkspaceOptions,
} from "../src/cmux.js";
import { MessageSchema } from "../src/message.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import { ProjectionRegistry, type ProjectionCmux } from "../src/projection.js";
import {
  SessionReconciler,
  type SessionLifecycleOpenShell,
  type SessionRuntime,
} from "../src/reconcile.js";
import { AgentRegistry } from "../src/registry.js";
import { PI_CLIENT_VERSION, PiClientConfigSchema } from "../src/agent.js";
import type { SessionIdentity } from "../src/session.js";
import { ProjectStore } from "../src/state.js";
import { loadSandboxPolicy } from "../src/policy.js";
import { startLinkServer } from "../sandbox/pi/client/link.mjs";
import {
  fixtureDigest,
  fixtureModelRoute,
  fixturePermissionCeiling,
} from "./fixture.js";

const roots: string[] = [];
const permissionCeiling = fixturePermissionCeiling();
const permissionCeilingDigest = permissionCeiling.permission_ceiling_digest;
const model = fixtureModelRoute("frontier-lead", {}, "openshell");
const workspaceOperation = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const paneOperation = "20000000-0000-4000-8000-000000000001";
const paneId = "20000000-0000-4000-8000-000000000002";
const surfaceId = "20000000-0000-4000-8000-000000000003";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: "0.0.106",
  installedVersion: "0.0.106",
  versionMatches: true,
  status: {
    authentication: { provider: "mTLS", status: "authenticated" },
    gateway: "openshell",
    server: "https://127.0.0.1:17670",
    status: "connected",
    version: "0.0.106",
  },
};

function sandbox(overrides: Partial<OpenShellSandbox> = {}): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-18 12:00:00",
    current_policy_version: 1,
    id: "43502221-db6b-49f2-a316-673792b3faae",
    labels: {},
    name: "pio-read-test",
    phase: "Ready",
    resource_version: 1,
    workspace: "default",
    ...overrides,
  };
}

function sandboxBinding(value = sandbox()) {
  return { id: value.id, name: value.name, workspace: value.workspace };
}

function paneBinding(operationId = paneOperation): CmuxPaneBinding {
  return {
    operation_id: operationId,
    workspace_id: workspaceId,
    pane_id: paneId,
    surface_id: surfaceId,
    title: "lead · plan",
  };
}

class FakeProjectionCmux implements ProjectionCmux {
  workspaceStatus: CmuxReconciliation["workspace"]["status"] = "present";
  paneStatus: CmuxReconciliation["panes"][string]["status"] = "present";
  readonly closed: CmuxPaneBinding[] = [];

  ensureWorkspace(
    options: EnsureCmuxWorkspaceOptions,
  ): Promise<CmuxEnsureResult<CmuxWorkspaceBinding>> {
    return Promise.resolve({
      binding: {
        operation_id: options.operationId,
        workspace_id: workspaceId,
        title: options.title,
      },
      created: options.binding == null,
      recovered: false,
      repaired: false,
    });
  }

  preparePaneCreation(options: {
    readonly operationId: string;
    readonly workspace: CmuxWorkspaceBinding;
    readonly title: string;
  }): Promise<CmuxPaneCreationIntent> {
    return Promise.resolve({
      operation_id: options.operationId,
      workspace_id: options.workspace.workspace_id,
      title: options.title,
      prior_pane_ids: [],
    });
  }

  ensurePane(
    options: EnsureCmuxPaneOptions,
  ): Promise<CmuxEnsureResult<CmuxPaneBinding>> {
    return Promise.resolve({
      binding: options.binding ?? paneBinding(options.operationId),
      created: options.binding == null,
      recovered: false,
      repaired: false,
    });
  }

  reconcile(projection: CmuxProjection): Promise<CmuxReconciliation> {
    return Promise.resolve({
      healthy:
        this.workspaceStatus === "present" &&
        Object.keys(projection.panes).length > 0 &&
        this.paneStatus === "present",
      workspace: {
        binding: projection.workspace,
        status: this.workspaceStatus,
      },
      panes: Object.fromEntries(
        Object.entries(projection.panes).map(([agent, binding]) => [
          agent,
          { binding, status: this.paneStatus },
        ]),
      ),
    });
  }

  closePane(binding: CmuxPaneBinding): Promise<void> {
    this.closed.push(binding);
    return Promise.resolve();
  }
}

class FakeOpenShell implements SessionLifecycleOpenShell {
  sandboxes: OpenShellSandbox[] = [];
  readonly deletes: string[] = [];
  failDelete = false;

  listSandboxes(): Promise<OpenShellSandbox[]> {
    return Promise.resolve([...this.sandboxes]);
  }

  getSandbox(name: string): Promise<OpenShellSandbox> {
    const found = this.sandboxes.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing Sandbox '${name}'`);
    return Promise.resolve(found);
  }

  preflight(): Promise<OpenShellPreflight> {
    return Promise.resolve(preflight);
  }

  execSandbox(): Promise<ProcessResult> {
    throw new Error("Unexpected Sandbox execution");
  }

  startServiceForward(): Promise<OpenShellForward> {
    throw new Error("Unexpected service forward");
  }

  deleteSandbox(name: string): Promise<void> {
    this.deletes.push(name);
    if (this.failDelete) throw new Error("injected deletion failure");
    this.sandboxes = this.sandboxes.filter(
      (candidate) => candidate.name !== name,
    );
    return Promise.resolve();
  }
}

async function setup(): Promise<{
  readonly store: ProjectStore;
  readonly registry: AgentRegistry;
  readonly identity: SessionIdentity;
  readonly cmux: FakeProjectionCmux;
  readonly projection: ProjectionRegistry;
  readonly openshell: FakeOpenShell;
  readonly reconciler: SessionReconciler;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-reconcile-test-"));
  roots.push(home);
  const store = await ProjectStore.open({
    home,
    projectId: "fixture",
    projectRoot: "/project",
  });
  await store.writeRun({
    version: 2,
    id: "run-one",
    project_id: "fixture",
    plan_id: "fixture-plan",
    plan_revision: 1,
    plan_digest: "sha256:plan",
    permission_policy_digest: fixtureDigest,
    routing_policy_digest: fixtureDigest,
    base_commit: "0123456789abcdef",
    branch: "orchestrator/run-one",
    worktree: "/worktrees/run-one",
    status: "active",
    tasks: {},
    created_at: "2026-08-18T12:00:00.000Z",
    updated_at: "2026-08-18T12:00:00.000Z",
  });
  const registry = new AgentRegistry(store, "run-one");
  await registry.register({
    agent: "lead",
    role: "lead",
    profile: model.profile,
  });
  const session = await registry.start({
    agent: "lead",
    session: "session-one",
    route: model,
    permissionCeilingDigest,
  });
  const cmux = new FakeProjectionCmux();
  const projection = new ProjectionRegistry(store, "run-one", cmux);
  const openshell = new FakeOpenShell();
  const reconciler = new SessionReconciler(
    store,
    "run-one",
    openshell,
    projection,
  );
  return {
    store,
    registry,
    identity: session.identity,
    cmux,
    projection,
    openshell,
    reconciler,
  };
}

async function projectSession(
  projection: ProjectionRegistry,
  identity: SessionIdentity,
): Promise<void> {
  await projection.ensureWorkspace({
    operationId: workspaceOperation,
    title: "fixture · run-one",
  });
  await projection.ensurePane({
    identity,
    operationId: paneOperation,
    title: "lead · plan",
  });
}

function runtime(
  identity: SessionIdentity,
  actual = sandbox(),
): SessionRuntime {
  return {
    identity,
    info: { sandbox: actual, permissionCeiling },
    deliver: () => Promise.resolve("queued"),
    ping: () => Promise.resolve("nonce"),
    release: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function instruction(id = "msg-one") {
  return MessageSchema.parse({
    version: 2,
    id,
    run: "run-one",
    from: { host: true },
    to: { agent: "lead" },
    type: "instruction",
    priority: "normal",
    reply_to: null,
    body: { instruction: "Continue the current work." },
    references: [],
    created_at: "2026-08-18T12:01:00.000Z",
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("Session lifecycle reconciliation", () => {
  it("derives recovery actions without treating projection drift as workflow completion", async () => {
    const {
      store,
      registry,
      identity,
      cmux,
      projection,
      openshell,
      reconciler,
    } = await setup();
    try {
      await expect(reconciler.inspect("lead")).resolves.toMatchObject({
        action: "start",
        sandbox: "unbound",
      });

      await registry.bindSandbox(identity, sandboxBinding());
      await expect(reconciler.inspect("lead")).resolves.toMatchObject({
        action: "replace",
        sandbox: "missing",
      });

      openshell.sandboxes = [
        sandbox({ id: "53502221-db6b-49f2-a316-673792b3faae" }),
      ];
      await expect(reconciler.inspect("lead")).resolves.toMatchObject({
        action: "blocked",
        sandbox: "identity_mismatch",
      });

      openshell.sandboxes = [sandbox()];
      await expect(reconciler.inspect("lead")).resolves.toMatchObject({
        action: "reconnect",
        sandbox: "ready",
        link: "missing",
      });

      await projectSession(projection, identity);
      const live = runtime(identity);
      await reconciler.mailbox.attach(live);
      await expect(reconciler.inspect("lead", live)).resolves.toMatchObject({
        action: "none",
        link: "connected",
        projection: { healthy: true },
      });

      cmux.paneStatus = "missing";
      await expect(reconciler.inspect("lead", live)).resolves.toMatchObject({
        action: "reattach",
        projection: { healthy: false, pane: "missing" },
      });

      await expect(
        reconciler.inspect(
          "lead",
          runtime(
            identity,
            sandbox({ id: "63502221-db6b-49f2-a316-673792b3faae" }),
          ),
        ),
      ).resolves.toMatchObject({ action: "blocked", link: "stale" });
      expect((await registry.get("lead")).session?.status).toBe("active");
    } finally {
      await store.close();
    }
  });

  it("retries ordered teardown and advances the generation only after cleanup", async () => {
    const {
      store,
      registry,
      identity,
      cmux,
      projection,
      openshell,
      reconciler,
    } = await setup();
    try {
      await registry.bindSandbox(identity, sandboxBinding());
      await registry.transition(identity, { status: "active" });
      openshell.sandboxes = [sandbox()];
      await projectSession(projection, identity);
      await reconciler.mailbox.send(instruction());

      openshell.failDelete = true;
      await expect(
        reconciler.replace({
          expected: identity,
          session: "session-two",
          reason: "Replace a lost Session",
          route: model,
        }),
      ).rejects.toThrow("injected deletion failure");
      expect((await registry.get("lead")).session).toMatchObject({
        identity,
        status: "stopped",
        termination_reason: "Replace a lost Session",
      });
      expect((await store.readRun("run-one")).cmux.panes.lead).toBeDefined();
      expect(await reconciler.mailbox.mailbox.list("pending")).toHaveLength(1);
      await expect(
        reconciler.mailbox.send(instruction("late-message")),
      ).rejects.toMatchObject({ code: "session_terminal" });

      openshell.failDelete = false;
      const replacement = await reconciler.replace({
        expected: identity,
        session: "session-two",
        reason: "Replace a lost Session",
        route: model,
      });
      expect(replacement).toMatchObject({
        identity: { session: "session-two", generation: 2 },
        status: "starting",
        replaces: {
          session: "session-one",
          reason: "Replace a lost Session",
        },
      });
      expect((await store.readRun("run-one")).cmux.panes.lead).toBeUndefined();
      expect(await reconciler.mailbox.mailbox.list("pending")).toEqual([]);
      expect(await reconciler.mailbox.mailbox.list("superseded")).toMatchObject(
        [{ message: { id: "msg-one" } }],
      );
      expect(cmux.closed).toMatchObject([{ pane_id: paneId }]);

      await expect(
        reconciler.replace({
          expected: identity,
          session: "session-two",
          reason: "Replace a lost Session",
          route: model,
        }),
      ).resolves.toEqual(replacement);
      expect(openshell.deletes).toEqual(["pio-read-test", "pio-read-test"]);
      expect(cmux.closed).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("rejects a Sandbox name collision before changing Session state", async () => {
    const {
      store,
      registry,
      identity,
      cmux,
      projection,
      openshell,
      reconciler,
    } = await setup();
    try {
      await registry.bindSandbox(identity, sandboxBinding());
      await registry.transition(identity, { status: "active" });
      await projectSession(projection, identity);
      await reconciler.mailbox.send(instruction());
      openshell.sandboxes = [sandbox()];

      await expect(
        reconciler.replace({
          expected: identity,
          session: "session-two",
          reason: "   ",
          route: model,
        }),
      ).rejects.toThrow();
      expect((await registry.get("lead")).session?.status).toBe("active");
      expect(openshell.deletes).toEqual([]);

      openshell.sandboxes = [
        sandbox({ id: "53502221-db6b-49f2-a316-673792b3faae" }),
      ];

      await expect(
        reconciler.replace({
          expected: identity,
          session: "session-two",
          reason: "Replace a lost Session",
          route: model,
        }),
      ).rejects.toMatchObject({ code: "sandbox_identity_mismatch" });
      expect((await registry.get("lead")).session).toMatchObject({
        identity,
        status: "active",
      });
      expect((await store.readRun("run-one")).cmux.panes.lead).toBeDefined();
      expect(await reconciler.mailbox.mailbox.list("pending")).toHaveLength(1);
      expect(openshell.deletes).toEqual([]);
      expect(cmux.closed).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("recovers a host Link and flushes pending Mailbox delivery", async () => {
    const { store, registry, identity, projection } = await setup();
    const port = await availablePort();
    const policy = await loadSandboxPolicy(
      "read",
      path.join(process.cwd(), "sandbox", "policies", "read.yaml"),
    );
    const config = PiClientConfigSchema.parse({
      version: 2,
      identity,
      token: "a".repeat(64),
      listen: { host: "127.0.0.1", port },
      client_version: PI_CLIENT_VERSION,
      pi_version: "0.84.2",
      permission_ceiling: permissionCeiling,
      model,
      brief: {
        path: "/workspace/input/brief.md",
        digest: fixtureDigest,
        content_digest: fixtureDigest,
      },
      source_digest: `sha256:${"1".repeat(64)}`,
      policy_digest: policy.digest,
    });
    const delivered: string[] = [];
    const server = await startLinkServer({
      config,
      deliver(message) {
        delivered.push(message.id);
      },
    });
    const actual = sandbox();
    let forwardStops = 0;
    const openshell: SessionLifecycleOpenShell = {
      listSandboxes: () => Promise.resolve([actual]),
      getSandbox: () => Promise.resolve(actual),
      preflight: () => Promise.resolve(preflight),
      getInferenceRoute: () =>
        Promise.resolve({ provider: "fixture", model: model.pi_model }),
      execSandbox: () =>
        Promise.resolve({
          stdout: JSON.stringify(config),
          stderr: "",
          exitCode: 0,
        }),
      startServiceForward: () =>
        Promise.resolve({
          sandboxName: actual.name,
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: () => {
            forwardStops += 1;
            if (forwardStops === 1) {
              return Promise.reject(new Error("injected forward failure"));
            }
            return Promise.resolve();
          },
        }),
      deleteSandbox: () => Promise.resolve(),
    };
    const reconciler = new SessionReconciler(
      store,
      "run-one",
      openshell,
      projection,
    );
    let recovered:
      Awaited<ReturnType<SessionReconciler["recover"]>> | undefined;
    try {
      await registry.bindSandbox(identity, sandboxBinding(actual));
      await registry.transition(identity, { status: "disconnected" });
      await reconciler.mailbox.send(instruction("recover-message"));

      recovered = await reconciler.recover({
        identity,
        model,
        briefDigest: fixtureDigest,
      });
      expect(delivered).toEqual(["recover-message"]);
      expect(
        (await reconciler.mailbox.mailbox.find("recover-message"))?.lifecycle,
      ).toBe("queued");
      expect((await registry.get("lead")).session?.status).toBe("active");
      await expect(recovered.release()).rejects.toMatchObject({
        code: "session_release_failed",
      });
      await expect(recovered.release()).resolves.toBeUndefined();
      recovered = undefined;
      expect(forwardStops).toBe(2);
    } finally {
      await recovered?.release().catch(() => undefined);
      await server.close();
      await store.close();
    }
  });
});
