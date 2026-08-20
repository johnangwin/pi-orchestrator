import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { sha256, type Digest } from "../src/digest.js";
import { initializeProject } from "../src/init.js";
import {
  createPermissionCeiling,
  projectPermissionPolicyDigest,
  type PermissionAssignment,
  type PermissionCeiling,
  type PermissionSet,
} from "../src/permission.js";
import type { PlanTask } from "../src/plan.js";
import type { Project } from "../src/project.js";

const execFileAsync = promisify(execFile);

export const fixtureDigest: Digest = sha256("pi-orchestrator-test-fixture");

const readPermissions: PermissionSet = {
  source: "read",
  write_lease: "never",
  pi_tools: ["read", "grep", "find", "ls", "bash"],
  actions: [
    "ask",
    "message",
    "consult",
    "report",
    "handoff",
    "block",
    "propose_plan",
    "propose_decision",
    "coordinate",
  ],
};

const writePermissions: PermissionSet = {
  source: "read",
  write_lease: "task",
  pi_tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
  actions: ["message", "consult", "report", "handoff", "block", "finish"],
};

export function fixturePermissionCeiling(
  assignment: PermissionAssignment = { kind: "query" },
  role = assignment.kind === "task" ? "implementer" : "scout",
): PermissionCeiling {
  return createPermissionCeiling({
    role,
    rolePermissions:
      assignment.kind === "task" ? writePermissions : readPermissions,
    assignment,
  });
}

export function fixturePermissionPolicyDigest(project: Project): Digest {
  return projectPermissionPolicyDigest(project.roles);
}

export const planMarkdown = `# Fixture Plan

## Context

The fixture needs a bounded change.

## Goal

Exercise the Orchestrator core.

## Non-goals

Do not launch a Sandbox.

## Current structure

The fixture contains one source file.

## Proposed direction

Validate one deterministic Task.

## Architecture

Keep the boundary local.

## Quantitative implications

There are no financial semantics.

## Risks

The fixture may be incomplete.

## Open questions

None.
`;

export function fixtureTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "bounded-change",
    title: "Make a bounded change",
    role: "implementer",
    goal: "Change the fixture without expanding scope.",
    depends: [],
    scope: ["src/**"],
    non_goals: ["Change project policy."],
    acceptance: ["The registered Check passes."],
    checks: ["project-test"],
    reviews: ["spec", "quality"],
    ...overrides,
  };
}

export async function createFixtureProject(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-")),
  );
  await initializeProject(root, "fixture");

  const configPath = path.join(root, ".agents", "orchestrator.yaml");
  const config = parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.checks = { "project-test": { argv: ["node", "--test"] } };
  await writeFile(configPath, stringify(config), "utf8");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "fixture.ts"),
    "export const fixture = true;\n",
    "utf8",
  );
  return root;
}

export async function createPlan(
  root: string,
  options: {
    readonly id?: string;
    readonly revision?: number;
    readonly tasks?: readonly PlanTask[];
    readonly markdown?: string;
  } = {},
): Promise<string> {
  const id = options.id ?? "fixture-plan";
  const directory = path.join(root, "docs", "plans", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "plan.md"),
    options.markdown ?? planMarkdown,
    "utf8",
  );
  await writeFile(
    path.join(directory, "tasks.yaml"),
    stringify({
      version: 1,
      plan: { id, revision: options.revision ?? 1 },
      tasks: options.tasks ?? [fixtureTask()],
    }),
    "utf8",
  );
  return directory;
}

export async function commitFixture(root: string): Promise<string> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
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
      "fixture",
    ],
    { cwd: root },
  );
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
