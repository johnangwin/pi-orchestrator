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
import {
  CheckSourceManifestSchema,
  runLegacyCheckForMigration,
  type CheckImage,
  type CheckOpenShell,
  type CheckRecord,
} from "../src/check.js";
import { sha256 } from "../src/digest.js";
import { OrchestratorError } from "../src/error.js";
import {
  type CreateSandboxOptions,
  type OpenShellInferenceRoute,
  type OpenShellPreflight,
  type OpenShellSandbox,
  type ProcessResult,
} from "../src/openshell.js";
import { importPatchArtifact, type VerifiedPatch } from "../src/patch.js";
import { catalogFromConfig, loadPlan, type PlanTask } from "../src/plan.js";
import { loadProject, type Project } from "../src/project.js";
import { AgentRegistry } from "../src/registry.js";
import { startRun } from "../src/run.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { ProjectStore } from "../src/state.js";
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
  readonly home: string;
  readonly project: Project;
  readonly plan: Awaited<ReturnType<typeof loadPlan>>;
  readonly task: PlanTask;
  readonly store: ProjectStore;
  readonly runId: string;
  readonly worktree: string;
  readonly patch: ImportedArtifact<VerifiedPatch>;
  dispose(): Promise<void>;
}

const fixtureCheckImageDigest = sha256("fixture Check image");
export const fixtureCheckImage: CheckImage = {
  source: `fixture-check-image@${fixtureCheckImageDigest}`,
  digest: fixtureCheckImageDigest,
};

class PassingCheckOpenShell implements CheckOpenShell {
  private active: OpenShellSandbox | undefined;
  private marker: { readonly job: string; readonly token: string } | undefined;
  private readonly uploads = new Map<string, Buffer>();

  preflight(): Promise<OpenShellPreflight> {
    return Promise.resolve({
      command: "openshell",
      requiredVersion: "0.0.106",
      installedVersion: "0.0.106",
      versionMatches: true,
      status: {
        authentication: { provider: "fixture", status: "authenticated" },
        gateway: "checks",
        server: "https://openshell.example.test",
        status: "connected",
        version: "0.0.106",
      },
    });
  }

  getInferenceRoute(): Promise<OpenShellInferenceRoute> {
    return Promise.reject(
      new OrchestratorError(
        "openshell_inference_unconfigured",
        "No inference route is configured",
      ),
    );
  }

  listSandboxes(): Promise<OpenShellSandbox[]> {
    return Promise.resolve(this.active ? [this.active] : []);
  }

  createSandbox(options: CreateSandboxOptions): Promise<OpenShellSandbox> {
    const [, action, job, token] = options.command ?? [];
    if (action === "init" && job && token) this.marker = { job, token };
    this.active = {
      ...implementationSandbox,
      id: "f6a44f4e-8ceb-4fa2-b57e-dcf87cc6f87f",
      labels: { ...options.labels },
      name: options.name,
      workspace: "checks",
    };
    return Promise.resolve(this.active);
  }

  waitForSandbox(): Promise<OpenShellSandbox> {
    if (!this.active) throw new Error("No active Check Sandbox");
    return Promise.resolve(this.active);
  }

  deleteSandbox(): Promise<void> {
    this.active = undefined;
    return Promise.resolve();
  }

  async upload(
    _sandbox: string,
    localPath: string,
    sandboxPath: string,
  ): Promise<void> {
    this.uploads.set(sandboxPath, await readFile(localPath));
  }

  execSandbox(
    _sandbox: string,
    command: readonly string[],
  ): Promise<ProcessResult> {
    if (command[0] !== "/usr/local/bin/orchestrator-prepare-check") {
      return Promise.resolve({
        stdout: "fixture Check passed\n",
        stderr: "",
        exitCode: 0,
      });
    }
    const [, action, job, token] = command;
    if (
      !this.marker ||
      this.marker.job !== job ||
      this.marker.token !== token
    ) {
      return Promise.resolve({
        stdout: "",
        stderr: "identity mismatch\n",
        exitCode: 1,
      });
    }
    if (action === "verify") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    const source = this.uploads.get("/sandbox/input/source.json");
    if (action !== "source" || !source) {
      return Promise.resolve({
        stdout: "",
        stderr: "source missing\n",
        exitCode: 1,
      });
    }
    const manifest = CheckSourceManifestSchema.parse(
      JSON.parse(source.toString("utf8")) as unknown,
    );
    return Promise.resolve({
      stdout: `${manifest.source_digest}\n`,
      stderr: "",
      exitCode: 0,
    });
  }
}

export async function passFixtureChecks(
  fixture: AppliedFixture,
): Promise<CheckRecord[]> {
  const client = new PassingCheckOpenShell();
  const records: CheckRecord[] = [];
  for (const check of fixture.task.checks) {
    const result = await runLegacyCheckForMigration({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      runId: fixture.runId,
      taskId: fixture.task.id,
      checkId: check,
      client,
      image: fixtureCheckImage,
      token: () => "a".repeat(64),
      now: () => new Date("2026-08-18T16:00:00.000Z"),
    });
    records.push(result.record);
  }
  return records;
}

export async function createAppliedFixture(
  options: {
    readonly task?: PlanTask;
    readonly tasks?: readonly PlanTask[];
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
    const task = options.task ?? options.tasks?.[0] ?? fixtureTask();
    const tasks = options.tasks ?? [task];
    if (!tasks.some((candidate) => candidate.id === task.id)) {
      throw new Error(`Fixture Task '${task.id}' is absent from its Plan`);
    }
    await createPlan(root, { tasks });
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
          version: 2,
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
        home,
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
