import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  it("validates, approves, and reports a fresh Plan", async () => {
    const project = await createFixtureProject();
    roots.push(project);
    await createPlan(project);
    await commitFixture(project);
    const home = await mkdtemp(
      path.join(os.tmpdir(), "pi-orchestrator-cli-state-"),
    );
    roots.push(home);

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

    const status = JSON.parse(
      await orchestrator([
        "status",
        "--project",
        project,
        "--home",
        home,
        "--json",
      ]),
    ) as { project: string; approvals: Array<{ fresh: boolean }> };
    expect(status.project).toBe("fixture");
    expect(status.approvals).toHaveLength(1);
    expect(status.approvals[0]?.fresh).toBe(true);
  });
});
