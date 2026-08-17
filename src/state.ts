import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { ApprovalSchema, type Approval } from "./approval.js";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import { GateStatusSchema, RunStatusSchema, TaskStatusSchema } from "./task.js";

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

export const TaskRecordSchema = z
  .object({
    id: IdentifierSchema,
    status: TaskStatusSchema,
    implementation_attempts: z.number().int().nonnegative(),
    review_rounds: z.number().int().nonnegative(),
    input_commit: z.string().optional(),
    input_source_digest: z.string().optional(),
    output_source_digest: z.string().optional(),
    diff_digest: z.string().optional(),
    gates: z.record(IdentifierSchema, GateRecordSchema),
  })
  .strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const RunStateSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    project_id: IdentifierSchema,
    plan_id: IdentifierSchema,
    plan_revision: z.number().int().positive(),
    plan_digest: z.string(),
    base_commit: z.string().min(1),
    branch: z.string().min(1),
    worktree: z.string().min(1),
    status: RunStatusSchema,
    tasks: z.record(IdentifierSchema, TaskRecordSchema),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type RunState = z.infer<typeof RunStateSchema>;

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
  private closed = false;

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
    if (this.closed)
      throw new OrchestratorError("store_closed", "Project store is closed");
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

    const parsed: unknown = JSON.parse(source);
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
    this.assertOpen();
    const current = await this.read();
    const next = ProjectRecordSchema.parse({
      ...change(structuredClone(current)),
      updated_at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.projectFile, next);
    return next;
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

  async readRun(runId: string): Promise<RunState> {
    const filePath = path.join(this.runDirectory(runId), "state.json");
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return RunStateSchema.parse(value);
  }

  async writeRun(state: RunState): Promise<void> {
    this.assertOpen();
    const parsed = RunStateSchema.parse(state);
    await writeJsonAtomic(
      path.join(this.runDirectory(state.id), "state.json"),
      parsed,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.releaseLock();
  }
}
