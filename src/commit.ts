import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitPatchWorktree, loadPreparedPatch } from "./apply.js";
import { requireFreshApproval } from "./approval.js";
import { ArtifactStore } from "./artifact.js";
import { CheckStore, type CheckRecord } from "./check.js";
import {
  IdentifierSchema,
  ReviewLensSchema,
  type ReviewLens,
} from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import {
  GitCommitSchema,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git.js";
import type { LocalConfig } from "./local.js";
import { resolveReviewModelRoute } from "./model.js";
import {
  validateVerifiedPatch,
  verifyAppliedPatchResult,
  WorkspacePathSchema,
  type VerifiedPatch,
} from "./patch.js";
import {
  catalogFromConfig,
  loadPlan,
  type LoadedPlan,
  type PlanTask,
} from "./plan.js";
import { loadSandboxPolicy } from "./policy.js";
import {
  projectPermissionPolicyDigest,
  roleHasReadSource,
} from "./permission.js";
import { gitHead, loadProject, type Project } from "./project.js";
import { ReviewStore, type ReviewRecord } from "./review.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  bundledPiPolicyDirectory,
} from "./agent.js";
import { validatePatchPaths } from "./scope.js";
import {
  syncDirectory,
  writeJsonAtomic,
  type ProjectRecord,
  type ProjectStore,
  type RunState,
  type TaskRecord,
} from "./state.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CommitJobIdSchema = z.string().regex(/^commit-[a-f0-9]{16}$/);
const CommitSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\0]/.test(value), "must be one safe line");
const GitIdentityValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/[\r\n\0]/.test(value), "must be one safe line");

export const GitIdentitySchema = z
  .object({
    name: GitIdentityValueSchema,
    email: GitIdentityValueSchema.email(),
  })
  .strict();
export type GitIdentity = z.infer<typeof GitIdentitySchema>;

const CommitCheckBindingSchema = z
  .object({
    check: IdentifierSchema,
    record_digest: DigestSchema,
  })
  .strict();

const CommitReviewBindingSchema = z
  .object({
    lens: ReviewLensSchema,
    record_digest: DigestSchema,
  })
  .strict();

const CommitChangeSchema = z
  .object({
    path: WorkspacePathSchema,
    status: z.enum(["added", "modified", "deleted"]),
  })
  .strict();

const CommitProposalWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    run: IdentifierSchema,
    task: IdentifierSchema,
    title: z.string().trim().min(1).max(1_000),
    plan: z
      .object({
        id: IdentifierSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    branch: z.string().trim().min(1).max(1_024),
    input_commit: GitCommitSchema,
    task_source_digest: DigestSchema,
    diff_digest: DigestSchema,
    patch_artifact: z
      .object({
        id: IdentifierSchema.max(128),
        content_digest: DigestSchema,
      })
      .strict(),
    changes: z.array(CommitChangeSchema).min(1),
    checks: z.array(CommitCheckBindingSchema).min(1),
    reviews: z.array(CommitReviewBindingSchema).min(1),
    subject: CommitSubjectSchema,
    author: GitIdentitySchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    for (const [name, values] of [
      ["changes", proposal.changes.map((change) => change.path)],
      ["checks", proposal.checks.map((check) => check.check)],
      ["reviews", proposal.reviews.map((review) => review.lens)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "must contain unique entries",
        });
      }
    }
  });

export const CommitProposalSchema = CommitProposalWithoutDigestSchema.extend({
  proposal_digest: DigestSchema,
}).strict();
export type CommitProposal = z.infer<typeof CommitProposalSchema>;

const CommitIntentBindingSchema = z
  .object({
    proposal: CommitProposalSchema,
    approved_by: z.string().trim().min(1).max(320),
    approved_at: TimestampSchema,
  })
  .strict();

export const CommitIntentSchema = CommitIntentBindingSchema.extend({
  version: z.literal(1),
  id: CommitJobIdSchema,
  binding_digest: DigestSchema,
  prepared_at: TimestampSchema,
}).strict();
export type CommitIntent = z.infer<typeof CommitIntentSchema>;

const GitCommitEvidenceSchema = z
  .object({
    commit: GitCommitSchema,
    parent: GitCommitSchema,
    tree: GitCommitSchema,
    subject: CommitSubjectSchema,
    author: GitIdentitySchema,
    committer: GitIdentitySchema,
    committed_at: TimestampSchema,
  })
  .strict();
export type GitCommitEvidence = z.infer<typeof GitCommitEvidenceSchema>;

const CommitRecordWithoutDigestSchema = z
  .object({
    version: z.literal(1),
    id: CommitJobIdSchema,
    run: IdentifierSchema,
    task: IdentifierSchema,
    proposal_digest: DigestSchema,
    intent_digest: DigestSchema,
    git: GitCommitEvidenceSchema,
    recorded_at: TimestampSchema,
  })
  .strict();

export const CommitRecordSchema = CommitRecordWithoutDigestSchema.extend({
  record_digest: DigestSchema,
}).strict();
export type CommitRecord = z.infer<typeof CommitRecordSchema>;

function proposalDigest(
  proposal: z.infer<typeof CommitProposalWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/commit-proposal/v1", [
    ["proposal", canonicalJson(proposal)],
  ]);
}

function createProposal(
  input: z.input<typeof CommitProposalWithoutDigestSchema>,
): CommitProposal {
  const parsed = CommitProposalWithoutDigestSchema.parse(input);
  return CommitProposalSchema.parse({
    ...parsed,
    proposal_digest: proposalDigest(parsed),
  });
}

function validateProposal(value: unknown): CommitProposal {
  const parsed = CommitProposalSchema.parse(value);
  const { proposal_digest: digest, ...input } = parsed;
  if (
    proposalDigest(CommitProposalWithoutDigestSchema.parse(input)) !== digest
  ) {
    throw new OrchestratorError(
      "commit_store_corrupt",
      "Commit proposal has an invalid digest",
    );
  }
  return parsed;
}

function intentDigest(
  binding: z.infer<typeof CommitIntentBindingSchema>,
): Digest {
  return digestParts("pi-orchestrator/commit-intent/v1", [
    ["intent", canonicalJson(binding)],
  ]);
}

function createIntent(options: {
  readonly proposal: CommitProposal;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly preparedAt: Date;
}): CommitIntent {
  const binding = CommitIntentBindingSchema.parse({
    proposal: validateProposal(options.proposal),
    approved_by: options.approvedBy,
    approved_at: options.approvedAt.toISOString(),
  });
  const digest = intentDigest(binding);
  return CommitIntentSchema.parse({
    version: 1,
    ...binding,
    id: `commit-${digest.slice("sha256:".length, "sha256:".length + 16)}`,
    binding_digest: digest,
    prepared_at: options.preparedAt.toISOString(),
  });
}

function validateIntent(value: unknown): CommitIntent {
  const parsed = CommitIntentSchema.parse(value);
  const binding = CommitIntentBindingSchema.parse({
    proposal: validateProposal(parsed.proposal),
    approved_by: parsed.approved_by,
    approved_at: parsed.approved_at,
  });
  const expected = intentDigest(binding);
  const expectedId = `commit-${expected.slice("sha256:".length, "sha256:".length + 16)}`;
  if (parsed.binding_digest !== expected || parsed.id !== expectedId) {
    throw new OrchestratorError(
      "commit_store_corrupt",
      `Commit intent '${parsed.id}' has an invalid binding digest`,
    );
  }
  return parsed;
}

function recordDigest(
  record: z.infer<typeof CommitRecordWithoutDigestSchema>,
): Digest {
  return digestParts("pi-orchestrator/commit-record/v1", [
    ["record", canonicalJson(record)],
  ]);
}

function createRecord(options: {
  readonly intent: CommitIntent;
  readonly git: GitCommitEvidence;
  readonly recordedAt: Date;
}): CommitRecord {
  const parsed = CommitRecordWithoutDigestSchema.parse({
    version: 1,
    id: options.intent.id,
    run: options.intent.proposal.run,
    task: options.intent.proposal.task,
    proposal_digest: options.intent.proposal.proposal_digest,
    intent_digest: options.intent.binding_digest,
    git: options.git,
    recorded_at: options.recordedAt.toISOString(),
  });
  return CommitRecordSchema.parse({
    ...parsed,
    record_digest: recordDigest(parsed),
  });
}

function validateRecord(value: unknown): CommitRecord {
  const parsed = CommitRecordSchema.parse(value);
  const { record_digest: digest, ...input } = parsed;
  if (recordDigest(CommitRecordWithoutDigestSchema.parse(input)) !== digest) {
    throw new OrchestratorError(
      "commit_store_corrupt",
      `Commit record '${parsed.id}' has an invalid digest`,
    );
  }
  return parsed;
}

function requireRecordIntent(record: CommitRecord, intent: CommitIntent): void {
  if (
    record.id !== intent.id ||
    record.run !== intent.proposal.run ||
    record.task !== intent.proposal.task ||
    record.proposal_digest !== intent.proposal.proposal_digest ||
    record.intent_digest !== intent.binding_digest ||
    record.git.parent !== intent.proposal.input_commit ||
    record.git.subject !== intent.proposal.subject ||
    canonicalJson(record.git.author) !==
      canonicalJson(intent.proposal.author) ||
    canonicalJson(record.git.committer) !==
      canonicalJson(intent.proposal.author)
  ) {
    throw new OrchestratorError(
      "commit_result_mismatch",
      `Commit record '${record.id}' does not match its human-approved intent`,
    );
  }
}

function isRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

export class CommitStore {
  readonly directory: string;

  constructor(runDirectory: string) {
    this.directory = path.join(path.resolve(runDirectory), "commits");
  }

  private jobDirectory(task: string, job: string): string {
    return path.join(
      this.directory,
      IdentifierSchema.parse(task),
      CommitJobIdSchema.parse(job),
    );
  }

  async getIntent(
    task: string,
    job: string,
  ): Promise<CommitIntent | undefined> {
    const filePath = path.join(this.jobDirectory(task, job), "intent.json");
    try {
      return validateIntent(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Invalid Commit intent at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async prepare(intent: CommitIntent): Promise<CommitIntent> {
    const parsed = validateIntent(intent);
    const existing = await this.getIntent(parsed.proposal.task, parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new OrchestratorError(
          "commit_intent_conflict",
          `Commit job '${parsed.id}' already has another intent`,
        );
      }
      return existing;
    }
    const parent = path.dirname(
      this.jobDirectory(parsed.proposal.task, parsed.id),
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, `.${parsed.id}-`));
    try {
      await writeJsonAtomic(path.join(staging, "intent.json"), parsed);
      await chmod(path.join(staging, "intent.json"), 0o400);
      try {
        await rename(
          staging,
          this.jobDirectory(parsed.proposal.task, parsed.id),
        );
        await syncDirectory(parent);
        return parsed;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.getIntent(parsed.proposal.task, parsed.id);
        if (!raced || canonicalJson(raced) !== canonicalJson(parsed)) {
          throw new OrchestratorError(
            "commit_intent_conflict",
            `Commit job '${parsed.id}' raced with another intent`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async getResult(
    task: string,
    job: string,
  ): Promise<CommitRecord | undefined> {
    const expectedTask = IdentifierSchema.parse(task);
    const expectedJob = CommitJobIdSchema.parse(job);
    const filePath = path.join(
      this.jobDirectory(expectedTask, expectedJob),
      "result",
      "record.json",
    );
    try {
      const record = validateRecord(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (record.task !== expectedTask || record.id !== expectedJob) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Commit result identity does not match ${filePath}`,
        );
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Invalid Commit result at ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async entries(task: string) {
    const directory = path.join(this.directory, IdentifierSchema.parse(task));
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async findIntentByDigest(
    task: string,
    digest: string,
  ): Promise<CommitIntent | undefined> {
    const expectedDigest = DigestSchema.parse(digest);
    let found: CommitIntent | undefined;
    for (const entry of (await this.entries(task)).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !CommitJobIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Unexpected Commit store entry '${entry.name}'`,
        );
      }
      const intent = await this.getIntent(task, entry.name);
      if (!intent || intent.binding_digest !== expectedDigest) continue;
      if (found) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Commit intent digest '${expectedDigest}' is duplicated`,
        );
      }
      found = intent;
    }
    return found;
  }

  async findIntentByProposalDigest(
    task: string,
    digest: string,
  ): Promise<CommitIntent | undefined> {
    const expectedDigest = DigestSchema.parse(digest);
    let found: CommitIntent | undefined;
    for (const entry of (await this.entries(task)).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !CommitJobIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Unexpected Commit store entry '${entry.name}'`,
        );
      }
      const intent = await this.getIntent(task, entry.name);
      if (!intent || intent.proposal.proposal_digest !== expectedDigest)
        continue;
      if (found) {
        throw new OrchestratorError(
          "commit_intent_ambiguous",
          `Multiple human Commit intents authorize proposal '${expectedDigest}'`,
        );
      }
      found = intent;
    }
    return found;
  }

  async findResultByDigest(
    task: string,
    digest: string,
  ): Promise<CommitRecord | undefined> {
    const expectedDigest = DigestSchema.parse(digest);
    let found: CommitRecord | undefined;
    for (const entry of (await this.entries(task)).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      if (
        !entry.isDirectory() ||
        !CommitJobIdSchema.safeParse(entry.name).success
      ) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Unexpected Commit store entry '${entry.name}'`,
        );
      }
      const record = await this.getResult(task, entry.name);
      if (!record || record.record_digest !== expectedDigest) continue;
      if (found) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Commit record digest '${expectedDigest}' is duplicated`,
        );
      }
      found = record;
    }
    return found;
  }

  async listResults(): Promise<CommitRecord[]> {
    let taskEntries;
    try {
      taskEntries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: CommitRecord[] = [];
    for (const taskEntry of taskEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (taskEntry.name.startsWith(".")) continue;
      if (
        !taskEntry.isDirectory() ||
        !IdentifierSchema.safeParse(taskEntry.name).success
      ) {
        throw new OrchestratorError(
          "commit_store_corrupt",
          `Unexpected Commit Task entry '${path.join(this.directory, taskEntry.name)}'`,
        );
      }
      for (const jobEntry of (await this.entries(taskEntry.name)).sort(
        (left, right) => left.name.localeCompare(right.name),
      )) {
        if (jobEntry.name.startsWith(".")) continue;
        if (
          !jobEntry.isDirectory() ||
          !CommitJobIdSchema.safeParse(jobEntry.name).success
        ) {
          throw new OrchestratorError(
            "commit_store_corrupt",
            `Unexpected Commit job entry '${path.join(this.directory, taskEntry.name, jobEntry.name)}'`,
          );
        }
        const record = await this.getResult(taskEntry.name, jobEntry.name);
        if (record) records.push(record);
      }
    }
    return records.sort(
      (left, right) =>
        left.recorded_at.localeCompare(right.recorded_at) ||
        left.id.localeCompare(right.id),
    );
  }

  async putResult(
    intent: CommitIntent,
    requested: CommitRecord,
  ): Promise<CommitRecord> {
    const parsedIntent = validateIntent(intent);
    const record = validateRecord(requested);
    requireRecordIntent(record, parsedIntent);
    const durableIntent = await this.getIntent(
      parsedIntent.proposal.task,
      parsedIntent.id,
    );
    if (
      !durableIntent ||
      canonicalJson(durableIntent) !== canonicalJson(parsedIntent)
    ) {
      throw new OrchestratorError(
        "commit_intent_conflict",
        `Commit job '${parsedIntent.id}' has no matching durable intent`,
      );
    }
    const existing = await this.getResult(record.task, record.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new OrchestratorError(
          "commit_result_conflict",
          `Commit job '${record.id}' already has another result`,
        );
      }
      return existing;
    }
    const jobDirectory = this.jobDirectory(record.task, record.id);
    const resultDirectory = path.join(jobDirectory, "result");
    const staging = await mkdtemp(path.join(jobDirectory, ".result-"));
    try {
      const filePath = path.join(staging, "record.json");
      await writeJsonAtomic(filePath, record);
      await chmod(filePath, 0o400);
      try {
        await rename(staging, resultDirectory);
        await syncDirectory(jobDirectory);
        return record;
      } catch (error) {
        if (!isRenameConflict(error)) throw error;
        const raced = await this.getResult(record.task, record.id);
        if (!raced || canonicalJson(raced) !== canonicalJson(record)) {
          throw new OrchestratorError(
            "commit_result_conflict",
            `Commit job '${record.id}' raced with another result`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function gitFailure(
  args: readonly string[],
  result: GitCommandResult,
): OrchestratorError {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  return new OrchestratorError(
    "git_failed",
    `git ${args.join(" ")} failed with exit ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
  );
}

function safeGitEnvironment(includeUserConfig: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && value !== undefined)
      environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LANG = "C.UTF-8";
  if (!includeUserConfig) {
    environment.GIT_CONFIG_GLOBAL = "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
  }
  return environment;
}

const safeGitConfiguration = ["-c", "core.fsmonitor=false"] as const;

function safeGitArguments(args: readonly string[]): readonly string[] {
  return [...safeGitConfiguration, ...args];
}

function gitRunner(includeUserConfig: boolean): GitCommandRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const command = safeGitArguments(args);
      execFile(
        "git",
        [...command],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: safeGitEnvironment(includeUserConfig),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          const failure = error as unknown as Error & {
            readonly code?: number | string;
            readonly stdout?: string;
            readonly stderr?: string;
          };
          if (typeof failure.code !== "number") {
            reject(
              new OrchestratorError(
                "git_unavailable",
                `Cannot execute git ${args.join(" ")}`,
                { cause: error },
              ),
            );
            return;
          }
          resolve({
            stdout: failure.stdout ?? stdout,
            stderr: failure.stderr ?? stderr,
            exitCode: failure.code,
          });
        },
      );
    });
}

interface GitBinaryCommandResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

type GitBinaryCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitBinaryCommandResult>;

function binaryGitRunner(includeUserConfig: boolean): GitBinaryCommandRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const command = safeGitArguments(args);
      execFile(
        "git",
        [...command],
        {
          cwd,
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          env: safeGitEnvironment(includeUserConfig),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr: stderr.toString("utf8"), exitCode: 0 });
            return;
          }
          const failure = error as unknown as Error & {
            readonly code?: number | string;
            readonly stdout?: Buffer;
            readonly stderr?: Buffer;
          };
          if (typeof failure.code !== "number") {
            reject(
              new OrchestratorError(
                "git_unavailable",
                `Cannot execute git ${args.join(" ")}`,
                { cause: error },
              ),
            );
            return;
          }
          resolve({
            stdout: failure.stdout ?? stdout,
            stderr: (failure.stderr ?? stderr).toString("utf8"),
            exitCode: failure.code,
          });
        },
      );
    });
}

const trustedCommitGitRunner = gitRunner(false);
const trustedCommitBinaryGitRunner = binaryGitRunner(false);
const userConfigGitRunner = gitRunner(true);

export async function readGitIdentity(
  repository: string,
  runner: GitCommandRunner = userConfigGitRunner,
): Promise<GitIdentity> {
  const values: string[] = [];
  for (const key of ["user.name", "user.email"] as const) {
    const args = ["config", "--get", key] as const;
    const result = await runner(args, path.resolve(repository));
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new OrchestratorError(
        "git_identity_missing",
        `Git ${key} is required for a human-authorized commit`,
      );
    }
    values.push(result.stdout.trim());
  }
  return GitIdentitySchema.parse({ name: values[0], email: values[1] });
}

function parseStatusPaths(source: string): readonly string[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git status did not terminate its path records",
    );
  }
  const paths: string[] = [];
  for (const record of source.slice(0, -1).split("\0")) {
    if (record.length < 4 || record[2] !== " ") {
      throw new OrchestratorError(
        "invalid_git_output",
        "git status returned an invalid path record",
      );
    }
    if (
      record[0] === "R" ||
      record[0] === "C" ||
      record[1] === "R" ||
      record[1] === "C"
    ) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git status returned an unexpected rename or copy record",
      );
    }
    paths.push(WorkspacePathSchema.parse(record.slice(3)));
  }
  if (new Set(paths).size !== paths.length) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git status returned duplicate paths",
    );
  }
  return paths.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

function parseNulPaths(source: string): readonly string[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git path output did not end with NUL",
    );
  }
  const paths = source
    .slice(0, -1)
    .split("\0")
    .map((value) => WorkspacePathSchema.parse(value));
  if (new Set(paths).size !== paths.length) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git path output contains duplicates",
    );
  }
  return paths.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

interface GitIndexEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  readonly object: string;
}

function parseIndexEntries(source: string): readonly GitIndexEntry[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git ls-files did not terminate its index records",
    );
  }
  const entries = source
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const match =
        /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(
          record,
        );
      if (!match) {
        throw new OrchestratorError(
          "invalid_git_output",
          "git ls-files returned an unsupported index entry",
        );
      }
      return {
        mode: match[1] as GitIndexEntry["mode"],
        object: GitCommitSchema.parse(match[2]),
        path: WorkspacePathSchema.parse(match[3]),
      };
    });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git ls-files returned duplicate or unmerged index paths",
    );
  }
  return entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  );
}

function parseAttributeValues(
  source: string,
  expectedPaths: readonly string[],
): ReadonlyMap<string, string> {
  if (!source.endsWith("\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git check-attr did not terminate its records",
    );
  }
  const values = source.slice(0, -1).split("\0");
  if (values.length !== expectedPaths.length * 3) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git check-attr returned an unexpected record count",
    );
  }
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 3) {
    const entryPath = WorkspacePathSchema.parse(values[index]);
    if (values[index + 1] !== "filter" || result.has(entryPath)) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git check-attr returned an invalid filter record",
      );
    }
    result.set(entryPath, values[index + 2]!);
  }
  if (
    canonicalJson([...result.keys()].sort()) !==
    canonicalJson([...expectedPaths].sort())
  ) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git check-attr returned paths outside the Commit proposal",
    );
  }
  return result;
}

async function requireNoCleanFilters(options: {
  readonly worktree: string;
  readonly paths: readonly string[];
  readonly source?: string;
  readonly runner?: GitCommandRunner;
}): Promise<void> {
  const runner = options.runner ?? trustedCommitGitRunner;
  for (let offset = 0; offset < options.paths.length; offset += 128) {
    const paths = options.paths.slice(offset, offset + 128);
    const args = [
      "check-attr",
      ...(options.source ? [`--source=${options.source}`] : []),
      "-z",
      "filter",
      "--",
      ...paths,
    ] as const;
    const result = await runner(args, options.worktree);
    if (result.exitCode !== 0) throw gitFailure(args, result);
    for (const [entryPath, value] of parseAttributeValues(
      result.stdout,
      paths,
    )) {
      if (value !== "unspecified" && value !== "unset") {
        throw new OrchestratorError(
          "commit_filter_unsupported",
          `Task source path '${entryPath}' has Git clean filter '${value}'; trusted Commit verification does not execute filters`,
        );
      }
    }
  }
}

async function commitSourcePaths(options: {
  readonly worktree: string;
  readonly inputCommit: string;
  readonly sourcePaths: readonly string[];
  readonly changedPaths: readonly string[];
}): Promise<readonly string[]> {
  const args = [
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    options.inputCommit,
    "--",
    ...options.sourcePaths,
  ] as const;
  const result = await trustedCommitGitRunner(args, options.worktree);
  if (result.exitCode !== 0) throw gitFailure(args, result);
  const paths = new Set(parseNulPaths(result.stdout));
  for (const changed of options.changedPaths) paths.add(changed);
  return [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

export interface CommitWorktreeOptions {
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly inputCommit: string;
  readonly diffDigest: Digest;
  readonly subject: string;
  readonly author: GitIdentity;
  readonly patch: VerifiedPatch;
}

export interface CommitWorktreeInspection {
  readonly state: "ready" | "committed";
  readonly git?: GitCommitEvidence;
}

export interface CommitWorktreeResult {
  readonly git: GitCommitEvidence;
  readonly created: boolean;
  readonly recovered: boolean;
}

export interface CommitWorktreePort {
  inspect(options: CommitWorktreeOptions): Promise<CommitWorktreeInspection>;
  commit(options: CommitWorktreeOptions): Promise<CommitWorktreeResult>;
}

export class GitCommitWorktree implements CommitWorktreePort {
  constructor(
    private readonly runner: GitCommandRunner = trustedCommitGitRunner,
    private readonly binaryRunner: GitBinaryCommandRunner = trustedCommitBinaryGitRunner,
  ) {}

  private async command(
    args: readonly string[],
    cwd: string,
  ): Promise<GitCommandResult> {
    return this.runner(args, cwd);
  }

  private async requireCommand(
    args: readonly string[],
    cwd: string,
  ): Promise<string> {
    const result = await this.command(args, cwd);
    if (result.exitCode !== 0) throw gitFailure(args, result);
    return result.stdout.trim();
  }

  private async requireNoCleanFilters(
    options: CommitWorktreeOptions,
  ): Promise<void> {
    const paths = options.patch.bundle.changes.map((change) => change.path);
    await requireNoCleanFilters({
      worktree: options.worktree,
      paths,
      runner: this.runner,
    });
  }

  private async verifyIndex(options: CommitWorktreeOptions): Promise<string> {
    const paths = options.patch.bundle.changes.map((change) => change.path);
    const args = ["ls-files", "--stage", "-z", "--", ...paths] as const;
    const result = await this.command(args, options.worktree);
    if (result.exitCode !== 0) throw gitFailure(args, result);
    const entries = parseIndexEntries(result.stdout);
    const expected = options.patch.bundle.changes.flatMap((change) =>
      change.after ? [change.after] : [],
    );
    if (
      canonicalJson(
        entries.map(({ path: entryPath, mode }) => ({ path: entryPath, mode })),
      ) !==
      canonicalJson(
        expected.map(({ path: entryPath, mode }) => ({
          path: entryPath,
          mode,
        })),
      )
    ) {
      throw new OrchestratorError(
        "commit_index_mismatch",
        "Git index paths or modes do not match the approved Task Patch",
      );
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const wanted = expected[index]!;
      const content = await this.binaryRunner(
        ["cat-file", "blob", entry.object],
        options.worktree,
      );
      if (content.exitCode !== 0) {
        throw new OrchestratorError(
          "git_failed",
          `git cat-file blob failed with exit ${content.exitCode}${content.stderr.trim() ? `: ${content.stderr.trim().slice(0, 2_000)}` : ""}`,
        );
      }
      if (
        content.stdout.byteLength !== wanted.size ||
        sha256(content.stdout) !== wanted.content_digest
      ) {
        throw new OrchestratorError(
          "commit_index_mismatch",
          `Git index content for '${entry.path}' does not match the approved Task Patch`,
        );
      }
    }
    return GitCommitSchema.parse(
      await this.requireCommand(["write-tree"], options.worktree),
    );
  }

  private async identity(options: CommitWorktreeOptions): Promise<string> {
    const repository = path.resolve(options.repository);
    const worktree = path.resolve(options.worktree);
    const [repositoryState, worktreeState] = await Promise.all([
      lstat(repository).catch(() => undefined),
      lstat(worktree).catch(() => undefined),
    ]);
    if (
      !repositoryState?.isDirectory() ||
      repositoryState.isSymbolicLink() ||
      (await realpath(repository).catch(() => undefined)) !== repository
    ) {
      throw new OrchestratorError(
        "git_repository_mismatch",
        `Project repository '${repository}' is unavailable or indirect`,
      );
    }
    if (
      !worktreeState?.isDirectory() ||
      worktreeState.isSymbolicLink() ||
      (await realpath(worktree).catch(() => undefined)) !== worktree
    ) {
      throw new OrchestratorError(
        "worktree_path_mismatch",
        `Run worktree '${worktree}' is unavailable or indirect`,
      );
    }
    const [repositoryTop, worktreeTop, repositoryCommon, worktreeCommon] =
      await Promise.all([
        this.requireCommand(["rev-parse", "--show-toplevel"], repository),
        this.requireCommand(["rev-parse", "--show-toplevel"], worktree),
        this.requireCommand(["rev-parse", "--git-common-dir"], repository),
        this.requireCommand(["rev-parse", "--git-common-dir"], worktree),
      ]);
    const [resolvedRepositoryTop, resolvedWorktreeTop, common, worktreeGit] =
      await Promise.all([
        realpath(path.resolve(repository, repositoryTop)),
        realpath(path.resolve(worktree, worktreeTop)),
        realpath(path.resolve(repository, repositoryCommon)),
        realpath(path.resolve(worktree, worktreeCommon)),
      ]);
    if (
      resolvedRepositoryTop !== repository ||
      resolvedWorktreeTop !== worktree ||
      common !== worktreeGit
    ) {
      throw new OrchestratorError(
        "worktree_repository_mismatch",
        `Run worktree '${worktree}' does not belong to Project '${repository}'`,
      );
    }
    const branch = await this.command(
      ["symbolic-ref", "--quiet", "HEAD"],
      worktree,
    );
    if (
      branch.exitCode !== 0 ||
      branch.stdout.trim() !== `refs/heads/${options.branch}`
    ) {
      throw new OrchestratorError(
        "worktree_branch_mismatch",
        `Run worktree is not on expected branch '${options.branch}'`,
      );
    }
    return GitCommitSchema.parse(
      await this.requireCommand(["rev-parse", "HEAD"], worktree),
    );
  }

  private async commitEvidence(
    options: CommitWorktreeOptions,
    head: string,
  ): Promise<GitCommitEvidence> {
    const format = [
      "%H",
      "%P",
      "%T",
      "%s",
      "%an",
      "%ae",
      "%cn",
      "%ce",
      "%cI",
    ].join("%x00");
    const raw = await this.requireCommand(
      ["show", "--no-patch", `--format=${format}%x00`, head],
      options.worktree,
    );
    if (!raw.endsWith("\0")) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git show did not terminate Commit metadata",
      );
    }
    const values = raw.slice(0, -1).split("\0");
    if (values.length !== 9) {
      throw new OrchestratorError(
        "invalid_git_output",
        "git show returned incomplete Commit metadata",
      );
    }
    const [
      commit,
      parents,
      tree,
      subject,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      committedAt,
    ] = values;
    if (parents?.includes(" ")) {
      throw new OrchestratorError(
        "commit_parent_mismatch",
        "A Task commit must have exactly one parent",
      );
    }
    const evidence = GitCommitEvidenceSchema.parse({
      commit,
      parent: parents,
      tree,
      subject,
      author: { name: authorName, email: authorEmail },
      committer: { name: committerName, email: committerEmail },
      committed_at: committedAt,
    });
    if (
      evidence.parent !== options.inputCommit ||
      evidence.subject !== options.subject ||
      canonicalJson(evidence.author) !== canonicalJson(options.author) ||
      canonicalJson(evidence.committer) !== canonicalJson(options.author)
    ) {
      throw new OrchestratorError(
        "commit_identity_mismatch",
        "Run branch HEAD does not match the approved Commit parent, subject, or identity",
      );
    }
    return evidence;
  }

  async inspect(
    rawOptions: CommitWorktreeOptions,
  ): Promise<CommitWorktreeInspection> {
    const options = {
      ...rawOptions,
      inputCommit: GitCommitSchema.parse(rawOptions.inputCommit),
      subject: CommitSubjectSchema.parse(rawOptions.subject),
      author: GitIdentitySchema.parse(rawOptions.author),
      patch: validateVerifiedPatch(rawOptions.patch),
    };
    const head = await this.identity(options);
    await this.requireNoCleanFilters(options);
    if (head === options.inputCommit) {
      const applied = await new GitPatchWorktree(this.runner).inspect({
        repository: options.repository,
        worktree: options.worktree,
        branch: options.branch,
        inputCommit: options.inputCommit,
        patch: options.patch,
      });
      if (applied.state !== "applied") {
        throw new OrchestratorError(
          "commit_patch_missing",
          "Run worktree does not contain the exact approved Task Patch",
        );
      }
      if (applied.hostDiffDigest !== options.diffDigest) {
        throw new OrchestratorError(
          "commit_stale",
          "Run worktree diff digest does not match the approved Task Patch",
        );
      }
      return { state: "ready" };
    }

    const git = await this.commitEvidence(options, head);
    const statusArgs = [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
    ] as const;
    const status = await this.command(statusArgs, options.worktree);
    if (status.exitCode !== 0) throw gitFailure(statusArgs, status);
    if (parseStatusPaths(status.stdout).length > 0) {
      throw new OrchestratorError(
        "worktree_dirty",
        "Run worktree changed after the approved Commit was created",
      );
    }
    const diffArgs = [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--no-renames",
      git.parent,
      git.commit,
    ] as const;
    const diff = await this.command(diffArgs, options.worktree);
    if (diff.exitCode !== 0) throw gitFailure(diffArgs, diff);
    const changedPaths = parseNulPaths(diff.stdout);
    const indexTree = await this.verifyIndex(options);
    if (indexTree !== git.tree) {
      throw new OrchestratorError(
        "commit_tree_mismatch",
        "Committed Git tree does not match the verified index",
      );
    }
    await verifyAppliedPatchResult({
      root: options.worktree,
      patch: options.patch,
      changedPaths,
    });
    return { state: "committed", git };
  }

  async commit(
    rawOptions: CommitWorktreeOptions,
  ): Promise<CommitWorktreeResult> {
    const options = {
      ...rawOptions,
      subject: CommitSubjectSchema.parse(rawOptions.subject),
      author: GitIdentitySchema.parse(rawOptions.author),
      patch: validateVerifiedPatch(rawOptions.patch),
    };
    const initial = await this.inspect(options);
    if (initial.state === "committed") {
      return { git: initial.git!, created: false, recovered: true };
    }
    const changedPaths = options.patch.bundle.changes.map(
      (change) => change.path,
    );
    await this.requireNoCleanFilters(options);
    const addArgs = ["add", "--all", "--", ...changedPaths] as const;
    const added = await this.command(addArgs, options.worktree);
    if (added.exitCode !== 0) throw gitFailure(addArgs, added);
    const statusArgs = [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
    ] as const;
    const staged = await this.command(statusArgs, options.worktree);
    if (staged.exitCode !== 0) throw gitFailure(statusArgs, staged);
    if (
      canonicalJson(parseStatusPaths(staged.stdout)) !==
      canonicalJson(changedPaths)
    ) {
      throw new OrchestratorError(
        "commit_staging_mismatch",
        "Git index paths do not match the approved Task Patch",
      );
    }
    await verifyAppliedPatchResult({
      root: options.worktree,
      patch: options.patch,
      changedPaths,
    });
    const stagedTree = await this.verifyIndex(options);
    const commitArgs = [
      "-c",
      `user.name=${options.author.name}`,
      "-c",
      `user.email=${options.author.email}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      stagedTree,
      "-p",
      options.inputCommit,
      "-m",
      options.subject,
    ] as const;
    const created = await this.command(commitArgs, options.worktree);
    if (created.exitCode !== 0) throw gitFailure(commitArgs, created);
    const candidate = GitCommitSchema.parse(created.stdout.trim());
    const updateArgs = [
      "update-ref",
      `refs/heads/${options.branch}`,
      candidate,
      options.inputCommit,
    ] as const;
    const updated = await this.command(updateArgs, options.worktree);
    let observed: CommitWorktreeInspection;
    try {
      observed = await this.inspect(options);
    } catch (error) {
      if (updated.exitCode !== 0) throw gitFailure(updateArgs, updated);
      throw error;
    }
    if (observed.state === "committed") {
      if (updated.exitCode === 0 && observed.git!.commit !== candidate) {
        throw new OrchestratorError(
          "commit_result_mismatch",
          "Git updated the Run branch to an unexpected Commit",
        );
      }
      if (observed.git!.tree !== stagedTree) {
        throw new OrchestratorError(
          "commit_tree_mismatch",
          "Git committed a tree other than the verified staged tree",
        );
      }
      return {
        git: observed.git!,
        created: updated.exitCode === 0,
        recovered: updated.exitCode !== 0,
      };
    }
    if (updated.exitCode !== 0) throw gitFailure(updateArgs, updated);
    throw new OrchestratorError(
      "commit_result_mismatch",
      "Git reported success without producing the exact approved Commit",
    );
  }
}

export type CommitProjectStore = Pick<
  ProjectStore,
  "read" | "readRun" | "runDirectory" | "updateRun"
>;

export interface InspectTaskCommitOptions {
  readonly store: CommitProjectStore;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly local: LocalConfig;
  readonly runId: string;
  readonly taskId: string;
  readonly author: GitIdentity;
  readonly subject?: string;
  readonly policyDirectory?: string;
  readonly temporaryRoot?: string;
  readonly worktrees?: CommitWorktreePort;
}

export interface CommitAuthorization {
  readonly proposalDigest: Digest;
  readonly approvedBy: string;
  readonly approvedAt?: Date;
}

export interface CommitTaskOptions extends InspectTaskCommitOptions {
  readonly authorization?: CommitAuthorization;
  readonly now?: () => Date;
}

export interface TaskCommitInspection {
  readonly state: "ready" | "authorized" | "committed";
  readonly proposal: CommitProposal;
  readonly worktree: CommitWorktreeInspection;
  readonly intent?: CommitIntent;
  readonly record?: CommitRecord;
}

export interface CommitTaskResult {
  readonly proposal: CommitProposal;
  readonly intent: CommitIntent;
  readonly record: CommitRecord;
  readonly task: TaskRecord;
  readonly run: RunState;
  readonly created: boolean;
  readonly recovered: boolean;
  readonly reused: boolean;
}

function requireRunBinding(options: {
  readonly run: RunState;
  readonly project: Project;
  readonly plan: LoadedPlan;
  readonly projectRecord: ProjectRecord;
  readonly currentHead: string;
}): void {
  const permissionPolicyDigest = projectPermissionPolicyDigest(
    options.project.roles,
  );
  if (
    options.run.project_id !== options.project.config.project.id ||
    path.resolve(options.projectRecord.root) !== options.project.root
  ) {
    throw new OrchestratorError(
      "run_project_conflict",
      `Run '${options.run.id}' does not belong to the loaded Project`,
    );
  }
  if (options.run.permission_policy_digest !== permissionPolicyDigest) {
    throw new OrchestratorError(
      "run_permission_policy_stale",
      `Run '${options.run.id}' was approved under another Role permission policy`,
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
  if (options.currentHead !== options.run.base_commit) {
    throw new OrchestratorError(
      "commit_base_stale",
      `Project HEAD changed after Run '${options.run.id}' was approved`,
    );
  }
  requireFreshApproval(options.projectRecord.approvals[options.plan.id], {
    planId: options.run.plan_id,
    planRevision: options.run.plan_revision,
    planDigest: options.run.plan_digest as Digest,
    permissionPolicyDigest,
    baseCommit: options.run.base_commit,
  });
}

async function currentProjectAndPlan(options: {
  readonly project: Project;
  readonly plan: LoadedPlan;
}): Promise<{ readonly project: Project; readonly plan: LoadedPlan }> {
  const project = await loadProject(options.project.root);
  if (project.config.project.id !== options.project.config.project.id) {
    throw new OrchestratorError(
      "commit_stale",
      "Project identity changed while preparing Commit evidence",
    );
  }
  const plan = await loadPlan(
    options.plan.directory,
    catalogFromConfig(project.config),
  );
  if (plan.digest !== options.plan.digest) {
    throw new OrchestratorError(
      "commit_stale",
      "The approved Plan changed while preparing Commit evidence",
    );
  }
  return { project, plan };
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

function requireAppliedTask(run: RunState, task: PlanTask): TaskRecord {
  const state = run.tasks[task.id];
  if (
    !state?.input_commit ||
    !state.output_source_digest ||
    !state.diff_digest ||
    state.patch_application?.state !== "applied" ||
    state.patch_application.host_diff_digest !== state.diff_digest
  ) {
    throw new OrchestratorError(
      "task_patch_missing",
      `Task '${task.id}' has no exact applied Patch ready to commit`,
    );
  }
  return state;
}

function checkGateKey(check: string): string {
  return IdentifierSchema.parse(`check-${check}`);
}

function reviewGateKey(lens: ReviewLens): string {
  return IdentifierSchema.parse(`review-${lens}`);
}

const COMMIT_GATE = "commit";

function requireCheckIntent(record: CheckRecord, intent: unknown): void {
  const value = z
    .object({
      id: z.string(),
      run: z.string(),
      task: z.string(),
      check: z.string(),
      plan_digest: z.string(),
      input_commit: z.string(),
      task_source_digest: z.string(),
      source_digest: z.string(),
      diff_digest: z.string(),
      argv: z.array(z.string()),
      cwd: z.string(),
      timeout_ms: z.number(),
      image: z.unknown(),
      policy_digest: z.string(),
      sandbox: z.string(),
      binding_digest: z.string(),
    })
    .passthrough()
    .parse(intent);
  if (
    value.id !== record.id ||
    value.run !== record.run ||
    value.task !== record.task ||
    value.check !== record.check ||
    value.plan_digest !== record.plan_digest ||
    value.input_commit !== record.input_commit ||
    value.task_source_digest !== record.task_source_digest ||
    value.source_digest !== record.source_digest ||
    value.diff_digest !== record.diff_digest ||
    canonicalJson(value.argv) !== canonicalJson(record.argv) ||
    value.cwd !== record.cwd ||
    value.timeout_ms !== record.timeout_ms ||
    canonicalJson(value.image) !== canonicalJson(record.image) ||
    value.policy_digest !== record.policy_digest ||
    value.sandbox !== record.sandbox.name ||
    value.binding_digest !== record.intent_digest
  ) {
    throw new OrchestratorError(
      "commit_check_stale",
      `Check '${record.check}' does not match its durable intent`,
    );
  }
}

async function collectChecks(options: {
  readonly store: CommitProjectStore;
  readonly project: Project;
  readonly run: RunState;
  readonly task: PlanTask;
  readonly taskState: TaskRecord;
  readonly policyDirectory: string;
}): Promise<CheckRecord[]> {
  const checks = new CheckStore(options.store.runDirectory(options.run.id));
  const policy = await loadSandboxPolicy(
    "check",
    path.join(options.policyDirectory, "check.yaml"),
  );
  const records: CheckRecord[] = [];
  for (const check of options.task.checks) {
    const definition = options.project.config.checks[check];
    const gate = options.taskState.gates[checkGateKey(check)];
    if (!definition || gate?.status !== "pass" || !gate.digest) {
      throw new OrchestratorError(
        "commit_checks_incomplete",
        `Task '${options.task.id}' has no current passing evidence for Check '${check}'`,
      );
    }
    const record = await checks.findResultByDigest(
      options.task.id,
      check,
      gate.digest,
    );
    if (
      !record ||
      record.verdict !== "pass" ||
      record.run !== options.run.id ||
      record.task !== options.task.id ||
      record.plan_digest !== options.run.plan_digest ||
      record.input_commit !== options.taskState.input_commit ||
      record.task_source_digest !== options.taskState.output_source_digest ||
      record.diff_digest !== options.taskState.diff_digest ||
      record.policy_digest !== policy.digest ||
      canonicalJson({ argv: record.argv, cwd: record.cwd }) !==
        canonicalJson({ argv: definition.argv, cwd: definition.cwd ?? "." })
    ) {
      throw new OrchestratorError(
        "commit_check_stale",
        `Check '${check}' evidence does not match the current Commit source`,
      );
    }
    const intent = await checks.getIntent(options.task.id, check, record.id);
    if (!intent) {
      throw new OrchestratorError(
        "check_store_corrupt",
        `Check '${check}' has no durable intent`,
      );
    }
    requireCheckIntent(record, intent);
    records.push(record);
  }
  return records;
}

function requireReviewIntent(record: ReviewRecord, intent: unknown): void {
  const value = z
    .object({
      id: z.string(),
      run: z.string(),
      task: z.string(),
      lens: z.string(),
      round: z.number(),
      plan_digest: z.string(),
      input_commit: z.string(),
      task_source_digest: z.string(),
      source_digest: z.string(),
      diff_digest: z.string(),
      checks: z.unknown(),
      role_digest: z.string(),
      brief_digest: z.string(),
      model: z.unknown(),
      identity: z.unknown(),
      sandbox: z.unknown(),
      policy_digest: z.string(),
      pi_version: z.string(),
      client_version: z.string(),
      binding_digest: z.string(),
    })
    .passthrough()
    .parse(intent);
  if (
    value.id !== record.id ||
    value.run !== record.run ||
    value.task !== record.task ||
    value.lens !== record.lens ||
    value.round !== record.round ||
    value.plan_digest !== record.plan_digest ||
    value.input_commit !== record.input_commit ||
    value.task_source_digest !== record.task_source_digest ||
    value.source_digest !== record.source_digest ||
    value.diff_digest !== record.diff_digest ||
    canonicalJson(value.checks) !== canonicalJson(record.checks) ||
    value.role_digest !== record.role_digest ||
    value.brief_digest !== record.brief_digest ||
    canonicalJson(value.model) !== canonicalJson(record.model) ||
    canonicalJson(value.identity) !== canonicalJson(record.identity) ||
    canonicalJson(value.sandbox) !== canonicalJson(record.sandbox) ||
    value.policy_digest !== record.policy_digest ||
    value.pi_version !== record.pi_version ||
    value.client_version !== record.client_version ||
    value.binding_digest !== record.intent_digest
  ) {
    throw new OrchestratorError(
      "commit_review_stale",
      `Review '${record.lens}' does not match its durable intent`,
    );
  }
}

async function collectReviews(options: {
  readonly store: CommitProjectStore;
  readonly project: Project;
  readonly local: LocalConfig;
  readonly run: RunState;
  readonly task: PlanTask;
  readonly taskState: TaskRecord;
  readonly checks: readonly CheckRecord[];
  readonly policyDirectory: string;
}): Promise<ReviewRecord[]> {
  const role = options.project.roles.get("reviewer");
  if (
    !role ||
    !roleHasReadSource(role.definition) ||
    role.definition.permissions.write_lease !== "never" ||
    role.definition.lifetime !== "review"
  ) {
    throw new OrchestratorError(
      "invalid_reviewer_role",
      "The reviewer Role must remain read-only and Review-scoped",
    );
  }
  const policy = await loadSandboxPolicy(
    "read",
    path.join(options.policyDirectory, "read.yaml"),
  );
  const checkBindings = options.checks.map((check) => ({
    check: check.check,
    record_digest: check.record_digest,
  }));
  const sourceDigests = new Set(
    options.checks.map((check) => check.source_digest),
  );
  if (sourceDigests.size !== 1) {
    throw new OrchestratorError(
      "commit_check_stale",
      "Required Checks did not evaluate one exact reconstructed source",
    );
  }
  const sourceDigest = options.checks[0]!.source_digest;
  const reviews = new ReviewStore(options.store.runDirectory(options.run.id));
  const records: ReviewRecord[] = [];
  for (const lens of options.task.reviews) {
    const gate = options.taskState.gates[reviewGateKey(lens)];
    if (gate?.status !== "pass" || !gate.digest) {
      throw new OrchestratorError(
        "commit_reviews_incomplete",
        `Task '${options.task.id}' has no current passing '${lens}' Review`,
      );
    }
    const record = await reviews.findResultByDigest(
      options.task.id,
      lens,
      gate.digest,
    );
    const model = resolveReviewModelRoute(
      options.project.config,
      options.local,
      lens,
      role.definition.inference,
    );
    if (
      !record ||
      record.verdict !== "pass" ||
      record.run !== options.run.id ||
      record.task !== options.task.id ||
      record.lens !== lens ||
      record.round !== options.taskState.review_rounds ||
      record.plan_digest !== options.run.plan_digest ||
      record.input_commit !== options.taskState.input_commit ||
      record.task_source_digest !== options.taskState.output_source_digest ||
      record.source_digest !== sourceDigest ||
      record.diff_digest !== options.taskState.diff_digest ||
      canonicalJson(record.checks) !== canonicalJson(checkBindings) ||
      record.role_digest !== role.digest ||
      canonicalJson(record.model) !== canonicalJson(model) ||
      record.policy_digest !== policy.digest ||
      record.pi_version !== PI_RUNTIME_VERSION ||
      record.client_version !== PI_CLIENT_VERSION
    ) {
      throw new OrchestratorError(
        "commit_review_stale",
        `Review '${lens}' evidence does not match the current Commit source`,
      );
    }
    const intent = await reviews.getIntent(options.task.id, lens, record.id);
    if (!intent) {
      throw new OrchestratorError(
        "review_store_corrupt",
        `Review '${lens}' has no durable intent`,
      );
    }
    requireReviewIntent(record, intent);
    const session = options.run.sessions[record.identity.session];
    if (
      !session ||
      canonicalJson(session.identity) !== canonicalJson(record.identity) ||
      canonicalJson(session.sandbox) !== canonicalJson(record.sandbox)
    ) {
      throw new OrchestratorError(
        "commit_review_stale",
        `Review '${lens}' no longer matches its durable Session generation`,
      );
    }
    records.push(record);
  }
  return records;
}

function requireProposalBinding(
  actual: CommitProposal,
  expected: CommitProposal,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new OrchestratorError(
      "commit_stale",
      "Current Commit evidence no longer matches the human-approved proposal",
    );
  }
}

function requireRecordGit(
  record: CommitRecord,
  worktree: CommitWorktreeInspection,
): void {
  if (
    worktree.state !== "committed" ||
    canonicalJson(worktree.git) !== canonicalJson(record.git)
  ) {
    throw new OrchestratorError(
      "commit_result_mismatch",
      `Git state no longer matches Commit record '${record.id}'`,
    );
  }
}

async function boundCommitEvidence(options: {
  readonly commits: CommitStore;
  readonly task: TaskRecord;
}): Promise<{
  readonly intent?: CommitIntent;
  readonly record?: CommitRecord;
}> {
  const gate = options.task.gates[COMMIT_GATE];
  if (!gate) return {};
  if (!gate.digest) {
    throw new OrchestratorError(
      "commit_gate_conflict",
      "Commit Gate has no evidence digest",
    );
  }
  if (gate.status === "pending") {
    const intent = await options.commits.findIntentByDigest(
      options.task.id,
      gate.digest,
    );
    if (!intent) {
      throw new OrchestratorError(
        "commit_store_corrupt",
        "Pending Commit Gate references missing intent evidence",
      );
    }
    const record = await options.commits.getResult(options.task.id, intent.id);
    if (record) requireRecordIntent(record, intent);
    return { intent, ...(record ? { record } : {}) };
  }
  if (gate.status === "pass") {
    const record = await options.commits.findResultByDigest(
      options.task.id,
      gate.digest,
    );
    if (!record) {
      throw new OrchestratorError(
        "commit_store_corrupt",
        "Passing Commit Gate references missing result evidence",
      );
    }
    const intent = await options.commits.getIntent(options.task.id, record.id);
    if (!intent) {
      throw new OrchestratorError(
        "commit_store_corrupt",
        `Commit record '${record.id}' has no durable intent`,
      );
    }
    requireRecordIntent(record, intent);
    return { intent, record };
  }
  throw new OrchestratorError(
    "commit_gate_conflict",
    `Commit Gate is '${gate.status}', not pending or passing`,
  );
}

export async function inspectTaskCommit(
  options: InspectTaskCommitOptions,
): Promise<TaskCommitInspection> {
  const [projectRecord, run, current, currentHead] = await Promise.all([
    options.store.read(),
    options.store.readRun(options.runId),
    currentProjectAndPlan({ project: options.project, plan: options.plan }),
    gitHead(options.project.root),
  ]);
  requireRunBinding({
    run,
    project: current.project,
    plan: current.plan,
    projectRecord,
    currentHead,
  });
  const task = findTask(current.plan, options.taskId);
  const taskState = requireAppliedTask(run, task);
  const sourcePaths = await commitSourcePaths({
    worktree: run.worktree,
    inputCommit: taskState.input_commit!,
    sourcePaths: taskState.patch_application!.source_paths,
    changedPaths: taskState.patch_application!.changed_paths,
  });
  await requireNoCleanFilters({
    worktree: run.worktree,
    paths: sourcePaths,
    source: taskState.input_commit!,
  });
  await requireNoCleanFilters({ worktree: run.worktree, paths: sourcePaths });
  const commits = new CommitStore(options.store.runDirectory(run.id));
  const bound = await boundCommitEvidence({ commits, task: taskState });
  if (
    (!bound.intent && taskState.status !== "reviewing") ||
    (bound.intent && !bound.record && taskState.status !== "reviewing") ||
    (bound.record &&
      taskState.status !== "reviewing" &&
      taskState.status !== "accepted")
  ) {
    throw new OrchestratorError(
      "task_not_committable",
      `Task '${task.id}' cannot be committed while ${taskState.status}`,
    );
  }
  const subject = CommitSubjectSchema.parse(
    bound.intent?.proposal.subject ?? options.subject ?? task.title,
  );
  const author = GitIdentitySchema.parse(
    bound.intent?.proposal.author ?? options.author,
  );
  const artifacts = new ArtifactStore(options.store.runDirectory(run.id));
  const patch = await loadPreparedPatch({
    store: artifacts,
    projectRoot: current.project.root,
    application: taskState.patch_application!,
    ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
  });
  validatePatchPaths({
    patch: patch.value,
    task,
    protectedPatterns: current.project.config.protected,
  });
  const policyDirectory = path.resolve(
    options.policyDirectory ?? bundledPiPolicyDirectory(),
  );
  const checks = await collectChecks({
    store: options.store,
    project: current.project,
    run,
    task,
    taskState,
    policyDirectory,
  });
  const reviews = await collectReviews({
    store: options.store,
    project: current.project,
    local: options.local,
    run,
    task,
    taskState,
    checks,
    policyDirectory,
  });
  const proposal = createProposal({
    version: 1,
    run: run.id,
    task: task.id,
    title: task.title,
    plan: {
      id: current.plan.id,
      revision: current.plan.revision,
      digest: current.plan.digest,
    },
    branch: run.branch,
    input_commit: taskState.input_commit!,
    task_source_digest: taskState.output_source_digest!,
    diff_digest: taskState.diff_digest!,
    patch_artifact: {
      id: taskState.patch_application!.artifact_id,
      content_digest: taskState.patch_application!.artifact_content_digest,
    },
    changes: patch.value.bundle.changes.map((change) => ({
      path: change.path,
      status: change.status,
    })),
    checks: checks.map((check) => ({
      check: check.check,
      record_digest: check.record_digest,
    })),
    reviews: reviews.map((review) => ({
      lens: review.lens,
      record_digest: review.record_digest,
    })),
    subject,
    author,
  });
  let intent = bound.intent;
  let record = bound.record;
  if (!intent) {
    intent = await commits.findIntentByProposalDigest(
      task.id,
      proposal.proposal_digest,
    );
    if (intent) {
      record = await commits.getResult(task.id, intent.id);
      if (record) requireRecordIntent(record, intent);
    }
  }
  if (intent) requireProposalBinding(proposal, intent.proposal);
  const worktrees = options.worktrees ?? new GitCommitWorktree();
  const worktree = await worktrees.inspect({
    repository: current.project.root,
    worktree: run.worktree,
    branch: run.branch,
    inputCommit: proposal.input_commit,
    diffDigest: proposal.diff_digest as Digest,
    subject: proposal.subject,
    author: proposal.author,
    patch: patch.value,
  });
  if (!intent && worktree.state === "committed") {
    throw new OrchestratorError(
      "commit_authorization_missing",
      "A matching Git commit exists without a durable human Commit intent",
    );
  }
  if (record) {
    requireRecordGit(record, worktree);
    if (taskState.gates[COMMIT_GATE]?.status === "pass") {
      if (taskState.status !== "accepted") {
        throw new OrchestratorError(
          "commit_gate_conflict",
          "Passing Commit evidence did not mark the Task accepted",
        );
      }
      return {
        state: "committed",
        proposal,
        worktree,
        intent: intent!,
        record,
      };
    }
  }
  return {
    state: intent ? "authorized" : "ready",
    proposal,
    worktree,
    ...(intent ? { intent } : {}),
    ...(record ? { record } : {}),
  };
}

function assertProposalState(
  current: TaskRecord,
  task: PlanTask,
  proposal: CommitProposal,
): void {
  if (
    current.input_commit !== proposal.input_commit ||
    current.output_source_digest !== proposal.task_source_digest ||
    current.diff_digest !== proposal.diff_digest ||
    current.patch_application?.state !== "applied" ||
    current.patch_application.artifact_id !== proposal.patch_artifact.id ||
    current.patch_application.artifact_content_digest !==
      proposal.patch_artifact.content_digest
  ) {
    throw new OrchestratorError(
      "commit_stale",
      `Task '${task.id}' source or Patch changed after human confirmation`,
    );
  }
  for (const check of proposal.checks) {
    const gate = current.gates[checkGateKey(check.check)];
    if (gate?.status !== "pass" || gate.digest !== check.record_digest) {
      throw new OrchestratorError(
        "commit_check_stale",
        `Check '${check.check}' changed after human confirmation`,
      );
    }
  }
  for (const review of proposal.reviews) {
    const gate = current.gates[reviewGateKey(review.lens)];
    if (gate?.status !== "pass" || gate.digest !== review.record_digest) {
      throw new OrchestratorError(
        "commit_review_stale",
        `Review '${review.lens}' changed after human confirmation`,
      );
    }
  }
}

async function recordPendingGate(options: {
  readonly store: CommitProjectStore;
  readonly runId: string;
  readonly task: PlanTask;
  readonly intent: CommitIntent;
  readonly timestamp: string;
}): Promise<void> {
  await options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertProposalState(current, options.task, options.intent.proposal);
    if (current.status !== "reviewing") {
      throw new OrchestratorError(
        "task_not_committable",
        `Task '${options.task.id}' must remain reviewing before Commit`,
      );
    }
    const existing = current.gates[COMMIT_GATE];
    if (existing) {
      if (
        existing.status !== "pending" ||
        existing.digest !== options.intent.binding_digest
      ) {
        throw new OrchestratorError(
          "commit_gate_conflict",
          "Commit Gate already contains other evidence",
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
            [COMMIT_GATE]: {
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

function taskTerminal(task: TaskRecord): boolean {
  return ["accepted", "skipped", "cancelled"].includes(task.status);
}

async function finalizeCommit(options: {
  readonly store: CommitProjectStore;
  readonly runId: string;
  readonly plan: LoadedPlan;
  readonly task: PlanTask;
  readonly intent: CommitIntent;
  readonly record: CommitRecord;
  readonly timestamp: string;
}): Promise<RunState> {
  return options.store.updateRun(options.runId, (run) => {
    const current = requireAppliedTask(run, options.task);
    assertProposalState(current, options.task, options.intent.proposal);
    const existing = current.gates[COMMIT_GATE];
    if (
      existing?.status === "pass" &&
      existing.digest === options.record.record_digest &&
      current.status === "accepted"
    ) {
      return run;
    }
    if (
      existing?.status !== "pending" ||
      existing.digest !== options.intent.binding_digest
    ) {
      throw new OrchestratorError(
        "commit_gate_conflict",
        "Commit Gate no longer matches its human-approved intent",
      );
    }
    if (current.status !== "reviewing") {
      throw new OrchestratorError(
        "task_not_committable",
        `Task '${options.task.id}' left Review before Commit completion`,
      );
    }
    const tasks: Record<string, TaskRecord> = {
      ...run.tasks,
      [options.task.id]: {
        ...current,
        status: "accepted",
        gates: {
          ...current.gates,
          [COMMIT_GATE]: {
            status: "pass",
            digest: options.record.record_digest,
            updated_at: options.timestamp,
          },
        },
      },
    };
    for (const planned of options.plan.tasks) {
      if (planned.id === options.task.id) continue;
      const candidate = tasks[planned.id]!;
      if (candidate.status === "ready") {
        tasks[planned.id] = {
          ...candidate,
          input_commit: options.record.git.commit,
        };
        continue;
      }
      if (
        candidate.status === "pending" &&
        planned.depends.every(
          (dependency) => tasks[dependency]?.status === "accepted",
        )
      ) {
        tasks[planned.id] = {
          ...candidate,
          status: "ready",
          input_commit: options.record.git.commit,
        };
      }
    }
    return {
      ...run,
      status: Object.values(tasks).every(taskTerminal) ? "complete" : "active",
      tasks,
    };
  });
}

export async function commitTask(
  options: CommitTaskOptions,
): Promise<CommitTaskResult> {
  const now = options.now ?? (() => new Date());
  let inspection = await inspectTaskCommit(options);
  if (
    inspection.state === "committed" &&
    inspection.intent &&
    inspection.record
  ) {
    const run = await options.store.updateRun(
      inspection.proposal.run,
      (current) => current,
    );
    return {
      proposal: inspection.proposal,
      intent: inspection.intent,
      record: inspection.record,
      task: run.tasks[inspection.proposal.task]!,
      run,
      created: false,
      recovered: false,
      reused: true,
    };
  }

  const task = findTask(options.plan, inspection.proposal.task);
  const commits = new CommitStore(
    options.store.runDirectory(inspection.proposal.run),
  );
  let intent = inspection.intent;
  if (!intent) {
    if (!options.authorization) {
      throw new OrchestratorError(
        "commit_authorization_required",
        "A fresh human authorization is required for this Commit proposal",
      );
    }
    if (
      options.authorization.proposalDigest !==
      inspection.proposal.proposal_digest
    ) {
      throw new OrchestratorError(
        "commit_authorization_stale",
        "Human authorization does not match the current Commit proposal",
      );
    }
    intent = await commits.prepare(
      createIntent({
        proposal: inspection.proposal,
        approvedBy: options.authorization.approvedBy,
        approvedAt: options.authorization.approvedAt ?? now(),
        preparedAt: now(),
      }),
    );
  }
  await recordPendingGate({
    store: options.store,
    runId: inspection.proposal.run,
    task,
    intent,
    timestamp: now().toISOString(),
  });
  inspection = await inspectTaskCommit(options);
  if (
    inspection.state !== "authorized" ||
    inspection.intent?.binding_digest !== intent.binding_digest
  ) {
    throw new OrchestratorError(
      "commit_stale",
      "Commit evidence changed while recording human authorization",
    );
  }

  let record = inspection.record;
  let gitResult: CommitWorktreeResult | undefined;
  if (!record) {
    const artifacts = new ArtifactStore(
      options.store.runDirectory(inspection.proposal.run),
    );
    const run = await options.store.readRun(inspection.proposal.run);
    const taskState = requireAppliedTask(run, task);
    const patch = await loadPreparedPatch({
      store: artifacts,
      projectRoot: options.project.root,
      application: taskState.patch_application!,
      ...(options.temporaryRoot
        ? { temporaryRoot: options.temporaryRoot }
        : {}),
    });
    const worktrees = options.worktrees ?? new GitCommitWorktree();
    gitResult = await worktrees.commit({
      repository: options.project.root,
      worktree: run.worktree,
      branch: run.branch,
      inputCommit: inspection.proposal.input_commit,
      diffDigest: inspection.proposal.diff_digest as Digest,
      subject: inspection.proposal.subject,
      author: inspection.proposal.author,
      patch: patch.value,
    });
    const afterGit = await inspectTaskCommit(options);
    if (
      afterGit.state !== "authorized" ||
      afterGit.intent?.binding_digest !== intent.binding_digest ||
      afterGit.worktree.state !== "committed" ||
      canonicalJson(afterGit.worktree.git) !== canonicalJson(gitResult.git)
    ) {
      throw new OrchestratorError(
        "commit_stale",
        "Commit evidence changed after Git created the approved Commit",
      );
    }
    inspection = afterGit;
    record = createRecord({ intent, git: gitResult.git, recordedAt: now() });
    record = await commits.putResult(intent, record);
  }
  requireRecordIntent(record, intent);
  requireRecordGit(record, inspection.worktree);
  const run = await finalizeCommit({
    store: options.store,
    runId: inspection.proposal.run,
    plan: options.plan,
    task,
    intent,
    record,
    timestamp: now().toISOString(),
  });
  return {
    proposal: inspection.proposal,
    intent,
    record,
    task: run.tasks[task.id]!,
    run,
    created: gitResult?.created ?? false,
    recovered: gitResult ? gitResult.recovered : true,
    reused: false,
  };
}
