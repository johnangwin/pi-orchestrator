import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "../src/openshell.js";
import { DockerVolumeCapability, DockerVolumeClient } from "../src/volume.js";

function inspection(
  options: Readonly<Record<string, string>> | null = null,
  labels: Readonly<Record<string, string>> = {
    "io.pi-orchestrator.kind": "run-workspace",
  },
) {
  return {
    CreatedAt: "2026-08-19T12:00:00Z",
    Driver: "local",
    Labels: labels,
    Mountpoint: "/var/lib/docker/volumes/pio-run-example/_data",
    Name: "pio-run-example",
    Options: options,
    Scope: "local",
  };
}

describe("Docker Workspace volumes", () => {
  it("creates, inspects, uses, and removes a plain labeled volume", async () => {
    const calls: string[][] = [];
    let exists = true;
    const runner: ProcessRunner = (_command, args) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "version --format {{.Server.Version}}") {
        return Promise.resolve({ stdout: "29.5.2\n", stderr: "", exitCode: 0 });
      }
      if (command.startsWith("volume create ")) {
        return Promise.resolve({
          stdout: "pio-run-example\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (command === "volume inspect pio-run-example --format {{json .}}") {
        return Promise.resolve(
          exists
            ? {
                stdout: JSON.stringify(inspection()),
                stderr: "",
                exitCode: 0,
              }
            : { stdout: "", stderr: "no such volume", exitCode: 1 },
        );
      }
      if (command.startsWith("run --rm --network none --mount ")) {
        return Promise.resolve({ stdout: "ok\n", stderr: "", exitCode: 0 });
      }
      if (command === "volume rm pio-run-example") {
        exists = false;
        return Promise.resolve({
          stdout: "pio-run-example\n",
          stderr: "",
          exitCode: 0,
        });
      }
      throw new Error(`unexpected Docker command: ${command}`);
    };
    const client = new DockerVolumeClient({
      command: "/usr/local/bin/docker",
      requiredVersion: "29.5.2",
      runner,
    });

    await expect(client.version()).resolves.toBe("29.5.2");
    const volume = await client.createVolume("pio-run-example", {
      "io.pi-orchestrator.kind": "run-workspace",
    });
    expect(volume).toBeInstanceOf(DockerVolumeCapability);
    expect(volume.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      client.runVolume({
        volume,
        image: "debian@sha256:example",
        command: ["/bin/true"],
        readOnly: true,
      }),
    ).resolves.toMatchObject({ stdout: "ok\n" });
    await client.removeVolume(volume.name);
    await expect(client.inspectVolume(volume.name)).resolves.toBeUndefined();

    expect(calls).toContainEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      "type=volume,source=pio-run-example,target=/run-volume,readonly",
      "debian@sha256:example",
      "/bin/true",
    ]);
  });

  it("rejects bind-backed and incorrectly labeled volumes", () => {
    expect(() =>
      DockerVolumeCapability.fromInspection(
        inspection({ type: "none", device: "/host", o: "bind" }),
        "pio-run-example",
        { "io.pi-orchestrator.kind": "run-workspace" },
      ),
    ).toThrow("plain local named volume");

    expect(() =>
      DockerVolumeCapability.fromInspection(
        inspection(null, {}),
        "pio-run-example",
        { "io.pi-orchestrator.kind": "run-workspace" },
      ),
    ).toThrow("expected label");
  });

  it("rejects a Docker version mismatch", async () => {
    const client = new DockerVolumeClient({
      requiredVersion: "29.5.2",
      runner: () =>
        Promise.resolve({ stdout: "29.5.1\n", stderr: "", exitCode: 0 }),
    });

    await expect(client.version()).rejects.toMatchObject({
      code: "docker_version_mismatch",
    });
  });

  it("does not mistake an inspection failure for an absent volume", async () => {
    const client = new DockerVolumeClient({
      runner: () =>
        Promise.resolve({
          stdout: "",
          stderr: "permission denied",
          exitCode: 1,
        }),
    });

    await expect(client.inspectVolume("pio-run-example")).rejects.toMatchObject(
      { code: "docker_failed" },
    );
  });
});
