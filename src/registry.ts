import { z } from "zod";
import {
  IdentifierSchema,
  ModelAliasSchema,
  type ModelAlias,
} from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  SeatRecordSchema,
  SessionIdentitySchema,
  SessionRecordSchema,
  SessionSandboxSchema,
  SessionStatusSchema,
  transitionSessionStatus,
  type SeatRecord,
  type SessionIdentity,
  type SessionRecord,
  type SessionSandbox,
  type SessionStatus,
} from "./session.js";
import type { ProjectStore, RunState } from "./state.js";

type RegistryStore = Pick<ProjectStore, "readRun" | "updateRun">;

const RegisterSeatInputSchema = z
  .object({
    seat: IdentifierSchema,
    role: IdentifierSchema,
    model: ModelAliasSchema,
  })
  .strict();

const StartSessionInputSchema = z
  .object({
    seat: IdentifierSchema,
    session: IdentifierSchema,
  })
  .strict();

const ReplaceSessionInputSchema = z
  .object({
    expected: SessionIdentitySchema,
    session: IdentifierSchema,
    reason: z.string().trim().min(1).max(2_000),
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

export interface SeatSnapshot {
  readonly id: string;
  readonly record: SeatRecord;
  readonly session: SessionRecord | null;
}

function requireSeat(state: RunState, seatId: string): SeatRecord {
  const seat = state.seats[seatId];
  if (!seat) {
    throw new OrchestratorError(
      "seat_not_found",
      `Run '${state.id}' has no Seat '${seatId}'`,
    );
  }
  return seat;
}

function requireCurrentSession(
  state: RunState,
  identity: SessionIdentity,
): SessionRecord {
  const seat = state.seats[identity.seat];
  if (
    identity.run !== state.id ||
    !seat ||
    seat.session !== identity.session ||
    seat.epoch !== identity.epoch
  ) {
    throw new OrchestratorError(
      "stale_session",
      `Session '${identity.session}' at epoch ${identity.epoch} is not current for Seat '${identity.seat}' in Run '${state.id}'`,
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

export class SeatRegistry {
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

  async list(): Promise<SeatSnapshot[]> {
    const state = await this.store.readRun(this.runId);
    return Object.entries(state.seats)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({
        id,
        record,
        session: record.session ? state.sessions[record.session]! : null,
      }));
  }

  async get(seatId: string): Promise<SeatSnapshot> {
    const parsedSeatId = IdentifierSchema.parse(seatId);
    const state = await this.store.readRun(this.runId);
    const record = requireSeat(state, parsedSeatId);
    return {
      id: parsedSeatId,
      record,
      session: record.session ? state.sessions[record.session]! : null,
    };
  }

  async register(input: {
    readonly seat: string;
    readonly role: string;
    readonly model: ModelAlias;
  }): Promise<SeatRecord> {
    const parsed = RegisterSeatInputSchema.parse(input);
    let result: SeatRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const existing = state.seats[parsed.seat];
      if (existing) {
        if (existing.role !== parsed.role || existing.model !== parsed.model) {
          throw new OrchestratorError(
            "seat_conflict",
            `Seat '${parsed.seat}' is already registered as Role '${existing.role}' on model '${existing.model}'`,
          );
        }
        result = existing;
        return state;
      }

      const timestamp = this.timestamp();
      result = SeatRecordSchema.parse({
        role: parsed.role,
        model: parsed.model,
        session: null,
        epoch: 0,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return {
        ...state,
        seats: { ...state.seats, [parsed.seat]: result },
      };
    });
    return result!;
  }

  async start(input: {
    readonly seat: string;
    readonly session: string;
  }): Promise<SessionRecord> {
    const parsed = StartSessionInputSchema.parse(input);
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      const seat = requireSeat(state, parsed.seat);
      if (seat.session !== null) {
        if (seat.session === parsed.session) {
          result = state.sessions[parsed.session];
          return state;
        }
        throw new OrchestratorError(
          "session_already_started",
          `Seat '${parsed.seat}' already has Session '${seat.session}'`,
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
        seat: parsed.seat,
        session: parsed.session,
        epoch: 1,
      });
      result = SessionRecordSchema.parse({
        identity,
        model: seat.model,
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
        seats: {
          ...state.seats,
          [parsed.seat]: {
            ...seat,
            session: parsed.session,
            epoch: 1,
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
  }): Promise<SessionRecord> {
    const parsed = ReplaceSessionInputSchema.parse(input);
    let result: SessionRecord | undefined;
    await this.store.updateRun(this.runId, (state) => {
      if (parsed.expected.run !== state.id) {
        throw new OrchestratorError(
          "stale_session",
          `Session '${parsed.expected.session}' belongs to Run '${parsed.expected.run}', not '${state.id}'`,
        );
      }
      const seat = requireSeat(state, parsed.expected.seat);

      if (seat.session === parsed.session) {
        const existing = state.sessions[parsed.session];
        if (
          existing?.identity.epoch === parsed.expected.epoch + 1 &&
          existing.replaces?.session === parsed.expected.session &&
          existing.replaces.reason === parsed.reason
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
      if (seat.epoch === Number.MAX_SAFE_INTEGER) {
        throw new OrchestratorError(
          "epoch_exhausted",
          `Seat '${parsed.expected.seat}' cannot allocate another Session epoch`,
        );
      }

      const timestamp = this.timestamp();
      const epoch = seat.epoch + 1;
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
        seat: parsed.expected.seat,
        session: parsed.session,
        epoch,
      });
      result = SessionRecordSchema.parse({
        identity,
        model: seat.model,
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
        seats: {
          ...state.seats,
          [parsed.expected.seat]: {
            ...seat,
            session: parsed.session,
            epoch,
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
