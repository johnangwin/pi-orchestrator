import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SharedWorkspaceSettings } from "../src/local.js";
import type { OpenShellMountSet } from "../src/mount.js";
import type {
  CreateSandboxOptions,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import {
  parseLinuxMountInfo,
  runWorkspaceVolumeCanary,
  type WorkspaceVolumeDocker,
  type WorkspaceVolumeOpenShell,
} from "../src/proof.js";
import {
  DockerVolumeCapability,
  type RunVolumeOptions,
} from "../src/volume.js";

const roots: string[] = [];

const writerIds = [
  "unprivileged-uid",
  "unprivileged-groups",
  "workspace-readable",
  "root-read-only",
  "sibling-read-only",
  "protected-read-only",
  "write-create",
  "write-replace",
  "write-rename",
  "write-delete",
  "git-absent",
  "git-create-denied",
  "restricted-file-masked",
  "restricted-directory-masked",
  "volume-control-inaccessible",
  "shared-write-created",
  "openshell-token-inaccessible",
  "openshell-key-inaccessible",
  "docker-socket-absent",
  "host-sentinel-inaccessible",
  "host-home-inaccessible",
  "host-state-inaccessible",
  "host-checkout-inaccessible",
  "sibling-repositories-inaccessible",
  "volume-source-inaccessible",
  "host-ssh-agent-inaccessible",
  "host-credentials-absent",
  "external-network-denied",
  "host-gateway-denied",
  "privileged-mount-denied",
];

const readerIds = [
  "shared-write-visible",
  "reader-root-read-only",
  "reader-task-read-only",
];

function output(ids: readonly string[]): ProcessResult {
  return {
    exitCode: 0,
    stdout: `${ids.map((id) => `${id}\tpass`).join("\n")}\n`,
    stderr: "",
  };
}

function sandbox(name: string, index: number): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-19T12:00:00Z",
    current_policy_version: 1,
    id: `43502221-db6b-49f2-a316-673792b3fa0${index}`,
    labels: {},
    name,
    phase: "Ready",
    resource_version: 1,
    workspace: "default",
  };
}

function escapeMountField(value: string): string {
  return value.replaceAll(" ", "\\040");
}

class FakeDocker implements WorkspaceVolumeDocker {
  readonly command = "docker";
  readonly root: string;
  exists = false;
  versionValue = "29.5.2";
  capability: DockerVolumeCapability | undefined;

  constructor(root: string) {
    this.root = root;
  }

  version() {
    return Promise.resolve(this.versionValue);
  }

  async createVolume(name: string, labels: Readonly<Record<string, string>>) {
    this.exists = true;
    await mkdir(this.root, { recursive: true });
    this.capability = DockerVolumeCapability.fromInspection(
      {
        CreatedAt: "2026-08-19T12:00:00Z",
        Driver: "local",
        Labels: labels,
        Mountpoint: this.root,
        Name: name,
        Options: null,
        Scope: "local",
      },
      name,
      labels,
    );
    return this.capability;
  }

  inspectVolume() {
    return Promise.resolve(this.exists ? this.capability : undefined);
  }

  async runVolume(options: RunVolumeOptions) {
    if (options.command[0] === "/bin/sh") {
      const token = options.command.at(-1);
      if (!token) throw new Error("missing seed token");
      await mkdir(path.join(this.root, "project", "task", "protected"), {
        recursive: true,
      });
      await mkdir(path.join(this.root, "project", "sibling"), {
        recursive: true,
      });
      await mkdir(path.join(this.root, "project", "restricted-dir"), {
        recursive: true,
      });
      await mkdir(path.join(this.root, "git"), { recursive: true });
      await mkdir(path.join(this.root, "control", "masks", "empty-directory"), {
        recursive: true,
      });
      await writeFile(
        path.join(this.root, "project", "visible.txt"),
        "visible\n",
      );
      await writeFile(
        path.join(this.root, "project", "task", "protected", "protected.txt"),
        "protected\n",
      );
      await writeFile(path.join(this.root, "git", "secret"), `${token}\n`);
      await writeFile(
        path.join(this.root, "control", "masks", "opaque-file"),
        "pi-orchestrator opaque mount\n",
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (options.command[0] === "/bin/cat") {
      return {
        stdout: await readFile(
          path.join(this.root, "project", "task", "shared.txt"),
          "utf8",
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    throw new Error(`unexpected helper command: ${options.command.join(" ")}`);
  }

  removeVolume() {
    this.exists = false;
    return Promise.resolve();
  }
}

class FakeWorkspaceVolumeClient implements WorkspaceVolumeOpenShell {
  readonly gateway = "openshell";
  readonly active = new Map<
    string,
    { readonly sandbox: OpenShellSandbox; readonly mountSet: OpenShellMountSet }
  >();
  readonly creates: string[] = [];
  driverVersion = "29.5.2";
  rootMode: "ro" | "rw" = "ro";
  createError: Error | undefined;

  preflight() {
    return Promise.resolve({
      command: "openshell",
      requiredVersion: "0.0.106",
      installedVersion: "0.0.106",
      versionMatches: true,
      status: {
        authentication: {
          provider: "mTLS transport",
          status: "authenticated",
        },
        gateway: this.gateway,
        server: "https://localhost:17670",
        status: "connected",
        version: "0.0.106",
      },
    });
  }

  listGateways() {
    return Promise.resolve([
      {
        active: true,
        auth: "mtls",
        endpoint: "https://localhost:17670",
        is_remote: false,
        name: this.gateway,
        remote_host: null,
        resolved_host: null,
        source: "user",
        type: "local",
      },
    ]);
  }

  getGatewayInfo() {
    return Promise.resolve({
      auth: null,
      compute_drivers: [
        {
          capabilities: {
            driver_name: "docker",
            driver_version: this.driverVersion,
          },
          name: "docker",
        },
      ],
      gateway: this.gateway,
      server: "https://localhost:17670",
      status: "healthy",
      version: "0.0.106",
    });
  }

  createSandbox(options: CreateSandboxOptions) {
    if (this.createError) throw this.createError;
    if (!options.mountSet) throw new Error("missing mount set");
    const state = sandbox(options.name, this.active.size + 1);
    this.active.set(options.name, {
      sandbox: state,
      mountSet: options.mountSet,
    });
    this.creates.push(options.name);
    return Promise.resolve(state);
  }

  waitForSandbox(name: string) {
    const state = this.active.get(name)?.sandbox;
    if (!state) throw new Error(`missing Sandbox ${name}`);
    return Promise.resolve(state);
  }

  async execSandbox(name: string, command: readonly string[]) {
    const state = this.active.get(name);
    if (!state) throw new Error(`missing Sandbox ${name}`);
    if (command[0] === "/usr/bin/cat") {
      const lines = state.mountSet.mounts.map((mount, index) => {
        const mode =
          mount.purpose === "workspace"
            ? this.rootMode
            : mount.readOnly
              ? "ro"
              : "rw";
        return `${100 + index} 1 0:${index + 1} /${escapeMountField(mount.subpath)} ${escapeMountField(mount.target)} ${mode},relatime - ext4 /dev/vda1 rw`;
      });
      return {
        exitCode: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      };
    }
    if (
      command[0] !== "/usr/local/bin/orchestrator-mount-canary" ||
      !command[1]
    ) {
      throw new Error(`unexpected command: ${command.join(" ")}`);
    }
    if (command[1] === "writer") {
      const token = command[2];
      const root = state.mountSet.volume.mountpoint;
      if (!token) throw new Error("invalid writer command");
      await writeFile(
        path.join(root, "project", "task", "shared.txt"),
        `${token}\n`,
      );
      return output(writerIds);
    }
    if (command[1] === "reader") return output(readerIds);
    throw new Error(`unexpected volume canary mode: ${command[1]}`);
  }

  deleteSandbox(name: string) {
    this.active.delete(name);
    return Promise.resolve();
  }

  listSandboxes() {
    return Promise.resolve(
      [...this.active.values()].map(({ sandbox }) => sandbox),
    );
  }
}

async function fixture(): Promise<{
  readonly root: string;
  readonly docker: FakeDocker;
  readonly settings: SharedWorkspaceSettings;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pi-proof-test-")),
  );
  roots.push(root);
  return {
    root,
    docker: new FakeDocker(path.join(root, "volume")),
    settings: {
      enabled: true,
      gateway: "openshell",
      driver: "docker",
      driver_version: "29.5.2",
      docker_command: "docker",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Linux mount table parser", () => {
  it("parses escaped paths and mount access", () => {
    expect(
      parseLinuxMountInfo(
        "42 1 0:1 /project/task\\040one /workspace/project/task\\040one ro,relatime shared:2 - ext4 /dev/vda1 rw\n",
      ),
    ).toEqual([
      expect.objectContaining({
        id: 42,
        root: "/project/task one",
        mountPoint: "/workspace/project/task one",
        mountOptions: ["ro", "relatime"],
        optionalFields: ["shared:2"],
        mountSource: "/dev/vda1",
      }),
    ]);
  });

  it("rejects malformed mount evidence", () => {
    expect(() => parseLinuxMountInfo("not mount info\n")).toThrow("malformed");
  });
});

describe("shared OpenShell Workspace volume proof", () => {
  it("binds the exact volume, access modes, sharing, and cleanup", async () => {
    const input = await fixture();
    const client = new FakeWorkspaceVolumeClient();
    const result = await runWorkspaceVolumeCanary({
      client,
      docker: input.docker,
      settings: input.settings,
      projectRoot: input.root,
      stateRoot: path.join(input.root, "state"),
      hostHome: path.join(input.root, "home"),
      nameSuffix: () => "abcdef",
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    });

    expect(result.passed).toBe(true);
    expect(result.openshell).toEqual({
      cliVersion: "0.0.106",
      gateway: "openshell",
      gatewayVersion: "0.0.106",
      driver: "docker",
      driverVersion: "29.5.2",
    });
    expect(result.volume.name).toBe("pio-proof-abcdef");
    expect(result.sandboxes.writer.mounts?.entries).toHaveLength(5);
    expect(result.sandboxes.reader.mounts?.entries).toHaveLength(4);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "writer-mount-table", passed: true }),
        expect.objectContaining({ id: "shared-write-visible", passed: true }),
        expect.objectContaining({
          id: "controller-shared-visible",
          passed: true,
        }),
        expect.objectContaining({ id: "volume-cleanup", passed: true }),
      ]),
    );
    expect(result.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(client.active.size).toBe(0);
    expect(input.docker.exists).toBe(false);
  });

  it("fails closed on an observed mount-table access mismatch", async () => {
    const input = await fixture();
    const client = new FakeWorkspaceVolumeClient();
    client.rootMode = "rw";
    const result = await runWorkspaceVolumeCanary({
      client,
      docker: input.docker,
      settings: input.settings,
      projectRoot: input.root,
      hostHome: input.root,
      nameSuffix: () => "123456",
    });

    expect(result.passed).toBe(false);
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "writer-mount-table", passed: false }),
    );
    expect(client.active.size).toBe(0);
    expect(input.docker.exists).toBe(false);
  });

  it("rejects a disabled capability before gateway or volume access", async () => {
    const input = await fixture();
    const client = new FakeWorkspaceVolumeClient();
    await expect(
      runWorkspaceVolumeCanary({
        client,
        docker: input.docker,
        settings: { ...input.settings, enabled: false },
      }),
    ).rejects.toMatchObject({ code: "shared_workspace_disabled" });
    expect(client.creates).toEqual([]);
    expect(input.docker.exists).toBe(false);
  });

  it("rejects an unexpected driver version before volume creation", async () => {
    const input = await fixture();
    const client = new FakeWorkspaceVolumeClient();
    client.driverVersion = "29.5.1";
    await expect(
      runWorkspaceVolumeCanary({
        client,
        docker: input.docker,
        settings: input.settings,
        projectRoot: input.root,
        hostHome: input.root,
      }),
    ).rejects.toMatchObject({ code: "shared_workspace_driver_mismatch" });
    expect(client.creates).toEqual([]);
    expect(input.docker.exists).toBe(false);
  });

  it("cleans up the volume when Sandbox provisioning fails", async () => {
    const input = await fixture();
    const client = new FakeWorkspaceVolumeClient();
    client.createError = new Error("volume provisioning failed");

    const result = await runWorkspaceVolumeCanary({
      client,
      docker: input.docker,
      settings: input.settings,
      projectRoot: input.root,
      hostHome: input.root,
      nameSuffix: () => "654321",
    });

    expect(result.passed).toBe(false);
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sandbox-lifecycle", passed: false }),
        expect.objectContaining({ id: "sandbox-cleanup", passed: true }),
        expect.objectContaining({ id: "volume-cleanup", passed: true }),
      ]),
    );
    expect(client.active.size).toBe(0);
    expect(input.docker.exists).toBe(false);
  });
});
