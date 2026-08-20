import { z } from "zod";
import {
  approvalDigest,
  requireFreshApproval,
  type Approval,
} from "./approval.js";
import {
  candidateReference,
  CandidateStore,
  createCandidate,
  RunWorkspaceStateSchema,
  transitionCandidate,
  type Candidate,
  type CandidatePath,
} from "./candidate.js";
import {
  changeSetReference,
  ChangeSetStore,
  createChangeSet,
  type ChangeSet,
} from "./change.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, type Digest } from "./digest.js";
import { OrchestratorError, formatUnknownError } from "./error.js";
import { validateWorkspaceDiff, type WorkspaceDiff } from "./git.js";
import {
  activateWriteLease,
  blockWriteLease,
  createWriteLease,
  releaseWriteLease,
  renewWriteLease,
  revokeWriteLease,
  sameWriteLeaseBinding,
  writeLeaseReference,
  WriteLeaseStore,
  type WriteLease,
} from "./lease.js";
import {
  PermissionCeilingSchema,
  type PermissionCeiling,
} from "./permission.js";
import type { PlanTask } from "./plan.js";
import {
  pathPolicyDigest,
  validateChangedPaths,
  validateTaskWritePaths,
} from "./scope.js";
import { SessionIdentitySchema, type SessionIdentity } from "./session.js";
import type { ProjectStore, RunState, TaskRecord } from "./state.js";
import {
  compareWorkspaceManifests,
  validateWorkspaceManifest,
  workspaceManifestEntries,
  type WorkspaceManifest,
  type WorkspaceManifestChange,
} from "./workspace.js";

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);
const TimestampSchema = z.string().datetime({ offset: true });

type LifecycleStore = Pick<
  ProjectStore,
  "read" | "readRun" | "updateRun" | "runDirectory"
>;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function sortedDigests(values: readonly string[]): Digest[] {
  return [...new Set(values)]
    .map((value) => DigestSchema.parse(value))
    .sort(compareUtf8);
}

function currentSession(state: RunState, identity: SessionIdentity) {
  const agent = state.agents[identity.agent];
  const session = state.sessions[identity.session];
  if (
    identity.run !== state.id ||
    !agent ||
    agent.session !== identity.session ||
    agent.generation !== identity.generation ||
    !session ||
    session.identity.agent !== identity.agent ||
    session.identity.generation !== identity.generation
  ) {
    throw new OrchestratorError(
      "stale_session",
      `Session '${identity.session}' is not current for Agent '${identity.agent}'`,
    );
  }
  if (session.status === "stopped" || session.status === "failed") {
    throw new OrchestratorError(
      "session_terminal",
      `Session '${identity.session}' is ${session.status}`,
    );
  }
  return session;
}

function currentTask(state: RunState, taskId: string): TaskRecord {
  const task = state.tasks[taskId];
  if (!task) {
    throw new OrchestratorError(
      "task_not_found",
      `Run '${state.id}' has no Task '${taskId}'`,
    );
  }
  return task;
}

function staleGates(
  task: TaskRecord,
  timestamp: string,
  reason: string,
): TaskRecord {
  if (Object.keys(task.gates).length === 0) return task;
  return {
    ...task,
    gates: Object.fromEntries(
      Object.entries(task.gates).map(([key, gate]) => [
        key,
        {
          ...gate,
          status: "stale" as const,
          rationale: reason,
          updated_at: timestamp,
        },
      ]),
    ),
  };
}

function sameWithout(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  excluded: readonly string[],
): boolean {
  const omit = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !excluded.includes(key)),
    );
  return canonicalJson(omit(left)) === canonicalJson(omit(right));
}

export interface InitializeWorkspaceInput {
  readonly volumeName: string;
  readonly volumeDigest: Digest;
  readonly manifest: WorkspaceManifest;
  readonly gitDiff: WorkspaceDiff;
}

export interface AcquireWriteLeaseInput {
  readonly id: string;
  readonly task: Pick<PlanTask, "id" | "scope" | "write_paths">;
  readonly identity: SessionIdentity;
  readonly permissionCeiling: PermissionCeiling;
  readonly baselineManifest: WorkspaceManifest;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
  readonly expiresAt: string;
  readonly sandboxName: string;
  readonly sandboxWorkspace: string;
  readonly policyDigest: Digest;
  readonly imageDigest: Digest;
  readonly gatewayDigest: Digest;
  readonly mountTableDigest: Digest;
}

export interface WritableSandboxProvenance {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly gatewayDigest: Digest;
  readonly mountTableDigest: Digest;
  readonly sandboxDigest: Digest;
}

export interface ReleaseWriteLeaseInput {
  readonly leaseId: string;
  readonly changeSetId: string;
  readonly task: Pick<PlanTask, "id" | "scope">;
  readonly baselineManifest: WorkspaceManifest;
  readonly resultManifest: WorkspaceManifest;
  readonly gitDiff: WorkspaceDiff;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
  readonly deletedSandboxId: string | null;
  readonly writableSandboxIds: readonly string[];
  readonly report?: string;
}

export interface FreezeCandidateInput {
  readonly id: string;
  readonly task: Pick<PlanTask, "id" | "scope">;
  readonly manifest: WorkspaceManifest;
  readonly gitDiff: WorkspaceDiff;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
  readonly writableSandboxIds: readonly string[];
}

export class WorkspaceLifecycle {
  readonly runId: string;
  readonly leases: WriteLeaseStore;
  readonly changes: ChangeSetStore;
  readonly candidates: CandidateStore;

  constructor(
    private readonly store: LifecycleStore,
    runId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runId = IdentifierSchema.parse(runId);
    const directory = store.runDirectory(this.runId);
    this.leases = new WriteLeaseStore(directory);
    this.changes = new ChangeSetStore(directory);
    this.candidates = new CandidateStore(directory);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async initialize(input: InitializeWorkspaceInput): Promise<RunState> {
    const manifest = validateWorkspaceManifest(input.manifest);
    const gitDiff = validateWorkspaceDiff(input.gitDiff);
    const volumeDigest = DigestSchema.parse(input.volumeDigest);
    if (gitDiff.manifest_digest !== manifest.digest) {
      throw new OrchestratorError(
        "workspace_diff_mismatch",
        "Workspace Git diff is not bound to the initial manifest",
      );
    }
    return this.store.updateRun(this.runId, (state) => {
      if (gitDiff.input_commit !== state.base_commit) {
        throw new OrchestratorError(
          "workspace_base_mismatch",
          "Workspace Git diff does not use the approved Run base commit",
        );
      }
      const requested = RunWorkspaceStateSchema.parse({
        volume_name: input.volumeName,
        volume_digest: volumeDigest,
        branch: state.branch,
        phase: "stable",
        generation: 0,
        manifest_digest: manifest.digest,
        git_diff_digest: gitDiff.digest,
        active_lease: null,
        change_sets: [],
        candidate: null,
        drift: null,
      });
      if (state.workspace) {
        if (canonicalJson(state.workspace) !== canonicalJson(requested)) {
          throw new OrchestratorError(
            "workspace_conflict",
            `Run '${state.id}' already has another Workspace identity`,
          );
        }
        return state;
      }
      return { ...state, workspace: requested };
    });
  }

  private validateLeaseRequest(
    state: RunState,
    input: AcquireWriteLeaseInput,
  ): {
    readonly permission: PermissionCeiling;
    readonly writeRoots: readonly string[];
  } {
    const workspace = state.workspace;
    if (!workspace) {
      throw new OrchestratorError(
        "workspace_uninitialized",
        `Run '${state.id}' has no initialized Workspace`,
      );
    }
    if (workspace.drift) {
      throw new OrchestratorError(
        "workspace_drift",
        `Run '${state.id}' Workspace has unexplained changes`,
      );
    }
    if (workspace.phase === "frozen") {
      throw new OrchestratorError(
        "candidate_frozen",
        `Run '${state.id}' has a frozen Candidate`,
      );
    }
    const taskState = currentTask(state, input.task.id);
    if (!["ready", "active", "rework"].includes(taskState.status)) {
      throw new OrchestratorError(
        "task_not_writable",
        `Task '${input.task.id}' is '${taskState.status}'`,
      );
    }
    const identity = SessionIdentitySchema.parse(input.identity);
    const session = currentSession(state, identity);
    const permission = PermissionCeilingSchema.parse(input.permissionCeiling);
    if (
      permission.permission_ceiling_digest !==
        session.permission_ceiling_digest ||
      permission.write_lease !== "task" ||
      permission.assignment.kind !== "task" ||
      permission.assignment.task !== input.task.id
    ) {
      throw new OrchestratorError(
        "write_lease_denied",
        `Session '${identity.session}' lacks the exact Task Write Lease grant`,
      );
    }
    const paths = validateTaskWritePaths({
      task: input.task,
      protectedPatterns: input.protectedPatterns,
      restrictedPatterns: input.restrictedPatterns,
    });
    return { permission, writeRoots: paths.writePaths };
  }

  async acquire(input: AcquireWriteLeaseInput): Promise<WriteLease> {
    const id = IdentifierSchema.parse(input.id);
    const baseline = validateWorkspaceManifest(input.baselineManifest);
    const expiresAt = TimestampSchema.parse(input.expiresAt);
    const initial = await this.store.readRun(this.runId);
    const validated = this.validateLeaseRequest(initial, input);
    if (initial.workspace!.manifest_digest !== baseline.digest) {
      throw new OrchestratorError(
        "write_lease_baseline_stale",
        "Write Lease baseline does not match the current Workspace",
      );
    }
    const timestamp = this.timestamp();
    if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
      throw new OrchestratorError(
        "write_lease_expiry",
        "Write Lease expiry must be in the future",
      );
    }
    let lease = createWriteLease({
      version: 2,
      id,
      run: initial.id,
      plan: initial.plan_id,
      plan_revision: initial.plan_revision,
      plan_digest: initial.plan_digest,
      task: input.task.id,
      identity: input.identity,
      workspace_generation: initial.workspace!.generation,
      baseline_manifest_digest: baseline.digest,
      write_roots: [...validated.writeRoots],
      write_roots_digest: pathPolicyDigest("write-roots", validated.writeRoots),
      scope_policy_digest: pathPolicyDigest("scope", input.task.scope),
      protected_policy_digest: pathPolicyDigest(
        "protected",
        input.protectedPatterns,
      ),
      restricted_policy_digest: pathPolicyDigest(
        "restricted",
        input.restrictedPatterns,
      ),
      permission_ceiling_digest: validated.permission.permission_ceiling_digest,
      route_digest:
        initial.sessions[input.identity.session]!.route.route_digest,
      policy_digest: input.policyDigest,
      image_digest: input.imageDigest,
      gateway_digest: input.gatewayDigest,
      mount_table_digest: input.mountTableDigest,
      sandbox_name: input.sandboxName,
      sandbox_workspace: input.sandboxWorkspace,
      sandbox_id: null,
      sandbox_digest: null,
      created_at: timestamp,
      expires_at: expiresAt,
      renewal_count: 0,
      status: "preparing",
      activated_at: null,
      revocation_started_at: null,
      sandbox_deleted_at: null,
      released_at: null,
      reason: null,
    });

    const versions = await this.leases.list(id);
    if (versions.length > 0) {
      const matching = versions.filter(
        (entry) =>
          sameWriteLeaseBinding(entry, lease) &&
          entry.renewal_count === 0 &&
          entry.expires_at === lease.expires_at,
      );
      if (matching.length === 0) {
        throw new OrchestratorError(
          "write_lease_conflict",
          `Write Lease ID '${id}' already identifies another grant`,
        );
      }
      const referenced = initial.workspace?.active_lease;
      if (referenced?.id === id) lease = await this.leases.get(referenced);
      else if (matching.some((entry) => entry.status === "released")) {
        throw new OrchestratorError(
          "write_lease_conflict",
          `Released Write Lease ID '${id}' cannot be reused`,
        );
      } else {
        lease = matching.find((entry) => entry.status === "preparing") ?? lease;
      }
    }
    await this.leases.put(lease);

    const next = await this.store.updateRun(this.runId, (state) => {
      this.validateLeaseRequest(state, input);
      const workspace = state.workspace!;
      if (
        workspace.generation !== lease.workspace_generation ||
        workspace.manifest_digest !== lease.baseline_manifest_digest
      ) {
        throw new OrchestratorError(
          "write_lease_baseline_stale",
          "Workspace changed before Write Lease acquisition",
        );
      }
      if (workspace.active_lease) {
        if (workspace.active_lease.id === id) return state;
        throw new OrchestratorError(
          "write_lease_active",
          `Run '${state.id}' already has Write Lease '${workspace.active_lease.id}'`,
        );
      }
      return {
        ...state,
        workspace: {
          ...workspace,
          phase: "mutating",
          active_lease: writeLeaseReference(lease),
        },
      };
    });
    const current = await this.leases.get(next.workspace!.active_lease!);
    if (!sameWriteLeaseBinding(current, lease)) {
      throw new OrchestratorError(
        "write_lease_conflict",
        `Write Lease ID '${id}' is active with another binding`,
      );
    }
    return current;
  }

  private async currentLease(leaseId: string): Promise<WriteLease> {
    const state = await this.store.readRun(this.runId);
    const reference = state.workspace?.active_lease;
    if (!reference || reference.id !== IdentifierSchema.parse(leaseId)) {
      throw new OrchestratorError(
        "write_lease_not_active",
        `Write Lease '${leaseId}' is not current for Run '${state.id}'`,
      );
    }
    return this.leases.get(reference);
  }

  private async replaceLease(
    expected: WriteLease,
    replacement: WriteLease,
  ): Promise<WriteLease> {
    await this.leases.put(replacement);
    const next = await this.store.updateRun(this.runId, (state) => {
      const workspace = state.workspace;
      if (!workspace?.active_lease) {
        throw new OrchestratorError(
          "write_lease_not_active",
          `Write Lease '${expected.id}' is no longer active`,
        );
      }
      if (
        workspace.active_lease.id === replacement.id &&
        workspace.active_lease.digest === replacement.digest
      ) {
        return state;
      }
      if (
        workspace.active_lease.id !== expected.id ||
        workspace.active_lease.digest !== expected.digest
      ) {
        throw new OrchestratorError(
          "write_lease_stale",
          `Write Lease '${expected.id}' changed during its transition`,
        );
      }
      return {
        ...state,
        workspace: {
          ...workspace,
          active_lease: writeLeaseReference(replacement),
        },
      };
    });
    return this.leases.get(next.workspace!.active_lease!);
  }

  async activate(
    leaseId: string,
    provenance: WritableSandboxProvenance,
  ): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    if (lease.status === "active") {
      if (
        lease.sandbox_id === provenance.id &&
        lease.sandbox_name === provenance.name &&
        lease.sandbox_workspace === provenance.workspace &&
        lease.sandbox_digest === provenance.sandboxDigest &&
        lease.gateway_digest === provenance.gatewayDigest &&
        lease.mount_table_digest === provenance.mountTableDigest
      ) {
        return lease;
      }
      throw new OrchestratorError(
        "write_lease_provenance_mismatch",
        `Active Write Lease '${lease.id}' has different Sandbox provenance`,
      );
    }
    const state = await this.store.readRun(this.runId);
    const session = currentSession(state, lease.identity);
    if (
      session.sandbox?.id !== provenance.id ||
      session.sandbox.name !== provenance.name ||
      session.sandbox.workspace !== provenance.workspace ||
      lease.sandbox_name !== provenance.name ||
      lease.sandbox_workspace !== provenance.workspace ||
      lease.gateway_digest !== provenance.gatewayDigest ||
      lease.mount_table_digest !== provenance.mountTableDigest ||
      state.workspace?.generation !== lease.workspace_generation ||
      state.workspace.manifest_digest !== lease.baseline_manifest_digest
    ) {
      await this.block(
        lease.id,
        "Writable Sandbox provenance did not match its persisted lease",
      );
      throw new OrchestratorError(
        "write_lease_provenance_mismatch",
        `Writable Sandbox does not match Write Lease '${lease.id}'`,
      );
    }
    return this.replaceLease(
      lease,
      activateWriteLease(lease, {
        sandboxId: provenance.id,
        sandboxDigest: provenance.sandboxDigest,
        activatedAt: this.timestamp(),
      }),
    );
  }

  async renew(leaseId: string, expiresAt: string): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    return this.replaceLease(
      lease,
      renewWriteLease(lease, { expiresAt: TimestampSchema.parse(expiresAt) }),
    );
  }

  async beginRevocation(leaseId: string): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    if (lease.status === "releasing" || lease.status === "blocked")
      return lease;
    return this.replaceLease(
      lease,
      revokeWriteLease(lease, { startedAt: this.timestamp() }),
    );
  }

  async revokeExpired(leaseId: string): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    if (this.now().getTime() < Date.parse(lease.expires_at)) return lease;
    return this.beginRevocation(lease.id);
  }

  async reconcile(
    leaseId: string,
    provenance: WritableSandboxProvenance | null,
  ): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    if (provenance === null) return this.beginRevocation(lease.id);
    const exact =
      lease.sandbox_name === provenance.name &&
      lease.sandbox_workspace === provenance.workspace &&
      lease.gateway_digest === provenance.gatewayDigest &&
      lease.mount_table_digest === provenance.mountTableDigest &&
      (lease.sandbox_digest === null ||
        lease.sandbox_digest === provenance.sandboxDigest) &&
      (lease.sandbox_id === null || lease.sandbox_id === provenance.id);
    if (!exact) {
      await this.block(
        lease.id,
        "Observed writable Sandbox did not match persisted lease provenance",
      );
      throw new OrchestratorError(
        "write_lease_provenance_mismatch",
        `Cannot reconcile Write Lease '${lease.id}' from different provenance`,
      );
    }
    if (lease.status === "preparing")
      return this.activate(lease.id, provenance);
    return lease;
  }

  async block(
    leaseId: string,
    reason: string,
    sandboxDeletedAt?: string,
  ): Promise<WriteLease> {
    const lease = await this.currentLease(leaseId);
    if (lease.status === "blocked") return lease;
    const timestamp = this.timestamp();
    const blocked = blockWriteLease(lease, {
      reason,
      blockedAt: timestamp,
      ...(sandboxDeletedAt ? { sandboxDeletedAt } : {}),
    });
    await this.leases.put(blocked);
    await this.store.updateRun(this.runId, (state) => {
      const workspace = state.workspace;
      if (
        !workspace?.active_lease ||
        workspace.active_lease.id !== lease.id ||
        workspace.active_lease.digest !== lease.digest
      ) {
        throw new OrchestratorError(
          "write_lease_stale",
          `Write Lease '${lease.id}' changed while it was blocked`,
        );
      }
      const task = currentTask(state, lease.task);
      return {
        ...state,
        status: "blocked",
        tasks: {
          ...state.tasks,
          [lease.task]: { ...task, status: "blocked" },
        },
        workspace: {
          ...workspace,
          active_lease: writeLeaseReference(blocked),
        },
      };
    });
    return blocked;
  }

  private async existingChangeSet(
    id: string,
    requested: ChangeSet,
  ): Promise<ChangeSet | undefined> {
    const versions = await this.changes.list(id);
    const matching = versions.find((entry) =>
      sameWithout(
        entry as unknown as Record<string, unknown>,
        requested as unknown as Record<string, unknown>,
        ["digest", "created_at"],
      ),
    );
    if (!matching && versions.length > 0) {
      throw new OrchestratorError(
        "change_set_conflict",
        `Change Set ID '${id}' already identifies another Workspace delta`,
      );
    }
    return matching;
  }

  async release(input: ReleaseWriteLeaseInput): Promise<ChangeSet> {
    const initial = await this.store.readRun(this.runId);
    const published = initial.workspace?.change_sets.find(
      (entry) => entry.id === IdentifierSchema.parse(input.changeSetId),
    );
    if (published) {
      const changeSet = await this.changes.get(published);
      if (changeSet.lease.id !== IdentifierSchema.parse(input.leaseId)) {
        throw new OrchestratorError(
          "change_set_conflict",
          `Change Set '${input.changeSetId}' belongs to another Write Lease`,
        );
      }
      return changeSet;
    }
    const lease = await this.currentLease(input.leaseId);
    if (lease.status !== "releasing") {
      throw new OrchestratorError(
        "write_lease_transition",
        `Write Lease '${lease.id}' must begin revocation before release`,
      );
    }
    const deletionTime = this.timestamp();
    let deletionVerified = false;
    let validationComplete = false;
    try {
      if (input.writableSandboxIds.length > 0) {
        throw new OrchestratorError(
          "writable_sandbox_present",
          `Writable Sandboxes remain: ${input.writableSandboxIds.join(", ")}`,
        );
      }
      if (
        lease.sandbox_id !== null &&
        input.deletedSandboxId !== lease.sandbox_id
      ) {
        throw new OrchestratorError(
          "sandbox_deletion_unverified",
          `Sandbox '${lease.sandbox_id}' deletion was not verified`,
        );
      }
      if (lease.sandbox_id === null && input.deletedSandboxId !== null) {
        throw new OrchestratorError(
          "sandbox_deletion_unverified",
          "Deletion evidence names a Sandbox not bound to the lease",
        );
      }
      deletionVerified = true;
      const baseline = validateWorkspaceManifest(input.baselineManifest);
      const result = validateWorkspaceManifest(input.resultManifest);
      const gitDiff = validateWorkspaceDiff(input.gitDiff);
      const state = await this.store.readRun(this.runId);
      const workspace = state.workspace;
      if (input.task.id !== lease.task) {
        throw new OrchestratorError(
          "write_lease_task_mismatch",
          `Write Lease '${lease.id}' belongs to Task '${lease.task}', not '${input.task.id}'`,
        );
      }
      if (
        !workspace ||
        workspace.generation !== lease.workspace_generation ||
        workspace.manifest_digest !== lease.baseline_manifest_digest ||
        baseline.digest !== lease.baseline_manifest_digest
      ) {
        throw new OrchestratorError(
          "write_lease_baseline_stale",
          "Write Lease baseline cannot explain the current Workspace",
        );
      }
      if (
        gitDiff.manifest_digest !== result.digest ||
        gitDiff.input_commit !==
          (state.tasks[lease.task]?.input_commit ?? state.base_commit)
      ) {
        throw new OrchestratorError(
          "workspace_diff_mismatch",
          "Result Git diff does not match the lease Task and manifest",
        );
      }
      if (
        pathPolicyDigest("write-roots", lease.write_roots) !==
          lease.write_roots_digest ||
        pathPolicyDigest("scope", input.task.scope) !==
          lease.scope_policy_digest ||
        pathPolicyDigest("protected", input.protectedPatterns) !==
          lease.protected_policy_digest ||
        pathPolicyDigest("restricted", input.restrictedPatterns) !==
          lease.restricted_policy_digest
      ) {
        throw new OrchestratorError(
          "write_lease_policy_stale",
          "Write Lease path policy changed before release",
        );
      }
      const manifestChanges = compareWorkspaceManifests(baseline, result);
      const outsideRoots = manifestChanges.filter(
        (change) =>
          !lease.write_roots.some((root) => contains(root, change.path)),
      );
      if (outsideRoots.length > 0) {
        throw new OrchestratorError(
          "write_lease_root_violation",
          `Workspace changes fall outside lease write roots: ${outsideRoots.map((entry) => entry.path).join(", ")}`,
        );
      }
      validateChangedPaths({
        changes: [...manifestChanges],
        task: input.task,
        protectedPatterns: input.protectedPatterns,
        restrictedPatterns: input.restrictedPatterns,
      });
      validationComplete = true;
      const createdAt = this.timestamp();
      let changeSet = createChangeSet({
        version: 2,
        id: input.changeSetId,
        run: state.id,
        plan: state.plan_id,
        task: lease.task,
        identity: lease.identity,
        lease: writeLeaseReference(lease),
        baseline_generation: lease.workspace_generation,
        result_generation: lease.workspace_generation + 1,
        baseline_manifest_digest: baseline.digest,
        result_manifest_digest: result.digest,
        changes: [...manifestChanges],
        git_diff_digest: gitDiff.digest,
        write_roots_digest: lease.write_roots_digest,
        scope_policy_digest: lease.scope_policy_digest,
        protected_policy_digest: lease.protected_policy_digest,
        restricted_policy_digest: lease.restricted_policy_digest,
        validation: {
          write_roots: "pass",
          scope: "pass",
          protected: "pass",
          restricted: "pass",
        },
        permission_ceiling_digest: lease.permission_ceiling_digest,
        route_digest: lease.route_digest,
        policy_digest: lease.policy_digest,
        image_digest: lease.image_digest,
        gateway_digest: lease.gateway_digest,
        mount_table_digest: lease.mount_table_digest,
        sandbox_digest: lease.sandbox_digest,
        report: input.report ?? null,
        created_at: createdAt,
      });
      changeSet =
        (await this.existingChangeSet(changeSet.id, changeSet)) ?? changeSet;
      await this.changes.put(changeSet);

      let released = (await this.leases.list(lease.id)).find(
        (entry) =>
          entry.status === "released" && sameWriteLeaseBinding(entry, lease),
      );
      released ??= releaseWriteLease(lease, {
        sandboxDeletedAt: deletionTime,
        releasedAt: createdAt,
      });
      await this.leases.put(released);
      const reference = changeSetReference(changeSet);
      await this.store.updateRun(this.runId, (current) => {
        const currentWorkspace = current.workspace;
        if (!currentWorkspace) {
          throw new OrchestratorError(
            "workspace_uninitialized",
            `Run '${current.id}' has no Workspace`,
          );
        }
        const existing = currentWorkspace.change_sets.find(
          (entry) => entry.id === changeSet.id,
        );
        if (existing) {
          if (existing.digest !== changeSet.digest) {
            throw new OrchestratorError(
              "change_set_conflict",
              `Change Set '${changeSet.id}' was published with another digest`,
            );
          }
          return current;
        }
        if (
          currentWorkspace.active_lease?.id !== lease.id ||
          currentWorkspace.active_lease.digest !== lease.digest ||
          currentWorkspace.generation !== lease.workspace_generation ||
          currentWorkspace.manifest_digest !== lease.baseline_manifest_digest
        ) {
          throw new OrchestratorError(
            "write_lease_stale",
            `Write Lease '${lease.id}' changed before release publication`,
          );
        }
        const task = currentTask(current, lease.task);
        const timestamp = createdAt;
        return {
          ...current,
          tasks: {
            ...current.tasks,
            [lease.task]: staleGates(
              {
                ...task,
                input_source_digest:
                  task.input_source_digest ?? baseline.digest,
                output_source_digest: result.digest,
                diff_digest: gitDiff.digest,
              },
              timestamp,
              "Workspace generation changed",
            ),
          },
          workspace: {
            ...currentWorkspace,
            phase: "stable",
            generation: changeSet.result_generation,
            manifest_digest: DigestSchema.parse(result.digest),
            git_diff_digest: DigestSchema.parse(gitDiff.digest),
            active_lease: null,
            change_sets: [...currentWorkspace.change_sets, reference],
            drift: null,
          },
        };
      });
      return changeSet;
    } catch (error) {
      if (
        validationComplete ||
        (error instanceof OrchestratorError &&
          ["write_lease_stale", "change_set_conflict"].includes(error.code))
      ) {
        throw error;
      }
      await this.block(
        lease.id,
        formatUnknownError(error),
        deletionVerified ? deletionTime : undefined,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async currentApproval(state: RunState): Promise<Approval> {
    const project = await this.store.read();
    const approval = project.approvals[state.plan_id];
    requireFreshApproval(approval, {
      planId: state.plan_id,
      planRevision: state.plan_revision,
      planDigest: DigestSchema.parse(state.plan_digest),
      permissionPolicyDigest: DigestSchema.parse(
        state.permission_policy_digest,
      ),
      routingPolicyDigest: DigestSchema.parse(state.routing_policy_digest),
      baseCommit: state.base_commit,
    });
    return approval!;
  }

  private async taskChangeSets(
    state: RunState,
    taskId: string,
  ): Promise<ChangeSet[]> {
    const references = state.workspace!.change_sets;
    const records = await Promise.all(
      references.map((reference) => this.changes.get(reference)),
    );
    const selected = records.filter((record) => record.task === taskId);
    if (selected.length === 0) {
      throw new OrchestratorError(
        "candidate_change_sets_missing",
        `Task '${taskId}' has no accepted Change Sets`,
      );
    }
    for (let index = 1; index < selected.length; index += 1) {
      const previous = selected[index - 1]!;
      const current = selected[index]!;
      if (
        current.baseline_generation !== previous.result_generation ||
        current.baseline_manifest_digest !== previous.result_manifest_digest
      ) {
        throw new OrchestratorError(
          "candidate_change_set_gap",
          `Task '${taskId}' Change Sets do not form one Workspace sequence`,
        );
      }
    }
    return selected;
  }

  private async existingCandidate(
    id: string,
    requested: Candidate,
  ): Promise<Candidate | undefined> {
    const versions = await this.candidates.list(id);
    const matching = versions.find(
      (entry) =>
        entry.status === "frozen" &&
        sameWithout(
          entry as unknown as Record<string, unknown>,
          requested as unknown as Record<string, unknown>,
          ["digest", "frozen_at", "status", "status_at", "reason"],
        ),
    );
    if (!matching && versions.length > 0) {
      throw new OrchestratorError(
        "candidate_conflict",
        `Candidate ID '${id}' already identifies another frozen result`,
      );
    }
    return matching;
  }

  async freeze(input: FreezeCandidateInput): Promise<Candidate> {
    if (input.writableSandboxIds.length > 0) {
      throw new OrchestratorError(
        "writable_sandbox_present",
        `Cannot freeze while writable Sandboxes remain: ${input.writableSandboxIds.join(", ")}`,
      );
    }
    const manifest = validateWorkspaceManifest(input.manifest);
    const gitDiff = validateWorkspaceDiff(input.gitDiff);
    const state = await this.store.readRun(this.runId);
    const workspace = state.workspace;
    if (!workspace) {
      throw new OrchestratorError(
        "workspace_uninitialized",
        `Run '${state.id}' has no Workspace`,
      );
    }
    if (workspace.candidate?.status === "frozen") {
      if (workspace.candidate.id === input.id) {
        const candidate = await this.candidates.get(workspace.candidate);
        const approval = await this.currentApproval(state);
        if (
          candidate.task !== input.task.id ||
          candidate.manifest_digest !== manifest.digest ||
          candidate.git_diff_digest !== gitDiff.digest ||
          candidate.approval_digest !== approvalDigest(approval)
        ) {
          throw new OrchestratorError(
            "candidate_conflict",
            `Candidate ID '${input.id}' was frozen from different inputs`,
          );
        }
        return candidate;
      }
      throw new OrchestratorError(
        "candidate_frozen",
        `Run '${state.id}' already has Candidate '${workspace.candidate.id}'`,
      );
    }
    if (workspace.phase !== "stable" || workspace.active_lease) {
      throw new OrchestratorError(
        "workspace_not_stable",
        `Run '${state.id}' Workspace is not stable`,
      );
    }
    if (workspace.drift) {
      throw new OrchestratorError(
        "workspace_drift",
        `Run '${state.id}' Workspace has unexplained changes`,
      );
    }
    if (
      workspace.manifest_digest !== manifest.digest ||
      workspace.git_diff_digest !== gitDiff.digest ||
      gitDiff.manifest_digest !== manifest.digest
    ) {
      throw new OrchestratorError(
        "candidate_stale",
        "Candidate inputs do not match current Workspace digests",
      );
    }
    const task = currentTask(state, input.task.id);
    const inputCommit = task.input_commit ?? state.base_commit;
    if (gitDiff.input_commit !== inputCommit) {
      throw new OrchestratorError(
        "candidate_base_mismatch",
        "Candidate Git diff does not use the Task input commit",
      );
    }
    validateChangedPaths({
      changes: gitDiff.changes,
      task: input.task,
      protectedPatterns: input.protectedPatterns,
      restrictedPatterns: input.restrictedPatterns,
    });
    const changeSets = await this.taskChangeSets(state, input.task.id);
    const scopePolicyDigest = pathPolicyDigest("scope", input.task.scope);
    const protectedPolicyDigest = pathPolicyDigest(
      "protected",
      input.protectedPatterns,
    );
    const restrictedPolicyDigest = pathPolicyDigest(
      "restricted",
      input.restrictedPatterns,
    );
    if (
      changeSets.some(
        (changeSet) =>
          changeSet.scope_policy_digest !== scopePolicyDigest ||
          changeSet.protected_policy_digest !== protectedPolicyDigest ||
          changeSet.restricted_policy_digest !== restrictedPolicyDigest,
      )
    ) {
      throw new OrchestratorError(
        "candidate_policy_stale",
        "Candidate path policy does not match its Change Sets",
      );
    }
    const last = changeSets.at(-1)!;
    if (
      last.result_generation !== workspace.generation ||
      last.result_manifest_digest !== manifest.digest
    ) {
      throw new OrchestratorError(
        "candidate_change_set_stale",
        "Latest Task Change Set does not produce the current Workspace",
      );
    }
    const approval = await this.currentApproval(state);
    const entries = workspaceManifestEntries(manifest);
    const changedPaths: CandidatePath[] = gitDiff.changes.map((change) => {
      const entry = entries.get(change.path);
      return {
        path: change.path,
        mode: entry?.mode ?? ("absent" as const),
        byte_count: entry?.byte_count ?? 0,
        content_digest: entry?.content_digest
          ? DigestSchema.parse(entry.content_digest)
          : null,
      };
    });
    const frozenAt = this.timestamp();
    let candidate = createCandidate({
      version: 2,
      id: input.id,
      run: state.id,
      plan: state.plan_id,
      plan_revision: state.plan_revision,
      plan_digest: DigestSchema.parse(state.plan_digest),
      approval_digest: approvalDigest(approval),
      task: input.task.id,
      input_commit: inputCommit,
      workspace_generation: workspace.generation,
      manifest_digest: manifest.digest,
      git_diff_digest: gitDiff.digest,
      change_sets: changeSets.map(changeSetReference),
      changed_paths: changedPaths,
      permission_policy_digest: DigestSchema.parse(
        state.permission_policy_digest,
      ),
      routing_policy_digest: DigestSchema.parse(state.routing_policy_digest),
      scope_policy_digest: scopePolicyDigest,
      protected_policy_digest: protectedPolicyDigest,
      restricted_policy_digest: restrictedPolicyDigest,
      permission_ceiling_digests: sortedDigests(
        changeSets.map((entry) => entry.permission_ceiling_digest),
      ),
      route_digests: sortedDigests(
        changeSets.map((entry) => entry.route_digest),
      ),
      image_digests: sortedDigests(
        changeSets.map((entry) => entry.image_digest),
      ),
      policy_digests: sortedDigests(
        changeSets.map((entry) => entry.policy_digest),
      ),
      gateway_digests: sortedDigests(
        changeSets.map((entry) => entry.gateway_digest),
      ),
      mount_table_digests: sortedDigests(
        changeSets.map((entry) => entry.mount_table_digest),
      ),
      sandbox_digests: sortedDigests(
        changeSets.flatMap((entry) =>
          entry.sandbox_digest ? [entry.sandbox_digest] : [],
        ),
      ),
      frozen_at: frozenAt,
      status: "frozen",
      status_at: frozenAt,
      reason: null,
    });
    candidate =
      (await this.existingCandidate(candidate.id, candidate)) ?? candidate;
    await this.candidates.put(candidate);
    const reference = candidateReference(candidate);
    await this.store.updateRun(this.runId, (current) => {
      const currentWorkspace = current.workspace;
      if (
        !currentWorkspace ||
        currentWorkspace.phase !== "stable" ||
        currentWorkspace.active_lease ||
        currentWorkspace.generation !== candidate.workspace_generation ||
        currentWorkspace.manifest_digest !== candidate.manifest_digest ||
        currentWorkspace.git_diff_digest !== candidate.git_diff_digest ||
        current.plan_digest !== candidate.plan_digest ||
        current.permission_policy_digest !==
          candidate.permission_policy_digest ||
        current.routing_policy_digest !== candidate.routing_policy_digest
      ) {
        throw new OrchestratorError(
          "candidate_stale",
          `Candidate '${candidate.id}' changed before freeze publication`,
        );
      }
      if (currentWorkspace.candidate?.status === "frozen") {
        if (
          currentWorkspace.candidate.id === candidate.id &&
          currentWorkspace.candidate.digest === candidate.digest
        ) {
          return current;
        }
        throw new OrchestratorError(
          "candidate_frozen",
          `Run '${current.id}' already froze another Candidate`,
        );
      }
      return {
        ...current,
        tasks: {
          ...current.tasks,
          [candidate.task]: staleGates(
            currentTask(current, candidate.task),
            candidate.frozen_at,
            "Candidate identity changed",
          ),
        },
        workspace: {
          ...currentWorkspace,
          phase: "frozen",
          candidate: reference,
        },
      };
    });
    return candidate;
  }

  async transitionCandidate(
    candidateId: string,
    status: "accepted" | "discarded",
    reason?: string,
  ): Promise<Candidate> {
    const state = await this.store.readRun(this.runId);
    const reference = state.workspace?.candidate;
    if (!reference || reference.id !== IdentifierSchema.parse(candidateId)) {
      throw new OrchestratorError(
        "candidate_not_current",
        `Candidate '${candidateId}' is not current for Run '${state.id}'`,
      );
    }
    const current = await this.candidates.get(reference);
    const next = transitionCandidate(current, {
      status,
      at: this.timestamp(),
      ...(reason ? { reason } : {}),
    });
    await this.candidates.put(next);
    await this.store.updateRun(this.runId, (run) => {
      const workspace = run.workspace;
      if (
        !workspace?.candidate ||
        workspace.candidate.digest !== current.digest
      ) {
        throw new OrchestratorError(
          "candidate_stale",
          `Candidate '${current.id}' changed during transition`,
        );
      }
      return {
        ...run,
        tasks:
          status === "discarded"
            ? {
                ...run.tasks,
                [current.task]: staleGates(
                  currentTask(run, current.task),
                  next.status_at,
                  "Candidate was discarded",
                ),
              }
            : run.tasks,
        workspace: {
          ...workspace,
          phase: "stable",
          candidate: candidateReference(next),
        },
      };
    });
    return next;
  }

  async observe(input: {
    readonly manifest: WorkspaceManifest;
    readonly gitDiff: WorkspaceDiff;
    readonly writableSandboxIds: readonly string[];
  }): Promise<void> {
    const manifest = validateWorkspaceManifest(input.manifest);
    const gitDiff = validateWorkspaceDiff(input.gitDiff);
    if (gitDiff.manifest_digest !== manifest.digest) {
      throw new OrchestratorError(
        "workspace_diff_mismatch",
        "Observed Git diff does not match the observed manifest",
      );
    }
    const state = await this.store.readRun(this.runId);
    const workspace = state.workspace;
    if (!workspace) {
      throw new OrchestratorError(
        "workspace_uninitialized",
        `Run '${state.id}' has no Workspace`,
      );
    }
    if (workspace.active_lease) {
      const lease = await this.leases.get(workspace.active_lease);
      const unexpected = input.writableSandboxIds.filter(
        (sandboxId) => sandboxId !== lease.sandbox_id,
      );
      if (unexpected.length > 0) {
        await this.block(
          lease.id,
          `Unleased writable Sandboxes were observed: ${unexpected.join(", ")}`,
        );
        throw new OrchestratorError(
          "writable_sandbox_without_lease",
          `Writable Sandboxes do not match Write Lease '${lease.id}'`,
        );
      }
      return;
    }
    const unleasedWritable = input.writableSandboxIds.length > 0;
    if (
      workspace.manifest_digest === manifest.digest &&
      workspace.git_diff_digest === gitDiff.digest &&
      !unleasedWritable
    ) {
      return;
    }

    const timestamp = this.timestamp();
    const reason = unleasedWritable
      ? `Writable Sandboxes exist without a Write Lease: ${input.writableSandboxIds.join(", ")}`
      : "Workspace digest changed without a Write Lease";
    let staleCandidate: Candidate | undefined;
    if (workspace.candidate?.status === "frozen") {
      const current = await this.candidates.get(workspace.candidate);
      staleCandidate = transitionCandidate(current, {
        status: "stale",
        at: timestamp,
        reason,
      });
      await this.candidates.put(staleCandidate);
    }
    await this.store.updateRun(this.runId, (current) => {
      const currentWorkspace = current.workspace;
      if (!currentWorkspace || currentWorkspace.active_lease) return current;
      if (
        currentWorkspace.manifest_digest === manifest.digest &&
        currentWorkspace.git_diff_digest === gitDiff.digest
      ) {
        return current;
      }
      return {
        ...current,
        status: "blocked",
        tasks: Object.fromEntries(
          Object.entries(current.tasks).map(([id, task]) => [
            id,
            staleGates(task, timestamp, reason),
          ]),
        ),
        workspace: {
          ...currentWorkspace,
          phase: "stable",
          candidate: staleCandidate
            ? candidateReference(staleCandidate)
            : currentWorkspace.candidate,
          drift: {
            expected_manifest_digest: currentWorkspace.manifest_digest,
            observed_manifest_digest: DigestSchema.parse(manifest.digest),
            expected_git_diff_digest: currentWorkspace.git_diff_digest,
            observed_git_diff_digest: DigestSchema.parse(gitDiff.digest),
            observed_at: timestamp,
            reason,
          },
        },
      };
    });
    throw new OrchestratorError(
      unleasedWritable
        ? "writable_sandbox_without_lease"
        : "workspace_changed_without_lease",
      reason,
    );
  }
}

export function changedPaths(
  changes: readonly WorkspaceManifestChange[],
): readonly string[] {
  return changes.map((change) => change.path);
}
