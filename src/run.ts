import { requireFreshApproval } from "./approval.js";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  GitCommitSchema,
  GitWorktreeManager,
  type RunWorktreeIntent,
  type RunWorktreeInspection,
  type RunWorktreeResult,
} from "./git.js";
import type { LoadedPlan } from "./plan.js";
import { routingPolicyDigest } from "./model.js";
import { projectPermissionPolicyDigest } from "./permission.js";
import type { Project } from "./project.js";
import { gitHead } from "./project.js";
import {
  RunStateSchema,
  TaskRecordSchema,
  type ProjectStore,
  type RunState,
} from "./state.js";

export type RunWorktreePort = Pick<
  GitWorktreeManager,
  "prepare" | "inspect" | "preflight" | "ensure"
>;

export interface StartRunOptions {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly runId?: string;
  readonly worktreeRoot: string;
  readonly worktrees?: RunWorktreePort;
  readonly now?: Date;
}

export interface StartRunResult {
  readonly run: RunState;
  readonly intent: RunWorktreeIntent;
  readonly worktree: RunWorktreeResult;
  readonly created: boolean;
}

export function defaultRunId(
  plan: Pick<LoadedPlan, "id" | "revision">,
): string {
  return IdentifierSchema.parse(`${plan.id}-r${plan.revision}`);
}

function initialRunState(options: {
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly intent: RunWorktreeIntent;
  readonly timestamp: string;
}): RunState {
  const tasks = Object.fromEntries(
    options.plan.tasks.map((task) => {
      const ready = task.depends.length === 0;
      return [
        task.id,
        TaskRecordSchema.parse({
          id: task.id,
          status: ready ? "ready" : "pending",
          implementation_attempts: 0,
          review_rounds: 0,
          ...(ready ? { input_commit: options.intent.base_commit } : {}),
          gates: {},
        }),
      ];
    }),
  );
  return RunStateSchema.parse({
    version: 2,
    id: options.intent.run_id,
    project_id: options.project.config.project.id,
    plan_id: options.plan.id,
    plan_revision: options.plan.revision,
    plan_digest: options.plan.digest,
    permission_policy_digest: projectPermissionPolicyDigest(
      options.project.roles,
    ),
    routing_policy_digest: routingPolicyDigest(options.project.config),
    base_commit: options.intent.base_commit,
    branch: options.intent.branch,
    worktree: options.intent.worktree,
    status: "ready",
    tasks,
    created_at: options.timestamp,
    updated_at: options.timestamp,
  });
}

export async function startRun(
  options: StartRunOptions,
): Promise<StartRunResult> {
  const runId = IdentifierSchema.parse(
    options.runId ?? defaultRunId(options.plan),
  );
  const projectRecord = await options.store.read();
  const baseCommit = GitCommitSchema.parse(await gitHead(options.project.root));
  const permissionPolicyDigest = projectPermissionPolicyDigest(
    options.project.roles,
  );
  const modelRoutingPolicyDigest = routingPolicyDigest(options.project.config);
  requireFreshApproval(projectRecord.approvals[options.plan.id], {
    planId: options.plan.id,
    planRevision: options.plan.revision,
    planDigest: options.plan.digest,
    permissionPolicyDigest,
    routingPolicyDigest: modelRoutingPolicyDigest,
    baseCommit,
  });

  const worktrees =
    options.worktrees ?? new GitWorktreeManager(options.project.root);
  const intent = await worktrees.prepare({
    projectId: options.project.config.project.id,
    runId,
    baseCommit,
    branchPrefix: options.project.config.git.branch_prefix,
    worktreeRoot: options.worktreeRoot,
  });
  await worktrees.preflight(intent);

  const timestamp = (options.now ?? new Date()).toISOString();
  const registration = await options.store.createRun(
    initialRunState({
      project: options.project,
      plan: options.plan,
      intent,
      timestamp,
    }),
  );
  const worktree = await worktrees.ensure(intent);
  return {
    run: registration.run,
    intent,
    worktree,
    created: registration.created,
  };
}

export async function inspectRunWorktree(options: {
  readonly run: RunState;
  readonly project: Project;
  readonly worktreeRoot: string;
  readonly worktrees?: RunWorktreePort;
}): Promise<RunWorktreeInspection> {
  const worktrees =
    options.worktrees ?? new GitWorktreeManager(options.project.root);
  const intent = await worktrees.prepare({
    projectId: options.run.project_id,
    runId: options.run.id,
    baseCommit: options.run.base_commit,
    branchPrefix: options.project.config.git.branch_prefix,
    worktreeRoot: options.worktreeRoot,
  });
  if (
    intent.branch !== options.run.branch ||
    intent.worktree !== options.run.worktree ||
    intent.base_commit !== options.run.base_commit
  ) {
    throw new OrchestratorError(
      "run_worktree_conflict",
      `Run '${options.run.id}' no longer matches its configured worktree intent`,
    );
  }
  return worktrees.inspect(intent);
}
