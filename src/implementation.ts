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
import { canonicalJson, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import type { LocalConfig } from "./local.js";
import { Mailbox, MessageSchema, type MessageLifecycle } from "./message.js";
import { MetricStore } from "./metric.js";
import { resolveRoleModelRoute, type ResolvedModelRoute } from "./model.js";
import type { OpenShellPreflight } from "./openshell.js";
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

export type ImplementationOpenShell = WriteSessionOpenShell & ArtifactOpenShell;

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
}

export interface RunImplementationResult {
  readonly application: ApplyTaskPatchResult["application"];
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
  requireFreshApproval(options.projectRecord.approvals[options.plan.id], {
    planId: options.run.plan_id,
    planRevision: options.run.plan_revision,
    planDigest: options.run.plan_digest,
    permissionPolicyDigest,
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
      report.kind === "implementation" &&
      report.task !== undefined &&
      dependencies.has(report.task),
  );
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
  return compileBrief({
    identity: options.identity,
    agents: options.project.agents,
    role: options.role,
    permissionCeiling: options.permissionCeiling,
    task: options.task,
    plan: options.plan,
    decisions: [],
    dependencyReports: options.dependencies,
    skills,
    outputContract: IMPLEMENTATION_OUTPUT_CONTRACT,
    sourceAnchors: options.task.scope.map((scope) => ({
      path: scope,
      reason: "Approved writable Task scope.",
    })),
    sourceDigests: {
      plan: options.plan.digest,
      source: options.sourceDigest,
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
      `Implementer model '${model.alias}' resolved to '${model.gateway}', but OpenShell reached '${preflight.status.gateway}'`,
    );
  }
}

async function allocateSession(options: {
  readonly registry: AgentRegistry;
  readonly task: PlanTask;
  readonly model: ResolvedModelRoute;
  readonly permissionCeiling: PermissionCeiling;
  readonly nonce: string;
}) {
  const agentId = "implementer";
  await options.registry.register({
    agent: agentId,
    role: options.task.role,
    model: options.model.alias,
  });
  const agent = await options.registry.get(agentId);
  const sessionId = IdentifierSchema.parse(`implementation-${options.nonce}`);
  if (agent.record.session === null) {
    return options.registry.start({
      agent: agentId,
      session: sessionId,
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
}): Promise<void> {
  await options.store.updateRun(options.runId, (run) => {
    const current = run.tasks[options.taskId];
    if (!current || current.status !== "active" || current.patch_application) {
      return run;
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.taskId]: { ...current, status: "rework" },
      },
    };
  });
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

export async function runImplementation(
  options: RunImplementationOptions,
): Promise<RunImplementationResult> {
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
    role.definition.inference,
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
