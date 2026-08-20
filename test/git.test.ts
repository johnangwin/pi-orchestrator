import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/digest.js";
import {
  collectWorkspaceGitDiff,
  GitWorktreeManager,
  parseWorkspaceGitStatus,
  parseWorktreeList,
  validateWorkspaceDiff,
} from "../src/git.js";
import { commitFixture, createFixtureProject } from "./fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

describe("Git worktree lifecycle", () => {
  it("creates and recovers an exact clean Run worktree", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    const worktreeRoot = await temporary("pi-worktrees-");
    const manager = new GitWorktreeManager(project);
    const intent = await manager.prepare({
      projectId: "fixture",
      runId: "run-one",
      baseCommit: base,
      branchPrefix: "orchestrator/",
      worktreeRoot,
    });

    await expect(manager.preflight(intent)).resolves.toMatchObject({
      status: "missing",
    });
    await expect(manager.ensure(intent)).resolves.toMatchObject({
      created: true,
      recovered: false,
    });
    await expect(manager.inspect(intent)).resolves.toMatchObject({
      status: "ready",
      actualHead: base,
      actualBranch: "refs/heads/orchestrator/run-one",
    });
    expect(
      await readFile(path.join(intent.worktree, "src", "fixture.ts"), "utf8"),
    ).toBe("export const fixture = true;\n");
    expect((await lstat(path.join(intent.worktree, ".git"))).isFile()).toBe(
      true,
    );
    expect(await git(project, ["status", "--porcelain=v1"])).toBe("");

    await expect(manager.ensure(intent)).resolves.toMatchObject({
      created: false,
      recovered: true,
    });
  });

  it("adopts a reserved branch-only retry at the exact base commit", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    const worktreeRoot = await temporary("pi-worktrees-");
    const manager = new GitWorktreeManager(project);
    const intent = await manager.prepare({
      projectId: "fixture",
      runId: "run-recovery",
      baseCommit: base,
      branchPrefix: "orchestrator/",
      worktreeRoot,
    });
    await git(project, ["branch", intent.branch, base]);

    await expect(manager.preflight(intent)).resolves.toMatchObject({
      status: "branch_only",
      actualHead: base,
    });
    await expect(manager.ensure(intent)).resolves.toMatchObject({
      created: true,
      recovered: true,
    });
    await expect(manager.inspect(intent)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("blocks dirty Run state without resetting or deleting it", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    const worktreeRoot = await temporary("pi-worktrees-");
    const manager = new GitWorktreeManager(project);
    const intent = await manager.prepare({
      projectId: "fixture",
      runId: "run-dirty",
      baseCommit: base,
      branchPrefix: "orchestrator/",
      worktreeRoot,
    });
    await manager.ensure(intent);
    const changed = path.join(intent.worktree, "src", "fixture.ts");
    await writeFile(changed, "export const fixture = false;\n", "utf8");
    await writeFile(
      path.join(intent.worktree, "untracked.txt"),
      "keep\n",
      "utf8",
    );

    await expect(manager.inspect(intent)).resolves.toMatchObject({
      status: "dirty",
    });
    await expect(manager.ensure(intent)).rejects.toMatchObject({
      code: "worktree_dirty",
    });
    expect(await readFile(changed, "utf8")).toBe(
      "export const fixture = false;\n",
    );
    expect(
      await readFile(path.join(intent.worktree, "untracked.txt"), "utf8"),
    ).toBe("keep\n");
  });

  it("rejects an unregistered path collision before creating a branch", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    const worktreeRoot = await temporary("pi-worktrees-");
    const manager = new GitWorktreeManager(project);
    const intent = await manager.prepare({
      projectId: "fixture",
      runId: "run-collision",
      baseCommit: base,
      branchPrefix: "orchestrator/",
      worktreeRoot,
    });
    await mkdir(intent.worktree, { recursive: true });
    await writeFile(
      path.join(intent.worktree, "owned.txt"),
      "external\n",
      "utf8",
    );

    await expect(manager.preflight(intent)).rejects.toMatchObject({
      code: "worktree_path_conflict",
    });
    await expect(
      execFileAsync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${intent.branch}`],
        { cwd: project },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      await readFile(path.join(intent.worktree, "owned.txt"), "utf8"),
    ).toBe("external\n");
  });

  it("rejects a reserved branch at a different commit", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    await writeFile(
      path.join(project, "src", "later.ts"),
      "export {};\n",
      "utf8",
    );
    await git(project, ["add", "."]);
    await git(project, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "later",
    ]);
    const worktreeRoot = await temporary("pi-worktrees-");
    const manager = new GitWorktreeManager(project);
    const intent = await manager.prepare({
      projectId: "fixture",
      runId: "run-branch-conflict",
      baseCommit: base,
      branchPrefix: "orchestrator/",
      worktreeRoot,
    });
    await git(project, ["branch", intent.branch, "HEAD"]);

    await expect(manager.preflight(intent)).rejects.toMatchObject({
      code: "worktree_branch_conflict",
    });
    await expect(lstat(intent.worktree)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a worktree root inside the trusted checkout without creating it", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    const base = await commitFixture(project);
    const unsafeRoot = path.join(project, ".orchestrator-worktrees");
    const manager = new GitWorktreeManager(project);

    await expect(
      manager.prepare({
        projectId: "fixture",
        runId: "run-unsafe",
        baseCommit: base,
        branchPrefix: "orchestrator/",
        worktreeRoot: unsafeRoot,
      }),
    ).rejects.toMatchObject({ code: "invalid_worktree_path" });
    await expect(lstat(unsafeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(project, ["status", "--porcelain=v1"])).toBe("");
  });

  it("parses NUL-delimited porcelain records and rejects truncation", () => {
    const source = [
      "worktree /repo",
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "",
      "worktree /runs/one",
      `HEAD ${"b".repeat(40)}`,
      "detached",
      "locked retained",
      "",
      "",
    ].join("\0");
    expect(parseWorktreeList(source)).toEqual([
      {
        path: "/repo",
        head: "a".repeat(40),
        branch: "refs/heads/main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/runs/one",
        head: "b".repeat(40),
        bare: false,
        detached: true,
        locked: true,
        prunable: false,
      },
    ]);
    expect(() => parseWorktreeList(source.slice(0, -1))).toThrow(
      "empty record",
    );
  });
});

describe("scrubbed Workspace Git evidence", () => {
  it("parses and raw-byte sorts NUL-delimited paths without shell quoting", () => {
    const source = Buffer.concat([
      Buffer.from("?? zed file\0", "utf8"),
      Buffer.from(" M line\nbreak\0", "utf8"),
      Buffer.from("A  alpha\0", "utf8"),
    ]);
    expect(parseWorkspaceGitStatus(source)).toEqual([
      { path: "alpha", index_status: "A", worktree_status: " " },
      {
        path: "line\nbreak",
        index_status: " ",
        worktree_status: "M",
      },
      { path: "zed file", index_status: "?", worktree_status: "?" },
    ]);
  });

  it("rejects malformed, unsafe, renamed, and non-UTF-8 status records", () => {
    expect(() => parseWorkspaceGitStatus(Buffer.from(" M source.ts"))).toThrow(
      "final record with NUL",
    );
    expect(() =>
      parseWorkspaceGitStatus(Buffer.from("R  renamed.ts\0")),
    ).toThrow("despite --no-renames");
    expect(() =>
      parseWorkspaceGitStatus(Buffer.from("?? .git/config\0")),
    ).toThrow("Workspace contract");
    expect(() =>
      parseWorkspaceGitStatus(Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x00])),
    ).toThrow("valid UTF-8");
  });

  it("binds tracked, mode, binary, deletion, and untracked status to the complete manifest", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    await writeFile(path.join(project, ".gitignore"), "*.ignored\n");
    await writeFile(path.join(project, "src", "delete.ts"), "delete\n");
    await writeFile(path.join(project, "src", "mode.sh"), "#!/bin/sh\n");
    const base = await commitFixture(project);

    await writeFile(
      path.join(project, "src", "fixture.ts"),
      "export const fixture = false;\n",
    );
    await rm(path.join(project, "src", "delete.ts"));
    await chmod(path.join(project, "src", "mode.sh"), 0o755);
    await writeFile(
      path.join(project, "src", "binary.bin"),
      Buffer.from([0, 255, 1, 254]),
    );
    await writeFile(path.join(project, "local.ignored"), "not committable\n");

    const first = await collectWorkspaceGitDiff({
      root: project,
      inputCommit: base,
      manifestDigest: sha256("complete-workspace-one"),
    });
    expect(first.changes.map((change) => change.path)).toEqual([
      "src/binary.bin",
      "src/delete.ts",
      "src/fixture.ts",
      "src/mode.sh",
    ]);
    expect(first.changes.map((change) => change.worktree_status)).toEqual([
      "?",
      "D",
      "M",
      "M",
    ]);
    expect(first.changes.map((change) => change.path)).not.toContain(
      "local.ignored",
    );

    const second = await collectWorkspaceGitDiff({
      root: project,
      inputCommit: base,
      manifestDigest: sha256("complete-workspace-two"),
    });
    expect(second.changes).toEqual(first.changes);
    expect(second.digest).not.toBe(first.digest);
    expect(() =>
      validateWorkspaceDiff({ ...first, digest: sha256("forged") }),
    ).toThrow("digest does not match");
    await expect(
      collectWorkspaceGitDiff({
        root: project,
        inputCommit: "f".repeat(40),
        manifestDigest: first.manifest_digest as `sha256:${string}`,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
  });
});
