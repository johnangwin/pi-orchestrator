#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const markerPath = "/sandbox/check-job.json";
const scratchRoot = "/sandbox/check-scratch";
const projectRoot = "/workspace/project";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const jobPattern = /^check-[a-f0-9]{16}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function lengthPrefix(length) {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function lexical(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.split("/").includes(".git")
  ) {
    throw new Error("Invalid Check source path");
  }
  return value;
}

async function hashFile(filePath) {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const state = await handle.stat();
    if (!state.isFile()) throw new Error("Check source entry is not a file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      state.dev !== after.dev ||
      state.ino !== after.ino ||
      state.size !== after.size ||
      state.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Check source entry changed during verification");
    }
    return { size: after.size, digest: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

async function workspaceEntries(root) {
  const entries = [];
  async function visit(directory, prefix) {
    const names = await readdir(directory, { encoding: "buffer" });
    names.sort(Buffer.compare);
    for (const name of names) {
      const decoded = decoder.decode(name);
      const relative = safePath(prefix ? `${prefix}/${decoded}` : decoded);
      const absolute = path.join(directory, decoded);
      const state = await lstat(absolute);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        await visit(absolute, relative);
        continue;
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
      if (!state.isFile()) throw new Error("Unsupported Check source entry");
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

function sourceDigest(manifest) {
  return digestParts("pi-orchestrator/check-source/v1", [
    ["input-commit", manifest.input_commit],
    ["task-source-digest", manifest.task_source_digest],
    ["diff-digest", manifest.diff_digest],
    ["tree-digest", manifest.tree_digest],
    ["entries", canonicalJson(manifest.entries)],
  ]);
}

function validIdentity(job, token) {
  if (!jobPattern.test(job) || !tokenPattern.test(token)) {
    throw new Error("Invalid Check job identity");
  }
  return { version: 1, job, token };
}

async function marker(job, token) {
  const expected = validIdentity(job, token);
  const actual = JSON.parse(await readFile(markerPath, "utf8"));
  const expectedBytes = Buffer.from(canonicalJson(expected));
  const actualBytes = Buffer.from(canonicalJson(actual));
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new Error("Check Sandbox identity mismatch");
  }
  return expected;
}

function validateManifest(value) {
  if (
    value?.version !== 1 ||
    !commitPattern.test(value.input_commit) ||
    !digestPattern.test(value.task_source_digest) ||
    !digestPattern.test(value.diff_digest) ||
    !digestPattern.test(value.tree_digest) ||
    !digestPattern.test(value.source_digest) ||
    !Array.isArray(value.entries) ||
    !value.archive ||
    !Number.isSafeInteger(value.archive.byte_count) ||
    value.archive.byte_count < 1 ||
    !digestPattern.test(value.archive.content_digest)
  ) {
    throw new Error("Invalid Check source manifest");
  }
  for (const entry of value.entries) {
    safePath(entry?.path);
    if (
      !["100644", "100755", "120000"].includes(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !digestPattern.test(entry.content_digest)
    ) {
      throw new Error("Invalid Check source entry");
    }
  }
  if (sourceDigest(value) !== value.source_digest) {
    throw new Error("Invalid Check source digest");
  }
  return value;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Source extraction failed: ${stderr.trim()}`));
    });
  });
}

async function initialize(job, token) {
  const identity = validIdentity(job, token);
  await Promise.all(
    ["home", "tmp", "cache", "build"].map((directory) =>
      mkdir(path.join(scratchRoot, directory), {
        recursive: true,
        mode: 0o700,
      }),
    ),
  );
  await writeFile(markerPath, `${JSON.stringify(identity)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function prepare(job, token, archivePath, manifestPath) {
  await marker(job, token);
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const archiveState = await lstat(archivePath);
  if (
    !archiveState.isFile() ||
    archiveState.isSymbolicLink() ||
    archiveState.size !== manifest.archive.byte_count ||
    (await hashFile(archivePath)).digest !== manifest.archive.content_digest
  ) {
    throw new Error("Check source archive does not match its manifest");
  }
  if ((await readdir(projectRoot)).length !== 0) {
    throw new Error("Check project directory is not empty");
  }
  await run("/usr/bin/tar", [
    "-xf",
    archivePath,
    "-C",
    projectRoot,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  const entries = await workspaceEntries(projectRoot);
  if (
    canonicalJson(entries) !== canonicalJson(manifest.entries) ||
    treeDigest(entries) !== manifest.tree_digest
  ) {
    throw new Error("Extracted Check source does not match its manifest");
  }
  process.stdout.write(`${manifest.source_digest}\n`);
}

async function main() {
  const [action, job, token, ...rest] = process.argv.slice(2);
  if (action === "init" && job && token && rest.length === 0) {
    await initialize(job, token);
    return;
  }
  if (action === "verify" && job && token && rest.length === 0) {
    await marker(job, token);
    return;
  }
  if (
    action === "source" &&
    job &&
    token &&
    rest.length === 2 &&
    rest[0] &&
    rest[1]
  ) {
    await prepare(job, token, rest[0], rest[1]);
    return;
  }
  throw new Error("Invalid orchestrator-prepare-check invocation");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
