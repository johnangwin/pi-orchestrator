import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { ApprovalSchema, type Approval } from "./approval.js";
import { CmuxRunStateSchema } from "./cmux.js";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import { AgentRecordSchema, SessionRecordSchema } from "./session.js";
import { GateStatusSchema, RunStatusSchema, TaskStatusSchema } from "./task.js";
import { RunWorkspaceStateSchema } from "./candidate.js";

export interface AtomicWriteOptions {
  readonly beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await options.beforeRename?.(temporaryPath);
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export const GateRecordSchema = z
  .object({
    status: GateStatusSchema,
    digest: z.string().optional(),
    rationale: z.string().optional(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const SourcePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine(
    (value) => path.posix.normalize(value) === value,
    "must be normalized",
  )
  .refine(
    (value) =>
      value !== ".." &&
      !value.startsWith("../") &&
      !value.split("/").includes(".git"),
    "must remain inside the Project and exclude Git metadata",
  );
const ChangedPathSchema = SourcePathSchema.refine(
  (value) => value !== ".",
  "must identify a workspace entry",
);

export const PatchApplicationSchema = z
  .object({
    artifact_id: IdentifierSchema.max(128),
    artifact_content_digest: DigestSchema,
    agent: IdentifierSchema,
    session: IdentifierSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sandbox_id: z.string().uuid(),
    source_commit: GitCommitSchema,
    source_paths: z.array(SourcePathSchema).min(1),
    source_digest: DigestSchema,
    result_source_digest: DigestSchema,
    sandbox_diff_digest: DigestSchema,
    changed_paths: z.array(ChangedPathSchema).min(1),
    state: z.enum(["prepared", "applied"]),
    host_diff_digest: DigestSchema.optional(),
    prepared_at: z.string().datetime({ offset: true }),
    applied_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((application, context) => {
    if (
      new Set(application.source_paths).size !== application.source_paths.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_paths"],
        message: "must contain unique paths",
      });
    }
    const sortedSourcePaths = [...application.source_paths].sort();
    if (
      sortedSourcePaths.some(
        (entry, index) => entry !== application.source_paths[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_paths"],
        message: "must be sorted",
      });
    }
    if (
      new Set(application.changed_paths).size !==
      application.changed_paths.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["changed_paths"],
        message: "must contain unique paths",
      });
    }
    const sorted = [...application.changed_paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    if (
      sorted.some((entry, index) => entry !== application.changed_paths[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["changed_paths"],
        message: "must be sorted by UTF-8 byte order",
      });
    }
    const hasAppliedFields =
      application.host_diff_digest !== undefined &&
      application.applied_at !== undefined;
    if (application.state === "applied" && !hasAppliedFields) {
      context.addIssue({
        code: "custom",
        message: "an applied Patch requires its host digest and timestamp",
      });
    }
    if (
      application.state === "prepared" &&
      (application.host_diff_digest !== undefined ||
        application.applied_at !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "a prepared Patch cannot be partially applied",
      });
    }
  });
export type PatchApplication = z.infer<typeof PatchApplicationSchema>;

export const TaskRecordSchema = z
  .object({
    id: IdentifierSchema,
    status: TaskStatusSchema,
    implementation_attempts: z.number().int().nonnegative(),
    review_rounds: z.number().int().nonnegative(),
    input_commit: z.string().optional(),
    input_source_digest: DigestSchema.optional(),
    output_source_digest: DigestSchema.optional(),
    diff_digest: DigestSchema.optional(),
    patch_application: PatchApplicationSchema.optional(),
    gates: z.record(IdentifierSchema, GateRecordSchema),
  })
  .strict()
  .superRefine((task, context) => {
    const application = task.patch_application;
    if (!application) return;
    if (task.input_source_digest !== application.source_digest) {
      context.addIssue({
        code: "custom",
        path: ["input_source_digest"],
        message: "must equal the prepared Patch source digest",
      });
    }
    if (task.output_source_digest !== application.result_source_digest) {
      context.addIssue({
        code: "custom",
        path: ["output_source_digest"],
        message: "must equal the prepared Patch result digest",
      });
    }
    if (application.state === "prepared" && task.diff_digest !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["diff_digest"],
        message: "must remain empty until the host applies the Patch",
      });
    }
    if (
      application.state === "applied" &&
      task.diff_digest !== application.host_diff_digest
    ) {
      context.addIssue({
        code: "custom",
        path: ["diff_digest"],
        message: "must equal the applied host diff digest",
      });
    }
  });
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const RunStateSchema = z
  .object({
    version: z.literal(2),
    id: IdentifierSchema,
    project_id: IdentifierSchema,
    plan_id: IdentifierSchema,
    plan_revision: z.number().int().positive(),
    plan_digest: z.string(),
    permission_policy_digest: DigestSchema,
    routing_policy_digest: DigestSchema,
    base_commit: z.string().min(1),
    branch: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), {
        message: "must not contain NUL",
      }),
    worktree: z.string().refine(path.isAbsolute, "must be absolute"),
    status: RunStatusSchema,
    tasks: z.record(IdentifierSchema, TaskRecordSchema),
    agents: z.record(IdentifierSchema, AgentRecordSchema).default({}),
    sessions: z.record(IdentifierSchema, SessionRecordSchema).default({}),
    workspace: RunWorkspaceStateSchema.nullable().default(null),
    cmux: CmuxRunStateSchema.default({ workspace: null, panes: {} }),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.workspace !== null && run.workspace.branch !== run.branch) {
      context.addIssue({
        code: "custom",
        path: ["workspace", "branch"],
        message: "must equal the Run branch",
      });
    }
    const sessionsByAgent = new Map<
      string,
      Map<number, { id: string; status: string }>
    >();

    for (const [sessionId, session] of Object.entries(run.sessions)) {
      const identity = session.identity;
      if (identity.session !== sessionId) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "session"],
          message: `must equal registry key '${sessionId}'`,
        });
      }
      if (identity.run !== run.id) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "run"],
          message: `must equal Run '${run.id}'`,
        });
      }

      const agent = run.agents[identity.agent];
      if (!agent) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "agent"],
          message: `references unknown Agent '${identity.agent}'`,
        });
        continue;
      }
      let generations = sessionsByAgent.get(identity.agent);
      if (!generations) {
        generations = new Map();
        sessionsByAgent.set(identity.agent, generations);
      }
      if (generations.has(identity.generation)) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "generation"],
          message: `duplicates generation ${identity.generation} for Agent '${identity.agent}'`,
        });
      } else {
        generations.set(identity.generation, {
          id: sessionId,
          status: session.status,
        });
      }
    }

    for (const [agentId, agent] of Object.entries(run.agents)) {
      const generations = sessionsByAgent.get(agentId) ?? new Map();
      if (agent.session === null) {
        if (generations.size > 0) {
          context.addIssue({
            code: "custom",
            path: ["agents", agentId, "session"],
            message: "a dormant Agent cannot have Session records",
          });
        }
        continue;
      }

      const current = run.sessions[agent.session];
      if (!current) {
        context.addIssue({
          code: "custom",
          path: ["agents", agentId, "session"],
          message: `references unknown Session '${agent.session}'`,
        });
      } else {
        if (
          current.identity.agent !== agentId ||
          current.identity.generation !== agent.generation
        ) {
          context.addIssue({
            code: "custom",
            path: ["agents", agentId, "session"],
            message:
              "must reference the current Session at the Agent generation",
          });
        }
        if (current.route.profile !== agent.profile) {
          context.addIssue({
            code: "custom",
            path: ["sessions", agent.session, "route", "profile"],
            message: `must equal Agent Model Profile '${agent.profile}'`,
          });
        }
      }

      const orderedGenerations = [...generations.entries()].sort(
        ([left], [right]) => left - right,
      );
      for (let index = 0; index < orderedGenerations.length; index += 1) {
        const [generation, entry] = orderedGenerations[index]!;
        const expectedGeneration = index + 1;
        if (generation !== expectedGeneration) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "identity", "generation"],
            message: `expected contiguous generation ${expectedGeneration}, received ${generation}`,
          });
        }
        const session = run.sessions[entry.id]!;
        if (generation === 1 && session.replaces !== null) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "replaces"],
            message: "the first Session cannot replace another Session",
          });
        }
        if (generation > 1) {
          const predecessor = generations.get(generation - 1);
          if (session.replaces?.session !== predecessor?.id) {
            context.addIssue({
              code: "custom",
              path: ["sessions", entry.id, "replaces"],
              message: `must reference the Session at generation ${generation - 1}`,
            });
          }
        }
        if (
          generation < agent.generation &&
          !["stopped", "failed"].includes(entry.status)
        ) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "status"],
            message: "a replaced Session must be terminal",
          });
        }
      }
      if (generations.size !== agent.generation) {
        context.addIssue({
          code: "custom",
          path: ["agents", agentId, "generation"],
          message: "must equal the contiguous Session history length",
        });
      }
    }

    for (const [agentId, pane] of Object.entries(run.cmux.panes)) {
      const agent = run.agents[agentId];
      if (!agent) {
        context.addIssue({
          code: "custom",
          path: ["cmux", "panes", agentId],
          message: `references unknown Agent '${agentId}'`,
        });
        continue;
      }
      if (
        pane.identity.run !== run.id ||
        pane.identity.session !== agent.session ||
        pane.identity.generation !== agent.generation
      ) {
        context.addIssue({
          code: "custom",
          path: ["cmux", "panes", agentId, "identity"],
          message: "must identify the current Session for the Agent",
        });
      }
    }
  });
export type RunState = z.output<typeof RunStateSchema>;
export type RunStateInput = z.input<typeof RunStateSchema>;

export interface CreateRunResult {
  readonly run: RunState;
  readonly created: boolean;
}

const RunSummarySchema = z
  .object({
    id: IdentifierSchema,
    plan_id: IdentifierSchema,
    state_path: z.string().min(1),
    status: RunStatusSchema,
  })
  .strict();

export const ProjectRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    root: z.string().min(1),
    approvals: z.record(IdentifierSchema, ApprovalSchema),
    runs: z.record(IdentifierSchema, RunSummarySchema),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export function defaultOrchestratorHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.ORCHESTRATOR_HOME
    ? path.resolve(environment.ORCHESTRATOR_HOME)
    : path.join(os.homedir(), ".local", "share", "pi-orchestrator");
}

export class ProjectStore {
  readonly directory: string;
  readonly projectFile: string;
  private readonly releaseLock: () => Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private accepting = true;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(directory: string, releaseLock: () => Promise<void>) {
    this.directory = directory;
    this.projectFile = path.join(directory, "project.json");
    this.releaseLock = releaseLock;
  }

  static async open(input: {
    readonly home: string;
    readonly projectId: string;
    readonly projectRoot: string;
  }): Promise<ProjectStore> {
    const projectId = IdentifierSchema.parse(input.projectId);
    const directory = path.join(input.home, "projects", projectId);
    await mkdir(directory, { recursive: true });

    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(directory, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: 0,
      });
    } catch (error) {
      throw new OrchestratorError(
        "concurrent_writer",
        `Another Orchestrator owns Project '${projectId}'`,
        { cause: error },
      );
    }

    const store = new ProjectStore(directory, release);
    try {
      await store.initialize(projectId, input.projectRoot);
      return store;
    } catch (error) {
      await release();
      throw error;
    }
  }

  private assertOpen(): void {
    if (!this.accepting || this.closed)
      throw new OrchestratorError("store_closed", "Project store is closed");
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initialize(
    projectId: string,
    projectRoot: string,
  ): Promise<void> {
    try {
      const existing = await this.read();
      if (
        existing.id !== projectId ||
        path.resolve(existing.root) !== path.resolve(projectRoot)
      ) {
        throw new OrchestratorError(
          "project_identity_conflict",
          `Runtime Project '${projectId}' is already bound to ${existing.root}`,
        );
      }
    } catch (error) {
      if (
        !(error instanceof OrchestratorError) ||
        error.code !== "state_not_found"
      )
        throw error;
      const now = new Date().toISOString();
      await writeJsonAtomic(
        this.projectFile,
        ProjectRecordSchema.parse({
          version: 1,
          id: projectId,
          root: path.resolve(projectRoot),
          approvals: {},
          runs: {},
          created_at: now,
          updated_at: now,
        }),
      );
    }
  }

  async read(): Promise<ProjectRecord> {
    this.assertOpen();
    return this.readProjectFile();
  }

  private async readProjectFile(): Promise<ProjectRecord> {
    let source: string;
    try {
      source = await readFile(this.projectFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new OrchestratorError(
          "state_not_found",
          `Missing ${this.projectFile}`,
          { cause: error },
        );
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new OrchestratorError(
        "invalid_state",
        `Invalid JSON in ${this.projectFile}`,
        { cause: error },
      );
    }
    const result = ProjectRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new OrchestratorError(
        "invalid_state",
        `Invalid ${this.projectFile}: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async update(
    change: (current: ProjectRecord) => ProjectRecord,
  ): Promise<ProjectRecord> {
    return this.serializeMutation(async () => {
      const current = await this.readProjectFile();
      const next = ProjectRecordSchema.parse({
        ...change(structuredClone(current)),
        updated_at: new Date().toISOString(),
      });
      await writeJsonAtomic(this.projectFile, next);
      return next;
    });
  }

  async recordApproval(approval: Approval): Promise<ProjectRecord> {
    return this.update((current) => ({
      ...current,
      approvals: { ...current.approvals, [approval.plan_id]: approval },
    }));
  }

  runDirectory(runId: string): string {
    return path.join(this.directory, "runs", IdentifierSchema.parse(runId));
  }

  planningDirectory(planningId: string): string {
    return path.join(
      this.directory,
      "planning",
      IdentifierSchema.parse(planningId),
    );
  }

  async readRun(runId: string): Promise<RunState> {
    this.assertOpen();
    return this.readRunFile(IdentifierSchema.parse(runId));
  }

  private async readRunFile(runId: string): Promise<RunState> {
    const filePath = path.join(this.runDirectory(runId), "state.json");
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OrchestratorError("state_not_found", `Missing ${filePath}`, {
          cause: error,
        });
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new OrchestratorError(
        "invalid_state",
        `Invalid JSON in ${filePath}`,
        { cause: error },
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1
    ) {
      throw new OrchestratorError(
        "unsupported_state_version",
        `Run '${runId}' uses unsupported state schema version 1; unfinished v0.2 Runs are not migrated or resumed automatically`,
      );
    }
    const result = RunStateSchema.safeParse(value);
    if (!result.success) {
      throw new OrchestratorError(
        "invalid_state",
        `Invalid ${filePath}: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async writeRun(state: RunStateInput): Promise<void> {
    const parsed = RunStateSchema.parse(state);
    await this.serializeMutation(async () => {
      const project = await this.readProjectFile();
      if (parsed.project_id !== project.id) {
        throw new OrchestratorError(
          "run_project_conflict",
          `Run '${parsed.id}' belongs to Project '${parsed.project_id}', not '${project.id}'`,
        );
      }
      const statePath = path.resolve(
        this.runDirectory(parsed.id),
        "state.json",
      );
      const summary = project.runs[parsed.id];
      if (
        summary &&
        (summary.plan_id !== parsed.plan_id ||
          path.resolve(summary.state_path) !== statePath)
      ) {
        throw new OrchestratorError(
          "run_summary_conflict",
          `Project Run '${parsed.id}' has a conflicting summary`,
        );
      }
      await writeJsonAtomic(statePath, parsed);
      if (!summary || summary.status !== parsed.status) {
        await writeJsonAtomic(
          this.projectFile,
          ProjectRecordSchema.parse({
            ...project,
            runs: {
              ...project.runs,
              [parsed.id]: {
                id: parsed.id,
                plan_id: parsed.plan_id,
                state_path: statePath,
                status: parsed.status,
              },
            },
            updated_at: new Date().toISOString(),
          }),
        );
      }
    });
  }

  async createRun(state: RunStateInput): Promise<CreateRunResult> {
    const requested = RunStateSchema.parse(state);
    return this.serializeMutation(async () => {
      const project = await this.readProjectFile();
      if (requested.project_id !== project.id) {
        throw new OrchestratorError(
          "run_project_conflict",
          `Run '${requested.id}' belongs to Project '${requested.project_id}', not '${project.id}'`,
        );
      }

      const statePath = path.resolve(
        this.runDirectory(requested.id),
        "state.json",
      );
      const summary = project.runs[requested.id];
      let run: RunState;
      let created = false;
      try {
        run = await this.readRunFile(requested.id);
        const matches =
          run.project_id === requested.project_id &&
          run.plan_id === requested.plan_id &&
          run.plan_revision === requested.plan_revision &&
          run.plan_digest === requested.plan_digest &&
          run.base_commit === requested.base_commit &&
          run.branch === requested.branch &&
          run.worktree === requested.worktree;
        if (!matches) {
          throw new OrchestratorError(
            "run_conflict",
            `Run ID '${requested.id}' already identifies another durable Run`,
          );
        }
      } catch (error) {
        if (
          !(error instanceof OrchestratorError) ||
          error.code !== "state_not_found"
        ) {
          throw error;
        }
        if (summary) {
          throw new OrchestratorError(
            "run_state_missing",
            `Project Run '${requested.id}' is registered but its state file is missing`,
          );
        }
        run = requested;
        await writeJsonAtomic(statePath, run);
        created = true;
      }

      if (
        summary &&
        (summary.plan_id !== run.plan_id ||
          path.resolve(summary.state_path) !== statePath)
      ) {
        throw new OrchestratorError(
          "run_summary_conflict",
          `Project Run '${run.id}' has a conflicting summary`,
        );
      }
      if (!summary || summary.status !== run.status) {
        const next = ProjectRecordSchema.parse({
          ...project,
          runs: {
            ...project.runs,
            [run.id]: {
              id: run.id,
              plan_id: run.plan_id,
              state_path: statePath,
              status: run.status,
            },
          },
          updated_at: new Date().toISOString(),
        });
        await writeJsonAtomic(this.projectFile, next);
      }
      return { run, created };
    });
  }

  async updateRun(
    runId: string,
    change: (current: RunState) => RunState,
  ): Promise<RunState> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.serializeMutation(async () => {
      const project = await this.readProjectFile();
      const current = await this.readRunFile(parsedRunId);
      const statePath = path.resolve(
        this.runDirectory(parsedRunId),
        "state.json",
      );
      const summary = project.runs[parsedRunId];
      if (
        summary &&
        (summary.plan_id !== current.plan_id ||
          path.resolve(summary.state_path) !== statePath)
      ) {
        throw new OrchestratorError(
          "run_summary_conflict",
          `Project Run '${parsedRunId}' has a conflicting summary`,
        );
      }
      const draft = structuredClone(current);
      const changed = change(draft);
      if (changed.id !== parsedRunId) {
        throw new OrchestratorError(
          "run_identity_conflict",
          `Run update for '${parsedRunId}' returned '${changed.id}'`,
        );
      }
      const next =
        changed === draft
          ? current
          : RunStateSchema.parse({
              ...changed,
              updated_at: new Date().toISOString(),
            });
      if (next !== current) await writeJsonAtomic(statePath, next);
      if (!summary || summary.status !== next.status) {
        await writeJsonAtomic(
          this.projectFile,
          ProjectRecordSchema.parse({
            ...project,
            runs: {
              ...project.runs,
              [parsedRunId]: {
                id: next.id,
                plan_id: next.plan_id,
                state_path: statePath,
                status: next.status,
              },
            },
            updated_at: new Date().toISOString(),
          }),
        );
      }
      return next;
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.accepting = false;
    this.closePromise = this.mutationTail
      .then(() => this.releaseLock())
      .finally(() => {
        this.closed = true;
      });
    return this.closePromise;
  }
}
