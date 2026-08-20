import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  approvalFreshness,
  createApproval,
  requireFreshApproval,
} from "../src/approval.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { routingPolicyDigest } from "../src/model.js";
import {
  createFixtureProject,
  createPlan,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
  fixtureTask,
} from "./fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await createFixtureProject();
  roots.push(root);
  const directory = await createPlan(root);
  const project = await loadProject(root);
  return { root, directory, project };
}

describe("Plan validation and approval", () => {
  it("invalidates approval when plan.md changes", async () => {
    const { directory, project } = await fixture();
    const original = await loadPlan(
      directory,
      catalogFromConfig(project.config),
    );
    const approval = createApproval({
      plan: original,
      baseCommit: "base-commit",
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "tester",
    });

    const markdownPath = path.join(directory, "plan.md");
    await writeFile(
      markdownPath,
      `${await readFile(markdownPath, "utf8")}\nAdditional detail.\n`,
      "utf8",
    );
    const changed = await loadPlan(
      directory,
      catalogFromConfig(project.config),
    );
    const freshness = approvalFreshness(approval, {
      planId: changed.id,
      planRevision: changed.revision,
      planDigest: changed.digest,
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      baseCommit: "base-commit",
    });

    expect(freshness.fresh).toBe(false);
    expect(freshness.reasons).toContain("Plan content changed");
  });

  it("invalidates approval when tasks.yaml changes", async () => {
    const { directory, project } = await fixture();
    const original = await loadPlan(
      directory,
      catalogFromConfig(project.config),
    );
    const approval = createApproval({
      plan: original,
      baseCommit: "base-commit",
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "tester",
    });
    const tasksPath = path.join(directory, "tasks.yaml");
    const tasks = parse(await readFile(tasksPath, "utf8")) as {
      tasks: Array<{ goal: string }>;
    };
    tasks.tasks[0]!.goal = "A materially different goal.";
    await writeFile(tasksPath, stringify(tasks), "utf8");
    const changed = await loadPlan(
      directory,
      catalogFromConfig(project.config),
    );

    expect(
      approvalFreshness(approval, {
        planId: changed.id,
        planRevision: changed.revision,
        planDigest: changed.digest,
        permissionPolicyDigest: fixturePermissionPolicyDigest(project),
        routingPolicyDigest: fixtureRoutingPolicyDigest(project),
        baseCommit: "base-commit",
      }).fresh,
    ).toBe(false);
  });

  it("invalidates approval when committed Model routing policy changes", async () => {
    const { directory, project } = await fixture();
    const plan = await loadPlan(directory, catalogFromConfig(project.config));
    const approval = createApproval({
      plan,
      baseCommit: "base-commit",
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "tester",
    });
    const changed = structuredClone(project.config);
    changed.routing.roles.implementer!.allowed.push("alternate-local-code");

    expect(
      approvalFreshness(approval, {
        planId: plan.id,
        planRevision: plan.revision,
        planDigest: plan.digest,
        permissionPolicyDigest: fixturePermissionPolicyDigest(project),
        routingPolicyDigest: routingPolicyDigest(changed),
        baseCommit: "base-commit",
      }),
    ).toEqual({
      fresh: false,
      reasons: ["Model routing policy changed"],
    });
  });

  it("rejects a Task dependency cycle", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const directory = await createPlan(root, {
      tasks: [
        fixtureTask({ id: "first-task", depends: ["second-task"] }),
        fixtureTask({ id: "second-task", depends: ["first-task"] }),
      ],
    });
    const project = await loadProject(root);

    await expect(
      loadPlan(directory, catalogFromConfig(project.config)),
    ).rejects.toMatchObject({
      code: "dependency_cycle",
    });
  });

  it.each([
    ["unknown Role", fixtureTask({ role: "missing-role" }), "unknown_role"],
    [
      "unknown Check",
      fixtureTask({ checks: ["missing-check"] }),
      "unknown_check",
    ],
    [
      "unknown Lens",
      { ...fixtureTask(), reviews: ["security"] },
      "invalid_plan",
    ],
    [
      "duplicate Lens",
      fixtureTask({ reviews: ["spec", "spec"] }),
      "invalid_plan",
    ],
    [
      "unsafe source scope",
      fixtureTask({ scope: ["../src/**"] }),
      "invalid_plan",
    ],
    [
      "glob write path",
      fixtureTask({ write_paths: ["src/**"] }),
      "invalid_plan",
    ],
    [
      "write path outside semantic scope",
      fixtureTask({ write_paths: ["test"] }),
      "invalid_plan",
    ],
    [
      "protected write path",
      fixtureTask({ write_paths: [".agents"], scope: [".agents/**"] }),
      "write_path_protected",
    ],
  ])("rejects an %s", async (_label, task, code) => {
    const root = await createFixtureProject();
    roots.push(root);
    const directory = await createPlan(root, {
      tasks: [task as ReturnType<typeof fixtureTask>],
    });
    const project = await loadProject(root);
    await expect(
      loadPlan(directory, catalogFromConfig(project.config)),
    ).rejects.toMatchObject({ code });
  });

  it("rejects a Role that references an unknown Skill", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const rolePath = path.join(root, ".agents", "roles", "implementer.md");
    const source = await readFile(rolePath, "utf8");
    await writeFile(
      rolePath,
      source.replace("  - development", "  - missing-skill"),
      "utf8",
    );
    await expect(loadProject(root)).rejects.toMatchObject({
      code: "unknown_skill",
    });
  });

  it("rejects a Task write root that overlaps committed restrictions", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const configPath = path.join(root, ".agents", "orchestrator.yaml");
    const config = parse(await readFile(configPath, "utf8")) as {
      restricted_paths: string[];
    };
    config.restricted_paths = ["src/private/**"];
    await writeFile(configPath, stringify(config), "utf8");
    const directory = await createPlan(root, {
      tasks: [
        fixtureTask({
          write_paths: ["src/private"],
          scope: ["src/private/**"],
        }),
      ],
    });
    const project = await loadProject(root);

    await expect(
      loadPlan(directory, catalogFromConfig(project.config)),
    ).rejects.toMatchObject({ code: "write_path_restricted" });
  });

  it("prevents writable work without a fresh approval", async () => {
    const { directory, project } = await fixture();
    const plan = await loadPlan(directory, catalogFromConfig(project.config));
    const current = {
      planId: plan.id,
      planRevision: plan.revision,
      planDigest: plan.digest,
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      baseCommit: "base-commit",
    } as const;

    expect(() => requireFreshApproval(undefined, current)).toThrowError(
      /has not been approved/,
    );
    const approval = createApproval({
      plan,
      baseCommit: "other-commit",
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "tester",
    });
    expect(() => requireFreshApproval(approval, current)).toThrowError(
      /approval is stale/,
    );
  });
});
