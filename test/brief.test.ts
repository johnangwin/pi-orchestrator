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
import { createFixtureProject, createPlan } from "./fixture.js";

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
  const dependency = createReport({
    id: "report-dependency",
    kind: "consultation",
    run: "run-001",
    seat: "architect",
    session: "session-001",
    epoch: 1,
    task: "bounded-change",
    content: "# Conclusion\nKeep the current boundary.",
    created_at: new Date().toISOString(),
  });

  return {
    identity: {
      run: "run-001",
      seat: "implementer",
      session: "session-002",
      epoch: 2,
    },
    agents: project.agents,
    role,
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

  it("marks a Brief stale when source or epoch identity changes", async () => {
    const input = await briefInput();
    const previous = compileBrief(input).binding;
    const current = compileBrief({
      ...input,
      identity: { ...input.identity, epoch: input.identity.epoch + 1 },
      sourceDigests: { "src/fixture.ts": sha256("changed") },
    }).binding;

    expect(briefStaleReasons(previous, current)).toEqual([
      "source digest changed",
      "Session identity or epoch changed",
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
