import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { MessageSchema } from "./message.js";
import { SessionIdentitySchema } from "./session.js";

export const MAX_LINK_FRAME_BYTES = 64 * 1024;

export const LinkFrameIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,127}$/,
    "must be a lowercase stable frame identifier",
  );

export const LinkTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a 256-bit lowercase hex token");

const LinkBaseSchema = z
  .object({
    version: z.literal(1),
    id: LinkFrameIdSchema,
    identity: SessionIdentitySchema,
  })
  .strict();

export const LinkHelloFrameSchema = LinkBaseSchema.extend({
  type: z.literal("hello"),
  payload: z
    .object({
      token: LinkTokenSchema,
    })
    .strict(),
}).strict();

export const LinkReadyFrameSchema = LinkBaseSchema.extend({
  type: z.literal("ready"),
  payload: z
    .object({
      reply_to: LinkFrameIdSchema,
      client_version: z.string().min(1),
      pi_version: z.string().min(1),
      capabilities: z
        .array(z.enum(["deliver", "events", "ping"]))
        .min(1)
        .refine(
          (values) => new Set(values).size === values.length,
          "capabilities must be unique",
        ),
    })
    .strict(),
}).strict();

export const LinkPingFrameSchema = LinkBaseSchema.extend({
  type: z.literal("ping"),
  payload: z.object({ nonce: z.string().min(1).max(128) }).strict(),
}).strict();

export const LinkPongFrameSchema = LinkBaseSchema.extend({
  type: z.literal("pong"),
  payload: z
    .object({
      reply_to: LinkFrameIdSchema,
      nonce: z.string().min(1).max(128),
    })
    .strict(),
}).strict();

export const LinkDeliverFrameSchema = LinkBaseSchema.extend({
  type: z.literal("deliver"),
  payload: z.object({ message: MessageSchema }).strict(),
}).strict();

export const LinkAckFrameSchema = LinkBaseSchema.extend({
  type: z.literal("ack"),
  payload: z
    .object({
      reply_to: LinkFrameIdSchema,
      message_id: IdentifierSchema,
      status: z.enum(["queued", "duplicate"]),
    })
    .strict(),
}).strict();

export const LinkEventFrameSchema = LinkBaseSchema.extend({
  type: z.literal("event"),
  payload: z
    .object({
      event: z.enum([
        "session-started",
        "session-blocked",
        "handoff-requested",
        "context-pressure",
        "report-submitted",
        "turn-completed",
        "turn-failed",
      ]),
      data: z.record(z.string(), z.unknown()),
    })
    .strict(),
}).strict();

export const LinkErrorFrameSchema = LinkBaseSchema.extend({
  type: z.literal("error"),
  payload: z
    .object({
      reply_to: LinkFrameIdSchema.optional(),
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(1_024),
    })
    .strict(),
}).strict();

export const LinkFrameSchema = z.discriminatedUnion("type", [
  LinkHelloFrameSchema,
  LinkReadyFrameSchema,
  LinkPingFrameSchema,
  LinkPongFrameSchema,
  LinkDeliverFrameSchema,
  LinkAckFrameSchema,
  LinkEventFrameSchema,
  LinkErrorFrameSchema,
]);
export type LinkFrame = z.infer<typeof LinkFrameSchema>;

export interface LinkTransport {
  readonly name: string;
  connect(signal?: AbortSignal): Promise<void>;
  send(frame: LinkFrame, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): AsyncIterable<LinkFrame>;
  close(): Promise<void>;
}
