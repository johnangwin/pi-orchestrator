import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApproval } from "../src/approval.js";
import type { ImportedArtifact } from "../src/artifact.js";
import { sha256 } from "../src/digest.js";
import {
  parseImplementationAssessment,
  runImplementation,
  type ImplementationOpenShell,
  type ImplementationSession,
} from "../src/implementation.js";
import { LocalConfigSchema } from "../src/local.js";
import type { OpenShellPreflight, OpenShellSandbox } from "../src/openshell.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import type { VerifiedPatch } from "../src/patch.js";
import { loadSandboxPolicy } from "../src/policy.js";
import { loadProject } from "../src/project.js";
import { startRun } from "../src/run.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type StartWriteSessionOptions,
} from "../src/agent.js";
import type { PatchApplication, ProjectStore, RunState } from "../src/state.js";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
} from "./fixture.js";

const roots: string[] = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

const local = LocalConfigSchema.parse({
  version: 2,
  openshell: {
    command: "openshell",
    required_version: "0.0.106",
    workspace: "default",
    gateways: { code: "code-gateway" },
  },
  models: {
    "local-code": {
      gateway: "code",
      pi_model: "fixture-code",
      api: "openai-completions",
      locality: "local",
      context_window: 32_768,
      max_tokens: 4_096,
      reasoning: false,
    },
  },
});

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: "0.0.106",
  installedVersion: "0.0.106",
  versionMatches: true,
  status: {
    authentication: { provider: "fixture", status: "authenticated" },
    gateway: "code-gateway",
    server: "https://openshell.example.test",
    status: "connected",
    version: "0.0.106",
  },
};

const sandbox: OpenShellSandbox = {
  annotations: {},
  created_at: "2026-08-18 18:00:00",
  current_policy_version: 1,
  id: "00000000-0000-4000-8000-000000000101",
  labels: {},
  name: "pio-impl-one",
  phase: "Ready",
  resource_version: 1,
  workspace: "default",
};

function client(): ImplementationOpenShell {
  return {
    preflight: () => Promise.resolve(preflight),
    deleteSandbox: vi.fn(() => Promise.resolve()),
  } as unknown as ImplementationOpenShell;
}

async function fixture() {
  const root = await createFixtureProject();
  roots.push(root);
  await createPlan(root);
  const commit = await commitFixture(root);
  const project = await loadProject(root);
  const plan = await loadPlan(
    path.join(root, "docs", "plans", "fixture-plan"),
    catalogFromConfig(project.config),
  );
  const home = await temporary("pi-implementation-state-");
  const worktrees = await temporary("pi-implementation-worktrees-");
  const { ProjectStore } = await import("../src/state.js");
  const store = await ProjectStore.open({
    home,
    projectId: project.config.project.id,
    projectRoot: project.root,
  });
  stores.push(store);
  await store.recordApproval(
    createApproval({
      plan,
      baseCommit: commit,
      permissionPolicyDigest: fixturePermissionPolicyDigest(project),
      routingPolicyDigest: fixtureRoutingPolicyDigest(project),
      approvedBy: "fixture",
    }),
  );
  const started = await startRun({
    store,
    project,
    plan,
    worktreeRoot: worktrees,
  });
  return { root, project, plan, store, runId: started.run.id };
}

function assessment() {
  return JSON.stringify({
    summary: "Implemented the bounded fixture change.",
    contracts_changed: [],
    behavior_changed: ["The fixture now returns the requested value."],
    checks_attempted: ["node --test passed"],
    deviations: [],
    risks: [],
    questions: [],
    downstream: [],
  });
}

function launcher(text: string) {
  return async (
    options: StartWriteSessionOptions,
  ): Promise<ImplementationSession> => {
    if (!options.model || !options.brief || !options.snapshot) {
      throw new Error("Fixture implementation Session lacks frozen inputs");
    }
    const policy = await loadSandboxPolicy(
      "write",
      path.join(options.policyDirectory!, "write.yaml"),
    );
    return {
      info: {
        sandbox,
        permissionCeiling: options.permissionCeiling,
        identity: options.identity,
        sourceDigest: options.snapshot.manifest.source_digest,
        profile: "write",
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight,
        piVersion: PI_RUNTIME_VERSION,
        clientVersion: PI_CLIENT_VERSION,
        model: options.model,
        inference: { provider: "fixture", model: options.model.pi_model },
        briefDigest: options.brief.digest,
        inputs: [],
      },
      run: (message) =>
        Promise.resolve({
          message_ids: [message.id],
          model_profile: options.model!.profile,
          requested_model: options.model!.pi_model,
          response_model: options.model!.pi_model,
          stop_reason: "stop",
          text,
          truncated: false,
          usage: { input: 100, output: 40 },
        }),
      stop: vi.fn(() => Promise.resolve()),
    };
  };
}

function importedPatch(sourceDigest: string): ImportedArtifact<VerifiedPatch> {
  return {
    record: {} as ImportedArtifact<VerifiedPatch>["record"],
    value: {
      source: {} as VerifiedPatch["source"],
      bundle: {
        version: 1,
        source_digest: sourceDigest,
        base_tree_digest: sha256("base"),
        result_tree_digest: sha256("result"),
        diff_digest: sha256("sandbox diff"),
        changes: [
          {
            path: "src/fixture.ts",
            status: "modified",
          },
        ],
        patch: {
          encoding: "base64",
          byte_count: 5,
          content_digest: sha256("patch"),
          data: "cGF0Y2g=",
        },
      } as VerifiedPatch["bundle"],
      patch: Buffer.from("patch"),
      baseEntries: [],
      resultEntries: [],
    },
  };
}

describe("implementation orchestration", () => {
  it("runs a write Session, records its Report, and advances to checking", async () => {
    const value = await fixture();
    const applyPatch = vi.fn(async (options) => {
      const current = await options.store.readRun(options.runId);
      const task = current.tasks[options.taskId]!;
      const application: PatchApplication = {
        artifact_id: "implementation-patch-00000001",
        artifact_content_digest: sha256("artifact"),
        agent: "implementer",
        session: "implementation-00000001",
        generation: 1,
        sandbox_id: sandbox.id,
        source_commit: task.input_commit!,
        source_paths: ["."],
        source_digest: options.patch.value.bundle.source_digest,
        result_source_digest: options.patch.value.bundle.result_tree_digest,
        sandbox_diff_digest: options.patch.value.bundle.diff_digest,
        changed_paths: ["src/fixture.ts"],
        state: "applied",
        host_diff_digest: sha256("host diff"),
        prepared_at: "2026-08-18T18:00:00.000Z",
        applied_at: "2026-08-18T18:00:00.000Z",
      };
      const run = await options.store.updateRun(
        options.runId,
        (state: RunState) => ({
          ...state,
          tasks: {
            ...state.tasks,
            [options.taskId]: {
              ...state.tasks[options.taskId]!,
              status: "checking",
              implementation_attempts: 1,
              input_source_digest: application.source_digest,
              output_source_digest: application.result_source_digest,
              diff_digest: application.host_diff_digest,
              patch_application: application,
            },
          },
        }),
      );
      return {
        run,
        task: run.tasks[options.taskId]!,
        application,
        created: true,
        recovered: false,
      };
    });

    const result = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      client: client(),
      launchSession: launcher(assessment()),
      exportPatch: async (options) =>
        importedPatch(options.snapshot.manifest.source_digest),
      applyPatch,
      nonce: () => "00000001",
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    });

    expect(result).toMatchObject({
      reused: false,
      task: { status: "checking", implementation_attempts: 1 },
      report: {
        kind: "implementation",
        task: "bounded-change",
        session: "implementation-00000001",
      },
    });
    expect(result.report.content).toContain("- src/fixture.ts");
    expect(applyPatch).toHaveBeenCalledOnce();
    const run = await value.store.readRun(value.runId);
    expect(run.sessions["implementation-00000001"]).toMatchObject({
      status: "stopped",
    });

    const reused = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      client: client(),
      launchSession: vi.fn(() =>
        Promise.reject(new Error("a completed retry must not launch")),
      ),
      nonce: () => "00000003",
      now: () => new Date("2026-08-18T18:05:00.000Z"),
    });
    expect(reused).toMatchObject({
      reused: true,
      task: { status: "checking" },
      report: { id: "implementation-00000001" },
    });
  });

  it("rejects invalid model output and leaves an unapplied Task in rework", async () => {
    const value = await fixture();
    await expect(
      runImplementation({
        ...value,
        taskId: "bounded-change",
        local,
        client: client(),
        launchSession: launcher("not structured output"),
        exportPatch: vi.fn(),
        nonce: () => "00000002",
        now: () => new Date("2026-08-18T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_implementation_output" });
    const run = await value.store.readRun(value.runId);
    expect(run.tasks["bounded-change"]).toMatchObject({
      status: "rework",
      implementation_attempts: 0,
    });
    expect(run.sessions["implementation-00000002"]).toMatchObject({
      status: "failed",
    });
  });

  it("parses one optional JSON fence", () => {
    expect(
      parseImplementationAssessment(`\`\`\`json\n${assessment()}\n\`\`\``),
    ).toMatchObject({ summary: "Implemented the bounded fixture change." });
  });
});
