import { mkdtemp, rm } from "node:fs/promises";
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
import { ProjectionRegistry, type ProjectionCmux } from "../src/projection.js";
import { AgentRegistry } from "../src/registry.js";
import type { SessionIdentity } from "../src/session.js";
import { ProjectStore, RunStateSchema } from "../src/state.js";
import { fixtureDigest, fixturePermissionCeiling } from "./fixture.js";

const roots: string[] = [];
const permissionCeilingDigest =
  fixturePermissionCeiling().permission_ceiling_digest;
const workspaceOperation = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const firstPaneOperation = "20000000-0000-4000-8000-000000000001";
const firstPaneId = "20000000-0000-4000-8000-000000000002";
const firstSurfaceId = "20000000-0000-4000-8000-000000000003";
const secondPaneOperation = "30000000-0000-4000-8000-000000000001";
const secondPaneId = "30000000-0000-4000-8000-000000000002";
const secondSurfaceId = "30000000-0000-4000-8000-000000000003";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{
  store: ProjectStore;
  agents: AgentRegistry;
  identity: SessionIdentity;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-projection-test-"));
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
    base_commit: "0123456789abcdef",
    branch: "orchestrator/run-one",
    worktree: "/worktrees/run-one",
    status: "active",
    tasks: {},
    created_at: "2026-08-18T12:00:00.000Z",
    updated_at: "2026-08-18T12:00:00.000Z",
  });
  const agents = new AgentRegistry(store, "run-one");
  await agents.register({ agent: "lead", role: "lead", model: "plan" });
  const session = await agents.start({
    agent: "lead",
    session: "session-one",
    permissionCeilingDigest,
  });
  return { store, agents, identity: session.identity };
}

function paneBinding(operationId: string): CmuxPaneBinding {
  const second = operationId === secondPaneOperation;
  return {
    operation_id: operationId,
    workspace_id: workspaceId,
    pane_id: second ? secondPaneId : firstPaneId,
    surface_id: second ? secondSurfaceId : firstSurfaceId,
    title: "lead · plan",
  };
}

class FakeProjectionCmux implements ProjectionCmux {
  failWorkspace = false;
  failPane = false;
  paneStatus: CmuxReconciliation["panes"][string]["status"] = "present";
  workspaceStatus: CmuxReconciliation["workspace"]["status"] = "present";
  prepareCount = 0;
  ensurePaneCount = 0;
  closed: CmuxPaneBinding[] = [];
  onEnsurePane: (() => void | Promise<void>) | undefined;
  lastWorkspaceOptions: EnsureCmuxWorkspaceOptions | undefined;
  lastPaneOptions: EnsureCmuxPaneOptions | undefined;

  async ensureWorkspace(
    options: EnsureCmuxWorkspaceOptions,
  ): Promise<CmuxEnsureResult<CmuxWorkspaceBinding>> {
    this.lastWorkspaceOptions = options;
    if (this.failWorkspace) throw new Error("injected Workspace failure");
    return {
      binding: {
        operation_id: options.operationId,
        workspace_id: workspaceId,
        title: options.title,
      },
      created: options.binding == null,
      recovered: false,
      repaired: false,
    };
  }

  preparePaneCreation(options: {
    readonly operationId: string;
    readonly workspace: CmuxWorkspaceBinding;
    readonly title: string;
  }): Promise<CmuxPaneCreationIntent> {
    this.prepareCount += 1;
    return Promise.resolve({
      operation_id: options.operationId,
      workspace_id: options.workspace.workspace_id,
      title: options.title,
      prior_pane_ids: [],
    });
  }

  async ensurePane(
    options: EnsureCmuxPaneOptions,
  ): Promise<CmuxEnsureResult<CmuxPaneBinding>> {
    this.ensurePaneCount += 1;
    this.lastPaneOptions = options;
    await this.onEnsurePane?.();
    if (this.failPane) throw new Error("injected Pane failure");
    return {
      binding: options.binding ?? paneBinding(options.operationId),
      created: options.binding == null,
      recovered: false,
      repaired: false,
    };
  }

  reconcile(projection: CmuxProjection): Promise<CmuxReconciliation> {
    const panes = Object.fromEntries(
      Object.entries(projection.panes).map(([agent, binding]) => [
        agent,
        { binding, status: this.paneStatus },
      ]),
    );
    return Promise.resolve({
      healthy:
        this.workspaceStatus === "present" &&
        Object.values(panes).every((pane) => pane.status === "present"),
      workspace: {
        binding: projection.workspace,
        status: this.workspaceStatus,
      },
      panes,
    });
  }

  closePane(binding: CmuxPaneBinding): Promise<void> {
    this.closed.push(binding);
    return Promise.resolve();
  }
}

async function bindWorkspace(
  projection: ProjectionRegistry,
): Promise<CmuxWorkspaceBinding> {
  return (
    await projection.ensureWorkspace({
      operationId: workspaceOperation,
      title: "fixture · run-one",
    })
  ).binding;
}

describe("durable cmux projection registry", () => {
  it("persists a Workspace operation before mutation and recovers it after restart", async () => {
    const { store } = await setup();
    try {
      const fake = new FakeProjectionCmux();
      const projection = new ProjectionRegistry(store, "run-one", fake);
      fake.failWorkspace = true;
      await expect(bindWorkspace(projection)).rejects.toThrow(
        "injected Workspace failure",
      );
      expect((await store.readRun("run-one")).cmux.workspace).toEqual({
        operation_id: workspaceOperation,
        title: "fixture · run-one",
        binding: null,
      });

      fake.failWorkspace = false;
      await expect(
        bindWorkspace(new ProjectionRegistry(store, "run-one", fake)),
      ).resolves.toMatchObject({ workspace_id: workspaceId });
      expect(
        (await store.readRun("run-one")).cmux.workspace?.binding,
      ).toMatchObject({ workspace_id: workspaceId });

      await bindWorkspace(new ProjectionRegistry(store, "run-one", fake));
      expect(fake.lastWorkspaceOptions?.binding).toMatchObject({
        workspace_id: workspaceId,
      });
    } finally {
      await store.close();
    }
  });

  it("persists the Pane intent before mutation and resumes the same operation", async () => {
    const { store, identity } = await setup();
    try {
      const fake = new FakeProjectionCmux();
      const projection = new ProjectionRegistry(store, "run-one", fake);
      await bindWorkspace(projection);
      fake.failPane = true;
      fake.onEnsurePane = async () => {
        const pane = (await store.readRun("run-one")).cmux.panes.lead;
        expect(pane?.intent).toMatchObject({
          operation_id: firstPaneOperation,
        });
        expect(pane?.binding).toBeNull();
      };
      const options = {
        identity,
        operationId: firstPaneOperation,
        title: "lead · plan",
      };
      await expect(projection.ensurePane(options)).rejects.toThrow(
        "injected Pane failure",
      );

      fake.failPane = false;
      fake.onEnsurePane = undefined;
      await expect(
        new ProjectionRegistry(store, "run-one", fake).ensurePane(options),
      ).resolves.toMatchObject({
        binding: { pane_id: firstPaneId, surface_id: firstSurfaceId },
      });
      expect(fake.prepareCount).toBe(1);
      expect((await store.readRun("run-one")).cmux.panes.lead).toMatchObject({
        identity,
        operation_id: firstPaneOperation,
        binding: { pane_id: firstPaneId },
      });
    } finally {
      await store.close();
    }
  });

  it("reattaches a running Session only after its old Pane is observed missing", async () => {
    const { store, identity } = await setup();
    try {
      const fake = new FakeProjectionCmux();
      const projection = new ProjectionRegistry(store, "run-one", fake);
      await bindWorkspace(projection);
      await projection.ensurePane({
        identity,
        operationId: firstPaneOperation,
        title: "lead · plan",
      });

      fake.paneStatus = "missing";
      await expect(
        projection.reattachPane({
          identity,
          operationId: firstPaneOperation,
          title: "lead · plan",
        }),
      ).rejects.toMatchObject({ code: "cmux_operation_conflict" });

      fake.paneStatus = "present";
      await expect(
        projection.reattachPane({
          identity,
          operationId: secondPaneOperation,
          title: "lead · plan",
        }),
      ).rejects.toMatchObject({ code: "cmux_pane_present" });

      fake.paneStatus = "missing";
      await expect(
        projection.reattachPane({
          identity,
          operationId: secondPaneOperation,
          title: "lead · plan",
        }),
      ).resolves.toMatchObject({
        binding: { pane_id: secondPaneId, surface_id: secondSurfaceId },
      });
      expect((await store.readRun("run-one")).cmux.panes.lead).toMatchObject({
        operation_id: secondPaneOperation,
        replaces: { pane_id: firstPaneId },
        binding: { pane_id: secondPaneId },
      });
    } finally {
      await store.close();
    }
  });

  it("requires Pane removal before advancing the Session generation", async () => {
    const { store, agents, identity } = await setup();
    try {
      const fake = new FakeProjectionCmux();
      const projection = new ProjectionRegistry(store, "run-one", fake);
      await bindWorkspace(projection);
      await projection.ensurePane({
        identity,
        operationId: firstPaneOperation,
        title: "lead · plan",
      });

      await expect(
        agents.replace({
          expected: identity,
          session: "session-two",
          reason: "Replace the Session",
          permissionCeilingDigest,
        }),
      ).rejects.toThrow();
      await projection.removePane(identity);
      await expect(
        agents.replace({
          expected: identity,
          session: "session-two",
          reason: "Replace the Session",
          permissionCeilingDigest,
        }),
      ).resolves.toMatchObject({ identity: { generation: 2 } });
      expect(fake.closed).toMatchObject([{ pane_id: firstPaneId }]);
    } finally {
      await store.close();
    }
  });

  it("removes stale Pane state when the entire cmux Workspace is gone", async () => {
    const { store, identity } = await setup();
    try {
      const fake = new FakeProjectionCmux();
      const projection = new ProjectionRegistry(store, "run-one", fake);
      await bindWorkspace(projection);
      await projection.ensurePane({
        identity,
        operationId: firstPaneOperation,
        title: "lead · plan",
      });

      fake.workspaceStatus = "missing";
      fake.paneStatus = "workspace_missing";
      await expect(projection.removePane(identity)).resolves.toBeUndefined();
      expect((await store.readRun("run-one")).cmux.panes.lead).toBeUndefined();
      expect(fake.closed).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("rejects projection state that does not identify the current Session", async () => {
    const { store, identity } = await setup();
    try {
      const state = await store.readRun("run-one");
      const invalid = {
        ...state,
        cmux: {
          workspace: {
            operation_id: workspaceOperation,
            title: "fixture · run-one",
            binding: {
              operation_id: workspaceOperation,
              workspace_id: workspaceId,
              title: "fixture · run-one",
            },
          },
          panes: {
            lead: {
              identity: { ...identity, generation: 2 },
              operation_id: firstPaneOperation,
              title: "lead · plan",
              intent: null,
              binding: paneBinding(firstPaneOperation),
              replaces: null,
            },
          },
        },
      };
      expect(RunStateSchema.safeParse(invalid).success).toBe(false);
    } finally {
      await store.close();
    }
  });
});
