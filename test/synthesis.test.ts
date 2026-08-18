import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPlanningConsultations } from "../src/consultation.js";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import {
  answerPlanningQuestionnaire,
  PlanningStore,
  runPlanningQuestionnaire,
  type PlanningSessionLauncher,
} from "../src/planning.js";
import { loadSandboxPolicy } from "../src/policy.js";
import { loadProject } from "../src/project.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type ReadSessionOpenShell,
} from "../src/seat.js";
import { ProjectStore, writeJsonAtomic } from "../src/state.js";
import {
  parsePlanSynthesisOutput,
  parsePlanningCritique,
  runPlanSynthesis,
} from "../src/synthesis.js";
import { commitFixture, createFixtureProject } from "./fixture.js";

const roots: string[] = [];
const requiredVersion = "0.0.106";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function localConfig(): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    openshell: {
      command: "openshell",
      required_version: requiredVersion,
      workspace: "default",
      gateways: {
        plan: "plan-gateway",
        quant: "quant-gateway",
        review: "review-gateway",
      },
    },
    models: {
      plan: {
        gateway: "plan",
        pi_model: "fixture-planner",
        api: "openai-responses",
        locality: "remote",
        context_window: 100_000,
        max_tokens: 8_192,
        reasoning: true,
      },
      quant: {
        gateway: "quant",
        pi_model: "fixture-quant",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 100_000,
        max_tokens: 8_192,
        reasoning: true,
      },
      review: {
        gateway: "review",
        pi_model: "fixture-reviewer",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 100_000,
        max_tokens: 8_192,
        reasoning: true,
      },
    },
  });
}

function preflight(gateway: string): OpenShellPreflight {
  return {
    command: "openshell",
    requiredVersion,
    installedVersion: requiredVersion,
    versionMatches: true,
    status: {
      authentication: { provider: "fixture", status: "authenticated" },
      gateway,
      server: "https://openshell.example.test",
      status: "connected",
      version: requiredVersion,
    },
  };
}

function client(gateway: string, model: string): ReadSessionOpenShell {
  const unused = (): never => {
    throw new Error("The fixture launcher owns this operation");
  };
  return {
    preflight: () => Promise.resolve(preflight(gateway)),
    getInferenceRoute: () => Promise.resolve({ provider: "fixture", model }),
    createSandbox: async () => unused(),
    waitForSandbox: async () => unused(),
    execSandbox: async (): Promise<ProcessResult> => unused(),
    startServiceForward: async (): Promise<OpenShellForward> => unused(),
    deleteSandbox: async () => unused(),
  };
}

const questionnaire = {
  version: 1 as const,
  repository: {
    summary: "A TypeScript fixture with one bounded source module.",
    current_structure: ["src/fixture.ts owns fixture behavior."],
    anchors: [
      {
        path: "src/fixture.ts",
        symbol: "fixture",
        reason: "Defines the behavior relevant to the goal.",
      },
    ],
  },
  questions: [
    {
      id: "compatibility-policy",
      scope: "run" as const,
      question: "How strictly should compatibility be preserved?",
      why: "The repository cannot determine migration policy.",
      options: [
        {
          id: "strict",
          label: "Preserve behavior",
          tradeoff: "Constrains the design.",
        },
        {
          id: "clean-break",
          label: "Permit a break",
          tradeoff: "Requires migration.",
        },
      ],
      recommendation: "strict",
      allow_free_form: true as const,
    },
  ],
  assumptions: ["The committed checkout is authoritative."],
};

const architectureOutput = {
  version: 1 as const,
  role: "architecture" as const,
  conclusion: "Preserve behavior through one narrow fixture boundary.",
  current_constraints: ["src/fixture.ts owns current behavior."],
  alternatives: [
    {
      kind: "conservative" as const,
      summary: "Add one local boundary.",
      tradeoffs: ["Keeps migration risk low."],
    },
    {
      kind: "target" as const,
      summary: "Separate the fixture domain.",
      tradeoffs: ["Creates more initial change."],
    },
  ],
  recommendation: "conservative" as const,
  risks: ["The boundary could become speculative."],
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Owns current behavior.",
    },
  ],
  unresolved_questions: [],
};

const quantOutput = {
  version: 1 as const,
  role: "quant" as const,
  applicability: "none" as const,
  conclusion: "The fixture has no material quantitative semantics.",
  evidence: "src/fixture.ts contains only a boolean value.",
  definitions: [],
  assumptions: [],
  analyses: [],
  risks: [],
  required_verification: ["Verify the fixture remains boolean."],
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Shows the absence of quantitative behavior.",
    },
  ],
  unresolved_questions: [],
};

const critiqueOutput = {
  version: 1 as const,
  role: "critic" as const,
  verdict: "accept" as const,
  conclusion: "The conservative recommendation satisfies the Decision.",
  strengths: ["Both specialists use the same exact source."],
  blocking_findings: [],
  tensions: [],
  improvements: ["Keep the first Task narrowly scoped."],
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Grounds the proposed boundary.",
    },
  ],
  unresolved_questions: [],
};

const reviseCritiqueOutput = {
  ...critiqueOutput,
  verdict: "revise" as const,
  blocking_findings: [
    {
      id: "protect-compatibility",
      finding: "The Plan must make compatibility preservation explicit.",
      evidence: critiqueOutput.source_anchors,
      required_correction:
        "Bind the Task acceptance criteria to compatibility.",
    },
  ],
};

const planMarkdown = `# Fixture Boundary

## Context

The fixture needs a repository-grounded boundary.

## Goal

Introduce one bounded fixture boundary while preserving behavior.

## Non-goals

Do not add a general factory or persistence layer.

## Current structure

The fixture behavior is defined in one source module.

## Proposed direction

Introduce only the smallest local boundary.

## Architecture

Keep the existing module authoritative and avoid speculative abstractions.

## Quantitative implications

No material quantitative semantics are affected.

## Risks

The boundary could expand beyond the approved scope.

## Open questions

None.
`;

const planOutput = {
  version: 1 as const,
  role: "lead" as const,
  plan_id: "fixture-boundary",
  revision: 1,
  plan_markdown: planMarkdown,
  tasks: [
    {
      id: "introduce-fixture-boundary",
      title: "Introduce the fixture boundary",
      role: "implementer",
      goal: "Introduce one local boundary while preserving fixture behavior.",
      depends: [],
      scope: ["src/**"],
      non_goals: ["Add a generic factory."],
      acceptance: ["The existing fixture behavior remains unchanged."],
      checks: ["project-test"],
      reviews: ["spec", "architecture", "quality"],
    },
  ],
  critique_resolutions: [],
  synthesis_summary: "Selected the conservative repository-grounded design.",
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Defines the bounded implementation scope.",
    },
  ],
};

const resolvedPlanOutput = {
  ...planOutput,
  critique_resolutions: [
    {
      finding: "protect-compatibility",
      resolution: "The Task acceptance criteria require unchanged behavior.",
    },
  ],
};

interface LaunchRecord {
  readonly seat: string;
  readonly session: string;
  readonly brief: string;
  readonly model: string;
}

function launcher(input: {
  readonly response: (seat: string, session: string) => string;
  readonly launches?: LaunchRecord[];
}): PlanningSessionLauncher {
  return async (options) => {
    if (!options.model || !options.brief || !options.snapshot) {
      throw new Error("Fixture Session lacks exact model inputs");
    }
    const seat = options.identity.seat;
    const session = options.identity.session;
    input.launches?.push({
      seat,
      session,
      brief: options.brief.content,
      model: options.model.pi_model,
    });
    const policy = await loadSandboxPolicy(
      "read",
      path.join(options.policyDirectory!, "read.yaml"),
    );
    const suffix = String((input.launches?.length ?? 0) + 1).padStart(12, "0");
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-18 18:00:00",
      current_policy_version: 1,
      id: `00000000-0000-4000-8000-${suffix}`,
      labels: {},
      name: `pio-${seat}`,
      phase: "Ready",
      resource_version: 1,
      workspace: "planning",
    };
    const model = options.model;
    return {
      info: {
        sandbox,
        identity: options.identity,
        sourceDigest: options.snapshot.manifest.source_digest,
        profile: "read",
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight(model.gateway),
        piVersion: PI_RUNTIME_VERSION,
        clientVersion: PI_CLIENT_VERSION,
        model,
        inference: { provider: "fixture", model: model.pi_model },
        briefDigest: options.brief.digest,
        inputs: [],
      },
      run: async (message) => ({
        message_ids: [message.id],
        model_alias: model.alias,
        requested_model: model.pi_model,
        response_model: model.pi_model,
        stop_reason: "stop",
        text: input.response(seat, session),
        truncated: false,
        usage: { input: 100, output: 50 },
      }),
      stop: () => Promise.resolve(),
    };
  };
}

async function consultedFixture() {
  const root = await createFixtureProject();
  roots.push(root);
  await commitFixture(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "synthesis-state-"));
  roots.push(home);
  const project = await loadProject(root);
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: root,
  });
  await runPlanningQuestionnaire({
    store,
    project,
    local: localConfig(),
    client: client("plan-gateway", "fixture-planner"),
    goal: "Introduce a bounded fixture boundary",
    planningId: "fixture-planning",
    nonce: () => "00000001",
    now: () => new Date("2026-08-18T18:00:00.000Z"),
    launchSession: launcher({
      response: () => JSON.stringify(questionnaire),
    }),
  });
  await answerPlanningQuestionnaire({
    store,
    project,
    planningId: "fixture-planning",
    answers: { "compatibility-policy": "strict" },
    acceptedBy: "tester",
    now: new Date("2026-08-18T18:05:00.000Z"),
  });
  await runPlanningConsultations({
    store,
    project,
    local: localConfig(),
    clients: {
      architecture: client("plan-gateway", "fixture-planner"),
      quant: client("quant-gateway", "fixture-quant"),
    },
    planningId: "fixture-planning",
    nonce: (role) => (role === "architecture" ? "00000002" : "00000003"),
    now: () => new Date("2026-08-18T18:10:00.000Z"),
    launchSession: launcher({
      response: (seat) =>
        JSON.stringify(seat === "architect" ? architectureOutput : quantOutput),
    }),
  });
  return { root, home, project, store };
}

const synthesisClients = {
  critic: client("review-gateway", "fixture-reviewer"),
  lead: client("plan-gateway", "fixture-planner"),
};

describe("planning critique and synthesis", () => {
  it("validates independent outputs and exact source anchors", () => {
    expect(
      parsePlanningCritique(
        JSON.stringify(critiqueOutput),
        new Set(["src/fixture.ts"]),
      ),
    ).toEqual(critiqueOutput);
    expect(
      parsePlanSynthesisOutput(
        JSON.stringify(planOutput),
        new Set(["src/fixture.ts"]),
      ),
    ).toMatchObject({ plan_id: "fixture-boundary", revision: 1 });
    expect(() =>
      parsePlanSynthesisOutput(
        JSON.stringify({
          ...planOutput,
          source_anchors: [
            { path: "src/invented.ts", reason: "Fabricated evidence." },
          ],
        }),
        new Set(["src/fixture.ts"]),
      ),
    ).toThrow("absent from the exact source snapshot");
    expect(() =>
      parsePlanningCritique(
        JSON.stringify({
          ...critiqueOutput,
          blocking_findings: [
            {
              id: "unresolved-risk",
              finding: "A material risk remains unresolved.",
              evidence: critiqueOutput.source_anchors,
              required_correction: "Resolve the risk in the Plan.",
            },
          ],
        }),
      ),
    ).toThrow("accept requires no blocking findings");
  });

  it("runs a fresh critic and Lead, persists a validated draft, and reuses it", async () => {
    const context = await consultedFixture();
    const launches: LaunchRecord[] = [];
    try {
      const first = await runPlanSynthesis({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: synthesisClients,
        planningId: "fixture-planning",
        nonce: (stage) => (stage === "critique" ? "00000004" : "00000005"),
        now: () => new Date("2026-08-18T18:15:00.000Z"),
        launchSession: launcher({
          response: (seat) =>
            JSON.stringify(seat === "critic" ? critiqueOutput : planOutput),
          launches,
        }),
      });
      expect(first.state.status).toBe("drafted");
      expect(first.critique.reused).toBe(false);
      expect(first.synthesis.reused).toBe(false);
      expect(launches.map(({ seat, model }) => [seat, model])).toEqual([
        ["critic", "fixture-reviewer"],
        ["lead", "fixture-planner"],
      ]);
      expect(launches[0]?.brief).toContain(architectureOutput.conclusion);
      expect(launches[0]?.brief).toContain(quantOutput.conclusion);
      expect(launches[0]?.brief).not.toContain(critiqueOutput.conclusion);
      expect(launches[1]?.brief).toContain(critiqueOutput.conclusion);
      expect(launches[1]?.brief).toContain("project-test");

      const loaded = await loadPlan(
        first.synthesis.directory,
        catalogFromConfig(context.project.config),
      );
      expect(loaded).toMatchObject({
        id: "fixture-boundary",
        revision: 1,
        digest: first.synthesis.plan.digest,
      });
      await expect(
        access(path.join(context.root, "docs", "plans", "fixture-boundary")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(
          path.join(first.synthesis.directory, "..", "manifest.json"),
          "utf8",
        ),
      ).toContain(first.synthesis.plan.digest);

      await writeJsonAtomic(
        path.join(
          context.store.planningDirectory("fixture-planning"),
          "state.json",
        ),
        {
          ...first.state,
          status: "synthesizing",
          synthesis: {
            ...first.state.synthesis,
            record_digest: null,
            report_digest: null,
            plan_digest: null,
          },
        },
      );

      const second = await runPlanSynthesis({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: synthesisClients,
        planningId: "fixture-planning",
        launchSession: async () => {
          throw new Error("Completed synthesis must not relaunch");
        },
      });
      expect(second.state.status).toBe("drafted");
      expect(second.critique.reused).toBe(true);
      expect(second.synthesis.reused).toBe(true);
    } finally {
      await context.store.close();
    }
  });

  it("preserves a frozen critique and retries only invalid Lead synthesis", async () => {
    const context = await consultedFixture();
    try {
      await expect(
        runPlanSynthesis({
          store: context.store,
          project: context.project,
          local: localConfig(),
          clients: synthesisClients,
          planningId: "fixture-planning",
          nonce: (stage) => (stage === "critique" ? "00000006" : "00000007"),
          launchSession: launcher({
            response: (seat) =>
              seat === "critic" ? JSON.stringify(critiqueOutput) : "{}",
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_planning_stage_output" });
      expect(
        await new PlanningStore(context.store).get("fixture-planning"),
      ).toMatchObject({
        status: "synthesizing",
        critique: { attempts: 1, record_digest: expect.any(String) },
        synthesis: { attempts: 1, record_digest: null },
      });

      const launches: LaunchRecord[] = [];
      const recovered = await runPlanSynthesis({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: synthesisClients,
        planningId: "fixture-planning",
        nonce: () => "00000008",
        launchSession: launcher({
          response: () => JSON.stringify(planOutput),
          launches,
        }),
      });
      expect(recovered.critique.reused).toBe(true);
      expect(recovered.synthesis).toMatchObject({
        reused: false,
        request: { attempt: 2 },
      });
      expect(launches.map(({ seat }) => seat)).toEqual(["lead"]);
    } finally {
      await context.store.close();
    }
  });

  it("requires critic resolutions and mandatory Reviews, then detects draft tampering", async () => {
    const invalid = await consultedFixture();
    try {
      await expect(
        runPlanSynthesis({
          store: invalid.store,
          project: invalid.project,
          local: localConfig(),
          clients: synthesisClients,
          planningId: "fixture-planning",
          nonce: () => "00000009",
          launchSession: launcher({
            response: (seat) =>
              JSON.stringify(
                seat === "critic" ? reviseCritiqueOutput : planOutput,
              ),
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_plan_synthesis" });

      await expect(
        runPlanSynthesis({
          store: invalid.store,
          project: invalid.project,
          local: localConfig(),
          clients: synthesisClients,
          planningId: "fixture-planning",
          nonce: () => "0000000b",
          launchSession: launcher({
            response: () =>
              JSON.stringify({
                ...resolvedPlanOutput,
                tasks: [
                  {
                    ...resolvedPlanOutput.tasks[0],
                    reviews: ["spec", "quality"],
                  },
                ],
              }),
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_plan_synthesis" });

      const corrected = await runPlanSynthesis({
        store: invalid.store,
        project: invalid.project,
        local: localConfig(),
        clients: synthesisClients,
        planningId: "fixture-planning",
        nonce: () => "0000000c",
        launchSession: launcher({
          response: () => JSON.stringify(resolvedPlanOutput),
        }),
      });
      expect(corrected).toMatchObject({
        state: { status: "drafted" },
        critique: { reused: true },
        synthesis: { request: { attempt: 3 }, reused: false },
      });
    } finally {
      await invalid.store.close();
    }

    const tampered = await consultedFixture();
    try {
      const completed = await runPlanSynthesis({
        store: tampered.store,
        project: tampered.project,
        local: localConfig(),
        clients: synthesisClients,
        planningId: "fixture-planning",
        nonce: () => "0000000a",
        launchSession: launcher({
          response: (seat) =>
            JSON.stringify(seat === "critic" ? critiqueOutput : planOutput),
        }),
      });
      await writeFile(
        path.join(completed.synthesis.directory, "plan.md"),
        `${planMarkdown}\nTampered.\n`,
        "utf8",
      );
      await expect(
        runPlanSynthesis({
          store: tampered.store,
          project: tampered.project,
          local: localConfig(),
          clients: synthesisClients,
          planningId: "fixture-planning",
          launchSession: async () => {
            throw new Error("Tamper detection must precede relaunch");
          },
        }),
      ).rejects.toMatchObject({ code: "plan_draft_conflict" });
    } finally {
      await tampered.store.close();
    }
  });
});
