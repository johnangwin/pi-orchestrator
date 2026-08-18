import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { ApprovalSchema, type Approval } from "./approval.js";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import { SeatRecordSchema, SessionRecordSchema } from "./session.js";
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
    seats: z.record(IdentifierSchema, SeatRecordSchema).default({}),
    sessions: z.record(IdentifierSchema, SessionRecordSchema).default({}),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((run, context) => {
    const sessionsBySeat = new Map<
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

      const seat = run.seats[identity.seat];
      if (!seat) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "seat"],
          message: `references unknown Seat '${identity.seat}'`,
        });
        continue;
      }
      if (session.model !== seat.model) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "model"],
          message: `must equal Seat model '${seat.model}'`,
        });
      }

      let epochs = sessionsBySeat.get(identity.seat);
      if (!epochs) {
        epochs = new Map();
        sessionsBySeat.set(identity.seat, epochs);
      }
      if (epochs.has(identity.epoch)) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionId, "identity", "epoch"],
          message: `duplicates epoch ${identity.epoch} for Seat '${identity.seat}'`,
        });
      } else {
        epochs.set(identity.epoch, {
          id: sessionId,
          status: session.status,
        });
      }
    }

    for (const [seatId, seat] of Object.entries(run.seats)) {
      const epochs = sessionsBySeat.get(seatId) ?? new Map();
      if (seat.session === null) {
        if (epochs.size > 0) {
          context.addIssue({
            code: "custom",
            path: ["seats", seatId, "session"],
            message: "a dormant Seat cannot have Session records",
          });
        }
        continue;
      }

      const current = run.sessions[seat.session];
      if (!current) {
        context.addIssue({
          code: "custom",
          path: ["seats", seatId, "session"],
          message: `references unknown Session '${seat.session}'`,
        });
      } else if (
        current.identity.seat !== seatId ||
        current.identity.epoch !== seat.epoch
      ) {
        context.addIssue({
          code: "custom",
          path: ["seats", seatId, "session"],
          message: "must reference the current Session at the Seat epoch",
        });
      }

      const orderedEpochs = [...epochs.entries()].sort(
        ([left], [right]) => left - right,
      );
      for (let index = 0; index < orderedEpochs.length; index += 1) {
        const [epoch, entry] = orderedEpochs[index]!;
        const expectedEpoch = index + 1;
        if (epoch !== expectedEpoch) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "identity", "epoch"],
            message: `expected contiguous epoch ${expectedEpoch}, received ${epoch}`,
          });
        }
        const session = run.sessions[entry.id]!;
        if (epoch === 1 && session.replaces !== null) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "replaces"],
            message: "the first Session cannot replace another Session",
          });
        }
        if (epoch > 1) {
          const predecessor = epochs.get(epoch - 1);
          if (session.replaces?.session !== predecessor?.id) {
            context.addIssue({
              code: "custom",
              path: ["sessions", entry.id, "replaces"],
              message: `must reference the Session at epoch ${epoch - 1}`,
            });
          }
        }
        if (
          epoch < seat.epoch &&
          !["stopped", "failed"].includes(entry.status)
        ) {
          context.addIssue({
            code: "custom",
            path: ["sessions", entry.id, "status"],
            message: "a replaced Session must be terminal",
          });
        }
      }
      if (epochs.size !== seat.epoch) {
        context.addIssue({
          code: "custom",
          path: ["seats", seatId, "epoch"],
          message: "must equal the contiguous Session history length",
        });
      }
    }
  });
export type RunState = z.output<typeof RunStateSchema>;
export type RunStateInput = z.input<typeof RunStateSchema>;

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
    await this.serializeMutation(() =>
      writeJsonAtomic(
        path.join(this.runDirectory(parsed.id), "state.json"),
        parsed,
      ),
    );
  }

  async updateRun(
    runId: string,
    change: (current: RunState) => RunState,
  ): Promise<RunState> {
    const parsedRunId = IdentifierSchema.parse(runId);
    return this.serializeMutation(async () => {
      const current = await this.readRunFile(parsedRunId);
      const draft = structuredClone(current);
      const changed = change(draft);
      if (changed.id !== parsedRunId) {
        throw new OrchestratorError(
          "run_identity_conflict",
          `Run update for '${parsedRunId}' returned '${changed.id}'`,
        );
      }
      if (changed === draft) return current;
      const next = RunStateSchema.parse({
        ...changed,
        updated_at: new Date().toISOString(),
      });
      await writeJsonAtomic(
        path.join(this.runDirectory(parsedRunId), "state.json"),
        next,
      );
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
