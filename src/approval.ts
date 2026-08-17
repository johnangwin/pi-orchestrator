import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import type { Digest } from "./digest.js";
import type { LoadedPlan } from "./plan.js";
import { OrchestratorError } from "./error.js";

export const ApprovalSchema = z
  .object({
    version: z.literal(1),
    plan_id: IdentifierSchema,
    plan_revision: z.number().int().positive(),
    plan_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    base_commit: z.string().min(1),
    approved_by: z.string().min(1),
    approved_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export interface ApprovalFreshness {
  readonly fresh: boolean;
  readonly reasons: readonly string[];
}

export function createApproval(input: {
  readonly plan: LoadedPlan;
  readonly baseCommit: string;
  readonly approvedBy: string;
  readonly approvedAt?: Date;
}): Approval {
  return ApprovalSchema.parse({
    version: 1,
    plan_id: input.plan.id,
    plan_revision: input.plan.revision,
    plan_digest: input.plan.digest,
    base_commit: input.baseCommit,
    approved_by: input.approvedBy,
    approved_at: (input.approvedAt ?? new Date()).toISOString(),
  });
}

export function approvalFreshness(
  approval: Approval,
  current: {
    readonly planId: string;
    readonly planRevision: number;
    readonly planDigest: Digest;
    readonly baseCommit: string;
  },
): ApprovalFreshness {
  const reasons: string[] = [];
  if (approval.plan_id !== current.planId) reasons.push("Plan ID changed");
  if (approval.plan_revision !== current.planRevision)
    reasons.push("Plan revision changed");
  if (approval.plan_digest !== current.planDigest)
    reasons.push("Plan content changed");
  if (approval.base_commit !== current.baseCommit)
    reasons.push("base commit changed");
  return { fresh: reasons.length === 0, reasons };
}

export function requireFreshApproval(
  approval: Approval | undefined,
  current: Parameters<typeof approvalFreshness>[1],
): void {
  if (!approval) {
    throw new OrchestratorError(
      "approval_required",
      `Plan '${current.planId}' has not been approved`,
    );
  }
  const freshness = approvalFreshness(approval, current);
  if (!freshness.fresh) {
    throw new OrchestratorError(
      "approval_stale",
      `Plan '${current.planId}' approval is stale: ${freshness.reasons.join(", ")}`,
    );
  }
}
