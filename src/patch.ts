import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  MAX_ARTIFACT_BYTES,
  type ArtifactDescriptor,
  type ArtifactOpenShell,
  type ArtifactStore,
  type ImportedArtifact,
} from "./artifact.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import type { OpenShellSandbox } from "./openshell.js";
import type { SessionIdentity } from "./session.js";
import {
  verifySourceSnapshot,
  type SourceSnapshot,
  type SourceSnapshotManifest,
} from "./snapshot.js";

export const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decoder = new TextDecoder("utf-8", { fatal: true });

const WorkspacePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine(
    (value) => path.posix.normalize(value) === value,
    "must be normalized",
  )
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.startsWith("../") &&
      !value.split("/").includes(".git"),
    "must remain inside the workspace and exclude Git metadata",
  );

export const WorkspaceEntrySchema = z
  .object({
    path: WorkspacePathSchema,
    mode: z.enum(["100644", "100755", "120000"]),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content_digest: DigestSchema,
  })
  .strict();
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const PatchChangeSchema = z
  .object({
    path: WorkspacePathSchema,
    status: z.enum(["added", "modified", "deleted"]),
    before: WorkspaceEntrySchema.optional(),
    after: WorkspaceEntrySchema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    const before = change.before;
    const after = change.after;
    const shapeIsValid =
      (change.status === "added" &&
        before === undefined &&
        after !== undefined) ||
      (change.status === "modified" &&
        before !== undefined &&
        after !== undefined) ||
      (change.status === "deleted" &&
        before !== undefined &&
        after === undefined);
    if (!shapeIsValid) {
      context.addIssue({
        code: "custom",
        message: `status '${change.status}' has invalid before/after entries`,
      });
    }
    if (before && before.path !== change.path) {
      context.addIssue({
        code: "custom",
        path: ["before", "path"],
        message: "must equal the changed path",
      });
    }
    if (after && after.path !== change.path) {
      context.addIssue({
        code: "custom",
        path: ["after", "path"],
        message: "must equal the changed path",
      });
    }
    if (before && after && canonicalJson(before) === canonicalJson(after)) {
      context.addIssue({
        code: "custom",
        message: "a modified entry must change",
      });
    }
  });
export type PatchChange = z.infer<typeof PatchChangeSchema>;

const EncodedPatchSchema = z
  .object({
    encoding: z.literal("base64"),
    byte_count: z.number().int().positive().max(MAX_PATCH_BYTES),
    content_digest: DigestSchema,
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_PATCH_BYTES * 4) / 3) + 4),
  })
  .strict();

export const PatchBundleSchema = z
  .object({
    version: z.literal(1),
    source_digest: DigestSchema,
    base_tree_digest: DigestSchema,
    result_tree_digest: DigestSchema,
    diff_digest: DigestSchema,
    changes: z.array(PatchChangeSchema).min(1).max(MAX_TREE_ENTRIES),
    patch: EncodedPatchSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    for (let index = 0; index < bundle.changes.length; index += 1) {
      if (
        index > 0 &&
        compareUtf8(
          bundle.changes[index - 1]!.path,
          bundle.changes[index]!.path,
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: "changed paths must be unique and sorted",
        });
      }
    }
  });
export type PatchBundle = z.infer<typeof PatchBundleSchema>;

export interface VerifiedPatch {
  readonly bundle: PatchBundle;
  readonly patch: Buffer;
  readonly baseEntries: readonly WorkspaceEntry[];
  readonly resultEntries: readonly WorkspaceEntry[];
}

export interface PatchContractOptions {
  readonly snapshot: SourceSnapshot;
  readonly temporaryRoot?: string;
}

export interface ImportPatchArtifactOptions extends PatchContractOptions {
  readonly store: ArtifactStore;
  readonly client: ArtifactOpenShell;
  readonly descriptor: ArtifactDescriptor;
  readonly identity: SessionIdentity;
  readonly task: string;
  readonly sourceSandbox: OpenShellSandbox;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function patchDigest(bundle: Omit<PatchBundle, "diff_digest">): Digest {
  return digestParts("pi-orchestrator/patch/v1", [
    ["source-digest", bundle.source_digest],
    ["base-tree-digest", bundle.base_tree_digest],
    ["result-tree-digest", bundle.result_tree_digest],
    ["changes", canonicalJson(bundle.changes)],
    ["patch-digest", bundle.patch.content_digest],
  ]);
}

function workspaceTreeDigest(entries: readonly WorkspaceEntry[]): Digest {
  return digestParts("pi-orchestrator/workspace-tree/v1", [
    ["entries", canonicalJson(entries)],
  ]);
}

function decodePatch(bundle: PatchBundle): Buffer {
  if (
    bundle.patch.data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      bundle.patch.data,
    )
  ) {
    throw new OrchestratorError(
      "invalid_patch_bundle",
      "Patch data is not canonical base64",
    );
  }
  const patch = Buffer.from(bundle.patch.data, "base64");
  if (
    patch.toString("base64") !== bundle.patch.data ||
    patch.byteLength !== bundle.patch.byte_count ||
    sha256(patch) !== bundle.patch.content_digest
  ) {
    throw new OrchestratorError(
      "invalid_patch_bundle",
      "Patch bytes do not match their declared size and digest",
    );
  }
  const { diff_digest: _diffDigest, ...digestInput } = bundle;
  if (patchDigest(digestInput) !== bundle.diff_digest) {
    throw new OrchestratorError(
      "invalid_patch_bundle",
      "Patch diff digest is invalid",
    );
  }
  return patch;
}

function parsePatchPayload(
  payload: Uint8Array,
  source: SourceSnapshotManifest,
): { readonly bundle: PatchBundle; readonly patch: Buffer } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload)) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_patch_bundle",
      "Patch Artifact is not valid UTF-8 JSON",
      { cause: error },
    );
  }
  const parsed = PatchBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_patch_bundle",
      `Patch Artifact has an invalid schema: ${parsed.error.message}`,
    );
  }
  if (parsed.data.source_digest !== source.source_digest) {
    throw new OrchestratorError(
      "patch_source_mismatch",
      "Patch Artifact does not identify the supplied source snapshot",
    );
  }
  return { bundle: parsed.data, patch: decodePatch(parsed.data) };
}

async function hashFile(filePath: string): Promise<{
  readonly size: number;
  readonly digest: Digest;
}> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new OrchestratorError(
        "unsupported_patch_entry",
        `Patch workspace entry '${filePath}' is not a regular file`,
      );
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new OrchestratorError(
        "patch_workspace_changed",
        `Patch workspace entry '${filePath}' changed during verification`,
      );
    }
    return {
      size: after.size,
      digest: `sha256:${hash.digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
}

async function workspaceEntries(root: string): Promise<WorkspaceEntry[]> {
  const rootState = await lstat(root).catch((error: unknown) => {
    throw new OrchestratorError(
      "invalid_patch_workspace",
      `Patch workspace '${root}' is not accessible`,
      { cause: error },
    );
  });
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new OrchestratorError(
      "invalid_patch_workspace",
      `Patch workspace '${root}' is not a directory`,
    );
  }
  const entries: WorkspaceEntry[] = [];

  const visit = async (directory: string, prefix: string): Promise<void> => {
    let names: Buffer[];
    try {
      names = await readdir(directory, { encoding: "buffer" });
    } catch (error) {
      throw new OrchestratorError(
        "invalid_patch_workspace",
        `Cannot read Patch workspace directory '${directory}'`,
        { cause: error },
      );
    }
    names.sort(Buffer.compare);
    for (const name of names) {
      let decoded: string;
      try {
        decoded = decoder.decode(name);
      } catch (error) {
        throw new OrchestratorError(
          "unsupported_patch_entry",
          "Patch workspace paths must be valid UTF-8",
          { cause: error },
        );
      }
      const relative = WorkspacePathSchema.parse(
        prefix.length === 0 ? decoded : `${prefix}/${decoded}`,
      );
      const absolute = path.join(directory, decoded);
      const state = await lstat(absolute);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        await visit(absolute, relative);
        continue;
      }
      if (entries.length >= MAX_TREE_ENTRIES) {
        throw new OrchestratorError(
          "patch_tree_too_large",
          `Patch workspace contains more than ${MAX_TREE_ENTRIES} entries`,
        );
      }
      if (state.isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: "buffer" });
        entries.push(
          WorkspaceEntrySchema.parse({
            path: relative,
            mode: "120000",
            size: target.byteLength,
            content_digest: sha256(target),
          }),
        );
        continue;
      }
      if (!state.isFile()) {
        throw new OrchestratorError(
          "unsupported_patch_entry",
          `Patch workspace contains unsupported entry '${relative}'`,
        );
      }
      const content = await hashFile(absolute);
      entries.push(
        WorkspaceEntrySchema.parse({
          path: relative,
          mode: (state.mode & 0o111) === 0 ? "100644" : "100755",
          size: content.size,
          content_digest: content.digest,
        }),
      );
    }
  };

  await visit(root, "");
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

function changeManifest(
  before: readonly WorkspaceEntry[],
  after: readonly WorkspaceEntry[],
): PatchChange[] {
  const base = new Map(before.map((entry) => [entry.path, entry]));
  const result = new Map(after.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...base.keys(), ...result.keys()])].sort(
    compareUtf8,
  );
  return paths.flatMap((entryPath) => {
    const oldEntry = base.get(entryPath);
    const newEntry = result.get(entryPath);
    if (canonicalJson(oldEntry) === canonicalJson(newEntry)) return [];
    if (!oldEntry) {
      return [
        PatchChangeSchema.parse({
          path: entryPath,
          status: "added",
          after: newEntry,
        }),
      ];
    }
    if (!newEntry) {
      return [
        PatchChangeSchema.parse({
          path: entryPath,
          status: "deleted",
          before: oldEntry,
        }),
      ];
    }
    return [
      PatchChangeSchema.parse({
        path: entryPath,
        status: "modified",
        before: oldEntry,
        after: newEntry,
      }),
    ];
  });
}

async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: {
          HOME: "/nonexistent",
          LANG: "C.UTF-8",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const diagnostic = stderr.trim() || stdout.trim();
        reject(
          new OrchestratorError(
            "patch_verification_failed",
            `${executable} ${args.join(" ")} failed${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

async function replayPatch(options: {
  readonly snapshot: SourceSnapshot;
  readonly bundle: PatchBundle;
  readonly patch: Buffer;
  readonly temporaryRoot?: string;
}): Promise<VerifiedPatch> {
  const root = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "pi-orchestrator-patch-"));
  const base = path.join(directory, "base");
  const project = path.join(directory, "project");
  const patchPath = path.join(directory, "change.patch");
  try {
    await Promise.all([mkdir(base), mkdir(project)]);
    await command(
      "tar",
      ["-xf", options.snapshot.archivePath, "-C", base],
      directory,
    );
    await command(
      "tar",
      ["-xf", options.snapshot.archivePath, "-C", project],
      directory,
    );
    const baseEntries = await workspaceEntries(base);
    if (workspaceTreeDigest(baseEntries) !== options.bundle.base_tree_digest) {
      throw new OrchestratorError(
        "patch_base_mismatch",
        "Patch base tree does not match the supplied source snapshot",
      );
    }
    await writeFile(patchPath, options.patch, { mode: 0o600 });
    const applyArgs = [
      "apply",
      "--binary",
      "--whitespace=nowarn",
      "-p2",
      patchPath,
    ] as const;
    await command("git", ["apply", "--check", ...applyArgs.slice(1)], project);
    await command("git", applyArgs, project);

    const [baseAfter, resultEntries] = await Promise.all([
      workspaceEntries(base),
      workspaceEntries(project),
    ]);
    if (canonicalJson(baseAfter) !== canonicalJson(baseEntries)) {
      throw new OrchestratorError(
        "patch_base_changed",
        "Patch replay modified its immutable base tree",
      );
    }
    if (
      workspaceTreeDigest(resultEntries) !== options.bundle.result_tree_digest
    ) {
      throw new OrchestratorError(
        "patch_result_mismatch",
        "Patch replay result does not match its declared tree digest",
      );
    }
    const changes = changeManifest(baseEntries, resultEntries);
    if (canonicalJson(changes) !== canonicalJson(options.bundle.changes)) {
      throw new OrchestratorError(
        "patch_manifest_mismatch",
        "Patch replay changes do not match the declared file manifest",
      );
    }
    return {
      bundle: options.bundle,
      patch: options.patch,
      baseEntries,
      resultEntries,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyPatchBundle(options: {
  readonly payload: Uint8Array;
  readonly snapshot: SourceSnapshot;
  readonly temporaryRoot?: string;
}): Promise<VerifiedPatch> {
  const source = await verifySourceSnapshot(options.snapshot);
  const parsed = parsePatchPayload(options.payload, source);
  return replayPatch({
    snapshot: options.snapshot,
    bundle: parsed.bundle,
    patch: parsed.patch,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
}

export function patchArtifactContract(options: PatchContractOptions) {
  return {
    kind: "patch",
    mediaType: "application/json",
    schema: "patch/v1",
    maxBytes: MAX_ARTIFACT_BYTES,
    validate(payload: Uint8Array) {
      return verifyPatchBundle({
        payload,
        snapshot: options.snapshot,
        ...(options.temporaryRoot
          ? { temporaryRoot: options.temporaryRoot }
          : {}),
      });
    },
  } as const;
}

export function importPatchArtifact(
  options: ImportPatchArtifactOptions,
): Promise<ImportedArtifact<VerifiedPatch>> {
  return options.store.importFromSandbox({
    client: options.client,
    descriptor: options.descriptor,
    contract: patchArtifactContract({
      snapshot: options.snapshot,
      ...(options.temporaryRoot
        ? { temporaryRoot: options.temporaryRoot }
        : {}),
    }),
    identity: options.identity,
    task: options.task,
    sourceSandbox: options.sourceSandbox,
  });
}
