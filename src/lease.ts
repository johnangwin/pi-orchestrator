import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { OpenShellSandboxNameSchema } from "./openshell.js";
import { ImmutableRecordStore } from "./record.js";
import { SessionIdentitySchema, type SessionIdentity } from "./session.js";
import { WritePathSchema } from "./workspace.js";

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

export const WriteLeaseStatusSchema = z.enum([
  "preparing",
  "active",
  "releasing",
  "released",
  "blocked",
]);
export type WriteLeaseStatus = z.infer<typeof WriteLeaseStatusSchema>;

const WriteLeaseRecordSchema = z
  .object({
    version: z.literal(2),
    id: IdentifierSchema,
    run: IdentifierSchema,
    plan: IdentifierSchema,
    plan_revision: z.number().int().positive(),
    plan_digest: DigestSchema,
    task: IdentifierSchema,
    identity: SessionIdentitySchema,
    workspace_generation: z.number().int().nonnegative(),
    baseline_manifest_digest: DigestSchema,
    write_roots: z.array(WritePathSchema).min(1).max(1_024),
    write_roots_digest: DigestSchema,
    scope_policy_digest: DigestSchema,
    protected_policy_digest: DigestSchema,
    restricted_policy_digest: DigestSchema,
    permission_ceiling_digest: DigestSchema,
    route_digest: DigestSchema,
    policy_digest: DigestSchema,
    image_digest: DigestSchema,
    gateway_digest: DigestSchema,
    mount_set_digest: DigestSchema,
    mount_table_digest: DigestSchema.nullable(),
    sandbox_name: OpenShellSandboxNameSchema,
    sandbox_workspace: z.string().min(1),
    sandbox_id: z.string().uuid().nullable(),
    sandbox_digest: DigestSchema.nullable(),
    created_at: TimestampSchema,
    expires_at: TimestampSchema,
    renewal_count: z.number().int().nonnegative(),
    status: WriteLeaseStatusSchema,
    activated_at: TimestampSchema.nullable(),
    revocation_started_at: TimestampSchema.nullable(),
    sandbox_deleted_at: TimestampSchema.nullable(),
    released_at: TimestampSchema.nullable(),
    reason: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((lease, context) => {
    sortedUnique(lease.write_roots, context, "write_roots");
    if (lease.identity.run !== lease.run) {
      context.addIssue({
        code: "custom",
        path: ["identity", "run"],
        message: "must equal the lease Run",
      });
    }
    if (Date.parse(lease.expires_at) <= Date.parse(lease.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "must follow creation",
      });
    }
    const orderedAfter = (
      field:
        | "activated_at"
        | "revocation_started_at"
        | "sandbox_deleted_at"
        | "released_at",
      value: string | null,
      floor: string,
    ): void => {
      if (value !== null && Date.parse(value) < Date.parse(floor)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "must not precede the prior lifecycle boundary",
        });
      }
    };
    orderedAfter("activated_at", lease.activated_at, lease.created_at);
    orderedAfter(
      "revocation_started_at",
      lease.revocation_started_at,
      lease.activated_at ?? lease.created_at,
    );
    orderedAfter(
      "sandbox_deleted_at",
      lease.sandbox_deleted_at,
      lease.revocation_started_at ?? lease.created_at,
    );
    orderedAfter(
      "released_at",
      lease.released_at,
      lease.sandbox_deleted_at ?? lease.created_at,
    );
    const activated = lease.activated_at !== null;
    if (
      lease.status === "active" &&
      (!activated ||
        lease.sandbox_id === null ||
        lease.sandbox_digest === null ||
        lease.mount_table_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "an active lease requires activated Sandbox provenance",
      });
    }
    const sandboxProvenance = [
      lease.sandbox_id,
      lease.sandbox_digest,
      lease.mount_table_digest,
    ];
    if (
      sandboxProvenance.some((value) => value !== null) &&
      sandboxProvenance.some((value) => value === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sandbox provenance fields must appear together",
      });
    }
    if (activated !== sandboxProvenance.every((value) => value !== null)) {
      context.addIssue({
        code: "custom",
        message: "Sandbox provenance and activation time must appear together",
      });
    }
    if (
      lease.status === "preparing" &&
      (lease.sandbox_id !== null ||
        lease.sandbox_digest !== null ||
        lease.mount_table_digest !== null ||
        activated ||
        lease.revocation_started_at !== null ||
        lease.sandbox_deleted_at !== null ||
        lease.released_at !== null ||
        lease.reason !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "a preparing lease cannot contain later lifecycle evidence",
      });
    }
    if (
      ["releasing", "released", "blocked"].includes(lease.status) !==
      (lease.revocation_started_at !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revocation_started_at"],
        message: "must exist exactly after revocation begins",
      });
    }
    if (lease.status === "released") {
      if (
        lease.sandbox_deleted_at === null ||
        lease.released_at === null ||
        lease.reason !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "a released lease requires deletion and release timestamps without a blocking reason",
        });
      }
    } else if (lease.released_at !== null) {
      context.addIssue({
        code: "custom",
        path: ["released_at"],
        message: "is only valid for a released lease",
      });
    }
    if ((lease.status === "blocked") !== (lease.reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "is required exactly for a blocked lease",
      });
    }
  });

export const WriteLeaseSchema = WriteLeaseRecordSchema.extend({
  digest: DigestSchema,
}).strict();
export type WriteLease = z.infer<typeof WriteLeaseSchema>;

export const WriteLeaseReferenceSchema = z
  .object({
    id: IdentifierSchema,
    digest: DigestSchema,
    status: WriteLeaseStatusSchema,
  })
  .strict();
export type WriteLeaseReference = z.infer<typeof WriteLeaseReferenceSchema>;

function writeLeaseDigest(
  record: z.infer<typeof WriteLeaseRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/write-lease/v2", [
    ["record", canonicalJson(record)],
  ]);
}

export function validateWriteLease(value: unknown): WriteLease {
  const parsed = WriteLeaseSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_write_lease",
      `Write Lease does not match the version-two contract: ${parsed.error.message}`,
    );
  }
  const { digest, ...record } = parsed.data;
  if (writeLeaseDigest(WriteLeaseRecordSchema.parse(record)) !== digest) {
    throw new OrchestratorError(
      "invalid_write_lease",
      `Write Lease '${parsed.data.id}' has an invalid digest`,
    );
  }
  return Object.freeze({
    ...parsed.data,
    identity: Object.freeze({ ...parsed.data.identity }),
    write_roots: Object.freeze([...parsed.data.write_roots]),
  }) as WriteLease;
}

export function createWriteLease(
  input: z.input<typeof WriteLeaseRecordSchema>,
): WriteLease {
  const record = WriteLeaseRecordSchema.parse(input);
  return validateWriteLease({ ...record, digest: writeLeaseDigest(record) });
}

export function writeLeaseReference(lease: WriteLease): WriteLeaseReference {
  return WriteLeaseReferenceSchema.parse({
    id: lease.id,
    digest: lease.digest,
    status: lease.status,
  });
}

export function sameWriteLeaseBinding(
  left: WriteLease,
  right: WriteLease,
): boolean {
  const mutable = new Set([
    "digest",
    "created_at",
    "status",
    "sandbox_id",
    "sandbox_digest",
    "mount_table_digest",
    "activated_at",
    "expires_at",
    "renewal_count",
    "revocation_started_at",
    "sandbox_deleted_at",
    "released_at",
    "reason",
  ]);
  const binding = (lease: WriteLease) =>
    Object.fromEntries(
      Object.entries(lease).filter(([key]) => !mutable.has(key)),
    );
  return canonicalJson(binding(left)) === canonicalJson(binding(right));
}

export function activateWriteLease(
  lease: WriteLease,
  input: {
    readonly sandboxId: string;
    readonly sandboxDigest: Digest;
    readonly mountTableDigest: Digest;
    readonly activatedAt: string;
  },
): WriteLease {
  if (lease.status !== "preparing") {
    throw new OrchestratorError(
      "write_lease_transition",
      `Write Lease '${lease.id}' is '${lease.status}', not preparing`,
    );
  }
  const { digest: _digest, ...record } = lease;
  return createWriteLease({
    ...record,
    status: "active",
    sandbox_id: input.sandboxId,
    sandbox_digest: input.sandboxDigest,
    mount_table_digest: input.mountTableDigest,
    activated_at: input.activatedAt,
  });
}

export function renewWriteLease(
  lease: WriteLease,
  input: { readonly expiresAt: string },
): WriteLease {
  if (lease.status !== "active") {
    throw new OrchestratorError(
      "write_lease_transition",
      `Write Lease '${lease.id}' is '${lease.status}', not active`,
    );
  }
  if (Date.parse(input.expiresAt) <= Date.parse(lease.expires_at)) {
    throw new OrchestratorError(
      "write_lease_expiry",
      "A renewed Write Lease must extend its expiry",
    );
  }
  const { digest: _digest, ...record } = lease;
  return createWriteLease({
    ...record,
    expires_at: input.expiresAt,
    renewal_count: lease.renewal_count + 1,
  });
}

export function revokeWriteLease(
  lease: WriteLease,
  input: { readonly startedAt: string },
): WriteLease {
  if (lease.status === "releasing" || lease.status === "blocked") return lease;
  if (lease.status !== "preparing" && lease.status !== "active") {
    throw new OrchestratorError(
      "write_lease_transition",
      `Write Lease '${lease.id}' cannot begin revocation from '${lease.status}'`,
    );
  }
  const { digest: _digest, ...record } = lease;
  return createWriteLease({
    ...record,
    status: "releasing",
    revocation_started_at: input.startedAt,
  });
}

export function releaseWriteLease(
  lease: WriteLease,
  input: {
    readonly sandboxDeletedAt: string;
    readonly releasedAt: string;
  },
): WriteLease {
  if (lease.status !== "releasing") {
    throw new OrchestratorError(
      "write_lease_transition",
      `Write Lease '${lease.id}' is '${lease.status}', not releasing`,
    );
  }
  const { digest: _digest, ...record } = lease;
  return createWriteLease({
    ...record,
    status: "released",
    sandbox_deleted_at: input.sandboxDeletedAt,
    released_at: input.releasedAt,
  });
}

export function blockWriteLease(
  lease: WriteLease,
  input: {
    readonly reason: string;
    readonly blockedAt: string;
    readonly sandboxDeletedAt?: string;
  },
): WriteLease {
  if (lease.status === "released") {
    throw new OrchestratorError(
      "write_lease_transition",
      `Released Write Lease '${lease.id}' cannot be blocked`,
    );
  }
  const { digest: _digest, ...record } = lease;
  return createWriteLease({
    ...record,
    status: "blocked",
    revocation_started_at: lease.revocation_started_at ?? input.blockedAt,
    sandbox_deleted_at: input.sandboxDeletedAt ?? lease.sandbox_deleted_at,
    released_at: null,
    reason: input.reason,
  });
}

export class WriteLeaseStore {
  private readonly records: ImmutableRecordStore<WriteLease>;

  constructor(runDirectory: string) {
    this.records = new ImmutableRecordStore(
      path.join(runDirectory, "leases"),
      "Write Lease",
      validateWriteLease,
    );
  }

  put(lease: WriteLease): Promise<WriteLease> {
    return this.records.put(lease);
  }

  async get(
    reference: Pick<WriteLeaseReference, "id" | "digest"> &
      Partial<Pick<WriteLeaseReference, "status">>,
  ): Promise<WriteLease> {
    const lease = await this.records.get(reference.id, reference.digest);
    if (reference.status !== undefined && lease.status !== reference.status) {
      throw new OrchestratorError(
        "immutable_store_corrupt",
        `Write Lease '${lease.id}' reference has status '${reference.status}', not '${lease.status}'`,
      );
    }
    return lease;
  }

  list(id: string): Promise<WriteLease[]> {
    return this.records.list(id);
  }
}

export interface WriteLeaseIdentity {
  readonly identity: SessionIdentity;
  readonly permissionCeilingDigest: Digest;
  readonly routeDigest: Digest;
}
