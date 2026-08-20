import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactRecordSchema,
  ArtifactStore,
  type ImportedArtifact,
} from "./artifact.js";
import { requireFreshApproval } from "./approval.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import {
  defaultGitCommandRunner,
  GitCommitSchema,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git.js";
import {
  patchArtifactContract,
  validateVerifiedPatch,
  verifyAppliedPatchResult,
  WorkspacePathSchema,
  type PatchChange,
  type VerifiedPatch,
} from "./patch.js";
import type { LoadedPlan, PlanTask } from "./plan.js";
import { projectPermissionPolicyDigest } from "./permission.js";
import { routingPolicyDigest } from "./model.js";
import type { Project } from "./project.js";
import { validatePatchPaths } from "./scope.js";
import { createSourceSnapshot } from "./snapshot.js";
import {
  PatchApplicationSchema,
  type PatchApplication,
  type ProjectRecord,
  type ProjectStore,
  type RunState,
  type TaskRecord,
} from "./state.js";

export interface PatchWorktreeInspection {
  readonly state: "clean" | "applied";
  readonly changedPaths: readonly string[];
  readonly changes?: readonly PatchChange[];
  readonly resultSourceDigest?: Digest;
  readonly hostDiffDigest?: Digest;
}

export interface PatchWorktreeResult {
  readonly created: boolean;
  readonly recovered: boolean;
  readonly changedPaths: readonly string[];
  readonly resultSourceDigest: Digest;
  readonly hostDiffDigest: Digest;
}

export interface PatchWorktreeOptions {
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly inputCommit: string;
  readonly patch: VerifiedPatch;
}

export interface PatchWorktreePort {
  inspect(options: PatchWorktreeOptions): Promise<PatchWorktreeInspection>;
  ensure(options: PatchWorktreeOptions): Promise<PatchWorktreeResult>;
}

export type PatchApplicationStore = Pick<
  ProjectStore,
  "read" | "readRun" | "updateRun"
>;

export interface ApplyTaskPatchOptions {
  readonly store: PatchApplicationStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly runId: string;
  readonly taskId: string;
  readonly patch: ImportedArtifact<VerifiedPatch>;
  readonly worktrees?: PatchWorktreePort;
  readonly now?: Date;
}

export interface ApplyTaskPatchResult {
  readonly run: RunState;
  readonly task: TaskRecord;
  readonly application: PatchApplication;
  readonly created: boolean;
  readonly recovered: boolean;
}

export interface LoadPreparedPatchOptions {
  readonly store: ArtifactStore;
  readonly projectRoot: string;
  readonly application: PatchApplication;
  readonly temporaryRoot?: string;
}

function failCommand(
  args: readonly string[],
  result: GitCommandResult,
): OrchestratorError {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  return new OrchestratorError(
    "git_failed",
    `git ${args.join(" ")} failed with exit ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
  );
}

function parseStatus(source: string): readonly string[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git status did not terminate its path records",
    );
  }
  const paths: string[] = [];
  for (const record of source.slice(0, -1).split("\0")) {
    if (record.length < 4 || record[2] !== " ") {
      throw new OrchestratorError(
        "invalid_git_output",
        "git status returned an invalid path record",
      );
    }
    if (
      record[0] === "R" ||
      record[0] === "C" ||
      record[1] === "R" ||
      record[1] === "C"
    ) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git status returned an unexpected rename or copy record",
      );
    }
    const parsed = WorkspacePathSchema.safeParse(record.slice(3));
    if (!parsed.success) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git status returned an unsafe or unsupported path",
      );
    }
    paths.push(parsed.data);
  }
  if (new Set(paths).size !== paths.length) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git status returned a duplicate changed path",
    );
  }
  return paths.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

function hostDiffDigest(options: {
  readonly inputCommit: string;
  readonly sourceDigest: string;
  readonly resultSourceDigest: string;
  readonly changes: readonly PatchChange[];
}): Digest {
  return digestParts("pi-orchestrator/host-diff/v1", [
    ["input-commit", options.inputCommit],
    ["source-digest", options.sourceDigest],
    ["result-source-digest", options.resultSourceDigest],
    ["changes", canonicalJson(options.changes)],
  ]);
}

export class GitPatchWorktree implements PatchWorktreePort {
  constructor(
    private readonly runner: GitCommandRunner = defaultGitCommandRunner,
  ) {}

  private async command(
    args: readonly string[],
    cwd: string,
  ): Promise<GitCommandResult> {
    return this.runner(args, cwd);
  }

  private async requireCommand(
    args: readonly string[],
    cwd: string,
  ): Promise<string> {
    const result = await this.command(args, cwd);
    if (result.exitCode !== 0) throw failCommand(args, result);
    return result.stdout.trim();
  }

  private async validateIdentity(options: PatchWorktreeOptions): Promise<void> {
    const repository = path.resolve(options.repository);
    const worktree = path.resolve(options.worktree);
    const [repositoryState, worktreeState] = await Promise.all([
      lstat(repository).catch(() => undefined),
      lstat(worktree).catch(() => undefined),
    ]);
    if (
      !repositoryState?.isDirectory() ||
      repositoryState.isSymbolicLink() ||
      (await realpath(repository).catch(() => undefined)) !== repository
    ) {
      throw new OrchestratorError(
        "git_repository_mismatch",
        `Project repository '${repository}' is unavailable or indirect`,
      );
    }
    if (
      !worktreeState?.isDirectory() ||
      worktreeState.isSymbolicLink() ||
      (await realpath(worktree).catch(() => undefined)) !== worktree
    ) {
      throw new OrchestratorError(
        "worktree_path_mismatch",
        `Run worktree '${worktree}' is unavailable or indirect`,
      );
    }

    const [repositoryTop, worktreeTop, repositoryCommon, worktreeCommon] =
      await Promise.all([
        this.requireCommand(["rev-parse", "--show-toplevel"], repository),
        this.requireCommand(["rev-parse", "--show-toplevel"], worktree),
        this.requireCommand(["rev-parse", "--git-common-dir"], repository),
        this.requireCommand(["rev-parse", "--git-common-dir"], worktree),
      ]);
    const [
      resolvedRepositoryTop,
      resolvedWorktreeTop,
      resolvedRepositoryCommon,
      resolvedWorktreeCommon,
    ] = await Promise.all([
      realpath(path.resolve(repository, repositoryTop)),
      realpath(path.resolve(worktree, worktreeTop)),
      realpath(path.resolve(repository, repositoryCommon)),
      realpath(path.resolve(worktree, worktreeCommon)),
    ]);
    if (
      resolvedRepositoryTop !== repository ||
      resolvedWorktreeTop !== worktree ||
      resolvedRepositoryCommon !== resolvedWorktreeCommon
    ) {
      throw new OrchestratorError(
        "worktree_repository_mismatch",
        `Run worktree '${worktree}' does not belong to Project '${repository}'`,
      );
    }

    const expectedCommit = GitCommitSchema.parse(options.inputCommit);
    const [head, branch] = await Promise.all([
      this.requireCommand(["rev-parse", "HEAD"], worktree),
      this.command(["symbolic-ref", "--quiet", "HEAD"], worktree),
    ]);
    if (head !== expectedCommit) {
      throw new OrchestratorError(
        "worktree_head_mismatch",
        `Run worktree HEAD '${head}' does not match Task input '${expectedCommit}'`,
      );
    }
    const expectedBranch = `refs/heads/${options.branch}`;
    if (branch.exitCode !== 0 || branch.stdout.trim() !== expectedBranch) {
      throw new OrchestratorError(
        "worktree_branch_mismatch",
        `Run worktree is not on expected branch '${options.branch}'`,
      );
    }
  }

  async inspect(
    rawOptions: PatchWorktreeOptions,
  ): Promise<PatchWorktreeInspection> {
    const patch = validateVerifiedPatch(rawOptions.patch);
    const options = { ...rawOptions, patch };
    await this.validateIdentity(options);
    const statusArgs = [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
    ] as const;
    const status = await this.command(statusArgs, options.worktree);
    if (status.exitCode !== 0) throw failCommand(statusArgs, status);
    const changedPaths = parseStatus(status.stdout);
    if (changedPaths.length === 0) {
      return { state: "clean", changedPaths };
    }

    const verified = await verifyAppliedPatchResult({
      root: options.worktree,
      patch,
      changedPaths,
    });
    const digest = hostDiffDigest({
      inputCommit: options.inputCommit,
      sourceDigest: patch.bundle.source_digest,
      resultSourceDigest: verified.resultSourceDigest,
      changes: verified.changes,
    });
    return {
      state: "applied",
      changedPaths,
      changes: verified.changes,
      resultSourceDigest: verified.resultSourceDigest,
      hostDiffDigest: digest,
    };
  }

  async ensure(rawOptions: PatchWorktreeOptions): Promise<PatchWorktreeResult> {
    const patch = validateVerifiedPatch(rawOptions.patch);
    const options = { ...rawOptions, patch };
    const initial = await this.inspect(options);
    if (initial.state === "applied") {
      return {
        created: false,
        recovered: true,
        changedPaths: initial.changedPaths,
        resultSourceDigest: initial.resultSourceDigest!,
        hostDiffDigest: initial.hostDiffDigest!,
      };
    }

    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pi-orchestrator-apply-"),
    );
    const patchPath = path.join(directory, "change.patch");
    try {
      await writeFile(patchPath, patch.patch, { mode: 0o600 });
      const args = [
        "apply",
        "--binary",
        "--whitespace=nowarn",
        "-p2",
        patchPath,
      ] as const;
      const checkArgs = ["apply", "--check", ...args.slice(1)] as const;
      const check = await this.command(checkArgs, options.worktree);
      if (check.exitCode !== 0) {
        const observed = await this.inspect(options);
        if (observed.state === "applied") {
          return {
            created: false,
            recovered: true,
            changedPaths: observed.changedPaths,
            resultSourceDigest: observed.resultSourceDigest!,
            hostDiffDigest: observed.hostDiffDigest!,
          };
        }
        throw failCommand(checkArgs, check);
      }

      const applied = await this.command(args, options.worktree);
      let observed: PatchWorktreeInspection;
      try {
        observed = await this.inspect(options);
      } catch (error) {
        if (applied.exitCode !== 0) {
          throw new OrchestratorError(
            "worktree_patch_drift",
            "Git failed after partially changing the Run worktree; manual resolution is required",
            { cause: error },
          );
        }
        throw error;
      }
      if (observed.state === "applied") {
        return {
          created: applied.exitCode === 0,
          recovered: applied.exitCode !== 0,
          changedPaths: observed.changedPaths,
          resultSourceDigest: observed.resultSourceDigest!,
          hostDiffDigest: observed.hostDiffDigest!,
        };
      }
      if (applied.exitCode !== 0) throw failCommand(args, applied);
      throw new OrchestratorError(
        "worktree_result_mismatch",
        "Git reported success without producing the verified Patch result",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
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

function requireCurrentArtifactSession(
  run: RunState,
  task: PlanTask,
  record: ReturnType<typeof ArtifactRecordSchema.parse>,
): void {
  const agent = run.agents[record.agent];
  const session = run.sessions[record.session];
  if (
    !agent ||
    !session ||
    agent.session !== record.session ||
    agent.generation !== record.generation ||
    session.identity.run !== run.id ||
    session.identity.agent !== record.agent ||
    session.identity.session !== record.session ||
    session.identity.generation !== record.generation
  ) {
    throw new OrchestratorError(
      "stale_session",
      `Patch Artifact '${record.id}' was not emitted by the current Session generation`,
    );
  }
  if (agent.role !== task.role) {
    throw new OrchestratorError(
      "artifact_role_mismatch",
      `Patch Artifact Agent '${record.agent}' does not have Task Role '${task.role}'`,
    );
  }
  if (
    !session.sandbox ||
    session.sandbox.id !== record.source.sandbox_id ||
    session.sandbox.name !== record.source.sandbox_name ||
    session.sandbox.workspace !== record.source.workspace
  ) {
    throw new OrchestratorError(
      "artifact_sandbox_mismatch",
      `Patch Artifact '${record.id}' does not match its Session Sandbox`,
    );
  }
}

function applicationIdentity(application: PatchApplication): unknown {
  return {
    artifact_id: application.artifact_id,
    artifact_content_digest: application.artifact_content_digest,
    agent: application.agent,
    session: application.session,
    generation: application.generation,
    sandbox_id: application.sandbox_id,
    source_commit: application.source_commit,
    source_paths: application.source_paths,
    source_digest: application.source_digest,
    result_source_digest: application.result_source_digest,
    sandbox_diff_digest: application.sandbox_diff_digest,
    changed_paths: application.changed_paths,
  };
}

function requireSameApplication(
  actual: PatchApplication,
  expected: PatchApplication,
): void {
  if (
    canonicalJson(applicationIdentity(actual)) !==
    canonicalJson(applicationIdentity(expected))
  ) {
    throw new OrchestratorError(
      "patch_application_conflict",
      `Task already has another prepared or applied Patch`,
    );
  }
}

function findTask(plan: LoadedPlan, taskId: string): PlanTask {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new OrchestratorError(
      "task_not_found",
      `Plan '${plan.id}' has no Task '${taskId}'`,
    );
  }
  return task;
}

function requireArtifactBinding(options: {
  readonly run: RunState;
  readonly task: PlanTask;
  readonly record: ReturnType<typeof ArtifactRecordSchema.parse>;
  readonly patch: VerifiedPatch;
}): void {
  if (
    options.record.kind !== "patch" ||
    options.record.media_type !== "application/json" ||
    options.record.schema !== "patch/v1" ||
    options.record.run !== options.run.id ||
    options.record.task !== options.task.id
  ) {
    throw new OrchestratorError(
      "patch_artifact_mismatch",
      `Artifact '${options.record.id}' is not the Patch for Task '${options.task.id}'`,
    );
  }
  const taskState = options.run.tasks[options.task.id];
  if (!taskState?.input_commit) {
    throw new OrchestratorError(
      "task_source_missing",
      `Task '${options.task.id}' has no durable input commit`,
    );
  }
  if (options.patch.source.commit !== taskState.input_commit) {
    throw new OrchestratorError(
      "patch_source_mismatch",
      `Patch Artifact '${options.record.id}' does not use Task input commit '${taskState.input_commit}'`,
    );
  }
}

function preparedApplication(options: {
  readonly record: ReturnType<typeof ArtifactRecordSchema.parse>;
  readonly patch: VerifiedPatch;
  readonly timestamp: string;
}): PatchApplication {
  return PatchApplicationSchema.parse({
    artifact_id: options.record.id,
    artifact_content_digest: options.record.content_digest,
    agent: options.record.agent,
    session: options.record.session,
    generation: options.record.generation,
    sandbox_id: options.record.source.sandbox_id,
    source_commit: options.patch.source.commit,
    source_paths: options.patch.source.selected_paths,
    source_digest: options.patch.bundle.source_digest,
    result_source_digest: options.patch.bundle.result_tree_digest,
    sandbox_diff_digest: options.patch.bundle.diff_digest,
    changed_paths: options.patch.bundle.changes.map((change) => change.path),
    state: "prepared",
    prepared_at: options.timestamp,
  });
}

export async function loadPreparedPatch(
  options: LoadPreparedPatchOptions,
): Promise<ImportedArtifact<VerifiedPatch>> {
  const application = PatchApplicationSchema.parse(options.application);
  const snapshot = await createSourceSnapshot({
    projectRoot: options.projectRoot,
    commit: application.source_commit,
    paths: application.source_paths,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  try {
    if (snapshot.manifest.source_digest !== application.source_digest) {
      throw new OrchestratorError(
        "patch_source_mismatch",
        `Recreated source for Patch Artifact '${application.artifact_id}' has another digest`,
      );
    }
    const imported = await options.store.get(
      application.artifact_id,
      patchArtifactContract({
        snapshot,
        ...(options.temporaryRoot
          ? { temporaryRoot: options.temporaryRoot }
          : {}),
      }),
    );
    const patch = validateVerifiedPatch(imported.value);
    const candidate = preparedApplication({
      record: ArtifactRecordSchema.parse(imported.record),
      patch,
      timestamp: application.prepared_at,
    });
    requireSameApplication(application, candidate);
    return { record: imported.record, value: patch };
  } finally {
    await snapshot.dispose();
  }
}

export async function applyTaskPatch(
  options: ApplyTaskPatchOptions,
): Promise<ApplyTaskPatchResult> {
  const [projectRecord, initialRun] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
  ]);
  requireRunBinding({
    run: initialRun,
    project: options.project,
    plan: options.plan,
    projectRecord,
  });
  const task = findTask(options.plan, options.taskId);
  const taskState = initialRun.tasks[task.id];
  if (!taskState) {
    throw new OrchestratorError(
      "task_not_found",
      `Run '${initialRun.id}' has no Task '${task.id}'`,
    );
  }
  const record = ArtifactRecordSchema.parse(options.patch.record);
  const patch = validateVerifiedPatch(options.patch.value);
  requireArtifactBinding({ run: initialRun, task, record, patch });
  validatePatchPaths({
    patch,
    task,
    protectedPatterns: options.project.config.protected,
    restrictedPatterns: options.project.config.restricted_paths,
  });
  const timestamp = (options.now ?? new Date()).toISOString();
  const prepared = preparedApplication({ record, patch, timestamp });
  if (taskState.patch_application) {
    requireSameApplication(taskState.patch_application, prepared);
  } else {
    if (taskState.status !== "active") {
      throw new OrchestratorError(
        "task_not_active",
        `Task '${task.id}' must be active before its Patch can be applied`,
      );
    }
    if (
      taskState.implementation_attempts >=
      options.project.config.attempts.implementation
    ) {
      throw new OrchestratorError(
        "implementation_attempt_limit",
        `Task '${task.id}' exhausted its implementation attempts`,
      );
    }
    requireCurrentArtifactSession(initialRun, task, record);
  }
  const inputCommit = GitCommitSchema.parse(taskState.input_commit);
  const worktrees = options.worktrees ?? new GitPatchWorktree();
  const worktreeOptions = {
    repository: options.project.root,
    worktree: initialRun.worktree,
    branch: initialRun.branch,
    inputCommit,
    patch,
  } as const;
  const before = await worktrees.inspect(worktreeOptions);
  if (!taskState.patch_application && before.state !== "clean") {
    throw new OrchestratorError(
      "unexpected_worktree_changes",
      `Run worktree '${initialRun.worktree}' changed before Patch preparation`,
    );
  }
  if (
    taskState.patch_application?.state === "applied" &&
    before.state !== "applied"
  ) {
    throw new OrchestratorError(
      "worktree_patch_missing",
      `Run worktree no longer contains Task '${task.id}' applied Patch`,
    );
  }
  if (
    taskState.patch_application?.state === "applied" &&
    (before.hostDiffDigest !== taskState.patch_application.host_diff_digest ||
      before.resultSourceDigest !==
        taskState.patch_application.result_source_digest)
  ) {
    throw new OrchestratorError(
      "patch_application_conflict",
      `Run worktree does not match Task '${task.id}' durable Patch digests`,
    );
  }

  const preparedRun = await options.store.updateRun(initialRun.id, (run) => {
    requireArtifactBinding({ run, task, record, patch });
    const current = run.tasks[task.id]!;
    if (current.patch_application) {
      requireSameApplication(current.patch_application, prepared);
      return run;
    }
    if (current.status !== "active") {
      throw new OrchestratorError(
        "task_not_active",
        `Task '${task.id}' must remain active during Patch preparation`,
      );
    }
    if (
      current.implementation_attempts >=
      options.project.config.attempts.implementation
    ) {
      throw new OrchestratorError(
        "implementation_attempt_limit",
        `Task '${task.id}' exhausted its implementation attempts`,
      );
    }
    requireCurrentArtifactSession(run, task, record);
    for (const [otherId, other] of Object.entries(run.tasks)) {
      if (otherId !== task.id && other.status === "active") {
        throw new OrchestratorError(
          "active_writer_conflict",
          `Task '${otherId}' is already the active implementation writer`,
        );
      }
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [task.id]: {
          ...current,
          implementation_attempts: current.implementation_attempts + 1,
          input_source_digest: prepared.source_digest,
          output_source_digest: prepared.result_source_digest,
          patch_application: prepared,
        },
      },
    };
  });
  const preparedTask = preparedRun.tasks[task.id]!;
  const durableApplication = preparedTask.patch_application!;
  if (preparedTask.patch_application?.state === "applied") {
    return {
      run: preparedRun,
      task: preparedTask,
      application: durableApplication,
      created: false,
      recovered: true,
    };
  }

  const applied = await worktrees.ensure(worktreeOptions);
  if (
    applied.resultSourceDigest !== durableApplication.result_source_digest ||
    canonicalJson(applied.changedPaths) !==
      canonicalJson(durableApplication.changed_paths)
  ) {
    throw new OrchestratorError(
      "worktree_result_mismatch",
      "Applied worktree result does not match the prepared Patch",
    );
  }
  const application = PatchApplicationSchema.parse({
    ...durableApplication,
    state: "applied",
    host_diff_digest: applied.hostDiffDigest,
    applied_at: timestamp,
  });
  const completedRun = await options.store.updateRun(initialRun.id, (run) => {
    const current = run.tasks[task.id]!;
    if (!current.patch_application) {
      throw new OrchestratorError(
        "patch_application_missing",
        `Task '${task.id}' lost its prepared Patch state`,
      );
    }
    requireSameApplication(current.patch_application, prepared);
    if (current.patch_application.state === "applied") {
      if (
        current.patch_application.host_diff_digest !== applied.hostDiffDigest
      ) {
        throw new OrchestratorError(
          "patch_application_conflict",
          `Task '${task.id}' has another host diff digest`,
        );
      }
      return run;
    }
    if (current.status !== "active") {
      throw new OrchestratorError(
        "task_state_changed",
        `Task '${task.id}' left active state during Patch application`,
      );
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [task.id]: {
          ...current,
          status: "checking",
          diff_digest: applied.hostDiffDigest,
          patch_application: application,
        },
      },
    };
  });
  const completedTask = completedRun.tasks[task.id]!;
  return {
    run: completedRun,
    task: completedTask,
    application: completedTask.patch_application!,
    created: applied.created,
    recovered: applied.recovered,
  };
}
