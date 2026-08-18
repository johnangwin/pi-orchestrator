import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnknownError, OrchestratorError } from "./error.js";
import type { OpenShellClient, OpenShellPreflight } from "./openshell.js";
import {
  loadSandboxPolicy,
  SandboxProfileSchema,
  type LoadedSandboxPolicy,
  type SandboxProfile,
} from "./policy.js";
import { defaultOrchestratorHome } from "./state.js";

export type CanaryOpenShell = Pick<
  OpenShellClient,
  | "createSandbox"
  | "deleteSandbox"
  | "execSandbox"
  | "preflight"
  | "waitForSandbox"
>;

export interface CanaryAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CanaryProfileResult {
  readonly profile: SandboxProfile;
  readonly sandbox: string;
  readonly sandboxId?: string;
  readonly policyPath: string;
  readonly policyDigest: string;
  readonly assertions: readonly CanaryAssertion[];
  readonly passed: boolean;
}

export interface CanaryResult {
  readonly version: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly image: string;
  readonly openshell: {
    readonly cliVersion: string;
    readonly gateway: string;
    readonly gatewayVersion: string;
  };
  readonly profiles: readonly CanaryProfileResult[];
  readonly passed: boolean;
}

export interface CanaryOptions {
  readonly client: CanaryOpenShell;
  readonly image?: string;
  readonly policyDirectory?: string;
  readonly profiles?: readonly SandboxProfile[];
  readonly projectRoot?: string;
  readonly stateRoot?: string;
  readonly hostHome?: string;
  readonly now?: () => Date;
  readonly nameSuffix?: () => string;
}

function bundledPath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../sandbox/${segments.join("/")}`, import.meta.url),
  );
}

export function bundledCanaryImage(): string {
  return bundledPath("probe");
}

export function bundledPolicyDirectory(): string {
  return bundledPath("policies");
}

const assertionDetails = new Map<string, string>([
  ["unprivileged-uid", "UID is 10001"],
  [
    "unprivileged-groups",
    "primary group is 10001 and supplementary root is absent",
  ],
  ["source-readable", "base, input, and project markers are readable"],
  ["base-read-only", "base snapshot is read-only"],
  ["input-read-only", "Brief and input material are read-only"],
  ["project-access", "project access matches the selected profile"],
  ["output-writable", "Sandbox output is writable"],
  ["openshell-token-inaccessible", "OpenShell Sandbox token is unreadable"],
  ["openshell-key-inaccessible", "OpenShell client key is unreadable"],
  ["docker-socket-absent", "Docker socket is absent"],
  ["host-sentinel-inaccessible", "host-only sentinel is inaccessible"],
  ["host-home-inaccessible", "host home is inaccessible"],
  ["host-state-inaccessible", "host state is inaccessible"],
  ["host-checkout-inaccessible", "host checkout is inaccessible"],
  ["host-git-inaccessible", "host Git metadata is inaccessible"],
  [
    "sibling-repositories-inaccessible",
    "sibling repositories are inaccessible",
  ],
  ["host-ssh-agent-inaccessible", "host SSH agent socket is inaccessible"],
  ["host-credentials-absent", "host credential and agent variables are absent"],
  ["external-network-denied", "unapproved external network is denied"],
  ["host-gateway-denied", "agent access to the host gateway is denied"],
  ["privileged-mount-denied", "mount namespace creation is denied"],
]);

async function profileAssertions(
  client: CanaryOpenShell,
  sandbox: string,
  profile: SandboxProfile,
  preflight: OpenShellPreflight,
  hostPaths: readonly [id: string, value: string][],
): Promise<CanaryAssertion[]> {
  const gateway = new URL(preflight.status.server);
  gateway.hostname = "host.openshell.internal";
  let result;
  try {
    result = await client.execSandbox(
      sandbox,
      [
        "/usr/local/bin/orchestrator-canary",
        profile,
        gateway.toString(),
        ...hostPaths.map(([, value]) => value),
      ],
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    return [
      {
        id: "canary-script",
        passed: false,
        detail: `could not evaluate: ${formatUnknownError(error)}`,
      },
    ];
  }
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    return [
      {
        id: "canary-script",
        passed: false,
        detail: `script exited ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 240)}` : ""}`,
      },
    ];
  }

  const observed = new Map<string, string>();
  const malformed: string[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    const [id, status, ...extra] = line.split("\t");
    if (
      !id ||
      !status ||
      extra.length > 0 ||
      !assertionDetails.has(id) ||
      !["pass", "fail"].includes(status) ||
      observed.has(id)
    ) {
      malformed.push(line);
      continue;
    }
    observed.set(id, status);
  }

  const assertions = [...assertionDetails].map(([id, detail]) => ({
    id,
    passed: observed.get(id) === "pass",
    detail:
      observed.get(id) === "pass"
        ? detail
        : observed.has(id)
          ? `Sandbox behavior violated: ${detail}`
          : `Canary output omitted '${id}'`,
  }));
  if (malformed.length > 0) {
    assertions.push({
      id: "canary-output-contract",
      passed: false,
      detail: `Malformed output: ${malformed.join(" | ").slice(0, 240)}`,
    });
  }
  return assertions;
}

async function runProfile(
  client: CanaryOpenShell,
  image: string,
  policy: LoadedSandboxPolicy,
  preflight: OpenShellPreflight,
  hostPaths: readonly [id: string, value: string][],
  suffix: string,
): Promise<CanaryProfileResult> {
  const profileCode = policy.profile.slice(0, 1);
  const sandbox = `pio-cny-${profileCode}-${suffix}`;
  const assertions: CanaryAssertion[] = [];
  let sandboxId: string | undefined;

  try {
    let state = await client.createSandbox({
      name: sandbox,
      from: image,
      policyPath: policy.path,
      command: ["/usr/bin/true"],
    });
    if (state.phase !== "Ready") {
      state = await client.waitForSandbox(sandbox);
    }
    sandboxId = state.id;
    assertions.push({
      id: "sandbox-ready",
      passed: state.phase === "Ready",
      detail: `phase is ${state.phase}`,
    });
    assertions.push(
      ...(await profileAssertions(
        client,
        sandbox,
        policy.profile,
        preflight,
        hostPaths,
      )),
    );
  } catch (error) {
    assertions.push({
      id: "sandbox-lifecycle",
      passed: false,
      detail: formatUnknownError(error),
    });
  } finally {
    try {
      await client.deleteSandbox(sandbox, { missingOk: true });
      assertions.push({
        id: "sandbox-cleanup",
        passed: true,
        detail: "sandbox deleted",
      });
    } catch (error) {
      assertions.push({
        id: "sandbox-cleanup",
        passed: false,
        detail: formatUnknownError(error),
      });
    }
  }

  return {
    profile: policy.profile,
    sandbox,
    ...(sandboxId ? { sandboxId } : {}),
    policyPath: policy.path,
    policyDigest: policy.digest,
    assertions,
    passed: assertions.every((assertion) => assertion.passed),
  };
}

export async function runCanary(options: CanaryOptions): Promise<CanaryResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const image = options.image ?? bundledCanaryImage();
  const policyDirectory = options.policyDirectory ?? bundledPolicyDirectory();
  const profiles = (options.profiles ?? SandboxProfileSchema.options).map(
    (profile) => SandboxProfileSchema.parse(profile),
  );
  if (profiles.length === 0 || new Set(profiles).size !== profiles.length) {
    throw new OrchestratorError(
      "invalid_canary_profiles",
      "Canary profiles must be non-empty and unique",
    );
  }

  const policies = await Promise.all(
    profiles.map((profile) =>
      loadSandboxPolicy(profile, path.join(policyDirectory, `${profile}.yaml`)),
    ),
  );
  const preflight = await options.client.preflight();
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "OpenShell canaries require an exact required_version pin",
    );
  }
  const sentinelRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-host-canary-"),
  );
  const sentinel = path.join(sentinelRoot, "host-only");
  await writeFile(sentinel, randomBytes(32), { mode: 0o600 });

  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const hostPaths: readonly [id: string, value: string][] = [
    ["host-sentinel-inaccessible", sentinel],
    ["host-home-inaccessible", options.hostHome ?? os.homedir()],
    [
      "host-state-inaccessible",
      path.resolve(options.stateRoot ?? defaultOrchestratorHome()),
    ],
    ["host-checkout-inaccessible", projectRoot],
    ["host-git-inaccessible", path.join(projectRoot, ".git")],
    ["sibling-repositories-inaccessible", path.dirname(projectRoot)],
    [
      "host-ssh-agent-inaccessible",
      process.env.SSH_AUTH_SOCK ?? "/run/host-services/ssh-auth.sock",
    ],
  ];
  const suffix = options.nameSuffix ?? (() => randomBytes(3).toString("hex"));
  const results: CanaryProfileResult[] = [];

  try {
    for (const policy of policies) {
      results.push(
        await runProfile(
          options.client,
          image,
          policy,
          preflight,
          hostPaths,
          suffix(),
        ),
      );
    }
  } finally {
    await rm(sentinelRoot, { recursive: true, force: true });
  }

  return {
    version: 1,
    startedAt,
    completedAt: now().toISOString(),
    image,
    openshell: {
      cliVersion: preflight.installedVersion,
      gateway: preflight.status.gateway,
      gatewayVersion: preflight.status.version,
    },
    profiles: results,
    passed: results.every((result) => result.passed),
  };
}
