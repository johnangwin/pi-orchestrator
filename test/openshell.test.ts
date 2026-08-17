import { describe, expect, it } from "vitest";
import { parseLocalConfig } from "../src/local.js";
import {
  OpenShellClient,
  type ProcessResult,
  type ProcessRunner,
} from "../src/openshell.js";

function runner(
  responses: Readonly<Record<string, ProcessResult>>,
  calls: string[][] = [],
): ProcessRunner {
  return (_command, args) => {
    calls.push([...args]);
    const response = responses[args.join(" ")];
    if (!response) throw new Error(`Unexpected command: ${args.join(" ")}`);
    return Promise.resolve(response);
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
    });
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
