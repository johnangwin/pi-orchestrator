import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTaskPatch,
  loadPreparedPatch,
  type PatchApplicationStore,
} from "../src/apply.js";
import { createApproval } from "../src/approval.js";
import {
  ArtifactStore,
  type ArtifactDescriptor,
  type ArtifactOpenShell,
} from "../src/artifact.js";
import { sha256 } from "../src/digest.js";
import { importPatchArtifact } from "../src/patch.js";
import { catalogFromConfig, loadPlan, type PlanTask } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { AgentRegistry } from "../src/registry.js";
import { startRun } from "../src/run.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { ProjectStore } from "../src/state.js";
import type { OpenShellSandbox } from "../src/openshell.js";
import { exportPatch } from "../sandbox/pi/export.mjs";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixtureModelRoute,
  fixturePermissionCeiling,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
  fixtureTask,
} from "./fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const stores: ProjectStore[] = [];
const sourceSandbox: OpenShellSandbox = {
  annotations: {},
  created_at: "2026-08-18 10:00:00",
  current_policy_version: 1,
  id: "53502221-db6b-49f2-a316-673792b3faae",
  labels: {},
  name: "pio-write-one",
  phase: "Ready",
  resource_version: 1,
  workspace: "default",
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

async function extract(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar", ["-xf", archive, "-C", destination]);
}

function copyingClient(payloadPath: string): ArtifactOpenShell {
  return {
    getSandbox: vi.fn(() => Promise.resolve(sourceSandbox)),
    execSandbox: vi.fn(async (_sandbox, command) => {
      const bytes = await readFile(payloadPath);
      if (command[0] === "/usr/bin/stat") {
        return {
          stdout: `regular file\t${bytes.byteLength}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: `${sha256(bytes).slice("sha256:".length)}  ${command.at(-1)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }),
    download: vi.fn(async (_sandbox, _source, destination) => {
      await copyFile(payloadPath, destination);
    }),
  };
}

async function fixture(options: {
  readonly task?: PlanTask;
  readonly mutate: (project: string) => Promise<void>;
}) {
  const root = await createFixtureProject();
  roots.push(root);
  const task = options.task ?? fixtureTask();
  await createPlan(root, { tasks: [task] });
  const commit = await commitFixture(root);
  const project = await loadProject(root);
  const plan = await loadPlan(
    path.join(root, "docs", "plans", "fixture-plan"),
    catalogFromConfig(project.config),
  );
  const home = await temporary("pi-apply-state-");
  const worktreeRoot = await temporary("pi-apply-worktrees-");
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
    }),
  );
  const started = await startRun({ store, project, plan, worktreeRoot });
  const registry = new AgentRegistry(store, started.run.id);
  await registry.register({
    agent: "implementer",
    role: task.role,
    profile: "local-code",
  });
  const session = await registry.start({
    agent: "implementer",
    session: "implementation-one",
    route: fixtureModelRoute(),
    permissionCeilingDigest: fixturePermissionCeiling(
      { kind: "task", task: task.id },
      task.role,
    ).permission_ceiling_digest,
  });
  await registry.bindSandbox(session.identity, {
    id: sourceSandbox.id,
    name: sourceSandbox.name,
    workspace: sourceSandbox.workspace,
  });
  await registry.transition(session.identity, { status: "active" });
  await store.updateRun(started.run.id, (run) => {
    return {
      ...run,
      status: "active",
      tasks: {
        ...run.tasks,
        [task.id]: { ...run.tasks[task.id]!, status: "active" },
      },
    };
  });

  const snapshot = await createSourceSnapshot({
    projectRoot: root,
    commit,
    paths: ["."],
  });
  const workspace = await temporary("pi-apply-export-");
  await Promise.all([
    extract(snapshot.archivePath, path.join(workspace, "base")),
    extract(snapshot.archivePath, path.join(workspace, "project")),
  ]);
  const sessionConfigPath = path.join(workspace, "session.json");
  await writeFile(
    sessionConfigPath,
    JSON.stringify({
      version: 2,
      identity: session.identity,
      profile: "write",
      source_digest: snapshot.manifest.source_digest,
    }),
  );
  await options.mutate(path.join(workspace, "project"));
  const exported = await exportPatch({
    artifactId: "implementation-patch",
    task: task.id,
    workspaceRoot: workspace,
    sessionConfigPath,
    outputRoot: path.join(workspace, "output"),
  });
  const artifacts = new ArtifactStore(store.runDirectory(started.run.id));
  const imported = await importPatchArtifact({
    store: artifacts,
    client: copyingClient(exported.artifactPath),
    descriptor: exported.descriptor as ArtifactDescriptor,
    identity: session.identity,
    task: task.id,
    sourceSandbox,
    snapshot,
  });
  await snapshot.dispose();
  return {
    root,
    project,
    plan,
    task,
    store,
    runId: started.run.id,
    worktree: started.run.worktree,
    imported,
  };
}

async function status(root: string): Promise<string> {
  return execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  ).then((result) => result.stdout);
}

describe("verified Patch application", () => {
  it("applies an in-scope Patch only to the Run worktree and recovers idempotently", async () => {
    const value = await fixture({
      mutate: (project) =>
        writeFile(
          path.join(project, "src", "fixture.ts"),
          "export const fixture = 'changed';\n",
        ),
    });
    const first = await applyTaskPatch({
      store: value.store,
      project: value.project,
      plan: value.plan,
      runId: value.runId,
      taskId: value.task.id,
      patch: value.imported,
      now: new Date("2026-08-18T15:00:00.000Z"),
    });

    expect(first).toMatchObject({
      created: true,
      recovered: false,
      task: {
        status: "checking",
        implementation_attempts: 1,
        patch_application: {
          state: "applied",
          changed_paths: ["src/fixture.ts"],
        },
      },
    });
    expect(first.task.diff_digest).toBe(first.application.host_diff_digest);
    expect(first.task.output_source_digest).toBe(
      value.imported.value.bundle.result_tree_digest,
    );
    expect(
      await readFile(path.join(value.worktree, "src", "fixture.ts"), "utf8"),
    ).toBe("export const fixture = 'changed';\n");
    expect(
      await readFile(path.join(value.root, "src", "fixture.ts"), "utf8"),
    ).toBe("export const fixture = true;\n");
    expect(await status(value.worktree)).toBe(" M src/fixture.ts\0");
    expect(await status(value.root)).toBe("");

    const retried = await applyTaskPatch({
      store: value.store,
      project: value.project,
      plan: value.plan,
      runId: value.runId,
      taskId: value.task.id,
      patch: value.imported,
      now: new Date("2026-08-18T16:00:00.000Z"),
    });
    expect(retried).toMatchObject({ created: false, recovered: true });
    expect(retried.task.implementation_attempts).toBe(1);
    expect(retried.application).toEqual(first.application);
  });

  it("rejects protected paths before persisting or changing the worktree", async () => {
    const value = await fixture({
      task: fixtureTask({ scope: ["**"] }),
      mutate: (project) =>
        writeFile(path.join(project, "AGENTS.md"), "changed policy\n"),
    });
    await expect(
      applyTaskPatch({
        store: value.store,
        project: value.project,
        plan: value.plan,
        runId: value.runId,
        taskId: value.task.id,
        patch: value.imported,
      }),
    ).rejects.toMatchObject({ code: "protected_path_change" });
    expect(await status(value.worktree)).toBe("");
    expect(
      (await value.store.readRun(value.runId)).tasks[value.task.id],
    ).toMatchObject({
      status: "active",
      implementation_attempts: 0,
    });
    expect(
      (await value.store.readRun(value.runId)).tasks[value.task.id]
        ?.patch_application,
    ).toBeUndefined();
  });

  it("rejects paths outside Task scope before persisting or changing the worktree", async () => {
    const value = await fixture({
      mutate: (project) =>
        writeFile(
          path.join(project, "docs", "decisions", "README.md"),
          "outside scope\n",
        ),
    });
    await expect(
      applyTaskPatch({
        store: value.store,
        project: value.project,
        plan: value.plan,
        runId: value.runId,
        taskId: value.task.id,
        patch: value.imported,
      }),
    ).rejects.toMatchObject({ code: "scope_exception" });
    expect(await status(value.worktree)).toBe("");
    expect(
      (await value.store.readRun(value.runId)).tasks[value.task.id]
        ?.patch_application,
    ).toBeUndefined();
  });

  it("recovers an exact Git result after a crash before the applied state write", async () => {
    const value = await fixture({
      mutate: (project) =>
        writeFile(
          path.join(project, "src", "fixture.ts"),
          "export const fixture = 'recovered';\n",
        ),
    });
    let updates = 0;
    const crashingStore: PatchApplicationStore = {
      read: () => value.store.read(),
      readRun: (runId) => value.store.readRun(runId),
      updateRun: (runId, change) => {
        updates += 1;
        if (updates === 2) return Promise.reject(new Error("injected crash"));
        return value.store.updateRun(runId, change);
      },
    };
    await expect(
      applyTaskPatch({
        store: crashingStore,
        project: value.project,
        plan: value.plan,
        runId: value.runId,
        taskId: value.task.id,
        patch: value.imported,
        now: new Date("2026-08-18T15:00:00.000Z"),
      }),
    ).rejects.toThrow("injected crash");
    const preparedTask = (await value.store.readRun(value.runId)).tasks[
      value.task.id
    ]!;
    expect(preparedTask).toMatchObject({
      status: "active",
      implementation_attempts: 1,
      patch_application: { state: "prepared" },
    });
    expect(await status(value.worktree)).toBe(" M src/fixture.ts\0");

    const reloaded = await loadPreparedPatch({
      store: new ArtifactStore(value.store.runDirectory(value.runId)),
      projectRoot: value.project.root,
      application: preparedTask.patch_application!,
    });

    const recovered = await applyTaskPatch({
      store: value.store,
      project: value.project,
      plan: value.plan,
      runId: value.runId,
      taskId: value.task.id,
      patch: reloaded,
      now: new Date("2026-08-18T16:00:00.000Z"),
    });
    expect(recovered).toMatchObject({
      created: false,
      recovered: true,
      task: { status: "checking", implementation_attempts: 1 },
    });
    expect(recovered.application.prepared_at).toBe("2026-08-18T15:00:00.000Z");
    expect(recovered.application.applied_at).toBe("2026-08-18T16:00:00.000Z");
  });

  it("fails closed on post-application drift without repairing the worktree", async () => {
    const value = await fixture({
      mutate: (project) =>
        writeFile(
          path.join(project, "src", "fixture.ts"),
          "export const fixture = 'expected';\n",
        ),
    });
    await applyTaskPatch({
      store: value.store,
      project: value.project,
      plan: value.plan,
      runId: value.runId,
      taskId: value.task.id,
      patch: value.imported,
    });
    await writeFile(
      path.join(value.worktree, "src", "fixture.ts"),
      "export const fixture = 'drift';\n",
    );

    await expect(
      applyTaskPatch({
        store: value.store,
        project: value.project,
        plan: value.plan,
        runId: value.runId,
        taskId: value.task.id,
        patch: value.imported,
      }),
    ).rejects.toMatchObject({ code: "worktree_result_mismatch" });
    expect(
      await readFile(path.join(value.worktree, "src", "fixture.ts"), "utf8"),
    ).toBe("export const fixture = 'drift';\n");
    expect(
      (await value.store.readRun(value.runId)).tasks[value.task.id],
    ).toMatchObject({
      status: "checking",
      implementation_attempts: 1,
      patch_application: { state: "applied" },
    });
  });
});
