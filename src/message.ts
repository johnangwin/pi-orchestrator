import { mkdir, readFile, rename } from "node:fs/promises";
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
  .strict();
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
    IdentifierSchema.parse(id);
    for (const lifecycle of messageLifecycles) {
      try {
        const value: unknown = JSON.parse(
          await readFile(this.file(lifecycle, id), "utf8"),
        );
        return { lifecycle, message: MessageSchema.parse(value) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
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
