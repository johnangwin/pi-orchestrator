import { execFile } from "node:child_process";
import {
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
import { GitWorktreeManager, parseWorktreeList } from "../src/git.js";
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
