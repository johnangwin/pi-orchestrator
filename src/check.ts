import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GitPatchWorktree, loadPreparedPatch } from "./apply.js";
import { requireFreshApproval } from "./approval.js";
import { ArtifactStore } from "./artifact.js";
import {
  IdentifierSchema,
  loadProjectConfig,
  type CheckDefinition,
} from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { GitCommitSchema } from "./git.js";
import type {
  OpenShellClient,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "./openshell.js";
import {
  inspectWorkspaceEntries,
  validateVerifiedPatch,
  verifyAppliedPatchResult,
  WorkspaceEntrySchema,
  workspaceTreeDigest,
  type VerifiedPatch,
} from "./patch.js";
import {
  catalogFromConfig,
  loadPlan,
  type LoadedPlan,
  type PlanTask,
} from "./plan.js";
import type { LoadedSandboxPolicy } from "./policy.js";
import { loadSandboxPolicy } from "./policy.js";
import type { Project } from "./project.js";
import { createSourceSnapshot } from "./snapshot.js";
import {
  syncDirectory,
  writeJsonAtomic,
  type ProjectRecord,
  type ProjectStore,
  type RunState,
  type TaskRecord,
} from "./state.js";

const MAX_CHECK_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_CHECK_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const DEFAULT_CHECK_TIMEOUT_MS = 30 * 60_000;
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CheckJobIdSchema = z.string().regex(/^check-[a-f0-9]{16}$/);
const CheckTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CheckTimeoutSchema = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60_000);

const CheckArchiveSchema = z
  .object({
    byte_count: z.number().int().positive().max(MAX_CHECK_SOURCE_BYTES),
    content_digest: DigestSchema,
  })
  .strict();

export const CheckSourceManifestSchema = z
  .object({
    version: z.literal(1),
    input_commit: GitCommitSchema,
    task_source_digest: DigestSchema,
    diff_digest: DigestSchema,
    tree_digest: DigestSchema,
    entries: z.array(WorkspaceEntrySchema).min(1).max(MAX_TREE_ENTRIES),
    archive: CheckArchiveSchema,
    source_digest: DigestSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    for (let index = 1; index < manifest.entries.length; index += 1) {
      if (
        Buffer.compare(
          Buffer.from(manifest.entries[index - 1]!.path, "utf8"),
          Buffer.from(manifest.entries[index]!.path, "utf8"),
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "entries must be unique and sorted",
        });
      }
    }
  });
export type CheckSourceManifest = z.infer<typeof CheckSourceManifestSchema>;

export interface CheckSource {
  readonly directory: string;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly manifest: CheckSourceManifest;
  dispose(): Promise<void>;
}

export const CheckImageSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0")),
    digest: DigestSchema,
  })
  .strict();
export type CheckImage = z.infer<typeof CheckImageSchema>;

const CheckIntentImageSchema = z
  .object({
    source: z.string().min(1),
    digest: DigestSchema,
  })
  .strict();

export const CheckIntentSchema = z
  .object({
    version: z.literal(1),
    id: CheckJobIdSchema,
    run: IdentifierSchema,
    task: IdentifierSchema,
    check: IdentifierSchema,
    plan_digest: DigestSchema,
    input_commit: GitCommitSchema,
    task_source_digest: DigestSchema,
    source_digest: DigestSchema,
    diff_digest: DigestSchema,
    argv: z.array(z.string().min(1)).min(1).max(256),
    cwd: z.string().min(1),
    timeout_ms: CheckTimeoutSchema,
    image: CheckIntentImageSchema,
    policy_digest: DigestSchema,
    sandbox: z.string().min(1).max(19),
    token: CheckTokenSchema,
    binding_digest: DigestSchema,
    prepared_at: TimestampSchema,
  })
  .strict();
export type CheckIntent = z.infer<typeof CheckIntentSchema>;

const CheckLogSchema = z
  .object({
    path: z.enum(["stdout.log", "stderr.log"]),
    byte_count: z.number().int().nonnegative().max(MAX_CHECK_LOG_BYTES),
    content_digest: DigestSchema,
  })
  .strict();

const CheckSandboxSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(19),
    workspace: z.string().min(1),
  })
  .strict();

const CheckOpenShellSchema = z
  .object({
    cli_version: z.string().min(1),
    gateway: z.string().min(1),
    gateway_version: z.string().min(1),
  })
  .strict();

const CheckRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: CheckJobIdSchema,
    run: IdentifierSchema,
    task: IdentifierSchema,
    check: IdentifierSchema,
    verdict: z.enum(["pass", "fail"]),
    argv: z.array(z.string().min(1)).min(1).max(256),
    cwd: z.string().min(1),
    timeout_ms: CheckTimeoutSchema,
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    exit_code: z.number().int().nonnegative(),
    signal: z.string().min(1).optional(),
    stdout: CheckLogSchema,
    stderr: CheckLogSchema,
    source_digest: DigestSchema,
    task_source_digest: DigestSchema,
    input_commit: GitCommitSchema,
    diff_digest: DigestSchema,
    plan_digest: DigestSchema,
    image: CheckIntentImageSchema,
    policy_digest: DigestSchema,
    sandbox: CheckSandboxSchema,
    openshell: CheckOpenShellSchema,
    intent_digest: DigestSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.exit_code === 0) !== (record.verdict === "pass")) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "must pass exactly when exit_code is zero",
      });
    }
    if (Date.parse(record.ended_at) < Date.parse(record.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["ended_at"],
        message: "must not precede started_at",
      });
    }
  });

export const CheckRecordSchema = CheckRecordWithoutDigestSchema.extend({
  record_digest: DigestSchema,
}).strict();
export type CheckRecord = z.infer<typeof CheckRecordSchema>;

export type CheckOpenShell = Pick<
  OpenShellClient,
  | "createSandbox"
  | "deleteSandbox"
  | "execSandbox"
  | "getInferenceRoute"
  | "listSandboxes"
  | "preflight"
  | "upload"
  | "waitForSandbox"
>;

export type CheckProjectStore = Pick<
  ProjectStore,
  "read" | "readRun" | "runDirectory" | "updateRun"
>;

export interface RunCheckOptions {
  readonly store: CheckProjectStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly runId: string;
  readonly taskId: string;
  readonly checkId: string;
  readonly client: CheckOpenShell;
  readonly image?: CheckImage;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly token?: () => string;
}

export interface RunCheckResult {
  readonly intent: CheckIntent;
  readonly record: CheckRecord;
  readonly reused: boolean;
  readonly task: TaskRecord;
}

function bundledPath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../sandbox/${segments.join("/")}`, import.meta.url),
  );
}

export function bundledCheckImage(): string {
  return bundledPath("check");
}

export function bundledCheckPolicy(): string {
  return bundledPath("policies", "check.yaml");
}

async function fileDigest(filePath: string): Promise<Digest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function checkSourceDigest(
  manifest: Omit<CheckSourceManifest, "archive" | "source_digest">,
): Digest {
  return digestParts("pi-orchestrator/check-source/v1", [
    ["input-commit", manifest.input_commit],
    ["task-source-digest", manifest.task_source_digest],
    ["diff-digest", manifest.diff_digest],
    ["tree-digest", manifest.tree_digest],
    ["entries", canonicalJson(manifest.entries)],
  ]);
}

async function trustedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          COPYFILE_DISABLE: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C.UTF-8",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const diagnostic = stderr.trim() || stdout.trim();
        reject(
          new OrchestratorError(
            "check_source_failed",
            `${executable} ${args.join(" ")} failed${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

async function extractArchive(
  archivePath: string,
  destination: string,
  cwd: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await trustedCommand("tar", ["-xf", archivePath, "-C", destination], cwd);
}

export async function verifyCheckSource(
  source: Pick<CheckSource, "archivePath" | "manifestPath" | "manifest">,
  temporaryRoot?: string,
): Promise<CheckSourceManifest> {
  const manifest = CheckSourceManifestSchema.parse(source.manifest);
  let stored: CheckSourceManifest;
  try {
    stored = CheckSourceManifestSchema.parse(
      JSON.parse(await readFile(source.manifestPath, "utf8")) as unknown,
    );
  } catch (error) {
    throw new OrchestratorError(
      "invalid_check_source",
      "Check source manifest cannot be read or validated",
      { cause: error },
    );
  }
  if (canonicalJson(stored) !== canonicalJson(manifest)) {
    throw new OrchestratorError(
      "invalid_check_source",
      "Check source manifest does not match its in-memory binding",
    );
  }
  if (
    checkSourceDigest(manifest) !== manifest.source_digest ||
    workspaceTreeDigest(manifest.entries) !== manifest.tree_digest
  ) {
    throw new OrchestratorError(
      "invalid_check_source",
      "Check source semantic digest is invalid",
    );
  }
  const archiveState = await lstat(source.archivePath).catch(() => undefined);
  if (
    !archiveState?.isFile() ||
    archiveState.isSymbolicLink() ||
    archiveState.size !== manifest.archive.byte_count ||
    (await fileDigest(source.archivePath)) !== manifest.archive.content_digest
  ) {
    throw new OrchestratorError(
      "invalid_check_source",
      "Check source archive does not match its manifest",
    );
  }

  const root = path.resolve(temporaryRoot ?? os.tmpdir());
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "pi-check-verify-"));
  try {
    const project = path.join(directory, "project");
    await extractArchive(source.archivePath, project, directory);
    const entries = await inspectWorkspaceEntries(project);
    if (canonicalJson(entries) !== canonicalJson(manifest.entries)) {
      throw new OrchestratorError(
        "invalid_check_source",
        "Extracted Check source does not match its manifest",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return manifest;
}

export async function createCheckSource(options: {
  readonly projectRoot: string;
  readonly inputCommit: string;
  readonly taskSourceDigest: string;
  readonly diffDigest: string;
  readonly patch: VerifiedPatch;
  readonly temporaryRoot?: string;
}): Promise<CheckSource> {
  const inputCommit = GitCommitSchema.parse(options.inputCommit);
  const taskSourceDigest = DigestSchema.parse(options.taskSourceDigest);
  const diffDigest = DigestSchema.parse(options.diffDigest);
  const patch = validateVerifiedPatch(options.patch);
  if (
    patch.source.commit !== inputCommit ||
    patch.bundle.result_tree_digest !== taskSourceDigest
  ) {
    throw new OrchestratorError(
      "check_source_mismatch",
      "Applied Patch does not match the requested Check source",
    );
  }

  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(temporaryRoot, "pi-orchestrator-check-source-"),
  );
  const project = path.join(directory, "project");
  const patchPath = path.join(directory, "change.patch");
  const archivePath = path.join(directory, "source.tar");
  const manifestPath = path.join(directory, "source.json");
  let created = false;
  const base = await createSourceSnapshot({
    projectRoot: options.projectRoot,
    commit: inputCommit,
    paths: ["."],
    temporaryRoot,
  });
  try {
    await extractArchive(base.archivePath, project, directory);
    await writeFile(patchPath, patch.patch, { mode: 0o600 });
    const applyArgs = [
      "apply",
      "--binary",
      "--whitespace=nowarn",
      "-p2",
      patchPath,
    ] as const;
    await trustedCommand(
      "git",
      ["apply", "--check", ...applyArgs.slice(1)],
      project,
    );
    await trustedCommand("git", applyArgs, project);
    await verifyAppliedPatchResult({
      root: project,
      patch,
      changedPaths: patch.bundle.changes.map((change) => change.path),
    });
    const entries = await inspectWorkspaceEntries(project);
    const treeDigest = workspaceTreeDigest(entries);
    const semantic = {
      version: 1 as const,
      input_commit: inputCommit,
      task_source_digest: taskSourceDigest,
      diff_digest: diffDigest,
      tree_digest: treeDigest,
      entries,
    };
    const sourceDigest = checkSourceDigest(semantic);
    await trustedCommand(
      "tar",
      ["-cf", archivePath, "-C", project, "."],
      directory,
    );
    const archiveState = await stat(archivePath);
    if (archiveState.size > MAX_CHECK_SOURCE_BYTES) {
      throw new OrchestratorError(
        "check_source_too_large",
        `Check source archive exceeds ${MAX_CHECK_SOURCE_BYTES} bytes`,
      );
    }
    const manifest = CheckSourceManifestSchema.parse({
      ...semantic,
      archive: {
        byte_count: archiveState.size,
        content_digest: await fileDigest(archivePath),
      },
      source_digest: sourceDigest,
    });
    await writeJsonAtomic(manifestPath, manifest);
    await verifyCheckSource(
      { archivePath, manifestPath, manifest },
      temporaryRoot,
    );
    created = true;
    return {
      directory,
      archivePath,
      manifestPath,
      manifest,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } finally {
    await base.dispose();
    if (!created) await rm(directory, { recursive: true, force: true });
  }
}

export async function loadBundledCheckImage(): Promise<CheckImage> {
  const source = await realpath(bundledCheckImage());
  const entries = await inspectWorkspaceEntries(source);
  return verifyCheckImage({
    source,
    digest: digestParts("pi-orchestrator/check-image/v1", [
      ["entries", canonicalJson(entries)],
    ]),
  });
}

function checkImageContextDigest(
  entries: Awaited<ReturnType<typeof inspectWorkspaceEntries>>,
): Digest {
  return digestParts("pi-orchestrator/check-image/v1", [
    ["entries", canonicalJson(entries)],
  ]);
}

export async function verifyCheckImage(value: CheckImage): Promise<CheckImage> {
  const image = CheckImageSchema.parse(value);
  const reference = /@sha256:([a-f0-9]{64})$/.exec(image.source);
  if (reference?.[1]) {
    if (image.digest !== `sha256:${reference[1]}`) {
      throw new OrchestratorError(
        "check_image_mismatch",
        "Pinned Check image reference does not match its recorded digest",
      );
    }
    return image;
  }
  if (!path.isAbsolute(image.source)) {
    throw new OrchestratorError(
      "check_image_unpinned",
      "A Check image must be an absolute local context or an OCI digest reference",
    );
  }
  const source = await realpath(image.source).catch((error: unknown) => {
    throw new OrchestratorError(
      "invalid_check_image",
      `Check image context '${image.source}' is not accessible`,
      { cause: error },
    );
  });
  if (source !== image.source) {
    throw new OrchestratorError(
      "invalid_check_image",
      `Check image context '${image.source}' is not canonical`,
    );
  }
  const digest = checkImageContextDigest(await inspectWorkspaceEntries(source));
  if (digest !== image.digest) {
    throw new OrchestratorError(
      "check_image_mismatch",
      `Check image context '${source}' changed after its identity was computed`,
    );
  }
  return image;
}

interface StagedCheckImage {
  readonly source: string;
  dispose(): Promise<void>;
}

async function stageCheckImage(
  image: CheckImage,
  temporaryRoot?: string,
): Promise<StagedCheckImage> {
  if (/@sha256:[a-f0-9]{64}$/.test(image.source)) {
    return { source: image.source, dispose: () => Promise.resolve() };
  }
  const root = path.resolve(temporaryRoot ?? os.tmpdir());
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "pi-check-image-"));
  const context = path.join(directory, "context");
  let complete = false;
  try {
    await cp(image.source, context, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    const digest = checkImageContextDigest(
      await inspectWorkspaceEntries(context),
    );
    if (digest !== image.digest) {
      throw new OrchestratorError(
        "check_image_mismatch",
        "Staged Check image context does not match its recorded digest",
      );
    }
    complete = true;
    return {
      source: context,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } finally {
    if (!complete) await rm(directory, { recursive: true, force: true });
  }
}

async function stageCheckPolicy(
  policy: LoadedSandboxPolicy,
  directory: string,
): Promise<LoadedSandboxPolicy> {
  const content = await readFile(policy.path);
  if (sha256(content) !== policy.digest) {
    throw new OrchestratorError(
      "check_policy_changed",
      `Check policy '${policy.path}' changed after validation`,
    );
  }
  const staged = path.join(directory, "check-policy.yaml");
  const handle = await open(staged, "wx", 0o400);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { ...policy, path: staged };
}

function intentBinding(
  input: Omit<
    CheckIntent,
    "id" | "sandbox" | "token" | "binding_digest" | "prepared_at"
  >,
): Digest {
  return digestParts("pi-orchestrator/check-job/v1", [
    ["binding", canonicalJson(input)],
  ]);
}

function createIntent(
  input: Omit<
    CheckIntent,
    "version" | "id" | "sandbox" | "token" | "binding_digest" | "prepared_at"
  >,
  token: string,
  now: Date,
): CheckIntent {
  const bindingInput = { version: 1 as const, ...input };
  const bindingDigest = intentBinding(bindingInput);
  const suffix = bindingDigest.slice("sha256:".length);
  return CheckIntentSchema.parse({
    ...bindingInput,
    id: `check-${suffix.slice(0, 16)}`,
    sandbox: `pio-c-${suffix.slice(0, 12)}`,
    token: CheckTokenSchema.parse(token),
    binding_digest: bindingDigest,
    prepared_at: now.toISOString(),
  });
}

function sameIntentBinding(left: CheckIntent, right: CheckIntent): boolean {
  const omit = (intent: CheckIntent) => {
    const { token: _token, prepared_at: _preparedAt, ...binding } = intent;
    return binding;
  };
  return canonicalJson(omit(left)) === canonicalJson(omit(right));
}

function recordDigest(
  record: z.infer<typeof CheckRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/check-record/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function createRecord(
  input: z.input<typeof CheckRecordWithoutDigestSchema>,
): CheckRecord {
  const parsed = CheckRecordWithoutDigestSchema.parse(input);
  return CheckRecordSchema.parse({
    ...parsed,
    record_digest: recordDigest(parsed),
  });
}

function requireRecordIntent(record: CheckRecord, intent: CheckIntent): void {
  const recordBinding = {
    id: record.id,
    run: record.run,
    task: record.task,
    check: record.check,
    plan_digest: record.plan_digest,
    input_commit: record.input_commit,
    task_source_digest: record.task_source_digest,
    source_digest: record.source_digest,
    diff_digest: record.diff_digest,
    argv: record.argv,
    cwd: record.cwd,
    timeout_ms: record.timeout_ms,
    image: record.image,
    policy_digest: record.policy_digest,
    intent_digest: record.intent_digest,
  };
  const intentBinding = {
    id: intent.id,
    run: intent.run,
    task: intent.task,
    check: intent.check,
    plan_digest: intent.plan_digest,
    input_commit: intent.input_commit,
    task_source_digest: intent.task_source_digest,
    source_digest: intent.source_digest,
    diff_digest: intent.diff_digest,
    argv: intent.argv,
    cwd: intent.cwd,
    timeout_ms: intent.timeout_ms,
    image: intent.image,
    policy_digest: intent.policy_digest,
    intent_digest: intent.binding_digest,
  };
  if (canonicalJson(recordBinding) !== canonicalJson(intentBinding)) {
    throw new OrchestratorError(
      "check_result_mismatch",
      `Check result '${record.id}' does not match its durable intent`,
    );
  }
}

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function writeDurableFile(
  filePath: string,
  content: string,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class CheckStore {
  readonly directory: string;

  constructor(runDirectory: string) {
    this.directory = path.join(path.resolve(runDirectory), "checks");
  }

  private jobDirectory(task: string, check: string, job: string): string {
    return path.join(
      this.directory,
      IdentifierSchema.parse(task),
      IdentifierSchema.parse(check),
      CheckJobIdSchema.parse(job),
    );
  }

  private async readIntentIfPresent(
    task: string,
    check: string,
    job: string,
  ): Promise<CheckIntent | undefined> {
    const filePath = path.join(
      this.jobDirectory(task, check, job),
      "intent.json",
    );
    try {
      return CheckIntentSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "check_store_corrupt",
          `Invalid Check intent at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async prepare(requested: CheckIntent): Promise<CheckIntent> {
    const parsed = CheckIntentSchema.parse(requested);
    const existing = await this.readIntentIfPresent(
      parsed.task,
      parsed.check,
      parsed.id,
    );
    if (existing) {
      if (!sameIntentBinding(existing, parsed)) {
        throw new OrchestratorError(
          "check_intent_conflict",
          `Check job '${parsed.id}' already has another binding`,
        );
      }
      return existing;
    }

    const parent = path.dirname(
      this.jobDirectory(parsed.task, parsed.check, parsed.id),
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, `.${parsed.id}-`));
    try {
      await writeJsonAtomic(path.join(staging, "intent.json"), parsed);
      try {
        await rename(
          staging,
          this.jobDirectory(parsed.task, parsed.check, parsed.id),
        );
        await syncDirectory(parent);
        return parsed;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.readIntentIfPresent(
          parsed.task,
          parsed.check,
          parsed.id,
        );
        if (!raced || !sameIntentBinding(raced, parsed)) {
          throw new OrchestratorError(
            "check_intent_conflict",
            `Check job '${parsed.id}' raced with another binding`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async validateResult(
    jobDirectory: string,
    record: CheckRecord,
  ): Promise<CheckRecord> {
    const parsed = CheckRecordSchema.parse(record);
    const { record_digest: _recordDigest, ...digestInput } = parsed;
    if (
      recordDigest(CheckRecordWithoutDigestSchema.parse(digestInput)) !==
      parsed.record_digest
    ) {
      throw new OrchestratorError(
        "check_store_corrupt",
        `Check record '${parsed.id}' has an invalid digest`,
      );
    }
    for (const log of [parsed.stdout, parsed.stderr]) {
      const filePath = path.join(jobDirectory, "result", log.path);
      const state = await lstat(filePath).catch(() => undefined);
      if (
        !state?.isFile() ||
        state.isSymbolicLink() ||
        state.size !== log.byte_count ||
        (await fileDigest(filePath)) !== log.content_digest
      ) {
        throw new OrchestratorError(
          "check_store_corrupt",
          `Check record '${parsed.id}' has an invalid ${log.path}`,
        );
      }
    }
    return parsed;
  }

  async getResult(
    task: string,
    check: string,
    job: string,
  ): Promise<CheckRecord | undefined> {
    const expectedTask = IdentifierSchema.parse(task);
    const expectedCheck = IdentifierSchema.parse(check);
    const expectedJob = CheckJobIdSchema.parse(job);
    const jobDirectory = this.jobDirectory(
      expectedTask,
      expectedCheck,
      expectedJob,
    );
    const filePath = path.join(jobDirectory, "result", "record.json");
    try {
      const record = CheckRecordSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (
        record.task !== expectedTask ||
        record.check !== expectedCheck ||
        record.id !== expectedJob
      ) {
        throw new OrchestratorError(
          "check_store_corrupt",
          `Check result identity does not match ${filePath}`,
        );
      }
      return this.validateResult(jobDirectory, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "check_store_corrupt",
          `Invalid Check result at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async putResult(options: {
    readonly intent: CheckIntent;
    readonly record: CheckRecord;
    readonly stdout: string;
    readonly stderr: string;
  }): Promise<CheckRecord> {
    const intent = CheckIntentSchema.parse(options.intent);
    const record = CheckRecordSchema.parse(options.record);
    const durableIntent = await this.readIntentIfPresent(
      intent.task,
      intent.check,
      intent.id,
    );
    if (
      !durableIntent ||
      canonicalJson(durableIntent) !== canonicalJson(intent)
    ) {
      throw new OrchestratorError(
        "check_intent_conflict",
        `Check job '${intent.id}' does not have the expected durable intent`,
      );
    }
    requireRecordIntent(record, intent);
    const stdout = Buffer.from(options.stdout, "utf8");
    const stderr = Buffer.from(options.stderr, "utf8");
    if (
      stdout.byteLength > MAX_CHECK_LOG_BYTES ||
      stderr.byteLength > MAX_CHECK_LOG_BYTES
    ) {
      throw new OrchestratorError(
        "check_log_too_large",
        `Check logs exceed ${MAX_CHECK_LOG_BYTES} bytes`,
      );
    }
    if (
      record.id !== intent.id ||
      record.intent_digest !== intent.binding_digest ||
      record.stdout.byte_count !== stdout.byteLength ||
      record.stdout.content_digest !==
        `sha256:${createHash("sha256").update(stdout).digest("hex")}` ||
      record.stderr.byte_count !== stderr.byteLength ||
      record.stderr.content_digest !==
        `sha256:${createHash("sha256").update(stderr).digest("hex")}`
    ) {
      throw new OrchestratorError(
        "check_result_mismatch",
        `Check result '${record.id}' does not match its intent or logs`,
      );
    }

    const jobDirectory = this.jobDirectory(
      intent.task,
      intent.check,
      intent.id,
    );
    const existing = await this.getResult(intent.task, intent.check, intent.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new OrchestratorError(
          "check_result_conflict",
          `Check job '${intent.id}' already has another result`,
        );
      }
      return existing;
    }
    const staging = await mkdtemp(path.join(jobDirectory, ".result-"));
    try {
      await Promise.all([
        writeDurableFile(path.join(staging, "stdout.log"), options.stdout),
        writeDurableFile(path.join(staging, "stderr.log"), options.stderr),
      ]);
      await writeJsonAtomic(path.join(staging, "record.json"), record);
      await Promise.all([
        chmod(path.join(staging, "stdout.log"), 0o400),
        chmod(path.join(staging, "stderr.log"), 0o400),
        chmod(path.join(staging, "record.json"), 0o400),
      ]);
      try {
        await rename(staging, path.join(jobDirectory, "result"));
        await syncDirectory(jobDirectory);
        return record;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.getResult(
          intent.task,
          intent.check,
          intent.id,
        );
        if (!raced || canonicalJson(raced) !== canonicalJson(record)) {
          throw new OrchestratorError(
            "check_result_conflict",
            `Check job '${intent.id}' raced with another result`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function requireRunBinding(options: {
  readonly run: RunState;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly projectRecord: ProjectRecord;
}): void {
  if (
    options.run.project_id !== options.project.config.project.id ||
    path.resolve(options.projectRecord.root) !== options.project.root
  ) {
    throw new OrchestratorError(
      "run_project_conflict",
      `Run '${options.run.id}' does not belong to the loaded Project`,
    );
  }
  if (
    options.run.plan_id !== options.plan.id ||
    options.run.plan_revision !== options.plan.revision ||
    options.run.plan_digest !== options.plan.digest
  ) {
    throw new OrchestratorError(
      "run_plan_stale",
      `Run '${options.run.id}' is not bound to the loaded Plan revision`,
    );
  }
  requireFreshApproval(options.projectRecord.approvals[options.plan.id], {
    planId: options.run.plan_id,
    planRevision: options.run.plan_revision,
    planDigest: options.run.plan_digest,
    baseCommit: options.run.base_commit,
  });
}

function findTask(plan: LoadedPlan, taskId: string): PlanTask {
  const parsed = IdentifierSchema.parse(taskId);
  const task = plan.tasks.find((candidate) => candidate.id === parsed);
  if (!task) {
    throw new OrchestratorError(
      "task_not_found",
      `Plan '${plan.id}' has no Task '${parsed}'`,
    );
  }
  return task;
}

function requireCheckDefinition(
  project: Project,
  task: PlanTask,
  checkId: string,
): CheckDefinition {
  const parsed = IdentifierSchema.parse(checkId);
  if (!task.checks.includes(parsed)) {
    throw new OrchestratorError(
      "check_not_required",
      `Task '${task.id}' does not require Check '${parsed}'`,
    );
  }
  const definition = project.config.checks[parsed];
  if (!definition) {
    throw new OrchestratorError(
      "unknown_check",
      `Project has no registered Check '${parsed}'`,
    );
  }
  return definition;
}

async function requireCurrentCheckInputs(options: {
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly task: PlanTask;
  readonly checkId: string;
  readonly definition: CheckDefinition;
}): Promise<void> {
  const config = await loadProjectConfig(
    path.join(options.project.root, ".agents", "orchestrator.yaml"),
  );
  if (config.project.id !== options.project.config.project.id) {
    throw new OrchestratorError(
      "check_stale",
      "Project identity changed while preparing Check evidence",
    );
  }
  const currentPlan = await loadPlan(
    options.plan.directory,
    catalogFromConfig(config),
  );
  const currentTask = findTask(currentPlan, options.task.id);
  const currentDefinition = requireCheckDefinition(
    { ...options.project, config },
    currentTask,
    options.checkId,
  );
  if (
    currentPlan.digest !== options.plan.digest ||
    canonicalJson(currentDefinition) !== canonicalJson(options.definition)
  ) {
    throw new OrchestratorError(
      "check_stale",
      `Plan or registered Check '${options.checkId}' changed during execution`,
    );
  }
}

function requireAppliedTask(run: RunState, task: PlanTask): TaskRecord {
  const state = run.tasks[task.id];
  if (
    !state?.input_commit ||
    !state.input_source_digest ||
    !state.output_source_digest ||
    !state.diff_digest ||
    state.patch_application?.state !== "applied" ||
    state.patch_application.host_diff_digest !== state.diff_digest
  ) {
    throw new OrchestratorError(
      "task_patch_missing",
      `Task '${task.id}' has no exact applied Patch ready for Checks`,
    );
  }
  return state;
}

async function requireNoInference(client: CheckOpenShell): Promise<void> {
  try {
    const route = await client.getInferenceRoute();
    throw new OrchestratorError(
      "check_inference_enabled",
      `Check gateway exposes inference route '${route.provider}/${route.model}'`,
    );
  } catch (error) {
    if (
      error instanceof OrchestratorError &&
      error.code === "openshell_inference_unconfigured"
    ) {
      return;
    }
    throw error;
  }
}

function requirePinnedPreflight(preflight: OpenShellPreflight): void {
  if (
    !preflight.requiredVersion ||
    preflight.versionMatches !== true ||
    preflight.requiredVersion !== preflight.installedVersion ||
    preflight.installedVersion !== preflight.status.version
  ) {
    throw new OrchestratorError(
      "check_openshell_unpinned",
      "Authoritative Checks require an exact, matching OpenShell version pin",
    );
  }
}

async function verifySandboxMarker(
  client: CheckOpenShell,
  sandbox: string,
  intent: CheckIntent,
): Promise<void> {
  const result = await client.execSandbox(sandbox, [
    "/usr/local/bin/orchestrator-prepare-check",
    "verify",
    intent.id,
    intent.token,
  ]);
  if (result.exitCode !== 0) {
    throw new OrchestratorError(
      "check_sandbox_conflict",
      `Sandbox '${sandbox}' does not belong to Check job '${intent.id}'`,
    );
  }
}

function sandboxOwnership(
  intent: CheckIntent,
): Readonly<Record<string, string>> {
  const tokenFingerprint = sha256(intent.token).slice(7, 39);
  return {
    "pio-check-job": intent.id,
    "pio-check-token": tokenFingerprint,
  };
}

function requireSandboxOwnership(
  sandbox: OpenShellSandbox,
  intent: CheckIntent,
): void {
  for (const [key, value] of Object.entries(sandboxOwnership(intent))) {
    if (sandbox.labels[key] !== value) {
      throw new OrchestratorError(
        "check_sandbox_conflict",
        `Sandbox '${sandbox.name}' does not carry Check job '${intent.id}' ownership`,
      );
    }
  }
}

async function removeAbandonedSandbox(
  client: CheckOpenShell,
  intent: CheckIntent,
): Promise<void> {
  const existing = (await client.listSandboxes()).find(
    (sandbox) => sandbox.name === intent.sandbox,
  );
  if (!existing) return;
  requireSandboxOwnership(existing, intent);
  if (existing.phase === "Ready") {
    await verifySandboxMarker(client, existing.name, intent);
  }
  await client.deleteSandbox(existing.name);
}

async function cleanupFailedSandbox(
  client: CheckOpenShell,
  intent: CheckIntent,
  created?: OpenShellSandbox,
): Promise<void> {
  const sandbox =
    created ??
    (await client.listSandboxes()).find(
      (candidate) => candidate.name === intent.sandbox,
    );
  if (!sandbox) return;
  requireSandboxOwnership(sandbox, intent);
  await client.deleteSandbox(sandbox.name, { missingOk: true });
}

async function createFreshSandbox(options: {
  readonly client: CheckOpenShell;
  readonly intent: CheckIntent;
  readonly image: CheckImage;
  readonly policy: LoadedSandboxPolicy;
}): Promise<OpenShellSandbox> {
  await removeAbandonedSandbox(options.client, options.intent);
  let sandbox: OpenShellSandbox | undefined;
  try {
    sandbox = await options.client.createSandbox({
      name: options.intent.sandbox,
      from: options.image.source,
      policyPath: options.policy.path,
      labels: sandboxOwnership(options.intent),
      command: [
        "/usr/local/bin/orchestrator-prepare-check",
        "init",
        options.intent.id,
        options.intent.token,
      ],
    });
    if (sandbox.phase !== "Ready") {
      sandbox = await options.client.waitForSandbox(options.intent.sandbox);
    }
    if (sandbox.phase !== "Ready" || sandbox.name !== options.intent.sandbox) {
      throw new OrchestratorError(
        "check_sandbox_failed",
        `Check Sandbox '${options.intent.sandbox}' is not ready`,
      );
    }
    requireSandboxOwnership(sandbox, options.intent);
    await verifySandboxMarker(options.client, sandbox.name, options.intent);
    return sandbox;
  } catch (error) {
    try {
      await cleanupFailedSandbox(options.client, options.intent, sandbox);
    } catch (cleanupError) {
      throw new OrchestratorError(
        "check_sandbox_cleanup_failed",
        `Check Sandbox '${options.intent.sandbox}' failed startup and cleanup: ${formatUnknownError(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function logMetadata(pathname: "stdout.log" | "stderr.log", value: string) {
  const bytes = Buffer.from(value, "utf8");
  return {
    path: pathname,
    byte_count: bytes.byteLength,
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  } as const;
}

function gateKey(checkId: string): string {
  return IdentifierSchema.parse(`check-${checkId}`);
}

function assertTaskBinding(
  current: TaskRecord,
  expected: TaskRecord,
  taskId: string,
): void {
  if (
    current.input_commit !== expected.input_commit ||
    current.output_source_digest !== expected.output_source_digest ||
    current.diff_digest !== expected.diff_digest ||
    canonicalJson(current.patch_application) !==
      canonicalJson(expected.patch_application)
  ) {
    throw new OrchestratorError(
      "check_stale",
      `Task '${taskId}' source or diff changed while the Check was running`,
    );
  }
}

async function recordPendingGate(options: {
  readonly store: CheckProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly expected: TaskRecord;
  readonly intent: CheckIntent;
  readonly timestamp: string;
}): Promise<void> {
  await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertTaskBinding(current, options.expected, options.task.id);
    if (current.status !== "checking") {
      throw new OrchestratorError(
        "task_not_checking",
        `Task '${options.task.id}' must be checking before a new Check starts`,
      );
    }
    const key = gateKey(options.intent.check);
    const existing = current.gates[key];
    if (existing) {
      if (
        existing.status !== "pending" ||
        existing.digest !== options.intent.binding_digest
      ) {
        throw new OrchestratorError(
          "check_gate_conflict",
          `Check Gate '${key}' already contains other evidence`,
        );
      }
      return run;
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.task.id]: {
          ...current,
          gates: {
            ...current.gates,
            [key]: {
              status: "pending",
              digest: options.intent.binding_digest,
              updated_at: options.timestamp,
            },
          },
        },
      },
    };
  });
}

async function finalizeGate(options: {
  readonly store: CheckProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly expected: TaskRecord;
  readonly record: CheckRecord;
  readonly timestamp: string;
}): Promise<TaskRecord> {
  const updated = await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertTaskBinding(current, options.expected, options.task.id);
    const key = gateKey(options.record.check);
    const existing = current.gates[key];
    if (
      existing &&
      existing.status === options.record.verdict &&
      existing.digest === options.record.record_digest
    ) {
      return run;
    }
    if (
      existing &&
      !(
        existing.status === "pending" &&
        existing.digest === options.record.intent_digest
      )
    ) {
      throw new OrchestratorError(
        "check_gate_conflict",
        `Check Gate '${key}' already contains other evidence`,
      );
    }
    if (!["checking", "rework", "reviewing"].includes(current.status)) {
      throw new OrchestratorError(
        "task_state_changed",
        `Task '${options.task.id}' cannot accept Check evidence while ${current.status}`,
      );
    }
    const gates = {
      ...current.gates,
      [key]: {
        status: options.record.verdict,
        digest: options.record.record_digest,
        updated_at: options.timestamp,
      },
    };
    const allPass = options.task.checks.every(
      (check) => gates[gateKey(check)]?.status === "pass",
    );
    const status =
      options.record.verdict === "fail"
        ? "rework"
        : allPass
          ? "reviewing"
          : "checking";
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [options.task.id]: { ...current, status, gates },
      },
    };
  });
  return updated.tasks[options.task.id]!;
}

async function inspectExactWorktree(options: {
  readonly project: Project;
  readonly run: RunState;
  readonly task: TaskRecord;
  readonly patch: VerifiedPatch;
}): Promise<void> {
  const observed = await new GitPatchWorktree().inspect({
    repository: options.project.root,
    worktree: options.run.worktree,
    branch: options.run.branch,
    inputCommit: options.task.input_commit!,
    patch: options.patch,
  });
  if (
    observed.state !== "applied" ||
    observed.hostDiffDigest !== options.task.diff_digest ||
    observed.resultSourceDigest !== options.task.output_source_digest
  ) {
    throw new OrchestratorError(
      "check_stale",
      `Run worktree does not match Task '${options.task.id}' applied Patch`,
    );
  }
}

export async function runCheck(
  options: RunCheckOptions,
): Promise<RunCheckResult> {
  const now = options.now ?? (() => new Date());
  const [projectRecord, run] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
  ]);
  requireRunBinding({
    run,
    project: options.project,
    plan: options.plan,
    projectRecord,
  });
  const task = findTask(options.plan, options.taskId);
  const definition = requireCheckDefinition(
    options.project,
    task,
    options.checkId,
  );
  await requireCurrentCheckInputs({
    project: options.project,
    plan: options.plan,
    task,
    checkId: options.checkId,
    definition,
  });
  const taskState = requireAppliedTask(run, task);
  const artifacts = new ArtifactStore(options.store.runDirectory(run.id));
  const patch = await loadPreparedPatch({
    store: artifacts,
    projectRoot: options.project.root,
    application: taskState.patch_application!,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  await inspectExactWorktree({
    project: options.project,
    run,
    task: taskState,
    patch: patch.value,
  });

  const source = await createCheckSource({
    projectRoot: options.project.root,
    inputCommit: taskState.input_commit!,
    taskSourceDigest: taskState.output_source_digest!,
    diffDigest: taskState.diff_digest!,
    patch: patch.value,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  let stagedImage: StagedCheckImage | undefined;
  try {
    const image = await verifyCheckImage(
      options.image ?? (await loadBundledCheckImage()),
    );
    stagedImage = await stageCheckImage(image, options.temporaryRoot);
    const policy = await stageCheckPolicy(
      await loadSandboxPolicy(
        "check",
        options.policyDirectory
          ? path.join(path.resolve(options.policyDirectory), "check.yaml")
          : bundledCheckPolicy(),
      ),
      source.directory,
    );
    const requested = createIntent(
      {
        run: run.id,
        task: task.id,
        check: IdentifierSchema.parse(options.checkId),
        plan_digest: run.plan_digest as Digest,
        input_commit: taskState.input_commit!,
        task_source_digest: taskState.output_source_digest as Digest,
        source_digest: source.manifest.source_digest,
        diff_digest: taskState.diff_digest as Digest,
        argv: definition.argv,
        cwd: definition.cwd ?? ".",
        timeout_ms: CheckTimeoutSchema.parse(
          options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        ),
        image,
        policy_digest: policy.digest,
      },
      (options.token ?? (() => randomBytes(32).toString("hex")))(),
      now(),
    );
    const checks = new CheckStore(options.store.runDirectory(run.id));
    const intent = await checks.prepare(requested);
    const existing = await checks.getResult(task.id, intent.check, intent.id);
    if (existing) {
      requireRecordIntent(existing, intent);
      const current = await options.store.readRun(run.id);
      const currentTask = requireAppliedTask(current, task);
      assertTaskBinding(currentTask, taskState, task.id);
      const finalized = await finalizeGate({
        store: options.store,
        runId: run.id,
        task,
        expected: taskState,
        record: existing,
        timestamp: now().toISOString(),
      });
      return { intent, record: existing, reused: true, task: finalized };
    }

    const preflight = await options.client.preflight();
    requirePinnedPreflight(preflight);
    await requireNoInference(options.client);
    await recordPendingGate({
      store: options.store,
      runId: run.id,
      task,
      expected: taskState,
      intent,
      timestamp: now().toISOString(),
    });

    let sandbox: OpenShellSandbox | undefined;
    let commandResult: ProcessResult | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let operationError: unknown;
    try {
      sandbox = await createFreshSandbox({
        client: options.client,
        intent,
        image: { ...image, source: stagedImage.source },
        policy,
      });
      await options.client.upload(
        sandbox.name,
        source.archivePath,
        "/sandbox/input/source.tar",
      );
      await options.client.upload(
        sandbox.name,
        source.manifestPath,
        "/sandbox/input/source.json",
      );
      const prepared = await options.client.execSandbox(
        sandbox.name,
        [
          "/usr/local/bin/orchestrator-prepare-check",
          "source",
          intent.id,
          intent.token,
          "/sandbox/input/source.tar",
          "/sandbox/input/source.json",
        ],
        { timeoutMs: 5 * 60_000 },
      );
      if (
        prepared.exitCode !== 0 ||
        prepared.stdout.trim() !== source.manifest.source_digest
      ) {
        const diagnostic = prepared.stderr.trim() || prepared.stdout.trim();
        throw new OrchestratorError(
          "check_source_rejected",
          `Check Sandbox rejected source '${source.manifest.source_digest}'${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
        );
      }
      await inspectExactWorktree({
        project: options.project,
        run: await options.store.readRun(run.id),
        task: taskState,
        patch: patch.value,
      });
      startedAt = now().toISOString();
      commandResult = await options.client.execSandbox(
        sandbox.name,
        intent.argv,
        {
          timeoutMs: intent.timeout_ms,
          workdir:
            intent.cwd === "."
              ? "/workspace/project"
              : path.posix.join("/workspace/project", intent.cwd),
        },
      );
      endedAt = now().toISOString();
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    if (sandbox) {
      try {
        await options.client.deleteSandbox(sandbox.name, { missingOk: true });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (operationError || cleanupError) {
      throw new OrchestratorError(
        "check_execution_failed",
        `Check '${intent.check}' could not produce authoritative evidence: ${formatUnknownError(operationError ?? cleanupError)}`,
        { cause: operationError ?? cleanupError },
      );
    }

    await inspectExactWorktree({
      project: options.project,
      run: await options.store.readRun(run.id),
      task: taskState,
      patch: patch.value,
    });
    const latestProject = await options.store.read();
    requireFreshApproval(latestProject.approvals[options.plan.id], {
      planId: run.plan_id,
      planRevision: run.plan_revision,
      planDigest: DigestSchema.parse(run.plan_digest) as Digest,
      baseCommit: run.base_commit,
    });
    await requireCurrentCheckInputs({
      project: options.project,
      plan: options.plan,
      task,
      checkId: intent.check,
      definition,
    });

    const stdout = commandResult!.stdout;
    const stderr = commandResult!.stderr;
    const record = createRecord({
      version: 1,
      id: intent.id,
      run: intent.run,
      task: intent.task,
      check: intent.check,
      verdict: commandResult!.exitCode === 0 ? "pass" : "fail",
      argv: intent.argv,
      cwd: intent.cwd,
      timeout_ms: intent.timeout_ms,
      started_at: startedAt!,
      ended_at: endedAt!,
      exit_code: commandResult!.exitCode,
      ...(commandResult!.signal ? { signal: commandResult!.signal } : {}),
      stdout: logMetadata("stdout.log", stdout),
      stderr: logMetadata("stderr.log", stderr),
      source_digest: intent.source_digest,
      task_source_digest: intent.task_source_digest,
      input_commit: intent.input_commit,
      diff_digest: intent.diff_digest,
      plan_digest: intent.plan_digest,
      image: intent.image,
      policy_digest: intent.policy_digest,
      sandbox: {
        id: sandbox!.id,
        name: sandbox!.name,
        workspace: sandbox!.workspace,
      },
      openshell: {
        cli_version: preflight.installedVersion,
        gateway: preflight.status.gateway,
        gateway_version: preflight.status.version,
      },
      intent_digest: intent.binding_digest,
    });
    const stored = await checks.putResult({ intent, record, stdout, stderr });
    const finalized = await finalizeGate({
      store: options.store,
      runId: run.id,
      task,
      expected: taskState,
      record: stored,
      timestamp: now().toISOString(),
    });
    return { intent, record: stored, reused: false, task: finalized };
  } finally {
    await stagedImage?.dispose();
    await source.dispose();
  }
}
