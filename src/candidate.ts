import path from "node:path";
import { z } from "zod";
import { ChangeSetReferenceSchema, type ChangeSetReference } from "./change.js";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import {
  WriteLeaseReferenceSchema,
  type WriteLeaseReference,
} from "./lease.js";
import { DockerVolumeNameSchema } from "./volume.js";
import { ImmutableRecordStore } from "./record.js";
import {
  RunWorkspacePathSchema,
  WorkspaceEntryStateSchema,
} from "./workspace.js";

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);
const TimestampSchema = z.string().datetime({ offset: true });

function sortedUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  field: string,
): void {
  const sorted = [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (
    new Set(values).size !== values.length ||
    sorted.some((value, index) => value !== values[index])
  ) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "must be unique and sorted by raw UTF-8 bytes",
    });
  }
}

export const CandidateStatusSchema = z.enum([
  "frozen",
  "stale",
  "accepted",
  "discarded",
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const CandidatePathSchema = z
  .object({
    path: RunWorkspacePathSchema,
    mode: z.union([WorkspaceEntryStateSchema.shape.mode, z.literal("absent")]),
    byte_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    content_digest: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      ["040000", "absent"].includes(entry.mode) !==
      (entry.content_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["content_digest"],
        message: "must be null exactly for a directory or deletion",
      });
    }
    if (entry.mode === "absent" && entry.byte_count !== 0) {
      context.addIssue({
        code: "custom",
        path: ["byte_count"],
        message: "must be zero for a deletion",
      });
    }
  });
export type CandidatePath = z.infer<typeof CandidatePathSchema>;

const CandidateRecordSchema = z
  .object({
    version: z.literal(2),
    id: IdentifierSchema,
    run: IdentifierSchema,
    plan: IdentifierSchema,
    plan_revision: z.number().int().positive(),
    plan_digest: DigestSchema,
    approval_digest: DigestSchema,
    task: IdentifierSchema,
    input_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    workspace_generation: z.number().int().nonnegative(),
    manifest_digest: DigestSchema,
    git_diff_digest: DigestSchema,
    change_sets: z.array(ChangeSetReferenceSchema).min(1).max(10_000),
    changed_paths: z.array(CandidatePathSchema).max(1_000_000),
    permission_policy_digest: DigestSchema,
    routing_policy_digest: DigestSchema,
    scope_policy_digest: DigestSchema,
    protected_policy_digest: DigestSchema,
    restricted_policy_digest: DigestSchema,
    permission_ceiling_digests: z.array(DigestSchema).min(1).max(1_024),
    route_digests: z.array(DigestSchema).min(1).max(1_024),
    image_digests: z.array(DigestSchema).min(1).max(1_024),
    policy_digests: z.array(DigestSchema).min(1).max(1_024),
    gateway_digests: z.array(DigestSchema).min(1).max(1_024),
    mount_table_digests: z.array(DigestSchema).min(1).max(1_024),
    sandbox_digests: z.array(DigestSchema).max(1_024),
    frozen_at: TimestampSchema,
    status: CandidateStatusSchema,
    status_at: TimestampSchema,
    reason: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((candidate, context) => {
    for (const field of [
      "permission_ceiling_digests",
      "route_digests",
      "image_digests",
      "policy_digests",
      "gateway_digests",
      "mount_table_digests",
      "sandbox_digests",
    ] as const) {
      sortedUnique(candidate[field], context, field);
    }
    const changeSetIds = candidate.change_sets.map((entry) => entry.id);
    if (new Set(changeSetIds).size !== changeSetIds.length) {
      context.addIssue({
        code: "custom",
        path: ["change_sets"],
        message: "must reference each Change Set once",
      });
    }
    for (let index = 1; index < candidate.changed_paths.length; index += 1) {
      if (
        Buffer.compare(
          Buffer.from(candidate.changed_paths[index - 1]!.path, "utf8"),
          Buffer.from(candidate.changed_paths[index]!.path, "utf8"),
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["changed_paths", index, "path"],
          message: "must be unique and sorted by raw UTF-8 bytes",
        });
      }
    }
    if (Date.parse(candidate.status_at) < Date.parse(candidate.frozen_at)) {
      context.addIssue({
        code: "custom",
        path: ["status_at"],
        message: "must not precede Candidate freeze",
      });
    }
    if (candidate.status === "frozen") {
      if (
        candidate.status_at !== candidate.frozen_at ||
        candidate.reason !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "a frozen Candidate uses its freeze timestamp and has no transition reason",
        });
      }
    } else if (
      ["stale", "discarded"].includes(candidate.status) !==
      (candidate.reason !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "is required for stale and discarded Candidates only",
      });
    }
  });

export const CandidateSchema = CandidateRecordSchema.extend({
  digest: DigestSchema,
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateReferenceSchema = z
  .object({
    id: IdentifierSchema,
    digest: DigestSchema,
    status: CandidateStatusSchema,
  })
  .strict();
export type CandidateReference = z.infer<typeof CandidateReferenceSchema>;

function candidateDigest(
  record: z.infer<typeof CandidateRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/candidate/v2", [
    ["record", canonicalJson(record)],
  ]);
}

export function validateCandidate(value: unknown): Candidate {
  const parsed = CandidateSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_candidate",
      `Candidate does not match the version-two contract: ${parsed.error.message}`,
    );
  }
  const { digest, ...record } = parsed.data;
  if (candidateDigest(CandidateRecordSchema.parse(record)) !== digest) {
    throw new OrchestratorError(
      "invalid_candidate",
      `Candidate '${parsed.data.id}' has an invalid digest`,
    );
  }
  return Object.freeze({
    ...parsed.data,
    change_sets: Object.freeze(
      parsed.data.change_sets.map((entry) => Object.freeze({ ...entry })),
    ),
    changed_paths: Object.freeze(
      parsed.data.changed_paths.map((entry) => Object.freeze({ ...entry })),
    ),
    permission_ceiling_digests: Object.freeze([
      ...parsed.data.permission_ceiling_digests,
    ]),
    route_digests: Object.freeze([...parsed.data.route_digests]),
    image_digests: Object.freeze([...parsed.data.image_digests]),
    policy_digests: Object.freeze([...parsed.data.policy_digests]),
    gateway_digests: Object.freeze([...parsed.data.gateway_digests]),
    mount_table_digests: Object.freeze([...parsed.data.mount_table_digests]),
    sandbox_digests: Object.freeze([...parsed.data.sandbox_digests]),
  }) as Candidate;
}

export function createCandidate(
  input: z.input<typeof CandidateRecordSchema>,
): Candidate {
  const record = CandidateRecordSchema.parse(input);
  return validateCandidate({ ...record, digest: candidateDigest(record) });
}

export function candidateReference(candidate: Candidate): CandidateReference {
  return CandidateReferenceSchema.parse({
    id: candidate.id,
    digest: candidate.digest,
    status: candidate.status,
  });
}

export function transitionCandidate(
  candidate: Candidate,
  input: {
    readonly status: Exclude<CandidateStatus, "frozen">;
    readonly at: string;
    readonly reason?: string;
  },
): Candidate {
  if (candidate.status !== "frozen") {
    if (
      candidate.status === input.status &&
      candidate.status_at === input.at &&
      candidate.reason === (input.reason ?? null)
    ) {
      return candidate;
    }
    throw new OrchestratorError(
      "candidate_transition",
      `Candidate '${candidate.id}' is already '${candidate.status}'`,
    );
  }
  const { digest: _digest, ...record } = candidate;
  return createCandidate({
    ...record,
    status: input.status,
    status_at: input.at,
    reason: input.reason ?? null,
  });
}

export class CandidateStore {
  private readonly records: ImmutableRecordStore<Candidate>;

  constructor(runDirectory: string) {
    this.records = new ImmutableRecordStore(
      path.join(runDirectory, "candidates"),
      "Candidate",
      validateCandidate,
    );
  }

  put(candidate: Candidate): Promise<Candidate> {
    return this.records.put(candidate);
  }

  async get(
    reference: Pick<CandidateReference, "id" | "digest"> &
      Partial<Pick<CandidateReference, "status">>,
  ): Promise<Candidate> {
    const candidate = await this.records.get(reference.id, reference.digest);
    if (
      reference.status !== undefined &&
      candidate.status !== reference.status
    ) {
      throw new OrchestratorError(
        "immutable_store_corrupt",
        `Candidate '${candidate.id}' reference has status '${reference.status}', not '${candidate.status}'`,
      );
    }
    return candidate;
  }

  list(id: string): Promise<Candidate[]> {
    return this.records.list(id);
  }
}

export const WorkspacePhaseSchema = z.enum(["stable", "mutating", "frozen"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhaseSchema>;

export const WorkspaceDriftSchema = z
  .object({
    expected_manifest_digest: DigestSchema,
    observed_manifest_digest: DigestSchema,
    expected_git_diff_digest: DigestSchema,
    observed_git_diff_digest: DigestSchema,
    observed_at: TimestampSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type WorkspaceDrift = z.infer<typeof WorkspaceDriftSchema>;

export const RunWorkspaceStateSchema = z
  .object({
    volume_name: DockerVolumeNameSchema,
    volume_digest: DigestSchema,
    branch: z.string().trim().min(1),
    phase: WorkspacePhaseSchema,
    generation: z.number().int().nonnegative(),
    manifest_digest: DigestSchema,
    git_diff_digest: DigestSchema,
    active_lease: WriteLeaseReferenceSchema.nullable(),
    change_sets: z.array(ChangeSetReferenceSchema).max(10_000),
    candidate: CandidateReferenceSchema.nullable(),
    drift: WorkspaceDriftSchema.nullable(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const hasLease = workspace.active_lease !== null;
    if ((workspace.phase === "mutating") !== hasLease) {
      context.addIssue({
        code: "custom",
        path: ["active_lease"],
        message: "must exist exactly while the Workspace is mutating",
      });
    }
    if (workspace.active_lease?.status === "released") {
      context.addIssue({
        code: "custom",
        path: ["active_lease", "status"],
        message: "a released Write Lease cannot remain active",
      });
    }
    const frozen = workspace.candidate?.status === "frozen";
    if ((workspace.phase === "frozen") !== frozen) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "must reference a frozen Candidate exactly in frozen phase",
      });
    }
    if (workspace.drift !== null && workspace.phase === "frozen") {
      context.addIssue({
        code: "custom",
        path: ["drift"],
        message: "a drifting Workspace cannot remain frozen",
      });
    }
    const changeSetIds = workspace.change_sets.map((entry) => entry.id);
    if (new Set(changeSetIds).size !== changeSetIds.length) {
      context.addIssue({
        code: "custom",
        path: ["change_sets"],
        message: "must reference each Change Set once",
      });
    }
  });
export type RunWorkspaceState = z.infer<typeof RunWorkspaceStateSchema>;

export function candidateChangeSetReferences(
  candidate: Candidate,
): readonly ChangeSetReference[] {
  return candidate.change_sets;
}

export function activeLeaseReference(
  workspace: RunWorkspaceState,
): WriteLeaseReference | null {
  return workspace.active_lease;
}
