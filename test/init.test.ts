import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/init.js";
import { loadLocalConfig, resolveMachinePath } from "../src/local.js";
import { loadProject } from "../src/project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("consumer Project initialization", () => {
  it("creates a valid minimal Project without overwriting existing instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-init-"));
    roots.push(root);
    await initializeProject(root, "sample-project");
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, "# Existing instructions\n", "utf8");
    await initializeProject(root, "sample-project");

    const project = await loadProject(root);
    expect(project.config.project.id).toBe("sample-project");
    expect(project.config.restricted_paths).toEqual([]);
    expect(project.roles.get("architect")?.definition.permissions.source).toBe(
      "read",
    );
    expect(project.config.routing.roles.quant).toMatchObject({
      default: "local-quant",
      remote: "denied",
    });
    expect(
      project.roles.get("implementer")?.definition.permissions.write_lease,
    ).toBe("task");
    expect(project.skills.get("quant")?.content).toContain(
      "dimensional consistency",
    );
    expect(await readFile(agentsPath, "utf8")).toBe(
      "# Existing instructions\n",
    );
    await expect(
      loadLocalConfig(
        path.join(root, ".pi", "orchestrator.local.yaml.example"),
      ),
    ).resolves.toMatchObject({
      openshell: { required_version: "0.0.106" },
      cmux: {
        required_version: "0.64.22",
        workspace_prefix: "orchestrator",
      },
      worktrees: {
        root: "~/.local/share/pi-orchestrator/worktrees",
      },
      workspace: {
        volume_prefix: "pi-orchestrator",
        restricted_paths: [],
      },
    });
  });

  it("resolves machine-local worktree roots without shell expansion", () => {
    expect(resolveMachinePath("~/runs", "/home/fixture", "/project")).toBe(
      "/home/fixture/runs",
    );
    expect(resolveMachinePath("./runs", "/home/fixture", "/project")).toBe(
      "/project/runs",
    );
    expect(() =>
      resolveMachinePath("~another/runs", "/home/fixture", "/project"),
    ).toThrow("unsupported home expansion");
  });
});
