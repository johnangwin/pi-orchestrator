import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { commitFixture, createFixtureProject, createPlan } from "./fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function orchestrator(args: readonly string[]): Promise<string> {
  const cli = path.resolve("src", "cli.ts");
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cli, ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
    },
  );
  return result.stdout.trim();
}

describe("host CLI", () => {
  it("exposes the repository planning workflow commands", async () => {
    const help = await orchestrator(["--help"]);
    expect(help).toContain("plan [options] <goal>");
    expect(help).toContain("answer [options] <planning>");
    expect(help).toContain("consult [options] <planning>");
    expect(help).toContain("draft [options] <planning>");
    expect(help).toContain("review [options] <task>");
    expect(help).toContain("metrics [options] <run>");
    expect(help).toContain("report [options] <run>");
  });

  it("validates, approves, and reports a fresh Plan", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    await createPlan(project);
    await commitFixture(project);
    const home = await mkdtemp(
      path.join(os.tmpdir(), "pi-orchestrator-cli-state-"),
    );
    roots.push(home);
    const worktreeRoot = await mkdtemp(
      path.join(os.tmpdir(), "pi-orchestrator-cli-worktrees-"),
    );
    roots.push(worktreeRoot);

    const validation = JSON.parse(
      await orchestrator([
        "validate",
        "fixture-plan",
        "--project",
        project,
        "--json",
      ]),
    ) as { id: string; tasks: string[] };
    expect(validation).toMatchObject({
      id: "fixture-plan",
      tasks: ["bounded-change"],
    });

    await expect(
      orchestrator([
        "approve",
        "fixture-plan",
        "--project",
        project,
        "--home",
        home,
        "--yes",
      ]),
    ).resolves.toMatch(/^Approved fixture-plan r1/);

    const started = JSON.parse(
      await orchestrator([
        "start",
        "fixture-plan",
        "--project",
        project,
        "--home",
        home,
        "--worktree-root",
        worktreeRoot,
        "--run",
        "fixture-run",
        "--json",
      ]),
    ) as {
      id: string;
      branch: string;
      worktree: string;
      created: boolean;
    };
    expect(started).toMatchObject({
      id: "fixture-run",
      branch: "orchestrator/fixture-run",
      created: true,
    });
    expect(started.worktree).toContain("/fixture/fixture-run");

    const digest = `sha256:${"0".repeat(64)}`;
    const planningDirectory = path.join(
      home,
      "projects",
      "fixture",
      "planning",
      "fixture-planning",
    );
    await mkdir(planningDirectory, { recursive: true });
    await writeFile(
      path.join(planningDirectory, "state.json"),
      `${JSON.stringify({
        version: 1,
        id: "fixture-planning",
        project_id: "fixture",
        goal: "Exercise status projection",
        goal_digest: digest,
        base_commit: "0".repeat(40),
        source_digest: digest,
        source_entries: 1,
        status: "consulting",
        attempts: 1,
        current_request_digest: digest,
        questionnaire_digest: digest,
        decisions: { "compatibility-policy": digest },
        consultations: {
          architecture: {
            attempts: 1,
            current_request_digest: digest,
            record_digest: digest,
            report_digest: digest,
          },
          quant: {
            attempts: 1,
            current_request_digest: digest,
            record_digest: null,
            report_digest: null,
          },
        },
        created_at: "2026-08-18T18:00:00.000Z",
        updated_at: "2026-08-18T18:05:00.000Z",
      })}\n`,
      "utf8",
    );

    const status = JSON.parse(
      await orchestrator([
        "status",
        "--project",
        project,
        "--home",
        home,
        "--json",
      ]),
    ) as {
      project: string;
      planning: Array<{
        status: string;
        consultations: {
          architecture: { report_digest: string | null };
          quant: { report_digest: string | null };
        };
        critique: { attempts: number; report_digest: string | null };
        synthesis: { attempts: number; plan_digest: string | null };
      }>;
      approvals: Array<{ fresh: boolean }>;
      runs: Array<{ id: string; status: string }>;
    };
    expect(status.project).toBe("fixture");
    expect(status.planning).toMatchObject([
      {
        status: "consulting",
        consultations: {
          architecture: { report_digest: digest },
          quant: { report_digest: null },
        },
        critique: { attempts: 0, report_digest: null },
        synthesis: { attempts: 0, plan_digest: null },
      },
    ]);
    expect(status.approvals).toHaveLength(1);
    expect(status.approvals[0]?.fresh).toBe(true);
    expect(status.runs).toMatchObject([{ id: "fixture-run", status: "ready" }]);

    const metrics = JSON.parse(
      await orchestrator([
        "metrics",
        "fixture-run",
        "--project",
        project,
        "--home",
        home,
        "--json",
      ]),
    ) as {
      run: { id: string; status: string };
      tasks: { total: number };
      human_interventions: { by_action: { approval: number } };
      metrics_digest: string;
    };
    expect(metrics).toMatchObject({
      run: { id: "fixture-run", status: "ready" },
      tasks: { total: 1 },
      human_interventions: { by_action: { approval: 1 } },
    });
    expect(metrics.metrics_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const report = JSON.parse(
      await orchestrator([
        "report",
        "fixture-run",
        "--project",
        project,
        "--home",
        home,
        "--json",
      ]),
    ) as {
      created: boolean;
      markdown_path: string;
      report: { run: string; metrics_digest: string };
    };
    expect(report).toMatchObject({
      created: true,
      report: { run: "fixture-run" },
    });
    expect(await readFile(report.markdown_path, "utf8")).toContain(
      "# Run Report: fixture-run",
    );
  });
});
