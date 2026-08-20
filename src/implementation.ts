import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { applyTaskPatch, type ApplyTaskPatchResult } from "./apply.js";
import { requireFreshApproval } from "./approval.js";
import {
  ArtifactDescriptorSchema,
  ArtifactStore,
  type ArtifactOpenShell,
  type ImportedArtifact,
} from "./artifact.js";
import { compileBrief, type CompiledBrief } from "./brief.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import type { LocalConfig } from "./local.js";
import { Mailbox, MessageSchema, type MessageLifecycle } from "./message.js";
import { MetricStore } from "./metric.js";
import {
  resolveRoleModelRoute,
  routingPolicyDigest,
  type ResolvedModelRoute,
} from "./model.js";
import type { OpenShellPreflight, OpenShellSandbox } from "./openshell.js";
import {
  permissionRuntimeState,
  projectPermissionPolicyDigest,
  resolveRolePermissionCeiling,
  roleCanImplementTask,
  type PermissionCeiling,
} from "./permission.js";
import {
  catalogFromConfig,
  loadPlan,
  type LoadedPlan,
  type PlanTask,
} from "./plan.js";
import { importPatchArtifact, type VerifiedPatch } from "./patch.js";
import { loadSandboxPolicy } from "./policy.js";
import { loadProject, resolvePlanDirectory, type Project } from "./project.js";
import { AgentRegistry } from "./registry.js";
import { createReport, ReportStore, type Report } from "./report.js";
import type { LoadedRole } from "./role.js";
import {
  bundledPiPolicyDirectory,
  startWriteSession,
  type StartWriteSessionOptions,
  type WriteSessionInfo,
  type WriteSessionOpenShell,
} from "./agent.js";
import {
  ModelTurnResultSchema,
  SessionIdentitySchema,
  SessionSandboxSchema,
  type ModelTurnResult,
  type SessionIdentity,
} from "./session.js";
import { createSourceSnapshot, type SourceSnapshot } from "./snapshot.js";
import {
  createRunSourceWorkspace,
  verifyWorkspaceGateway,
  WritableWorkspaceSessionProjectionSchema,
  type CreateRunSourceWorkspaceOptions,
  type RunSourceWorkspace,
  type WorkspaceSourceManifest,
} from "./source.js";
import {
  WorkspaceLifecycle,
  changedPaths,
  type WritableSandboxProvenance,
} from "./lifecycle.js";
import type { ChangeSet } from "./change.js";
import type { Candidate } from "./candidate.js";
import type { WriteLease } from "./lease.js";
import {
  compareWorkspaceManifests,
  createWorkspaceManifestFromEntries,
  effectiveRestrictedPaths,
  type WorkspaceManifest,
} from "./workspace.js";
import { validateTaskWritePaths } from "./scope.js";
import type {
  ProjectRecord,
  ProjectStore,
  RunState,
  TaskRecord,
} from "./state.js";

const TextSchema = z.string().trim().min(1).max(8_000);
const TextListSchema = z.array(TextSchema).max(64);

export const ImplementationAssessmentSchema = z
  .object({
    summary: TextSchema,
    contracts_changed: TextListSchema,
    behavior_changed: TextListSchema,
    checks_attempted: TextListSchema,
    deviations: TextListSchema,
    risks: TextListSchema,
    questions: TextListSchema,
    downstream: TextListSchema,
  })
  .strict();
export type ImplementationAssessment = z.infer<
  typeof ImplementationAssessmentSchema
>;

export const IMPLEMENTATION_OUTPUT_CONTRACT = `Modify only /workspace/project and complete the approved Task. Run useful local checks when practical. Then return exactly one JSON object, optionally inside one JSON code fence, with this shape:
{
  "summary": "concise implementation summary",
  "contracts_changed": ["contract change or None"],
  "behavior_changed": ["behavior change"],
  "checks_attempted": ["command and result"],
  "deviations": ["deviation from the Task"],
  "risks": ["remaining risk"],
  "questions": ["unresolved question"],
  "downstream": ["information required by dependent Tasks"]
}
Use empty arrays when a section has nothing to report. Do not add prose outside the JSON object.`;

export function parseImplementationAssessment(
  text: string,
): ImplementationAssessment {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  try {
    return ImplementationAssessmentSchema.parse(JSON.parse(source) as unknown);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_implementation_output",
      "Implementer output is not one valid structured implementation object",
      { cause: error },
    );
  }
}

export type ImplementationOpenShell = WriteSessionOpenShell &
  ArtifactOpenShell & {
    readonly gateway?: string | undefined;
    listSandboxes(): Promise<OpenShellSandbox[]>;
  };

export interface ImplementationSession {
  readonly info: WriteSessionInfo;
  run(
    message: ReturnType<typeof MessageSchema.parse>,
    timeoutMs?: number,
  ): Promise<ModelTurnResult>;
  stop(): Promise<void>;
}

export interface RunImplementationOptions {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly runId: string;
  readonly taskId: string;
  readonly local: LocalConfig;
  readonly client: ImplementationOpenShell;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly temporaryRoot?: string;
  readonly nonce?: () => string;
  readonly now?: () => Date;
  readonly launchSession?: (
    options: StartWriteSessionOptions,
  ) => Promise<ImplementationSession>;
  readonly exportPatch?: (options: {
    readonly client: ImplementationOpenShell;
    readonly session: ImplementationSession;
    readonly identity: SessionIdentity;
    readonly task: PlanTask;
    readonly snapshot: SourceSnapshot;
    readonly artifacts: ArtifactStore;
    readonly artifactId: string;
    readonly temporaryRoot?: string;
  }) => Promise<ImportedArtifact<VerifiedPatch>>;
  readonly applyPatch?: typeof applyTaskPatch;
  readonly workspaceFactory?: (
    options: CreateRunSourceWorkspaceOptions,
  ) => Promise<RunSourceWorkspace>;
  readonly leaseDurationMs?: number;
}

export interface RunImplementationResult {
  readonly candidate: Candidate;
  readonly changeSet: ChangeSet;
  readonly report: Report;
  readonly reused: boolean;
  readonly task: TaskRecord;
  readonly identity: SessionIdentity;
}

function requireRunBinding(options: {
  readonly run: RunState;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly projectRecord: ProjectRecord;
}): void {
  const permissionPolicyDigest = projectPermissionPolicyDigest(
    options.project.roles,
  );
  const modelRoutingPolicyDigest = routingPolicyDigest(options.project.config);
  if (
    options.run.project_id !== options.project.config.project.id ||
    path.resolve(options.projectRecord.root) !== options.project.root
  ) {
    throw new OrchestratorError(
      "run_project_conflict",
      `Run '${options.run.id}' does not belong to the loaded Project`,
    );
  }
  if (
    options.run.plan_id !== options.plan.id ||
    options.run.plan_revision !== options.plan.revision ||
    options.run.plan_digest !== options.plan.digest
  ) {
    throw new OrchestratorError(
      "run_plan_stale",
      `Run '${options.run.id}' is not bound to the loaded Plan revision`,
    );
  }
  if (options.run.permission_policy_digest !== permissionPolicyDigest) {
    throw new OrchestratorError(
      "run_permission_policy_stale",
      `Run '${options.run.id}' was approved under another Role permission policy`,
    );
  }
  if (options.run.routing_policy_digest !== modelRoutingPolicyDigest) {
    throw new OrchestratorError(
      "run_routing_policy_stale",
      `Run '${options.run.id}' was approved under another Model routing policy`,
    );
  }
  requireFreshApproval(options.projectRecord.approvals[options.plan.id], {
    planId: options.run.plan_id,
    planRevision: options.run.plan_revision,
    planDigest: options.run.plan_digest,
    permissionPolicyDigest,
    routingPolicyDigest: modelRoutingPolicyDigest,
    baseCommit: options.run.base_commit,
  });
}

function findTask(plan: LoadedPlan, taskId: string): PlanTask {
  const parsed = IdentifierSchema.parse(taskId);
  const task = plan.tasks.find((candidate) => candidate.id === parsed);
  if (!task) {
    throw new OrchestratorError(
      "task_not_found",
      `Plan '${plan.id}' has no Task '${parsed}'`,
    );
  }
  return task;
}

function requireImplementerRole(project: Project, task: PlanTask): LoadedRole {
  const role = project.roles.get(task.role);
  if (!role) {
    throw new OrchestratorError(
      "role_not_found",
      `Task '${task.id}' Role '${task.role}' is unavailable`,
    );
  }
  if (!roleCanImplementTask(role.definition)) {
    throw new OrchestratorError(
      "invalid_implementation_role",
      `Task '${task.id}' Role '${task.role}' must explicitly permit Task writes and completion`,
    );
  }
  return role;
}

function requireTaskReady(
  state: TaskRecord,
  task: PlanTask,
  attemptLimit: number,
): asserts state is TaskRecord & { readonly input_commit: string } {
  if (!state.input_commit) {
    throw new OrchestratorError(
      "task_input_missing",
      `Task '${task.id}' has no accepted input commit`,
    );
  }
  if (
    state.status !== "ready" &&
    !(state.status === "rework" && !state.patch_application)
  ) {
    throw new OrchestratorError(
      "task_not_ready",
      `Task '${task.id}' cannot begin implementation while ${state.status}`,
    );
  }
  if (state.implementation_attempts >= attemptLimit) {
    throw new OrchestratorError(
      "implementation_attempt_limit",
      `Task '${task.id}' exhausted its implementation attempts`,
    );
  }
}

async function currentProjectAndPlan(options: {
  readonly project: Project;
  readonly plan: LoadedPlan;
}): Promise<{ readonly project: Project; readonly plan: LoadedPlan }> {
  const project = await loadProject(options.project.root);
  const plan = await loadPlan(
    resolvePlanDirectory(project.root, options.plan.id),
    catalogFromConfig(project.config),
  );
  if (plan.digest !== options.plan.digest) {
    throw new OrchestratorError(
      "run_plan_stale",
      `Plan '${options.plan.id}' changed during implementation`,
    );
  }
  return { project, plan };
}

async function dependencyReports(
  store: ReportStore,
  runId: string,
  task: PlanTask,
): Promise<Report[]> {
  const dependencies = new Set(task.depends);
  return (await store.list()).filter(
    (report) =>
      report.run === runId &&
      report.task !== undefined &&
      (report.task === task.id ||
        (report.kind === "implementation" && dependencies.has(report.task))),
  );
}

interface ImplementationCorrectionEvidence {
  readonly candidate: {
    readonly id: string;
    readonly digest: Digest;
    readonly manifest_digest: Digest;
    readonly git_diff_digest: Digest;
    readonly change_sets: Candidate["change_sets"];
  };
  readonly gates: TaskRecord["gates"];
}

function compileImplementationBrief(options: {
  readonly identity: SessionIdentity;
  readonly project: Project;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly task: PlanTask;
  readonly plan: LoadedPlan;
  readonly model: ResolvedModelRoute;
  readonly sourceDigest: Digest;
  readonly dependencies: readonly Report[];
  readonly correction?: ImplementationCorrectionEvidence;
}): CompiledBrief {
  const skills = options.role.definition.skills.map((name) => {
    const skill = options.project.skills.get(name);
    if (!skill) {
      throw new OrchestratorError(
        "unknown_skill",
        `Implementer Role references unavailable Skill '${name}'`,
      );
    }
    return skill;
  });
  const correction = options.correction
    ? canonicalJson(options.correction)
    : undefined;
  return compileBrief({
    identity: options.identity,
    agents: options.project.agents,
    role: options.role,
    permissionCeiling: options.permissionCeiling,
    model: options.model,
    task: options.task,
    plan: options.plan,
    decisions: [],
    dependencyReports: options.dependencies,
    skills,
    outputContract: correction
      ? `${IMPLEMENTATION_OUTPUT_CONTRACT}\n\nCurrent correction evidence is authoritative and replaces predecessor conversation context:\n${correction}`
      : IMPLEMENTATION_OUTPUT_CONTRACT,
    sourceAnchors: options.task.scope.map((scope) => ({
      path: scope,
      reason: "Approved writable Task scope.",
    })),
    sourceDigests: {
      plan: options.plan.digest,
      source: options.sourceDigest,
      ...(correction
        ? {
            correction: digestParts(
              "pi-orchestrator/implementation-correction/v1",
              [["evidence", correction]],
            ),
          }
        : {}),
    },
    contextLimitTokens: options.model.context_window,
    initialFraction: options.project.config.context.initial_fraction,
  });
}

function requirePinnedPreflight(
  preflight: OpenShellPreflight,
  model: ResolvedModelRoute,
): void {
  if (
    !preflight.requiredVersion ||
    preflight.versionMatches !== true ||
    preflight.requiredVersion !== preflight.installedVersion ||
    preflight.installedVersion !== preflight.status.version
  ) {
    throw new OrchestratorError(
      "implementation_openshell_unpinned",
      "Implementation Sessions require an exact, matching OpenShell version pin",
    );
  }
  if (preflight.status.gateway !== model.gateway) {
    throw new OrchestratorError(
      "model_gateway_mismatch",
      `Implementer model '${model.profile}' resolved to '${model.gateway}', but OpenShell reached '${preflight.status.gateway}'`,
    );
  }
}

async function allocateSession(options: {
  readonly registry: AgentRegistry;
  readonly task: PlanTask;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly attempt?: number;
  readonly nonce?: string;
}) {
  const agentId = "implementer";
  await options.registry.register({
    agent: agentId,
    role: options.task.role,
    profile: options.model.profile,
  });
  const agent = await options.registry.get(agentId);
  const sessionId = IdentifierSchema.parse(
    options.attempt === undefined
      ? `implementation-${options.nonce}`
      : `implementation-${options.task.id}-${options.attempt}`,
  );
  if (agent.record.session === null) {
    return options.registry.start({
      agent: agentId,
      session: sessionId,
      route: options.model,
      permissionCeilingDigest:
        options.permissionCeiling.permission_ceiling_digest,
    });
  }
  if (!agent.session || !["stopped", "failed"].includes(agent.session.status)) {
    throw new OrchestratorError(
      "implementation_session_active",
      `Implementer Agent already has nonterminal Session '${agent.record.session}'`,
    );
  }
  return options.registry.replace({
    expected: agent.session.identity,
    session: sessionId,
    reason: `Implementation attempt for Task '${options.task.id}'`,
    route: options.model,
    permissionCeilingDigest:
      options.permissionCeiling.permission_ceiling_digest,
  });
}

async function activateTask(options: {
  readonly store: ProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly attemptLimit: number;
}): Promise<TaskRecord> {
  const updated = await options.store.updateRun(options.runId, (run) => {
    const current = run.tasks[options.task.id];
    if (!current) {
      throw new OrchestratorError(
        "task_not_found",
        `Run '${run.id}' has no Task '${options.task.id}'`,
      );
    }
    if (!current.input_commit) {
      throw new OrchestratorError(
        "task_input_missing",
        `Task '${options.task.id}' has no accepted input commit`,
      );
    }
    if (
      current.status !== "ready" &&
      !(current.status === "rework" && !current.patch_application)
    ) {
      throw new OrchestratorError(
        "task_not_ready",
        `Task '${options.task.id}' cannot begin implementation while ${current.status}`,
      );
    }
    if (current.implementation_attempts >= options.attemptLimit) {
      throw new OrchestratorError(
        "implementation_attempt_limit",
        `Task '${options.task.id}' exhausted its implementation attempts`,
      );
    }
    const active = Object.values(run.tasks).find(
      (candidate) =>
        candidate.id !== options.task.id && candidate.status === "active",
    );
    if (active) {
      throw new OrchestratorError(
        "active_writer_conflict",
        `Task '${active.id}' is already the active implementation writer`,
      );
    }
    return {
      ...run,
      status: "active",
      tasks: {
        ...run.tasks,
        [options.task.id]: { ...current, status: "active" },
      },
    };
  });
  return updated.tasks[options.task.id]!;
}

async function markTaskRework(options: {
  readonly store: ProjectStore;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt?: number;
}): Promise<void> {
  await options.store.updateRun(options.runId, (run) => {
    const current = run.tasks[options.taskId];
    if (!current) {
      throw new OrchestratorError(
        "task_not_found",
        `Run '${run.id}' has no Task '${options.taskId}'`,
      );
    }
    if (
      current.status === "rework" &&
      current.implementation_attempts >=
        (options.attempt ?? current.implementation_attempts)
    )
      return run;
    if (!["ready", "active", "rework"].includes(current.status)) return run;
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.taskId]: {
          ...current,
          status: "rework",
          implementation_attempts: Math.max(
            current.implementation_attempts,
            options.attempt ?? current.implementation_attempts,
          ),
        },
      },
    };
  });
}

async function markTaskChecking(options: {
  readonly store: ProjectStore;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly candidate: Candidate;
}): Promise<TaskRecord> {
  const updated = await options.store.updateRun(options.runId, (run) => {
    const current = run.tasks[options.taskId];
    if (!current) {
      throw new OrchestratorError(
        "task_not_found",
        `Run '${run.id}' has no Task '${options.taskId}'`,
      );
    }
    if (
      run.workspace?.phase !== "frozen" ||
      run.workspace.candidate?.id !== options.candidate.id ||
      run.workspace.candidate.digest !== options.candidate.digest
    ) {
      throw new OrchestratorError(
        "candidate_stale",
        `Task '${options.taskId}' Candidate is not frozen in current Run state`,
      );
    }
    if (
      current.status === "checking" &&
      current.implementation_attempts >= options.attempt
    ) {
      return run;
    }
    if (current.status !== "active") {
      throw new OrchestratorError(
        "task_not_active",
        `Task '${options.taskId}' cannot enter checking while ${current.status}`,
      );
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.taskId]: {
          ...current,
          status: "checking",
          implementation_attempts: Math.max(
            current.implementation_attempts,
            options.attempt,
          ),
        },
      },
    };
  });
  return updated.tasks[options.taskId]!;
}

async function failSession(
  registry: AgentRegistry,
  identity: SessionIdentity,
  reason: string,
): Promise<void> {
  const current = await registry
    .requireCurrent(identity)
    .catch(() => undefined);
  if (!current || ["stopped", "failed"].includes(current.status)) return;
  await registry.transition(identity, {
    status: "failed",
    reason: reason.slice(0, 2_000),
  });
}

async function moveMessageIfPresent(
  mailbox: Mailbox,
  id: string,
  to: MessageLifecycle,
): Promise<void> {
  const stored = await mailbox.find(id);
  if (!stored || stored.lifecycle === to) return;
  await mailbox.move(id, stored.lifecycle, to);
}

function list(values: readonly string[]): string {
  return values.length === 0
    ? "None."
    : values.map((value) => `- ${value}`).join("\n");
}

function renderReport(options: {
  readonly assessment: ImplementationAssessment;
  readonly changes: readonly string[];
}): string {
  return `# Summary

${options.assessment.summary}

# Files changed

${list(options.changes)}

# Contracts changed

${list(options.assessment.contracts_changed)}

# Behavior changed

${list(options.assessment.behavior_changed)}

# Checks attempted

${list(options.assessment.checks_attempted)}

# Deviations

${list(options.assessment.deviations)}

# Risks

${list(options.assessment.risks)}

# Questions

${list(options.assessment.questions)}

# Downstream

${list(options.assessment.downstream)}
`;
}

async function exportPatch(options: {
  readonly client: ImplementationOpenShell;
  readonly session: ImplementationSession;
  readonly identity: SessionIdentity;
  readonly task: PlanTask;
  readonly snapshot: SourceSnapshot;
  readonly artifacts: ArtifactStore;
  readonly artifactId: string;
  readonly temporaryRoot?: string;
}): Promise<ImportedArtifact<VerifiedPatch>> {
  const exported = await options.client.execSandbox(
    options.session.info.sandbox.name,
    [
      "/usr/local/bin/orchestrator-export-patch",
      options.artifactId,
      options.task.id,
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (exported.exitCode !== 0) {
    const diagnostic = exported.stderr.trim() || exported.stdout.trim();
    throw new OrchestratorError(
      "patch_export_failed",
      `Implementer Patch export failed${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
    );
  }
  let descriptor;
  try {
    descriptor = ArtifactDescriptorSchema.parse(
      JSON.parse(exported.stdout) as unknown,
    );
  } catch (error) {
    throw new OrchestratorError(
      "invalid_artifact_descriptor",
      "Implementer Patch exporter returned an invalid descriptor",
      { cause: error },
    );
  }
  return importPatchArtifact({
    store: options.artifacts,
    client: options.client,
    descriptor,
    identity: options.identity,
    task: options.task.id,
    sourceSandbox: options.session.info.sandbox,
    snapshot: options.snapshot,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
}

function existingReport(options: {
  readonly reports: readonly Report[];
  readonly run: RunState;
  readonly task: PlanTask;
  readonly state: TaskRecord;
}): Report | undefined {
  const application = options.state.patch_application;
  if (!application || application.state !== "applied") return undefined;
  return options.reports.find(
    (report) =>
      report.run === options.run.id &&
      report.kind === "implementation" &&
      report.task === options.task.id &&
      report.agent === application.agent &&
      report.session === application.session &&
      report.generation === application.generation &&
      report.source_digest === application.source_digest &&
      report.patch_digest === application.sandbox_diff_digest,
  );
}

async function settleAppliedSession(options: {
  readonly client: ImplementationOpenShell;
  readonly registry: AgentRegistry;
  readonly state: TaskRecord;
}): Promise<void> {
  const application = options.state.patch_application;
  if (!application) return;
  const identity = SessionIdentitySchema.parse({
    run: options.registry.runId,
    agent: application.agent,
    session: application.session,
    generation: application.generation,
  });
  const current = await options.registry
    .requireCurrent(identity)
    .catch(() => undefined);
  if (!current || ["stopped", "failed"].includes(current.status)) return;
  if (!current.sandbox || current.sandbox.id !== application.sandbox_id) {
    throw new OrchestratorError(
      "implementation_session_mismatch",
      `Applied Task Session '${identity.session}' no longer matches its Sandbox`,
    );
  }
  await options.client.deleteSandbox(current.sandbox.name, { missingOk: true });
  await options.registry.transition(identity, {
    status: "stopped",
    reason: "Implementation recovered from durable Patch evidence",
  });
}

async function runLegacyImplementation(
  options: RunImplementationOptions,
): Promise<{
  readonly application: ApplyTaskPatchResult["application"];
  readonly report: Report;
  readonly reused: boolean;
  readonly task: TaskRecord;
  readonly identity: SessionIdentity;
}> {
  const now = options.now ?? (() => new Date());
  const [projectRecord, initialRun, current] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
    currentProjectAndPlan({ project: options.project, plan: options.plan }),
  ]);
  requireRunBinding({
    run: initialRun,
    project: current.project,
    plan: current.plan,
    projectRecord,
  });
  const task = findTask(current.plan, options.taskId);
  const initialTask = initialRun.tasks[task.id];
  if (!initialTask) {
    throw new OrchestratorError(
      "task_not_found",
      `Run '${initialRun.id}' has no Task '${task.id}'`,
    );
  }
  const registry = new AgentRegistry(options.store, initialRun.id, now);
  const reports = new ReportStore(options.store.runDirectory(initialRun.id));
  const priorReport = existingReport({
    reports: await reports.list(),
    run: initialRun,
    task,
    state: initialTask,
  });
  if (priorReport && initialTask.patch_application) {
    await settleAppliedSession({
      client: options.client,
      registry,
      state: initialTask,
    });
    return {
      application: initialTask.patch_application,
      report: priorReport,
      reused: true,
      task: initialTask,
      identity: SessionIdentitySchema.parse({
        run: initialRun.id,
        agent: initialTask.patch_application.agent,
        session: initialTask.patch_application.session,
        generation: initialTask.patch_application.generation,
      }),
    };
  }
  if (initialTask.patch_application) {
    throw new OrchestratorError(
      "implementation_evidence_incomplete",
      `Task '${task.id}' has Patch state without its exact implementation Report`,
    );
  }
  requireTaskReady(
    initialTask,
    task,
    current.project.config.attempts.implementation,
  );

  const role = requireImplementerRole(current.project, task);
  const permissionCeiling = resolveRolePermissionCeiling({
    role,
    assignment: { kind: "task", task: task.id },
    localPolicy: options.local.permissions,
  });
  const model = resolveRoleModelRoute(
    current.project.config,
    options.local,
    task.role,
  );
  const preflight = await options.client.preflight();
  requirePinnedPreflight(preflight, model);
  const policyDirectory = path.resolve(
    options.policyDirectory ?? bundledPiPolicyDirectory(),
  );
  const policy = await loadSandboxPolicy(
    "write",
    path.join(policyDirectory, "write.yaml"),
  );
  const snapshot = await createSourceSnapshot({
    projectRoot: current.project.root,
    commit: initialTask.input_commit,
    paths: ["."],
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  const mailbox = new Mailbox(options.store.runDirectory(initialRun.id));
  const metrics = new MetricStore(
    options.store.runDirectory(initialRun.id),
    initialRun.id,
  );
  const artifacts = new ArtifactStore(
    options.store.runDirectory(initialRun.id),
  );
  const rawNonce = (options.nonce ?? (() => randomBytes(4).toString("hex")))();
  const nonce = z
    .string()
    .regex(/^[a-f0-9]{8}$/)
    .parse(rawNonce);
  const sessionRecord = await allocateSession({
    registry,
    task,
    model,
    permissionCeiling,
    nonce,
  });
  const identity = sessionRecord.identity;
  const brief = compileImplementationBrief({
    identity,
    project: current.project,
    role,
    permissionCeiling,
    task,
    plan: current.plan,
    model,
    sourceDigest: snapshot.manifest.source_digest as Digest,
    dependencies: await dependencyReports(reports, initialRun.id, task),
  });
  const message = MessageSchema.parse({
    version: 2,
    id: `implementation-request-${nonce}`,
    run: initialRun.id,
    from: { host: true },
    to: {
      agent: identity.agent,
      session: identity.session,
      generation: identity.generation,
    },
    type: "implementation-request",
    priority: "normal",
    reply_to: null,
    body: {
      action: "implement",
      task: task.id,
      brief_digest: brief.digest,
      instruction:
        "Implement exactly the approved Task in /workspace/project and return the required structured object.",
    },
    references: [...task.scope],
    created_at: now().toISOString(),
  });
  const artifactId = `implementation-patch-${nonce}`;
  let session: ImplementationSession | undefined;
  let activated = false;
  try {
    session = await (options.launchSession ?? startWriteSession)({
      client: options.client,
      identity,
      snapshot,
      permissionCeiling,
      writeGrant: { task: task.id },
      model,
      brief,
      context: current.project.config.context,
      metrics,
      task: task.id,
      currentActionState: async () =>
        permissionRuntimeState({
          ceiling: permissionCeiling,
          identity,
          run: await options.store.readRun(initialRun.id),
        }),
      now,
      policyDirectory,
      ...(options.imageContext ? { imageContext: options.imageContext } : {}),
      ...(options.startupTimeoutMs
        ? { startupTimeoutMs: options.startupTimeoutMs }
        : {}),
      ...(options.turnTimeoutMs
        ? { turnTimeoutMs: options.turnTimeoutMs }
        : {}),
    });
    if (
      session.info.profile !== "write" ||
      session.info.permissionCeiling.permission_ceiling_digest !==
        permissionCeiling.permission_ceiling_digest ||
      canonicalJson(session.info.identity) !== canonicalJson(identity) ||
      session.info.sourceDigest !== snapshot.manifest.source_digest ||
      session.info.policyDigest !== policy.digest ||
      session.info.briefDigest !== brief.digest ||
      canonicalJson(session.info.model) !== canonicalJson(model) ||
      session.info.inference?.model !== model.pi_model
    ) {
      throw new OrchestratorError(
        "implementation_session_mismatch",
        "Fresh implementation Session does not match its source, Brief, model, or policy",
      );
    }
    requirePinnedPreflight(session.info.openshell, model);
    const sandbox = SessionSandboxSchema.parse({
      id: session.info.sandbox.id,
      name: session.info.sandbox.name,
      workspace: session.info.sandbox.workspace,
    });
    await registry.bindSandbox(identity, sandbox);
    await registry.transition(identity, { status: "active" });
    await activateTask({
      store: options.store,
      runId: initialRun.id,
      task,
      attemptLimit: current.project.config.attempts.implementation,
    });
    activated = true;
    await mailbox.put(message);
    const turn = ModelTurnResultSchema.parse(
      await session.run(message, options.turnTimeoutMs),
    );
    await moveMessageIfPresent(mailbox, message.id, "queued");
    if (turn.truncated) {
      throw new OrchestratorError(
        "implementation_output_truncated",
        `Implementer output exceeded the Link result limit for Task '${task.id}'`,
      );
    }
    const assessment = parseImplementationAssessment(turn.text);
    const imported = await (options.exportPatch ?? exportPatch)({
      client: options.client,
      session,
      identity,
      task,
      snapshot,
      artifacts,
      artifactId,
      ...(options.temporaryRoot
        ? { temporaryRoot: options.temporaryRoot }
        : {}),
    });
    const report = createReport({
      id: `implementation-${nonce}`,
      kind: "implementation",
      run: initialRun.id,
      agent: identity.agent,
      session: identity.session,
      generation: identity.generation,
      permission_ceiling_digest: permissionCeiling.permission_ceiling_digest,
      model_profile: model.profile,
      route_digest: model.route_digest,
      task: task.id,
      source_digest: snapshot.manifest.source_digest,
      patch_digest: imported.value.bundle.diff_digest,
      content: renderReport({
        assessment,
        changes: imported.value.bundle.changes.map((change) => change.path),
      }),
      created_at: now().toISOString(),
    });
    await reports.put(report);

    const latest = await currentProjectAndPlan({
      project: current.project,
      plan: current.plan,
    });
    const applied = await (options.applyPatch ?? applyTaskPatch)({
      store: options.store,
      project: latest.project,
      plan: latest.plan,
      runId: initialRun.id,
      taskId: task.id,
      patch: imported,
      now: now(),
    });
    await moveMessageIfPresent(mailbox, message.id, "answered");
    await session.stop();
    await registry.transition(identity, {
      status: "stopped",
      reason: "Implementation completed and Patch imported",
    });
    return {
      application: applied.application,
      report,
      reused: false,
      task: applied.task,
      identity,
    };
  } catch (error) {
    const cleanup: string[] = [];
    await moveMessageIfPresent(mailbox, message.id, "expired").catch(
      (cleanupError: unknown) => {
        cleanup.push(`Message: ${formatUnknownError(cleanupError)}`);
      },
    );
    await session?.stop().catch((cleanupError: unknown) => {
      cleanup.push(`Sandbox: ${formatUnknownError(cleanupError)}`);
    });
    await failSession(
      registry,
      identity,
      `Implementation failed: ${formatUnknownError(error)}`,
    ).catch((cleanupError: unknown) => {
      cleanup.push(`Session: ${formatUnknownError(cleanupError)}`);
    });
    if (activated) {
      await markTaskRework({
        store: options.store,
        runId: initialRun.id,
        taskId: task.id,
      }).catch((cleanupError: unknown) => {
        cleanup.push(`Task: ${formatUnknownError(cleanupError)}`);
      });
    }
    if (cleanup.length > 0) {
      throw new OrchestratorError(
        "implementation_cleanup_failed",
        `Implementation failed (${formatUnknownError(error)}); cleanup also failed: ${cleanup.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await snapshot.dispose();
  }
}

void runLegacyImplementation;

function workspaceManifest(source: WorkspaceSourceManifest): WorkspaceManifest {
  return createWorkspaceManifestFromEntries(source.entries);
}

function implementationAttempt(id: string, fallback: number): number {
  const match = /-(\d+)$/u.exec(id);
  const parsed = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function implementationIds(task: string, attempt: number) {
  const suffix = `${task}-${attempt}`;
  return Object.freeze({
    session: IdentifierSchema.parse(`implementation-${suffix}`),
    request: IdentifierSchema.parse(`implementation-request-${suffix}`),
    report: IdentifierSchema.parse(`implementation-${suffix}`),
    lease: IdentifierSchema.parse(`lease-${suffix}`),
    changeSet: IdentifierSchema.parse(`change-${suffix}`),
    candidate: IdentifierSchema.parse(`candidate-${suffix}`),
    sandbox: `pio-w-${sha256(suffix).slice("sha256:".length, 19)}`,
  });
}

function sandboxProvenanceDigest(
  sandbox: ReturnType<typeof SessionSandboxSchema.parse>,
): Digest {
  return digestParts("pi-orchestrator/writable-sandbox/v1", [
    ["sandbox", canonicalJson(sandbox)],
  ]);
}

async function writableSandboxes(
  client: ImplementationOpenShell,
  runId: string,
): Promise<OpenShellSandbox[]> {
  return (await client.listSandboxes()).filter(
    (sandbox) =>
      sandbox.labels["pio.run"] === runId &&
      sandbox.labels["pio.access"] === "write",
  );
}

async function requireWriterAbsence(options: {
  readonly lifecycle: WorkspaceLifecycle;
  readonly lease: WriteLease;
  readonly sandboxes: readonly OpenShellSandbox[];
}): Promise<void> {
  if (options.sandboxes.length === 0) return;
  const reason = `Writable Sandboxes remain after revocation: ${options.sandboxes
    .map((sandbox) => sandbox.id)
    .join(", ")}`;
  await options.lifecycle.block(options.lease.id, reason);
  throw new OrchestratorError("writable_sandbox_present", reason);
}

async function stopPersistedWriter(options: {
  readonly client: ImplementationOpenShell;
  readonly lease: WriteLease;
  readonly session?: ImplementationSession;
}): Promise<void> {
  let stopError: unknown;
  if (options.session) {
    try {
      await options.session.stop();
    } catch (error) {
      stopError = error;
    }
  }
  await options.client.deleteSandbox(options.lease.sandbox_name, {
    missingOk: true,
  });
  if (stopError) throw stopError;
}

async function settleSession(options: {
  readonly registry: AgentRegistry;
  readonly identity: SessionIdentity;
  readonly status: "stopped" | "failed";
  readonly reason: string;
}): Promise<void> {
  const current = await options.registry
    .requireCurrent(options.identity)
    .catch(() => undefined);
  if (!current || ["stopped", "failed"].includes(current.status)) return;
  await options.registry.transition(options.identity, {
    status: options.status,
    reason: options.reason,
  });
}

async function settleOrphanedImplementer(options: {
  readonly registry: AgentRegistry;
  readonly store: ProjectStore;
  readonly run: RunState;
  readonly task: PlanTask;
}): Promise<void> {
  if (options.run.workspace?.active_lease) return;
  const agent = options.run.agents.implementer;
  if (!agent?.session) return;
  const session = options.run.sessions[agent.session];
  if (!session || ["stopped", "failed"].includes(session.status)) return;
  if (
    !session.identity.session.startsWith(`implementation-${options.task.id}-`)
  ) {
    throw new OrchestratorError(
      "implementation_session_active",
      `Orphaned Implementer Session '${session.identity.session}' does not belong to Task '${options.task.id}'`,
    );
  }
  const attempt = implementationAttempt(
    session.identity.session,
    options.run.tasks[options.task.id]!.implementation_attempts + 1,
  );
  await settleSession({
    registry: options.registry,
    identity: session.identity,
    status: "failed",
    reason: "Implementation Session had no durable Write Lease",
  });
  await markTaskRework({
    store: options.store,
    runId: options.run.id,
    taskId: options.task.id,
    attempt,
  });
}

async function exactCandidateResult(options: {
  readonly lifecycle: WorkspaceLifecycle;
  readonly reports: ReportStore;
  readonly candidate: Candidate;
  readonly task: TaskRecord;
}): Promise<RunImplementationResult> {
  const reference = options.candidate.change_sets.at(-1);
  if (!reference) {
    throw new OrchestratorError(
      "implementation_evidence_incomplete",
      `Candidate '${options.candidate.id}' has no Change Set`,
    );
  }
  const changeSet = await options.lifecycle.changes.get(reference);
  if (!changeSet.report) {
    throw new OrchestratorError(
      "implementation_evidence_incomplete",
      `Candidate '${options.candidate.id}' has no implementation Report`,
    );
  }
  return {
    candidate: options.candidate,
    changeSet,
    report: await options.reports.get(changeSet.report),
    reused: true,
    task: options.task,
    identity: changeSet.identity,
  };
}

async function emitWorkspaceChanged(options: {
  readonly store: ProjectStore;
  readonly mailbox: Mailbox;
  readonly runId: string;
  readonly source: WorkspaceSourceManifest;
  readonly changeSet: ChangeSet;
  readonly candidate: Candidate;
  readonly sender: string;
  readonly createdAt: string;
}): Promise<void> {
  const run = await options.store.readRun(options.runId);
  const references = changedPaths(options.changeSet.changes);
  await Promise.all(
    Object.entries(run.agents).map(async ([agent, record]) => {
      if (agent === options.sender || !record.session) return;
      const session = run.sessions[record.session];
      if (!session || ["stopped", "failed"].includes(session.status)) return;
      await options.mailbox.put(
        MessageSchema.parse({
          version: 2,
          id: `workspace-changed-${options.source.workspace_generation}-${agent}`,
          run: run.id,
          from: { host: true },
          to: {
            agent,
            session: record.session,
            generation: record.generation,
          },
          type: "workspace-changed",
          priority: "normal",
          reply_to: null,
          body: {
            workspace_generation: options.source.workspace_generation,
            source_digest: options.source.source_digest,
            manifest_digest: options.source.manifest_digest,
            change_set: options.changeSet.id,
            change_set_digest: options.changeSet.digest,
            candidate: options.candidate.id,
            candidate_digest: options.candidate.digest,
          },
          references,
          created_at: options.createdAt,
        }),
      );
    }),
  );
}

export async function runImplementation(
  options: RunImplementationOptions,
): Promise<RunImplementationResult> {
  if (options.imageContext) {
    throw new OrchestratorError(
      "derived_writer_disabled",
      "Shared-Workspace Implementers require the configured pinned image; derived writer images are disabled",
    );
  }
  const now = options.now ?? (() => new Date());
  const [projectRecord, initialRun, current] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
    currentProjectAndPlan({ project: options.project, plan: options.plan }),
  ]);
  requireRunBinding({
    run: initialRun,
    project: current.project,
    plan: current.plan,
    projectRecord,
  });
  const task = findTask(current.plan, options.taskId);
  let taskState = initialRun.tasks[task.id];
  if (!taskState) {
    throw new OrchestratorError(
      "task_not_found",
      `Run '${initialRun.id}' has no Task '${task.id}'`,
    );
  }
  if (!taskState.input_commit) {
    throw new OrchestratorError(
      "task_input_missing",
      `Task '${task.id}' has no accepted input commit`,
    );
  }

  const lifecycle = new WorkspaceLifecycle(options.store, initialRun.id, now);
  const registry = new AgentRegistry(options.store, initialRun.id, now);
  const reports = new ReportStore(options.store.runDirectory(initialRun.id));
  const mailbox = new Mailbox(options.store.runDirectory(initialRun.id));
  const metrics = new MetricStore(
    options.store.runDirectory(initialRun.id),
    initialRun.id,
  );
  const protectedPatterns = current.project.config.protected;
  const restrictedPatterns = effectiveRestrictedPaths(
    current.project.config.restricted_paths,
    options.local.workspace.restricted_paths,
  );
  const workspace = await (
    options.workspaceFactory ?? createRunSourceWorkspace
  )({
    projectRoot: current.project.root,
    projectId: current.project.config.project.id,
    runId: initialRun.id,
    commit: initialRun.base_commit,
    local: options.local,
    ...(initialRun.workspace
      ? {
          binding: {
            volumeName: initialRun.workspace.volume_name,
            volumeDigest: initialRun.workspace.volume_digest,
          },
        }
      : {}),
  });

  let run = await options.store.readRun(initialRun.id);
  let source!: WorkspaceSourceManifest;
  let manifest!: WorkspaceManifest;
  let gitDiff!: Awaited<ReturnType<RunSourceWorkspace["gitDiff"]>>;
  let writers = await writableSandboxes(options.client, initialRun.id);
  if (writers.length > 0 && !run.workspace?.active_lease) {
    if (run.workspace) {
      await lifecycle.blockUnleasedWriters(writers.map((entry) => entry.id));
    }
    await options.store.updateRun(run.id, (currentRun) => ({
      ...currentRun,
      status: "blocked",
    }));
    throw new OrchestratorError(
      "writable_sandbox_without_lease",
      "A writable Sandbox exists before Run Workspace initialization",
    );
  }
  if (!run.workspace || !run.workspace.active_lease) {
    source = await workspace.inspect(run.workspace?.generation ?? 0);
    manifest = workspaceManifest(source);
    gitDiff = await workspace.gitDiff(source);
  }
  if (!run.workspace) {
    if (gitDiff.changes.length > 0) {
      throw new OrchestratorError(
        "workspace_seed_mismatch",
        "The initial Run Workspace differs from its approved base commit",
      );
    }
    run = await lifecycle.initialize({
      volumeName: workspace.volume.name,
      volumeDigest: workspace.volume.digest,
      manifest,
      gitDiff,
    });
  } else if (!run.workspace.active_lease) {
    await lifecycle.observe({
      manifest,
      gitDiff,
      writableSandboxIds: writers.map((entry) => entry.id),
    });
  }

  run = await options.store.readRun(initialRun.id);
  taskState = run.tasks[task.id]!;
  let correction: ImplementationCorrectionEvidence | undefined;
  if (
    taskState.status === "rework" &&
    run.workspace?.candidate?.status === "frozen"
  ) {
    const frozen = await lifecycle.candidates.get(run.workspace.candidate);
    if (frozen.task !== task.id) {
      throw new OrchestratorError(
        "candidate_frozen",
        `Run '${run.id}' has a frozen Candidate for Task '${frozen.task}'`,
      );
    }
    correction = {
      candidate: {
        id: frozen.id,
        digest: frozen.digest,
        manifest_digest: frozen.manifest_digest,
        git_diff_digest: frozen.git_diff_digest,
        change_sets: frozen.change_sets,
      },
      gates: taskState.gates,
    };
    await lifecycle.transitionCandidate(
      frozen.id,
      "discarded",
      "Task entered rework",
    );
    run = await options.store.readRun(initialRun.id);
  } else if (run.workspace?.candidate?.status === "frozen") {
    const candidate = await lifecycle.candidates.get(run.workspace.candidate);
    if (candidate.task !== task.id) {
      throw new OrchestratorError(
        "candidate_frozen",
        `Run '${run.id}' has a frozen Candidate for Task '${candidate.task}'`,
      );
    }
    if (taskState.status === "active") {
      taskState = await markTaskChecking({
        store: options.store,
        runId: run.id,
        taskId: task.id,
        attempt: implementationAttempt(
          candidate.id,
          taskState.implementation_attempts + 1,
        ),
        candidate,
      });
    }
    const result = await exactCandidateResult({
      lifecycle,
      reports,
      candidate,
      task: taskState,
    });
    await settleSession({
      registry,
      identity: result.identity,
      status: "stopped",
      reason: "Implementation recovered from a frozen Candidate",
    });
    await emitWorkspaceChanged({
      store: options.store,
      mailbox,
      runId: run.id,
      source,
      changeSet: result.changeSet,
      candidate,
      sender: result.identity.agent,
      createdAt: candidate.frozen_at,
    });
    return result;
  }

  const activeReference = run.workspace?.active_lease;
  if (activeReference) {
    let lease = await lifecycle.leases.get(activeReference);
    if (lease.task !== task.id) {
      throw new OrchestratorError(
        "active_writer_conflict",
        `Task '${lease.task}' owns the active Write Lease`,
      );
    }
    const attempt = implementationAttempt(
      lease.id,
      taskState.implementation_attempts + 1,
    );
    const ids = implementationIds(task.id, attempt);
    const wasPreparing = lease.status === "preparing";
    const baseline = await lifecycle.manifests.get(
      lease.baseline_manifest_digest,
    );
    lease = await lifecycle.beginRevocation(lease.id);
    await stopPersistedWriter({ client: options.client, lease });
    writers = await writableSandboxes(options.client, run.id);
    await requireWriterAbsence({ lifecycle, lease, sandboxes: writers });
    source = await workspace.inspect(lease.workspace_generation + 1);
    manifest = workspaceManifest(source);
    gitDiff = await workspace.gitDiff(source);
    const delta = compareWorkspaceManifests(baseline, manifest);
    if (wasPreparing && delta.length > 0) {
      await lifecycle.block(
        lease.id,
        "Workspace changed before writable Sandbox activation",
        now().toISOString(),
      );
      throw new OrchestratorError(
        "write_lease_provenance_mismatch",
        "A preparing Write Lease cannot explain Workspace changes",
      );
    }
    const report = (await reports.list()).find(
      (entry) =>
        entry.id === ids.report &&
        entry.run === run.id &&
        entry.kind === "implementation" &&
        entry.task === task.id &&
        entry.agent === lease.identity.agent &&
        entry.session === lease.identity.session &&
        entry.generation === lease.identity.generation &&
        entry.patch_digest === gitDiff.digest,
    );
    const changeSet = await lifecycle.release({
      leaseId: lease.id,
      changeSetId: ids.changeSet,
      task,
      baselineManifest: baseline,
      resultManifest: manifest,
      gitDiff,
      protectedPatterns,
      restrictedPatterns,
      deletedSandboxId: lease.sandbox_id,
      writableSandboxIds: writers.map((entry) => entry.id),
      ...(report ? { report: report.id } : {}),
    });
    await moveMessageIfPresent(mailbox, ids.request, "expired").catch(
      () => undefined,
    );
    if (!report) {
      await settleSession({
        registry,
        identity: lease.identity,
        status: "failed",
        reason: "Interrupted Implementer was revoked without a durable Report",
      });
      await markTaskRework({
        store: options.store,
        runId: run.id,
        taskId: task.id,
        attempt,
      });
      run = await options.store.readRun(run.id);
      taskState = run.tasks[task.id]!;
    } else {
      await settleSession({
        registry,
        identity: lease.identity,
        status: "stopped",
        reason: "Implementation recovered from durable Workspace evidence",
      });
      const candidate = await lifecycle.freeze({
        id: ids.candidate,
        task,
        manifest,
        gitDiff,
        protectedPatterns,
        restrictedPatterns,
        writableSandboxIds: [],
      });
      taskState = await markTaskChecking({
        store: options.store,
        runId: run.id,
        taskId: task.id,
        attempt,
        candidate,
      });
      await emitWorkspaceChanged({
        store: options.store,
        mailbox,
        runId: run.id,
        source,
        changeSet,
        candidate,
        sender: lease.identity.agent,
        createdAt: candidate.frozen_at,
      });
      return {
        candidate,
        changeSet,
        report,
        reused: true,
        task: taskState,
        identity: lease.identity,
      };
    }
  }

  run = await options.store.readRun(initialRun.id);
  taskState = run.tasks[task.id]!;
  source = await workspace.inspect(run.workspace!.generation);
  manifest = workspaceManifest(source);
  gitDiff = await workspace.gitDiff(source);
  writers = await writableSandboxes(options.client, run.id);
  await lifecycle.observe({
    manifest,
    gitDiff,
    writableSandboxIds: writers.map((entry) => entry.id),
  });

  if (taskState.status === "active" && run.workspace?.phase === "stable") {
    const reference = run.workspace.change_sets.at(-1);
    if (reference) {
      const changeSet = await lifecycle.changes.get(reference);
      if (
        changeSet.task === task.id &&
        changeSet.result_generation === run.workspace.generation &&
        changeSet.result_manifest_digest === manifest.digest &&
        changeSet.report
      ) {
        const attempt = implementationAttempt(
          changeSet.lease.id,
          taskState.implementation_attempts + 1,
        );
        const candidate = await lifecycle.freeze({
          id: implementationIds(task.id, attempt).candidate,
          task,
          manifest,
          gitDiff,
          protectedPatterns,
          restrictedPatterns,
          writableSandboxIds: [],
        });
        taskState = await markTaskChecking({
          store: options.store,
          runId: run.id,
          taskId: task.id,
          attempt,
          candidate,
        });
        await settleSession({
          registry,
          identity: changeSet.identity,
          status: "stopped",
          reason: "Implementation recovered from a durable Change Set",
        });
        await emitWorkspaceChanged({
          store: options.store,
          mailbox,
          runId: run.id,
          source,
          changeSet,
          candidate,
          sender: changeSet.identity.agent,
          createdAt: candidate.frozen_at,
        });
        return {
          candidate,
          changeSet,
          report: await reports.get(changeSet.report),
          reused: true,
          task: taskState,
          identity: changeSet.identity,
        };
      }
    }
  }

  run = await options.store.readRun(initialRun.id);
  await settleOrphanedImplementer({
    registry,
    store: options.store,
    run,
    task,
  });
  run = await options.store.readRun(initialRun.id);
  taskState = run.tasks[task.id]!;
  requireTaskReady(
    taskState,
    task,
    current.project.config.attempts.implementation,
  );
  const role = requireImplementerRole(current.project, task);
  const permissionCeiling = resolveRolePermissionCeiling({
    role,
    assignment: { kind: "task", task: task.id },
    localPolicy: options.local.permissions,
  });
  const model = resolveRoleModelRoute(
    current.project.config,
    options.local,
    task.role,
  );
  const preflight = await options.client.preflight();
  requirePinnedPreflight(preflight, model);
  if (
    !options.client.gateway ||
    !options.client.listGateways ||
    !options.client.getGatewayInfo
  ) {
    throw new OrchestratorError(
      "workspace_gateway_uninspectable",
      "Writable Workspace Sessions require inspectable local gateway provenance",
    );
  }
  const gateway = await verifyWorkspaceGateway(
    workspace,
    {
      gateway: options.client.gateway,
      listGateways: options.client.listGateways.bind(options.client),
      getGatewayInfo: options.client.getGatewayInfo.bind(options.client),
    },
    preflight,
  );
  const policyDirectory = path.resolve(
    options.policyDirectory ?? bundledPiPolicyDirectory(),
  );
  const policy = await loadSandboxPolicy(
    "write",
    path.join(policyDirectory, "write.yaml"),
  );
  const writePolicy = validateTaskWritePaths({
    task,
    protectedPatterns,
    restrictedPatterns,
  });
  const mountSet = workspace.writeMountSet({
    source,
    writePaths: writePolicy.writePaths,
    protectedPatterns,
    restrictedPatterns,
  });
  const attempt = taskState.implementation_attempts + 1;
  const ids = implementationIds(task.id, attempt);
  const dependencies = await dependencyReports(reports, run.id, task);
  const sessionRecord = await allocateSession({
    registry,
    task,
    model,
    permissionCeiling,
    attempt,
  });
  const identity = sessionRecord.identity;
  let brief: CompiledBrief;
  let message: ReturnType<typeof MessageSchema.parse>;
  try {
    brief = compileImplementationBrief({
      identity,
      project: current.project,
      role,
      permissionCeiling,
      task,
      plan: current.plan,
      model,
      sourceDigest: source.source_digest,
      dependencies,
      ...(correction ? { correction } : {}),
    });
    message = MessageSchema.parse({
      version: 2,
      id: ids.request,
      run: run.id,
      from: { host: true },
      to: {
        agent: identity.agent,
        session: identity.session,
        generation: identity.generation,
      },
      type: "implementation-request",
      priority: "normal",
      reply_to: null,
      body: {
        action: "implement",
        task: task.id,
        brief_digest: brief.digest,
        workspace_generation: source.workspace_generation,
        instruction:
          "Implement exactly the approved Task in /workspace/project and return the required structured object.",
      },
      references: [...task.scope],
      created_at: now().toISOString(),
    });
  } catch (error) {
    await settleSession({
      registry,
      identity,
      status: "failed",
      reason: `Implementation Brief failed: ${formatUnknownError(error)}`,
    });
    await markTaskRework({
      store: options.store,
      runId: run.id,
      taskId: task.id,
      attempt,
    });
    throw error;
  }

  let lease: WriteLease | undefined;
  let session: ImplementationSession | undefined;
  let report: Report | undefined;
  let released = false;
  let completed = false;
  try {
    lease = await lifecycle.acquire({
      id: ids.lease,
      task,
      identity,
      permissionCeiling,
      baselineManifest: manifest,
      protectedPatterns,
      restrictedPatterns,
      expiresAt: new Date(
        now().getTime() + (options.leaseDurationMs ?? 30 * 60_000),
      ).toISOString(),
      sandboxName: ids.sandbox,
      sandboxWorkspace: "default",
      policyDigest: policy.digest,
      imageDigest: workspace.imageDigest,
      gatewayDigest: gateway.digest,
      mountSetDigest: mountSet.digest,
    });
    taskState = await activateTask({
      store: options.store,
      runId: run.id,
      task,
      attemptLimit: current.project.config.attempts.implementation,
    });
    const writer = workspace.bindWriter({
      source,
      mountSet,
      lease,
      gatewayDigest: gateway.digest,
    });
    session = await (options.launchSession ?? startWriteSession)({
      client: options.client,
      identity,
      workspace: writer,
      permissionCeiling,
      writeGrant: { task: task.id },
      model,
      brief,
      context: current.project.config.context,
      metrics,
      task: task.id,
      currentActionState: async () =>
        permissionRuntimeState({
          ceiling: permissionCeiling,
          identity,
          run: await options.store.readRun(run.id),
        }),
      now,
      policyDirectory,
      sandboxName: ids.sandbox,
      ...(options.startupTimeoutMs
        ? { startupTimeoutMs: options.startupTimeoutMs }
        : {}),
      ...(options.turnTimeoutMs
        ? { turnTimeoutMs: options.turnTimeoutMs }
        : {}),
    });
    const projection = WritableWorkspaceSessionProjectionSchema.parse(
      session.info.workspaceProjection,
    );
    if (
      session.info.profile !== "write" ||
      session.info.permissionCeiling.permission_ceiling_digest !==
        permissionCeiling.permission_ceiling_digest ||
      canonicalJson(session.info.identity) !== canonicalJson(identity) ||
      session.info.sourceDigest !== source.source_digest ||
      session.info.policyDigest !== policy.digest ||
      session.info.briefDigest !== brief.digest ||
      canonicalJson(session.info.model) !== canonicalJson(model) ||
      session.info.inference?.model !== model.pi_model ||
      session.info.sandbox.name !== ids.sandbox ||
      session.info.sandbox.workspace !== lease.sandbox_workspace ||
      projection.lease_id !== lease.id ||
      projection.lease_digest !== lease.digest ||
      projection.mount_set_digest !== mountSet.digest ||
      projection.gateway_digest !== gateway.digest ||
      projection.source_digest !== source.source_digest
    ) {
      throw new OrchestratorError(
        "implementation_session_mismatch",
        "Writable implementation Session does not match its Lease, Workspace, Brief, model, or policy",
      );
    }
    requirePinnedPreflight(session.info.openshell, model);
    const sandbox = SessionSandboxSchema.parse({
      id: session.info.sandbox.id,
      name: session.info.sandbox.name,
      workspace: session.info.sandbox.workspace,
      projection,
    });
    await registry.bindSandbox(identity, sandbox);
    const provenance: WritableSandboxProvenance = {
      id: sandbox.id,
      name: sandbox.name,
      workspace: sandbox.workspace,
      gatewayDigest: gateway.digest,
      mountSetDigest: projection.mount_set_digest,
      mountTableDigest: projection.mount_table_digest,
      sandboxDigest: sandboxProvenanceDigest(sandbox),
    };
    lease = await lifecycle.activate(lease.id, provenance);
    await registry.transition(identity, { status: "active" });
    await mailbox.put(message);
    const turn = ModelTurnResultSchema.parse(
      await session.run(message, options.turnTimeoutMs),
    );
    await moveMessageIfPresent(mailbox, message.id, "queued");
    if (turn.truncated) {
      throw new OrchestratorError(
        "implementation_output_truncated",
        `Implementer output exceeded the Link result limit for Task '${task.id}'`,
      );
    }
    const assessment = parseImplementationAssessment(turn.text);

    lease = await lifecycle.beginRevocation(lease.id);
    await stopPersistedWriter({ client: options.client, lease, session });
    session = undefined;
    writers = await writableSandboxes(options.client, run.id);
    await requireWriterAbsence({ lifecycle, lease, sandboxes: writers });
    const resultSource = await workspace.inspect(
      lease.workspace_generation + 1,
    );
    const resultManifest = workspaceManifest(resultSource);
    const resultGitDiff = await workspace.gitDiff(resultSource);
    const changes = compareWorkspaceManifests(manifest, resultManifest);
    report = createReport({
      id: ids.report,
      kind: "implementation",
      run: run.id,
      agent: identity.agent,
      session: identity.session,
      generation: identity.generation,
      permission_ceiling_digest: permissionCeiling.permission_ceiling_digest,
      model_profile: model.profile,
      route_digest: model.route_digest,
      task: task.id,
      source_digest: source.source_digest,
      patch_digest: resultGitDiff.digest,
      content: renderReport({
        assessment,
        changes: changedPaths(changes),
      }),
      created_at: now().toISOString(),
    });
    await reports.put(report);
    const changeSet = await lifecycle.release({
      leaseId: lease.id,
      changeSetId: ids.changeSet,
      task,
      baselineManifest: manifest,
      resultManifest,
      gitDiff: resultGitDiff,
      protectedPatterns,
      restrictedPatterns,
      deletedSandboxId: lease.sandbox_id,
      writableSandboxIds: writers.map((entry) => entry.id),
      report: report.id,
    });
    released = true;
    const candidate = await lifecycle.freeze({
      id: ids.candidate,
      task,
      manifest: resultManifest,
      gitDiff: resultGitDiff,
      protectedPatterns,
      restrictedPatterns,
      writableSandboxIds: [],
    });
    taskState = await markTaskChecking({
      store: options.store,
      runId: run.id,
      taskId: task.id,
      attempt,
      candidate,
    });
    await moveMessageIfPresent(mailbox, message.id, "answered");
    await settleSession({
      registry,
      identity,
      status: "stopped",
      reason: "Implementation produced a frozen Candidate",
    });
    await emitWorkspaceChanged({
      store: options.store,
      mailbox,
      runId: run.id,
      source: resultSource,
      changeSet,
      candidate,
      sender: identity.agent,
      createdAt: candidate.frozen_at,
    });
    completed = true;
    return {
      candidate,
      changeSet,
      report,
      reused: false,
      task: taskState,
      identity,
    };
  } catch (error) {
    const cleanup: string[] = [];
    await moveMessageIfPresent(mailbox, message.id, "expired").catch(
      (cleanupError: unknown) => {
        cleanup.push(`Message: ${formatUnknownError(cleanupError)}`);
      },
    );
    if (lease && !released && !completed) {
      try {
        lease = await lifecycle.beginRevocation(lease.id);
        await stopPersistedWriter({
          client: options.client,
          lease,
          ...(session ? { session } : {}),
        });
        session = undefined;
        writers = await writableSandboxes(options.client, run.id);
        await requireWriterAbsence({ lifecycle, lease, sandboxes: writers });
        const resultSource = await workspace.inspect(
          lease.workspace_generation + 1,
        );
        const resultManifest = workspaceManifest(resultSource);
        const resultGitDiff = await workspace.gitDiff(resultSource);
        await lifecycle.release({
          leaseId: lease.id,
          changeSetId: ids.changeSet,
          task,
          baselineManifest: manifest,
          resultManifest,
          gitDiff: resultGitDiff,
          protectedPatterns,
          restrictedPatterns,
          deletedSandboxId: lease.sandbox_id,
          writableSandboxIds: writers.map((entry) => entry.id),
          ...(report ? { report: report.id } : {}),
        });
        released = true;
      } catch (cleanupError) {
        cleanup.push(`Write Lease: ${formatUnknownError(cleanupError)}`);
      }
    }
    if (session) {
      await session.stop().catch((cleanupError: unknown) => {
        cleanup.push(`Sandbox: ${formatUnknownError(cleanupError)}`);
      });
    }
    await failSession(
      registry,
      identity,
      `Implementation failed: ${formatUnknownError(error)}`,
    ).catch((cleanupError: unknown) => {
      cleanup.push(`Session: ${formatUnknownError(cleanupError)}`);
    });
    if (!report) {
      await markTaskRework({
        store: options.store,
        runId: run.id,
        taskId: task.id,
        attempt,
      }).catch((cleanupError: unknown) => {
        cleanup.push(`Task: ${formatUnknownError(cleanupError)}`);
      });
    }
    if (cleanup.length > 0) {
      throw new OrchestratorError(
        "implementation_cleanup_failed",
        `Implementation failed (${formatUnknownError(error)}); cleanup also failed: ${cleanup.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}
