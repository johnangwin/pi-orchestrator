import {
  CmuxPaneStateSchema,
  CmuxTitleSchema,
  CmuxWorkspaceStateSchema,
  type CmuxClient,
  type CmuxEnsureResult,
  type CmuxPaneBinding,
  type CmuxPaneProjectionStatus,
  type CmuxWorkspaceBinding,
  type CmuxWorkspaceProjectionStatus,
} from "./cmux.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson } from "./digest.js";
import { OrchestratorError } from "./error.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  type SessionIdentity,
} from "./session.js";
import type { ProjectStore, RunState } from "./state.js";

type ProjectionStore = Pick<ProjectStore, "readRun" | "updateRun">;

export type ProjectionCmux = Pick<
  CmuxClient,
  | "closePane"
  | "ensurePane"
  | "ensureWorkspace"
  | "preparePaneCreation"
  | "reconcile"
>;

export type DurableWorkspaceStatus =
  "unconfigured" | "prepared" | CmuxWorkspaceProjectionStatus;

export type DurablePaneStatus =
  "unconfigured" | "prepared" | CmuxPaneProjectionStatus;

export interface ProjectionInspection {
  readonly healthy: boolean;
  readonly workspace: DurableWorkspaceStatus;
  readonly pane: DurablePaneStatus;
}

export interface EnsureRunWorkspaceOptions {
  readonly operationId: string;
  readonly title: string;
  readonly cwd?: string;
  readonly description?: string;
  readonly command?: readonly string[];
  readonly focus?: boolean;
}

export interface EnsureAgentPaneOptions {
  readonly identity: SessionIdentity;
  readonly operationId: string;
  readonly title: string;
  readonly direction?: "left" | "right" | "up" | "down";
  readonly cwd?: string;
  readonly command?: readonly string[];
  readonly focus?: boolean;
}

function requireCurrent(state: RunState, identity: SessionIdentity): void {
  const agent = state.agents[identity.agent];
  if (
    identity.run !== state.id ||
    !agent ||
    agent.session !== identity.session ||
    agent.generation !== identity.generation
  ) {
    throw new OrchestratorError(
      "stale_session",
      `Session '${identity.session}' at generation ${identity.generation} is not current for Agent '${identity.agent}' in Run '${state.id}'`,
    );
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class ProjectionRegistry {
  readonly runId: string;

  constructor(
    private readonly store: ProjectionStore,
    runId: string,
    private readonly cmux: ProjectionCmux,
  ) {
    this.runId = IdentifierSchema.parse(runId);
  }

  async ensureWorkspace(
    options: EnsureRunWorkspaceOptions,
  ): Promise<CmuxEnsureResult<CmuxWorkspaceBinding>> {
    const desired = CmuxWorkspaceStateSchema.parse({
      operation_id: options.operationId,
      title: options.title,
      binding: null,
    });
    let workspace = desired;
    await this.store.updateRun(this.runId, (state) => {
      const existing = state.cmux.workspace;
      if (existing) {
        if (
          existing.operation_id !== desired.operation_id ||
          existing.title !== desired.title
        ) {
          throw new OrchestratorError(
            "cmux_workspace_conflict",
            "The Run already has another cmux Workspace operation",
          );
        }
        workspace = existing;
        return state;
      }
      workspace = desired;
      return {
        ...state,
        cmux: { ...state.cmux, workspace: desired },
      };
    });

    const result = await this.cmux.ensureWorkspace({
      operationId: workspace.operation_id,
      title: workspace.title,
      binding: workspace.binding,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    });
    await this.store.updateRun(this.runId, (state) => {
      const current = state.cmux.workspace;
      if (
        !current ||
        current.operation_id !== desired.operation_id ||
        current.title !== desired.title
      ) {
        throw new OrchestratorError(
          "cmux_workspace_conflict",
          "The durable cmux Workspace operation changed while it was running",
        );
      }
      if (current.binding) {
        if (!sameValue(current.binding, result.binding)) {
          throw new OrchestratorError(
            "cmux_binding_conflict",
            "The Run Workspace is already bound to another cmux Workspace",
          );
        }
        return state;
      }
      return {
        ...state,
        cmux: {
          ...state.cmux,
          workspace: { ...current, binding: result.binding },
        },
      };
    });
    return result;
  }

  async ensurePane(
    options: EnsureAgentPaneOptions,
  ): Promise<CmuxEnsureResult<CmuxPaneBinding>> {
    const identity = SessionIdentitySchema.parse(options.identity);
    const desired = CmuxPaneStateSchema.parse({
      identity,
      operation_id: options.operationId,
      title: options.title,
      intent: null,
      binding: null,
      replaces: null,
    });
    let pane = desired;
    let workspace: CmuxWorkspaceBinding | undefined;
    await this.store.updateRun(this.runId, (state) => {
      requireCurrent(state, identity);
      workspace = state.cmux.workspace?.binding ?? undefined;
      if (!workspace) {
        throw new OrchestratorError(
          "cmux_workspace_unbound",
          "The Run Workspace must be durably bound before an Agent Pane",
        );
      }
      const existing = state.cmux.panes[identity.agent];
      if (existing) {
        if (
          !sameSessionIdentity(existing.identity, identity) ||
          existing.operation_id !== desired.operation_id ||
          existing.title !== desired.title
        ) {
          throw new OrchestratorError(
            "cmux_pane_conflict",
            `Agent '${identity.agent}' already has another cmux Pane operation`,
          );
        }
        pane = existing;
        return state;
      }
      pane = desired;
      return {
        ...state,
        cmux: {
          ...state.cmux,
          panes: { ...state.cmux.panes, [identity.agent]: desired },
        },
      };
    });

    if (!pane.binding && !pane.intent) {
      const intent = await this.cmux.preparePaneCreation({
        operationId: pane.operation_id,
        workspace: workspace!,
        title: pane.title,
      });
      await this.store.updateRun(this.runId, (state) => {
        requireCurrent(state, identity);
        const current = state.cmux.panes[identity.agent];
        if (
          !current ||
          !sameSessionIdentity(current.identity, identity) ||
          current.operation_id !== pane.operation_id
        ) {
          throw new OrchestratorError(
            "cmux_pane_conflict",
            "The durable cmux Pane operation changed while preparing its intent",
          );
        }
        if (current.intent) {
          if (!sameValue(current.intent, intent)) {
            throw new OrchestratorError(
              "cmux_intent_conflict",
              "The Agent Pane already has another durable creation intent",
            );
          }
          pane = current;
          return state;
        }
        pane = { ...current, intent };
        return {
          ...state,
          cmux: {
            ...state.cmux,
            panes: { ...state.cmux.panes, [identity.agent]: pane },
          },
        };
      });
    }

    const result = await this.cmux.ensurePane({
      operationId: pane.operation_id,
      workspace: workspace!,
      title: pane.title,
      binding: pane.binding,
      ...(pane.intent ? { intent: pane.intent } : {}),
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    });
    await this.store.updateRun(this.runId, (state) => {
      requireCurrent(state, identity);
      const current = state.cmux.panes[identity.agent];
      if (
        !current ||
        !sameSessionIdentity(current.identity, identity) ||
        current.operation_id !== pane.operation_id
      ) {
        throw new OrchestratorError(
          "cmux_pane_conflict",
          "The durable cmux Pane operation changed while it was running",
        );
      }
      if (current.binding) {
        if (!sameValue(current.binding, result.binding)) {
          throw new OrchestratorError(
            "cmux_binding_conflict",
            `Agent '${identity.agent}' is already bound to another cmux Pane`,
          );
        }
        return state;
      }
      return {
        ...state,
        cmux: {
          ...state.cmux,
          panes: {
            ...state.cmux.panes,
            [identity.agent]: { ...current, binding: result.binding },
          },
        },
      };
    });
    return result;
  }

  async reattachPane(
    options: EnsureAgentPaneOptions,
  ): Promise<CmuxEnsureResult<CmuxPaneBinding>> {
    const identity = SessionIdentitySchema.parse(options.identity);
    const state = await this.store.readRun(this.runId);
    requireCurrent(state, identity);
    const workspace = state.cmux.workspace?.binding;
    if (!workspace) {
      throw new OrchestratorError(
        "cmux_workspace_unbound",
        "The Run Workspace is not durably bound",
      );
    }
    const existing = state.cmux.panes[identity.agent];
    if (!existing) {
      return this.ensurePane(options);
    }
    if (!sameSessionIdentity(existing.identity, identity)) {
      throw new OrchestratorError(
        "stale_session",
        `The cmux Pane for Agent '${identity.agent}' belongs to another Session`,
      );
    }

    if (existing.operation_id === options.operationId) {
      if (existing.replaces) return this.ensurePane(options);
      throw new OrchestratorError(
        "cmux_operation_conflict",
        "A Pane reattachment requires a new operation ID",
      );
    }
    if (!existing.binding) {
      throw new OrchestratorError(
        "cmux_pane_unbound",
        `Agent '${identity.agent}' already has an unfinished Pane operation`,
      );
    }

    const observed = await this.cmux.reconcile({
      workspace,
      panes: { [identity.agent]: existing.binding },
    });
    const status = observed.panes[identity.agent]?.status;
    if (observed.workspace.status === "missing") {
      throw new OrchestratorError(
        "cmux_workspace_missing",
        "Cannot reattach a Pane while the bound Run Workspace is missing",
      );
    }
    if (status === "present" || status === "title_mismatch") {
      throw new OrchestratorError(
        "cmux_pane_present",
        `Agent '${identity.agent}' still has its bound cmux Pane`,
      );
    }
    if (status !== "missing" && status !== "surface_missing") {
      throw new OrchestratorError(
        "invalid_cmux_observation",
        "cmux did not report a valid missing state for the bound Agent Pane",
      );
    }

    const replacement = CmuxPaneStateSchema.parse({
      identity,
      operation_id: options.operationId,
      title: CmuxTitleSchema.parse(options.title),
      intent: null,
      binding: null,
      replaces: existing.binding,
    });
    await this.store.updateRun(this.runId, (current) => {
      requireCurrent(current, identity);
      const pane = current.cmux.panes[identity.agent];
      if (!pane || !sameValue(pane, existing)) {
        throw new OrchestratorError(
          "cmux_pane_conflict",
          "The durable cmux Pane changed before reattachment was recorded",
        );
      }
      return {
        ...current,
        cmux: {
          ...current.cmux,
          panes: { ...current.cmux.panes, [identity.agent]: replacement },
        },
      };
    });
    return this.ensurePane(options);
  }

  async removePane(identity: SessionIdentity): Promise<void> {
    const parsed = SessionIdentitySchema.parse(identity);
    const state = await this.store.readRun(this.runId);
    requireCurrent(state, parsed);
    const pane = state.cmux.panes[parsed.agent];
    if (!pane) return;
    if (!sameSessionIdentity(pane.identity, parsed)) {
      throw new OrchestratorError(
        "stale_session",
        `The cmux Pane for Agent '${parsed.agent}' belongs to another Session`,
      );
    }
    if (pane.binding) {
      const workspace = state.cmux.workspace?.binding;
      if (!workspace) {
        throw new OrchestratorError(
          "cmux_workspace_unbound",
          "The bound Agent Pane has no bound Run Workspace",
        );
      }
      const observed = await this.cmux.reconcile({
        workspace,
        panes: { [parsed.agent]: pane.binding },
      });
      const status = observed.panes[parsed.agent]?.status;
      if (observed.workspace.status === "missing") {
        if (status !== "workspace_missing") {
          throw new OrchestratorError(
            "invalid_cmux_observation",
            "cmux reported inconsistent missing-Workspace projection state",
          );
        }
      } else if (status === "present" || status === "title_mismatch") {
        await this.cmux.closePane(pane.binding);
      } else if (status !== "missing" && status !== "surface_missing") {
        throw new OrchestratorError(
          "invalid_cmux_observation",
          "cmux did not report a valid state for the bound Agent Pane",
        );
      }
    }

    await this.store.updateRun(this.runId, (current) => {
      requireCurrent(current, parsed);
      const existing = current.cmux.panes[parsed.agent];
      if (!existing) return current;
      if (!sameValue(existing, pane)) {
        throw new OrchestratorError(
          "cmux_pane_conflict",
          "The durable cmux Pane changed while it was being removed",
        );
      }
      const panes = { ...current.cmux.panes };
      delete panes[parsed.agent];
      return { ...current, cmux: { ...current.cmux, panes } };
    });
  }

  async inspect(identity: SessionIdentity): Promise<ProjectionInspection> {
    const parsed = SessionIdentitySchema.parse(identity);
    const state = await this.store.readRun(this.runId);
    requireCurrent(state, parsed);
    const workspaceState = state.cmux.workspace;
    if (!workspaceState) {
      return {
        healthy: false,
        workspace: "unconfigured",
        pane: "unconfigured",
      };
    }
    if (!workspaceState.binding) {
      return { healthy: false, workspace: "prepared", pane: "unconfigured" };
    }

    const pane = state.cmux.panes[parsed.agent];
    if (pane && !sameSessionIdentity(pane.identity, parsed)) {
      throw new OrchestratorError(
        "stale_session",
        `The cmux Pane for Agent '${parsed.agent}' belongs to another Session`,
      );
    }
    const reconciliation = await this.cmux.reconcile({
      workspace: workspaceState.binding,
      panes: pane?.binding ? { [parsed.agent]: pane.binding } : {},
    });
    const paneStatus: DurablePaneStatus = !pane
      ? "unconfigured"
      : !pane.binding
        ? "prepared"
        : (reconciliation.panes[parsed.agent]?.status ?? "unconfigured");
    return {
      healthy:
        reconciliation.workspace.status === "present" &&
        paneStatus === "present",
      workspace: reconciliation.workspace.status,
      pane: paneStatus,
    };
  }
}
