import { describe, expect, it } from "vitest";
import { runCanary, type CanaryOpenShell } from "../src/canary.js";
import type {
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: "0.0.106",
  installedVersion: "0.0.106",
  versionMatches: true,
  status: {
    authentication: {
      provider: "mTLS transport",
      status: "authenticated",
    },
    gateway: "openshell",
    server: "https://localhost:17670",
    status: "connected",
    version: "0.0.106",
  },
};

function sandbox(name: string): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-17 23:39:16",
    current_policy_version: 1,
    id: "43502221-db6b-49f2-a316-673792b3faae",
    labels: {},
    name,
    phase: "Ready",
    resource_version: 1,
    workspace: "default",
  };
}

function result(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr };
}

function passingClient(deleted: string[]): CanaryOpenShell {
  return {
    preflight: () => Promise.resolve(preflight),
    createSandbox: ({ name }) => Promise.resolve(sandbox(name)),
    waitForSandbox: (name) => Promise.resolve(sandbox(name)),
    deleteSandbox: (name) => {
      deleted.push(name);
      return Promise.resolve();
    },
    execSandbox: (_name, command) => {
      if (command[0] !== "/usr/local/bin/orchestrator-canary") {
        throw new Error(`Unexpected command: ${command.join(" ")}`);
      }
      const ids = [
        "unprivileged-uid",
        "unprivileged-groups",
        "source-readable",
        "base-read-only",
        "input-read-only",
        "project-access",
        "output-writable",
        "openshell-token-inaccessible",
        "openshell-key-inaccessible",
        "docker-socket-absent",
        "host-sentinel-inaccessible",
        "host-home-inaccessible",
        "host-state-inaccessible",
        "host-checkout-inaccessible",
        "host-git-inaccessible",
        "sibling-repositories-inaccessible",
        "host-ssh-agent-inaccessible",
        "host-credentials-absent",
        "external-network-denied",
        "host-gateway-denied",
        "privileged-mount-denied",
      ];
      return Promise.resolve(
        result(0, `${ids.map((id) => `${id}\tpass`).join("\n")}\n`),
      );
    },
  };
}

describe("OpenShell canary", () => {
  it("verifies all profiles and cleans up every Sandbox", async () => {
    const deleted: string[] = [];
    const output = await runCanary({
      client: passingClient(deleted),
      nameSuffix: () => "abcdef",
      now: () => new Date("2026-08-17T23:00:00.000Z"),
      projectRoot: "/host/project",
      stateRoot: "/host/state",
      hostHome: "/host/home",
    });

    expect(output.passed).toBe(true);
    expect(output.profiles).toHaveLength(3);
    expect(output.profiles.every((profile) => profile.passed)).toBe(true);
    expect(deleted).toEqual([
      "pio-cny-r-abcdef",
      "pio-cny-w-abcdef",
      "pio-cny-c-abcdef",
    ]);
  });

  it("attempts cleanup when Sandbox creation fails", async () => {
    const deleted: string[] = [];
    const client = passingClient(deleted);
    client.createSandbox = () =>
      Promise.reject(new Error("provisioning failed"));

    const output = await runCanary({
      client,
      profiles: ["read"],
      nameSuffix: () => "123456",
      projectRoot: "/host/project",
      stateRoot: "/host/state",
      hostHome: "/host/home",
    });

    expect(output.passed).toBe(false);
    expect(output.profiles[0]?.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sandbox-lifecycle", passed: false }),
        expect.objectContaining({ id: "sandbox-cleanup", passed: true }),
      ]),
    );
    expect(deleted).toEqual(["pio-cny-r-123456"]);
  });

  it("requires an exact OpenShell pin before provisioning", async () => {
    const client = passingClient([]);
    const { requiredVersion: _requiredVersion, ...unpinned } = preflight;
    client.preflight = () =>
      Promise.resolve({ ...unpinned, versionMatches: null });

    await expect(runCanary({ client, profiles: ["read"] })).rejects.toThrow(
      "exact required_version pin",
    );
  });
});
