import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalConfig } from "../src/local.js";
import { OpenShellMountSet } from "../src/mount.js";
import {
  OpenShellClient,
  parseOpenShellInferenceRoute,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
} from "../src/openshell.js";
import { DockerVolumeCapability } from "../src/volume.js";

type StubResult = Omit<ProcessResult, "exitCode"> &
  Partial<Pick<ProcessResult, "exitCode">>;

function runner(
  responses: Readonly<Record<string, StubResult>>,
  calls: string[][] = [],
): ProcessRunner {
  return (_command, args) => {
    calls.push([...args]);
    const response = responses[args.join(" ")];
    if (!response) throw new Error(`Unexpected command: ${args.join(" ")}`);
    return Promise.resolve({ exitCode: 0, ...response });
  };
}

const healthyStatus = JSON.stringify({
  authentication: {
    provider: "mTLS transport",
    status: "authenticated",
  },
  gateway: "openshell",
  server: "https://localhost:17670",
  status: "connected",
  version: "0.0.106",
});

describe("OpenShell preflight", () => {
  it("binds an exact CLI version to an authenticated gateway", async () => {
    const calls: string[][] = [];
    const client = new OpenShellClient({
      gateway: "openshell",
      requiredVersion: "0.0.106",
      runner: runner(
        {
          "--version": { stdout: "openshell 0.0.106\n", stderr: "" },
          "status --output json --gateway openshell --workspace default": {
            stdout: healthyStatus,
            stderr: "",
          },
        },
        calls,
      ),
    });

    await expect(client.preflight()).resolves.toMatchObject({
      installedVersion: "0.0.106",
      requiredVersion: "0.0.106",
      versionMatches: true,
      status: { status: "connected", version: "0.0.106" },
    });
    expect(calls).toEqual([
      ["--version"],
      [
        "status",
        "--output",
        "json",
        "--gateway",
        "openshell",
        "--workspace",
        "default",
      ],
    ]);
  });

  it("fails before gateway access when the installed version is not pinned", async () => {
    const calls: string[][] = [];
    const client = new OpenShellClient({
      requiredVersion: "0.0.106",
      runner: runner(
        {
          "--version": { stdout: "openshell 0.0.105\n", stderr: "" },
        },
        calls,
      ),
    });

    await expect(client.preflight()).rejects.toMatchObject({
      code: "openshell_version_mismatch",
    });
    expect(calls).toEqual([["--version"]]);
  });

  it("rejects a gateway running a different version", async () => {
    const client = new OpenShellClient({
      runner: runner({
        "--version": { stdout: "openshell 0.0.105\n", stderr: "" },
        "status --output json --workspace default": {
          stdout: healthyStatus,
          stderr: "",
        },
      }),
    });

    await expect(client.preflight()).rejects.toMatchObject({
      code: "openshell_version_mismatch",
    });
  });
});

describe("OpenShell inference route", () => {
  it("parses the configured user-facing route and ignores the system route", () => {
    expect(
      parseOpenShellInferenceRoute(`\u001b[1mInference:\u001b[0m

  Provider: local-code
  Model: qwen/test-code
  Timeout: 300s
  Version: 4

System inference:

  Provider: system
  Model: system-model
`),
    ).toEqual({
      provider: "local-code",
      model: "qwen/test-code",
      timeoutSeconds: 300,
      version: 4,
    });
  });

  it("fails closed when inference is not configured", () => {
    expect(() =>
      parseOpenShellInferenceRoute(`Inference:

  Not configured

System inference:

  Not configured
`),
    ).toThrow("not configured");
  });

  it("reads the route through the selected gateway and workspace", async () => {
    const client = new OpenShellClient({
      gateway: "openshell-code",
      workspace: "project",
      runner: runner({
        "inference get --gateway openshell-code --workspace project": {
          stdout: `Inference:\n  Provider: local\n  Model: code-model\n`,
          stderr: "",
        },
      }),
    });
    await expect(client.getInferenceRoute()).resolves.toEqual({
      provider: "local",
      model: "code-model",
    });
  });
});

describe("OpenShell gateway inspection", () => {
  it("reads the exact local driver and gateway registration", async () => {
    const client = new OpenShellClient({
      gateway: "openshell-direct",
      runner: runner({
        "gateway info --output json --gateway openshell-direct --workspace default":
          {
            stdout: JSON.stringify({
              auth: null,
              compute_drivers: [
                {
                  capabilities: {
                    driver_name: "docker",
                    driver_version: "29.5.2",
                  },
                  name: "docker",
                },
              ],
              gateway: "openshell-direct",
              server: "https://localhost:17670",
              status: "healthy",
              version: "0.0.106",
            }),
            stderr: "",
          },
        "gateway list --output json": {
          stdout: JSON.stringify([
            {
              active: true,
              auth: "mtls",
              endpoint: "https://localhost:17670",
              is_remote: false,
              name: "openshell-direct",
              remote_host: null,
              resolved_host: null,
              source: "user",
              type: "local",
            },
          ]),
          stderr: "",
        },
      }),
    });

    await expect(client.getGatewayInfo()).resolves.toMatchObject({
      gateway: "openshell-direct",
      compute_drivers: [
        {
          name: "docker",
          capabilities: { driver_version: "29.5.2" },
        },
      ],
    });
    await expect(client.listGateways()).resolves.toEqual([
      expect.objectContaining({
        name: "openshell-direct",
        is_remote: false,
        type: "local",
      }),
    ]);
  });
});

const readySandbox = JSON.stringify({
  annotations: {},
  created_at: "2026-08-17 23:39:16",
  current_policy_version: 1,
  id: "43502221-db6b-49f2-a316-673792b3faae",
  labels: {},
  name: "pio-cny-read-001",
  phase: "Ready",
  policy: { version: 1 },
  policy_source: "sandbox",
  resource_version: 8,
  revision: 1,
  workspace: "default",
});

describe("OpenShell Sandbox lifecycle", () => {
  it("closes child stdin so non-interactive exec can begin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openshell-runner-"));
    const executable = path.join(root, "openshell-mock");
    await writeFile(
      executable,
      "#!/bin/sh\ncat >/dev/null\nprintf finished\nexit 23\n",
    );
    await chmod(executable, 0o755);
    try {
      const client = new OpenShellClient({ command: executable });
      await expect(
        client.execSandbox("pio-cny-read-001", ["true"], {
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ stdout: "finished", exitCode: 23 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates, inspects, executes in, transfers to, and deletes a Sandbox", async () => {
    const calls: string[][] = [];
    const client = new OpenShellClient({
      runner: runner(
        {
          "sandbox create --name pio-cny-read-001 --from /image --policy /read.yaml --label purpose=test --no-auto-providers --no-tty --workspace default -- /usr/bin/true":
            {
              stdout: "created",
              stderr: "",
            },
          "sandbox get pio-cny-read-001 --output json --workspace default": {
            stdout: readySandbox,
            stderr: "",
          },
          "sandbox exec --name pio-cny-read-001 --no-tty --timeout 2 --workspace default -- false":
            {
              stdout: "",
              stderr: "denied",
              exitCode: 23,
            },
          "sandbox upload pio-cny-read-001 /host/input /workspace/input/file --workspace default":
            {
              stdout: "uploaded",
              stderr: "",
            },
          "sandbox download pio-cny-read-001 /sandbox/output/report /host/report --workspace default":
            {
              stdout: "downloaded",
              stderr: "",
            },
          "sandbox delete pio-cny-read-001 --workspace default": {
            stdout: "deleted",
            stderr: "",
          },
          "policy set pio-cny-read-001 --policy /read.yaml --wait --timeout 2 --workspace default":
            {
              stdout: "updated",
              stderr: "",
            },
        },
        calls,
      ),
    });

    await expect(
      client.createSandbox({
        name: "pio-cny-read-001",
        from: "/image",
        policyPath: "/read.yaml",
        labels: { purpose: "test" },
      }),
    ).resolves.toMatchObject({ phase: "Ready" });
    await expect(
      client.execSandbox("pio-cny-read-001", ["false"], {
        timeoutMs: 1_001,
      }),
    ).resolves.toMatchObject({ exitCode: 23 });
    await client.upload(
      "pio-cny-read-001",
      "/host/input",
      "/workspace/input/file",
    );
    await client.download(
      "pio-cny-read-001",
      "/sandbox/output/report",
      "/host/report",
    );
    await expect(
      client.setSandboxPolicy("pio-cny-read-001", "/read.yaml", {
        timeoutMs: 1_001,
      }),
    ).resolves.toMatchObject({ phase: "Ready" });
    await client.deleteSandbox("pio-cny-read-001");

    expect(calls).toHaveLength(8);
  });

  it("serializes only a host-compiled volume capability", async () => {
    const volume = DockerVolumeCapability.fromInspection(
      {
        CreatedAt: "2026-08-19T12:00:00Z",
        Driver: "local",
        Labels: { "io.pi-orchestrator.kind": "run-workspace" },
        Mountpoint: "/var/lib/docker/volumes/pio-run-example/_data",
        Name: "pio-run-example",
        Options: null,
        Scope: "local",
      },
      "pio-run-example",
      { "io.pi-orchestrator.kind": "run-workspace" },
    );
    const mountSet = OpenShellMountSet.forVolume({
      volume,
    });
    const calls: string[][] = [];
    const create = [
      "sandbox",
      "create",
      "--name",
      "pio-cny-read-001",
      "--from",
      "/image",
      "--policy",
      "/read.yaml",
      "--driver-config-json",
      mountSet.driverConfigJson(),
      "--no-auto-providers",
      "--no-tty",
      "--workspace",
      "default",
      "--",
      "/usr/bin/true",
    ];
    const client = new OpenShellClient({
      runner: runner(
        {
          [create.join(" ")]: { stdout: "created", stderr: "" },
          "sandbox get pio-cny-read-001 --output json --workspace default": {
            stdout: readySandbox,
            stderr: "",
          },
        },
        calls,
      ),
    });
    await expect(
      client.createSandbox({
        name: "pio-cny-read-001",
        from: "/image",
        policyPath: "/read.yaml",
        mountSet,
      }),
    ).resolves.toMatchObject({ phase: "Ready" });
    expect(calls[0]).toEqual(create);

    await expect(
      client.createSandbox({
        name: "pio-cny-read-001",
        from: "/image",
        policyPath: "/read.yaml",
        mountSet: {} as OpenShellMountSet,
      }),
    ).rejects.toMatchObject({ code: "invalid_openshell_mount_set" });
  });

  it("rejects Sandbox names that OpenShell cannot represent", async () => {
    const client = new OpenShellClient({ runner: runner({}) });
    await expect(
      client.getSandbox("this-name-is-over-nineteen-characters"),
    ).rejects.toThrow("Too big");
  });

  it("rejects labels that OpenShell cannot represent", async () => {
    const client = new OpenShellClient({ runner: runner({}) });
    await expect(
      client.createSandbox({
        name: "pio-check-one",
        from: "/image",
        policyPath: "/check.yaml",
        labels: { ownership: "x".repeat(64) },
      }),
    ).rejects.toThrow("Too big");
  });

  it("polls provisioning Sandboxes until Ready", async () => {
    let requests = 0;
    let now = 0;
    const client = new OpenShellClient({
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
      runner: (_command, args) => {
        expect(args.slice(0, 3)).toEqual([
          "sandbox",
          "get",
          "pio-cny-read-001",
        ]);
        requests += 1;
        return Promise.resolve({
          stdout: readySandbox.replace(
            '"phase":"Ready"',
            `"phase":"${requests === 1 ? "Provisioning" : "Ready"}"`,
          ),
          stderr: "",
          exitCode: 0,
        });
      },
    });

    await expect(
      client.waitForSandbox("pio-cny-read-001", {
        pollMs: 10,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ phase: "Ready" });
    expect(requests).toBe(2);
  });

  it("treats verified absence as idempotent deletion", async () => {
    const client = new OpenShellClient({
      runner: runner({
        "sandbox delete pio-cny-read-001 --workspace default": {
          stdout: "",
          stderr: "sandbox not found",
          exitCode: 1,
        },
        "sandbox list --output json --workspace default": {
          stdout: "[]",
          stderr: "",
        },
      }),
    });

    await expect(
      client.deleteSandbox("pio-cny-read-001", { missingOk: true }),
    ).resolves.toBeUndefined();
  });

  it("binds service forwarding to host loopback", async () => {
    let resolveCompletion!: (result: ProcessResult) => void;
    const stdout = new Set<(chunk: string) => void>();
    const stderr = new Set<(chunk: string) => void>();
    const completion = new Promise<ProcessResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const handle: ProcessHandle = {
      onStdout(listener) {
        stdout.add(listener);
        return () => stdout.delete(listener);
      },
      onStderr(listener) {
        stderr.add(listener);
        return () => stderr.delete(listener);
      },
      wait: () => completion,
      terminate() {
        resolveCompletion({
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: "SIGTERM",
        });
      },
    };
    let args: readonly string[] = [];
    const client = new OpenShellClient({
      starter: (_command, value) => {
        args = value;
        queueMicrotask(() => {
          for (const listener of stdout) {
            listener(
              "Forwarding 127.0.0.1:43123 -> 127.0.0.1:19090 in sandbox pio-cny-read-001 via gRPC\n",
            );
          }
        });
        return handle;
      },
    });

    const forward = await client.startServiceForward({
      sandboxName: "pio-cny-read-001",
      targetPort: 19_090,
    });
    expect(forward).toMatchObject({
      localHost: "127.0.0.1",
      localPort: 43_123,
      targetHost: "127.0.0.1",
      targetPort: 19_090,
    });
    expect(args).toContain("127.0.0.1:0");
    await forward.stop();
  });
});

describe("machine-local configuration", () => {
  it("loads an exact OpenShell version pin and defaults", () => {
    expect(
      parseLocalConfig(`version: 1
openshell:
  required_version: "0.0.106"
`),
    ).toMatchObject({
      openshell: {
        command: "openshell",
        required_version: "0.0.106",
        workspace: "default",
        gateways: {},
      },
      models: {},
      cmux: {
        command: "cmux",
        workspace_prefix: "orchestrator",
      },
    });
  });

  it("validates explicit model execution metadata", () => {
    expect(
      parseLocalConfig(`version: 1
openshell:
  gateways:
    code: openshell-code
models:
  code:
    gateway: code
    pi_model: qwen/test-code
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 8192
    reasoning: false
`),
    ).toMatchObject({
      models: {
        code: {
          gateway: "code",
          pi_model: "qwen/test-code",
          api: "openai-completions",
          locality: "local",
        },
      },
    });
  });

  it("requires a complete shared Workspace volume configuration", () => {
    expect(
      parseLocalConfig(`version: 1
openshell:
  required_version: "0.0.106"
  shared_workspace:
    enabled: true
    gateway: openshell
    driver: docker
    driver_version: "29.5.2"
    docker_command: /usr/local/bin/docker
`),
    ).toMatchObject({
      openshell: {
        shared_workspace: {
          enabled: true,
          gateway: "openshell",
          driver: "docker",
          driver_version: "29.5.2",
          docker_command: "/usr/local/bin/docker",
        },
      },
    });

    expect(() =>
      parseLocalConfig(`version: 1
openshell:
  shared_workspace:
    enabled: true
`),
    ).toThrow("is required");
  });

  it("rejects a floating version label", () => {
    expect(() =>
      parseLocalConfig(`version: 1
openshell:
  required_version: latest
`),
    ).toThrow("semantic version");
  });
});
