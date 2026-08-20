import { describe, expect, it, vi } from "vitest";
import { parseProjectConfig } from "../src/config.js";
import { parseLocalConfig } from "../src/local.js";
import {
  resolveAgentProfileChange,
  resolveModelRoute,
  resolveReviewModelRoute,
  resolveRoleModelRoute,
  routingPolicyDigest,
} from "../src/model.js";
import {
  modelArguments,
  registerModelRoute,
} from "../sandbox/pi/client/model.mjs";
import { fixtureModelRoute, fixturePermissionCeiling } from "./fixture.js";

const local = parseLocalConfig(`version: 2
openshell:
  gateways:
    local: openshell-local
    remote: openshell-remote
models:
  local-code:
    gateway: local
    pi_model: qwen-local-code
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 8192
    reasoning: false
  frontier-planning:
    gateway: remote
    pi_model: frontier-plan
    api: openai-responses
    locality: remote
    context_window: 200000
    max_tokens: 16000
    reasoning: true
  independent-review:
    gateway: remote
    pi_model: independent-reviewer
    api: openai-responses
    locality: remote
    context_window: 200000
    max_tokens: 16000
    reasoning: true
  local-quant:
    gateway: local
    pi_model: local-quant-model
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 8192
    reasoning: true
`);

function project(remote: "allowed" | "denied" = "denied") {
  return parseProjectConfig(`version: 2
project: { id: fixture }
roles: [lead, implementer, reviewer]
routing:
  roles:
    lead:
      default: local-code
      allowed: [local-code, frontier-planning]
      remote: ${remote}
    implementer:
      default: local-code
      allowed: [local-code]
      remote: denied
    reviewer:
      default: independent-review
      allowed: [independent-review, local-quant]
      focuses: { quant: local-quant }
      remote: allowed
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
}

describe("model routing", () => {
  it("resolves a descriptive Profile to one exact digest-bound route", () => {
    const route = resolveModelRoute(local, "local-code");
    expect(route).toMatchObject({
      profile: "local-code",
      gateway_alias: "local",
      gateway: "openshell-local",
      pi_model: "qwen-local-code",
      api: "openai-completions",
      locality: "local",
      context_window: 131072,
      max_tokens: 8192,
      reasoning: false,
      route_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(resolveModelRoute(local, "local-code")).toEqual(route);
  });

  it("applies Role allowlists and Review Focus selection", () => {
    const config = project();
    expect(resolveRoleModelRoute(config, local, "lead").profile).toBe(
      "local-code",
    );
    expect(resolveReviewModelRoute(config, local, "quant").profile).toBe(
      "local-quant",
    );
    expect(() =>
      resolveRoleModelRoute(config, local, "lead", {
        profile: "independent-review",
      }),
    ).toThrow("does not allow Model Profile");
    expect(routingPolicyDigest(config)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("resolves concurrent frontier and local Agents through separate gateways", () => {
    const config = project("allowed");
    const lead = resolveRoleModelRoute(config, local, "lead", {
      profile: "frontier-planning",
    });
    const implementer = resolveRoleModelRoute(config, local, "implementer");

    expect(lead).toMatchObject({
      profile: "frontier-planning",
      gateway: "openshell-remote",
      locality: "remote",
    });
    expect(implementer).toMatchObject({
      profile: "local-code",
      gateway: "openshell-local",
      locality: "local",
    });
    expect(lead.route_digest).not.toBe(implementer.route_digest);
  });

  it("rejects missing gateways, denied remote routes, and silent egress", () => {
    const broken = parseLocalConfig(`version: 2
openshell:
  gateways: {}
models:
  local-code:
    gateway: missing
    pi_model: local-code
    api: openai-completions
    locality: local
    context_window: 1000
    max_tokens: 100
    reasoning: false
`);
    expect(() => resolveModelRoute(broken, "local-code")).toThrow(
      "unknown OpenShell gateway alias",
    );
    expect(() =>
      resolveRoleModelRoute(project(), local, "lead", {
        profile: "frontier-planning",
      }),
    ).toThrow("denies remote inference");
    expect(() =>
      resolveAgentProfileChange({
        project: project("allowed"),
        local,
        role: "lead",
        currentProfile: "local-code",
        targetProfile: "frontier-planning",
      }),
    ).toThrow("requires trusted human approval");
    expect(
      resolveAgentProfileChange({
        project: project("allowed"),
        local,
        role: "lead",
        currentProfile: "local-code",
        targetProfile: "frontier-planning",
        remoteEgressApproved: true,
      }).profile,
    ).toBe("frontier-planning");
  });

  it("rejects Check working directories that can escape the Project", () => {
    expect(() =>
      parseProjectConfig(`version: 2
project: { id: fixture }
roles: [lead]
routing:
  roles:
    lead: { default: local-code, allowed: [local-code], remote: denied }
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
    permission_ceiling: fixturePermissionCeiling(),
    model: fixtureModelRoute("local-code"),
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
        models: [expect.objectContaining({ id: "local-code-model" })],
      }),
    );
  });

  it("selects only the registered model and immutable Brief", () => {
    expect(modelArguments(config)).toEqual([
      "--provider",
      "orchestrator",
      "--model",
      "local-code-model",
      "--append-system-prompt",
      "/workspace/input/brief.md",
    ]);
  });
});
