import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createExampleProject } from "../src/example.js";
import { loadLocalConfig } from "../src/local.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadProject } from "../src/project.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-run example", () => {
  it("creates a clean standalone Project with a valid Plan and passing baseline", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "pi-example-test-"));
    roots.push(parent);
    const destination = path.join(parent, "first-run");
    const result = await createExampleProject({ directory: destination });

    expect(result).toMatchObject({
      root: destination,
      projectId: "price-calculator",
      planId: "percentage-discount",
      taskId: "add-discount",
      localConfig: "example",
    });
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    const project = await loadProject(destination);
    expect(project.config.checks).toEqual({
      test: { argv: ["node", "--test"] },
    });
    const plan = await loadPlan(
      path.join(destination, "docs", "plans", result.planId),
      catalogFromConfig(project.config),
    );
    expect(plan.tasks).toMatchObject([
      {
        id: "add-discount",
        reviews: ["spec", "architecture", "quality", "quant"],
      },
    ]);
    await expect(
      loadLocalConfig(path.join(destination, ".pi", "orchestrator.local.yaml")),
    ).resolves.toMatchObject({ version: 1 });
    const tests = await execFileAsync("node", ["--test"], {
      cwd: destination,
      encoding: "utf8",
    });
    expect(tests.stdout).toContain("pass 3");
    const status = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: destination, encoding: "utf8" },
    );
    expect(status.stdout).toBe("");
    expect(
      await readFile(path.join(destination, "AGENTS.md"), "utf8"),
    ).toContain("Represent money as integer cents");
  });

  it("does not replace an existing destination", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "pi-example-test-"));
    roots.push(parent);
    const destination = path.join(parent, "first-run");
    await createExampleProject({ directory: destination });
    await expect(
      createExampleProject({ directory: destination }),
    ).rejects.toMatchObject({ code: "example_destination_exists" });
  });
});
