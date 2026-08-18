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
import { parse, stringify } from "yaml";
import { applyTaskPatch } from "../src/apply.js";
import { createApproval } from "../src/approval.js";
import {
  ArtifactStore,
  type ArtifactDescriptor,
  type ArtifactOpenShell,
  type ImportedArtifact,
} from "../src/artifact.js";
import { sha256 } from "../src/digest.js";
import { type OpenShellSandbox } from "../src/openshell.js";
import { importPatchArtifact, type VerifiedPatch } from "../src/patch.js";
import { catalogFromConfig, loadPlan, type PlanTask } from "../src/plan.js";
import { loadProject, type Project } from "../src/project.js";
import { SeatRegistry } from "../src/registry.js";
import { startRun } from "../src/run.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { ProjectStore } from "../src/state.js";
import { exportPatch } from "../sandbox/pi/export.mjs";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixtureTask,
} from "./fixture.js";

const execFileAsync = promisify(execFile);

export const implementationSandbox: OpenShellSandbox = {
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

async function temporary(prefix: string, roots: string[]): Promise<string> {
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
    getSandbox: async () => implementationSandbox,
    execSandbox: async (_sandbox, command) => {
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
    },
    download: async (_sandbox, _source, destination) => {
      await copyFile(payloadPath, destination);
    },
  };
}

export interface AppliedFixture {
  readonly root: string;
  readonly project: Project;
  readonly plan: Awaited<ReturnType<typeof loadPlan>>;
  readonly task: PlanTask;
  readonly store: ProjectStore;
  readonly runId: string;
  readonly worktree: string;
  readonly patch: ImportedArtifact<VerifiedPatch>;
  dispose(): Promise<void>;
}

export async function createAppliedFixture(
  options: {
    readonly task?: PlanTask;
    readonly mutate?: (project: string) => Promise<void>;
    readonly checks?: Readonly<
      Record<
        string,
        { readonly argv: readonly string[]; readonly cwd?: string }
      >
    >;
  } = {},
): Promise<AppliedFixture> {
  const roots: string[] = [];
  let store: ProjectStore | undefined;
  try {
    const root = await createFixtureProject();
    roots.push(root);
    if (options.checks) {
      const configPath = path.join(root, ".agents", "orchestrator.yaml");
      const config = parse(await readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      config.checks = options.checks;
      await writeFile(configPath, stringify(config), "utf8");
    }
    const task = options.task ?? fixtureTask();
    await createPlan(root, { tasks: [task] });
    const commit = await commitFixture(root);
    const project = await loadProject(root);
    const plan = await loadPlan(
      path.join(root, "docs", "plans", "fixture-plan"),
      catalogFromConfig(project.config),
    );
    const home = await temporary("pi-check-state-", roots);
    const worktreeRoot = await temporary("pi-check-worktrees-", roots);
    store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    await store.recordApproval(
      createApproval({ plan, baseCommit: commit, approvedBy: "fixture" }),
    );
    const started = await startRun({ store, project, plan, worktreeRoot });
    const registry = new SeatRegistry(store, started.run.id);
    await registry.register({
      seat: "implementer",
      role: task.role,
      model: "code",
    });
    const session = await registry.start({
      seat: "implementer",
      session: "implementation-one",
    });
    await registry.bindSandbox(session.identity, {
      id: implementationSandbox.id,
      name: implementationSandbox.name,
      workspace: implementationSandbox.workspace,
    });
    await registry.transition(session.identity, { status: "active" });
    await store.updateRun(started.run.id, (run) => ({
      ...run,
      status: "active",
      tasks: {
        ...run.tasks,
        [task.id]: { ...run.tasks[task.id]!, status: "active" },
      },
    }));

    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["."],
    });
    const workspace = await temporary("pi-check-export-", roots);
    try {
      await Promise.all([
        extract(snapshot.archivePath, path.join(workspace, "base")),
        extract(snapshot.archivePath, path.join(workspace, "project")),
      ]);
      const sessionConfigPath = path.join(workspace, "session.json");
      await writeFile(
        sessionConfigPath,
        JSON.stringify({
          version: 1,
          identity: session.identity,
          profile: "write",
          source_digest: snapshot.manifest.source_digest,
        }),
      );
      await (
        options.mutate ??
        ((projectRoot) =>
          writeFile(
            path.join(projectRoot, "src", "fixture.ts"),
            "export const fixture = 'checked';\n",
          ))
      )(path.join(workspace, "project"));
      const exported = await exportPatch({
        artifactId: "implementation-patch",
        task: task.id,
        workspaceRoot: workspace,
        sessionConfigPath,
        outputRoot: path.join(workspace, "output"),
      });
      const artifacts = new ArtifactStore(store.runDirectory(started.run.id));
      const patch = await importPatchArtifact({
        store: artifacts,
        client: copyingClient(exported.artifactPath),
        descriptor: exported.descriptor as ArtifactDescriptor,
        identity: session.identity,
        task: task.id,
        sourceSandbox: implementationSandbox,
        snapshot,
      });
      await applyTaskPatch({
        store,
        project,
        plan,
        runId: started.run.id,
        taskId: task.id,
        patch,
        now: new Date("2026-08-18T15:00:00.000Z"),
      });
      return {
        root,
        project,
        plan,
        task,
        store,
        runId: started.run.id,
        worktree: started.run.worktree,
        patch,
        async dispose() {
          await store?.close();
          await Promise.all(
            roots.map((directory) =>
              rm(directory, { recursive: true, force: true }),
            ),
          );
        },
      };
    } finally {
      await snapshot.dispose();
    }
  } catch (error) {
    await store?.close().catch(() => undefined);
    await Promise.all(
      roots.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }
}
