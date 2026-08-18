import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  Mailbox,
  MessageSchema,
  type Message,
  type StoredMessage,
} from "./message.js";
import { SeatRegistry } from "./registry.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  type SessionIdentity,
  type SessionRecord,
} from "./session.js";
import type { ProjectStore, RunState } from "./state.js";

const MailboxAcknowledgementSchema = z.enum(["queued", "duplicate"]);
export type MailboxAcknowledgement = z.infer<
  typeof MailboxAcknowledgementSchema
>;

type MailboxProjectStore = Pick<
  ProjectStore,
  "readRun" | "runDirectory" | "updateRun"
>;

export interface MailboxLink {
  readonly identity: SessionIdentity;
  deliver(message: Message): Promise<MailboxAcknowledgement>;
}

export interface MailboxDelivery {
  readonly stored: StoredMessage;
  readonly acknowledgement: MailboxAcknowledgement | null;
}

function terminal(session: SessionRecord): boolean {
  return session.status === "stopped" || session.status === "failed";
}

function currentSession(state: RunState, seatId: string): SessionRecord {
  const seat = state.seats[seatId];
  if (!seat) {
    throw new OrchestratorError(
      "seat_not_found",
      `Run '${state.id}' has no Seat '${seatId}'`,
    );
  }
  if (seat.session === null) {
    throw new OrchestratorError(
      "seat_dormant",
      `Seat '${seatId}' in Run '${state.id}' has no active Session`,
    );
  }
  const session = state.sessions[seat.session];
  if (!session) {
    throw new OrchestratorError(
      "invalid_state",
      `Current Session '${seat.session}' is missing from Run '${state.id}'`,
    );
  }
  if (terminal(session)) {
    throw new OrchestratorError(
      "session_terminal",
      `Cannot deliver to ${session.status} Session '${session.identity.session}'`,
    );
  }
  return session;
}

export class MailboxRouter {
  readonly runId: string;
  readonly mailbox: Mailbox;
  private readonly registry: SeatRegistry;
  private readonly links = new Map<string, MailboxLink>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: MailboxProjectStore,
    runId: string,
  ) {
    this.runId = IdentifierSchema.parse(runId);
    this.mailbox = new Mailbox(store.runDirectory(this.runId));
    this.registry = new SeatRegistry(store, this.runId);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async attach(link: MailboxLink): Promise<MailboxDelivery[]> {
    return this.serialize(async () => {
      const identity = SessionIdentitySchema.parse(link.identity);
      const session = await this.registry.requireCurrent(identity);
      if (terminal(session)) {
        throw new OrchestratorError(
          "session_terminal",
          `Cannot attach a Link to ${session.status} Session '${identity.session}'`,
        );
      }

      this.links.set(identity.seat, link);
      try {
        if (
          session.status === "starting" ||
          session.status === "disconnected"
        ) {
          await this.registry.transition(identity, { status: "active" });
        }
      } catch (error) {
        this.removeLink(link);
        throw error;
      }
      return this.deliverPending(link);
    });
  }

  async detach(identity: SessionIdentity): Promise<void> {
    return this.serialize(async () => {
      const parsed = SessionIdentitySchema.parse(identity);
      await this.registry.requireCurrent(parsed);
      const link = this.links.get(parsed.seat);
      if (link && sameSessionIdentity(link.identity, parsed)) {
        this.links.delete(parsed.seat);
      }
      await this.markDisconnected(parsed);
    });
  }

  async send(message: Message): Promise<MailboxDelivery> {
    return this.serialize(async () => {
      const bound = await this.bindTarget(message);
      const stored = await this.mailbox.put(bound);
      if (stored.lifecycle !== "pending") {
        return { stored, acknowledgement: null };
      }

      const link = this.links.get(bound.to.seat);
      if (!link || !this.targets(bound, link.identity)) {
        if (link) this.links.delete(bound.to.seat);
        return { stored, acknowledgement: null };
      }
      return this.deliverStored(stored, link);
    });
  }

  async flush(seatId: string): Promise<MailboxDelivery[]> {
    return this.serialize(async () => {
      const seat = IdentifierSchema.parse(seatId);
      const link = this.links.get(seat);
      if (!link) {
        throw new OrchestratorError(
          "link_disconnected",
          `Seat '${seat}' has no attached Link`,
        );
      }
      return this.deliverPending(link);
    });
  }

  private async bindTarget(message: Message): Promise<Message> {
    const parsed = MessageSchema.parse(message);
    if (parsed.run !== this.runId) {
      throw new OrchestratorError(
        "message_run_conflict",
        `Message '${parsed.id}' belongs to Run '${parsed.run}', not '${this.runId}'`,
      );
    }

    const session = currentSession(
      await this.store.readRun(this.runId),
      parsed.to.seat,
    );
    const identity = session.identity;
    if (
      (parsed.to.session !== undefined &&
        parsed.to.session !== identity.session) ||
      (parsed.to.epoch !== undefined && parsed.to.epoch !== identity.epoch)
    ) {
      throw new OrchestratorError(
        "stale_session",
        `Message '${parsed.id}' does not target the current Session for Seat '${parsed.to.seat}'`,
      );
    }

    return MessageSchema.parse({
      ...parsed,
      to: {
        seat: identity.seat,
        session: identity.session,
        epoch: identity.epoch,
      },
    });
  }

  private targets(message: Message, identity: SessionIdentity): boolean {
    return (
      message.run === identity.run &&
      message.to.seat === identity.seat &&
      message.to.session === identity.session &&
      message.to.epoch === identity.epoch
    );
  }

  private async deliverPending(link: MailboxLink): Promise<MailboxDelivery[]> {
    const identity = SessionIdentitySchema.parse(link.identity);
    await this.registry.requireCurrent(identity);
    const deliveries: MailboxDelivery[] = [];
    for (const stored of await this.mailbox.list("pending")) {
      if (stored.message.run !== this.runId) {
        throw new OrchestratorError(
          "message_run_conflict",
          `Message '${stored.message.id}' belongs to Run '${stored.message.run}', not '${this.runId}'`,
        );
      }
      if (stored.message.to.seat !== identity.seat) continue;
      if (
        stored.message.to.session === undefined ||
        stored.message.to.epoch === undefined
      ) {
        throw new OrchestratorError(
          "invalid_message_target",
          `Pending Message '${stored.message.id}' is not bound to a Session epoch`,
        );
      }
      if (!this.targets(stored.message, identity)) continue;
      deliveries.push(await this.deliverStored(stored, link));
    }
    return deliveries;
  }

  private async deliverStored(
    stored: StoredMessage,
    link: MailboxLink,
  ): Promise<MailboxDelivery> {
    if (stored.lifecycle !== "pending") {
      return { stored, acknowledgement: null };
    }
    const identity = SessionIdentitySchema.parse(link.identity);
    if (!this.targets(stored.message, identity)) {
      throw new OrchestratorError(
        "stale_session",
        `Message '${stored.message.id}' does not target Link Session '${identity.session}' at epoch ${identity.epoch}`,
      );
    }
    await this.registry.requireCurrent(identity);

    let acknowledgement: MailboxAcknowledgement;
    try {
      const result: unknown = await link.deliver(stored.message);
      const parsed = MailboxAcknowledgementSchema.safeParse(result);
      if (!parsed.success) {
        throw new OrchestratorError(
          "invalid_link_acknowledgement",
          `Link returned an invalid acknowledgement for Message '${stored.message.id}'`,
        );
      }
      acknowledgement = parsed.data;
    } catch (error) {
      this.removeLink(link);
      try {
        await this.markDisconnected(identity);
      } catch (stateError) {
        throw new OrchestratorError(
          "session_disconnect_failed",
          `Message '${stored.message.id}' remains pending, but the failed Link could not be recorded as disconnected`,
          { cause: stateError },
        );
      }
      throw error;
    }

    try {
      await this.registry.requireCurrent(identity);
    } catch (error) {
      this.removeLink(link);
      throw error;
    }
    const queued = await this.mailbox.move(
      stored.message.id,
      "pending",
      "queued",
    );
    return { stored: queued, acknowledgement };
  }

  private removeLink(link: MailboxLink): void {
    const current = this.links.get(link.identity.seat);
    if (current === link) this.links.delete(link.identity.seat);
  }

  private async markDisconnected(identity: SessionIdentity): Promise<void> {
    let current: SessionRecord;
    try {
      current = await this.registry.requireCurrent(identity);
    } catch (error) {
      if (
        error instanceof OrchestratorError &&
        error.code === "stale_session"
      ) {
        return;
      }
      throw error;
    }
    if (terminal(current) || current.status === "disconnected") return;
    await this.registry.transition(identity, { status: "disconnected" });
  }
}
