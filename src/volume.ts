import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import {
  PinnedImageReferenceSchema,
  VersionSchema,
  type PinnedImageReference,
} from "./local.js";
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from "./openshell.js";

export const DockerVolumeNameSchema = z
  .string()
  .min(2)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/, "must be a Docker volume name");

const DockerLabelKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
const DockerLabelValueSchema = z
  .string()
  .max(256)
  .refine((value) => !value.includes("\0"), "must not contain NUL");

const DockerVolumeInspectionSchema = z
  .object({
    CreatedAt: z.string().min(1),
    Driver: z.string().min(1),
    Labels: z.record(z.string(), z.string()).nullable(),
    Mountpoint: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/"), {
        message: "must be an absolute Docker-host path",
      }),
    Name: DockerVolumeNameSchema,
    Options: z.record(z.string(), z.string()).nullable(),
    Scope: z.string().min(1),
  })
  .passthrough();

const DockerImageReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "must not contain NUL");

const defaultRunner: ProcessRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const failure = error as Error & {
          readonly code?: number | string;
          readonly killed?: boolean;
          readonly signal?: NodeJS.Signals;
          readonly stderr?: string;
          readonly stdout?: string;
        };
        if (typeof failure.code !== "number" && !failure.killed) {
          reject(error);
          return;
        }
        resolve({
          stdout: failure.stdout ?? stdout,
          stderr: failure.stderr ?? stderr,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          ...(failure.signal ? { signal: failure.signal } : {}),
        });
      },
    );
  });

function commandFailure(args: readonly string[], result: ProcessResult) {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  return new OrchestratorError(
    "docker_failed",
    `Docker command failed with exit ${result.exitCode}: ${args.join(" ")}${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
  );
}

function labels(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    result[DockerLabelKeySchema.parse(key)] =
      DockerLabelValueSchema.parse(labelValue);
  }
  return Object.freeze(result);
}

export class DockerVolumeCapability {
  readonly name: string;
  readonly driver: "local";
  readonly scope: "local";
  readonly createdAt: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly digest: Digest;

  private constructor(input: {
    readonly name: string;
    readonly createdAt: string;
    readonly mountpoint: string;
    readonly labels: Readonly<Record<string, string>>;
  }) {
    this.name = input.name;
    this.driver = "local";
    this.scope = "local";
    this.createdAt = input.createdAt;
    this.mountpoint = input.mountpoint;
    this.labels = labels(input.labels);
    this.digest = digestParts("pi-orchestrator/docker-volume/v1", [
      ["name", this.name],
      ["driver", this.driver],
      ["scope", this.scope],
      ["created-at", this.createdAt],
      ["mountpoint", this.mountpoint],
      ["labels", canonicalJson(this.labels)],
    ]);
    Object.freeze(this);
  }

  static fromInspection(
    input: unknown,
    expectedName: string,
    expectedLabels: Readonly<Record<string, string>>,
  ): DockerVolumeCapability {
    const inspection = DockerVolumeInspectionSchema.safeParse(input);
    if (!inspection.success) {
      throw new OrchestratorError(
        "invalid_docker_output",
        `Docker volume inspection did not match the expected contract: ${inspection.error.message}`,
      );
    }
    const expected = labels(expectedLabels);
    const actual = inspection.data;
    if (
      actual.Name !== DockerVolumeNameSchema.parse(expectedName) ||
      actual.Driver !== "local" ||
      actual.Scope !== "local" ||
      (actual.Options !== null && Object.keys(actual.Options).length > 0)
    ) {
      throw new OrchestratorError(
        "unsafe_docker_volume",
        `Docker volume '${actual.Name}' is not a plain local named volume`,
      );
    }
    const actualLabels = actual.Labels ?? {};
    for (const [key, value] of Object.entries(expected)) {
      if (actualLabels[key] !== value) {
        throw new OrchestratorError(
          "docker_volume_label_mismatch",
          `Docker volume '${actual.Name}' does not have expected label '${key}'`,
        );
      }
    }
    return new DockerVolumeCapability({
      name: actual.Name,
      createdAt: actual.CreatedAt,
      mountpoint: actual.Mountpoint,
      labels: actualLabels,
    });
  }
}

export interface DockerVolumeClientOptions {
  readonly command?: string;
  readonly requiredVersion?: string;
  readonly runner?: ProcessRunner;
}

export interface RunVolumeOptions {
  readonly volume: DockerVolumeCapability;
  readonly image: string;
  readonly command: readonly string[];
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
}

export interface SeedGitWorkspaceOptions {
  readonly volume: DockerVolumeCapability;
  readonly image: PinnedImageReference;
  readonly gitDirectory: string;
  readonly commit: string;
  readonly timeoutMs?: number;
}

export interface InspectWorkspaceVolumeOptions {
  readonly volume: DockerVolumeCapability;
  readonly image: PinnedImageReference;
  readonly timeoutMs?: number;
}

export class DockerVolumeClient {
  readonly command: string;
  readonly requiredVersion: string | undefined;
  private readonly runner: ProcessRunner;

  constructor(options: DockerVolumeClientOptions = {}) {
    this.command = options.command ?? "docker";
    this.requiredVersion = options.requiredVersion
      ? VersionSchema.parse(options.requiredVersion)
      : undefined;
    this.runner = options.runner ?? defaultRunner;
  }

  private async execute(
    args: readonly string[],
    options: ProcessRunOptions & { readonly check?: boolean } = {},
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner(this.command, args, options);
    } catch (error) {
      throw new OrchestratorError(
        "docker_failed",
        `Cannot execute Docker command: ${this.command} ${args.join(" ")}`,
        { cause: error },
      );
    }
    if ((options.check ?? true) && result.exitCode !== 0) {
      throw commandFailure(args, result);
    }
    return result;
  }

  async version(): Promise<string> {
    const result = await this.execute([
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const version = VersionSchema.safeParse(result.stdout.trim());
    if (!version.success) {
      throw new OrchestratorError(
        "invalid_docker_output",
        "Docker version output did not contain a semantic server version",
      );
    }
    if (this.requiredVersion && version.data !== this.requiredVersion) {
      throw new OrchestratorError(
        "docker_version_mismatch",
        `Docker ${version.data} is installed; ${this.requiredVersion} is required`,
      );
    }
    return version.data;
  }

  async createVolume(
    name: string,
    expectedLabels: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability> {
    const volumeName = DockerVolumeNameSchema.parse(name);
    const expected = labels(expectedLabels);
    await this.execute([
      "volume",
      "create",
      "--driver",
      "local",
      ...Object.entries(expected).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      volumeName,
    ]);
    const volume = await this.inspectVolume(volumeName, expected);
    if (!volume) {
      throw new OrchestratorError(
        "docker_volume_missing",
        `Docker did not retain volume '${volumeName}' after creation`,
      );
    }
    return volume;
  }

  async inspectVolume(
    name: string,
    expectedLabels: Readonly<Record<string, string>> = {},
  ): Promise<DockerVolumeCapability | undefined> {
    const volumeName = DockerVolumeNameSchema.parse(name);
    const result = await this.execute(
      ["volume", "inspect", volumeName, "--format", "{{json .}}"],
      { check: false },
    );
    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.trim() || result.stdout.trim();
      if (/no such volume/i.test(diagnostic)) return undefined;
      throw commandFailure(
        ["volume", "inspect", volumeName, "--format", "{{json .}}"],
        result,
      );
    }
    let inspection: unknown;
    try {
      inspection = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new OrchestratorError(
        "invalid_docker_output",
        "Docker volume inspect returned invalid JSON",
        { cause: error },
      );
    }
    return DockerVolumeCapability.fromInspection(
      inspection,
      volumeName,
      expectedLabels,
    );
  }

  async runVolume(options: RunVolumeOptions): Promise<ProcessResult> {
    if (!(options.volume instanceof DockerVolumeCapability)) {
      throw new OrchestratorError(
        "invalid_docker_volume",
        "Docker helpers require an inspected named-volume capability",
      );
    }
    const image = DockerImageReferenceSchema.parse(options.image);
    if (options.command.length === 0) {
      throw new OrchestratorError(
        "invalid_docker_request",
        "A Docker helper command cannot be empty",
      );
    }
    return this.execute(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${options.volume.name},target=/run-volume${options.readOnly ? ",readonly" : ""}`,
        image,
        ...options.command,
      ],
      { timeoutMs: options.timeoutMs ?? 2 * 60_000 },
    );
  }

  async seedGitWorkspace(
    options: SeedGitWorkspaceOptions,
  ): Promise<ProcessResult> {
    if (!(options.volume instanceof DockerVolumeCapability)) {
      throw new OrchestratorError(
        "invalid_docker_volume",
        "Workspace seeding requires an inspected named-volume capability",
      );
    }
    const image = PinnedImageReferenceSchema.parse(options.image);
    const commit = z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .parse(options.commit);
    const gitDirectory = await realpath(options.gitDirectory).catch(
      (error: unknown) => {
        throw new OrchestratorError(
          "invalid_git_directory",
          "Workspace seeding Git directory is not accessible",
          { cause: error },
        );
      },
    );
    const state = await stat(gitDirectory);
    if (!state.isDirectory() || gitDirectory.includes(",")) {
      throw new OrchestratorError(
        "invalid_git_directory",
        "Workspace seeding requires a real Git directory without Docker mount delimiters",
      );
    }
    return this.execute(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "0:0",
        "--env",
        "HOME=/tmp",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=268435456",
        "--mount",
        `type=volume,source=${options.volume.name},target=/run-volume`,
        "--mount",
        `type=bind,source=${gitDirectory},target=/repository.git,readonly`,
        image,
        "/usr/bin/node",
        "/usr/local/lib/pi-orchestrator/workspace.mjs",
        "seed",
        "/repository.git",
        commit,
        "/run-volume",
      ],
      { timeoutMs: options.timeoutMs ?? 10 * 60_000 },
    );
  }

  async inspectWorkspaceVolume(
    options: InspectWorkspaceVolumeOptions,
  ): Promise<ProcessResult> {
    if (!(options.volume instanceof DockerVolumeCapability)) {
      throw new OrchestratorError(
        "invalid_docker_volume",
        "Workspace inspection requires an inspected named-volume capability",
      );
    }
    const image = PinnedImageReferenceSchema.parse(options.image);
    return this.execute(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "0:0",
        "--env",
        "HOME=/tmp",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=67108864",
        "--mount",
        `type=volume,source=${options.volume.name},target=/run-volume,readonly`,
        image,
        "/usr/bin/node",
        "/usr/local/lib/pi-orchestrator/workspace.mjs",
        "inspect",
        "/run-volume/project",
      ],
      { timeoutMs: options.timeoutMs ?? 10 * 60_000 },
    );
  }

  async removeVolume(name: string, missingOk = false): Promise<void> {
    const volumeName = DockerVolumeNameSchema.parse(name);
    const args = ["volume", "rm", volumeName];
    const result = await this.execute(args, { check: false });
    if (result.exitCode === 0) return;
    if (missingOk && !(await this.inspectVolume(volumeName))) return;
    throw commandFailure(args, result);
  }
}
