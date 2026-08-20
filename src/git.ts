import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { RunWorkspacePathSchema } from "./workspace.js";

export const GitCommitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine(path.isAbsolute, "must be absolute");

const GitNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\0"), "must not contain NUL");

export const RunWorktreeIntentSchema = z
  .object({
    project_id: IdentifierSchema,
    run_id: IdentifierSchema,
    repository: AbsolutePathSchema,
    common_dir: AbsolutePathSchema,
    worktree: AbsolutePathSchema,
    branch: GitNameSchema,
    base_commit: GitCommitSchema,
  })
  .strict();
export type RunWorktreeIntent = z.infer<typeof RunWorktreeIntentSchema>;

export const RunWorktreeStatusSchema = z.enum([
  "missing",
  "branch_only",
  "ready",
  "dirty",
  "path_missing",
  "path_conflict",
  "branch_conflict",
  "head_mismatch",
  "branch_mismatch",
  "repository_mismatch",
]);
export type RunWorktreeStatus = z.infer<typeof RunWorktreeStatusSchema>;

export interface RunWorktreeInspection {
  readonly intent: RunWorktreeIntent;
  readonly status: RunWorktreeStatus;
  readonly actualHead?: string;
  readonly actualBranch?: string;
  readonly conflictingPath?: string;
}

export interface RunWorktreeResult {
  readonly intent: RunWorktreeIntent;
  readonly created: boolean;
  readonly recovered: boolean;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GitCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitCommandResult>;

export type GitStatusRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<Uint8Array>;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitStatusCodeSchema = z.enum([" ", "M", "T", "A", "D", "U", "?"]);

export const WorkspaceGitChangeSchema = z
  .object({
    path: RunWorkspacePathSchema,
    index_status: GitStatusCodeSchema,
    worktree_status: GitStatusCodeSchema,
  })
  .strict()
  .superRefine((change, context) => {
    const untracked =
      change.index_status === "?" && change.worktree_status === "?";
    if (
      !untracked &&
      (change.index_status === "?" || change.worktree_status === "?")
    ) {
      context.addIssue({
        code: "custom",
        message: "question-mark status is valid only for an untracked path",
      });
    }
    if (change.index_status === " " && change.worktree_status === " ") {
      context.addIssue({
        code: "custom",
        message: "an unchanged path must not appear in Git status",
      });
    }
  });
export type WorkspaceGitChange = z.infer<typeof WorkspaceGitChangeSchema>;

const WorkspaceDiffRecordSchema = z
  .object({
    version: z.literal(2),
    input_commit: GitCommitSchema,
    manifest_digest: DigestSchema,
    changes: z.array(WorkspaceGitChangeSchema).max(1_000_000),
  })
  .strict()
  .superRefine((record, context) => {
    for (let index = 1; index < record.changes.length; index += 1) {
      if (
        Buffer.compare(
          Buffer.from(record.changes[index - 1]!.path, "utf8"),
          Buffer.from(record.changes[index]!.path, "utf8"),
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

export const WorkspaceDiffSchema = WorkspaceDiffRecordSchema.extend({
  digest: DigestSchema,
}).strict();
export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;

interface GitFailure extends Error {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export const defaultGitCommandRunner: GitCommandRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C.UTF-8",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const failure = error as GitFailure;
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

const defaultGitStatusRunner: GitStatusRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 64 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      reject(
        new OrchestratorError(
          "git_unavailable",
          `Cannot execute scrubbed git ${args.join(" ")}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      if (exceeded) {
        reject(
          new OrchestratorError(
            "git_output_too_large",
            "Scrubbed Git status output exceeded 64 MiB",
          ),
        );
        return;
      }
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new OrchestratorError(
            "git_failed",
            `Scrubbed git ${args.join(" ")} failed with exit ${code ?? "unknown"}${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });

function splitNul(source: Uint8Array): readonly Buffer[] {
  const bytes = Buffer.from(source);
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    throw new OrchestratorError(
      "invalid_git_output",
      "Git status did not terminate its final record with NUL",
    );
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) {
      throw new OrchestratorError(
        "invalid_git_output",
        "Git status contained an empty record",
      );
    }
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}

export function parseWorkspaceGitStatus(
  source: Uint8Array,
): readonly WorkspaceGitChange[] {
  const changes = splitNul(source).map((record) => {
    if (record.byteLength < 4 || record[2] !== 0x20) {
      throw new OrchestratorError(
        "invalid_git_output",
        "Git status returned a malformed porcelain record",
      );
    }
    const indexStatus = String.fromCharCode(record[0]!);
    const worktreeStatus = String.fromCharCode(record[1]!);
    if (
      [indexStatus, worktreeStatus].some(
        (status) => status === "R" || status === "C",
      )
    ) {
      throw new OrchestratorError(
        "invalid_git_output",
        "Git status reported a rename despite --no-renames",
      );
    }
    let entryPath: string;
    try {
      entryPath = new TextDecoder("utf-8", { fatal: true }).decode(
        record.subarray(3),
      );
    } catch (error) {
      throw new OrchestratorError(
        "invalid_git_output",
        "Git status paths must be valid UTF-8",
        { cause: error },
      );
    }
    const parsed = WorkspaceGitChangeSchema.safeParse({
      path: entryPath,
      index_status: indexStatus,
      worktree_status: worktreeStatus,
    });
    if (!parsed.success) {
      throw new OrchestratorError(
        "invalid_git_output",
        `Git status record does not match the Workspace contract: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
  changes.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  );
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index - 1]!.path === changes[index]!.path) {
      throw new OrchestratorError(
        "invalid_git_output",
        `Git status repeated path '${changes[index]!.path}'`,
      );
    }
  }
  return Object.freeze(changes.map((change) => Object.freeze({ ...change })));
}

function workspaceDiffDigest(
  record: z.infer<typeof WorkspaceDiffRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/workspace-diff/v2", [
    ["input-commit", record.input_commit],
    ["manifest-digest", record.manifest_digest],
    ["changes", canonicalJson(record.changes)],
  ]);
}

export function validateWorkspaceDiff(value: unknown): WorkspaceDiff {
  const parsed = WorkspaceDiffSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_workspace_diff",
      `Workspace Git diff does not match the version-two contract: ${parsed.error.message}`,
    );
  }
  const { digest, ...record } = parsed.data;
  if (workspaceDiffDigest(record) !== digest) {
    throw new OrchestratorError(
      "invalid_workspace_diff",
      "Workspace Git diff digest does not match its record",
    );
  }
  return Object.freeze({
    ...parsed.data,
    changes: Object.freeze(
      parsed.data.changes.map((change) => Object.freeze({ ...change })),
    ),
  }) as WorkspaceDiff;
}

export async function collectWorkspaceGitDiff(options: {
  readonly root: string;
  readonly inputCommit: string;
  readonly manifestDigest: Digest;
  readonly runner?: GitStatusRunner;
}): Promise<WorkspaceDiff> {
  const root = path.resolve(options.root);
  const inputCommit = GitCommitSchema.parse(options.inputCommit);
  const manifestDigest = DigestSchema.parse(options.manifestDigest) as Digest;
  const runner = options.runner ?? defaultGitStatusRunner;
  const prefix = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
  ] as const;
  const head = Buffer.from(
    await runner([...prefix, "rev-parse", "--verify", "HEAD"], root),
  )
    .toString("ascii")
    .trim();
  if (head !== inputCommit) {
    throw new OrchestratorError(
      "workspace_head_mismatch",
      `Workspace HEAD '${head}' does not match input commit '${inputCommit}'`,
    );
  }
  const changes = parseWorkspaceGitStatus(
    await runner(
      [
        ...prefix,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=none",
      ],
      root,
    ),
  );
  const record = WorkspaceDiffRecordSchema.parse({
    version: 2,
    input_commit: inputCommit,
    manifest_digest: manifestDigest,
    changes,
  });
  return validateWorkspaceDiff({
    ...record,
    digest: workspaceDiffDigest(record),
  });
}

interface PorcelainWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

function failCommand(
  args: readonly string[],
  result: GitCommandResult,
): OrchestratorError {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  return new OrchestratorError(
    "git_failed",
    `git ${args.join(" ")} failed with exit ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : ""}`,
  );
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function pathState(filePath: string) {
  return lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function prospectiveRealpath(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  const missing: string[] = [];
  while (!(await pathState(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new OrchestratorError(
        "invalid_worktree_path",
        `Cannot resolve an existing ancestor of '${filePath}'`,
      );
    }
    missing.push(path.basename(current));
    current = parent;
  }
  return path.join(await realpath(current), ...missing.reverse());
}

function parseBooleanField(
  seen: Set<string>,
  field: string,
  value: string,
): boolean {
  if (value !== field) return false;
  if (seen.has(field)) {
    throw new OrchestratorError(
      "invalid_git_output",
      `git worktree list repeated '${field}'`,
    );
  }
  seen.add(field);
  return true;
}

export function parseWorktreeList(
  source: string,
): readonly PorcelainWorktree[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\0\0")) {
    throw new OrchestratorError(
      "invalid_git_output",
      "git worktree list did not end with an empty record",
    );
  }

  return source
    .slice(0, -2)
    .split("\0\0")
    .map((record) => {
      const fields = record.split("\0");
      const worktree = fields.shift();
      if (!worktree?.startsWith("worktree ")) {
        throw new OrchestratorError(
          "invalid_git_output",
          "git worktree list record does not start with a worktree path",
        );
      }
      const worktreePath = worktree.slice("worktree ".length);
      if (!path.isAbsolute(worktreePath)) {
        throw new OrchestratorError(
          "invalid_git_output",
          "git worktree list returned a non-absolute path",
        );
      }

      let head: string | undefined;
      let branch: string | undefined;
      const seen = new Set<string>();
      let bare = false;
      let detached = false;
      let locked = false;
      let prunable = false;
      for (const field of fields) {
        if (field.startsWith("HEAD ")) {
          if (head !== undefined) {
            throw new OrchestratorError(
              "invalid_git_output",
              "git worktree list repeated HEAD",
            );
          }
          head = GitCommitSchema.parse(field.slice("HEAD ".length));
          continue;
        }
        if (field.startsWith("branch ")) {
          if (branch !== undefined) {
            throw new OrchestratorError(
              "invalid_git_output",
              "git worktree list repeated branch",
            );
          }
          branch = field.slice("branch ".length);
          if (!branch.startsWith("refs/heads/") || branch.length === 11) {
            throw new OrchestratorError(
              "invalid_git_output",
              "git worktree list returned an invalid branch ref",
            );
          }
          continue;
        }
        if (parseBooleanField(seen, "bare", field)) {
          bare = true;
          continue;
        }
        if (parseBooleanField(seen, "detached", field)) {
          detached = true;
          continue;
        }
        if (field === "locked" || field.startsWith("locked ")) {
          if (seen.has("locked")) {
            throw new OrchestratorError(
              "invalid_git_output",
              "git worktree list repeated locked",
            );
          }
          seen.add("locked");
          locked = true;
          continue;
        }
        if (field === "prunable" || field.startsWith("prunable ")) {
          if (seen.has("prunable")) {
            throw new OrchestratorError(
              "invalid_git_output",
              "git worktree list repeated prunable",
            );
          }
          seen.add("prunable");
          prunable = true;
          continue;
        }
        throw new OrchestratorError(
          "invalid_git_output",
          `git worktree list returned unknown field '${field}'`,
        );
      }
      if (!head) {
        throw new OrchestratorError(
          "invalid_git_output",
          "git worktree list record is missing HEAD",
        );
      }
      return {
        path: path.resolve(worktreePath),
        head,
        ...(branch ? { branch } : {}),
        bare,
        detached,
        locked,
        prunable,
      };
    });
}

export class GitWorktreeManager {
  private readonly repository: string;

  constructor(
    repository: string,
    private readonly runner: GitCommandRunner = defaultGitCommandRunner,
  ) {
    this.repository = path.resolve(repository);
  }

  private command(
    args: readonly string[],
    cwd = this.repository,
  ): Promise<GitCommandResult> {
    return this.runner(args, cwd);
  }

  private async requireCommand(
    args: readonly string[],
    cwd = this.repository,
  ): Promise<string> {
    const result = await this.command(args, cwd);
    if (result.exitCode !== 0) throw failCommand(args, result);
    return result.stdout.trim();
  }

  private async list(): Promise<readonly PorcelainWorktree[]> {
    return parseWorktreeList(
      await this.requireCommand(["worktree", "list", "--porcelain", "-z"]),
    );
  }

  async prepare(input: {
    readonly projectId: string;
    readonly runId: string;
    readonly baseCommit: string;
    readonly branchPrefix: string;
    readonly worktreeRoot: string;
  }): Promise<RunWorktreeIntent> {
    const projectId = IdentifierSchema.parse(input.projectId);
    const runId = IdentifierSchema.parse(input.runId);
    const requestedBase = GitCommitSchema.parse(input.baseCommit);
    const branchPrefix = GitNameSchema.parse(input.branchPrefix);
    const requestedWorktreeRoot = z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), "must not contain NUL")
      .parse(input.worktreeRoot);
    const repository = await realpath(this.repository).catch(
      (error: unknown) => {
        throw new OrchestratorError(
          "git_repository_missing",
          `Project repository '${this.repository}' is not accessible`,
          { cause: error },
        );
      },
    );
    const topLevel = path.resolve(
      await this.requireCommand(["rev-parse", "--show-toplevel"]),
    );
    if (repository !== (await realpath(topLevel))) {
      throw new OrchestratorError(
        "git_repository_mismatch",
        `Project root '${repository}' is not the Git top-level '${topLevel}'`,
      );
    }
    const resolvedBase = await this.requireCommand([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${requestedBase}^{commit}`,
    ]);
    if (resolvedBase !== requestedBase) {
      throw new OrchestratorError(
        "git_commit_mismatch",
        `Base commit '${requestedBase}' resolved to '${resolvedBase}'`,
      );
    }

    const commonValue = await this.requireCommand([
      "rev-parse",
      "--git-common-dir",
    ]);
    const commonDir = await realpath(path.resolve(repository, commonValue));
    const branch = `${branchPrefix}${runId}`;
    const branchCheck = await this.command([
      "check-ref-format",
      "--branch",
      branch,
    ]);
    if (branchCheck.exitCode !== 0) {
      throw new OrchestratorError(
        "invalid_run_branch",
        `Run branch '${branch}' is not a valid Git branch name`,
      );
    }

    const configuredRoot = path.resolve(requestedWorktreeRoot);
    const prospectiveRoot = await prospectiveRealpath(configuredRoot);
    const prospectiveWorktree = path.join(prospectiveRoot, projectId, runId);
    if (
      inside(repository, prospectiveWorktree) ||
      inside(prospectiveWorktree, repository)
    ) {
      throw new OrchestratorError(
        "invalid_worktree_path",
        `Run worktree '${prospectiveWorktree}' must be isolated from Project checkout '${repository}'`,
      );
    }
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const worktree = path.join(root, projectId, runId);
    if (inside(repository, worktree) || inside(worktree, repository)) {
      throw new OrchestratorError(
        "invalid_worktree_path",
        `Run worktree '${worktree}' must be isolated from Project checkout '${repository}'`,
      );
    }

    return RunWorktreeIntentSchema.parse({
      project_id: projectId,
      run_id: runId,
      repository,
      common_dir: commonDir,
      worktree,
      branch,
      base_commit: resolvedBase,
    });
  }

  async inspect(intent: RunWorktreeIntent): Promise<RunWorktreeInspection> {
    const expected = RunWorktreeIntentSchema.parse(intent);
    const repository = await realpath(this.repository).catch(() => undefined);
    if (repository !== expected.repository) {
      return { intent: expected, status: "repository_mismatch" };
    }
    const commonValue = await this.requireCommand([
      "rev-parse",
      "--git-common-dir",
    ]);
    const commonDir = await realpath(path.resolve(repository, commonValue));
    if (commonDir !== expected.common_dir) {
      return { intent: expected, status: "repository_mismatch" };
    }
    const entries = await this.list();
    const branchRef = `refs/heads/${expected.branch}`;
    const atPath = entries.find(
      (entry) => path.resolve(entry.path) === expected.worktree,
    );
    const onBranch = entries.find((entry) => entry.branch === branchRef);

    if (!atPath) {
      if (onBranch) {
        return {
          intent: expected,
          status: "branch_conflict",
          actualHead: onBranch.head,
          ...(onBranch.branch ? { actualBranch: onBranch.branch } : {}),
          conflictingPath: onBranch.path,
        };
      }
      const existingPath = await pathState(expected.worktree);
      if (existingPath) {
        return { intent: expected, status: "path_conflict" };
      }

      const branchResult = await this.command([
        "show-ref",
        "--verify",
        "--quiet",
        branchRef,
      ]);
      if (branchResult.exitCode === 1) {
        return { intent: expected, status: "missing" };
      }
      if (branchResult.exitCode !== 0) {
        throw failCommand(
          ["show-ref", "--verify", "--quiet", branchRef],
          branchResult,
        );
      }
      const head = await this.requireCommand([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${branchRef}^{commit}`,
      ]);
      return head === expected.base_commit
        ? { intent: expected, status: "branch_only", actualHead: head }
        : {
            intent: expected,
            status: "branch_conflict",
            actualHead: head,
          };
    }

    const existingPath = await pathState(expected.worktree);
    if (!existingPath) {
      return { intent: expected, status: "path_missing" };
    }
    if (!existingPath.isDirectory() || existingPath.isSymbolicLink()) {
      return { intent: expected, status: "path_conflict" };
    }
    if (atPath.bare || atPath.detached || atPath.prunable) {
      return {
        intent: expected,
        status: "branch_mismatch",
        actualHead: atPath.head,
        ...(atPath.branch ? { actualBranch: atPath.branch } : {}),
      };
    }
    if (atPath.branch !== branchRef) {
      return {
        intent: expected,
        status: "branch_mismatch",
        actualHead: atPath.head,
        ...(atPath.branch ? { actualBranch: atPath.branch } : {}),
      };
    }
    if (atPath.head !== expected.base_commit) {
      return {
        intent: expected,
        status: "head_mismatch",
        actualHead: atPath.head,
        actualBranch: atPath.branch,
      };
    }

    const worktreeCommonValue = await this.requireCommand(
      ["rev-parse", "--git-common-dir"],
      expected.worktree,
    );
    const worktreeCommonDir = await realpath(
      path.resolve(expected.worktree, worktreeCommonValue),
    );
    if (worktreeCommonDir !== expected.common_dir) {
      return { intent: expected, status: "repository_mismatch" };
    }
    const [head, branch, dirty] = await Promise.all([
      this.requireCommand(["rev-parse", "HEAD"], expected.worktree),
      this.requireCommand(
        ["symbolic-ref", "--quiet", "HEAD"],
        expected.worktree,
      ),
      this.requireCommand(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        expected.worktree,
      ),
    ]);
    if (head !== expected.base_commit) {
      return {
        intent: expected,
        status: "head_mismatch",
        actualHead: head,
        actualBranch: branch,
      };
    }
    if (branch !== branchRef) {
      return {
        intent: expected,
        status: "branch_mismatch",
        actualHead: head,
        actualBranch: branch,
      };
    }
    if (dirty.length > 0) {
      return {
        intent: expected,
        status: "dirty",
        actualHead: head,
        actualBranch: branch,
      };
    }
    return {
      intent: expected,
      status: "ready",
      actualHead: head,
      actualBranch: branch,
    };
  }

  async preflight(intent: RunWorktreeIntent): Promise<RunWorktreeInspection> {
    const inspection = await this.inspect(intent);
    if (["missing", "branch_only", "ready"].includes(inspection.status)) {
      return inspection;
    }
    if (inspection.status === "dirty") {
      throw new OrchestratorError(
        "worktree_dirty",
        `Run worktree '${inspection.intent.worktree}' contains uncommitted changes`,
      );
    }
    throw new OrchestratorError(
      `worktree_${inspection.status}`,
      `Run worktree '${inspection.intent.worktree}' is ${inspection.status.replaceAll("_", " ")}`,
    );
  }

  async ensure(intent: RunWorktreeIntent): Promise<RunWorktreeResult> {
    const expected = RunWorktreeIntentSchema.parse(intent);
    const initial = await this.preflight(expected);
    if (initial.status === "ready") {
      return { intent: expected, created: false, recovered: true };
    }

    await mkdir(path.dirname(expected.worktree), { recursive: true });
    const args =
      initial.status === "branch_only"
        ? [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            expected.worktree,
            expected.branch,
          ]
        : [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "--no-track",
            "-b",
            expected.branch,
            expected.worktree,
            expected.base_commit,
          ];
    const result = await this.command(args);
    const observed = await this.inspect(expected);
    if (observed.status === "ready") {
      return {
        intent: expected,
        created: result.exitCode === 0,
        recovered: result.exitCode !== 0 || initial.status === "branch_only",
      };
    }
    if (result.exitCode !== 0) throw failCommand(args, result);
    if (observed.status === "dirty") {
      throw new OrchestratorError(
        "worktree_dirty",
        `New Run worktree '${expected.worktree}' is not clean`,
      );
    }
    throw new OrchestratorError(
      `worktree_${observed.status}`,
      `New Run worktree '${expected.worktree}' is ${observed.status.replaceAll("_", " ")}`,
    );
  }
}
