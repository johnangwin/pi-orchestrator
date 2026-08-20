import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const MAX_ENTRIES = 1_000_000;
const MAX_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function decode(value, description) {
  try {
    return decoder.decode(value);
  } catch {
    fail(`${description} must be valid UTF-8`);
  }
}

function relativePath(value) {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.split("/").some((segment) => segment === "" || segment === ".git")
  ) {
    fail(`unsafe Workspace path '${value}'`);
  }
  return value;
}

function safeSymlink(entryPath, target) {
  const value = decode(target, `symlink '${entryPath}' target`);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    fail(`symlink '${entryPath}' has an unsafe target`);
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryPath), value),
  );
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved) ||
    resolved.split("/").includes(".git")
  ) {
    fail(`symlink '${entryPath}' escapes the Project`);
  }
  return value;
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: options.encoding ?? "buffer",
        maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const diagnostic = Buffer.from(stderr ?? "")
          .toString("utf8")
          .trim();
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
          ),
        );
      },
    );
  });
}

function gitArgs(gitDirectory, args) {
  return [`--git-dir=${gitDirectory}`, "-c", "core.fsmonitor=false", ...args];
}

function parseTree(source) {
  const entries = [];
  for (const record of decode(source, "Git tree").split("\0")) {
    if (!record) continue;
    const match =
      /^([0-7]{6}) ([a-z]+) ((?:[a-f0-9]{40}|[a-f0-9]{64}))\t([\s\S]+)$/.exec(
        record,
      );
    if (
      !match ||
      match[2] !== "blob" ||
      !["100644", "100755", "120000"].includes(match[1])
    ) {
      fail(`unsupported Git tree record '${record.slice(0, 200)}'`);
    }
    entries.push({
      mode: match[1],
      object: match[3],
      path: relativePath(match[4]),
    });
  }
  if (entries.length === 0) fail("Git commit contains no materializable files");
  if (entries.length > MAX_ENTRIES) fail("Git commit exceeds the entry limit");
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return entries;
}

async function writeBlob(gitDirectory, object, destination, mode) {
  const child = spawn(
    "git",
    gitArgs(gitDirectory, ["cat-file", "blob", object]),
    {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `git cat-file failed with exit ${code ?? "unknown"}: ${Buffer.concat(errors).toString("utf8").slice(0, 2_000)}`,
          ),
        );
    });
  });
  await Promise.all([
    pipeline(
      child.stdout,
      createWriteStream(destination, { flags: "wx", mode }),
    ),
    closed,
  ]);
}

async function hashBlob(gitDirectory, object) {
  const child = spawn(
    "git",
    gitArgs(gitDirectory, ["cat-file", "blob", object]),
    {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) {
      child.kill("SIGKILL");
      fail("Git blob exceeds the Workspace byte limit");
    }
    hash.update(chunk);
  }
  const code = await closed;
  if (code !== 0) {
    fail(
      `git cat-file failed with exit ${code ?? "unknown"}: ${Buffer.concat(errors).toString("utf8").slice(0, 2_000)}`,
    );
  }
  return { bytes, digest: `sha256:${hash.digest("hex")}` };
}

function directoryEntries(entries) {
  const directories = new Set();
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...directories].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

async function gitManifest(gitDirectory, requestedCommit) {
  const gitRoot = await realpath(gitDirectory);
  const commit = Buffer.from(
    await execute(
      "git",
      gitArgs(gitRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${requestedCommit}^{commit}`,
      ]),
    ),
  )
    .toString("utf8")
    .trim();
  if (commit !== requestedCommit) fail("Git commit did not resolve exactly");
  const tree = parseTree(
    Buffer.from(
      await execute(
        "git",
        gitArgs(gitRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]),
      ),
    ),
  );
  const entries = directoryEntries(tree).map((entryPath) => ({
    path: entryPath,
    type: "directory",
    byte_count: 0,
  }));
  let byteCount = 0;
  for (const entry of tree) {
    if (entry.mode === "120000") {
      const target = Buffer.from(
        await execute(
          "git",
          gitArgs(gitRoot, ["cat-file", "blob", entry.object]),
          {
            maxBuffer: MAX_PATH_BYTES,
          },
        ),
      );
      safeSymlink(entry.path, target);
      byteCount += target.byteLength;
      entries.push({
        path: entry.path,
        type: "symlink",
        byte_count: target.byteLength,
        link_target_base64: target.toString("base64"),
        link_target_digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
      });
      continue;
    }
    const blob = await hashBlob(gitRoot, entry.object);
    byteCount += blob.bytes;
    if (byteCount > MAX_BYTES)
      fail("Git tree exceeds the Workspace byte limit");
    entries.push({
      path: entry.path,
      type: entry.mode === "100755" ? "executable" : "regular",
      byte_count: blob.bytes,
      content_digest: blob.digest,
    });
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  process.stdout.write(
    `${JSON.stringify({ commit, manifest: { version: 2, entry_count: entries.length, byte_count: byteCount, entries } })}\n`,
  );
}

async function seed(gitDirectory, requestedCommit, volumeRoot) {
  const gitRoot = await realpath(gitDirectory);
  if (!(await stat(gitRoot)).isDirectory())
    fail("Git object root is not a directory");
  const commit = Buffer.from(
    await execute(
      "git",
      gitArgs(gitRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${requestedCommit}^{commit}`,
      ]),
    ),
  )
    .toString("utf8")
    .trim();
  if (commit !== requestedCommit) fail("Git commit did not resolve exactly");

  const project = path.join(volumeRoot, "project");
  const control = path.join(volumeRoot, "control");
  for (const target of [project, control]) {
    try {
      await lstat(target);
      fail(`Workspace target '${target}' already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(project, { recursive: false, mode: 0o755 });
  const entries = parseTree(
    Buffer.from(
      await execute(
        "git",
        gitArgs(gitRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]),
      ),
    ),
  );
  const directories = directoryEntries(entries);
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || Buffer.compare(Buffer.from(left), Buffer.from(right));
  })) {
    await mkdir(path.join(project, ...directory.split("/")), {
      mode: 0o755,
    });
  }
  for (const entry of entries) {
    const destination = path.join(project, ...entry.path.split("/"));
    if (entry.mode === "120000") {
      const target = Buffer.from(
        await execute(
          "git",
          gitArgs(gitRoot, ["cat-file", "blob", entry.object]),
          {
            maxBuffer: MAX_PATH_BYTES,
          },
        ),
      );
      await symlink(safeSymlink(entry.path, target), destination);
      await lchown(destination, 10001, 10001);
      continue;
    }
    const mode = entry.mode === "100755" ? 0o755 : 0o644;
    await writeBlob(gitRoot, entry.object, destination, mode);
    await chown(destination, 10001, 10001);
    await chmod(destination, mode);
  }
  for (const directory of [...directories].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  )) {
    const destination = path.join(project, ...directory.split("/"));
    await chown(destination, 10001, 10001);
    await chmod(destination, 0o755);
  }
  await chown(project, 10001, 10001);
  await chmod(project, 0o755);

  const masks = path.join(control, "masks");
  const empty = path.join(masks, "empty-directory");
  await mkdir(empty, { recursive: true, mode: 0o555 });
  await writeFile(
    path.join(masks, "opaque-file"),
    "pi-orchestrator restricted content\n",
    { mode: 0o444 },
  );
  await chmod(control, 0o700);
  process.stdout.write(
    `${JSON.stringify({ commit, entries: entries.length })}\n`,
  );
}

function sameState(left, right) {
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

async function inspect(root) {
  const requestedRoot = await lstat(root, { bigint: true });
  if (!requestedRoot.isDirectory() || requestedRoot.isSymbolicLink()) {
    fail("Workspace Project root is not a real directory");
  }
  const workspaceRoot = await realpath(root);
  const rootBefore = await lstat(workspaceRoot, { bigint: true });
  if (
    !rootBefore.isDirectory() ||
    rootBefore.isSymbolicLink() ||
    !sameState(requestedRoot, rootBefore)
  ) {
    fail("Workspace Project root is not a real directory");
  }
  const entries = [];
  let byteCount = 0;

  const add = (entry) => {
    if (entries.length >= MAX_ENTRIES)
      fail("Workspace exceeds the entry limit");
    if (byteCount + entry.byte_count > MAX_BYTES)
      fail("Workspace exceeds the byte limit");
    entries.push(entry);
    byteCount += entry.byte_count;
  };

  const visit = async (directory, prefix, before) => {
    const children = await readdir(directory, { encoding: "buffer" });
    children.sort(Buffer.compare);
    for (const name of children) {
      const decoded = relativePath(
        prefix
          ? `${prefix}/${decode(name, "Workspace path")}`
          : decode(name, "Workspace path"),
      );
      if (decoded.split("/").includes(".git"))
        fail("Git metadata is present in the Workspace");
      const absolute = path.join(workspaceRoot, ...decoded.split("/"));
      const first = await lstat(absolute, { bigint: true });
      if (first.isDirectory() && !first.isSymbolicLink()) {
        add({ path: decoded, type: "directory", byte_count: 0 });
        await visit(absolute, decoded, first);
      } else if (first.isSymbolicLink()) {
        if (first.nlink !== 1n)
          fail(`symlink '${decoded}' has an unexpected link count`);
        const target = await readlink(absolute, { encoding: "buffer" });
        safeSymlink(decoded, target);
        const after = await lstat(absolute, { bigint: true });
        if (!sameState(first, after))
          fail(`symlink '${decoded}' changed during inspection`);
        add({
          path: decoded,
          type: "symlink",
          byte_count: target.byteLength,
          link_target_base64: target.toString("base64"),
          link_target_digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
        });
      } else if (first.isFile()) {
        if (first.nlink !== 1n) fail(`file '${decoded}' is multiply linked`);
        const hash = createHash("sha256");
        let observed = 0;
        for await (const chunk of createReadStream(absolute)) {
          observed += chunk.byteLength;
          if (byteCount + observed > MAX_BYTES)
            fail("Workspace exceeds the byte limit");
          hash.update(chunk);
        }
        const after = await lstat(absolute, { bigint: true });
        if (!sameState(first, after) || BigInt(observed) !== after.size) {
          fail(`file '${decoded}' changed during inspection`);
        }
        add({
          path: decoded,
          type: (after.mode & 0o111n) === 0n ? "regular" : "executable",
          byte_count: observed,
          content_digest: `sha256:${hash.digest("hex")}`,
        });
      } else {
        fail(`Workspace contains unsupported entry '${decoded}'`);
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (!sameState(before, after))
      fail(`directory '${prefix || "."}' changed during inspection`);
  };

  await visit(workspaceRoot, "", rootBefore);
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  process.stdout.write(
    `${JSON.stringify({ version: 2, entry_count: entries.length, byte_count: byteCount, entries })}\n`,
  );
}

try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "seed" && args.length === 3) {
    await seed(args[0], args[1], args[2]);
  } else if (operation === "git-manifest" && args.length === 2) {
    await gitManifest(args[0], args[1]);
  } else if (operation === "inspect" && args.length === 1) {
    await inspect(args[0]);
  } else {
    fail(
      "usage: workspace.mjs seed <git-dir> <commit> <volume-root> | git-manifest <git-dir> <commit> | inspect <project-root>",
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
