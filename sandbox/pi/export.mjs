#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function lengthPrefix(length) {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function digestParts(domain, parts) {
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(domain, "utf8");
  hash.update(lengthPrefix(domainBytes.length));
  hash.update(domainBytes);
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, "utf8");
    const contentBytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    hash.update(lengthPrefix(nameBytes.length));
    hash.update(nameBytes);
    hash.update(lengthPrefix(contentBytes.length));
    hash.update(contentBytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function lexical(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safePath(value) {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.split("/").includes(".git")
  ) {
    throw new Error(`Unsafe workspace path '${value}'`);
  }
  return value;
}

async function hashFile(filePath) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Unsupported file '${filePath}'`);
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
      throw new Error(`Workspace file changed during export: '${filePath}'`);
    }
    return {
      size: after.size,
      digest: `sha256:${hash.digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
}

async function workspaceEntries(root) {
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error(`Workspace root '${root}' is not a directory`);
  }
  const entries = [];

  async function visit(directory, prefix) {
    const names = await readdir(directory, { encoding: "buffer" });
    const decoded = names
      .map((name) => ({ bytes: name, name: decoder.decode(name) }))
      .sort((left, right) => Buffer.compare(left.bytes, right.bytes));
    for (const item of decoded) {
      const relative = safePath(
        prefix.length === 0 ? item.name : `${prefix}/${item.name}`,
      );
      const absolute = path.join(directory, item.name);
      const state = await lstat(absolute);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        await visit(absolute, relative);
        continue;
      }
      if (entries.length >= MAX_TREE_ENTRIES) {
        throw new Error(
          `Workspace contains more than ${MAX_TREE_ENTRIES} entries`,
        );
      }
      if (state.isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: "buffer" });
        entries.push({
          path: relative,
          mode: "120000",
          size: target.byteLength,
          content_digest: sha256(target),
        });
        continue;
      }
      if (!state.isFile()) {
        throw new Error(`Unsupported workspace entry '${relative}'`);
      }
      const content = await hashFile(absolute);
      entries.push({
        path: relative,
        mode: (state.mode & 0o111) === 0 ? "100644" : "100755",
        size: content.size,
        content_digest: content.digest,
      });
    }
  }

  await visit(root, "");
  return entries.sort((left, right) => lexical(left.path, right.path));
}

function treeDigest(entries) {
  return digestParts("pi-orchestrator/workspace-tree/v1", [
    ["entries", canonicalJson(entries)],
  ]);
}

function changeManifest(before, after) {
  const base = new Map(before.map((entry) => [entry.path, entry]));
  const result = new Map(after.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...base.keys(), ...result.keys()])].sort(lexical);
  return paths.flatMap((entryPath) => {
    const oldEntry = base.get(entryPath);
    const newEntry = result.get(entryPath);
    if (canonicalJson(oldEntry) === canonicalJson(newEntry)) return [];
    if (!oldEntry) {
      return [{ path: entryPath, status: "added", after: newEntry }];
    }
    if (!newEntry) {
      return [{ path: entryPath, status: "deleted", before: oldEntry }];
    }
    return [
      {
        path: entryPath,
        status: "modified",
        before: oldEntry,
        after: newEntry,
      },
    ];
  });
}

async function gitPatch(workspaceRoot, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "diff",
        "--no-index",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "base",
        "project",
      ],
      {
        cwd: workspaceRoot,
        env: {
          HOME: "/nonexistent",
          LANG: "C.UTF-8",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failed = false;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (
        stderr.reduce((total, item) => total + item.length, 0) <
        1024 * 1024
      ) {
        stderr.push(chunk);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (failed) {
        reject(new Error(`Patch exceeds ${maxBytes} bytes`));
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(
          new Error(
            `git diff failed with exit ${code}: ${Buffer.concat(stderr)
              .toString("utf8")
              .trim()
              .slice(0, 1000)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function patchDigest(bundle) {
  return digestParts("pi-orchestrator/patch/v1", [
    ["source-digest", bundle.source_digest],
    ["base-tree-digest", bundle.base_tree_digest],
    ["result-tree-digest", bundle.result_tree_digest],
    ["changes", canonicalJson(bundle.changes)],
    ["patch-digest", bundle.patch.content_digest],
  ]);
}

function validSessionConfig(value) {
  const identity = value?.identity;
  if (
    value?.version !== 2 ||
    !identity ||
    !identifierPattern.test(identity.run) ||
    !identifierPattern.test(identity.agent) ||
    !identifierPattern.test(identity.session) ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1 ||
    value.profile !== "write" ||
    !digestPattern.test(value.source_digest)
  ) {
    throw new Error("Invalid immutable Session configuration");
  }
  return value;
}

async function publish(filePath, payload) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new Error(`Artifact directory '${directory}' is not a directory`);
  }
  const existingState = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    existingState &&
    (!existingState.isFile() || existingState.isSymbolicLink())
  ) {
    throw new Error(
      `Artifact '${path.basename(filePath)}' is not a regular file`,
    );
  }
  const existing = await readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.equals(payload)) {
      throw new Error(
        `Artifact '${path.basename(filePath)}' already has other content`,
      );
    }
    return stat(filePath);
  }

  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await open(temporary, "wx", 0o600).then(async (handle) => {
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  try {
    await link(temporary, filePath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = await readFile(filePath);
    if (!raced.equals(payload)) {
      throw new Error(
        `Artifact '${path.basename(filePath)}' raced with other content`,
      );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return stat(filePath);
}

export async function exportPatch(options) {
  const artifactId = options.artifactId;
  const task = options.task;
  if (!identifierPattern.test(artifactId) || artifactId.length > 128) {
    throw new Error("Invalid Artifact ID");
  }
  if (!identifierPattern.test(task)) throw new Error("Invalid Task ID");

  const workspaceRoot = path.resolve(options.workspaceRoot);
  const baseRoot = path.join(workspaceRoot, "base");
  const projectRoot = path.join(workspaceRoot, "project");
  const config = validSessionConfig(
    JSON.parse(await readFile(options.sessionConfigPath, "utf8")),
  );
  const [baseEntries, resultEntries] = await Promise.all([
    workspaceEntries(baseRoot),
    workspaceEntries(projectRoot),
  ]);
  const changes = changeManifest(baseEntries, resultEntries);
  if (changes.length === 0)
    throw new Error("Implementation produced no changes");

  const patch = await gitPatch(
    workspaceRoot,
    options.maxPatchBytes ?? MAX_PATCH_BYTES,
  );
  if (patch.length === 0) throw new Error("Git produced an empty patch");
  const bundle = {
    version: 1,
    source_digest: config.source_digest,
    base_tree_digest: treeDigest(baseEntries),
    result_tree_digest: treeDigest(resultEntries),
    changes,
    patch: {
      encoding: "base64",
      byte_count: patch.byteLength,
      content_digest: sha256(patch),
      data: patch.toString("base64"),
    },
  };
  bundle.diff_digest = patchDigest(bundle);
  const payload = Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8");
  if (payload.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Patch Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const artifactPath = path.join(path.resolve(options.outputRoot), artifactId);
  const published = await publish(artifactPath, payload);
  const descriptor = {
    version: 1,
    id: artifactId,
    kind: "patch",
    run: config.identity.run,
    agent: config.identity.agent,
    session: config.identity.session,
    generation: config.identity.generation,
    task,
    sandbox_path: `/sandbox/output/artifacts/${artifactId}`,
    media_type: "application/json",
    schema: "patch/v1",
    byte_count: payload.byteLength,
    content_digest: sha256(payload),
    created_at: published.mtime.toISOString(),
  };
  return { artifactPath, bundle, descriptor };
}

async function main() {
  const [artifactId, task, ...extra] = process.argv.slice(2);
  if (!artifactId || !task || extra.length > 0) {
    throw new Error("Usage: orchestrator-export-patch <artifact-id> <task-id>");
  }
  const result = await exportPatch({
    artifactId,
    task,
    workspaceRoot: "/workspace",
    sessionConfigPath: "/workspace/input/session.json",
    outputRoot: "/sandbox/output/artifacts",
  });
  process.stdout.write(`${JSON.stringify(result.descriptor)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
