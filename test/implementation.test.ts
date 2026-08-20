import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApproval } from "../src/approval.js";
import {
  bundledPiPolicyDirectory,
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  type StartWriteSessionOptions,
} from "../src/agent.js";
import { sha256 } from "../src/digest.js";
import {
  parseImplementationAssessment,
  runImplementation,
  type ImplementationOpenShell,
  type ImplementationSession,
} from "../src/implementation.js";
import { LocalConfigSchema } from "../src/local.js";
import { WorkspaceLifecycle } from "../src/lifecycle.js";
import { resolveRoleModelRoute } from "../src/model.js";
import type {
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import { catalogFromConfig, loadPlan } from "../src/plan.js";
import { loadSandboxPolicy } from "../src/policy.js";
import { loadProject } from "../src/project.js";
import { AgentRegistry } from "../src/registry.js";
import { startRun } from "../src/run.js";
import { resolveRolePermissionCeiling } from "../src/permission.js";
import { validateTaskWritePaths } from "../src/scope.js";
import {
  RunSourceWorkspace,
  WritableSourceWorkspace,
  verifyWorkspaceGateway,
  type WorkspaceSourceDocker,
} from "../src/source.js";
import type { ProjectStore } from "../src/state.js";
import { DockerVolumeCapability } from "../src/volume.js";
import { createWorkspaceManifestFromEntries } from "../src/workspace.js";
import {
  commitFixture,
  createFixtureProject,
  createPlan,
  fixturePermissionPolicyDigest,
  fixtureRoutingPolicyDigest,
} from "./fixture.js";

const roots: string[] = [];
const stores: ProjectStore[] = [];
const image =
  "pi-orchestrator-pi@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dockerVersion = "29.5.2";
const openshellVersion = "0.0.106";
const helper = fileURLToPath(
  new URL("../sandbox/pi/workspace.mjs", import.meta.url),
);
const baselineContent = "export const fixture = true;\n";

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
    required_version: openshellVersion,
    workspace: "default",
    gateways: { code: "code-gateway" },
    images: { pi: image },
    shared_workspace: {
      enabled: true,
      gateway: "code-gateway",
      driver: "docker",
      driver_version: dockerVersion,
      docker_command: "docker",
    },
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
  workspace: { volume_prefix: "pio-test", restricted_paths: [] },
});

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: openshellVersion,
  installedVersion: openshellVersion,
  versionMatches: true,
  status: {
    authentication: { provider: "mTLS", status: "authenticated" },
    gateway: "code-gateway",
    server: "https://127.0.0.1:17670",
    status: "connected",
    version: openshellVersion,
  },
};

class FixtureDocker implements WorkspaceSourceDocker {
  readonly command = "fixture-docker";
  readonly capability: DockerVolumeCapability;
  inspectionCalls = 0;
  inspectWhileWritable = 0;
  writerActive: () => boolean = () => false;

  constructor(
    readonly root: string,
    readonly commit: string,
    labels: Readonly<Record<string, string>>,
  ) {
    this.capability = DockerVolumeCapability.fromInspection(
      {
        CreatedAt: "2026-08-19T00:00:00Z",
        Driver: "local",
        Labels: labels,
        Mountpoint: root,
        Name: "pio-test-run-workspace",
        Options: null,
        Scope: "local",
      },
      "pio-test-run-workspace",
      labels,
    );
  }

  version(): Promise<string> {
    return Promise.resolve(dockerVersion);
  }

  createVolume(): Promise<DockerVolumeCapability> {
    return Promise.resolve(this.capability);
  }

  inspectVolume(
    name: string,
    labels?: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability | undefined> {
    if (
      name !== this.capability.name ||
      (labels &&
        Object.entries(labels).some(
          ([key, value]) => this.capability.labels[key] !== value,
        ))
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.capability);
  }

  seedGitWorkspace(): Promise<ProcessResult> {
    return Promise.resolve({ stdout: "", stderr: "unused", exitCode: 1 });
  }

  inspectWorkspaceVolume(): Promise<ProcessResult> {
    this.inspectionCalls += 1;
    if (this.writerActive()) this.inspectWhileWritable += 1;
    return Promise.resolve({
      stdout: execFileSync(
        process.execPath,
        [helper, "inspect", path.join(this.root, "project")],
        { encoding: "utf8" },
      ),
      stderr: "",
      exitCode: 0,
    });
  }

  async inspectWorkspaceGitStatus(): Promise<ProcessResult> {
    this.inspectionCalls += 1;
    if (this.writerActive()) this.inspectWhileWritable += 1;
    const current = await readFile(
      path.join(this.root, "project", "src", "fixture.ts"),
      "utf8",
    );
    return {
      stdout: `${JSON.stringify({
        commit: this.commit,
        changes:
          current === baselineContent
            ? []
            : [
                {
                  path: "src/fixture.ts",
                  index_status: " ",
                  worktree_status: "M",
                },
              ],
      })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  removeVolume(): Promise<void> {
    return Promise.resolve();
  }
}

class FixtureClient {
  readonly gateway = "code-gateway";
  readonly sandboxes = new Map<string, OpenShellSandbox>();
  readonly deleteSandbox = vi.fn(async (name: string) => {
    this.sandboxes.delete(name);
  });

  preflight(): Promise<OpenShellPreflight> {
    return Promise.resolve(preflight);
  }

  listGateways() {
    return Promise.resolve([
      {
        active: true,
        auth: "mtls",
        endpoint: preflight.status.server,
        is_remote: false,
        name: this.gateway,
        remote_host: null,
        resolved_host: "127.0.0.1",
        source: "fixture",
        type: "local",
      } as const,
    ]);
  }

  getGatewayInfo() {
    return Promise.resolve({
      auth: null,
      compute_drivers: [
        {
          capabilities: {
            driver_name: "docker",
            driver_version: dockerVersion,
          },
          name: "docker",
        },
      ],
      gateway: this.gateway,
      server: preflight.status.server,
      status: "healthy",
      version: openshellVersion,
    });
  }

  listSandboxes(): Promise<OpenShellSandbox[]> {
    return Promise.resolve([...this.sandboxes.values()]);
  }

  addSandbox(sandbox: OpenShellSandbox): void {
    this.sandboxes.set(sandbox.name, sandbox);
  }
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
  const volumeRoot = await temporary("pi-implementation-volume-");
  await mkdir(path.join(volumeRoot, "project", "src"), { recursive: true });
  await writeFile(
    path.join(volumeRoot, "project", "src", "fixture.ts"),
    baselineContent,
  );
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
  const labels = {
    "pio.kind": "run-workspace",
    "pio.project": project.config.project.id,
    "pio.run": started.run.id,
    "pio.commit": commit.slice(0, 63),
  };
  const docker = new FixtureDocker(volumeRoot, commit, labels);
  const workspace = new RunSourceWorkspace(
    project.config.project.id,
    started.run.id,
    commit,
    docker.capability,
    image,
    dockerVersion,
    labels,
    path.join(root, ".git"),
    docker,
  );
  const fixtureClient = new FixtureClient();
  docker.writerActive = () => fixtureClient.sandboxes.size > 0;
  return {
    root,
    project,
    plan,
    store,
    runId: started.run.id,
    workspace,
    docker,
    client: fixtureClient as unknown as ImplementationOpenShell,
    rawClient: fixtureClient,
    workspaceFactory: () => Promise.resolve(workspace),
  };
}

function assessment(summary = "Implemented the bounded fixture change.") {
  return JSON.stringify({
    summary,
    contracts_changed: [],
    behavior_changed: ["The fixture now returns the requested value."],
    checks_attempted: ["node --test passed"],
    deviations: [],
    risks: [],
    questions: [],
    downstream: [],
  });
}

function launcher(options: {
  readonly client: FixtureClient;
  readonly text: string;
  readonly content: string;
  readonly duringTurn?: () => Promise<void>;
  readonly captureMounts?: (
    mounts: WritableSourceWorkspace["mountSet"],
  ) => void;
  readonly captureBrief?: (content: string) => void;
}) {
  return async (
    input: StartWriteSessionOptions,
  ): Promise<ImplementationSession> => {
    if (
      !input.model ||
      !input.brief ||
      !(input.workspace instanceof WritableSourceWorkspace) ||
      !input.sandboxName
    ) {
      throw new Error("Fixture implementation Session lacks frozen inputs");
    }
    const workspace = input.workspace;
    options.captureMounts?.(workspace.mountSet);
    options.captureBrief?.(input.brief.content);
    const policy = await loadSandboxPolicy(
      "write",
      path.join(input.policyDirectory!, "write.yaml"),
    );
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-19T18:00:00Z",
      current_policy_version: 1,
      id: "00000000-0000-4000-8000-000000000101",
      labels: {
        "pio.run": input.identity.run,
        "pio.access": "write",
      },
      name: input.sandboxName,
      phase: "Ready",
      resource_version: 1,
      workspace: "default",
    };
    options.client.addSandbox(sandbox);
    const projection = {
      source_digest: workspace.manifest.source_digest,
      workspace_generation: workspace.manifest.workspace_generation,
      manifest_digest: workspace.manifest.manifest_digest,
      volume_name: workspace.volume.name,
      volume_digest: workspace.volume.digest,
      mount_set_digest: workspace.mountSet.digest,
      mount_table_digest: sha256("fixture mount table"),
      image_digest: workspace.imageDigest,
      projection_digest: workspace.projectionDigest,
      lease_id: workspace.lease.id,
      lease_digest: workspace.lease.digest,
      write_roots_digest: workspace.lease.write_roots_digest,
      gateway_digest: workspace.gatewayDigest,
    } as const;
    return {
      info: {
        sandbox: { ...sandbox, projection },
        permissionCeiling: input.permissionCeiling,
        identity: input.identity,
        sourceDigest: workspace.manifest.source_digest,
        profile: "write",
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight,
        piVersion: PI_RUNTIME_VERSION,
        clientVersion: PI_CLIENT_VERSION,
        model: input.model,
        inference: { provider: "fixture", model: input.model.pi_model },
        briefDigest: input.brief.digest,
        inputs: [],
        workspaceProjection: projection,
      },
      async run(message) {
        await writeFile(
          path.join(
            workspace.volume.mountpoint,
            "project",
            "src",
            "fixture.ts",
          ),
          options.content,
        );
        await options.duringTurn?.();
        return {
          message_ids: [message.id],
          model_profile: input.model!.profile,
          requested_model: input.model!.pi_model,
          response_model: input.model!.pi_model,
          stop_reason: "stop",
          text: options.text,
          truncated: false,
          usage: { input: 100, output: 40 },
        };
      },
      stop: () => options.client.deleteSandbox(sandbox.name),
    };
  };
}

describe("implementation orchestration", () => {
  it("requires every writer to use the configured shared Workspace gateway", async () => {
    const value = await fixture();
    const mismatched = LocalConfigSchema.parse({
      ...local,
      openshell: {
        ...local.openshell,
        shared_workspace: {
          ...local.openshell.shared_workspace!,
          gateway: "another-local-gateway",
        },
      },
    });

    await expect(
      runImplementation({
        ...value,
        taskId: "bounded-change",
        local: mismatched,
        launchSession: vi.fn(() =>
          Promise.reject(new Error("a mismatched gateway must not launch")),
        ),
        now: () => new Date("2026-08-19T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "workspace_gateway_mismatch" });
    expect(value.rawClient.sandboxes.size).toBe(0);
  });

  it("revokes the exact writer before freezing a digest-bound Candidate", async () => {
    const value = await fixture();
    const initialSource = await value.workspace.inspect(0);
    const reader = value.workspace.bindReader({
      source: initialSource,
      restrictedPatterns: [],
    });
    let duringTurn: unknown;
    let projectedMounts: WritableSourceWorkspace["mountSet"] | undefined;
    const result = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment(),
        content: "export const fixture = 2;\n",
        duringTurn: async () => {
          const run = await value.store.readRun(value.runId);
          duringTurn = {
            phase: run.workspace?.phase,
            candidate: run.workspace?.candidate,
            task: run.tasks["bounded-change"]?.status,
            writers: value.rawClient.sandboxes.size,
          };
        },
        captureMounts: (mounts) => {
          projectedMounts = mounts;
        },
      }),
      now: () => new Date("2026-08-19T18:00:00.000Z"),
    });

    expect(duringTurn).toEqual({
      phase: "mutating",
      candidate: null,
      task: "active",
      writers: 1,
    });
    expect(projectedMounts?.mounts).toEqual([
      expect.objectContaining({
        target: "/workspace/project",
        readOnly: true,
        purpose: "workspace",
      }),
      expect.objectContaining({
        target: "/workspace/project/src",
        readOnly: false,
        purpose: "write",
      }),
    ]);
    expect(value.rawClient.sandboxes.size).toBe(0);
    expect(value.docker.inspectWhileWritable).toBe(0);
    expect(result).toMatchObject({
      reused: false,
      task: { status: "checking", implementation_attempts: 1 },
      report: {
        id: "implementation-bounded-change-1",
        kind: "implementation",
        task: "bounded-change",
        session: "implementation-bounded-change-1",
      },
      changeSet: {
        id: "change-bounded-change-1",
        baseline_generation: 0,
        result_generation: 1,
        report: "implementation-bounded-change-1",
      },
      candidate: {
        id: "candidate-bounded-change-1",
        workspace_generation: 1,
        status: "frozen",
      },
    });
    expect(result.report.content).toContain("- src/fixture.ts");
    expect(
      await readFile(
        path.join(reader.volume.mountpoint, "project", "src", "fixture.ts"),
        "utf8",
      ),
    ).toBe("export const fixture = 2;\n");
    await expect(reader.verify()).rejects.toMatchObject({
      code: "workspace_source_stale",
    });
    const run = await value.store.readRun(value.runId);
    expect(run.workspace).toMatchObject({
      phase: "frozen",
      generation: 1,
      active_lease: null,
      candidate: { id: "candidate-bounded-change-1", status: "frozen" },
    });
    expect(run.sessions["implementation-bounded-change-1"]).toMatchObject({
      status: "stopped",
    });

    const reused = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      launchSession: vi.fn(() =>
        Promise.reject(new Error("a frozen retry must not launch")),
      ),
      now: () => new Date("2026-08-19T18:05:00.000Z"),
    });
    expect(reused).toMatchObject({
      reused: true,
      candidate: { id: "candidate-bounded-change-1" },
      report: { id: "implementation-bounded-change-1" },
    });
  });

  it("retains failed-attempt changes as rework and uses a new lease without a transcript", async () => {
    const value = await fixture();
    await expect(
      runImplementation({
        ...value,
        taskId: "bounded-change",
        local,
        launchSession: launcher({
          client: value.rawClient,
          text: "not structured output",
          content: "export const fixture = 2;\n",
        }),
        now: () => new Date("2026-08-19T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_implementation_output" });
    let run = await value.store.readRun(value.runId);
    expect(run.tasks["bounded-change"]).toMatchObject({
      status: "rework",
      implementation_attempts: 1,
    });
    expect(run.workspace).toMatchObject({
      phase: "stable",
      generation: 1,
      active_lease: null,
      candidate: null,
      change_sets: [{ id: "change-bounded-change-1" }],
    });
    expect(value.rawClient.sandboxes.size).toBe(0);
    expect(value.docker.inspectWhileWritable).toBe(0);

    const result = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment("Corrected the retained Workspace state."),
        content: "export const fixture = 3;\n",
      }),
      now: () => new Date("2026-08-19T18:10:00.000Z"),
    });
    expect(result).toMatchObject({
      task: { status: "checking", implementation_attempts: 2 },
      changeSet: { id: "change-bounded-change-2" },
      candidate: {
        id: "candidate-bounded-change-2",
        workspace_generation: 2,
        change_sets: [
          { id: "change-bounded-change-1" },
          { id: "change-bounded-change-2" },
        ],
      },
    });
    run = await value.store.readRun(value.runId);
    expect(run.sessions["implementation-bounded-change-1"]).toMatchObject({
      status: "failed",
    });
    expect(run.sessions["implementation-bounded-change-2"]).toMatchObject({
      status: "stopped",
      replaces: { session: "implementation-bounded-change-1" },
    });
  });

  it("revokes an interrupted writer before inspecting and starts a fresh attempt", async () => {
    const value = await fixture();
    const task = value.plan.tasks.find(
      (candidate) => candidate.id === "bounded-change",
    );
    const role = value.project.roles.get("implementer");
    if (!task || !role)
      throw new Error("Fixture implementation inputs missing");
    const clock = () => new Date("2026-08-19T18:00:00.000Z");
    const lifecycle = new WorkspaceLifecycle(value.store, value.runId, clock);
    const registry = new AgentRegistry(value.store, value.runId, clock);
    const source = await value.workspace.inspect(0);
    const manifest = createWorkspaceManifestFromEntries(source.entries);
    const gitDiff = await value.workspace.gitDiff(source);
    await lifecycle.initialize({
      volumeName: value.workspace.volume.name,
      volumeDigest: value.workspace.volume.digest,
      manifest,
      gitDiff,
    });
    const permissionCeiling = resolveRolePermissionCeiling({
      role,
      assignment: { kind: "task", task: task.id },
      localPolicy: local.permissions,
    });
    const model = resolveRoleModelRoute(value.project.config, local, task.role);
    await registry.register({
      agent: "implementer",
      role: task.role,
      profile: model.profile,
    });
    const session = await registry.start({
      agent: "implementer",
      session: "implementation-bounded-change-1",
      route: model,
      permissionCeilingDigest: permissionCeiling.permission_ceiling_digest,
    });
    const writePolicy = validateTaskWritePaths({
      task,
      protectedPatterns: value.project.config.protected,
      restrictedPatterns: value.project.config.restricted_paths,
    });
    const mountSet = value.workspace.writeMountSet({
      source,
      writePaths: writePolicy.writePaths,
      protectedPatterns: value.project.config.protected,
      restrictedPatterns: value.project.config.restricted_paths,
    });
    const policy = await loadSandboxPolicy(
      "write",
      path.join(bundledPiPolicyDirectory(), "write.yaml"),
    );
    const gateway = await verifyWorkspaceGateway(
      value.workspace,
      {
        gateway: value.rawClient.gateway,
        listGateways: value.rawClient.listGateways.bind(value.rawClient),
        getGatewayInfo: value.rawClient.getGatewayInfo.bind(value.rawClient),
      },
      preflight,
    );
    let lease = await lifecycle.acquire({
      id: "lease-bounded-change-1",
      task,
      identity: session.identity,
      permissionCeiling,
      baselineManifest: manifest,
      protectedPatterns: value.project.config.protected,
      restrictedPatterns: value.project.config.restricted_paths,
      expiresAt: "2026-08-19T19:00:00.000Z",
      sandboxName: "pio-w-d097cb6aaab2",
      sandboxWorkspace: "default",
      policyDigest: policy.digest,
      imageDigest: value.workspace.imageDigest,
      gatewayDigest: gateway.digest,
      mountSetDigest: mountSet.digest,
    });
    await value.store.updateRun(value.runId, (run) => ({
      ...run,
      status: "active",
      tasks: {
        ...run.tasks,
        [task.id]: { ...run.tasks[task.id]!, status: "active" },
      },
    }));
    const writer = value.workspace.bindWriter({
      source,
      mountSet,
      lease,
      gatewayDigest: gateway.digest,
    });
    const sandbox: OpenShellSandbox = {
      annotations: {},
      created_at: "2026-08-19T18:00:00Z",
      current_policy_version: 1,
      id: "00000000-0000-4000-8000-000000000102",
      labels: { "pio.run": value.runId, "pio.access": "write" },
      name: lease.sandbox_name,
      phase: "Ready",
      resource_version: 1,
      workspace: "default",
    };
    const projection = {
      source_digest: source.source_digest,
      workspace_generation: source.workspace_generation,
      manifest_digest: source.manifest_digest,
      volume_name: writer.volume.name,
      volume_digest: writer.volume.digest,
      mount_set_digest: mountSet.digest,
      mount_table_digest: sha256("interrupted mount table"),
      image_digest: writer.imageDigest,
      projection_digest: writer.projectionDigest,
      lease_id: lease.id,
      lease_digest: lease.digest,
      write_roots_digest: lease.write_roots_digest,
      gateway_digest: gateway.digest,
    } as const;
    await registry.bindSandbox(session.identity, {
      id: sandbox.id,
      name: sandbox.name,
      workspace: sandbox.workspace,
      projection,
    });
    lease = await lifecycle.activate(lease.id, {
      id: sandbox.id,
      name: sandbox.name,
      workspace: sandbox.workspace,
      gatewayDigest: gateway.digest,
      mountSetDigest: mountSet.digest,
      mountTableDigest: projection.mount_table_digest,
      sandboxDigest: sha256("interrupted sandbox"),
    });
    await registry.transition(session.identity, { status: "active" });
    value.rawClient.addSandbox(sandbox);
    await writeFile(
      path.join(
        value.workspace.volume.mountpoint,
        "project",
        "src",
        "fixture.ts",
      ),
      "export const fixture = 2;\n",
    );

    const result = await runImplementation({
      ...value,
      taskId: task.id,
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment("Replaced the interrupted Implementer."),
        content: "export const fixture = 3;\n",
      }),
      now: () => new Date("2026-08-19T18:10:00.000Z"),
    });
    expect(value.rawClient.deleteSandbox).toHaveBeenCalledWith(
      lease.sandbox_name,
      { missingOk: true },
    );
    expect(value.docker.inspectWhileWritable).toBe(0);
    expect(result).toMatchObject({
      task: { status: "checking", implementation_attempts: 2 },
      changeSet: { id: "change-bounded-change-2" },
      candidate: {
        id: "candidate-bounded-change-2",
        workspace_generation: 2,
        change_sets: [
          { id: "change-bounded-change-1" },
          { id: "change-bounded-change-2" },
        ],
      },
    });
    const recovered = await value.store.readRun(value.runId);
    expect(recovered.sessions["implementation-bounded-change-1"]).toMatchObject(
      { status: "failed" },
    );
    expect(recovered.workspace?.active_lease).toBeNull();
  });

  it("builds Candidate rework from failed Gates and durable Reports, not a transcript", async () => {
    const value = await fixture();
    const first = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment("Produced the first Candidate."),
        content: "export const fixture = 2;\n",
      }),
      now: () => new Date("2026-08-19T18:00:00.000Z"),
    });
    await value.store.updateRun(value.runId, (run) => ({
      ...run,
      tasks: {
        ...run.tasks,
        "bounded-change": {
          ...run.tasks["bounded-change"]!,
          status: "rework",
          gates: {
            "review-quality": {
              status: "fail",
              digest: sha256("failed review"),
              rationale: "The returned value is off by one.",
              updated_at: "2026-08-19T18:05:00.000Z",
            },
          },
        },
      },
    }));
    let correctionBrief = "";

    const corrected = await runImplementation({
      ...value,
      taskId: "bounded-change",
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment("Corrected the failed Candidate."),
        content: "export const fixture = 3;\n",
        captureBrief: (content) => {
          correctionBrief = content;
        },
      }),
      now: () => new Date("2026-08-19T18:10:00.000Z"),
    });

    expect(corrected).toMatchObject({
      task: { status: "checking", implementation_attempts: 2 },
      candidate: {
        id: "candidate-bounded-change-2",
        change_sets: [
          { id: "change-bounded-change-1" },
          { id: "change-bounded-change-2" },
        ],
      },
    });
    expect(correctionBrief).toContain("Current correction evidence");
    expect(correctionBrief).toContain(first.candidate.id);
    expect(correctionBrief).toContain(first.candidate.digest);
    expect(correctionBrief).toContain("The returned value is off by one.");
    expect(correctionBrief).toContain(first.report.id);
    expect(correctionBrief).toContain("Produced the first Candidate.");
    const candidates = await new WorkspaceLifecycle(
      value.store,
      value.runId,
    ).candidates.list(first.candidate.id);
    expect(candidates.map((candidate) => candidate.status).sort()).toEqual([
      "discarded",
      "frozen",
    ]);
  });

  it("blocks an unleased writer without inspecting the mutable volume", async () => {
    const value = await fixture();
    value.rawClient.addSandbox({
      annotations: {},
      created_at: "2026-08-19T18:00:00Z",
      current_policy_version: 1,
      id: "00000000-0000-4000-8000-000000000103",
      labels: { "pio.run": value.runId, "pio.access": "write" },
      name: "pio-w-unleased",
      phase: "Ready",
      resource_version: 1,
      workspace: "default",
    });
    const inspections = value.docker.inspectionCalls;

    await expect(
      runImplementation({
        ...value,
        taskId: "bounded-change",
        local,
        launchSession: vi.fn(() =>
          Promise.reject(new Error("an unleased writer must block launch")),
        ),
        now: () => new Date("2026-08-19T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "writable_sandbox_without_lease" });
    expect(value.docker.inspectionCalls).toBe(inspections);
    await expect(value.store.readRun(value.runId)).resolves.toMatchObject({
      status: "blocked",
      workspace: null,
    });
  });

  it("replaces an orphaned pre-lease Implementer Session on retry", async () => {
    const value = await fixture();
    const task = value.plan.tasks.find(
      (candidate) => candidate.id === "bounded-change",
    );
    const role = value.project.roles.get("implementer");
    if (!task || !role)
      throw new Error("Fixture implementation inputs missing");
    const registry = new AgentRegistry(
      value.store,
      value.runId,
      () => new Date("2026-08-19T18:00:00.000Z"),
    );
    const model = resolveRoleModelRoute(value.project.config, local, task.role);
    const permissionCeiling = resolveRolePermissionCeiling({
      role,
      assignment: { kind: "task", task: task.id },
      localPolicy: local.permissions,
    });
    await registry.register({
      agent: "implementer",
      role: task.role,
      profile: model.profile,
    });
    await registry.start({
      agent: "implementer",
      session: "implementation-bounded-change-1",
      route: model,
      permissionCeilingDigest: permissionCeiling.permission_ceiling_digest,
    });

    const result = await runImplementation({
      ...value,
      taskId: task.id,
      local,
      launchSession: launcher({
        client: value.rawClient,
        text: assessment("Replaced the pre-lease Implementer."),
        content: "export const fixture = 2;\n",
      }),
      now: () => new Date("2026-08-19T18:10:00.000Z"),
    });

    expect(result).toMatchObject({
      task: { status: "checking", implementation_attempts: 2 },
      identity: { session: "implementation-bounded-change-2" },
      candidate: { id: "candidate-bounded-change-2" },
    });
    const run = await value.store.readRun(value.runId);
    expect(run.sessions["implementation-bounded-change-1"]).toMatchObject({
      status: "failed",
      termination_reason: "Implementation Session had no durable Write Lease",
    });
    expect(run.sessions["implementation-bounded-change-2"]).toMatchObject({
      status: "stopped",
      replaces: { session: "implementation-bounded-change-1" },
    });
    expect(value.docker.inspectWhileWritable).toBe(0);
  });

  it("parses one optional JSON fence", () => {
    expect(
      parseImplementationAssessment(`\`\`\`json\n${assessment()}\n\`\`\``),
    ).toMatchObject({ summary: "Implemented the bounded fixture change." });
  });
});
