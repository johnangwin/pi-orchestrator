import path from "node:path";
import { z } from "zod";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { DockerVolumeCapability } from "./volume.js";
import { WritePathSchema } from "./workspace.js";

const PROJECT_TARGET = "/workspace/project";
const PROJECT_SUBPATH = "project";

export const MountRelativePathSchema = WritePathSchema;
export type MountRelativePath = z.infer<typeof MountRelativePathSchema>;

export type WorkspaceMountPurpose =
  | "workspace"
  | "write"
  | "protected"
  | "restricted-file-mask"
  | "restricted-directory-mask";

export interface WorkspaceVolumeMount {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly subpath: string;
  readonly readOnly: boolean;
  readonly purpose: WorkspaceMountPurpose;
}

export interface WorkspaceMountSetOptions {
  readonly volume: DockerVolumeCapability;
  readonly writePaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly restrictedFiles?: readonly string[];
  readonly restrictedDirectories?: readonly string[];
}

function contains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function ensureUniqueNonOverlapping(
  name: string,
  paths: readonly MountRelativePath[],
): void {
  for (let index = 0; index < paths.length; index += 1) {
    const current = paths[index]!;
    for (const other of paths.slice(index + 1)) {
      if (overlaps(current, other)) {
        throw new OrchestratorError(
          "overlapping_mount_paths",
          `${name} '${current}' overlaps '${other}'`,
        );
      }
    }
  }
}

function targetFor(relative: string): string {
  const target = path.posix.join(PROJECT_TARGET, relative);
  if (!target.startsWith(`${PROJECT_TARGET}/`)) {
    throw new OrchestratorError(
      "invalid_mount_target",
      `Mount target '${target}' escapes the fixed Project root`,
    );
  }
  return target;
}

function subpathFor(relative: string): string {
  return path.posix.join(PROJECT_SUBPATH, relative);
}

function freezeMounts(
  mounts: readonly WorkspaceVolumeMount[],
): readonly WorkspaceVolumeMount[] {
  return Object.freeze(mounts.map((mount) => Object.freeze({ ...mount })));
}

export class OpenShellMountSet {
  readonly driver = "docker" as const;
  readonly volume: DockerVolumeCapability;
  readonly mounts: readonly WorkspaceVolumeMount[];
  readonly digest: Digest;

  private constructor(
    volume: DockerVolumeCapability,
    mounts: readonly WorkspaceVolumeMount[],
  ) {
    this.volume = volume;
    this.mounts = freezeMounts(mounts);
    this.digest = digestParts("pi-orchestrator/openshell-volume-mount-set/v1", [
      ["driver", this.driver],
      ["volume", volume.digest],
      ["mounts", canonicalJson(this.mounts)],
    ]);
    Object.freeze(this);
  }

  static forVolume(options: WorkspaceMountSetOptions): OpenShellMountSet {
    if (!(options.volume instanceof DockerVolumeCapability)) {
      throw new OrchestratorError(
        "invalid_docker_volume",
        "Workspace mounts require an inspected named-volume capability",
      );
    }
    const writePaths = (options.writePaths ?? []).map((value) =>
      MountRelativePathSchema.parse(value),
    );
    const protectedPaths = (options.protectedPaths ?? []).map((value) =>
      MountRelativePathSchema.parse(value),
    );
    const restrictedFiles = (options.restrictedFiles ?? []).map((value) =>
      MountRelativePathSchema.parse(value),
    );
    const restrictedDirectories = (options.restrictedDirectories ?? []).map(
      (value) => MountRelativePathSchema.parse(value),
    );
    ensureUniqueNonOverlapping("write path", writePaths);
    ensureUniqueNonOverlapping("protected path", protectedPaths);
    ensureUniqueNonOverlapping("restricted path", [
      ...restrictedFiles,
      ...restrictedDirectories,
    ]);

    for (const writePath of writePaths) {
      const restricted = [...restrictedFiles, ...restrictedDirectories].find(
        (restrictedPath) => overlaps(writePath, restrictedPath),
      );
      if (restricted) {
        throw new OrchestratorError(
          "write_mount_overlaps_mask",
          `Write path '${writePath}' overlaps restricted path '${restricted}'`,
        );
      }
      const protectedParent = protectedPaths.find((protectedPath) =>
        contains(protectedPath, writePath),
      );
      if (protectedParent) {
        throw new OrchestratorError(
          "write_mount_inside_protected_path",
          `Write path '${writePath}' is inside protected path '${protectedParent}'`,
        );
      }
    }

    const mount = (
      relative: string | undefined,
      readOnly: boolean,
      purpose: WorkspaceMountPurpose,
      sourceSubpath?: string,
    ): WorkspaceVolumeMount => ({
      type: "volume",
      source: options.volume.name,
      target: relative ? targetFor(relative) : PROJECT_TARGET,
      subpath:
        sourceSubpath ?? (relative ? subpathFor(relative) : PROJECT_SUBPATH),
      readOnly,
      purpose,
    });
    const mounts = [
      mount(undefined, true, "workspace"),
      ...writePaths.map((relative) => mount(relative, false, "write")),
      ...protectedPaths.map((relative) => mount(relative, true, "protected")),
      ...restrictedFiles.map((relative) =>
        mount(
          relative,
          true,
          "restricted-file-mask",
          "control/masks/opaque-file",
        ),
      ),
      ...restrictedDirectories.map((relative) =>
        mount(
          relative,
          true,
          "restricted-directory-mask",
          "control/masks/empty-directory",
        ),
      ),
    ];
    const targets = mounts.map((entry) => entry.target);
    if (new Set(targets).size !== targets.length) {
      throw new OrchestratorError(
        "duplicate_mount_target",
        "A Workspace mount target was requested more than once",
      );
    }
    return new OpenShellMountSet(options.volume, mounts);
  }

  driverConfigJson(): string {
    return JSON.stringify({
      docker: {
        mounts: this.mounts.map((mount) => ({
          type: mount.type,
          source: mount.source,
          target: mount.target,
          subpath: mount.subpath,
          read_only: mount.readOnly,
        })),
      },
    });
  }
}

export interface LinuxMountInfoEntry {
  readonly id: number;
  readonly parentId: number;
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: readonly string[];
  readonly optionalFields: readonly string[];
  readonly filesystem: string;
  readonly mountSource: string;
  readonly superOptions: readonly string[];
}

export interface MountTableEvidence {
  readonly rawDigest: Digest;
  readonly selectedDigest: Digest;
  readonly entries: readonly LinuxMountInfoEntry[];
}

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseLinuxMountInfo(source: string): LinuxMountInfoEntry[] {
  const entries: LinuxMountInfoEntry[] = [];
  for (const [index, line] of source.trimEnd().split("\n").entries()) {
    if (!line) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) {
      throw new OrchestratorError(
        "invalid_mount_table",
        `Mount table line ${index + 1} is malformed`,
      );
    }
    const id = Number(fields[0]);
    const parentId = Number(fields[1]);
    const device = fields[2];
    const root = fields[3];
    const mountPoint = fields[4];
    const mountOptions = fields[5];
    const filesystem = fields[separator + 1];
    const mountSource = fields[separator + 2];
    const superOptions = fields[separator + 3];
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(parentId) ||
      !device ||
      !root ||
      !mountPoint ||
      !mountOptions ||
      !filesystem ||
      !mountSource ||
      !superOptions
    ) {
      throw new OrchestratorError(
        "invalid_mount_table",
        `Mount table line ${index + 1} has invalid required fields`,
      );
    }
    entries.push({
      id,
      parentId,
      device,
      root: decodeMountField(root),
      mountPoint: decodeMountField(mountPoint),
      mountOptions: mountOptions.split(","),
      optionalFields: fields.slice(6, separator).map(decodeMountField),
      filesystem,
      mountSource: decodeMountField(mountSource),
      superOptions: superOptions.split(","),
    });
  }
  return entries;
}

export function validateOpenShellMountTable(
  source: string,
  mountSet: OpenShellMountSet,
): MountTableEvidence {
  if (!(mountSet instanceof OpenShellMountSet)) {
    throw new OrchestratorError(
      "invalid_openshell_mount_set",
      "Mount evidence requires a host-compiled mount capability",
    );
  }
  const entries = parseLinuxMountInfo(source)
    .filter(
      (entry) =>
        entry.mountPoint === PROJECT_TARGET ||
        entry.mountPoint.startsWith(`${PROJECT_TARGET}/`),
    )
    .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
  const expected = new Map(
    mountSet.mounts.map((mount) => [mount.target, mount] as const),
  );
  if (entries.length !== expected.size) {
    throw new OrchestratorError(
      "mount_table_mismatch",
      `Observed ${entries.length} Project mounts; expected ${expected.size}`,
    );
  }
  for (const entry of entries) {
    const requested = expected.get(entry.mountPoint);
    if (!requested) {
      throw new OrchestratorError(
        "mount_table_mismatch",
        `Unexpected Project mount '${entry.mountPoint}'`,
      );
    }
    const expectedMode = requested.readOnly ? "ro" : "rw";
    if (
      !entry.mountOptions.includes(expectedMode) ||
      entry.filesystem === "fakeowner" ||
      entry.root !== `/${requested.subpath}`
    ) {
      throw new OrchestratorError(
        "mount_table_mismatch",
        `Project mount '${entry.mountPoint}' does not match the requested ${expectedMode} native-volume subpath`,
      );
    }
  }
  const frozenEntries = Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        mountOptions: Object.freeze([...entry.mountOptions]),
        optionalFields: Object.freeze([...entry.optionalFields]),
        superOptions: Object.freeze([...entry.superOptions]),
      }),
    ),
  );
  return Object.freeze({
    rawDigest: sha256(source),
    selectedDigest: digestParts("pi-orchestrator/observed-mount-table/v1", [
      ["entries", canonicalJson(frozenEntries)],
    ]),
    entries: frozenEntries,
  });
}
