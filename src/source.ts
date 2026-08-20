import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { GitCommitSchema } from "./git.js";
import {
  PinnedImageReferenceSchema,
  VersionSchema,
  type LocalConfig,
  type PinnedImageReference,
  type SharedWorkspaceSettings,
} from "./local.js";
import { OpenShellMountSet } from "./mount.js";
import type {
  OpenShellGatewayInfo,
  OpenShellGatewayRegistration,
  OpenShellPreflight,
} from "./openshell.js";
import { gitOutput } from "./project.js";
import { pathMatchesPatterns } from "./scope.js";
import {
  DockerVolumeCapability,
  DockerVolumeClient,
  DockerVolumeNameSchema,
} from "./volume.js";
import {
  WorkspaceManifestEntrySchema,
  createWorkspaceManifestFromEntries,
  effectiveRestrictedPaths,
  type WorkspaceManifest,
} from "./workspace.js";
import {
  SourceSnapshotManifestSchema,
  createSourceSnapshot,
  verifySourceSnapshot,
  type SourceSnapshot,
  type SourceSnapshotManifest,
} from "./snapshot.js";

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);

export const WorkspaceSessionProjectionSchema = z
  .object({
    source_digest: DigestSchema,
    workspace_generation: z.number().int().nonnegative(),
    manifest_digest: DigestSchema,
    volume_name: DockerVolumeNameSchema,
    volume_digest: DigestSchema,
    mount_set_digest: DigestSchema,
    mount_table_digest: DigestSchema,
    image_digest: DigestSchema,
    projection_digest: DigestSchema,
  })
  .strict();
export type WorkspaceSessionProjection = z.infer<
  typeof WorkspaceSessionProjectionSchema
>;

const WorkspaceSourceRecordSchema = z
  .object({
    version: z.literal(2),
    commit: GitCommitSchema,
    workspace_generation: z.number().int().nonnegative(),
    manifest_digest: DigestSchema,
    entry_count: z.number().int().positive(),
    byte_count: z.number().int().nonnegative(),
    entries: z.array(WorkspaceManifestEntrySchema).min(1),
  })
  .strict();

export const WorkspaceSourceManifestSchema = WorkspaceSourceRecordSchema.extend(
  {
    source_digest: DigestSchema,
  },
).strict();
export type WorkspaceSourceManifest = z.infer<
  typeof WorkspaceSourceManifestSchema
>;

export const PlanningSourceManifestSchema = z.union([
  SourceSnapshotManifestSchema,
  WorkspaceSourceManifestSchema,
]);
export type PlanningSourceManifest =
  SourceSnapshotManifest | WorkspaceSourceManifest;
export type PlanningSource = SourceSnapshot | ReadOnlySourceWorkspace;
export type SourceWorkspaceFactory = (
  options: CreateSourceWorkspaceOptions,
) => Promise<ReadOnlySourceWorkspace>;

const HelperGitManifestSchema = z
  .object({
    commit: GitCommitSchema,
    manifest: z
      .object({
        version: z.literal(2),
        entry_count: z.number().int().positive(),
        byte_count: z.number().int().nonnegative(),
        entries: z.array(WorkspaceManifestEntrySchema).min(1),
      })
      .strict(),
  })
  .strict();

const HelperWorkspaceManifestSchema = z
  .object({
    version: z.literal(2),
    entry_count: z.number().int().positive(),
    byte_count: z.number().int().nonnegative(),
    entries: z.array(WorkspaceManifestEntrySchema).min(1),
  })
  .strict();

export interface WorkspaceSourceDocker {
  readonly command: string;
  version(): Promise<string>;
  createVolume(
    name: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability>;
  inspectVolume(
    name: string,
    labels?: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability | undefined>;
  seedGitWorkspace(
    options: Parameters<DockerVolumeClient["seedGitWorkspace"]>[0],
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
  inspectWorkspaceVolume(
    options: Parameters<DockerVolumeClient["inspectWorkspaceVolume"]>[0],
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
  removeVolume(name: string, missingOk?: boolean): Promise<void>;
}

export interface WorkspaceGatewayClient {
  readonly gateway?: string;
  listGateways(): Promise<OpenShellGatewayRegistration[]>;
  getGatewayInfo(): Promise<OpenShellGatewayInfo>;
}

export interface CreateSourceWorkspaceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly commit: string;
  readonly local: LocalConfig;
  readonly restrictedPaths?: readonly string[];
  readonly docker?: WorkspaceSourceDocker;
  readonly suffix?: () => string;
}

function sourceDigest(
  record: z.infer<typeof WorkspaceSourceRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/workspace-source/v1", [
    ["record", canonicalJson(record)],
  ]);
}

export function validateWorkspaceSourceManifest(
  value: unknown,
): WorkspaceSourceManifest {
  const parsed = WorkspaceSourceManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_workspace_source",
      `Workspace source does not match the version-two contract: ${parsed.error.message}`,
    );
  }
  const manifest = createWorkspaceManifestFromEntries(parsed.data.entries);
  if (
    manifest.digest !== parsed.data.manifest_digest ||
    manifest.entry_count !== parsed.data.entry_count ||
    manifest.byte_count !== parsed.data.byte_count
  ) {
    throw new OrchestratorError(
      "invalid_workspace_source",
      "Workspace source metadata does not match its complete manifest",
    );
  }
  const { source_digest, ...record } = parsed.data;
  if (sourceDigest(record) !== source_digest) {
    throw new OrchestratorError(
      "invalid_workspace_source",
      "Workspace source digest does not match its record",
    );
  }
  return Object.freeze({
    ...parsed.data,
    entries: Object.freeze(
      parsed.data.entries.map((entry) => Object.freeze({ ...entry })),
    ),
  }) as WorkspaceSourceManifest;
}

export function createWorkspaceSourceManifest(
  commit: string,
  generation: number,
  manifest: WorkspaceManifest,
): WorkspaceSourceManifest {
  const record = WorkspaceSourceRecordSchema.parse({
    version: 2,
    commit,
    workspace_generation: generation,
    manifest_digest: manifest.digest,
    entry_count: manifest.entry_count,
    byte_count: manifest.byte_count,
    entries: manifest.entries,
  });
  return validateWorkspaceSourceManifest({
    ...record,
    source_digest: sourceDigest(record),
  });
}

function helperPath(): string {
  return fileURLToPath(new URL("../sandbox/pi/workspace.mjs", import.meta.url));
}

async function executeHelper(args: readonly string[]): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [helperPath(), ...args],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
      (error, output, stderr) => {
        if (!error) {
          resolve(output);
          return;
        }
        reject(
          new OrchestratorError(
            "workspace_helper_failed",
            `Trusted Workspace helper failed${stderr.trim() ? `: ${stderr.trim().slice(0, 2_000)}` : ""}`,
            { cause: error },
          ),
        );
      },
    );
  });
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_workspace_helper_output",
      "Trusted Workspace helper returned invalid JSON",
      { cause: error },
    );
  }
}

async function gitDirectory(projectRoot: string): Promise<string> {
  const value = await gitOutput(projectRoot, ["rev-parse", "--git-common-dir"]);
  return realpath(path.resolve(projectRoot, value));
}

async function expectedSource(
  projectRoot: string,
  commit: string,
): Promise<{
  readonly source: WorkspaceSourceManifest;
  readonly gitDirectory: string;
}> {
  const commonDirectory = await gitDirectory(projectRoot);
  const raw = HelperGitManifestSchema.parse(
    await executeHelper(["git-manifest", commonDirectory, commit]),
  );
  const manifest = createWorkspaceManifestFromEntries(raw.manifest.entries);
  if (
    raw.manifest.entry_count !== manifest.entry_count ||
    raw.manifest.byte_count !== manifest.byte_count
  ) {
    throw new OrchestratorError(
      "invalid_workspace_helper_output",
      "Git manifest helper returned inconsistent counts",
    );
  }
  return {
    source: createWorkspaceSourceManifest(raw.commit, 0, manifest),
    gitDirectory: commonDirectory,
  };
}

function pinnedImageDigest(image: string): Digest {
  const parsed = PinnedImageReferenceSchema.parse(image);
  return DigestSchema.parse(parsed.slice(parsed.lastIndexOf("@") + 1));
}

function enabledWorkspace(local: LocalConfig): {
  readonly settings: SharedWorkspaceSettings & {
    readonly enabled: true;
    readonly gateway: string;
    readonly driver_version: string;
  };
  readonly image: PinnedImageReference;
} {
  const settings = local.openshell.shared_workspace;
  if (
    !settings?.enabled ||
    !settings.gateway ||
    !settings.driver_version ||
    !local.openshell.images?.pi
  ) {
    throw new OrchestratorError(
      "shared_workspace_disabled",
      "Read-only Workspace Sessions require enabled shared workspaces and a pinned Pi image",
    );
  }
  return {
    settings: {
      ...settings,
      enabled: true,
      gateway: settings.gateway,
      driver_version: settings.driver_version,
    },
    image: local.openshell.images.pi,
  };
}

function volumeName(
  prefix: string,
  workspaceId: string,
  suffix: string,
): string {
  const tail = `${workspaceId}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${tail}`.slice(0, 255).replace(/[.-]+$/g, "");
}

function sourceVolumeLabels(
  projectId: string,
  workspaceId: string,
  commit: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "pio.kind": "source-workspace",
    "pio.project": projectId,
    "pio.workspace": workspaceId,
    "pio.commit": commit.slice(0, 63),
  });
}

function restrictedMounts(
  manifest: WorkspaceManifest,
  patterns: readonly string[],
): {
  readonly files: readonly string[];
  readonly directories: readonly string[];
} {
  const matched = manifest.entries.filter((entry) =>
    pathMatchesPatterns(entry.path, patterns),
  );
  const directories = matched
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.path)
    .filter(
      (candidate, index, all) =>
        !all.some(
          (parent, parentIndex) =>
            parentIndex !== index && candidate.startsWith(`${parent}/`),
        ),
    );
  const files: string[] = [];
  for (const entry of matched) {
    if (
      entry.type === "directory" ||
      directories.some((directory) => entry.path.startsWith(`${directory}/`))
    ) {
      continue;
    }
    if (entry.type === "symlink") {
      throw new OrchestratorError(
        "unsupported_restricted_path",
        `Restricted symlink '${entry.path}' cannot be projected safely`,
      );
    }
    files.push(entry.path);
  }
  return {
    files: Object.freeze(files),
    directories: Object.freeze(directories),
  };
}

function parseInspectedManifest(source: string): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_workspace_helper_output",
      "Workspace inspection helper returned invalid JSON",
      { cause: error },
    );
  }
  const raw = HelperWorkspaceManifestSchema.parse(value);
  const manifest = createWorkspaceManifestFromEntries(raw.entries);
  if (
    raw.entry_count !== manifest.entry_count ||
    raw.byte_count !== manifest.byte_count
  ) {
    throw new OrchestratorError(
      "invalid_workspace_helper_output",
      "Workspace inspection helper returned inconsistent counts",
    );
  }
  return manifest;
}

export class ReadOnlySourceWorkspace {
  readonly kind = "workspace" as const;
  readonly imageDigest: Digest;
  readonly projectionDigest: Digest;
  private removed = false;

  constructor(
    readonly manifest: WorkspaceSourceManifest,
    readonly volume: DockerVolumeCapability,
    readonly mountSet: OpenShellMountSet,
    readonly image: PinnedImageReference,
    readonly driverVersion: string,
    readonly labels: Readonly<Record<string, string>>,
    private readonly docker: WorkspaceSourceDocker,
  ) {
    this.manifest = validateWorkspaceSourceManifest(manifest);
    if (!(volume instanceof DockerVolumeCapability)) {
      throw new OrchestratorError(
        "invalid_docker_volume",
        "Read-only Workspace requires an inspected volume capability",
      );
    }
    if (
      !(mountSet instanceof OpenShellMountSet) ||
      mountSet.volume !== volume
    ) {
      throw new OrchestratorError(
        "invalid_openshell_mount_set",
        "Read-only Workspace mount set does not bind its inspected volume",
      );
    }
    if (
      mountSet.mounts.some(
        (mount) =>
          !mount.readOnly ||
          ![
            "workspace",
            "restricted-file-mask",
            "restricted-directory-mask",
          ].includes(mount.purpose),
      ) ||
      mountSet.mounts.filter((mount) => mount.purpose === "workspace")
        .length !== 1
    ) {
      throw new OrchestratorError(
        "invalid_openshell_mount_set",
        "Read-only Workspace projection contains writable or unrelated mounts",
      );
    }
    for (const [key, value] of Object.entries(labels)) {
      if (volume.labels[key] !== value) {
        throw new OrchestratorError(
          "docker_volume_label_mismatch",
          `Workspace volume '${volume.name}' does not match label '${key}'`,
        );
      }
    }
    this.image = PinnedImageReferenceSchema.parse(image);
    this.driverVersion = VersionSchema.parse(driverVersion);
    this.imageDigest = pinnedImageDigest(this.image);
    this.projectionDigest = digestParts(
      "pi-orchestrator/read-workspace-projection/v1",
      [
        ["source", this.manifest.source_digest],
        ["generation", String(this.manifest.workspace_generation)],
        ["volume", this.volume.digest],
        ["mount-set", this.mountSet.digest],
        ["image", this.imageDigest],
        ["driver-version", this.driverVersion],
      ],
    );
    Object.freeze(this.labels);
  }

  async verify(): Promise<WorkspaceSourceManifest> {
    if (this.removed) {
      throw new OrchestratorError(
        "workspace_removed",
        `Workspace volume '${this.volume.name}' has been removed`,
      );
    }
    const inspected = await this.docker.inspectVolume(
      this.volume.name,
      this.labels,
    );
    if (!inspected || inspected.digest !== this.volume.digest) {
      throw new OrchestratorError(
        "workspace_volume_changed",
        `Workspace volume '${this.volume.name}' no longer matches its inspected identity`,
      );
    }
    const result = await this.docker.inspectWorkspaceVolume({
      volume: this.volume,
      image: this.image,
    });
    if (result.exitCode !== 0) {
      throw new OrchestratorError(
        "workspace_inspection_failed",
        result.stderr.trim() ||
          `Workspace inspection exited ${result.exitCode}`,
      );
    }
    const observed = parseInspectedManifest(result.stdout);
    if (
      observed.digest !== this.manifest.manifest_digest ||
      canonicalJson(observed.entries) !== canonicalJson(this.manifest.entries)
    ) {
      throw new OrchestratorError(
        "workspace_source_stale",
        `Workspace volume '${this.volume.name}' changed from source ${this.manifest.source_digest}`,
      );
    }
    return this.manifest;
  }

  async dispose(): Promise<void> {
    if (this.removed) return;
    await this.docker.removeVolume(this.volume.name, true);
    this.removed = true;
  }
}

export async function createReadOnlySourceWorkspace(
  options: CreateSourceWorkspaceOptions,
): Promise<ReadOnlySourceWorkspace> {
  const { settings, image } = enabledWorkspace(options.local);
  const docker =
    options.docker ??
    new DockerVolumeClient({
      command: settings.docker_command,
      requiredVersion: settings.driver_version,
    });
  const dockerVersion = await docker.version();
  if (dockerVersion !== settings.driver_version) {
    throw new OrchestratorError(
      "docker_version_mismatch",
      `Docker ${dockerVersion} does not match configured driver ${settings.driver_version}`,
    );
  }
  const expected = await expectedSource(
    path.resolve(options.projectRoot),
    GitCommitSchema.parse(options.commit),
  );
  const suffix = z
    .string()
    .regex(/^[a-z0-9]{6,16}$/)
    .parse(options.suffix?.() ?? randomBytes(4).toString("hex"));
  const name = volumeName(
    options.local.workspace.volume_prefix,
    options.workspaceId,
    suffix,
  );
  const labels = sourceVolumeLabels(
    options.projectId,
    options.workspaceId,
    expected.source.commit,
  );
  let volume: DockerVolumeCapability | undefined;
  try {
    volume = await docker.createVolume(name, labels);
    const seeded = await docker.seedGitWorkspace({
      volume,
      image,
      gitDirectory: expected.gitDirectory,
      commit: expected.source.commit,
    });
    if (seeded.exitCode !== 0) {
      throw new OrchestratorError(
        "workspace_seed_failed",
        seeded.stderr.trim() || `Workspace seeding exited ${seeded.exitCode}`,
      );
    }
    const inspected = await docker.inspectWorkspaceVolume({ volume, image });
    if (inspected.exitCode !== 0) {
      throw new OrchestratorError(
        "workspace_inspection_failed",
        inspected.stderr.trim() ||
          `Workspace inspection exited ${inspected.exitCode}`,
      );
    }
    const observed = parseInspectedManifest(inspected.stdout);
    if (
      observed.digest !== expected.source.manifest_digest ||
      canonicalJson(observed.entries) !== canonicalJson(expected.source.entries)
    ) {
      throw new OrchestratorError(
        "workspace_seed_mismatch",
        "Materialized Workspace does not equal the exact Git commit",
      );
    }
    const restricted = restrictedMounts(
      observed,
      effectiveRestrictedPaths(
        options.restrictedPaths ?? [],
        options.local.workspace.restricted_paths,
      ),
    );
    const mountSet = OpenShellMountSet.forVolume({
      volume,
      restrictedFiles: restricted.files,
      restrictedDirectories: restricted.directories,
    });
    return new ReadOnlySourceWorkspace(
      expected.source,
      volume,
      mountSet,
      image,
      settings.driver_version,
      labels,
      docker,
    );
  } catch (error) {
    if (volume)
      await docker.removeVolume(volume.name, true).catch(() => undefined);
    throw error;
  }
}

export function isReadOnlySourceWorkspace(
  source: PlanningSource,
): source is ReadOnlySourceWorkspace {
  return source instanceof ReadOnlySourceWorkspace;
}

export function workspaceProjectionMatches(
  source: PlanningSource,
  projection: WorkspaceSessionProjection | undefined,
): boolean {
  if (!isReadOnlySourceWorkspace(source)) return projection === undefined;
  if (!projection) return false;
  const parsed = WorkspaceSessionProjectionSchema.safeParse(projection);
  return (
    parsed.success &&
    parsed.data.source_digest === source.manifest.source_digest &&
    parsed.data.workspace_generation === source.manifest.workspace_generation &&
    parsed.data.manifest_digest === source.manifest.manifest_digest &&
    parsed.data.volume_name === source.volume.name &&
    parsed.data.volume_digest === source.volume.digest &&
    parsed.data.mount_set_digest === source.mountSet.digest &&
    parsed.data.image_digest === source.imageDigest &&
    parsed.data.projection_digest === source.projectionDigest
  );
}

export async function recoverReadOnlySourceWorkspace(options: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly manifest: WorkspaceSourceManifest;
  readonly projection: WorkspaceSessionProjection;
  readonly local: LocalConfig;
  readonly restrictedPaths?: readonly string[];
  readonly docker?: WorkspaceSourceDocker;
}): Promise<ReadOnlySourceWorkspace> {
  const manifest = validateWorkspaceSourceManifest(options.manifest);
  const projection = WorkspaceSessionProjectionSchema.parse(options.projection);
  const { settings, image } = enabledWorkspace(options.local);
  const docker =
    options.docker ??
    new DockerVolumeClient({
      command: settings.docker_command,
      requiredVersion: settings.driver_version,
    });
  const dockerVersion = await docker.version();
  if (dockerVersion !== settings.driver_version) {
    throw new OrchestratorError(
      "docker_version_mismatch",
      `Docker ${dockerVersion} does not match configured driver ${settings.driver_version}`,
    );
  }
  const labels = sourceVolumeLabels(
    options.projectId,
    options.workspaceId,
    manifest.commit,
  );
  const volume = await docker.inspectVolume(projection.volume_name, labels);
  if (!volume || volume.digest !== projection.volume_digest) {
    throw new OrchestratorError(
      "workspace_volume_changed",
      `Workspace volume '${projection.volume_name}' no longer matches durable Session evidence`,
    );
  }
  const complete = createWorkspaceManifestFromEntries(manifest.entries);
  const restricted = restrictedMounts(
    complete,
    effectiveRestrictedPaths(
      options.restrictedPaths ?? [],
      options.local.workspace.restricted_paths,
    ),
  );
  const mountSet = OpenShellMountSet.forVolume({
    volume,
    restrictedFiles: restricted.files,
    restrictedDirectories: restricted.directories,
  });
  const workspace = new ReadOnlySourceWorkspace(
    manifest,
    volume,
    mountSet,
    image,
    settings.driver_version,
    labels,
    docker,
  );
  if (!workspaceProjectionMatches(workspace, projection)) {
    throw new OrchestratorError(
      "workspace_projection_mismatch",
      "Recovered Workspace capability does not match durable Session evidence",
    );
  }
  await workspace.verify();
  return workspace;
}

export function planningSourcePaths(
  manifest: PlanningSourceManifest,
): ReadonlySet<string> {
  return new Set(
    manifest.entries
      .filter((entry) => !("type" in entry) || entry.type !== "directory")
      .map((entry) => entry.path),
  );
}

export function planningSourceBytes(manifest: PlanningSourceManifest): number {
  return manifest.entries.reduce(
    (total, entry) =>
      total + ("byte_count" in entry ? entry.byte_count : entry.size),
    0,
  );
}

export async function createPlanningSource(options: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly commit: string;
  readonly local: LocalConfig;
  readonly restrictedPaths: readonly string[];
  readonly temporaryRoot?: string;
  readonly workspaceFactory?: SourceWorkspaceFactory;
}): Promise<PlanningSource> {
  if (options.local.openshell.shared_workspace?.enabled) {
    return (options.workspaceFactory ?? createReadOnlySourceWorkspace)({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      commit: options.commit,
      local: options.local,
      restrictedPaths: options.restrictedPaths,
    });
  }
  return createSourceSnapshot({
    projectRoot: options.projectRoot,
    commit: options.commit,
    paths: ["."],
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
}

export function verifyPlanningSource(
  source: PlanningSource,
): Promise<PlanningSourceManifest> {
  return isReadOnlySourceWorkspace(source)
    ? source.verify()
    : verifySourceSnapshot(source);
}

export async function verifyWorkspaceGateway(
  workspace: ReadOnlySourceWorkspace,
  client: WorkspaceGatewayClient,
  preflight: OpenShellPreflight,
): Promise<void> {
  if (!(workspace instanceof ReadOnlySourceWorkspace)) {
    throw new OrchestratorError(
      "invalid_workspace_projection",
      "Read-only Session requires a trusted Workspace projection",
    );
  }
  if (!client.gateway || client.gateway !== preflight.status.gateway) {
    throw new OrchestratorError(
      "workspace_gateway_mismatch",
      "Workspace Session client and OpenShell preflight identify different gateways",
    );
  }
  const [registrations, info] = await Promise.all([
    client.listGateways(),
    client.getGatewayInfo(),
  ]);
  const registration = registrations.find(
    (candidate) => candidate.name === client.gateway,
  );
  const driver = info.compute_drivers.find(
    (candidate) => candidate.name === "docker",
  );
  if (
    !registration ||
    !registration.active ||
    registration.is_remote ||
    registration.type !== "local" ||
    registration.auth !== "mtls" ||
    registration.endpoint !== info.server ||
    info.gateway !== client.gateway ||
    info.status !== "healthy" ||
    info.version !== preflight.installedVersion ||
    info.server !== preflight.status.server ||
    info.compute_drivers.length !== 1 ||
    !driver ||
    driver.capabilities.driver_name !== "docker" ||
    driver.capabilities.driver_version !== workspace.driverVersion
  ) {
    throw new OrchestratorError(
      "workspace_gateway_unsupported",
      `Gateway '${client.gateway}' is not the required local Docker ${workspace.driverVersion} substrate`,
    );
  }
}
