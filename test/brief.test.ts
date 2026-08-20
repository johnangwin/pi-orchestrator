import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  briefStaleReasons,
  compileBrief,
  type BriefInput,
} from "../src/brief.js";
import { sha256 } from "../src/digest.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadProject } from "../src/project.js";
import { createReport } from "../src/report.js";
import {
  createFixtureProject,
  createPlan,
  fixtureModelRoute,
  fixturePermissionCeiling,
} from "./fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function briefInput(): Promise<BriefInput> {
  const root = await createFixtureProject();
  roots.push(root);
  const directory = await createPlan(root);
  const project = await loadProject(root);
  const plan = await loadPlan(directory, catalogFromConfig(project.config));
  const role = project.roles.get("implementer")!;
  const model = fixtureModelRoute();
  const dependency = createReport({
    id: "report-dependency",
    kind: "consultation",
    run: "run-001",
    agent: "architect",
    session: "session-001",
    generation: 1,
    permission_ceiling_digest:
      fixturePermissionCeiling().permission_ceiling_digest,
    model_profile: model.profile,
    route_digest: model.route_digest,
    task: "bounded-change",
    content: "# Conclusion\nKeep the current boundary.",
    created_at: new Date().toISOString(),
  });

  return {
    identity: {
      run: "run-001",
      agent: "implementer",
      session: "session-002",
      generation: 2,
    },
    agents: project.agents,
    role,
    model,
    permissionCeiling: fixturePermissionCeiling(
      { kind: "task", task: plan.tasks[0]!.id },
      role.definition.name,
    ),
    task: plan.tasks[0]!,
    plan,
    decisions: [
      {
        id: "decision-001",
        scope: "task",
        statement: "Preserve the current boundary.",
        rationale: "It is sufficient for this Task.",
        accepted_at: new Date().toISOString(),
      },
    ],
    dependencyReports: [dependency],
    skills: role.definition.skills.map((name) => project.skills.get(name)!),
    outputContract: "Submit an implementation Report and patch metadata.",
    sourceAnchors: [
      {
        path: "src/fixture.ts",
        symbol: "fixture",
        reason: "Defines fixture behavior.",
      },
    ],
    sourceDigests: {
      "src/fixture.ts": sha256("export const fixture = true;\n"),
    },
    contextLimitTokens: 100_000,
  };
}

describe("Brief compilation", () => {
  it("contains authoritative identity, Task, Decisions, dependencies, and source identity", async () => {
    const input = await briefInput();
    const brief = compileBrief(input);

    expect(brief.content).toContain("Session: session-002");
    expect(brief.content).toContain("bounded-change");
    expect(brief.content).toContain("Preserve the current boundary.");
    expect(brief.content).toContain("report-dependency");
    expect(brief.content).toContain("Keep the current boundary.");
    expect(brief.content).toContain("src/fixture.ts");
    expect(brief.omissions).toEqual([]);
  });

  it("marks a Brief stale when source or generation identity changes", async () => {
    const input = await briefInput();
    const previous = compileBrief(input).binding;
    const current = compileBrief({
      ...input,
      identity: {
        ...input.identity,
        generation: input.identity.generation + 1,
      },
      sourceDigests: { "src/fixture.ts": sha256("changed") },
    }).binding;

    expect(briefStaleReasons(previous, current)).toEqual([
      "source digest changed",
      "Session identity or generation changed",
    ]);
  });

  it("marks a Brief stale when its resolved Model Profile route changes", async () => {
    const input = await briefInput();
    const previous = compileBrief(input).binding;
    const model = fixtureModelRoute("local-code", {
      pi_model: "replacement-local-code",
    });
    const current = compileBrief({ ...input, model }).binding;

    expect(briefStaleReasons(previous, current)).toEqual([
      "resolved model route changed",
    ]);
  });

  it("binds Review evidence by immutable diff reference instead of embedding it", async () => {
    const input = await briefInput();
    const review = {
      lens: "spec" as const,
      diff: {
        path: "/workspace/input/review.patch" as const,
        digest: sha256("large frozen diff"),
      },
      checks: [
        {
          check: "project-test",
          verdict: "pass" as const,
          argv: ["node", "--test"],
          cwd: ".",
          exitCode: 0,
          recordDigest: sha256("Check record"),
        },
      ],
    };
    const previous = compileBrief({ ...input, review });
    const current = compileBrief({
      ...input,
      review: {
        ...review,
        diff: { ...review.diff, digest: sha256("changed diff") },
      },
    });

    expect(previous.content).toContain("/workspace/input/review.patch");
    expect(previous.content).not.toContain("large frozen diff");
    expect(briefStaleReasons(previous.binding, current.binding)).toEqual([
      "Review evidence changed",
    ]);
  });

  it("records explicit omissions instead of silently truncating context", async () => {
    const input = await briefInput();
    const brief = compileBrief({ ...input, contextLimitTokens: 100 });

    expect(brief.omissions.length).toBeGreaterThan(0);
    expect(brief.content).toContain("Explicit Omissions");
    expect(brief.content).toContain(
      "constraints were preserved without truncation",
    );
    expect(brief.estimatedTokens).toBeGreaterThan(brief.budgetTokens);
  });
});
