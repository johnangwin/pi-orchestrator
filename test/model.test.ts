import { describe, expect, it, vi } from "vitest";
import { parseProjectConfig } from "../src/config.js";
import { parseLocalConfig } from "../src/local.js";
import { resolveModelRoute, resolveRoleModelRoute } from "../src/model.js";
import {
  modelArguments,
  registerModelRoute,
} from "../sandbox/pi/client/model.mjs";

const local = parseLocalConfig(`version: 1
openshell:
  gateways:
    plan: openshell-plan
    code: openshell-code
models:
  plan:
    gateway: plan
    pi_model: frontier-plan
    api: openai-responses
    locality: remote
    context_window: 200000
    max_tokens: 16000
    reasoning: true
  code:
    gateway: code
    pi_model: local-code
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 8192
    reasoning: false
`);

describe("model routing", () => {
  it("resolves a logical alias to an exact gateway and Pi model", () => {
    expect(resolveModelRoute(local, "code")).toEqual({
      alias: "code",
      gateway_alias: "code",
      gateway: "openshell-code",
      pi_model: "local-code",
      api: "openai-completions",
      locality: "local",
      context_window: 131072,
      max_tokens: 8192,
      reasoning: false,
    });
  });

  it("rejects missing gateways and incompatible locality", () => {
    const broken = parseLocalConfig(`version: 1
openshell:
  gateways: {}
models:
  code:
    gateway: code
    pi_model: local-code
    api: openai-completions
    locality: local
    context_window: 1000
    max_tokens: 100
    reasoning: false
`);
    expect(() => resolveModelRoute(broken, "code")).toThrow(
      "unknown OpenShell gateway alias",
    );

    const project = parseProjectConfig(`version: 1
project: { id: fixture }
roles: [lead]
models: { lead: code }
context:
  initial_fraction: 0.25
  warn_fraction: 0.6
  handoff_fraction: 0.75
  stop_fraction: 0.85
attempts: { implementation: 3, review: 2, consultation_hops: 2 }
git: { branch_prefix: orchestrator/, commit: human, push: disabled, merge: disabled }
network: { default: none }
protected: []
checks: {}
`);
    expect(() =>
      resolveRoleModelRoute(project, local, "lead", "remote"),
    ).toThrow("requires remote inference");
  });

  it("rejects Check working directories that can escape the Project", () => {
    expect(() =>
      parseProjectConfig(`version: 1
project: { id: fixture }
roles: [lead]
models: { lead: plan }
context:
  initial_fraction: 0.25
  warn_fraction: 0.6
  handoff_fraction: 0.75
  stop_fraction: 0.85
attempts: { implementation: 3, review: 2, consultation_hops: 2 }
git: { branch_prefix: orchestrator/, commit: human, push: disabled, merge: disabled }
network: { default: none }
protected: []
checks:
  project-test:
    argv: [node, --test]
    cwd: ../outside
`),
    ).toThrow("must remain inside the Project");
  });
});

describe("Pi model route", () => {
  const config = {
    version: 2 as const,
    identity: {
      run: "run-one",
      agent: "scout",
      session: "session-one",
      generation: 1,
    },
    token: "a".repeat(64),
    listen: { host: "127.0.0.1" as const, port: 41727 },
    client_version: "0.2.0",
    pi_version: "0.84.2",
    model: {
      alias: "code" as const,
      pi_model: "local-code",
      api: "openai-completions" as const,
      context_window: 131072,
      max_tokens: 8192,
      reasoning: false,
    },
    brief: {
      path: "/workspace/input/brief.md" as const,
      digest: `sha256:${"a".repeat(64)}`,
    },
  };

  it("registers one credential-free inference.local provider", () => {
    const registerProvider = vi.fn();
    registerModelRoute({ registerProvider }, config);
    expect(registerProvider).toHaveBeenCalledWith(
      "orchestrator",
      expect.objectContaining({
        baseUrl: "https://inference.local/v1",
        apiKey: "unused",
        api: "openai-completions",
        models: [expect.objectContaining({ id: "local-code" })],
      }),
    );
  });

  it("selects only the registered model and immutable Brief", () => {
    expect(modelArguments(config)).toEqual([
      "--provider",
      "orchestrator",
      "--model",
      "local-code",
      "--append-system-prompt",
      "/workspace/input/brief.md",
    ]);
  });
});
