import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import type { OpenShellClient, OpenShellSandbox } from "./openshell.js";
import {
  OpenShellSandboxNameSchema,
  OpenShellSandboxSchema,
} from "./openshell.js";
import { ReportSchema, type Report } from "./report.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  type SessionIdentity,
} from "./session.js";
import { syncDirectory, writeJsonAtomic } from "./state.js";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ArtifactIdSchema = IdentifierSchema.max(128);
const MediaTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; charset=utf-8)?$/,
    "must be a normalized media type",
  );
const ArtifactContentSchema = z
  .string()
  .max(80)
  .regex(
    /^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/,
    "must identify a versioned content contract",
  );

export function artifactSandboxPath(id: string): string {
  return `/sandbox/output/artifacts/${ArtifactIdSchema.parse(id)}`;
}

const descriptorShape = {
  version: z.literal(1),
  id: ArtifactIdSchema,
  kind: IdentifierSchema.max(80),
  run: IdentifierSchema,
  agent: IdentifierSchema,
  session: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  task: IdentifierSchema.optional(),
  sandbox_path: z.string().min(1),
  media_type: MediaTypeSchema,
  schema: ArtifactContentSchema,
  byte_count: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  content_digest: DigestSchema,
  created_at: z.string().datetime({ offset: true }),
} as const;

function canonicalPathIssue(
  value: { readonly id: string; readonly sandbox_path: string },
  context: z.RefinementCtx,
): void {
  const expected = artifactSandboxPath(value.id);
  if (value.sandbox_path !== expected) {
    context.addIssue({
      code: "custom",
      path: ["sandbox_path"],
      message: `must equal ${expected}`,
    });
  }
}

export const ArtifactDescriptorSchema = z
  .object(descriptorShape)
  .strict()
  .superRefine(canonicalPathIssue);
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

export const ArtifactSourceSchema = z
  .object({
    sandbox_id: z.string().uuid(),
    sandbox_name: OpenShellSandboxNameSchema,
    workspace: z.string().min(1),
  })
  .strict();
export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;

export const ArtifactRecordSchema = z
  .object({
    ...descriptorShape,
    source: ArtifactSourceSchema,
    imported_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine(canonicalPathIssue);
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

const ArtifactContractMetadataSchema = z
  .object({
    kind: IdentifierSchema.max(80),
    mediaType: MediaTypeSchema,
    schema: ArtifactContentSchema,
    maxBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  })
  .strict();

export interface ArtifactContract<T> {
  readonly kind: string;
  readonly mediaType: string;
  readonly schema: string;
  readonly maxBytes: number;
  validate(payload: Uint8Array, descriptor: ArtifactDescriptor): T | Promise<T>;
}

export interface JsonArtifactContractOptions<T> {
  readonly kind: string;
  readonly mediaType?: "application/json";
  readonly schema: string;
  readonly maxBytes: number;
  readonly valueSchema: z.ZodType<T>;
}

export function jsonArtifactContract<T>(
  options: JsonArtifactContractOptions<T>,
): ArtifactContract<T> {
  return {
    kind: options.kind,
    mediaType: options.mediaType ?? "application/json",
    schema: options.schema,
    maxBytes: options.maxBytes,
    validate(payload) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      return options.valueSchema.parse(JSON.parse(text) as unknown);
    },
  };
}

export function reportArtifactContract(
  maxBytes = 1024 * 1024,
): ArtifactContract<Report> {
  return {
    kind: "report",
    mediaType: "application/json",
    schema: "report/v1",
    maxBytes,
    validate(payload, descriptor) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      const report = ReportSchema.parse(JSON.parse(text) as unknown);
      if (sha256(report.content) !== (report.content_digest as Digest)) {
        throw new Error("Report content digest is invalid");
      }
      if (
        report.run !== descriptor.run ||
        report.agent !== descriptor.agent ||
        report.session !== descriptor.session ||
        report.generation !== descriptor.generation ||
        report.task !== descriptor.task
      ) {
        throw new Error(
          "Report identity does not match its Artifact descriptor",
        );
      }
      return report;
    },
  };
}

export type ArtifactOpenShell = Pick<
  OpenShellClient,
  "download" | "execSandbox" | "getSandbox"
>;

export interface ImportArtifactOptions<T> {
  readonly client: ArtifactOpenShell;
  readonly descriptor: ArtifactDescriptor;
  readonly contract: ArtifactContract<T>;
  readonly identity: SessionIdentity;
  readonly task?: string;
  readonly sourceSandbox: OpenShellSandbox;
}

export interface ImportedArtifact<T> {
  readonly record: ArtifactRecord;
  readonly value: T;
}

interface ContractMetadata {
  readonly kind: string;
  readonly mediaType: string;
  readonly schema: string;
  readonly maxBytes: number;
}

function parseDescriptor(value: unknown): ArtifactDescriptor {
  const parsed = ArtifactDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_artifact_descriptor",
      `Artifact descriptor is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseContract<T>(contract: ArtifactContract<T>): ContractMetadata {
  const parsed = ArtifactContractMetadataSchema.safeParse({
    kind: contract.kind,
    mediaType: contract.mediaType,
    schema: contract.schema,
    maxBytes: contract.maxBytes,
  });
  if (!parsed.success || typeof contract.validate !== "function") {
    throw new OrchestratorError(
      "invalid_artifact_contract",
      `Artifact contract is invalid${parsed.success ? "" : `: ${parsed.error.message}`}`,
    );
  }
  return parsed.data;
}

function validateContract(
  descriptor: ArtifactDescriptor,
  contract: ContractMetadata,
): void {
  if (
    descriptor.kind !== contract.kind ||
    descriptor.media_type !== contract.mediaType ||
    descriptor.schema !== contract.schema
  ) {
    throw new OrchestratorError(
      "artifact_contract_mismatch",
      `Artifact '${descriptor.id}' does not match contract '${contract.kind}/${contract.schema}'`,
    );
  }
  if (descriptor.byte_count > contract.maxBytes) {
    throw new OrchestratorError(
      "artifact_too_large",
      `Artifact '${descriptor.id}' claims ${descriptor.byte_count} bytes; contract limit is ${contract.maxBytes}`,
    );
  }
}

function validateBinding(
  descriptor: ArtifactDescriptor,
  identity: SessionIdentity,
  task: string | undefined,
): void {
  const descriptorIdentity = SessionIdentitySchema.parse({
    run: descriptor.run,
    agent: descriptor.agent,
    session: descriptor.session,
    generation: descriptor.generation,
  });
  if (
    !sameSessionIdentity(descriptorIdentity, identity) ||
    descriptor.task !== task
  ) {
    throw new OrchestratorError(
      "artifact_binding_mismatch",
      `Artifact '${descriptor.id}' does not match the expected Run, Task, Agent, Session, or generation`,
    );
  }
}

function artifactSource(sandbox: OpenShellSandbox): ArtifactSource {
  return ArtifactSourceSchema.parse({
    sandbox_id: sandbox.id,
    sandbox_name: sandbox.name,
    workspace: sandbox.workspace,
  });
}

async function verifySourceSandbox(
  client: ArtifactOpenShell,
  expected: OpenShellSandbox,
  artifactId: string,
): Promise<void> {
  const actual = await client.getSandbox(expected.name);
  if (
    actual.id !== expected.id ||
    actual.name !== expected.name ||
    actual.workspace !== expected.workspace ||
    actual.phase !== "Ready"
  ) {
    throw new OrchestratorError(
      "artifact_source_mismatch",
      `Artifact '${artifactId}' did not come from the expected ready Sandbox`,
    );
  }
}

async function inspectRemoteArtifact(
  client: ArtifactOpenShell,
  sandboxName: string,
  descriptor: ArtifactDescriptor,
  contract: ContractMetadata,
): Promise<void> {
  const remoteStat = await client.execSandbox(sandboxName, [
    "/usr/bin/stat",
    "--format=%F\t%s",
    "--",
    descriptor.sandbox_path,
  ]);
  const statMatch = /^regular file\t(\d+)\n?$/.exec(remoteStat.stdout);
  if (remoteStat.exitCode !== 0 || !statMatch?.[1]) {
    throw new OrchestratorError(
      "invalid_artifact_payload",
      `Artifact '${descriptor.id}' is not an inspectable regular Sandbox file`,
    );
  }
  const byteCount = Number(statMatch[1]);
  if (!Number.isSafeInteger(byteCount) || byteCount > contract.maxBytes) {
    throw new OrchestratorError(
      "artifact_too_large",
      `Artifact '${descriptor.id}' contains ${statMatch[1]} bytes; contract limit is ${contract.maxBytes}`,
    );
  }
  if (byteCount !== descriptor.byte_count) {
    throw new OrchestratorError(
      "artifact_size_mismatch",
      `Artifact '${descriptor.id}' contains ${byteCount} bytes, not ${descriptor.byte_count}`,
    );
  }

  const remoteDigest = await client.execSandbox(sandboxName, [
    "/usr/bin/sha256sum",
    "--",
    descriptor.sandbox_path,
  ]);
  const digestMatch = /^([a-f0-9]{64})  (.+)\n?$/.exec(remoteDigest.stdout);
  if (
    remoteDigest.exitCode !== 0 ||
    !digestMatch?.[1] ||
    digestMatch[2] !== descriptor.sandbox_path ||
    `sha256:${digestMatch[1]}` !== descriptor.content_digest
  ) {
    throw new OrchestratorError(
      "artifact_digest_mismatch",
      `Artifact '${descriptor.id}' Sandbox content digest is invalid`,
    );
  }
}

function recordDescriptor(record: ArtifactRecord): ArtifactDescriptor {
  return ArtifactDescriptorSchema.parse({
    version: record.version,
    id: record.id,
    kind: record.kind,
    run: record.run,
    agent: record.agent,
    session: record.session,
    generation: record.generation,
    ...(record.task ? { task: record.task } : {}),
    sandbox_path: record.sandbox_path,
    media_type: record.media_type,
    schema: record.schema,
    byte_count: record.byte_count,
    content_digest: record.content_digest,
    created_at: record.created_at,
  });
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ArtifactStore {
  readonly directory: string;

  constructor(
    runDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = path.join(path.resolve(runDirectory), "artifacts");
  }

  artifactDirectory(id: string): string {
    return path.join(this.directory, ArtifactIdSchema.parse(id));
  }

  recordPath(id: string): string {
    return path.join(this.artifactDirectory(id), "artifact.json");
  }

  payloadPath(id: string): string {
    return path.join(this.artifactDirectory(id), "payload");
  }

  private async readRecordIfPresent(
    id: string,
  ): Promise<ArtifactRecord | undefined> {
    const recordPath = this.recordPath(id);
    let source: string;
    try {
      source = await readFile(recordPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const artifactState = await lstat(this.artifactDirectory(id)).catch(
          (stateError: unknown) => {
            if ((stateError as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw stateError;
          },
        );
        if (!artifactState) return undefined;
        throw new OrchestratorError(
          "artifact_store_corrupt",
          `Stored Artifact '${id}' is missing its record`,
        );
      }
      throw error;
    }
    const result = ArtifactRecordSchema.safeParse(
      (() => {
        try {
          return JSON.parse(source) as unknown;
        } catch {
          return undefined;
        }
      })(),
    );
    if (!result.success) {
      throw new OrchestratorError(
        "artifact_store_corrupt",
        `Stored Artifact '${id}' has an invalid record`,
      );
    }
    return result.data;
  }

  private async validatePayload<T>(
    payloadPath: string,
    descriptor: ArtifactDescriptor,
    contract: ArtifactContract<T>,
    metadata: ContractMetadata,
  ): Promise<T> {
    let state;
    try {
      state = await lstat(payloadPath);
    } catch (error) {
      throw new OrchestratorError(
        "invalid_artifact_payload",
        `Artifact '${descriptor.id}' payload is unavailable`,
        { cause: error },
      );
    }
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new OrchestratorError(
        "invalid_artifact_payload",
        `Artifact '${descriptor.id}' payload is not a regular file`,
      );
    }
    if (state.size > metadata.maxBytes) {
      throw new OrchestratorError(
        "artifact_too_large",
        `Artifact '${descriptor.id}' contains ${state.size} bytes; contract limit is ${metadata.maxBytes}`,
      );
    }
    if (state.size !== descriptor.byte_count) {
      throw new OrchestratorError(
        "artifact_size_mismatch",
        `Artifact '${descriptor.id}' contains ${state.size} bytes, not ${descriptor.byte_count}`,
      );
    }

    const payload = await readFile(payloadPath);
    if (sha256(payload) !== (descriptor.content_digest as Digest)) {
      throw new OrchestratorError(
        "artifact_digest_mismatch",
        `Artifact '${descriptor.id}' content digest is invalid`,
      );
    }
    try {
      return await contract.validate(payload, descriptor);
    } catch (error) {
      throw new OrchestratorError(
        "invalid_artifact_schema",
        `Artifact '${descriptor.id}' violates '${descriptor.schema}'`,
        { cause: error },
      );
    }
  }

  private async validateStored<T>(
    record: ArtifactRecord,
    contract: ArtifactContract<T>,
    metadata: ContractMetadata,
  ): Promise<ImportedArtifact<T>> {
    const descriptor = recordDescriptor(record);
    validateContract(descriptor, metadata);
    const value = await this.validatePayload(
      this.payloadPath(record.id),
      descriptor,
      contract,
      metadata,
    );
    return { record, value };
  }

  async get<T>(
    id: string,
    contract: ArtifactContract<T>,
  ): Promise<ImportedArtifact<T>> {
    const artifactId = ArtifactIdSchema.parse(id);
    const metadata = parseContract(contract);
    const record = await this.readRecordIfPresent(artifactId);
    if (!record) {
      throw new OrchestratorError(
        "artifact_not_found",
        `Artifact '${artifactId}' does not exist`,
      );
    }
    return this.validateStored(record, contract, metadata);
  }

  async importFromSandbox<T>(
    options: ImportArtifactOptions<T>,
  ): Promise<ImportedArtifact<T>> {
    const descriptor = parseDescriptor(options.descriptor);
    const contract = parseContract(options.contract);
    const identity = SessionIdentitySchema.parse(options.identity);
    const task =
      options.task === undefined
        ? undefined
        : IdentifierSchema.parse(options.task);
    const expectedSandbox = OpenShellSandboxSchema.parse(options.sourceSandbox);
    const source = artifactSource(expectedSandbox);

    validateContract(descriptor, contract);
    validateBinding(descriptor, identity, task);

    const existing = await this.readRecordIfPresent(descriptor.id);
    if (existing) {
      const { imported_at: _importedAt, ...existingIdentity } = existing;
      if (
        canonicalJson(existingIdentity) !==
        canonicalJson({ ...descriptor, source })
      ) {
        throw new OrchestratorError(
          "duplicate_artifact",
          `Artifact '${descriptor.id}' already exists with other content or provenance`,
        );
      }
      return this.validateStored(existing, options.contract, contract);
    }

    await verifySourceSandbox(options.client, expectedSandbox, descriptor.id);

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const staging = await mkdtemp(
      path.join(this.directory, `.import-${descriptor.id}-`),
    );
    const stagedPayload = path.join(staging, "payload");
    const stagedRecord = path.join(staging, "artifact.json");
    let published = false;
    try {
      await inspectRemoteArtifact(
        options.client,
        expectedSandbox.name,
        descriptor,
        contract,
      );
      try {
        await options.client.download(
          expectedSandbox.name,
          descriptor.sandbox_path,
          stagedPayload,
        );
      } catch (error) {
        throw new OrchestratorError(
          "artifact_download_failed",
          `Cannot download Artifact '${descriptor.id}' from Sandbox '${expectedSandbox.name}'`,
          { cause: error },
        );
      }

      await verifySourceSandbox(options.client, expectedSandbox, descriptor.id);

      const value = await this.validatePayload(
        stagedPayload,
        descriptor,
        options.contract,
        contract,
      );
      const record = ArtifactRecordSchema.parse({
        ...descriptor,
        source,
        imported_at: this.now().toISOString(),
      });
      await writeJsonAtomic(stagedRecord, record);
      await chmod(stagedPayload, 0o400);
      await chmod(stagedRecord, 0o400);
      await syncFile(stagedPayload);
      await syncFile(stagedRecord);
      await rename(staging, this.artifactDirectory(descriptor.id));
      published = true;
      await syncDirectory(this.directory);
      return { record, value };
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true });
    }
  }
}
