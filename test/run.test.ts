import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { defaultRunId, startRun, type RunWorktreePort } from "../src/run.js";
import { ProjectStore } from "../src/state.js";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixtureTask,
} from "./fixture.js";

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

async function fixture() {
  const root = await createFixtureProject();
  roots.push(root);
  await createPlan(root, {
    tasks: [
      fixtureTask(),
      fixtureTask({
        id: "dependent-change",
        depends: ["bounded-change"],
      }),
    ],
  });
  const commit = await commitFixture(root);
  const project = await loadProject(root);
  const plan = await loadPlan(
    path.join(root, "docs", "plans", "fixture-plan"),
    catalogFromConfig(project.config),
  );
  const home = await temporary("pi-run-state-");
  const worktreeRoot = await temporary("pi-run-worktrees-");
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: project.root,
  });
  return { root, commit, project, plan, home, worktreeRoot, store };
}

describe("approved Run initialization", () => {
  it("creates a durable Run and exact isolated worktree, then recovers it", async () => {
    const { root, commit, project, plan, worktreeRoot, store } =
      await fixture();
    try {
      await store.recordApproval(
        createApproval({
          plan,
          baseCommit: commit,
          approvedBy: "fixture",
          approvedAt: new Date("2026-08-18T12:00:00.000Z"),
        }),
      );

      const first = await startRun({
        store,
        project,
        plan,
        worktreeRoot,
        now: new Date("2026-08-18T12:01:00.000Z"),
      });
      expect(first).toMatchObject({
        created: true,
        run: {
          id: "fixture-plan-r1",
          plan_digest: plan.digest,
          base_commit: commit,
          branch: "orchestrator/fixture-plan-r1",
          status: "ready",
          tasks: {
            "bounded-change": {
              status: "ready",
              input_commit: commit,
            },
            "dependent-change": { status: "pending" },
          },
        },
        worktree: { created: true, recovered: false },
      });
      expect(first.run.worktree.startsWith(await realpath(worktreeRoot))).toBe(
        true,
      );
      expect(first.run.worktree.startsWith(await realpath(root))).toBe(false);

      const record = await store.read();
      expect(record.runs["fixture-plan-r1"]).toMatchObject({
        id: "fixture-plan-r1",
        plan_id: "fixture-plan",
        status: "ready",
      });
      expect(record.runs["fixture-plan-r1"]?.state_path).toBe(
        path.join(store.runDirectory("fixture-plan-r1"), "state.json"),
      );

      const second = await startRun({
        store,
        project,
        plan,
        worktreeRoot,
        now: new Date("2026-08-18T12:02:00.000Z"),
      });
      expect(second.created).toBe(false);
      expect(second.run).toEqual(first.run);
      expect(second.worktree).toMatchObject({
        created: false,
        recovered: true,
      });
      expect(
        await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: first.run.worktree,
          encoding: "utf8",
        }).then((result) => result.stdout.trim()),
      ).toBe(commit);
    } finally {
      await store.close();
    }
  });

  it("rejects missing or stale approval before creating Run state", async () => {
    const { root, commit, project, plan, worktreeRoot, store } =
      await fixture();
    try {
      await expect(
        startRun({ store, project, plan, worktreeRoot }),
      ).rejects.toMatchObject({ code: "approval_required" });

      await store.recordApproval(
        createApproval({ plan, baseCommit: commit, approvedBy: "fixture" }),
      );
      await writeFile(
        path.join(root, "src", "later.ts"),
        "export {};\n",
        "utf8",
      );
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "later",
        ],
        { cwd: root },
      );
      await expect(
        startRun({ store, project, plan, worktreeRoot }),
      ).rejects.toMatchObject({ code: "approval_stale" });
      await expect(store.readRun(defaultRunId(plan))).rejects.toMatchObject({
        code: "state_not_found",
      });
    } finally {
      await store.close();
    }
  });

  it("persists Run intent before worktree mutation and resumes the same operation", async () => {
    const { commit, project, plan, worktreeRoot, store } = await fixture();
    const worktree = path.join(
      path.resolve(worktreeRoot),
      "fixture",
      "durable-run",
    );
    const intent = {
      project_id: "fixture",
      run_id: "durable-run",
      repository: project.root,
      common_dir: path.join(project.root, ".git"),
      worktree,
      branch: "orchestrator/durable-run",
      base_commit: commit,
    };
    let fail = true;
    let ensureCalls = 0;
    const worktrees: RunWorktreePort = {
      prepare: () => Promise.resolve(intent),
      inspect: () => Promise.resolve({ intent, status: "missing" }),
      preflight: () => Promise.resolve({ intent, status: "missing" }),
      ensure: () => {
        ensureCalls += 1;
        if (fail) return Promise.reject(new Error("injected Git failure"));
        return Promise.resolve({ intent, created: true, recovered: true });
      },
    };
    try {
      await store.recordApproval(
        createApproval({ plan, baseCommit: commit, approvedBy: "fixture" }),
      );
      await expect(
        startRun({
          store,
          project,
          plan,
          runId: "durable-run",
          worktreeRoot,
          worktrees,
          now: new Date("2026-08-18T12:01:00.000Z"),
        }),
      ).rejects.toThrow("injected Git failure");
      await expect(store.readRun("durable-run")).resolves.toMatchObject({
        branch: intent.branch,
        worktree: intent.worktree,
        base_commit: commit,
      });
      expect((await store.read()).runs["durable-run"]).toBeDefined();

      fail = false;
      await expect(
        startRun({
          store,
          project,
          plan,
          runId: "durable-run",
          worktreeRoot,
          worktrees,
          now: new Date("2026-08-18T12:02:00.000Z"),
        }),
      ).resolves.toMatchObject({
        created: false,
        worktree: { recovered: true },
      });
      expect(ensureCalls).toBe(2);
    } finally {
      await store.close();
    }
  });
});
