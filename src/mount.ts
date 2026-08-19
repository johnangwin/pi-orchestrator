import path from "node:path";
import { z } from "zod";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { DockerVolumeCapability } from "./volume.js";

const PROJECT_TARGET = "/workspace/project";
const PROJECT_SUBPATH = "project";

export const MountRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !value.includes("\\"), "must use POSIX separators")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      path.posix.normalize(value) === value &&
      value.split("/").every((segment) => segment !== "" && segment !== ".."),
    "must be a normalized non-root relative path",
  )
  .refine(
    (value) => value !== ".git" && !value.startsWith(".git/"),
    "must not address Git metadata",
  );
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
