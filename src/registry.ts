import { z } from "zod";
import {
  IdentifierSchema,
  ModelAliasSchema,
  type ModelAlias,
} from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  AgentRecordSchema,
  SessionIdentitySchema,
  SessionRecordSchema,
  SessionSandboxSchema,
  SessionStatusSchema,
  transitionSessionStatus,
  type AgentRecord,
  type SessionIdentity,
  type SessionRecord,
  type SessionSandbox,
  type SessionStatus,
} from "./session.js";
import type { ProjectStore, RunState } from "./state.js";

type RegistryStore = Pick<ProjectStore, "readRun" | "updateRun">;

const RegisterAgentInputSchema = z
  .object({
    agent: IdentifierSchema,
    role: IdentifierSchema,
    model: ModelAliasSchema,
  })
  .strict();

const StartSessionInputSchema = z
  .object({
    agent: IdentifierSchema,
    session: IdentifierSchema,
    permission_ceiling_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const ReplaceSessionInputSchema = z
  .object({
    expected: SessionIdentitySchema,
    session: IdentifierSchema,
    reason: z.string().trim().min(1).max(2_000),
    permission_ceiling_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const NonterminalTransitionSchema = z
  .object({
    status: SessionStatusSchema.exclude(["stopped", "failed"]),
  })
  .strict();

const TerminalTransitionSchema = z
  .object({
    status: z.enum(["stopped", "failed"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const SessionTransitionSchema = z.union([
  NonterminalTransitionSchema,
  TerminalTransitionSchema,
]);
export type SessionTransition = z.infer<typeof SessionTransitionSchema>;

export interface AgentSnapshot {
  readonly id: string;
  readonly record: AgentRecord;
  readonly session: SessionRecord | null;
}

function requireAgent(state: RunState, agentId: string): AgentRecord {
  const agent = state.agents[agentId];
  if (!agent) {
    throw new OrchestratorError(
      "agent_not_found",
      `Run '${state.id}' has no Agent '${agentId}'`,
    );
  }
  return agent;
}

function requireCurrentSession(
  state: RunState,
  identity: SessionIdentity,
): SessionRecord {
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

  const session = state.sessions[identity.session];
  if (!session) {
    throw new OrchestratorError(
      "invalid_state",
      `Current Session '${identity.session}' is missing from Run '${state.id}'`,
    );
  }
  return session;
}

function sameSandbox(left: SessionSandbox, right: SessionSandbox): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.workspace === right.workspace
  );
}

function terminal(status: SessionStatus): boolean {
  return status === "stopped" || status === "failed";
}

export class AgentRegistry {
  readonly runId: string;

  constructor(
    private readonly store: RegistryStore,
    runId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runId = IdentifierSchema.parse(runId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async list(): Promise<AgentSnapshot[]> {
    const state = await this.store.readRun(this.runId);
    return Object.entries(state.agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({
        id,
        record,
        session: record.session ? state.sessions[record.session]! : null,
      }));
  }

  async get(agentId: string): Promise<AgentSnapshot> {
    const parsedAgentId = IdentifierSchema.parse(agentId);
    const state = await this.store.readRun(this.runId);
    const record = requireAgent(state, parsedAgentId);
    return {
      id: parsedAgentId,
      record,
      session: record.session ? state.sessions[record.session]! : null,
    };
  }

  async register(input: {
    readonly agent: string;
    readonly role: string;
    readonly model: ModelAlias;
  }): Promise<AgentRecord> {
    const parsed = RegisterAgentInputSchema.parse(input);
    let result: AgentRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const existing = state.agents[parsed.agent];
      if (existing) {
        if (existing.role !== parsed.role || existing.model !== parsed.model) {
          throw new OrchestratorError(
            "agent_conflict",
            `Agent '${parsed.agent}' is already registered as Role '${existing.role}' on model '${existing.model}'`,
          );
        }
        result = existing;
        return state;
      }

      const timestamp = this.timestamp();
      result = AgentRecordSchema.parse({
        role: parsed.role,
        model: parsed.model,
        session: null,
        generation: 0,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return {
        ...state,
        agents: { ...state.agents, [parsed.agent]: result },
      };
    });
    return result!;
  }

  async start(input: {
    readonly agent: string;
    readonly session: string;
    readonly permissionCeilingDigest: string;
  }): Promise<SessionRecord> {
    const parsed = StartSessionInputSchema.parse({
      agent: input.agent,
      session: input.session,
      permission_ceiling_digest: input.permissionCeilingDigest,
    });
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const agent = requireAgent(state, parsed.agent);
      if (agent.session !== null) {
        if (agent.session === parsed.session) {
          const existing = state.sessions[parsed.session];
          if (
            existing?.permission_ceiling_digest ===
            parsed.permission_ceiling_digest
          ) {
            result = existing;
            return state;
          }
          throw new OrchestratorError(
            "session_permission_conflict",
            `Session '${parsed.session}' was started under another permission ceiling`,
          );
        }
        throw new OrchestratorError(
          "session_already_started",
          `Agent '${parsed.agent}' already has Session '${agent.session}'`,
        );
      }
      if (state.sessions[parsed.session]) {
        throw new OrchestratorError(
          "session_conflict",
          `Session ID '${parsed.session}' already exists in Run '${state.id}'`,
        );
      }

      const timestamp = this.timestamp();
      const identity = SessionIdentitySchema.parse({
        run: state.id,
        agent: parsed.agent,
        session: parsed.session,
        generation: 1,
      });
      result = SessionRecordSchema.parse({
        identity,
        model: agent.model,
        permission_ceiling_digest: parsed.permission_ceiling_digest,
        status: "starting",
        sandbox: null,
        replaces: null,
        termination_reason: null,
        created_at: timestamp,
        updated_at: timestamp,
        ended_at: null,
      });
      return {
        ...state,
        agents: {
          ...state.agents,
          [parsed.agent]: {
            ...agent,
            session: parsed.session,
            generation: 1,
            updated_at: timestamp,
          },
        },
        sessions: { ...state.sessions, [parsed.session]: result },
      };
    });
    return result!;
  }

  async replace(input: {
    readonly expected: SessionIdentity;
    readonly session: string;
    readonly reason: string;
    readonly permissionCeilingDigest: string;
  }): Promise<SessionRecord> {
    const parsed = ReplaceSessionInputSchema.parse({
      expected: input.expected,
      session: input.session,
      reason: input.reason,
      permission_ceiling_digest: input.permissionCeilingDigest,
    });
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      if (parsed.expected.run !== state.id) {
        throw new OrchestratorError(
          "stale_session",
          `Session '${parsed.expected.session}' belongs to Run '${parsed.expected.run}', not '${state.id}'`,
        );
      }
      const agent = requireAgent(state, parsed.expected.agent);

      if (agent.session === parsed.session) {
        const existing = state.sessions[parsed.session];
        if (
          existing?.identity.generation === parsed.expected.generation + 1 &&
          existing.replaces?.session === parsed.expected.session &&
          existing.replaces.reason === parsed.reason &&
          existing.permission_ceiling_digest ===
            parsed.permission_ceiling_digest
        ) {
          result = existing;
          return state;
        }
        throw new OrchestratorError(
          "session_conflict",
          `Session ID '${parsed.session}' does not identify this replacement`,
        );
      }

      const previous = requireCurrentSession(state, parsed.expected);
      if (state.sessions[parsed.session]) {
        throw new OrchestratorError(
          "session_conflict",
          `Session ID '${parsed.session}' already exists in Run '${state.id}'`,
        );
      }
      if (agent.generation === Number.MAX_SAFE_INTEGER) {
        throw new OrchestratorError(
          "generation_exhausted",
          `Agent '${parsed.expected.agent}' cannot allocate another Session generation`,
        );
      }

      const timestamp = this.timestamp();
      const generation = agent.generation + 1;
      const stoppedPrevious = terminal(previous.status)
        ? previous
        : SessionRecordSchema.parse({
            ...previous,
            status: "stopped",
            termination_reason: parsed.reason,
            updated_at: timestamp,
            ended_at: timestamp,
          });
      const identity = SessionIdentitySchema.parse({
        run: state.id,
        agent: parsed.expected.agent,
        session: parsed.session,
        generation,
      });
      result = SessionRecordSchema.parse({
        identity,
        model: agent.model,
        permission_ceiling_digest: parsed.permission_ceiling_digest,
        status: "starting",
        sandbox: null,
        replaces: {
          session: parsed.expected.session,
          reason: parsed.reason,
        },
        termination_reason: null,
        created_at: timestamp,
        updated_at: timestamp,
        ended_at: null,
      });
      return {
        ...state,
        agents: {
          ...state.agents,
          [parsed.expected.agent]: {
            ...agent,
            session: parsed.session,
            generation,
            updated_at: timestamp,
          },
        },
        sessions: {
          ...state.sessions,
          [parsed.expected.session]: stoppedPrevious,
          [parsed.session]: result,
        },
      };
    });
    return result!;
  }

  async bindSandbox(
    identity: SessionIdentity,
    sandbox: SessionSandbox,
  ): Promise<SessionRecord> {
    const parsedIdentity = SessionIdentitySchema.parse(identity);
    const parsedSandbox = SessionSandboxSchema.parse(sandbox);
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const session = requireCurrentSession(state, parsedIdentity);
      if (session.sandbox) {
        if (!sameSandbox(session.sandbox, parsedSandbox)) {
          throw new OrchestratorError(
            "sandbox_conflict",
            `Session '${parsedIdentity.session}' is already bound to Sandbox '${session.sandbox.name}'`,
          );
        }
        result = session;
        return state;
      }
      if (terminal(session.status)) {
        throw new OrchestratorError(
          "session_terminal",
          `Cannot bind a Sandbox to ${session.status} Session '${parsedIdentity.session}'`,
        );
      }

      result = SessionRecordSchema.parse({
        ...session,
        sandbox: parsedSandbox,
        updated_at: this.timestamp(),
      });
      return {
        ...state,
        sessions: { ...state.sessions, [parsedIdentity.session]: result },
      };
    });
    return result!;
  }

  async transition(
    identity: SessionIdentity,
    transition: SessionTransition,
  ): Promise<SessionRecord> {
    const parsedIdentity = SessionIdentitySchema.parse(identity);
    const parsedTransition = SessionTransitionSchema.parse(transition);
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const session = requireCurrentSession(state, parsedIdentity);
      if (session.status === parsedTransition.status) {
        const reason =
          "reason" in parsedTransition ? parsedTransition.reason : null;
        if (terminal(session.status) && session.termination_reason !== reason) {
          throw new OrchestratorError(
            "session_transition_conflict",
            `Session '${parsedIdentity.session}' is already ${session.status} for another reason`,
          );
        }
        result = session;
        return state;
      }

      transitionSessionStatus(session.status, parsedTransition.status);
      const timestamp = this.timestamp();
      const isTerminal = terminal(parsedTransition.status);
      const terminationReason =
        "reason" in parsedTransition ? parsedTransition.reason : null;
      result = SessionRecordSchema.parse({
        ...session,
        status: parsedTransition.status,
        termination_reason: isTerminal ? terminationReason : null,
        updated_at: timestamp,
        ended_at: isTerminal ? timestamp : null,
      });
      return {
        ...state,
        sessions: { ...state.sessions, [parsedIdentity.session]: result },
      };
    });
    return result!;
  }

  async requireCurrent(identity: SessionIdentity): Promise<SessionRecord> {
    const parsedIdentity = SessionIdentitySchema.parse(identity);
    return requireCurrentSession(
      await this.store.readRun(this.runId),
      parsedIdentity,
    );
  }
}
