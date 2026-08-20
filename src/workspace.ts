import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";

export const MAX_WORKSPACE_ENTRIES = 1_000_000;
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_PATH_BYTES = 4_096;
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decoder = new TextDecoder("utf-8", { fatal: true });

export const RunWorkspacePathSchema = z
  .string()
  .min(1)
  .max(MAX_WORKSPACE_PATH_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_WORKSPACE_PATH_BYTES,
    `must be at most ${MAX_WORKSPACE_PATH_BYTES} UTF-8 bytes`,
  )
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
    (value) => !value.split("/").includes(".git"),
    "must not address Git metadata",
  );
export type RunWorkspacePath = z.infer<typeof RunWorkspacePathSchema>;

export const WritePathSchema = RunWorkspacePathSchema.refine(
  (value) => !/[*?[\]{}]/u.test(value),
  "must be a literal path without glob syntax",
)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  )
  .refine(
    (value) => !value.includes(":"),
    "must not use platform-ambiguous drive or stream syntax",
  );
export type WritePath = z.infer<typeof WritePathSchema>;

const WorkspaceDirectoryEntrySchema = z
  .object({
    path: RunWorkspacePathSchema,
    type: z.literal("directory"),
    byte_count: z.literal(0),
  })
  .strict();

const WorkspaceFileEntrySchema = z
  .object({
    path: RunWorkspacePathSchema,
    type: z.enum(["regular", "executable"]),
    byte_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content_digest: DigestSchema,
  })
  .strict();

const CanonicalBase64Schema = z.string().refine((value) => {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}, "must be canonical base64");

const WorkspaceSymlinkEntrySchema = z
  .object({
    path: RunWorkspacePathSchema,
    type: z.literal("symlink"),
    byte_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    link_target_base64: CanonicalBase64Schema,
    link_target_digest: DigestSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const target = Buffer.from(entry.link_target_base64, "base64");
    if (target.byteLength !== entry.byte_count) {
      context.addIssue({
        code: "custom",
        path: ["byte_count"],
        message: "must equal the encoded link-target byte count",
      });
    }
    if (sha256(target) !== entry.link_target_digest) {
      context.addIssue({
        code: "custom",
        path: ["link_target_digest"],
        message: "must match the encoded link-target bytes",
      });
    }
  });

export const WorkspaceManifestEntrySchema = z.discriminatedUnion("type", [
  WorkspaceDirectoryEntrySchema,
  WorkspaceFileEntrySchema,
  WorkspaceSymlinkEntrySchema,
]);
export type WorkspaceManifestEntry = z.infer<
  typeof WorkspaceManifestEntrySchema
>;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

const WorkspaceManifestRecordSchema = z
  .object({
    version: z.literal(2),
    entry_count: z.number().int().nonnegative().max(MAX_WORKSPACE_ENTRIES),
    byte_count: z.number().int().nonnegative().max(MAX_WORKSPACE_BYTES),
    entries: z.array(WorkspaceManifestEntrySchema).max(MAX_WORKSPACE_ENTRIES),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.entry_count !== manifest.entries.length) {
      context.addIssue({
        code: "custom",
        path: ["entry_count"],
        message: "must equal the number of entries",
      });
    }
    const byteCount = manifest.entries.reduce(
      (total, entry) => total + entry.byte_count,
      0,
    );
    if (!Number.isSafeInteger(byteCount) || byteCount !== manifest.byte_count) {
      context.addIssue({
        code: "custom",
        path: ["byte_count"],
        message: "must equal the sum of entry byte counts",
      });
    }
    for (let index = 1; index < manifest.entries.length; index += 1) {
      if (
        compareUtf8(
          manifest.entries[index - 1]!.path,
          manifest.entries[index]!.path,
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "entries must have unique paths sorted by raw UTF-8 bytes",
        });
      }
    }
  });

export const WorkspaceManifestSchema = WorkspaceManifestRecordSchema.extend({
  digest: DigestSchema,
}).strict();
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const WorkspaceEntryModeSchema = z.enum([
  "040000",
  "100644",
  "100755",
  "120000",
]);
export type WorkspaceEntryMode = z.infer<typeof WorkspaceEntryModeSchema>;

export const WorkspaceEntryStateSchema = z
  .object({
    mode: WorkspaceEntryModeSchema,
    byte_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content_digest: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.mode === "040000") !== (entry.content_digest === null)) {
      context.addIssue({
        code: "custom",
        path: ["content_digest"],
        message: "must be null exactly for a directory",
      });
    }
  });
export type WorkspaceEntryState = z.infer<typeof WorkspaceEntryStateSchema>;

export const WorkspaceManifestChangeSchema = z
  .object({
    path: RunWorkspacePathSchema,
    kind: z.enum(["addition", "modification", "deletion", "mode", "symlink"]),
    before: WorkspaceEntryStateSchema.nullable(),
    after: WorkspaceEntryStateSchema.nullable(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.kind === "addition" && (change.before || !change.after)) {
      context.addIssue({
        code: "custom",
        message: "an addition requires only an after state",
      });
    }
    if (change.kind === "deletion" && (!change.before || change.after)) {
      context.addIssue({
        code: "custom",
        message: "a deletion requires only a before state",
      });
    }
    if (
      change.kind !== "addition" &&
      change.kind !== "deletion" &&
      (!change.before || !change.after)
    ) {
      context.addIssue({
        code: "custom",
        message: `${change.kind} requires before and after states`,
      });
    }
    if (
      change.kind === "mode" &&
      change.before &&
      change.after &&
      !(
        [change.before.mode, change.after.mode].every((mode) =>
          ["100644", "100755"].includes(mode),
        ) &&
        change.before.mode !== change.after.mode &&
        change.before.content_digest === change.after.content_digest
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "a mode change must preserve regular-file content",
      });
    }
    if (
      change.kind === "symlink" &&
      change.before &&
      change.after &&
      change.before.mode !== "120000" &&
      change.after.mode !== "120000"
    ) {
      context.addIssue({
        code: "custom",
        message: "a symlink change must involve a symlink",
      });
    }
  });
export type WorkspaceManifestChange = z.infer<
  typeof WorkspaceManifestChangeSchema
>;

export interface WorkspaceManifestOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface ResolvedWorkspaceMountRoot {
  readonly path: WritePath;
  readonly type: "directory" | "regular";
  readonly canonicalPath: string;
}

function manifestDigest(
  record: z.infer<typeof WorkspaceManifestRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/workspace-manifest/v2", [
    ["record", canonicalJson(record)],
  ]);
}

export function validateWorkspaceManifest(value: unknown): WorkspaceManifest {
  const manifest = WorkspaceManifestSchema.safeParse(value);
  if (!manifest.success) {
    throw new OrchestratorError(
      "invalid_workspace_manifest",
      `Workspace manifest does not match the version-two contract: ${manifest.error.message}`,
    );
  }
  const { digest, ...record } = manifest.data;
  if (manifestDigest(record) !== digest) {
    throw new OrchestratorError(
      "invalid_workspace_manifest",
      "Workspace manifest digest does not match its complete record",
    );
  }
  return Object.freeze({
    ...manifest.data,
    entries: Object.freeze(
      manifest.data.entries.map((entry) => Object.freeze({ ...entry })),
    ),
  }) as WorkspaceManifest;
}

function entryState(entry: WorkspaceManifestEntry): WorkspaceEntryState {
  if (entry.type === "directory") {
    return { mode: "040000", byte_count: 0, content_digest: null };
  }
  if (entry.type === "symlink") {
    return {
      mode: "120000",
      byte_count: entry.byte_count,
      content_digest: entry.link_target_digest,
    };
  }
  return {
    mode: entry.type === "executable" ? "100755" : "100644",
    byte_count: entry.byte_count,
    content_digest: entry.content_digest,
  };
}

export function workspaceManifestEntries(
  manifest: WorkspaceManifest,
): ReadonlyMap<RunWorkspacePath, WorkspaceEntryState> {
  const parsed = validateWorkspaceManifest(manifest);
  return new Map(
    parsed.entries.map((entry) => [entry.path, entryState(entry)] as const),
  );
}

export function compareWorkspaceManifests(
  baseline: WorkspaceManifest,
  result: WorkspaceManifest,
): readonly WorkspaceManifestChange[] {
  const before = workspaceManifestEntries(baseline);
  const after = workspaceManifestEntries(result);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    compareUtf8,
  );
  const changes: WorkspaceManifestChange[] = [];

  for (const entryPath of paths) {
    const left = before.get(entryPath) ?? null;
    const right = after.get(entryPath) ?? null;
    if (canonicalJson(left) === canonicalJson(right)) continue;
    let kind: WorkspaceManifestChange["kind"];
    if (!left) kind = "addition";
    else if (!right) kind = "deletion";
    else if (
      [left.mode, right.mode].every((mode) =>
        ["100644", "100755"].includes(mode),
      ) &&
      left.content_digest === right.content_digest &&
      left.byte_count === right.byte_count
    ) {
      kind = "mode";
    } else if (left.mode === "120000" || right.mode === "120000") {
      kind = "symlink";
    } else {
      kind = "modification";
    }
    changes.push(
      WorkspaceManifestChangeSchema.parse({
        path: entryPath,
        kind,
        before: left,
        after: right,
      }),
    );
  }
  return Object.freeze(
    changes.map((change) =>
      Object.freeze({
        ...change,
        before: change.before ? Object.freeze(change.before) : null,
        after: change.after ? Object.freeze(change.after) : null,
      }),
    ),
  );
}

function limits(options: WorkspaceManifestOptions): {
  readonly maxEntries: number;
  readonly maxBytes: number;
} {
  const schema = z
    .object({
      maxEntries: z.number().int().positive().max(MAX_WORKSPACE_ENTRIES),
      maxBytes: z.number().int().positive().max(MAX_WORKSPACE_BYTES),
    })
    .strict();
  return schema.parse({
    maxEntries: options.maxEntries ?? MAX_WORKSPACE_ENTRIES,
    maxBytes: options.maxBytes ?? MAX_WORKSPACE_BYTES,
  });
}

function sameState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function decodePathName(name: Buffer): string {
  try {
    return decoder.decode(name);
  } catch (error) {
    throw new OrchestratorError(
      "unsupported_workspace_path",
      "Workspace paths must be valid UTF-8",
      { cause: error },
    );
  }
}

export function requireSafeWorkspaceSymlink(
  relative: string,
  target: Buffer,
): void {
  let decoded: string;
  try {
    decoded = decoder.decode(target);
  } catch (error) {
    throw new OrchestratorError(
      "unsafe_workspace_symlink",
      `Workspace symlink '${relative}' has a non-UTF-8 target`,
      { cause: error },
    );
  }
  if (
    decoded.length === 0 ||
    decoded.includes("\\") ||
    path.posix.isAbsolute(decoded) ||
    path.win32.isAbsolute(decoded)
  ) {
    throw new OrchestratorError(
      "unsafe_workspace_symlink",
      `Workspace symlink '${relative}' has an unsafe target`,
    );
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), decoded),
  );
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved) ||
    resolved.split("/").includes(".git")
  ) {
    throw new OrchestratorError(
      "unsafe_workspace_symlink",
      `Workspace symlink '${relative}' escapes the Project or addresses Git metadata`,
    );
  }
}

async function state(filePath: string): Promise<BigIntStats> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    throw new OrchestratorError(
      "workspace_changed",
      `Workspace entry '${filePath}' changed during inspection`,
      { cause: error },
    );
  }
}

export async function createWorkspaceManifest(
  root: string,
  options: WorkspaceManifestOptions = {},
): Promise<WorkspaceManifest> {
  const bound = limits(options);
  const resolvedRoot = path.resolve(root);
  const rootBefore = await state(resolvedRoot);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new OrchestratorError(
      "invalid_workspace_root",
      `Workspace root '${resolvedRoot}' must be a real directory`,
    );
  }

  const entries: WorkspaceManifestEntry[] = [];
  let byteCount = 0;

  const add = (entry: WorkspaceManifestEntry): void => {
    if (entries.length >= bound.maxEntries) {
      throw new OrchestratorError(
        "workspace_too_large",
        `Workspace contains more than ${bound.maxEntries} entries`,
      );
    }
    if (byteCount + entry.byte_count > bound.maxBytes) {
      throw new OrchestratorError(
        "workspace_too_large",
        `Workspace content exceeds ${bound.maxBytes} bytes`,
      );
    }
    entries.push(entry);
    byteCount += entry.byte_count;
  };

  const visitFile = async (
    absolute: string,
    relative: RunWorkspacePath,
    before: BigIntStats,
  ): Promise<void> => {
    if (before.nlink !== 1n) {
      throw new OrchestratorError(
        "unsafe_workspace_hardlink",
        `Workspace file '${relative}' has ${before.nlink.toString()} hard links`,
      );
    }
    if (before.size > BigInt(bound.maxBytes - byteCount)) {
      throw new OrchestratorError(
        "workspace_too_large",
        `Workspace content exceeds ${bound.maxBytes} bytes`,
      );
    }
    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new OrchestratorError(
        "workspace_changed",
        `Workspace file '${relative}' could not be opened without following links`,
        { cause: error },
      );
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameState(before, opened)) {
        throw new OrchestratorError(
          "workspace_changed",
          `Workspace file '${relative}' changed before it was read`,
        );
      }
      const hash = createHash("sha256");
      let observed = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        observed += chunk.length;
        if (byteCount + observed > bound.maxBytes) {
          throw new OrchestratorError(
            "workspace_too_large",
            `Workspace content exceeds ${bound.maxBytes} bytes`,
          );
        }
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      if (
        !sameState(opened, after) ||
        BigInt(observed) !== after.size ||
        !sameState(after, await state(absolute))
      ) {
        throw new OrchestratorError(
          "workspace_changed",
          `Workspace file '${relative}' changed while it was read`,
        );
      }
      add(
        WorkspaceManifestEntrySchema.parse({
          path: relative,
          type: (after.mode & 0o111n) === 0n ? "regular" : "executable",
          byte_count: observed,
          content_digest: `sha256:${hash.digest("hex")}`,
        }),
      );
    } finally {
      await handle.close();
    }
  };

  const visitSymlink = async (
    absolute: string,
    relative: RunWorkspacePath,
    before: BigIntStats,
  ): Promise<void> => {
    if (before.nlink !== 1n) {
      throw new OrchestratorError(
        "unsafe_workspace_hardlink",
        `Workspace symlink '${relative}' has an unexpected link count`,
      );
    }
    const target = await readlink(absolute, { encoding: "buffer" }).catch(
      (error: unknown) => {
        throw new OrchestratorError(
          "workspace_changed",
          `Workspace symlink '${relative}' changed during inspection`,
          { cause: error },
        );
      },
    );
    const after = await state(absolute);
    if (!after.isSymbolicLink() || !sameState(before, after)) {
      throw new OrchestratorError(
        "workspace_changed",
        `Workspace symlink '${relative}' changed during inspection`,
      );
    }
    requireSafeWorkspaceSymlink(relative, target);
    add(
      WorkspaceManifestEntrySchema.parse({
        path: relative,
        type: "symlink",
        byte_count: target.byteLength,
        link_target_base64: target.toString("base64"),
        link_target_digest: sha256(target),
      }),
    );
  };

  const visitDirectory = async (
    directory: string,
    prefix: string,
    before: BigIntStats,
  ): Promise<void> => {
    let names: Buffer[];
    try {
      names = await readdir(directory, { encoding: "buffer" });
    } catch (error) {
      throw new OrchestratorError(
        "workspace_changed",
        `Workspace directory '${prefix || "."}' could not be read`,
        { cause: error },
      );
    }
    names.sort(Buffer.compare);
    for (const name of names) {
      const decoded = decodePathName(name);
      const relativeSource = prefix ? `${prefix}/${decoded}` : decoded;
      if (decoded === ".git") {
        throw new OrchestratorError(
          "workspace_git_metadata",
          `Git metadata is present at '${relativeSource}'`,
        );
      }
      const relative = RunWorkspacePathSchema.parse(relativeSource);
      const absolute = path.join(directory, decoded);
      const beforeEntry = await state(absolute);
      if (beforeEntry.isDirectory() && !beforeEntry.isSymbolicLink()) {
        add(
          WorkspaceManifestEntrySchema.parse({
            path: relative,
            type: "directory",
            byte_count: 0,
          }),
        );
        await visitDirectory(absolute, relative, beforeEntry);
      } else if (beforeEntry.isFile()) {
        await visitFile(absolute, relative, beforeEntry);
      } else if (beforeEntry.isSymbolicLink()) {
        await visitSymlink(absolute, relative, beforeEntry);
      } else {
        throw new OrchestratorError(
          "unsupported_workspace_entry",
          `Workspace contains unsupported entry '${relative}'`,
        );
      }
    }
    const after = await state(directory);
    if (!after.isDirectory() || !sameState(before, after)) {
      throw new OrchestratorError(
        "workspace_changed",
        `Workspace directory '${prefix || "."}' changed during inspection`,
      );
    }
  };

  await visitDirectory(resolvedRoot, "", rootBefore);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const record = WorkspaceManifestRecordSchema.parse({
    version: 2,
    entry_count: entries.length,
    byte_count: byteCount,
    entries,
  });
  return validateWorkspaceManifest({
    ...record,
    digest: manifestDigest(record),
  });
}

export function createWorkspaceManifestFromEntries(
  values: readonly WorkspaceManifestEntry[],
): WorkspaceManifest {
  const entries = values
    .map((entry) => WorkspaceManifestEntrySchema.parse(entry))
    .sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path === entries[index]!.path) {
      throw new OrchestratorError(
        "duplicate_workspace_path",
        `Workspace manifest repeats path '${entries[index]!.path}'`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.type === "symlink") {
      requireSafeWorkspaceSymlink(
        entry.path,
        Buffer.from(entry.link_target_base64, "base64"),
      );
    }
  }
  const byteCount = entries.reduce(
    (total, entry) => total + entry.byte_count,
    0,
  );
  const record = WorkspaceManifestRecordSchema.parse({
    version: 2,
    entry_count: entries.length,
    byte_count: byteCount,
    entries,
  });
  return validateWorkspaceManifest({
    ...record,
    digest: manifestDigest(record),
  });
}

function contains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export async function resolveWorkspaceMountRoots(
  root: string,
  requestedPaths: readonly string[],
): Promise<readonly ResolvedWorkspaceMountRoot[]> {
  if (requestedPaths.length === 0) {
    throw new OrchestratorError(
      "invalid_write_path",
      "At least one literal Workspace write path is required",
    );
  }
  const parsed = requestedPaths.map((value) => WritePathSchema.parse(value));
  const sorted = [...parsed].sort(compareUtf8);
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && contains(sorted[index - 1]!, sorted[index]!)) {
      throw new OrchestratorError(
        "overlapping_write_paths",
        `Write path '${sorted[index - 1]}' overlaps '${sorted[index]}'`,
      );
    }
  }

  const requestedRoot = path.resolve(root);
  const rootState = await state(requestedRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new OrchestratorError(
      "invalid_workspace_root",
      `Workspace root '${requestedRoot}' must be a real directory`,
    );
  }
  const canonicalRoot = await realpath(requestedRoot);
  if (!sameState(rootState, await state(canonicalRoot))) {
    throw new OrchestratorError(
      "workspace_changed",
      "Workspace root changed during canonical resolution",
    );
  }
  const result: ResolvedWorkspaceMountRoot[] = [];
  for (const relative of sorted) {
    let current = canonicalRoot;
    const segments = relative.split("/");
    let currentState: BigIntStats | undefined;
    const observed: Array<readonly [absolute: string, state: BigIntStats]> = [];
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      currentState = await state(current);
      observed.push([current, currentState]);
      if (currentState.isSymbolicLink()) {
        throw new OrchestratorError(
          "unsafe_workspace_mount_root",
          `Write path '${relative}' traverses symlink '${segments.slice(0, index + 1).join("/")}'`,
        );
      }
      if (index < segments.length - 1 && !currentState.isDirectory()) {
        throw new OrchestratorError(
          "invalid_workspace_mount_root",
          `Write path '${relative}' traverses a non-directory entry`,
        );
      }
    }
    const canonicalPath = current;
    const relativeCanonical = path.relative(canonicalRoot, canonicalPath);
    if (
      relativeCanonical === ".." ||
      relativeCanonical.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCanonical)
    ) {
      throw new OrchestratorError(
        "unsafe_workspace_mount_root",
        `Write path '${relative}' escapes the Workspace`,
      );
    }
    if (!currentState) {
      throw new OrchestratorError(
        "invalid_workspace_mount_root",
        `Write path '${relative}' has no mountable entry`,
      );
    }
    if (currentState.isFile() && currentState.nlink !== 1n) {
      throw new OrchestratorError(
        "unsafe_workspace_hardlink",
        `Write path '${relative}' is a multiply linked file`,
      );
    }
    if (!currentState.isDirectory() && !currentState.isFile()) {
      throw new OrchestratorError(
        "invalid_workspace_mount_root",
        `Write path '${relative}' is not a regular file or directory`,
      );
    }
    for (const [absolute, before] of observed) {
      const after = await state(absolute);
      if (after.isSymbolicLink() || !sameState(before, after)) {
        throw new OrchestratorError(
          "workspace_changed",
          `Write path '${relative}' changed during canonical resolution`,
        );
      }
    }
    result.push(
      Object.freeze({
        path: relative,
        type: currentState.isDirectory() ? "directory" : "regular",
        canonicalPath,
      }),
    );
  }
  return Object.freeze(result);
}

export function effectiveRestrictedPaths(
  committed: readonly string[],
  machineLocal: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set([...committed, ...machineLocal])].sort(compareUtf8),
  );
}
