import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { syncDirectory, writeJsonAtomic } from "./state.js";

export const MessageLifecycleSchema = z.enum([
  "pending",
  "queued",
  "answered",
  "expired",
  "superseded",
]);
export type MessageLifecycle = z.infer<typeof MessageLifecycleSchema>;
export const messageLifecycles = MessageLifecycleSchema.options;

const MessageSenderSchema = z
  .object({
    seat: IdentifierSchema.optional(),
    host: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (sender) => sender.seat !== undefined || sender.host === true,
    "sender must identify a Seat or the host",
  );

export const MessageSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    run: IdentifierSchema,
    from: MessageSenderSchema,
    to: z
      .object({
        seat: IdentifierSchema,
        session: IdentifierSchema.optional(),
        epoch: z.number().int().nonnegative().optional(),
      })
      .strict(),
    type: IdentifierSchema,
    priority: z.enum(["normal", "urgent"]),
    reply_to: IdentifierSchema.nullable(),
    body: z.record(z.string(), z.unknown()),
    references: z.array(z.string()),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      (message.to.session === undefined) !==
      (message.to.epoch === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message:
          "session and epoch must either both be present or both be absent",
      });
    }
  });
export type Message = z.infer<typeof MessageSchema>;

export interface StoredMessage {
  readonly lifecycle: MessageLifecycle;
  readonly message: Message;
}

export class Mailbox {
  readonly root: string;

  constructor(runDirectory: string) {
    this.root = path.join(runDirectory, "messages");
  }

  private file(lifecycle: MessageLifecycle, id: string): string {
    return path.join(this.root, lifecycle, `${id}.json`);
  }

  async find(id: string): Promise<StoredMessage | undefined> {
    const parsedId = IdentifierSchema.parse(id);
    let found: StoredMessage | undefined;
    for (const lifecycle of messageLifecycles) {
      try {
        const value: unknown = JSON.parse(
          await readFile(this.file(lifecycle, parsedId), "utf8"),
        );
        const message = MessageSchema.parse(value);
        if (message.id !== parsedId) {
          throw new OrchestratorError(
            "invalid_message_store",
            `Mailbox file '${parsedId}.json' contains Message '${message.id}'`,
          );
        }
        if (found) {
          throw new OrchestratorError(
            "invalid_message_store",
            `Message '${parsedId}' exists in multiple lifecycle directories`,
          );
        }
        found = { lifecycle, message };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return found;
  }

  async list(lifecycle?: MessageLifecycle): Promise<StoredMessage[]> {
    const selected = lifecycle
      ? MessageLifecycleSchema.parse(lifecycle)
      : undefined;
    const messages = new Map<string, StoredMessage>();

    for (const current of messageLifecycles) {
      let entries;
      try {
        entries = await readdir(path.join(this.root, current), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new OrchestratorError(
            "invalid_message_store",
            `Unexpected Mailbox entry '${path.join(current, entry.name)}'`,
          );
        }

        const value: unknown = JSON.parse(
          await readFile(path.join(this.root, current, entry.name), "utf8"),
        );
        const message = MessageSchema.parse(value);
        if (entry.name !== `${message.id}.json`) {
          throw new OrchestratorError(
            "invalid_message_store",
            `Mailbox file '${entry.name}' does not match Message '${message.id}'`,
          );
        }
        if (messages.has(message.id)) {
          throw new OrchestratorError(
            "invalid_message_store",
            `Message '${message.id}' exists in multiple lifecycle directories`,
          );
        }
        messages.set(message.id, { lifecycle: current, message });
      }
    }

    return [...messages.values()]
      .filter(
        (stored) => selected === undefined || stored.lifecycle === selected,
      )
      .sort(
        (left, right) =>
          left.message.created_at.localeCompare(right.message.created_at) ||
          left.message.id.localeCompare(right.message.id),
      );
  }

  async put(message: Message): Promise<StoredMessage> {
    const parsed = MessageSchema.parse(message);
    const existing = await this.find(parsed.id);
    if (existing) {
      if (canonicalJson(existing.message) !== canonicalJson(parsed)) {
        throw new OrchestratorError(
          "duplicate_message",
          `Message '${parsed.id}' already exists with other content`,
        );
      }
      return existing;
    }
    await writeJsonAtomic(this.file("pending", parsed.id), parsed);
    return { lifecycle: "pending", message: parsed };
  }

  async move(
    id: string,
    from: MessageLifecycle,
    to: MessageLifecycle,
  ): Promise<StoredMessage> {
    if (from === to) {
      const current = await this.find(id);
      if (!current || current.lifecycle !== to) {
        throw new OrchestratorError(
          "message_not_found",
          `Message '${id}' is not ${to}`,
        );
      }
      return current;
    }

    const existing = await this.find(id);
    if (!existing)
      throw new OrchestratorError(
        "message_not_found",
        `Message '${id}' does not exist`,
      );
    if (existing.lifecycle === to) return existing;
    if (existing.lifecycle !== from) {
      throw new OrchestratorError(
        "message_state_conflict",
        `Message '${id}' is ${existing.lifecycle}, not ${from}`,
      );
    }

    const source = this.file(from, id);
    const target = this.file(to, id);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
    await Promise.all([
      syncDirectory(path.dirname(source)),
      syncDirectory(path.dirname(target)),
    ]);
    return { lifecycle: to, message: existing.message };
  }
}
