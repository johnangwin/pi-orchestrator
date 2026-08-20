import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiClientConfigSchema,
  resumeReadSession,
  startReadSession,
  type ReadSessionOpenShell,
} from "../src/agent.js";
import { sha256 } from "../src/digest.js";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import { OpenShellMountSet } from "../src/mount.js";
import type {
  CreateSandboxOptions,
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import { compilePlanningBrief } from "../src/planning.js";
import { loadProject } from "../src/project.js";
import {
  createReadOnlySourceWorkspace,
  createRunSourceWorkspace,
  createWorkspaceSourceManifest,
  ReadOnlySourceWorkspace,
  recoverReadOnlySourceWorkspace,
  type WorkspaceSourceDocker,
} from "../src/source.js";
import { DockerVolumeCapability } from "../src/volume.js";
import { createWorkspaceManifestFromEntries } from "../src/workspace.js";
import { startLinkServer } from "../sandbox/pi/client/link.mjs";
import {
  commitFixture,
  createFixtureProject,
  fixtureModelRoute,
  fixturePermissionCeiling,
} from "./fixture.js";

const roots: string[] = [];
const image =
  "pi-orchestrator-pi@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dockerVersion = "29.5.2";
const openshellVersion = "0.0.106";
const helper = fileURLToPath(
  new URL("../sandbox/pi/workspace.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sharedLocal(): LocalConfig {
  return LocalConfigSchema.parse({
    version: 2,
    openshell: {
      command: "openshell",
      required_version: openshellVersion,
      workspace: "default",
      gateways: { code: "openshell-local" },
      images: { pi: image },
      shared_workspace: {
        enabled: true,
        gateway: "openshell-local",
        driver: "docker",
        driver_version: dockerVersion,
        docker_command: "docker",
      },
    },
    workspace: {
      volume_prefix: "pio-test",
      restricted_paths: [],
    },
  });
}

function parseTree(source: Buffer): Array<{
  readonly mode: string;
  readonly object: string;
  readonly path: string;
}> {
  return source
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^([0-7]{6}) blob ([a-f0-9]+)\t(.+)$/.exec(record);
      if (!match) throw new Error(`Unexpected Git tree record: ${record}`);
      return { mode: match[1]!, object: match[2]!, path: match[3]! };
    });
}

class FixtureDocker implements WorkspaceSourceDocker {
  readonly command = "fixture-docker";
  readonly seedCalls: Array<{
    readonly image: string;
    readonly gitDirectory: string;
    readonly commit: string;
  }> = [];
  inspectionCalls = 0;
  private readonly volumes = new Map<
    string,
    { readonly root: string; readonly capability: DockerVolumeCapability }
  >();

  constructor(private readonly root: string) {}

  version(): Promise<string> {
    return Promise.resolve(dockerVersion);
  }

  async createVolume(
    name: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability> {
    const root = path.join(this.root, name);
    await mkdir(root, { recursive: true });
    const capability = DockerVolumeCapability.fromInspection(
      {
        CreatedAt: "2026-08-19T00:00:00Z",
        Driver: "local",
        Labels: labels,
        Mountpoint: root,
        Name: name,
        Options: null,
        Scope: "local",
      },
      name,
      labels,
    );
    this.volumes.set(name, { root, capability });
    return capability;
  }

  inspectVolume(
    name: string,
    labels?: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability | undefined> {
    const capability = this.volumes.get(name)?.capability;
    if (
      capability &&
      labels &&
      Object.entries(labels).some(
        ([key, value]) => capability.labels[key] !== value,
      )
    ) {
      throw new Error("Fixture volume label mismatch");
    }
    return Promise.resolve(capability);
  }

  async seedGitWorkspace(options: {
    readonly volume: DockerVolumeCapability;
    readonly image: string;
    readonly gitDirectory: string;
    readonly commit: string;
  }): Promise<ProcessResult> {
    this.seedCalls.push({
      image: options.image,
      gitDirectory: options.gitDirectory,
      commit: options.commit,
    });
    const target = this.volumes.get(options.volume.name)?.root;
    if (!target) throw new Error("Unknown fixture volume");
    const project = path.join(target, "project");
    await mkdir(project);
    const tree = parseTree(
      execFileSync("git", [
        `--git-dir=${options.gitDirectory}`,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        options.commit,
      ]),
    );
    for (const entry of tree) {
      const destination = path.join(project, ...entry.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      const content = execFileSync("git", [
        `--git-dir=${options.gitDirectory}`,
        "cat-file",
        "blob",
        entry.object,
      ]);
      if (entry.mode === "120000") {
        await symlink(content.toString("utf8"), destination);
      } else {
        const mode = entry.mode === "100755" ? 0o755 : 0o644;
        await writeFile(destination, content, { mode });
        await chmod(destination, mode);
      }
    }
    await mkdir(path.join(target, "control", "masks", "empty-directory"), {
      recursive: true,
    });
    await writeFile(
      path.join(target, "control", "masks", "opaque-file"),
      "restricted\n",
    );
    return { stdout: "{}\n", stderr: "", exitCode: 0 };
  }

  inspectWorkspaceVolume(options: {
    readonly volume: DockerVolumeCapability;
  }): Promise<ProcessResult> {
    this.inspectionCalls += 1;
    const target = this.volumes.get(options.volume.name)?.root;
    if (!target) {
      return Promise.resolve({ stdout: "", stderr: "missing", exitCode: 1 });
    }
    try {
      return Promise.resolve({
        stdout: execFileSync(
          process.execPath,
          [helper, "inspect", path.join(target, "project")],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
        stderr: "",
        exitCode: 0,
      });
    } catch (error) {
      return Promise.resolve({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
    }
  }

  inspectWorkspaceGitStatus(): Promise<ProcessResult> {
    return Promise.resolve({
      stdout: "",
      stderr: "Fixture Git status is not configured",
      exitCode: 1,
    });
  }

  async removeVolume(name: string): Promise<void> {
    const found = this.volumes.get(name);
    if (!found) return;
    this.volumes.delete(name);
    await rm(found.root, { recursive: true, force: true });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function sandbox(name: string): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-19T00:00:00Z",
    current_policy_version: 1,
    id: "43502221-db6b-49f2-a316-673792b3faae",
    labels: {},
    name,
    phase: "Ready",
    resource_version: 1,
    workspace: "default",
  };
}

function mountInfo(
  mounts: ReadonlyArray<{
    readonly target: string;
    readonly subpath: string;
    readonly readOnly: boolean;
  }>,
): string {
  return mounts
    .map(
      (mount, index) =>
        `${100 + index} 1 0:42 /${mount.subpath} ${mount.target} ${mount.readOnly ? "ro" : "rw"},relatime - ext4 /dev/docker ${mount.readOnly ? "ro" : "rw"},relatime`,
    )
    .join("\n");
}

describe("read-only Workspace source", () => {
  it("reopens a bound Run volume without inspecting mutable contents", async () => {
    const projectRoot = await createFixtureProject();
    const volumeRoot = await mkdtemp(
      path.join(os.tmpdir(), "pio-run-volume-test-"),
    );
    roots.push(projectRoot, volumeRoot);
    const commit = await commitFixture(projectRoot);
    const docker = new FixtureDocker(volumeRoot);
    const created = await createRunSourceWorkspace({
      projectRoot,
      projectId: "fixture",
      runId: "run-one",
      commit,
      local: sharedLocal(),
      docker,
    });
    const inspections = docker.inspectionCalls;
    const recovered = await createRunSourceWorkspace({
      projectRoot,
      projectId: "fixture",
      runId: "run-one",
      commit,
      local: sharedLocal(),
      binding: {
        volumeName: created.volume.name,
        volumeDigest: created.volume.digest,
      },
      docker,
    });

    expect(recovered.volume.digest).toBe(created.volume.digest);
    expect(docker.inspectionCalls).toBe(inspections);
  });

  it("materializes an exact commit without Git metadata and compiles restricted masks", async () => {
    const projectRoot = await createFixtureProject();
    await writeFile(
      path.join(projectRoot, "src", "tool.sh"),
      "#!/bin/sh\necho fixture\n",
      { mode: 0o755 },
    );
    await chmod(path.join(projectRoot, "src", "tool.sh"), 0o755);
    await symlink(
      "fixture.ts",
      path.join(projectRoot, "src", "current-fixture.ts"),
    );
    const volumeRoot = await mkdtemp(
      path.join(os.tmpdir(), "pio-volume-test-"),
    );
    roots.push(projectRoot, volumeRoot);
    const commit = await commitFixture(projectRoot);
    const docker = new FixtureDocker(volumeRoot);
    const workspace = await createReadOnlySourceWorkspace({
      projectRoot,
      projectId: "fixture",
      workspaceId: "planning-one",
      commit,
      local: sharedLocal(),
      restrictedPaths: ["AGENTS.md", ".agents/**"],
      docker,
      suffix: () => "abcdef12",
    });

    expect(workspace.manifest.commit).toBe(commit);
    expect(workspace.manifest.workspace_generation).toBe(0);
    expect(
      workspace.manifest.entries.some((entry) => entry.path === ".git"),
    ).toBe(false);
    expect(
      workspace.manifest.entries.some(
        (entry) => entry.path === ".pi/orchestrator.local.yaml",
      ),
    ).toBe(false);
    expect(workspace.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/tool.sh", type: "executable" }),
        expect.objectContaining({
          path: "src/current-fixture.ts",
          type: "symlink",
        }),
      ]),
    );
    expect(docker.seedCalls).toEqual([
      {
        image,
        gitDirectory: await realpath(path.join(projectRoot, ".git")),
        commit,
      },
    ]);
    expect(workspace.mountSet.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "/workspace/project",
          subpath: "project",
          readOnly: true,
          purpose: "workspace",
        }),
        expect.objectContaining({
          target: "/workspace/project/AGENTS.md",
          subpath: "control/masks/opaque-file",
          purpose: "restricted-file-mask",
        }),
        expect.objectContaining({
          target: "/workspace/project/.agents",
          subpath: "control/masks/empty-directory",
          purpose: "restricted-directory-mask",
        }),
      ]),
    );
    expect(
      () =>
        new ReadOnlySourceWorkspace(
          workspace.manifest,
          workspace.volume,
          OpenShellMountSet.forVolume({
            volume: workspace.volume,
            writePaths: ["src"],
          }),
          workspace.image,
          workspace.driverVersion,
          workspace.labels,
          docker,
        ),
    ).toThrow("writable or unrelated mounts");
    await expect(workspace.verify()).resolves.toEqual(workspace.manifest);
    await writeFile(
      path.join(workspace.volume.mountpoint, "project", "src", "fixture.ts"),
      "export const fixture = false;\n",
    );
    await expect(workspace.verify()).rejects.toMatchObject({
      code: "workspace_source_stale",
    });
    await workspace.dispose();
    await expect(workspace.verify()).rejects.toMatchObject({
      code: "workspace_removed",
    });
  });

  it("changes the planning Brief when the Workspace generation advances", async () => {
    const projectRoot = await createFixtureProject();
    roots.push(projectRoot);
    const commit = await commitFixture(projectRoot);
    const project = await loadProject(projectRoot);
    const entries = createWorkspaceManifestFromEntries([
      {
        path: "src/fixture.ts",
        type: "regular",
        byte_count: 29,
        content_digest: sha256("export const fixture = true;\n"),
      },
    ]);
    const source0 = createWorkspaceSourceManifest(commit, 0, entries);
    const source1 = createWorkspaceSourceManifest(commit, 1, entries);
    const role = project.roles.get("lead");
    if (!role) throw new Error("Fixture Lead Role is missing");
    const common = {
      identity: {
        run: "planning-one",
        agent: "lead",
        session: "planning-session",
        generation: 1,
      },
      project,
      role,
      permissionCeiling: fixturePermissionCeiling({ kind: "run" }, "lead"),
      model: fixtureModelRoute(
        "frontier-lead",
        { context_window: 100_000, max_tokens: 8_192 },
        "openshell-local",
      ),
      goal: "Inspect the fixture.",
      contextLimitTokens: 100_000,
    } as const;

    const first = compilePlanningBrief({ ...common, source: source0 });
    const second = compilePlanningBrief({ ...common, source: source1 });
    expect(source0.source_digest).not.toBe(source1.source_digest);
    expect(first.digest).not.toBe(second.digest);
    expect(second.content).toContain(source1.source_digest);
  });

  it("starts and recovers a static-image Session from exact mount provenance", async () => {
    const projectRoot = await createFixtureProject();
    const volumeRoot = await mkdtemp(
      path.join(os.tmpdir(), "pio-volume-test-"),
    );
    roots.push(projectRoot, volumeRoot);
    const commit = await commitFixture(projectRoot);
    const docker = new FixtureDocker(volumeRoot);
    const workspace = await createReadOnlySourceWorkspace({
      projectRoot,
      projectId: "fixture",
      workspaceId: "planning-one",
      commit,
      local: sharedLocal(),
      restrictedPaths: [".agents/**"],
      docker,
      suffix: () => "abcdef12",
    });
    const port = await availablePort();
    const identity = {
      run: "planning-one",
      agent: "lead",
      session: "planning-session",
      generation: 1,
    } as const;
    const permissionCeiling = fixturePermissionCeiling({ kind: "run" }, "lead");
    const model = fixtureModelRoute(
      "frontier-lead",
      { context_window: 100_000, max_tokens: 8_192 },
      "openshell-local",
    );
    const brief = {
      content: "# Workspace Brief\n",
      digest: sha256("# Workspace Brief\n"),
    };
    const preflight: OpenShellPreflight = {
      command: "openshell",
      requiredVersion: openshellVersion,
      installedVersion: openshellVersion,
      versionMatches: true,
      status: {
        authentication: { provider: "mTLS", status: "authenticated" },
        gateway: "openshell-local",
        server: "https://127.0.0.1:17670",
        status: "connected",
        version: openshellVersion,
      },
    };
    const created = sandbox("pio-workspace-read");
    const uploads: string[] = [];
    let createOptions: CreateSandboxOptions | undefined;
    let config: ReturnType<typeof PiClientConfigSchema.parse> | undefined;
    let boundary = "";
    let observedMountInfo = mountInfo(workspace.mountSet.mounts);
    const client: ReadSessionOpenShell & {
      readonly gateway: string;
      getSandbox(name: string): Promise<OpenShellSandbox>;
    } = {
      gateway: "openshell-local",
      preflight: () => Promise.resolve(preflight),
      getInferenceRoute: () =>
        Promise.resolve({ provider: "fixture", model: model.pi_model }),
      listGateways: () =>
        Promise.resolve([
          {
            active: true,
            auth: "mtls",
            endpoint: preflight.status.server,
            is_remote: false,
            name: "openshell-local",
            remote_host: null,
            resolved_host: "127.0.0.1",
            source: "fixture",
            type: "local",
          },
        ]),
      getGatewayInfo: () =>
        Promise.resolve({
          auth: null,
          compute_drivers: [
            {
              capabilities: {
                driver_name: "docker",
                driver_version: dockerVersion,
              },
              name: "docker",
            },
          ],
          gateway: "openshell-local",
          server: preflight.status.server,
          status: "healthy",
          version: openshellVersion,
        }),
      async createSandbox(options) {
        createOptions = options;
        return created;
      },
      waitForSandbox: () => Promise.resolve(created),
      getSandbox: () => Promise.resolve(created),
      async upload(_name, localPath, sandboxPath) {
        uploads.push(sandboxPath);
        if (sandboxPath.endsWith("/session.json")) {
          config = PiClientConfigSchema.parse(
            JSON.parse(await readFile(localPath, "utf8")) as unknown,
          );
        }
      },
      execSandbox(_name, command) {
        if (
          command[0] === "/usr/bin/cat" &&
          command[1] === "/proc/self/mountinfo"
        ) {
          return Promise.resolve({
            stdout: observedMountInfo,
            stderr: "",
            exitCode: 0,
          });
        }
        if (
          command[0] === "/bin/cat" &&
          command[1] === "/workspace/input/session.json"
        ) {
          return Promise.resolve({
            stdout: JSON.stringify(config),
            stderr: "",
            exitCode: 0,
          });
        }
        if (command[0] === "/bin/sh") boundary = command[2] ?? "";
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startServiceForward(): Promise<OpenShellForward> {
        if (!config) throw new Error("Session config was not uploaded");
        const server = await startLinkServer({ config, deliver() {} });
        return {
          sandboxName: created.name,
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: () => server.close(),
        };
      },
      deleteSandbox: () => Promise.resolve(),
    };

    try {
      const session = await startReadSession({
        client,
        identity,
        workspace,
        permissionCeiling,
        model,
        brief,
        linkPort: port,
        sandboxName: created.name,
      });
      expect(createOptions).toMatchObject({
        from: image,
        mountSet: workspace.mountSet,
        command: ["/usr/bin/true"],
      });
      expect(uploads).toEqual([
        "/workspace/input/session.json",
        "/workspace/input/brief.md",
      ]);
      expect(JSON.stringify(config)).not.toContain(projectRoot);
      expect(config).not.toHaveProperty("snapshot");
      expect(config?.workspace_projection).toEqual(
        session.info.workspaceProjection,
      );
      expect(boundary).not.toContain("snapshot.json");
      expect(boundary).toContain(
        config!.brief!.content_digest.slice("sha256:".length),
      );
      expect(boundary).toContain("test ! -e /workspace/project/.git");
      expect(boundary).toContain("! touch /workspace/project");
      await session.stop();

      await expect(
        recoverReadOnlySourceWorkspace({
          projectId: "another-project",
          workspaceId: "planning-one",
          manifest: workspace.manifest,
          projection: session.info.workspaceProjection!,
          local: sharedLocal(),
          restrictedPaths: [".agents/**"],
          docker,
        }),
      ).rejects.toThrow("label mismatch");
      const recoveredWorkspace = await recoverReadOnlySourceWorkspace({
        projectId: "fixture",
        workspaceId: "planning-one",
        manifest: workspace.manifest,
        projection: session.info.workspaceProjection!,
        local: sharedLocal(),
        restrictedPaths: [".agents/**"],
        docker,
      });
      const recovered = await resumeReadSession({
        client,
        identity,
        sandbox: {
          id: session.info.sandbox.id,
          name: session.info.sandbox.name,
          workspace: session.info.sandbox.workspace,
          projection: session.info.sandbox.projection,
        },
        permissionCeilingDigest: permissionCeiling.permission_ceiling_digest,
        model,
        briefDigest: brief.digest,
        workspace: recoveredWorkspace,
      });
      expect(recovered.info.workspaceProjection).toEqual(
        session.info.workspaceProjection,
      );
      await expect(recovered.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      await recovered.stop();

      observedMountInfo = observedMountInfo.replace(
        " /project ",
        " /another-project ",
      );
      await expect(
        resumeReadSession({
          client,
          identity,
          sandbox: {
            id: session.info.sandbox.id,
            name: session.info.sandbox.name,
            workspace: session.info.sandbox.workspace,
            projection: session.info.sandbox.projection,
          },
          permissionCeilingDigest: permissionCeiling.permission_ceiling_digest,
          model,
          briefDigest: brief.digest,
          workspace: recoveredWorkspace,
        }),
      ).rejects.toMatchObject({ code: "mount_table_mismatch" });
    } finally {
      await workspace.dispose();
    }
  });
});
