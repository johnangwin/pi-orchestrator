import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { WriteLeaseReferenceSchema } from "./lease.js";
import { ImmutableRecordStore } from "./record.js";
import { SessionIdentitySchema } from "./session.js";
import { WorkspaceManifestChangeSchema } from "./workspace.js";

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);
const TimestampSchema = z.string().datetime({ offset: true });

const PathValidationResultSchema = z
  .object({
    write_roots: z.literal("pass"),
    scope: z.literal("pass"),
    protected: z.literal("pass"),
    restricted: z.literal("pass"),
  })
  .strict();

const ChangeSetRecordSchema = z
  .object({
    version: z.literal(2),
    id: IdentifierSchema,
    run: IdentifierSchema,
    plan: IdentifierSchema,
    task: IdentifierSchema,
    identity: SessionIdentitySchema,
    lease: WriteLeaseReferenceSchema,
    baseline_generation: z.number().int().nonnegative(),
    result_generation: z.number().int().positive(),
    baseline_manifest_digest: DigestSchema,
    result_manifest_digest: DigestSchema,
    changes: z.array(WorkspaceManifestChangeSchema).max(1_000_000),
    git_diff_digest: DigestSchema,
    write_roots_digest: DigestSchema,
    scope_policy_digest: DigestSchema,
    protected_policy_digest: DigestSchema,
    restricted_policy_digest: DigestSchema,
    validation: PathValidationResultSchema,
    permission_ceiling_digest: DigestSchema,
    route_digest: DigestSchema,
    policy_digest: DigestSchema,
    image_digest: DigestSchema,
    gateway_digest: DigestSchema,
    mount_set_digest: DigestSchema,
    mount_table_digest: DigestSchema.nullable(),
    sandbox_digest: DigestSchema.nullable(),
    report: IdentifierSchema.nullable(),
    created_at: TimestampSchema,
  })
  .strict()
  .superRefine((changeSet, context) => {
    if (changeSet.identity.run !== changeSet.run) {
      context.addIssue({
        code: "custom",
        path: ["identity", "run"],
        message: "must equal the Change Set Run",
      });
    }
    if (changeSet.result_generation !== changeSet.baseline_generation + 1) {
      context.addIssue({
        code: "custom",
        path: ["result_generation"],
        message: "must advance the Workspace generation exactly once",
      });
    }
    for (let index = 1; index < changeSet.changes.length; index += 1) {
      if (
        Buffer.compare(
          Buffer.from(changeSet.changes[index - 1]!.path, "utf8"),
          Buffer.from(changeSet.changes[index]!.path, "utf8"),
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: "changes must have unique paths sorted by raw UTF-8 bytes",
        });
      }
    }
  });

export const ChangeSetSchema = ChangeSetRecordSchema.extend({
  digest: DigestSchema,
}).strict();
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const ChangeSetReferenceSchema = z
  .object({
    id: IdentifierSchema,
    digest: DigestSchema,
  })
  .strict();
export type ChangeSetReference = z.infer<typeof ChangeSetReferenceSchema>;

function changeSetDigest(
  record: z.infer<typeof ChangeSetRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/change-set/v2", [
    ["record", canonicalJson(record)],
  ]);
}

export function validateChangeSet(value: unknown): ChangeSet {
  const parsed = ChangeSetSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_change_set",
      `Change Set does not match the version-two contract: ${parsed.error.message}`,
    );
  }
  const { digest, ...record } = parsed.data;
  if (changeSetDigest(ChangeSetRecordSchema.parse(record)) !== digest) {
    throw new OrchestratorError(
      "invalid_change_set",
      `Change Set '${parsed.data.id}' has an invalid digest`,
    );
  }
  return Object.freeze({
    ...parsed.data,
    identity: Object.freeze({ ...parsed.data.identity }),
    lease: Object.freeze({ ...parsed.data.lease }),
    changes: Object.freeze(
      parsed.data.changes.map((change) =>
        Object.freeze({
          ...change,
          before: change.before ? Object.freeze(change.before) : null,
          after: change.after ? Object.freeze(change.after) : null,
        }),
      ),
    ),
    validation: Object.freeze({ ...parsed.data.validation }),
  }) as ChangeSet;
}

export function createChangeSet(
  input: z.input<typeof ChangeSetRecordSchema>,
): ChangeSet {
  const record = ChangeSetRecordSchema.parse(input);
  return validateChangeSet({ ...record, digest: changeSetDigest(record) });
}

export function changeSetReference(changeSet: ChangeSet): ChangeSetReference {
  return ChangeSetReferenceSchema.parse({
    id: changeSet.id,
    digest: changeSet.digest,
  });
}

export class ChangeSetStore {
  private readonly records: ImmutableRecordStore<ChangeSet>;

  constructor(runDirectory: string) {
    this.records = new ImmutableRecordStore(
      path.join(runDirectory, "changes"),
      "Change Set",
      validateChangeSet,
    );
  }

  put(changeSet: ChangeSet): Promise<ChangeSet> {
    return this.records.put(changeSet);
  }

  get(reference: ChangeSetReference): Promise<ChangeSet> {
    return this.records.get(reference.id, reference.digest);
  }

  list(id: string): Promise<ChangeSet[]> {
    return this.records.list(id);
  }
}
