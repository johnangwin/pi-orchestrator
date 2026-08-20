import { z } from "zod";
import { IdentifierSchema, type ContextThresholds } from "./config.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { MailboxRouter, type MailboxLink } from "./mailbox.js";
import { MetricStore, type SessionMetricRecorder } from "./metric.js";
import { ResolvedModelRouteSchema, type ResolvedModelRoute } from "./model.js";
import type {
  PermissionCeiling,
  PermissionRuntimeState,
} from "./permission.js";
import type { OpenShellClient, OpenShellSandbox } from "./openshell.js";
import { ProjectionRegistry, type ProjectionInspection } from "./projection.js";
import { AgentRegistry } from "./registry.js";
import {
  ReadSession,
  resumeReadSession,
  resumeWriteSession,
  type AgentSessionProfile,
  type ResumeReadSessionOpenShell,
} from "./agent.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  type SessionIdentity,
  type SessionRecord,
  type SessionSandbox,
} from "./session.js";
import type { ProjectStore } from "./state.js";

export const SessionRecoveryActionSchema = z.enum([
  "none",
  "start",
  "reconnect",
  "reattach",
  "replace",
  "blocked",
]);
export type SessionRecoveryAction = z.infer<typeof SessionRecoveryActionSchema>;

export const SandboxObservationSchema = z.enum([
  "unbound",
  "missing",
  "identity_mismatch",
  "pending",
  "ready",
  "terminal",
]);
export type SandboxObservation = z.infer<typeof SandboxObservationSchema>;

export const LinkObservationSchema = z.enum([
  "missing",
  "connected",
  "failed",
  "stale",
]);
export type LinkObservation = z.infer<typeof LinkObservationSchema>;

export interface SessionReconciliation {
  readonly agent: string;
  readonly identity: SessionIdentity | null;
  readonly sessionStatus: SessionRecord["status"] | null;
  readonly sandbox: SandboxObservation;
  readonly link: LinkObservation;
  readonly projection: ProjectionInspection | null;
  readonly action: SessionRecoveryAction;
  readonly reasons: readonly string[];
}

export type SessionLifecycleOpenShell = ResumeReadSessionOpenShell &
  Pick<OpenShellClient, "listSandboxes">;

export interface SessionRuntime extends MailboxLink {
  readonly info: {
    readonly sandbox: OpenShellSandbox;
    readonly permissionCeiling: PermissionCeiling;
    readonly model?: ResolvedModelRoute;
  };
  ping(): Promise<string>;
  release(): Promise<void>;
  stop(): Promise<void>;
}

export interface RecoverSessionOptions {
  readonly identity: SessionIdentity;
  readonly runtime?: SessionRuntime;
  readonly profile?: AgentSessionProfile;
  readonly policyDirectory?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly context?: ContextThresholds;
  readonly model?: ResolvedModelRoute;
  readonly briefDigest?: string;
  readonly metrics?: SessionMetricRecorder;
  readonly task?: string;
  readonly currentActionState?: () =>
    PermissionRuntimeState | Promise<PermissionRuntimeState>;
}

export interface ReplaceSessionOptions {
  readonly expected: SessionIdentity;
  readonly session: string;
  readonly reason: string;
  readonly route: ResolvedModelRoute;
  readonly runtime?: SessionRuntime;
}

const ReplacementReasonSchema = z.string().trim().min(1).max(2_000);

type LifecycleStore = Pick<
  ProjectStore,
  "readRun" | "runDirectory" | "updateRun"
>;

function sameSandbox(
  expected: SessionSandbox,
  actual: Pick<OpenShellSandbox, "id" | "name" | "workspace">,
): boolean {
  return (
    expected.id === actual.id &&
    expected.name === actual.name &&
    expected.workspace === actual.workspace
  );
}

function terminalSession(session: SessionRecord): boolean {
  return session.status === "stopped" || session.status === "failed";
}

function terminalSandbox(sandbox: OpenShellSandbox): boolean {
  return ["Error", "Failed", "Stopped"].includes(sandbox.phase);
}

function replacementRetry(
  session: SessionRecord | null,
  expected: SessionIdentity,
  replacement: string,
  reason: string,
  routeDigest: string,
): boolean {
  return (
    session?.identity.run === expected.run &&
    session.identity.agent === expected.agent &&
    session.identity.session === replacement &&
    session.identity.generation === expected.generation + 1 &&
    session.replaces?.session === expected.session &&
    session.replaces.reason === reason &&
    session.route.route_digest === routeDigest
  );
}

export class SessionReconciler {
  readonly runId: string;
  readonly registry: AgentRegistry;
  readonly mailbox: MailboxRouter;

  constructor(
    private readonly store: LifecycleStore,
    runId: string,
    private readonly openshell: SessionLifecycleOpenShell,
    readonly projection: ProjectionRegistry,
    mailbox?: MailboxRouter,
  ) {
    this.runId = IdentifierSchema.parse(runId);
    this.registry = new AgentRegistry(store, this.runId);
    this.mailbox = mailbox ?? new MailboxRouter(store, this.runId);
  }

  async inspect(
    agentId: string,
    runtime?: Pick<SessionRuntime, "identity" | "info" | "ping">,
  ): Promise<SessionReconciliation> {
    const agent = await this.registry.get(IdentifierSchema.parse(agentId));
    const session = agent.session;
    if (!session) {
      return {
        agent: agent.id,
        identity: null,
        sessionStatus: null,
        sandbox: "unbound",
        link: "missing",
        projection: null,
        action: "start",
        reasons: ["Agent has no Session"],
      };
    }
    const identity = session.identity;
    if (terminalSession(session)) {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: session.sandbox ? "pending" : "unbound",
        link: "missing",
        projection: null,
        action: "replace",
        reasons: [`Current Session is ${session.status}`],
      };
    }
    if (!session.sandbox) {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "unbound",
        link: "missing",
        projection: null,
        action: session.status === "starting" ? "start" : "replace",
        reasons: ["Current Session has no durable Sandbox binding"],
      };
    }

    const sandboxes = await this.openshell.listSandboxes();
    const actual = sandboxes.find(
      (candidate) => candidate.name === session.sandbox!.name,
    );
    if (!actual) {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "missing",
        link: "missing",
        projection: null,
        action: "replace",
        reasons: ["Durably bound Sandbox is missing"],
      };
    }
    if (!sameSandbox(session.sandbox, actual)) {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "identity_mismatch",
        link: "missing",
        projection: null,
        action: "blocked",
        reasons: ["Sandbox name now resolves to different provenance"],
      };
    }
    if (actual.phase !== "Ready") {
      const terminal = terminalSandbox(actual);
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: terminal ? "terminal" : "pending",
        link: "missing",
        projection: null,
        action: terminal ? "replace" : "blocked",
        reasons: [`Sandbox is ${actual.phase}`],
      };
    }

    let link: LinkObservation = "missing";
    const reasons: string[] = [];
    if (runtime) {
      if (!sameSessionIdentity(runtime.identity, identity)) {
        link = "stale";
        reasons.push("Live runtime identifies another Session or generation");
      } else if (!sameSandbox(session.sandbox, runtime.info.sandbox)) {
        link = "stale";
        reasons.push("Live runtime identifies another Sandbox provenance");
      } else {
        try {
          await runtime.ping();
          link = "connected";
        } catch (error) {
          link = "failed";
          reasons.push(`Link probe failed: ${formatUnknownError(error)}`);
        }
      }
    } else {
      reasons.push("Host has no live Link for the current Session");
    }

    const projection = await this.projection.inspect(identity);
    if (link === "stale") {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "ready",
        link,
        projection,
        action: "blocked",
        reasons,
      };
    }
    if (link !== "connected") {
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "ready",
        link,
        projection,
        action: "reconnect",
        reasons,
      };
    }

    if (
      ["unconfigured", "prepared", "missing"].includes(projection.workspace)
    ) {
      reasons.push(`Run Workspace is ${projection.workspace}`);
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "ready",
        link,
        projection,
        action: "blocked",
        reasons,
      };
    }
    if (!projection.healthy) {
      reasons.push(
        `Visible projection is ${projection.workspace}/${projection.pane}`,
      );
      return {
        agent: agent.id,
        identity,
        sessionStatus: session.status,
        sandbox: "ready",
        link,
        projection,
        action: "reattach",
        reasons,
      };
    }
    return {
      agent: agent.id,
      identity,
      sessionStatus: session.status,
      sandbox: "ready",
      link,
      projection,
      action: "none",
      reasons,
    };
  }

  async activate(
    session: SessionRuntime,
    pane?: Omit<Parameters<ProjectionRegistry["ensurePane"]>[0], "identity">,
  ): Promise<void> {
    const identity = SessionIdentitySchema.parse(session.identity);
    const current = await this.registry.requireCurrent(identity);
    if (
      session.info.permissionCeiling.permission_ceiling_digest !==
      current.permission_ceiling_digest
    ) {
      throw new OrchestratorError(
        "session_permission_stale",
        "Live Session permission ceiling does not match durable state",
      );
    }
    if (
      !session.info.model ||
      session.info.model.route_digest !== current.route.route_digest
    ) {
      throw new OrchestratorError(
        "session_route_stale",
        "Live Session resolved route does not match durable state",
      );
    }
    await this.registry.bindSandbox(identity, {
      id: session.info.sandbox.id,
      name: session.info.sandbox.name,
      workspace: session.info.sandbox.workspace,
    });
    await this.mailbox.attach(session);
    if (pane) await this.projection.ensurePane({ ...pane, identity });
  }

  async recover(options: RecoverSessionOptions): Promise<ReadSession> {
    const identity = SessionIdentitySchema.parse(options.identity);
    const current = await this.registry.requireCurrent(identity);
    if (terminalSession(current)) {
      throw new OrchestratorError(
        "session_terminal",
        `Cannot recover ${current.status} Session '${identity.session}'`,
      );
    }
    if (!current.sandbox) {
      throw new OrchestratorError(
        "sandbox_unbound",
        `Session '${identity.session}' has no durable Sandbox binding`,
      );
    }
    if (
      !options.model ||
      options.model.route_digest !== current.route.route_digest
    ) {
      throw new OrchestratorError(
        "session_route_stale",
        "Session recovery requires the exact durable resolved route",
      );
    }
    if (options.runtime) {
      if (!sameSessionIdentity(options.runtime.identity, identity)) {
        throw new OrchestratorError(
          "stale_session",
          "Cannot release a runtime for another Session during recovery",
        );
      }
      if (!sameSandbox(current.sandbox, options.runtime.info.sandbox)) {
        throw new OrchestratorError(
          "sandbox_identity_mismatch",
          "Live runtime Sandbox does not match the durable Session binding",
        );
      }
    }
    await this.mailbox.detach(identity);
    await options.runtime?.release();

    const resume =
      options.profile === "write" ? resumeWriteSession : resumeReadSession;
    const recovered = await resume({
      client: this.openshell,
      identity,
      sandbox: current.sandbox,
      permissionCeilingDigest: current.permission_ceiling_digest,
      ...(options.policyDirectory
        ? { policyDirectory: options.policyDirectory }
        : {}),
      ...(options.piVersion ? { piVersion: options.piVersion } : {}),
      ...(options.clientVersion
        ? { clientVersion: options.clientVersion }
        : {}),
      ...(options.startupTimeoutMs
        ? { startupTimeoutMs: options.startupTimeoutMs }
        : {}),
      ...(options.turnTimeoutMs
        ? { turnTimeoutMs: options.turnTimeoutMs }
        : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.briefDigest ? { briefDigest: options.briefDigest } : {}),
      metrics:
        options.metrics ??
        new MetricStore(this.store.runDirectory(this.runId), this.runId),
      ...(options.task ? { task: options.task } : {}),
      ...(options.currentActionState
        ? { currentActionState: options.currentActionState }
        : {}),
    });
    try {
      await this.mailbox.attach(recovered);
      return recovered;
    } catch (error) {
      await recovered.release().catch(() => undefined);
      throw error;
    }
  }

  async replace(options: ReplaceSessionOptions): Promise<SessionRecord> {
    const expected = SessionIdentitySchema.parse(options.expected);
    const sessionId = IdentifierSchema.parse(options.session);
    const reason = ReplacementReasonSchema.parse(options.reason);
    const snapshot = await this.registry.get(expected.agent);
    const route = ResolvedModelRouteSchema.parse(options.route);
    if (
      replacementRetry(
        snapshot.session,
        expected,
        sessionId,
        reason,
        route.route_digest,
      )
    ) {
      return snapshot.session!;
    }
    const current = await this.registry.requireCurrent(expected);

    if (options.runtime) {
      if (!sameSessionIdentity(options.runtime.identity, expected)) {
        throw new OrchestratorError(
          "stale_session",
          "Cannot stop a runtime for another Session during replacement",
        );
      }
      if (!current.sandbox) {
        throw new OrchestratorError(
          "sandbox_unbound",
          "Cannot stop a live runtime without a durable Sandbox binding",
        );
      }
      if (!sameSandbox(current.sandbox, options.runtime.info.sandbox)) {
        throw new OrchestratorError(
          "sandbox_identity_mismatch",
          "Live runtime Sandbox does not match the durable Session binding",
        );
      }
    }

    let actualSandbox: OpenShellSandbox | undefined;
    if (current.sandbox) {
      const sandboxes = await this.openshell.listSandboxes();
      actualSandbox = sandboxes.find(
        (candidate) => candidate.name === current.sandbox!.name,
      );
      if (actualSandbox && !sameSandbox(current.sandbox, actualSandbox)) {
        throw new OrchestratorError(
          "sandbox_identity_mismatch",
          `Refusing to delete Sandbox '${current.sandbox.name}' with different provenance`,
        );
      }
    }

    await this.mailbox.detach(expected);
    if (!terminalSession(current)) {
      await this.registry.transition(expected, { status: "stopped", reason });
    }
    if (options.runtime) {
      await options.runtime.stop();
    } else if (current.sandbox && actualSandbox) {
      await this.openshell.deleteSandbox(current.sandbox.name, {
        missingOk: true,
      });
    }

    await this.projection.removePane(expected);
    await this.mailbox.supersedePending(expected);
    return this.registry.replace({
      expected,
      session: sessionId,
      reason,
      route,
      permissionCeilingDigest: current.permission_ceiling_digest,
    });
  }
}
