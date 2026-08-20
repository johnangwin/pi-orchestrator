import { z } from "zod";
import { IdentifierSchema, ModelProfileSchema } from "./config.js";
import type { Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { ResolvedModelRouteSchema } from "./model.js";
import { OpenShellSandboxNameSchema } from "./openshell.js";

const TimestampSchema = z.string().datetime({ offset: true });
const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);

export const SessionGenerationSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

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
    agent: IdentifierSchema,
    session: IdentifierSchema,
    generation: SessionGenerationSchema,
  })
  .strict();
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

export const AgentRecordSchema = z
  .object({
    role: IdentifierSchema,
    profile: ModelProfileSchema,
    session: IdentifierSchema.nullable(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((agent, context) => {
    if ((agent.session === null) !== (agent.generation === 0)) {
      context.addIssue({
        code: "custom",
        path: ["session"],
        message: "an Agent has no Session exactly when its generation is zero",
      });
    }
    if (Date.parse(agent.updated_at) < Date.parse(agent.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "must not precede created_at",
      });
    }
  });
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const SessionSandboxSchema = z
  .object({
    id: z.string().uuid(),
    name: OpenShellSandboxNameSchema,
    workspace: z.string().min(1),
  })
  .strict();
export type SessionSandbox = z.infer<typeof SessionSandboxSchema>;

const SessionReplacementSchema = z
  .object({
    session: IdentifierSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const SessionRecordSchema = z
  .object({
    identity: SessionIdentitySchema,
    route: ResolvedModelRouteSchema,
    permission_ceiling_digest: DigestSchema,
    status: SessionStatusSchema,
    sandbox: SessionSandboxSchema.nullable(),
    replaces: SessionReplacementSchema.nullable(),
    termination_reason: z.string().trim().min(1).max(2_000).nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    ended_at: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const terminal = ["stopped", "failed"].includes(session.status);
    if (terminal !== (session.ended_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["ended_at"],
        message: terminal
          ? "is required for a terminal Session"
          : "is only allowed for a terminal Session",
      });
    }
    if (terminal !== (session.termination_reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["termination_reason"],
        message: terminal
          ? "is required for a terminal Session"
          : "is only allowed for a terminal Session",
      });
    }
    if (Date.parse(session.updated_at) < Date.parse(session.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "must not precede created_at",
      });
    }
    if (
      session.ended_at !== null &&
      Date.parse(session.ended_at) < Date.parse(session.created_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ended_at"],
        message: "must not precede created_at",
      });
    }
  });
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const sessionTransitions: Readonly<
  Record<SessionStatus, ReadonlySet<SessionStatus>>
> = {
  starting: new Set(["active", "disconnected", "stopped", "failed"]),
  active: new Set(["waiting", "disconnected", "stopped", "failed"]),
  disconnected: new Set(["active", "waiting", "stopped", "failed"]),
  waiting: new Set(["active", "disconnected", "stopped", "failed"]),
  stopped: new Set(),
  failed: new Set(),
};

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return sessionTransitions[from].has(to);
}

export function transitionSessionStatus(
  from: SessionStatus,
  to: SessionStatus,
): SessionStatus {
  if (!canTransitionSession(from, to)) {
    throw new OrchestratorError(
      "invalid_transition",
      `Session cannot transition from '${from}' to '${to}'`,
    );
  }
  return to;
}

export const ModelTurnResultSchema = z
  .object({
    message_ids: z.array(IdentifierSchema).min(1),
    model_profile: ModelProfileSchema,
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
    model_profile: ModelProfileSchema,
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
    left.agent === right.agent &&
    left.session === right.session &&
    left.generation === right.generation
  );
}
