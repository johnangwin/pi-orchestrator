import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import {
  answerPlanningQuestionnaire,
  parsePlanningQuestionnaire,
  planningDecisions,
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
import { commitFixture, createFixtureProject } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const requiredVersion = "0.0.106";

function localConfig(): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    openshell: {
      command: "openshell",
      required_version: requiredVersion,
      workspace: "default",
      gateways: { plan: "plan-gateway" },
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
    },
  });
}

function preflight(): OpenShellPreflight {
  return {
    command: "openshell",
    requiredVersion,
    installedVersion: requiredVersion,
    versionMatches: true,
    status: {
      authentication: { provider: "fixture", status: "authenticated" },
      gateway: "plan-gateway",
      server: "https://openshell.example.test",
      status: "connected",
      version: requiredVersion,
    },
  };
}

function client(): ReadSessionOpenShell {
  const unused = (): never => {
    throw new Error("The fixture planning launcher owns this operation");
  };
  return {
    preflight: () => Promise.resolve(preflight()),
    getInferenceRoute: () =>
      Promise.resolve({ provider: "fixture", model: "fixture-planner" }),
    createSandbox: async () => unused(),
    waitForSandbox: async () => unused(),
    execSandbox: async (): Promise<ProcessResult> => unused(),
    startServiceForward: async (): Promise<OpenShellForward> => unused(),
    deleteSandbox: async () => unused(),
  };
}

function questionnaire() {
  return {
    version: 1 as const,
    repository: {
      summary: "A small TypeScript fixture with one bounded source module.",
      current_structure: [
        "src/fixture.ts owns the current fixture behavior.",
        "Registered verification uses the Project configuration.",
      ],
      anchors: [
        {
          path: "src/fixture.ts",
          symbol: "fixture",
          reason: "Defines the current behavior relevant to the goal.",
        },
      ],
    },
    questions: [
      {
        id: "compatibility-policy",
        scope: "run" as const,
        question: "How strictly should the change preserve compatibility?",
        why: "The repository cannot determine the intended migration policy.",
        options: [
          {
            id: "strict",
            label: "Preserve all behavior",
            tradeoff: "Minimizes migration risk but constrains the design.",
          },
          {
            id: "clean-break",
            label: "Permit a clean break",
            tradeoff: "Simplifies the design but requires migration work.",
          },
        ],
        recommendation: "strict",
        allow_free_form: true as const,
      },
    ],
    assumptions: ["The committed checkout is the planning source of truth."],
  };
}

function launcher(
  response = JSON.stringify(questionnaire()),
  onLaunch?: (brief: string) => void,
  beforeResponse?: () => void | Promise<void>,
): PlanningSessionLauncher {
  return async (options) => {
    if (!options.model || !options.brief || !options.snapshot) {
      throw new Error("Fixture planning Session lacks exact inputs");
    }
    onLaunch?.(options.brief.content);
    const policy = await loadSandboxPolicy(
      "read",
      path.join(options.policyDirectory!, "read.yaml"),
    );
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-18 18:00:00",
      current_policy_version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      labels: {},
      name: "pio-plan-fixture",
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
        openshell: preflight(),
        piVersion: PI_RUNTIME_VERSION,
        clientVersion: PI_CLIENT_VERSION,
        model,
        inference: { provider: "fixture", model: model.pi_model },
        briefDigest: options.brief.digest,
        inputs: [],
      },
      run: async (message) => {
        await beforeResponse?.();
        return {
          message_ids: [message.id],
          model_alias: model.alias,
          requested_model: model.pi_model,
          response_model: model.pi_model,
          stop_reason: "stop",
          text: response,
          truncated: false,
          usage: { input: 100, output: 50 },
        };
      },
      stop: () => Promise.resolve(),
    };
  };
}

async function fixture() {
  const root = await createFixtureProject();
  roots.push(root);
  await commitFixture(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "planning-state-"));
  roots.push(home);
  const project = await loadProject(root);
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: root,
  });
  return { root, project, store };
}

describe("planning questionnaire", () => {
  it("requires bounded structured choices and real source anchors", () => {
    expect(
      parsePlanningQuestionnaire(
        `\`\`\`json\n${JSON.stringify(questionnaire())}\n\`\`\``,
        new Set(["src/fixture.ts"]),
      ),
    ).toEqual(questionnaire());

    const tooMany = {
      ...questionnaire(),
      questions: Array.from({ length: 6 }, (_, index) => ({
        ...questionnaire().questions[0]!,
        id: `question-${index}`,
      })),
    };
    expect(() => parsePlanningQuestionnaire(JSON.stringify(tooMany))).toThrow(
      "Too big",
    );
    expect(() =>
      parsePlanningQuestionnaire(
        JSON.stringify({
          ...questionnaire(),
          repository: {
            ...questionnaire().repository,
            anchors: [
              {
                path: "src/invented.ts",
                reason: "Fabricated evidence.",
              },
            ],
          },
        }),
        new Set(["src/fixture.ts"]),
      ),
    ).toThrow("absent from the exact source snapshot");
  });

  it("binds repository inspection to a read-only Session and persists human Decisions", async () => {
    const context = await fixture();
    let launches = 0;
    try {
      const first = await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Introduce a bounded fixture boundary",
        planningId: "fixture-planning",
        nonce: () => "00000001",
        now: () => new Date("2026-08-18T18:00:00.000Z"),
        launchSession: launcher(undefined, (brief) => {
          launches += 1;
          expect(brief).toContain("Introduce a bounded fixture boundary");
          expect(brief).toContain("mounted read-only");
          expect(brief).toContain("Inspect /workspace/project");
        }),
      });
      expect(first.state.status).toBe("awaiting-answers");
      expect(first.state.source_entries).toBeGreaterThan(0);
      expect(first.record.questionnaire.questions).toHaveLength(1);
      expect(first.record.identity).toMatchObject({
        run: "fixture-planning",
        seat: "lead",
        epoch: 1,
      });
      expect(first.reused).toBe(false);

      const second = await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Introduce a bounded fixture boundary",
        planningId: "fixture-planning",
        nonce: () => "00000002",
        launchSession: launcher(undefined, () => {
          launches += 1;
        }),
      });
      expect(second.reused).toBe(true);
      expect(second.record.record_digest).toBe(first.record.record_digest);
      expect(launches).toBe(1);

      const accepted = await answerPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        planningId: "fixture-planning",
        answers: { "compatibility-policy": "strict" },
        acceptedBy: "tester",
        now: new Date("2026-08-18T18:05:00.000Z"),
      });
      expect(accepted.state.status).toBe("answered");
      expect(accepted.decisions).toHaveLength(1);
      expect(accepted.decisions[0]).toMatchObject({
        accepted_by: "tester",
        answer: {
          question: "compatibility-policy",
          kind: "option",
          option: "strict",
          value: "Preserve all behavior",
        },
        decision: { scope: "run" },
      });
      expect(
        await planningDecisions(context.store, "fixture-planning"),
      ).toEqual(accepted.decisions.map((record) => record.decision));

      await writeJsonAtomic(
        path.join(
          context.store.planningDirectory("fixture-planning"),
          "state.json",
        ),
        {
          ...accepted.state,
          status: "awaiting-answers",
          decisions: {},
        },
      );
      const retried = await answerPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        planningId: "fixture-planning",
        answers: { "compatibility-policy": "strict" },
        acceptedBy: "tester",
      });
      expect(retried.reused).toBe(true);
      expect(retried.decisions[0]?.record_digest).toBe(
        accepted.decisions[0]?.record_digest,
      );
      await expect(
        answerPlanningQuestionnaire({
          store: context.store,
          project: context.project,
          planningId: "fixture-planning",
          answers: { "compatibility-policy": "clean-break" },
          acceptedBy: "tester",
        }),
      ).rejects.toMatchObject({ code: "planning_decision_conflict" });

      const listed = await new PlanningStore(context.store).list();
      expect(listed).toMatchObject([
        { id: "fixture-planning", status: "answered", attempts: 1 },
      ]);
    } finally {
      await context.store.close();
    }
  });

  it("accepts explicit free-form answers but requires every material answer", async () => {
    const context = await fixture();
    try {
      await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Plan a free-form fixture change",
        planningId: "free-form-planning",
        nonce: () => "00000003",
        launchSession: launcher(),
      });
      await expect(
        answerPlanningQuestionnaire({
          store: context.store,
          project: context.project,
          planningId: "free-form-planning",
          answers: {},
          acceptedBy: "tester",
        }),
      ).rejects.toMatchObject({ code: "invalid_planning_answers" });
      const result = await answerPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        planningId: "free-form-planning",
        answers: {
          "compatibility-policy": "Preserve public behavior, not file layout.",
        },
        acceptedBy: "tester",
      });
      expect(result.decisions[0]?.answer).toMatchObject({
        kind: "free-form",
        option: null,
        value: "Preserve public behavior, not file layout.",
      });
    } finally {
      await context.store.close();
    }
  });

  it("adopts an exact attempt prepared before an interrupted state update", async () => {
    const context = await fixture();
    try {
      const first = await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Recover prepared planning evidence",
        planningId: "prepared-planning",
        nonce: () => "00000006",
        now: () => new Date("2026-08-18T18:10:00.000Z"),
        launchSession: launcher(),
      });
      const directory = context.store.planningDirectory("prepared-planning");
      await rm(path.join(directory, "attempts", "1", "questionnaire.json"));
      await writeJsonAtomic(path.join(directory, "state.json"), {
        ...first.state,
        status: "drafting",
        attempts: 0,
        current_request_digest: null,
        questionnaire_digest: null,
        decisions: {},
      });

      const recovered = await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Recover prepared planning evidence",
        planningId: "prepared-planning",
        nonce: () => {
          throw new Error("An exact prepared attempt must retain its nonce");
        },
        now: () => new Date("2026-08-18T18:11:00.000Z"),
        launchSession: launcher(),
      });
      expect(recovered.request.request_digest).toBe(
        first.request.request_digest,
      );
      expect(recovered.request.identity).toEqual(first.request.identity);
      expect(recovered.state).toMatchObject({
        status: "awaiting-answers",
        attempts: 1,
      });
    } finally {
      await context.store.close();
    }
  });

  it("refuses to plan against uncommitted repository state", async () => {
    const context = await fixture();
    try {
      await mkdir(path.join(context.root, "notes"), { recursive: true });
      await writeFile(
        path.join(context.root, "notes", "untracked.md"),
        "draft\n",
      );
      await expect(
        runPlanningQuestionnaire({
          store: context.store,
          project: context.project,
          local: localConfig(),
          client: client(),
          goal: "Plan against an exact repository",
          planningId: "dirty-planning",
          launchSession: launcher(),
        }),
      ).rejects.toMatchObject({ code: "dirty_project" });
    } finally {
      await context.store.close();
    }
  });

  it("rejects repository changes made during the planning turn", async () => {
    const context = await fixture();
    try {
      await expect(
        runPlanningQuestionnaire({
          store: context.store,
          project: context.project,
          local: localConfig(),
          client: client(),
          goal: "Keep planning evidence fresh",
          planningId: "stale-planning",
          nonce: () => "00000005",
          launchSession: launcher(undefined, undefined, () =>
            writeFile(
              path.join(context.root, "src", "fixture.ts"),
              "export const fixture = false;\n",
            ),
          ),
        }),
      ).rejects.toMatchObject({ code: "dirty_project" });
      expect(
        (await new PlanningStore(context.store).get("stale-planning")).status,
      ).toBe("drafting");
    } finally {
      await context.store.close();
    }
  });

  it("does not let ambient Git variables redirect repository inspection", async () => {
    const context = await fixture();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(context.root, "missing-git-directory");
    try {
      const result = await runPlanningQuestionnaire({
        store: context.store,
        project: context.project,
        local: localConfig(),
        client: client(),
        goal: "Inspect the intended repository",
        planningId: "ambient-git-planning",
        nonce: () => "00000004",
        launchSession: launcher(),
      });
      expect(result.state.base_commit).toBe(result.request.base_commit);
      expect(result.state.status).toBe("awaiting-answers");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      await context.store.close();
    }
  });
});
