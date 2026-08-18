import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";

const GitObjectSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const SnapshotPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine((value) => {
    const normalized = path.posix.normalize(value);
    return normalized !== ".." && !normalized.startsWith("../");
  }, "must not escape the Project")
  .refine(
    (value) => !value.split("/").includes(".git"),
    "must not select Git metadata",
  );

export const SnapshotEntrySchema = z
  .object({
    path: SnapshotPathSchema,
    mode: z.enum(["100644", "100755", "120000"]),
    object: GitObjectSchema,
    size: z.number().int().nonnegative(),
  })
  .strict();
export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

export const SourceSnapshotManifestSchema = z
  .object({
    version: z.literal(1),
    commit: GitObjectSchema,
    selected_paths: z.array(SnapshotPathSchema).min(1),
    entries: z.array(SnapshotEntrySchema).min(1),
    archive_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    archive_bytes: z.number().int().positive(),
    source_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type SourceSnapshotManifest = z.infer<
  typeof SourceSnapshotManifestSchema
>;

export interface SourceSnapshot {
  readonly directory: string;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly manifest: SourceSnapshotManifest;
  dispose(): Promise<void>;
}

export interface SourceSnapshotOptions {
  readonly projectRoot: string;
  readonly commit: string;
  readonly paths: readonly string[];
  readonly temporaryRoot?: string;
}

function snapshotGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && value !== undefined)
      environment[name] = value;
  }
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LANG = "C.UTF-8";
  return environment;
}

async function gitBuffer(
  root: string,
  args: readonly string[],
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: snapshotGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      reject(
        new OrchestratorError(
          "git_failed",
          `Cannot execute git ${args.join(" ")}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      if (exceeded) {
        reject(
          new OrchestratorError(
            "snapshot_too_large",
            `git ${args[0] ?? "command"} output exceeded ${maxBytes} bytes`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new OrchestratorError(
            "git_failed",
            `git ${args.join(" ")} failed${diagnostic ? `: ${diagnostic.slice(0, 1_000)}` : ""}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function selectedPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    throw new OrchestratorError(
      "invalid_snapshot_path",
      `Snapshot path '${value}' must be a non-empty relative path`,
    );
  }
  const normalizedPath = path.posix.normalize(value.replace(/^\.\//, ""));
  const normalized =
    normalizedPath === "." ? normalizedPath : normalizedPath.replace(/\/$/, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes(".git")
  ) {
    throw new OrchestratorError(
      "invalid_snapshot_path",
      `Snapshot path '${value}' escapes the Project or selects Git metadata`,
    );
  }
  return normalized;
}

function parseTree(source: Buffer): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new OrchestratorError(
      "unsupported_snapshot_entry",
      "Snapshot paths must be valid UTF-8",
      { cause: error },
    );
  }
  for (const record of decoded.split("\0")) {
    if (record.length === 0) continue;
    const match =
      /^([0-7]{6}) ([a-z]+) ((?:[a-f0-9]{40}|[a-f0-9]{64})) +([0-9-]+)\t([\s\S]+)$/.exec(
        record,
      );
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
      throw new OrchestratorError(
        "invalid_git_tree",
        "Git returned an unrecognized tree record",
      );
    }
    if (
      match[2] !== "blob" ||
      !["100644", "100755", "120000"].includes(match[1])
    ) {
      throw new OrchestratorError(
        "unsupported_snapshot_entry",
        `Snapshot entry '${match[5]}' has unsupported type ${match[2]} mode ${match[1]}`,
      );
    }
    const size = Number(match[4]);
    entries.push(
      SnapshotEntrySchema.parse({
        path: match[5],
        mode: match[1],
        object: match[3],
        size,
      }),
    );
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function parseFilterAttributes(
  source: Buffer,
  expectedPaths: readonly string[],
): void {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_git_output",
      "Git attribute paths must be valid UTF-8",
      { cause: error },
    );
  }
  if (!decoded.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git check-attr did not terminate its records",
    );
  }
  const values = decoded.slice(0, -1).split("\0");
  if (values.length !== expectedPaths.length * 3) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git check-attr returned an unexpected record count",
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 3) {
    const entryPath = SnapshotPathSchema.parse(values[index]);
    const value = values[index + 2];
    if (
      values[index + 1] !== "filter" ||
      !expectedPaths.includes(entryPath) ||
      seen.has(entryPath) ||
      value === undefined
    ) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git check-attr returned an invalid filter record",
      );
    }
    seen.add(entryPath);
    if (value !== "unspecified" && value !== "unset") {
      throw new OrchestratorError(
        "snapshot_filter_unsupported",
        `Snapshot path '${entryPath}' has Git clean filter '${value}'; host snapshots do not execute filters`,
      );
    }
  }
}

async function requireNoSnapshotFilters(
  root: string,
  commit: string,
  paths: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += 128) {
    const selected = paths.slice(offset, offset + 128);
    parseFilterAttributes(
      await gitBuffer(root, [
        "check-attr",
        `--source=${commit}`,
        "-z",
        "filter",
        "--",
        ...selected,
      ]),
      selected,
    );
  }
}

async function fileDigest(filePath: string): Promise<Digest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function snapshotDigest(
  manifest: Pick<
    SourceSnapshotManifest,
    "commit" | "selected_paths" | "entries" | "archive_digest"
  >,
): Digest {
  return digestParts("pi-orchestrator/source-snapshot/v1", [
    ["commit", manifest.commit],
    ["selected-paths", canonicalJson(manifest.selected_paths)],
    ["entries", canonicalJson(manifest.entries)],
    ["archive-digest", manifest.archive_digest],
  ]);
}

export async function verifySourceSnapshot(
  snapshot: Pick<SourceSnapshot, "archivePath" | "manifestPath" | "manifest">,
): Promise<SourceSnapshotManifest> {
  const manifest = SourceSnapshotManifestSchema.parse(snapshot.manifest);
  let stored: SourceSnapshotManifest;
  try {
    stored = SourceSnapshotManifestSchema.parse(
      JSON.parse(await readFile(snapshot.manifestPath, "utf8")) as unknown,
    );
  } catch (error) {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot manifest cannot be read or validated",
      { cause: error },
    );
  }
  if (canonicalJson(stored) !== canonicalJson(manifest)) {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot manifest does not match its in-memory binding",
    );
  }

  const archive = await lstat(snapshot.archivePath).catch((error: unknown) => {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot archive is not accessible",
      { cause: error },
    );
  });
  if (!archive.isFile() || archive.size !== manifest.archive_bytes) {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot archive size does not match its manifest",
    );
  }
  if ((await fileDigest(snapshot.archivePath)) !== manifest.archive_digest) {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot archive digest does not match its manifest",
    );
  }
  if (snapshotDigest(manifest) !== manifest.source_digest) {
    throw new OrchestratorError(
      "invalid_source_snapshot",
      "Source snapshot digest is invalid",
    );
  }
  return manifest;
}

export async function createSourceSnapshot(
  options: SourceSnapshotOptions,
): Promise<SourceSnapshot> {
  const root = path.resolve(options.projectRoot);
  const selectedPaths = [...new Set(options.paths.map(selectedPath))].sort();
  if (selectedPaths.length === 0) {
    throw new OrchestratorError(
      "invalid_snapshot_path",
      "A source snapshot requires at least one selected path",
    );
  }

  const resolvedCommit = (
    await gitBuffer(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${options.commit}^{commit}`,
    ])
  )
    .toString("utf8")
    .trim();
  GitObjectSchema.parse(resolvedCommit);
  const entries = parseTree(
    await gitBuffer(root, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      "-l",
      "--full-tree",
      resolvedCommit,
      "--",
      ...selectedPaths,
    ]),
  );
  if (entries.length === 0) {
    throw new OrchestratorError(
      "empty_snapshot",
      "The selected paths contain no tracked files at the requested commit",
    );
  }
  await requireNoSnapshotFilters(
    root,
    resolvedCommit,
    entries.map((entry) => entry.path),
  );

  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(temporaryRoot, "pi-orchestrator-snapshot-"),
  );
  const archivePath = path.join(directory, "source.tar");
  const manifestPath = path.join(directory, "snapshot.json");

  try {
    await gitBuffer(root, [
      "--literal-pathspecs",
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      resolvedCommit,
      "--",
      ...selectedPaths,
    ]);
    const archive = await stat(archivePath);
    const archiveDigest = await fileDigest(archivePath);
    const sourceDigest = snapshotDigest({
      commit: resolvedCommit,
      selected_paths: selectedPaths,
      entries,
      archive_digest: archiveDigest,
    });
    const manifest = SourceSnapshotManifestSchema.parse({
      version: 1,
      commit: resolvedCommit,
      selected_paths: selectedPaths,
      entries,
      archive_digest: archiveDigest,
      archive_bytes: archive.size,
      source_digest: sourceDigest,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      directory,
      archivePath,
      manifestPath,
      manifest,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
