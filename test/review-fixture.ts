import path from "node:path";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import { resolveReviewModelRoute } from "../src/model.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import {
  runReview,
  type ReviewRecord,
  type ReviewSession,
  type ReviewSessionLauncher,
} from "../src/review.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type ReadSessionOpenShell,
} from "../src/agent.js";
import { loadSandboxPolicy } from "../src/policy.js";
import type { AppliedFixture } from "./applied-fixture.js";

export async function fixtureLocalConfig(
  _fixture: AppliedFixture,
): Promise<LocalConfig> {
  return LocalConfigSchema.parse({
    version: 1,
    openshell: {
      command: "openshell",
      required_version: "0.0.106",
      workspace: "default",
      gateways: {
        review: "review-gateway",
        quant: "quant-gateway",
      },
    },
    models: {
      review: {
        gateway: "review",
        pi_model: "fixture-reviewer",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 131_072,
        max_tokens: 16_384,
        reasoning: true,
      },
      quant: {
        gateway: "quant",
        pi_model: "fixture-quant",
        api: "openai-responses",
        locality: "prefer-local",
        context_window: 131_072,
        max_tokens: 16_384,
        reasoning: true,
      },
    },
  });
}

function preflight(
  gateway: string,
  requiredVersion: string,
): OpenShellPreflight {
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

function client(
  gateway: string,
  model: string,
  requiredVersion: string,
): ReadSessionOpenShell {
  const unused = (): never => {
    throw new Error("The fixture Review launcher owns this operation");
  };
  return {
    preflight: () => Promise.resolve(preflight(gateway, requiredVersion)),
    getInferenceRoute: () => Promise.resolve({ provider: "fixture", model }),
    createSandbox: async () => unused(),
    waitForSandbox: async () => unused(),
    execSandbox: async (): Promise<ProcessResult> => unused(),
    startServiceForward: async (): Promise<OpenShellForward> => unused(),
    deleteSandbox: async () => unused(),
  };
}

function launcher(
  requiredVersion: string,
  index: number,
): ReviewSessionLauncher {
  return async (options) => {
    if (!options.model || !options.brief || !options.workspaceSource) {
      throw new Error("Fixture Review Session lacks frozen inputs");
    }
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-18 17:00:00",
      current_policy_version: 1,
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      labels: {},
      name: `pio-review-${index}`,
      phase: "Ready",
      resource_version: 1,
      workspace: "reviews",
    };
    const policy = await loadSandboxPolicy(
      "read",
      path.join(options.policyDirectory!, "read.yaml"),
    );
    const model = options.model;
    const session: ReviewSession = {
      info: {
        sandbox,
        permissionCeiling: options.permissionCeiling,
        identity: options.identity,
        sourceDigest: options.workspaceSource.sourceDigest,
        profile: "read",
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight(model.gateway, requiredVersion),
        piVersion: PI_RUNTIME_VERSION,
        clientVersion: PI_CLIENT_VERSION,
        model,
        inference: { provider: "fixture", model: model.pi_model },
        briefDigest: options.brief.digest,
        inputs: (options.inputs ?? []).map((input) => ({
          path: `/workspace/input/${input.name}`,
          byte_count:
            typeof input.content === "string"
              ? Buffer.byteLength(input.content, "utf8")
              : input.content.byteLength,
          digest: input.digest,
        })),
      },
      run: (message) =>
        Promise.resolve({
          message_ids: [message.id],
          model_alias: model.alias,
          requested_model: model.pi_model,
          response_model: model.pi_model,
          stop_reason: "stop",
          text: JSON.stringify({
            verdict: "pass",
            conclusion: "The exact fixture change satisfies this Lens.",
            blocking_findings: [],
            improvements: [],
            evidence: ["The exact source, diff, and Checks were inspected."],
            uncertainty: [],
          }),
          truncated: false,
          usage: { input: 100, output: 50 },
        }),
      stop: () => Promise.resolve(),
    };
    return session;
  };
}

export async function passFixtureReviews(
  fixture: AppliedFixture,
  configuredLocal?: LocalConfig,
): Promise<ReviewRecord[]> {
  const local = configuredLocal ?? (await fixtureLocalConfig(fixture));
  const role = fixture.project.roles.get("reviewer")!;
  const requiredVersion = local.openshell.required_version!;
  const records: ReviewRecord[] = [];
  for (let index = 0; index < fixture.task.reviews.length; index += 1) {
    const lens = fixture.task.reviews[index]!;
    const model = resolveReviewModelRoute(
      fixture.project.config,
      local,
      lens,
      role.definition.inference,
    );
    const sequence = index + 1;
    const result = await runReview({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      runId: fixture.runId,
      taskId: fixture.task.id,
      lens,
      local,
      client: client(model.gateway, model.pi_model, requiredVersion),
      launchSession: launcher(requiredVersion, sequence),
      nonce: () => sequence.toString(16).padStart(8, "0"),
      now: () => new Date(`2026-08-18T17:0${index}:00.000Z`),
    });
    records.push(result.record);
  }
  return records;
}
