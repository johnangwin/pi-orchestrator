import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseConsultationOutput,
  runPlanningConsultations,
} from "../src/consultation.js";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
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
} from "../src/agent.js";
import { ProjectStore } from "../src/state.js";
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
    version: 2,
    openshell: {
      command: "openshell",
      required_version: requiredVersion,
      workspace: "default",
      gateways: { plan: "plan-gateway", quant: "quant-gateway" },
    },
    models: {
      "frontier-lead": {
        gateway: "plan",
        pi_model: "fixture-planner",
        api: "openai-responses",
        locality: "remote",
        context_window: 100_000,
        max_tokens: 8_192,
        reasoning: true,
      },
      "local-quant": {
        gateway: "quant",
        pi_model: "fixture-quant",
        api: "openai-responses",
        locality: "local",
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
  conclusion: "Preserve the current boundary and introduce one narrow seam.",
  current_constraints: ["src/fixture.ts owns the current behavior."],
  alternatives: [
    {
      kind: "conservative" as const,
      summary: "Add one local boundary.",
      tradeoffs: ["Keeps migration risk low."],
    },
    {
      kind: "target" as const,
      summary: "Separate the complete fixture domain.",
      tradeoffs: ["Creates a cleaner direction with more initial change."],
    },
  ],
  recommendation: "conservative" as const,
  risks: ["The new boundary could become speculative."],
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Owns the current behavior.",
    },
  ],
  unresolved_questions: [],
};

const quantOutput = {
  version: 1 as const,
  role: "quant" as const,
  applicability: "none" as const,
  conclusion: "The fixture change has no material quantitative semantics.",
  evidence: "src/fixture.ts contains only a boolean fixture value.",
  definitions: [],
  assumptions: [],
  analyses: [],
  risks: [],
  required_verification: [
    "Verify the fixture remains boolean and no numeric contract is added.",
  ],
  source_anchors: [
    {
      path: "src/fixture.ts",
      symbol: "fixture",
      reason: "Shows the absence of quantitative behavior.",
    },
  ],
  unresolved_questions: [],
};

function launcher(input: {
  readonly responses: Readonly<Record<string, string>>;
  readonly launches?: Array<{ agent: string; brief: string; model: string }>;
}): PlanningSessionLauncher {
  return async (options) => {
    if (!options.model || !options.brief || !options.snapshot) {
      throw new Error("Fixture Session lacks exact model inputs");
    }
    const agent = options.identity.agent;
    input.launches?.push({
      agent,
      brief: options.brief.content,
      model: options.model.pi_model,
    });
    const policy = await loadSandboxPolicy(
      "read",
      path.join(options.policyDirectory!, "read.yaml"),
    );
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-18 18:00:00",
      current_policy_version: 1,
      id:
        agent === "architect"
          ? "00000000-0000-4000-8000-000000000002"
          : agent === "quant"
            ? "00000000-0000-4000-8000-000000000003"
            : "00000000-0000-4000-8000-000000000001",
      labels: {},
      name: `pio-${agent}`,
      phase: "Ready",
      resource_version: 1,
      workspace: "planning",
    };
    const model = options.model;
    return {
      info: {
        sandbox,
        permissionCeiling: options.permissionCeiling,
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
        model_profile: model.profile,
        requested_model: model.pi_model,
        response_model: model.pi_model,
        stop_reason: "stop",
        text: input.responses[agent] ?? "{}",
        truncated: false,
        usage: { input: 100, output: 50 },
      }),
      stop: () => Promise.resolve(),
    };
  };
}

async function planningFixture(answer = true) {
  const root = await createFixtureProject();
  roots.push(root);
  await commitFixture(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "consultation-state-"));
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
      responses: { lead: JSON.stringify(questionnaire) },
    }),
  });
  if (answer) {
    await answerPlanningQuestionnaire({
      store,
      project,
      planningId: "fixture-planning",
      answers: { "compatibility-policy": "strict" },
      acceptedBy: "tester",
      now: new Date("2026-08-18T18:05:00.000Z"),
    });
  }
  return { root, home, project, store };
}

describe("planning consultation", () => {
  it("validates role-specific structured evidence and exact source anchors", () => {
    expect(
      parseConsultationOutput(
        "architecture",
        JSON.stringify(architectureOutput),
        new Set(["src/fixture.ts"]),
      ),
    ).toEqual(architectureOutput);
    expect(
      parseConsultationOutput(
        "quant",
        `\`\`\`json\n${JSON.stringify(quantOutput)}\n\`\`\``,
        new Set(["src/fixture.ts"]),
      ),
    ).toEqual(quantOutput);
    expect(() =>
      parseConsultationOutput(
        "quant",
        JSON.stringify({
          ...quantOutput,
          source_anchors: [
            { path: "src/invented.ts", reason: "Fabricated evidence." },
          ],
        }),
        new Set(["src/fixture.ts"]),
      ),
    ).toThrow("absent from the exact source snapshot");
  });

  it("runs independent Architecture and Quant Sessions and reuses exact Reports", async () => {
    const context = await planningFixture();
    const launches: Array<{ agent: string; brief: string; model: string }> = [];
    try {
      const first = await runPlanningConsultations({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: {
          architecture: client("plan-gateway", "fixture-planner"),
          quant: client("quant-gateway", "fixture-quant"),
        },
        planningId: "fixture-planning",
        nonce: (role) => (role === "architecture" ? "00000002" : "00000003"),
        now: () => new Date("2026-08-18T18:10:00.000Z"),
        launchSession: launcher({
          responses: {
            architect: JSON.stringify(architectureOutput),
            quant: JSON.stringify(quantOutput),
          },
          launches,
        }),
      });
      expect(first.state.status).toBe("consulted");
      expect(first.consultations.map((item) => item.role)).toEqual([
        "architecture",
        "quant",
      ]);
      expect(first.consultations.every((item) => !item.reused)).toBe(true);
      expect(launches.map((item) => [item.agent, item.model])).toEqual([
        ["architect", "fixture-planner"],
        ["quant", "fixture-quant"],
      ]);
      expect(launches[0]?.brief).toContain("Preserve behavior");
      expect(launches[0]?.brief).not.toContain(quantOutput.conclusion);
      expect(launches[1]?.brief).toContain("Preserve behavior");
      expect(launches[1]?.brief).not.toContain(architectureOutput.conclusion);
      expect(
        await readFile(
          path.join(
            context.store.planningDirectory("fixture-planning"),
            "reports",
            "architecture-consultation.json",
          ),
          "utf8",
        ),
      ).toContain("Current Constraints");

      const second = await runPlanningConsultations({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: {
          architecture: client("plan-gateway", "fixture-planner"),
          quant: client("quant-gateway", "fixture-quant"),
        },
        planningId: "fixture-planning",
        launchSession: async () => {
          throw new Error("Completed consultation must not relaunch");
        },
      });
      expect(second.state.status).toBe("consulted");
      expect(second.consultations.every((item) => item.reused)).toBe(true);
      expect(launches).toHaveLength(2);
    } finally {
      await context.store.close();
    }
  });

  it("preserves a completed Architecture Report when Quant needs a fresh attempt", async () => {
    const context = await planningFixture();
    try {
      await expect(
        runPlanningConsultations({
          store: context.store,
          project: context.project,
          local: localConfig(),
          clients: {
            architecture: client("plan-gateway", "fixture-planner"),
            quant: client("quant-gateway", "fixture-quant"),
          },
          planningId: "fixture-planning",
          nonce: (role) => (role === "architecture" ? "00000004" : "00000005"),
          launchSession: launcher({
            responses: {
              architect: JSON.stringify(architectureOutput),
              quant: "{}",
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_consultation_output" });
      const partial = await new PlanningStore(context.store).get(
        "fixture-planning",
      );
      expect(partial).toMatchObject({
        status: "consulting",
        consultations: {
          architecture: { attempts: 1 },
          quant: { attempts: 1, record_digest: null },
        },
      });

      const launches: Array<{ agent: string; brief: string; model: string }> =
        [];
      const recovered = await runPlanningConsultations({
        store: context.store,
        project: context.project,
        local: localConfig(),
        clients: {
          architecture: client("plan-gateway", "fixture-planner"),
          quant: client("quant-gateway", "fixture-quant"),
        },
        planningId: "fixture-planning",
        nonce: () => "00000006",
        launchSession: launcher({
          responses: { quant: JSON.stringify(quantOutput) },
          launches,
        }),
      });
      expect(recovered.state.status).toBe("consulted");
      expect(recovered.consultations[0]).toMatchObject({
        role: "architecture",
        reused: true,
      });
      expect(recovered.consultations[1]).toMatchObject({
        role: "quant",
        reused: false,
        request: { attempt: 2 },
      });
      expect(launches.map((item) => item.agent)).toEqual(["quant"]);
    } finally {
      await context.store.close();
    }
  });

  it("rejects consultation before questionnaire answers", async () => {
    const context = await planningFixture(false);
    try {
      await expect(
        runPlanningConsultations({
          store: context.store,
          project: context.project,
          local: localConfig(),
          clients: {
            architecture: client("plan-gateway", "fixture-planner"),
            quant: client("quant-gateway", "fixture-quant"),
          },
          planningId: "fixture-planning",
          launchSession: launcher({ responses: {} }),
        }),
      ).rejects.toMatchObject({ code: "planning_not_answered" });
    } finally {
      await context.store.close();
    }
  });

  it("rejects consultation after repository changes", async () => {
    const context = await planningFixture();
    try {
      await writeFile(
        path.join(context.root, "src", "fixture.ts"),
        "export const fixture = false;\n",
        "utf8",
      );
      await expect(
        runPlanningConsultations({
          store: context.store,
          project: context.project,
          local: localConfig(),
          clients: {
            architecture: client("plan-gateway", "fixture-planner"),
            quant: client("quant-gateway", "fixture-quant"),
          },
          planningId: "fixture-planning",
          launchSession: launcher({ responses: {} }),
        }),
      ).rejects.toMatchObject({ code: "dirty_project" });
    } finally {
      await context.store.close();
    }
  });
});
