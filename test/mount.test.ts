import { describe, expect, it } from "vitest";
import { OpenShellMountSet } from "../src/mount.js";
import { DockerVolumeCapability } from "../src/volume.js";

function volume(name = "pio-run-example") {
  return DockerVolumeCapability.fromInspection(
    {
      CreatedAt: "2026-08-19T12:00:00Z",
      Driver: "local",
      Labels: {
        "io.pi-orchestrator.kind": "run-workspace",
      },
      Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
      Name: name,
      Options: null,
      Scope: "local",
    },
    name,
    { "io.pi-orchestrator.kind": "run-workspace" },
  );
}

describe("OpenShell Workspace volume mount compiler", () => {
  it("builds one ordered, digest-bound Docker volume capability", () => {
    const input = volume();
    const mountSet = OpenShellMountSet.forVolume({
      volume: input,
      writePaths: ["task"],
      protectedPaths: ["task/protected"],
      restrictedFiles: ["restricted.txt"],
      restrictedDirectories: ["restricted-dir"],
    });

    expect(mountSet.mounts.map((mount) => mount.purpose)).toEqual([
      "workspace",
      "write",
      "protected",
      "restricted-file-mask",
      "restricted-directory-mask",
    ]);
    expect(
      mountSet.mounts.map((mount) => [
        mount.target,
        mount.subpath,
        mount.readOnly,
      ]),
    ).toEqual([
      ["/workspace/project", "project", true],
      ["/workspace/project/task", "project/task", false],
      ["/workspace/project/task/protected", "project/task/protected", true],
      ["/workspace/project/restricted.txt", "control/masks/opaque-file", true],
      [
        "/workspace/project/restricted-dir",
        "control/masks/empty-directory",
        true,
      ],
    ]);
    expect(JSON.parse(mountSet.driverConfigJson())).toEqual({
      docker: {
        mounts: mountSet.mounts.map((mount) => ({
          type: "volume",
          source: input.name,
          target: mount.target,
          subpath: mount.subpath,
          read_only: mount.readOnly,
        })),
      },
    });
    expect(mountSet.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mountSet.volume).toBe(input);
    expect(Object.isFrozen(mountSet)).toBe(true);
    expect(Object.isFrozen(mountSet.mounts)).toBe(true);
  });

  it("rejects a forged volume capability", () => {
    expect(() =>
      OpenShellMountSet.forVolume({
        volume: { name: "forged" } as DockerVolumeCapability,
      }),
    ).toThrow("inspected named-volume capability");
  });

  it.each([".", "../task", "/task", "task//nested", "task\\nested"])(
    "rejects invalid write path %s",
    (writePath) => {
      expect(() =>
        OpenShellMountSet.forVolume({
          volume: volume(),
          writePaths: [writePath],
        }),
      ).toThrow();
    },
  );

  it("rejects Git metadata write paths", () => {
    expect(() =>
      OpenShellMountSet.forVolume({
        volume: volume(),
        writePaths: [".git/objects"],
      }),
    ).toThrow("Git metadata");
  });

  it("rejects overlapping write roots", () => {
    expect(() =>
      OpenShellMountSet.forVolume({
        volume: volume(),
        writePaths: ["task", "task/nested"],
      }),
    ).toThrow("overlaps");
  });

  it("rejects a write root that overlaps a restricted path", () => {
    expect(() =>
      OpenShellMountSet.forVolume({
        volume: volume(),
        writePaths: ["task"],
        restrictedDirectories: ["task/private"],
      }),
    ).toThrow("overlaps restricted path");
  });

  it("rejects a write root nested inside a protected path", () => {
    expect(() =>
      OpenShellMountSet.forVolume({
        volume: volume(),
        writePaths: ["task/protected/nested"],
        protectedPaths: ["task/protected"],
      }),
    ).toThrow("inside protected path");
  });
});
