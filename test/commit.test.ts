import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommitStore,
  GitCommitWorktree,
  commitTask,
  inspectTaskCommit,
  type CommitWorktreePort,
  type GitIdentity,
} from "../src/commit.js";
import { sha256, type Digest } from "../src/digest.js";
import { defaultGitCommandRunner, type GitCommandRunner } from "../src/git.js";
import type { LocalConfig } from "../src/local.js";
import { fixtureTask } from "./fixture.js";
import {
  createAppliedFixture,
  passFixtureChecks,
  type AppliedFixture,
} from "./applied-fixture.js";
import { fixtureLocalConfig, passFixtureReviews } from "./review-fixture.js";

const execFileAsync = promisify(execFile);
const fixtures: AppliedFixture[] = [];
const author: GitIdentity = {
  name: "Fixture Human",
  email: "human@example.test",
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function reviewed(
  options: {
    readonly tasks?: ReturnType<typeof fixtureTask>[];
    readonly mutate?: (project: string) => Promise<void>;
  } = {},
): Promise<{
  readonly fixture: AppliedFixture;
  readonly local: LocalConfig;
}> {
  const fixture = await createAppliedFixture(
    options.tasks
      ? {
          ...(options.tasks[0] ? { task: options.tasks[0] } : {}),
          tasks: options.tasks,
          ...(options.mutate ? { mutate: options.mutate } : {}),
        }
      : options.mutate
        ? { mutate: options.mutate }
        : {},
  );
  fixtures.push(fixture);
  await passFixtureChecks(fixture);
  const local = await fixtureLocalConfig(fixture);
  await passFixtureReviews(fixture, local);
  return { fixture, local };
}

function inspect(
  fixture: AppliedFixture,
  local: LocalConfig,
  overrides: Partial<Parameters<typeof inspectTaskCommit>[0]> = {},
) {
  return inspectTaskCommit({
    store: fixture.store,
    project: fixture.project,
    plan: fixture.plan,
    local,
    runId: fixture.runId,
    taskId: fixture.task.id,
    author,
    ...overrides,
  });
}

function commit(
  fixture: AppliedFixture,
  local: LocalConfig,
  proposalDigest: string,
  overrides: Partial<Parameters<typeof commitTask>[0]> = {},
) {
  return commitTask({
    store: fixture.store,
    project: fixture.project,
    plan: fixture.plan,
    local,
    runId: fixture.runId,
    taskId: fixture.task.id,
    author,
    authorization: {
      proposalDigest: proposalDigest as Digest,
      approvedBy: "fixture-human",
      approvedAt: new Date("2026-08-18T18:00:00.000Z"),
    },
    now: () => new Date("2026-08-18T18:01:00.000Z"),
    ...overrides,
  });
}

async function git(root: string, args: readonly string[]): Promise<string> {
  return execFileAsync("git", [...args], { cwd: root, encoding: "utf8" }).then(
    (result) => result.stdout.trim(),
  );
}

async function orchestrator(args: readonly string[]): Promise<string> {
  const cli = path.resolve("src", "cli.ts");
  return execFileAsync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  }).then((result) => result.stdout.trim());
}

describe("human-authorized Task commit", { timeout: 15_000 }, () => {
  it("commits exact reviewed evidence, disables hooks, and unlocks dependencies", async () => {
    const primary = fixtureTask();
    const dependent = fixtureTask({
      id: "dependent-change",
      title: "Make the dependent change",
      depends: [primary.id],
    });
    const { fixture, local } = await reviewed({
      tasks: [primary, dependent],
    });
    const hookMarker = path.join(fixture.root, "hook-ran");
    const hook = path.join(fixture.root, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\ntouch '${hookMarker}'\nexit 1\n`, "utf8");
    await chmod(hook, 0o755);

    const prepared = await inspect(fixture, local);
    expect(prepared).toMatchObject({
      state: "ready",
      proposal: {
        run: fixture.runId,
        task: primary.id,
        subject: primary.title,
        author,
        changes: [{ path: "src/fixture.ts", status: "modified" }],
        checks: [{ check: "project-test" }],
        reviews: [{ lens: "spec" }, { lens: "quality" }],
      },
      worktree: { state: "ready" },
    });

    const result = await commit(
      fixture,
      local,
      prepared.proposal.proposal_digest,
    );
    expect(result).toMatchObject({
      created: true,
      recovered: false,
      reused: false,
      task: { status: "accepted" },
      run: {
        status: "active",
        tasks: {
          "dependent-change": {
            status: "ready",
            input_commit: result.record.git.commit,
          },
        },
      },
    });
    expect(result.task.gates.commit).toEqual({
      status: "pass",
      digest: result.record.record_digest,
      updated_at: "2026-08-18T18:01:00.000Z",
    });
    expect(await git(fixture.worktree, ["rev-parse", "HEAD"])).toBe(
      result.record.git.commit,
    );
    expect(await git(fixture.worktree, ["show", "-s", "--format=%s"])).toBe(
      primary.title,
    );
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(hookMarker)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a one-Task Run and reuses exact durable Commit evidence", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    const first = await commit(
      fixture,
      local,
      prepared.proposal.proposal_digest,
    );
    expect(first.run.status).toBe("complete");
    expect((await fixture.store.read()).runs[fixture.runId]?.status).toBe(
      "complete",
    );

    const staleProject = JSON.parse(
      await readFile(fixture.store.projectFile, "utf8"),
    ) as { runs: Record<string, { status: string }> };
    staleProject.runs[fixture.runId]!.status = "active";
    await writeFile(
      fixture.store.projectFile,
      `${JSON.stringify(staleProject, null, 2)}\n`,
      "utf8",
    );

    const current = await inspect(fixture, local);
    expect(current).toMatchObject({
      state: "committed",
      record: { record_digest: first.record.record_digest },
    });
    const reused = await commitTask({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      local,
      runId: fixture.runId,
      taskId: fixture.task.id,
      author,
    });
    expect(reused).toMatchObject({ reused: true, created: false });
    expect(reused.record).toEqual(first.record);
    expect((await fixture.store.read()).runs[fixture.runId]?.status).toBe(
      "complete",
    );

    const commits = new CommitStore(fixture.store.runDirectory(fixture.runId));
    const stored = await commits.findResultByDigest(
      fixture.task.id,
      first.record.record_digest,
    );
    expect(stored).toEqual(first.record);
    await expect(commits.listResults()).resolves.toEqual([first.record]);
  });

  it("recovers when Git succeeds before Commit evidence is published", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    const real = new GitCommitWorktree();
    const interrupted: CommitWorktreePort = {
      inspect: (options) => real.inspect(options),
      async commit(options) {
        await real.commit(options);
        throw new Error("injected post-Git interruption");
      },
    };
    await expect(
      commit(fixture, local, prepared.proposal.proposal_digest, {
        worktrees: interrupted,
      }),
    ).rejects.toThrow("injected post-Git interruption");
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]?.gates
        .commit,
    ).toMatchObject({ status: "pending" });

    const recovered = await commitTask({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      local,
      runId: fixture.runId,
      taskId: fixture.task.id,
      author,
      now: () => new Date("2026-08-18T18:02:00.000Z"),
    });
    expect(recovered).toMatchObject({
      created: false,
      recovered: true,
      reused: false,
      task: { status: "accepted" },
    });
  });

  it("recovers durable human intent when pending Gate publication was interrupted", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    const interruptedStore = {
      read: () => fixture.store.read(),
      readRun: (runId: string) => fixture.store.readRun(runId),
      runDirectory: (runId: string) => fixture.store.runDirectory(runId),
      updateRun: () => Promise.reject(new Error("injected Gate interruption")),
    };
    await expect(
      commit(fixture, local, prepared.proposal.proposal_digest, {
        store: interruptedStore,
      }),
    ).rejects.toThrow("injected Gate interruption");
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]?.gates
        .commit,
    ).toBeUndefined();

    const recovered = await commitTask({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      local,
      runId: fixture.runId,
      taskId: fixture.task.id,
      author,
      now: () => new Date("2026-08-18T18:03:00.000Z"),
    });
    expect(recovered).toMatchObject({
      created: true,
      reused: false,
      task: { status: "accepted" },
    });
    expect(recovered.intent.approved_by).toBe("fixture-human");
    expect(recovered.intent.approved_at).toBe("2026-08-18T18:00:00.000Z");
  });

  it("recovers an immutable Commit result when acceptance was interrupted", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    let updates = 0;
    const interruptedStore = {
      read: () => fixture.store.read(),
      readRun: (runId: string) => fixture.store.readRun(runId),
      runDirectory: (runId: string) => fixture.store.runDirectory(runId),
      updateRun: (
        runId: string,
        change: Parameters<typeof fixture.store.updateRun>[1],
      ) => {
        updates += 1;
        if (updates === 2)
          return Promise.reject(new Error("injected acceptance interruption"));
        return fixture.store.updateRun(runId, change);
      },
    };
    await expect(
      commit(fixture, local, prepared.proposal.proposal_digest, {
        store: interruptedStore,
      }),
    ).rejects.toThrow("injected acceptance interruption");
    const pending = await fixture.store.readRun(fixture.runId);
    expect(pending.tasks[fixture.task.id]).toMatchObject({
      status: "reviewing",
      gates: { commit: { status: "pending" } },
    });

    const recovered = await commitTask({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      local,
      runId: fixture.runId,
      taskId: fixture.task.id,
      author,
      now: () => new Date("2026-08-18T18:04:00.000Z"),
    });
    expect(recovered).toMatchObject({
      created: false,
      recovered: true,
      reused: false,
      task: { status: "accepted" },
    });
  });

  it("does not overwrite a Run branch that races beyond the approved parent", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    let competitor: string | undefined;
    const runner: GitCommandRunner = async (args, cwd) => {
      if (args[0] === "update-ref" && !competitor) {
        const tree = await git(cwd, [
          "rev-parse",
          `${prepared.proposal.input_commit}^{tree}`,
        ]);
        competitor = await git(cwd, [
          "-c",
          `user.name=${author.name}`,
          "-c",
          `user.email=${author.email}`,
          "commit-tree",
          tree,
          "-p",
          prepared.proposal.input_commit,
          "-m",
          "Competing host commit",
        ]);
        await git(cwd, [
          "update-ref",
          `refs/heads/${prepared.proposal.branch}`,
          competitor,
          prepared.proposal.input_commit,
        ]);
      }
      return defaultGitCommandRunner(args, cwd);
    };

    await expect(
      commit(fixture, local, prepared.proposal.proposal_digest, {
        worktrees: new GitCommitWorktree(runner),
      }),
    ).rejects.toMatchObject({ code: "git_failed" });
    expect(await git(fixture.worktree, ["rev-parse", "HEAD"])).toBe(competitor);
    expect(await git(fixture.worktree, ["show", "-s", "--format=%s"])).toBe(
      "Competing host commit",
    );
  });

  it("requires every Review and an exact proposal authorization", async () => {
    const fixture = await createAppliedFixture();
    fixtures.push(fixture);
    await passFixtureChecks(fixture);
    const local = await fixtureLocalConfig(fixture);
    await expect(inspect(fixture, local)).rejects.toMatchObject({
      code: "commit_reviews_incomplete",
    });

    await passFixtureReviews(fixture, local);
    const prepared = await inspect(fixture, local);
    await expect(
      commit(fixture, local, sha256("another proposal")),
    ).rejects.toMatchObject({ code: "commit_authorization_stale" });
    expect(await git(fixture.worktree, ["rev-parse", "HEAD"])).toBe(
      prepared.proposal.input_commit,
    );
  });

  it("rejects Review route drift and unexpected worktree changes", async () => {
    const routeFixture = await reviewed();
    const drifted = structuredClone(routeFixture.local);
    drifted.models["independent-review"]!.pi_model = "another-reviewer";
    await expect(inspect(routeFixture.fixture, drifted)).rejects.toMatchObject({
      code: "commit_review_stale",
    });

    const worktreeFixture = await reviewed();
    await writeFile(
      path.join(worktreeFixture.fixture.worktree, "src", "fixture.ts"),
      "export const fixture = 'unapproved';\n",
      "utf8",
    );
    await expect(
      inspect(worktreeFixture.fixture, worktreeFixture.local),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/worktree|commit/),
    });
  });

  it("makes current Check and Review policy bytes part of Commit freshness", async () => {
    const { fixture, local } = await reviewed();
    const policyDirectory = path.join(fixture.root, "commit-policies");
    await mkdir(policyDirectory, { recursive: true });
    const bundled = path.resolve("sandbox", "policies");
    await writeFile(
      path.join(policyDirectory, "read.yaml"),
      await readFile(path.join(bundled, "read.yaml")),
    );
    await writeFile(
      path.join(policyDirectory, "check.yaml"),
      `${await readFile(path.join(bundled, "check.yaml"), "utf8")}# changed after Check\n`,
      "utf8",
    );

    await expect(
      inspect(fixture, local, { policyDirectory }),
    ).rejects.toMatchObject({ code: "commit_check_stale" });
  });

  it("rejects a trusted checkout that advanced beyond the approved base", async () => {
    const { fixture, local } = await reviewed();
    await writeFile(
      path.join(fixture.root, "unrelated.txt"),
      "new trusted checkout content\n",
      "utf8",
    );
    await git(fixture.root, ["add", "unrelated.txt"]);
    await git(fixture.root, [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      "Advance trusted checkout",
    ]);

    await expect(inspect(fixture, local)).rejects.toMatchObject({
      code: "commit_base_stale",
    });
  });

  it("does not adopt an exact Git commit created without durable human intent", async () => {
    const { fixture, local } = await reviewed();
    const prepared = await inspect(fixture, local);
    await git(fixture.worktree, ["add", "--all"]);
    await git(fixture.worktree, [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      prepared.proposal.subject,
    ]);

    await expect(inspect(fixture, local)).rejects.toMatchObject({
      code: "commit_authorization_missing",
    });
  });

  it("refuses clean filters before Git can execute them on the host", async () => {
    const { fixture, local } = await reviewed();
    const marker = path.join(fixture.root, "filter-ran");
    const filter = path.join(fixture.root, "clean-filter.sh");
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, "utf8");
    await chmod(filter, 0o755);
    await mkdir(path.join(fixture.root, ".git", "info"), { recursive: true });
    await writeFile(
      path.join(fixture.root, ".git", "info", "attributes"),
      "src/fixture.ts filter=fixture-unsafe\n",
      "utf8",
    );
    await git(fixture.root, ["config", "filter.fixture-unsafe.clean", filter]);
    await git(fixture.root, [
      "config",
      "filter.fixture-unsafe.required",
      "true",
    ]);

    await expect(inspect(fixture, local)).rejects.toMatchObject({
      code: "commit_filter_unsupported",
    });
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(marker)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Git index content transformed away from the approved Patch", async () => {
    const { fixture, local } = await reviewed({
      mutate: (projectRoot) =>
        writeFile(
          path.join(projectRoot, "src", "fixture.ts"),
          "export const fixture = 'checked';\r\n",
          "utf8",
        ),
    });
    await mkdir(path.join(fixture.root, ".git", "info"), { recursive: true });
    await writeFile(
      path.join(fixture.root, ".git", "info", "attributes"),
      "src/fixture.ts text eol=lf\n",
      "utf8",
    );
    const prepared = await inspect(fixture, local);

    await expect(
      commit(fixture, local, prepared.proposal.proposal_digest),
    ).rejects.toMatchObject({ code: "commit_index_mismatch" });
    expect(await git(fixture.worktree, ["rev-parse", "HEAD"])).toBe(
      prepared.proposal.input_commit,
    );
  });

  it("exposes the exact human Commit flow through the host CLI", async () => {
    const { fixture, local } = await reviewed();
    const localPath = path.join(fixture.root, ".pi", "orchestrator.local.yaml");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, JSON.stringify(local), "utf8");
    await git(fixture.root, ["config", "user.name", author.name]);
    await git(fixture.root, ["config", "user.email", author.email]);
    await fixture.store.close();

    const output = JSON.parse(
      await orchestrator([
        "commit",
        fixture.task.id,
        "--project",
        fixture.root,
        "--home",
        fixture.home,
        "--config",
        localPath,
        "--run",
        fixture.runId,
        "--yes",
        "--json",
      ]),
    ) as Record<string, unknown>;
    expect(output).toMatchObject({
      run: fixture.runId,
      run_status: "complete",
      task: fixture.task.id,
      task_status: "accepted",
      subject: fixture.task.title,
      author,
      created: true,
      recovered: false,
      reused: false,
    });

    const status = JSON.parse(
      await orchestrator([
        "status",
        "--project",
        fixture.root,
        "--home",
        fixture.home,
        "--json",
      ]),
    ) as { runs: Array<{ id: string; status: string }> };
    expect(status.runs).toContainEqual({
      id: fixture.runId,
      plan_id: fixture.plan.id,
      state_path: path.join(
        fixture.home,
        "projects",
        "fixture",
        "runs",
        fixture.runId,
        "state.json",
      ),
      status: "complete",
    });
  });
});
