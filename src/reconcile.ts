import { z } from "zod";
import { IdentifierSchema, type ContextThresholds } from "./config.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { MailboxRouter, type MailboxLink } from "./mailbox.js";
import type { ResolvedModelRoute } from "./model.js";
import type { OpenShellClient, OpenShellSandbox } from "./openshell.js";
import { ProjectionRegistry, type ProjectionInspection } from "./projection.js";
import { SeatRegistry } from "./registry.js";
import {
  ReadSession,
  resumeReadSession,
  resumeWriteSession,
  type AgentSessionProfile,
  type ResumeReadSessionOpenShell,
} from "./seat.js";
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
  readonly seat: string;
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
}

export interface ReplaceSessionOptions {
  readonly expected: SessionIdentity;
  readonly session: string;
  readonly reason: string;
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
): boolean {
  return (
    session?.identity.run === expected.run &&
    session.identity.seat === expected.seat &&
    session.identity.session === replacement &&
    session.identity.epoch === expected.epoch + 1 &&
    session.replaces?.session === expected.session &&
    session.replaces.reason === reason
  );
}

export class SessionReconciler {
  readonly runId: string;
  readonly registry: SeatRegistry;
  readonly mailbox: MailboxRouter;

  constructor(
    store: LifecycleStore,
    runId: string,
    private readonly openshell: SessionLifecycleOpenShell,
    readonly projection: ProjectionRegistry,
    mailbox?: MailboxRouter,
  ) {
    this.runId = IdentifierSchema.parse(runId);
    this.registry = new SeatRegistry(store, this.runId);
    this.mailbox = mailbox ?? new MailboxRouter(store, this.runId);
  }

  async inspect(
    seatId: string,
    runtime?: Pick<SessionRuntime, "identity" | "info" | "ping">,
  ): Promise<SessionReconciliation> {
    const seat = await this.registry.get(IdentifierSchema.parse(seatId));
    const session = seat.session;
    if (!session) {
      return {
        seat: seat.id,
        identity: null,
        sessionStatus: null,
        sandbox: "unbound",
        link: "missing",
        projection: null,
        action: "start",
        reasons: ["Seat has no Session"],
      };
    }
    const identity = session.identity;
    if (terminalSession(session)) {
      return {
        seat: seat.id,
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
        seat: seat.id,
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
        seat: seat.id,
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
        seat: seat.id,
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
        seat: seat.id,
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
        reasons.push("Live runtime identifies another Session or epoch");
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
        seat: seat.id,
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
        seat: seat.id,
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
        seat: seat.id,
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
        seat: seat.id,
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
      seat: seat.id,
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
    await this.registry.requireCurrent(identity);
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
    const snapshot = await this.registry.get(expected.seat);
    if (replacementRetry(snapshot.session, expected, sessionId, reason)) {
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
    });
  }
}
