import { z } from "zod";
import { IdentifierSchema, ModelAliasSchema } from "./config.js";

export const SessionStatusSchema = z.enum([
  "starting",
  "active",
  "disconnected",
  "waiting",
  "stopped",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionIdentitySchema = z
  .object({
    run: IdentifierSchema,
    seat: IdentifierSchema,
    session: IdentifierSchema,
    epoch: z.number().int().nonnegative(),
  })
  .strict();
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

export const SeatRecordSchema = z
  .object({
    role: IdentifierSchema,
    sandbox: z.string().min(1).optional(),
    session: IdentifierSchema,
    epoch: z.number().int().nonnegative(),
    status: SessionStatusSchema,
    model: ModelAliasSchema,
  })
  .strict();
export type SeatRecord = z.infer<typeof SeatRecordSchema>;

export const ModelTurnResultSchema = z
  .object({
    message_ids: z.array(IdentifierSchema).min(1),
    model_alias: ModelAliasSchema,
    requested_model: z.string().min(1),
    response_model: z.string().min(1).optional(),
    stop_reason: z.string().min(1),
    text: z.string(),
    truncated: z.boolean(),
    usage: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ModelTurnResult = z.infer<typeof ModelTurnResultSchema>;

export const ModelTurnFailureSchema = z
  .object({
    message_ids: z.array(IdentifierSchema).min(1),
    model_alias: ModelAliasSchema,
    requested_model: z.string().min(1),
    response_model: z.string().min(1).optional(),
    stop_reason: z.string().min(1),
    error: z.string().min(1),
  })
  .strict();
export type ModelTurnFailure = z.infer<typeof ModelTurnFailureSchema>;

export function sameSessionIdentity(
  left: SessionIdentity,
  right: SessionIdentity,
): boolean {
  return (
    left.run === right.run &&
    left.seat === right.seat &&
    left.session === right.session &&
    left.epoch === right.epoch
  );
}
