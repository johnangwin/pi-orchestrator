import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import type { Digest } from "../src/digest.js";
import { collectWorkspaceGitDiff, type GitStatusRunner } from "../src/git.js";
import {
  WorkspaceLifecycle,
  type AcquireWriteLeaseInput,
} from "../src/lifecycle.js";
import { catalogFromConfig, loadPlan, type PlanTask } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { AgentRegistry } from "../src/registry.js";
import { startRun } from "../src/run.js";
import { ProjectStore } from "../src/state.js";
import {
  createWorkspaceManifest,
  type WorkspaceManifest,
} from "../src/workspace.js";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixtureDigest,
  fixtureModelRoute,
  fixturePermissionCeiling,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
} from "./fixture.js";

const roots: string[] = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function statusRunner(
  commit: string,
  records: readonly string[],
): GitStatusRunner {
  return (args) =>
    Promise.resolve(
      Buffer.from(
        args.includes("rev-parse")
          ? `${commit}\n`
          : records.map((record) => `${record}\0`).join(""),
        "utf8",
      ),
    );
}

async function gitDiff(
  root: string,
  commit: string,
  manifest: WorkspaceManifest,
  records: readonly string[],
) {
  return collectWorkspaceGitDiff({
    root,
    inputCommit: commit,
    manifestDigest: manifest.digest as Digest,
    runner: statusRunner(commit, records),
  });
}

interface Fixture {
  readonly store: ProjectStore;
  readonly lifecycle: WorkspaceLifecycle;
  readonly registry: AgentRegistry;
  readonly task: PlanTask;
  readonly commit: string;
  readonly workspaceRoot: string;
  readonly baseline: WorkspaceManifest;
  readonly baselineDiff: Awaited<ReturnType<typeof gitDiff>>;
  readonly permission: ReturnType<typeof fixturePermissionCeiling>;
  readonly acquireInput: AcquireWriteLeaseInput;
  readonly clock: { value: Date };
}

async function fixture(): Promise<Fixture> {
  const root = await createFixtureProject();
  roots.push(root);
  await createPlan(root);
  const commit = await commitFixture(root);
  const project = await loadProject(root);
  const plan = await loadPlan(
    path.join(root, "docs", "plans", "fixture-plan"),
    catalogFromConfig(project.config),
  );
  const task = plan.tasks[0]!;
  const home = await temporary("pi-lifecycle-state-");
  const worktreeRoot = await temporary("pi-lifecycle-worktree-");
  const workspaceRoot = await temporary("pi-lifecycle-volume-");
  await mkdir(path.join(workspaceRoot, "src"));
  await writeFile(
    path.join(workspaceRoot, "src", "fixture.ts"),
    "export const fixture = true;\n",
  );
  const baseline = await createWorkspaceManifest(workspaceRoot);
  const baselineDiff = await gitDiff(workspaceRoot, commit, baseline, []);
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: project.root,
  });
  stores.push(store);
  await store.recordApproval(
    createApproval({
      plan,
      baseCommit: commit,
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "fixture",
      approvedAt: new Date("2026-08-19T12:00:00.000Z"),
    }),
  );
  const run = await startRun({
    store,
    project,
    plan,
    worktreeRoot,
    now: new Date("2026-08-19T12:01:00.000Z"),
  });
  const clock = { value: new Date("2026-08-19T12:02:00.000Z") };
  const lifecycle = new WorkspaceLifecycle(
    store,
    run.run.id,
    () => clock.value,
  );
  await lifecycle.initialize({
    volumeName: "pio-fixture-run",
    volumeDigest: fixtureDigest,
    manifest: baseline,
    gitDiff: baselineDiff,
  });
  const registry = new AgentRegistry(store, run.run.id, () => clock.value);
  const permission = fixturePermissionCeiling({
    kind: "task",
    task: task.id,
  });
  await registry.register({
    agent: "implementer-one",
    role: "implementer",
    profile: "local-code",
  });
  await registry.start({
    agent: "implementer-one",
    session: "implementation-one",
    route: fixtureModelRoute(),
    permissionCeilingDigest: permission.permission_ceiling_digest,
  });
  const acquireInput: AcquireWriteLeaseInput = {
    id: "lease-one",
    task,
    identity: {
      run: run.run.id,
      agent: "implementer-one",
      session: "implementation-one",
      generation: 1,
    },
    permissionCeiling: permission,
    baselineManifest: baseline,
    protectedPatterns: project.config.protected,
    restrictedPatterns: project.config.restricted_paths,
    expiresAt: "2026-08-19T13:00:00.000Z",
    sandboxName: "impl-one",
    sandboxWorkspace: "workspace-fixture",
    policyDigest: fixtureDigest,
    imageDigest: fixtureDigest,
    gatewayDigest: fixtureDigest,
    mountSetDigest: fixtureDigest,
  };
  return {
    store,
    lifecycle,
    registry,
    task,
    commit,
    workspaceRoot,
    baseline,
    baselineDiff,
    permission,
    acquireInput,
    clock,
  };
}

async function activate(
  context: Fixture,
  input: AcquireWriteLeaseInput = context.acquireInput,
  sandboxId = "00000000-0000-4000-8000-000000000001",
) {
  const lease = await context.lifecycle.acquire(input);
  await context.registry.bindSandbox(input.identity, {
    id: sandboxId,
    name: input.sandboxName,
    workspace: input.sandboxWorkspace,
  });
  const active = await context.lifecycle.activate(lease.id, {
    id: sandboxId,
    name: input.sandboxName,
    workspace: input.sandboxWorkspace,
    gatewayDigest: input.gatewayDigest,
    mountSetDigest: input.mountSetDigest,
    mountTableDigest: fixtureDigest,
    sandboxDigest: fixtureDigest,
  });
  return { lease: active, sandboxId };
}

async function releaseChanged(
  context: Fixture,
  input: AcquireWriteLeaseInput,
  baseline: WorkspaceManifest,
  content: string,
  changeSetId: string,
  sandboxId: string,
) {
  await writeFile(
    path.join(context.workspaceRoot, "src", "fixture.ts"),
    content,
  );
  const result = await createWorkspaceManifest(context.workspaceRoot);
  const diff = await gitDiff(context.workspaceRoot, context.commit, result, [
    " M src/fixture.ts",
  ]);
  await context.lifecycle.beginRevocation(input.id);
  const changeSet = await context.lifecycle.release({
    leaseId: input.id,
    changeSetId,
    task: context.task,
    baselineManifest: baseline,
    resultManifest: result,
    gitDiff: diff,
    protectedPatterns: input.protectedPatterns,
    restrictedPatterns: input.restrictedPatterns,
    deletedSandboxId: sandboxId,
    writableSandboxIds: [],
  });
  return { result, diff, changeSet };
}

describe("Workspace Write Lease lifecycle", () => {
  it("atomically grants one competing lease and makes its retry idempotent", async () => {
    const context = await fixture();
    const second = {
      ...context.acquireInput,
      id: "lease-two",
      sandboxName: "impl-two",
    };

    const attempts = await Promise.allSettled([
      context.lifecycle.acquire(context.acquireInput),
      context.lifecycle.acquire(second),
    ]);
    expect(
      attempts.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = attempts.find((entry) => entry.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "write_lease_active" },
    });
    const granted = attempts.find(
      (
        entry,
      ): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof context.lifecycle.acquire>>
      > => entry.status === "fulfilled",
    )!.value;
    const requested =
      granted.id === "lease-one" ? context.acquireInput : second;
    await expect(context.lifecycle.acquire(requested)).resolves.toEqual(
      granted,
    );
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace,
    ).toMatchObject({
      phase: "mutating",
      active_lease: {
        id: granted.id,
        digest: granted.digest,
        status: "preparing",
      },
    });
  });

  it("revokes an expired preparing lease without claiming stability before absence verification", async () => {
    const context = await fixture();
    const lease = await context.lifecycle.acquire({
      ...context.acquireInput,
      expiresAt: "2026-08-19T12:03:00.000Z",
    });
    context.clock.value = new Date("2026-08-19T12:04:00.000Z");

    const releasing = await context.lifecycle.revokeExpired(lease.id);
    expect(releasing.status).toBe("releasing");
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace?.phase,
    ).toBe("mutating");

    const changeSet = await context.lifecycle.release({
      leaseId: lease.id,
      changeSetId: "change-empty",
      task: context.task,
      baselineManifest: context.baseline,
      resultManifest: context.baseline,
      gitDiff: context.baselineDiff,
      protectedPatterns: context.acquireInput.protectedPatterns,
      restrictedPatterns: context.acquireInput.restrictedPatterns,
      deletedSandboxId: null,
      writableSandboxIds: [],
    });
    expect(changeSet.changes).toEqual([]);
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace,
    ).toMatchObject({
      phase: "stable",
      generation: 1,
      active_lease: null,
    });
    await expect(
      context.lifecycle.release({
        leaseId: lease.id,
        changeSetId: "change-empty",
        task: context.task,
        baselineManifest: context.baseline,
        resultManifest: context.baseline,
        gitDiff: context.baselineDiff,
        protectedPatterns: context.acquireInput.protectedPatterns,
        restrictedPatterns: context.acquireInput.restrictedPatterns,
        deletedSandboxId: null,
        writableSandboxIds: [],
      }),
    ).resolves.toEqual(changeSet);
  });

  it("reconciles an interrupted writer only from exact persisted provenance", async () => {
    const context = await fixture();
    const sandboxId = "00000000-0000-4000-8000-000000000001";
    await context.lifecycle.acquire(context.acquireInput);
    await context.registry.bindSandbox(context.acquireInput.identity, {
      id: sandboxId,
      name: context.acquireInput.sandboxName,
      workspace: context.acquireInput.sandboxWorkspace,
    });
    await expect(
      context.lifecycle.reconcile(context.acquireInput.id, {
        id: sandboxId,
        name: context.acquireInput.sandboxName,
        workspace: context.acquireInput.sandboxWorkspace,
        gatewayDigest: context.acquireInput.gatewayDigest,
        mountSetDigest: context.acquireInput.mountSetDigest,
        mountTableDigest: fixtureDigest,
        sandboxDigest: fixtureDigest,
      }),
    ).resolves.toMatchObject({ status: "active", sandbox_id: sandboxId });

    await expect(
      context.lifecycle.reconcile(context.acquireInput.id, {
        id: sandboxId,
        name: context.acquireInput.sandboxName,
        workspace: context.acquireInput.sandboxWorkspace,
        gatewayDigest: context.acquireInput.gatewayDigest,
        mountSetDigest: context.acquireInput.mountSetDigest,
        mountTableDigest: `sha256:${"f".repeat(64)}`,
        sandboxDigest: fixtureDigest,
      }),
    ).rejects.toMatchObject({ code: "write_lease_provenance_mismatch" });
    expect((await context.store.readRun(context.lifecycle.runId)).status).toBe(
      "blocked",
    );
  });

  it("blocks unexplained Workspace changes that have no active lease", async () => {
    const context = await fixture();
    await context.store.updateRun(context.lifecycle.runId, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        [context.task.id]: {
          ...state.tasks[context.task.id]!,
          gates: {
            "check-project-test": {
              status: "pass",
              digest: fixtureDigest,
              updated_at: context.clock.value.toISOString(),
            },
          },
        },
      },
    }));
    await writeFile(
      path.join(context.workspaceRoot, "src", "fixture.ts"),
      "export const fixture = false;\n",
    );
    const observed = await createWorkspaceManifest(context.workspaceRoot);
    const observedDiff = await gitDiff(
      context.workspaceRoot,
      context.commit,
      observed,
      [" M src/fixture.ts"],
    );

    await expect(
      context.lifecycle.observe({
        manifest: observed,
        gitDiff: observedDiff,
        writableSandboxIds: [],
      }),
    ).rejects.toMatchObject({ code: "workspace_changed_without_lease" });
    const state = await context.store.readRun(context.lifecycle.runId);
    expect(state.status).toBe("blocked");
    expect(state.workspace?.drift).toMatchObject({
      expected_manifest_digest: context.baseline.digest,
      observed_manifest_digest: observed.digest,
    });
    expect(
      state.tasks[context.task.id]?.gates["check-project-test"]?.status,
    ).toBe("stale");
  });

  it("records sequential Agents as separate Change Sets over one accumulating Task result", async () => {
    const context = await fixture();
    const first = await activate(context);
    const firstResult = await releaseChanged(
      context,
      context.acquireInput,
      context.baseline,
      "export const fixture = 1;\n",
      "change-one",
      first.sandboxId,
    );

    const permission = fixturePermissionCeiling({
      kind: "task",
      task: context.task.id,
    });
    await context.registry.register({
      agent: "implementer-two",
      role: "implementer",
      profile: "local-code",
    });
    await context.registry.start({
      agent: "implementer-two",
      session: "implementation-two",
      route: fixtureModelRoute(),
      permissionCeilingDigest: permission.permission_ceiling_digest,
    });
    const secondInput: AcquireWriteLeaseInput = {
      ...context.acquireInput,
      id: "lease-two",
      identity: {
        run: context.lifecycle.runId,
        agent: "implementer-two",
        session: "implementation-two",
        generation: 1,
      },
      permissionCeiling: permission,
      baselineManifest: firstResult.result,
      sandboxName: "impl-two",
    };
    const second = await activate(
      context,
      secondInput,
      "00000000-0000-4000-8000-000000000002",
    );
    const secondResult = await releaseChanged(
      context,
      secondInput,
      firstResult.result,
      "export const fixture = 2;\n",
      "change-two",
      second.sandboxId,
    );

    expect(firstResult.changeSet.identity.agent).toBe("implementer-one");
    expect(secondResult.changeSet.identity.agent).toBe("implementer-two");
    expect(secondResult.changeSet.baseline_generation).toBe(1);
    expect(secondResult.changeSet.baseline_manifest_digest).toBe(
      firstResult.result.digest,
    );
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace,
    ).toMatchObject({
      generation: 2,
      manifest_digest: secondResult.result.digest,
      change_sets: [{ id: "change-one" }, { id: "change-two" }],
    });
  });

  it("blocks a released delta outside the literal write roots", async () => {
    const context = await fixture();
    const active = await activate(context);
    await writeFile(
      path.join(context.workspaceRoot, "outside.txt"),
      "outside\n",
    );
    const result = await createWorkspaceManifest(context.workspaceRoot);
    const diff = await gitDiff(context.workspaceRoot, context.commit, result, [
      "?? outside.txt",
    ]);
    await context.lifecycle.beginRevocation(context.acquireInput.id);

    await expect(
      context.lifecycle.release({
        leaseId: context.acquireInput.id,
        changeSetId: "change-outside",
        task: context.task,
        baselineManifest: context.baseline,
        resultManifest: result,
        gitDiff: diff,
        protectedPatterns: context.acquireInput.protectedPatterns,
        restrictedPatterns: context.acquireInput.restrictedPatterns,
        deletedSandboxId: active.sandboxId,
        writableSandboxIds: [],
      }),
    ).rejects.toMatchObject({ code: "write_lease_root_violation" });
    const state = await context.store.readRun(context.lifecycle.runId);
    expect(state.status).toBe("blocked");
    expect(state.workspace).toMatchObject({
      phase: "mutating",
      active_lease: { status: "blocked" },
      change_sets: [],
    });
  });

  it("adopts immutable release evidence after interrupted state publication", async () => {
    const context = await fixture();
    const active = await activate(context);
    await writeFile(
      path.join(context.workspaceRoot, "src", "fixture.ts"),
      "export const fixture = 1;\n",
    );
    const result = await createWorkspaceManifest(context.workspaceRoot);
    const diff = await gitDiff(context.workspaceRoot, context.commit, result, [
      " M src/fixture.ts",
    ]);
    await context.lifecycle.beginRevocation(context.acquireInput.id);
    let fail = true;
    const interrupted = new WorkspaceLifecycle(
      {
        read: () => context.store.read(),
        readRun: (runId) => context.store.readRun(runId),
        runDirectory: (runId) => context.store.runDirectory(runId),
        updateRun: (runId, change) => {
          if (fail) {
            fail = false;
            return Promise.reject(
              new Error("injected state publication failure"),
            );
          }
          return context.store.updateRun(runId, change);
        },
      },
      context.lifecycle.runId,
      () => context.clock.value,
    );
    const request = {
      leaseId: context.acquireInput.id,
      changeSetId: "change-interrupted",
      task: context.task,
      baselineManifest: context.baseline,
      resultManifest: result,
      gitDiff: diff,
      protectedPatterns: context.acquireInput.protectedPatterns,
      restrictedPatterns: context.acquireInput.restrictedPatterns,
      deletedSandboxId: active.sandboxId,
      writableSandboxIds: [],
    } as const;

    await expect(interrupted.release(request)).rejects.toThrow(
      "injected state publication failure",
    );
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace
        ?.active_lease?.status,
    ).toBe("releasing");
    const recovered = await context.lifecycle.release(request);
    expect(recovered.id).toBe("change-interrupted");
    expect(
      (await context.store.readRun(context.lifecycle.runId)).workspace,
    ).toMatchObject({
      phase: "stable",
      generation: 1,
      active_lease: null,
      change_sets: [{ id: "change-interrupted" }],
    });
  });

  it("freezes only without writable Sandboxes and stales all bound evidence on drift", async () => {
    const context = await fixture();
    const active = await activate(context);
    const result = await releaseChanged(
      context,
      context.acquireInput,
      context.baseline,
      "export const fixture = 1;\n",
      "change-one",
      active.sandboxId,
    );
    const freeze = {
      id: "candidate-one",
      task: context.task,
      manifest: result.result,
      gitDiff: result.diff,
      protectedPatterns: context.acquireInput.protectedPatterns,
      restrictedPatterns: context.acquireInput.restrictedPatterns,
      writableSandboxIds: [active.sandboxId],
    };
    await expect(context.lifecycle.freeze(freeze)).rejects.toMatchObject({
      code: "writable_sandbox_present",
    });
    const candidate = await context.lifecycle.freeze({
      ...freeze,
      writableSandboxIds: [],
    });
    expect(candidate).toMatchObject({
      status: "frozen",
      workspace_generation: 1,
      change_sets: [{ id: "change-one" }],
    });
    await expect(
      context.lifecycle.freeze({ ...freeze, writableSandboxIds: [] }),
    ).resolves.toEqual(candidate);

    await context.store.updateRun(context.lifecycle.runId, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        [context.task.id]: {
          ...state.tasks[context.task.id]!,
          gates: Object.fromEntries(
            ["check-project-test", "review-quality", "commit"].map((key) => [
              key,
              {
                status: "pass" as const,
                digest: fixtureDigest,
                updated_at: context.clock.value.toISOString(),
              },
            ]),
          ),
        },
      },
    }));
    await writeFile(
      path.join(context.workspaceRoot, "src", "fixture.ts"),
      "export const fixture = 2;\n",
    );
    const drifted = await createWorkspaceManifest(context.workspaceRoot);
    const driftedDiff = await gitDiff(
      context.workspaceRoot,
      context.commit,
      drifted,
      [" M src/fixture.ts"],
    );
    await expect(
      context.lifecycle.observe({
        manifest: drifted,
        gitDiff: driftedDiff,
        writableSandboxIds: [],
      }),
    ).rejects.toMatchObject({ code: "workspace_changed_without_lease" });

    const state = await context.store.readRun(context.lifecycle.runId);
    expect(state.workspace?.candidate?.status).toBe("stale");
    expect(state.workspace?.candidate?.digest).not.toBe(candidate.digest);
    expect(
      (await context.lifecycle.candidates.list(candidate.id))
        .map((entry) => entry.status)
        .sort(),
    ).toEqual(["frozen", "stale"]);
    expect(
      Object.values(state.tasks[context.task.id]!.gates).map(
        (gate) => gate.status,
      ),
    ).toEqual(["stale", "stale", "stale"]);
  });

  it("blocks an unleased writer even when source digests have not changed", async () => {
    const context = await fixture();
    await expect(
      context.lifecycle.observe({
        manifest: context.baseline,
        gitDiff: context.baselineDiff,
        writableSandboxIds: ["00000000-0000-4000-8000-000000000099"],
      }),
    ).rejects.toMatchObject({ code: "writable_sandbox_without_lease" });

    const state = await context.store.readRun(context.lifecycle.runId);
    expect(state).toMatchObject({
      status: "blocked",
      workspace: {
        drift: {
          expected_manifest_digest: context.baseline.digest,
          observed_manifest_digest: context.baseline.digest,
          reason: expect.stringContaining("without a Write Lease"),
        },
      },
    });
  });
});
