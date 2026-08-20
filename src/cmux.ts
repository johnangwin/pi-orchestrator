import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import { VersionSchema } from "./local.js";
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from "./openshell.js";
import { SessionIdentitySchema } from "./session.js";

export const CmuxIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const CmuxTitleSchema = z.string().trim().min(1).max(256);

const CmuxWorkspaceSchema = z
  .object({
    id: CmuxIdSchema,
    title: z.string(),
    selected: z.boolean(),
    index: z.number().int().nonnegative(),
    description: z.string().nullable().optional(),
  })
  .passthrough();
export type CmuxWorkspace = z.output<typeof CmuxWorkspaceSchema>;

const CmuxPaneSchema = z
  .object({
    id: CmuxIdSchema,
    focused: z.boolean(),
    surface_ids: z.array(CmuxIdSchema),
    selected_surface_id: CmuxIdSchema.nullable(),
    surface_count: z.number().int().nonnegative(),
  })
  .passthrough()
  .superRefine((pane, context) => {
    if (pane.surface_count !== pane.surface_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["surface_count"],
        message: "must equal surface_ids length",
      });
    }
    if (
      pane.selected_surface_id !== null &&
      !pane.surface_ids.includes(pane.selected_surface_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selected_surface_id"],
        message: "must identify a surface in this pane",
      });
    }
  });
export type CmuxPane = z.output<typeof CmuxPaneSchema>;

const CmuxSurfaceSchema = z
  .object({
    id: CmuxIdSchema,
    title: z.string(),
    type: z.string().nullable(),
    selected: z.boolean(),
    index: z.number().int().nonnegative(),
  })
  .passthrough();
export type CmuxSurface = z.output<typeof CmuxSurfaceSchema>;

const CmuxCapabilitiesSchema = z
  .object({
    methods: z.array(z.string().min(1)),
  })
  .passthrough();
export type CmuxCapabilities = z.output<typeof CmuxCapabilitiesSchema>;

const CmuxWorkspaceListSchema = z
  .object({
    workspaces: z.array(CmuxWorkspaceSchema),
  })
  .passthrough();

const CmuxWorkspaceCreateSchema = z
  .object({
    workspace_id: CmuxIdSchema,
    surface_id: CmuxIdSchema.nullable(),
  })
  .passthrough();

const CmuxPaneListSchema = z
  .object({
    workspace_id: CmuxIdSchema,
    panes: z.array(CmuxPaneSchema),
  })
  .passthrough();

const CmuxSurfaceListSchema = z
  .object({
    workspace_id: CmuxIdSchema,
    pane_id: CmuxIdSchema,
    surfaces: z.array(CmuxSurfaceSchema),
  })
  .passthrough();

const CmuxPaneCreateSchema = z
  .object({
    workspace_id: CmuxIdSchema,
    pane_id: CmuxIdSchema,
    surface_id: CmuxIdSchema,
    type: z.literal("terminal"),
  })
  .passthrough();

export const CmuxWorkspaceBindingSchema = z
  .object({
    operation_id: CmuxIdSchema,
    workspace_id: CmuxIdSchema,
    title: CmuxTitleSchema,
  })
  .strict();
export type CmuxWorkspaceBinding = z.output<typeof CmuxWorkspaceBindingSchema>;

export const CmuxPaneBindingSchema = z
  .object({
    operation_id: CmuxIdSchema,
    workspace_id: CmuxIdSchema,
    pane_id: CmuxIdSchema,
    surface_id: CmuxIdSchema,
    title: CmuxTitleSchema,
  })
  .strict();
export type CmuxPaneBinding = z.output<typeof CmuxPaneBindingSchema>;

export const CmuxPaneCreationIntentSchema = z
  .object({
    operation_id: CmuxIdSchema,
    workspace_id: CmuxIdSchema,
    title: CmuxTitleSchema,
    prior_pane_ids: z.array(CmuxIdSchema),
  })
  .strict()
  .superRefine((intent, context) => {
    if (new Set(intent.prior_pane_ids).size !== intent.prior_pane_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["prior_pane_ids"],
        message: "must not contain duplicate Pane IDs",
      });
    }
  });
export type CmuxPaneCreationIntent = z.output<
  typeof CmuxPaneCreationIntentSchema
>;

export const CmuxWorkspaceStateSchema = z
  .object({
    operation_id: CmuxIdSchema,
    title: CmuxTitleSchema,
    binding: CmuxWorkspaceBindingSchema.nullable(),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (
      workspace.binding &&
      (workspace.binding.operation_id !== workspace.operation_id ||
        workspace.binding.title !== workspace.title)
    ) {
      context.addIssue({
        code: "custom",
        path: ["binding"],
        message: "must match the Workspace operation and title",
      });
    }
  });
export type CmuxWorkspaceState = z.output<typeof CmuxWorkspaceStateSchema>;

export const CmuxPaneStateSchema = z
  .object({
    identity: SessionIdentitySchema,
    operation_id: CmuxIdSchema,
    title: CmuxTitleSchema,
    intent: CmuxPaneCreationIntentSchema.nullable(),
    binding: CmuxPaneBindingSchema.nullable(),
    replaces: CmuxPaneBindingSchema.nullable(),
  })
  .strict()
  .superRefine((pane, context) => {
    for (const [field, value] of [
      ["intent", pane.intent],
      ["binding", pane.binding],
    ] as const) {
      if (
        value &&
        (value.operation_id !== pane.operation_id || value.title !== pane.title)
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "must match the Pane operation and title",
        });
      }
    }
    if (
      pane.intent &&
      pane.binding &&
      pane.intent.workspace_id !== pane.binding.workspace_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["binding", "workspace_id"],
        message: "must match the Pane creation intent Workspace",
      });
    }
    if (
      pane.replaces &&
      pane.binding &&
      pane.replaces.pane_id === pane.binding.pane_id &&
      pane.replaces.surface_id === pane.binding.surface_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["replaces"],
        message: "must identify a different Pane binding",
      });
    }
    if (pane.replaces && pane.replaces.operation_id === pane.operation_id) {
      context.addIssue({
        code: "custom",
        path: ["replaces", "operation_id"],
        message: "must identify a prior Pane operation",
      });
    }
  });
export type CmuxPaneState = z.output<typeof CmuxPaneStateSchema>;

export const CmuxRunStateSchema = z
  .object({
    workspace: CmuxWorkspaceStateSchema.nullable(),
    panes: z.record(IdentifierSchema, CmuxPaneStateSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const workspaceId = state.workspace?.binding?.workspace_id;
    if (!state.workspace?.binding && Object.keys(state.panes).length) {
      context.addIssue({
        code: "custom",
        path: ["panes"],
        message: "cannot exist before the Run Workspace is bound",
      });
    }

    const paneOwners = new Map<string, string>();
    const surfaceOwners = new Map<string, string>();
    for (const [agent, pane] of Object.entries(state.panes)) {
      if (pane.identity.agent !== agent) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "identity", "agent"],
          message: `must equal registry key '${agent}'`,
        });
      }
      for (const [field, value] of [
        ["intent", pane.intent],
        ["binding", pane.binding],
        ["replaces", pane.replaces],
      ] as const) {
        if (value && value.workspace_id !== workspaceId) {
          context.addIssue({
            code: "custom",
            path: ["panes", agent, field, "workspace_id"],
            message: "must equal the bound Run Workspace",
          });
        }
      }
      if (!pane.binding) continue;
      const paneOwner = paneOwners.get(pane.binding.pane_id);
      if (paneOwner) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "binding", "pane_id"],
          message: `is already bound to Agent '${paneOwner}'`,
        });
      } else {
        paneOwners.set(pane.binding.pane_id, agent);
      }
      const surfaceOwner = surfaceOwners.get(pane.binding.surface_id);
      if (surfaceOwner) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "binding", "surface_id"],
          message: `is already bound to Agent '${surfaceOwner}'`,
        });
      } else {
        surfaceOwners.set(pane.binding.surface_id, agent);
      }
    }
  });
export type CmuxRunState = z.output<typeof CmuxRunStateSchema>;

export const CmuxProjectionSchema = z
  .object({
    workspace: CmuxWorkspaceBindingSchema,
    panes: z.record(IdentifierSchema, CmuxPaneBindingSchema),
  })
  .strict()
  .superRefine((projection, context) => {
    const paneOwners = new Map<string, string>();
    const surfaceOwners = new Map<string, string>();
    for (const [agent, pane] of Object.entries(projection.panes)) {
      if (pane.workspace_id !== projection.workspace.workspace_id) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "workspace_id"],
          message: "must equal the projection workspace_id",
        });
      }
      const paneOwner = paneOwners.get(pane.pane_id);
      if (paneOwner) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "pane_id"],
          message: `is already bound to Agent '${paneOwner}'`,
        });
      } else {
        paneOwners.set(pane.pane_id, agent);
      }
      const surfaceOwner = surfaceOwners.get(pane.surface_id);
      if (surfaceOwner) {
        context.addIssue({
          code: "custom",
          path: ["panes", agent, "surface_id"],
          message: `is already bound to Agent '${surfaceOwner}'`,
        });
      } else {
        surfaceOwners.set(pane.surface_id, agent);
      }
    }
  });
export type CmuxProjection = z.output<typeof CmuxProjectionSchema>;

const CommandSchema = z
  .array(
    z.string().refine((value) => !value.includes("\0"), "must not contain NUL"),
  )
  .min(1);

const CreateWorkspaceOptionsSchema = z
  .object({
    operationId: CmuxIdSchema,
    title: CmuxTitleSchema,
    cwd: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), "must be an absolute path")
      .optional(),
    description: z.string().trim().min(1).max(2_000).optional(),
    command: CommandSchema.optional(),
    focus: z.boolean().default(false),
  })
  .strict();

const CreatePaneOptionsSchema = z
  .object({
    operationId: CmuxIdSchema,
    workspace: CmuxWorkspaceBindingSchema,
    title: CmuxTitleSchema,
    direction: z.enum(["left", "right", "up", "down"]).default("right"),
    cwd: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), "must be an absolute path")
      .optional(),
    command: CommandSchema.optional(),
    focus: z.boolean().default(false),
  })
  .strict();

export const CMUX_REQUIRED_METHODS = [
  "pane.create",
  "pane.focus",
  "pane.list",
  "pane.surfaces",
  "surface.close",
  "tab.action",
  "workspace.close",
  "workspace.create",
  "workspace.list",
  "workspace.rename",
  "workspace.select",
] as const;

export interface CmuxPreflight {
  readonly command: string;
  readonly requiredVersion?: string;
  readonly installedVersion: string;
  readonly versionMatches: boolean | null;
  readonly capabilities: CmuxCapabilities;
}

export interface CmuxClientOptions {
  readonly command?: string;
  readonly requiredVersion?: string;
  readonly runner?: ProcessRunner;
}

export interface CreateCmuxWorkspaceOptions {
  readonly operationId: string;
  readonly title: string;
  readonly cwd?: string;
  readonly description?: string;
  readonly command?: readonly string[];
  readonly focus?: boolean;
}

export interface CreateCmuxPaneOptions {
  readonly operationId: string;
  readonly workspace: CmuxWorkspaceBinding;
  readonly title: string;
  readonly direction?: "left" | "right" | "up" | "down";
  readonly cwd?: string;
  readonly command?: readonly string[];
  readonly focus?: boolean;
}

export interface EnsureCmuxWorkspaceOptions extends CreateCmuxWorkspaceOptions {
  readonly binding?: CmuxWorkspaceBinding | null;
}

export interface EnsureCmuxPaneOptions extends CreateCmuxPaneOptions {
  readonly binding?: CmuxPaneBinding | null;
  readonly intent?: CmuxPaneCreationIntent;
}

export interface CmuxEnsureResult<T> {
  readonly binding: T;
  readonly created: boolean;
  readonly recovered: boolean;
  readonly repaired: boolean;
}

export type CmuxWorkspaceProjectionStatus =
  "present" | "title_mismatch" | "missing";

export type CmuxPaneProjectionStatus =
  | "present"
  | "title_mismatch"
  | "missing"
  | "surface_missing"
  | "workspace_missing";

export interface CmuxReconciliation {
  readonly healthy: boolean;
  readonly workspace: {
    readonly binding: CmuxWorkspaceBinding;
    readonly status: CmuxWorkspaceProjectionStatus;
    readonly actualTitle?: string;
  };
  readonly panes: Readonly<
    Record<
      string,
      {
        readonly binding: CmuxPaneBinding;
        readonly status: CmuxPaneProjectionStatus;
        readonly actualTitle?: string;
      }
    >
  >;
}

interface ExecFileFailure extends Error {
  readonly code?: number | string;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals;
  readonly stderr?: string;
  readonly stdout?: string;
}

const defaultRunner: ProcessRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const failure = error as ExecFileFailure;
        if (typeof failure.code !== "number" && !failure.killed) {
          reject(error);
          return;
        }
        resolve({
          stdout: failure.stdout ?? stdout,
          stderr: failure.stderr ?? stderr,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          ...(failure.signal ? { signal: failure.signal } : {}),
        });
      },
    );
    child.stdin?.end();
  });

function parseJson(source: string, operation: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_cmux_output",
      `cmux ${operation} returned invalid JSON`,
      { cause: error },
    );
  }
}

function parseOutput<T>(
  schema: z.ZodType<T>,
  source: string,
  operation: string,
): T {
  const result = schema.safeParse(parseJson(source, operation));
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_cmux_output",
      `cmux ${operation} output did not match the expected contract: ${result.error.message}`,
    );
  }
  return result.data;
}

function commandFailure(operation: string, result: ProcessResult) {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  const excerpt =
    diagnostic.length <= 2_000
      ? diagnostic
      : `${diagnostic.slice(0, 500)}\n...\n${diagnostic.slice(-1_500)}`;
  if (/access denied.*started inside cmux/is.test(excerpt)) {
    return new OrchestratorError(
      "cmux_access_denied",
      "cmux denied control-socket access; run the Orchestrator from a cmux-created terminal",
    );
  }
  return new OrchestratorError(
    "cmux_failed",
    `cmux ${operation} failed with exit ${result.exitCode}${excerpt ? `: ${excerpt}` : ""}`,
  );
}

export function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new OrchestratorError(
      "invalid_cmux_command",
      "cmux launch arguments must not contain NUL",
    );
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function cmuxShellCommand(argv: readonly string[]): string {
  return CommandSchema.parse(argv).map(quoteShellArg).join(" ");
}

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireReturnedId(
  operation: string,
  kind: "Workspace" | "Pane" | "Surface",
  actual: string,
  expected: string,
): void {
  if (!sameId(actual, expected)) {
    throw new OrchestratorError(
      "invalid_cmux_output",
      `cmux ${operation} returned ${kind} '${actual}', expected '${expected}'`,
    );
  }
}

function requireExpectedWorkspace(
  binding: CmuxWorkspaceBinding,
  operationId: string,
  title: string,
): void {
  if (binding.operation_id !== operationId) {
    throw new OrchestratorError(
      "cmux_binding_conflict",
      `cmux Workspace binding operation '${binding.operation_id}' does not match '${operationId}'`,
    );
  }
  if (binding.title !== title) {
    throw new OrchestratorError(
      "cmux_binding_conflict",
      `cmux Workspace binding title '${binding.title}' does not match '${title}'`,
    );
  }
}

export class CmuxClient {
  readonly command: string;
  readonly requiredVersion: string | undefined;
  private readonly runner: ProcessRunner;

  constructor(options: CmuxClientOptions = {}) {
    this.command = options.command ?? "cmux";
    this.requiredVersion = options.requiredVersion
      ? VersionSchema.parse(options.requiredVersion)
      : undefined;
    this.runner = options.runner ?? defaultRunner;
  }

  private jsonArgs(args: readonly string[]): string[] {
    return ["--json", "--id-format", "uuids", ...args];
  }

  private async execute(
    operation: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner(this.command, args, options);
    } catch (error) {
      throw new OrchestratorError(
        "cmux_failed",
        `Cannot execute cmux ${operation} with '${this.command}'`,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) throw commandFailure(operation, result);
    return result;
  }

  private async executeJson<T>(
    operation: string,
    args: readonly string[],
    schema: z.ZodType<T>,
  ): Promise<T> {
    const result = await this.execute(operation, this.jsonArgs(args));
    return parseOutput(schema, result.stdout, operation);
  }

  async version(): Promise<string> {
    const { stdout } = await this.execute("--version", ["--version"]);
    const match =
      /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/.exec(
        stdout,
      );
    if (!match?.[1]) {
      throw new OrchestratorError(
        "invalid_cmux_output",
        "cmux --version did not contain a semantic version",
      );
    }
    return VersionSchema.parse(match[1]);
  }

  async capabilities(): Promise<CmuxCapabilities> {
    const capabilities = await this.executeJson(
      "capabilities",
      ["capabilities"],
      CmuxCapabilitiesSchema,
    );
    const available = new Set(capabilities.methods);
    const missing = CMUX_REQUIRED_METHODS.filter(
      (method) => !available.has(method),
    );
    if (missing.length > 0) {
      throw new OrchestratorError(
        "cmux_capability_missing",
        `cmux is missing required control methods: ${missing.join(", ")}`,
      );
    }
    return capabilities;
  }

  async preflight(): Promise<CmuxPreflight> {
    const installedVersion = await this.version();
    if (
      this.requiredVersion !== undefined &&
      installedVersion !== this.requiredVersion
    ) {
      throw new OrchestratorError(
        "cmux_version_mismatch",
        `cmux ${installedVersion} is installed; ${this.requiredVersion} is required`,
      );
    }
    const capabilities = await this.capabilities();
    return {
      command: this.command,
      ...(this.requiredVersion
        ? { requiredVersion: this.requiredVersion }
        : {}),
      installedVersion,
      versionMatches:
        this.requiredVersion === undefined
          ? null
          : installedVersion === this.requiredVersion,
      capabilities,
    };
  }

  async listWorkspaces(): Promise<CmuxWorkspace[]> {
    const result = await this.executeJson(
      "workspace list",
      ["workspace", "list"],
      CmuxWorkspaceListSchema,
    );
    return result.workspaces;
  }

  async createWorkspace(
    options: CreateCmuxWorkspaceOptions,
  ): Promise<CmuxWorkspaceBinding> {
    const parsed = CreateWorkspaceOptionsSchema.parse(options);
    const params = {
      operation_id: parsed.operationId,
      title: parsed.title,
      focus: parsed.focus,
      ...(parsed.cwd ? { working_directory: parsed.cwd } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.command
        ? { initial_command: cmuxShellCommand(parsed.command) }
        : {}),
    };
    const result = await this.executeJson(
      "workspace create",
      ["rpc", "workspace.create", JSON.stringify(params)],
      CmuxWorkspaceCreateSchema,
    );
    return CmuxWorkspaceBindingSchema.parse({
      operation_id: parsed.operationId,
      workspace_id: result.workspace_id,
      title: parsed.title,
    });
  }

  async renameWorkspace(binding: CmuxWorkspaceBinding): Promise<void> {
    const parsed = CmuxWorkspaceBindingSchema.parse(binding);
    const result = await this.executeJson(
      "workspace rename",
      ["workspace", "rename", parsed.workspace_id, "--title", parsed.title],
      z.object({ workspace_id: CmuxIdSchema }).passthrough(),
    );
    requireReturnedId(
      "workspace rename",
      "Workspace",
      result.workspace_id,
      parsed.workspace_id,
    );
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    const id = CmuxIdSchema.parse(workspaceId);
    const result = await this.executeJson(
      "workspace select",
      ["workspace", "select", id],
      z.object({ workspace_id: CmuxIdSchema }).passthrough(),
    );
    requireReturnedId("workspace select", "Workspace", result.workspace_id, id);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const id = CmuxIdSchema.parse(workspaceId);
    const result = await this.executeJson(
      "workspace close",
      ["workspace", "close", id],
      z.object({ workspace_id: CmuxIdSchema }).passthrough(),
    );
    requireReturnedId("workspace close", "Workspace", result.workspace_id, id);
  }

  async listPanes(workspaceId: string): Promise<CmuxPane[]> {
    const id = CmuxIdSchema.parse(workspaceId);
    const result = await this.executeJson(
      "list-panes",
      ["list-panes", "--workspace", id],
      CmuxPaneListSchema,
    );
    if (!sameId(result.workspace_id, id)) {
      throw new OrchestratorError(
        "invalid_cmux_output",
        `cmux list-panes returned Workspace '${result.workspace_id}', expected '${id}'`,
      );
    }
    return result.panes;
  }

  async listPaneSurfaces(
    workspaceId: string,
    paneId: string,
  ): Promise<CmuxSurface[]> {
    const workspace = CmuxIdSchema.parse(workspaceId);
    const pane = CmuxIdSchema.parse(paneId);
    const result = await this.executeJson(
      "list-pane-surfaces",
      ["list-pane-surfaces", "--workspace", workspace, "--pane", pane],
      CmuxSurfaceListSchema,
    );
    if (
      !sameId(result.workspace_id, workspace) ||
      !sameId(result.pane_id, pane)
    ) {
      throw new OrchestratorError(
        "invalid_cmux_output",
        "cmux list-pane-surfaces returned a different Workspace or Pane",
      );
    }
    return result.surfaces;
  }

  async createPane(options: CreateCmuxPaneOptions): Promise<CmuxPaneBinding> {
    const parsed = CreatePaneOptionsSchema.parse(options);
    const params = {
      workspace_id: parsed.workspace.workspace_id,
      type: "terminal",
      direction: parsed.direction,
      focus: parsed.focus,
      ...(parsed.cwd ? { working_directory: parsed.cwd } : {}),
      ...(parsed.command
        ? { initial_command: cmuxShellCommand(parsed.command) }
        : {}),
    };
    const created = await this.executeJson(
      "pane create",
      ["rpc", "pane.create", JSON.stringify(params)],
      CmuxPaneCreateSchema,
    );
    if (!sameId(created.workspace_id, parsed.workspace.workspace_id)) {
      throw new OrchestratorError(
        "invalid_cmux_output",
        "cmux pane create returned a different Workspace",
      );
    }
    const binding = CmuxPaneBindingSchema.parse({
      operation_id: parsed.operationId,
      workspace_id: created.workspace_id,
      pane_id: created.pane_id,
      surface_id: created.surface_id,
      title: parsed.title,
    });
    await this.renameSurface(binding);
    return binding;
  }

  async renameSurface(binding: CmuxPaneBinding): Promise<void> {
    const parsed = CmuxPaneBindingSchema.parse(binding);
    const result = await this.executeJson(
      "rename-tab",
      [
        "rename-tab",
        "--workspace",
        parsed.workspace_id,
        "--surface",
        parsed.surface_id,
        "--title",
        parsed.title,
      ],
      z
        .object({
          workspace_id: CmuxIdSchema,
          surface_id: CmuxIdSchema,
        })
        .passthrough(),
    );
    requireReturnedId(
      "rename-tab",
      "Workspace",
      result.workspace_id,
      parsed.workspace_id,
    );
    requireReturnedId(
      "rename-tab",
      "Surface",
      result.surface_id,
      parsed.surface_id,
    );
  }

  async focusPane(binding: CmuxPaneBinding): Promise<void> {
    const parsed = CmuxPaneBindingSchema.parse(binding);
    await this.selectWorkspace(parsed.workspace_id);
    const result = await this.executeJson(
      "focus-pane",
      [
        "focus-pane",
        "--workspace",
        parsed.workspace_id,
        "--pane",
        parsed.pane_id,
      ],
      z
        .object({
          workspace_id: CmuxIdSchema,
          pane_id: CmuxIdSchema,
        })
        .passthrough(),
    );
    requireReturnedId(
      "focus-pane",
      "Workspace",
      result.workspace_id,
      parsed.workspace_id,
    );
    requireReturnedId("focus-pane", "Pane", result.pane_id, parsed.pane_id);
  }

  async closePane(binding: CmuxPaneBinding): Promise<void> {
    const parsed = CmuxPaneBindingSchema.parse(binding);
    const panes = await this.listPanes(parsed.workspace_id);
    const pane = panes.find((candidate) => candidate.id === parsed.pane_id);
    if (!pane) return;
    if (pane.surface_count !== 1 || pane.surface_ids[0] !== parsed.surface_id) {
      throw new OrchestratorError(
        "cmux_pane_shape",
        `Refusing to close Pane '${parsed.pane_id}' because it no longer contains only its bound Surface`,
      );
    }
    const result = await this.executeJson(
      "close-surface",
      [
        "close-surface",
        "--workspace",
        parsed.workspace_id,
        "--surface",
        parsed.surface_id,
      ],
      z
        .object({
          workspace_id: CmuxIdSchema,
          surface_id: CmuxIdSchema,
        })
        .passthrough(),
    );
    requireReturnedId(
      "close-surface",
      "Workspace",
      result.workspace_id,
      parsed.workspace_id,
    );
    requireReturnedId(
      "close-surface",
      "Surface",
      result.surface_id,
      parsed.surface_id,
    );
  }

  async preparePaneCreation(options: {
    readonly operationId: string;
    readonly workspace: CmuxWorkspaceBinding;
    readonly title: string;
  }): Promise<CmuxPaneCreationIntent> {
    const operation = CmuxIdSchema.parse(options.operationId);
    const workspace = CmuxWorkspaceBindingSchema.parse(options.workspace);
    const title = CmuxTitleSchema.parse(options.title);
    const panes = await this.listPanes(workspace.workspace_id);
    return CmuxPaneCreationIntentSchema.parse({
      operation_id: operation,
      workspace_id: workspace.workspace_id,
      title,
      prior_pane_ids: panes.map((pane) => pane.id).sort(),
    });
  }

  async ensureWorkspace(
    options: EnsureCmuxWorkspaceOptions,
  ): Promise<CmuxEnsureResult<CmuxWorkspaceBinding>> {
    const { binding: inputBinding, ...createOptions } = options;
    const parsed = CreateWorkspaceOptionsSchema.parse(createOptions);
    const binding = inputBinding
      ? CmuxWorkspaceBindingSchema.parse(inputBinding)
      : null;
    if (binding)
      requireExpectedWorkspace(binding, parsed.operationId, parsed.title);

    const workspaces = await this.listWorkspaces();
    if (binding) {
      const workspace = workspaces.find(
        (candidate) => candidate.id === binding.workspace_id,
      );
      if (!workspace) {
        throw new OrchestratorError(
          "cmux_workspace_missing",
          `Bound cmux Workspace '${binding.workspace_id}' is missing`,
        );
      }
      if (workspace.title !== binding.title) {
        await this.renameWorkspace(binding);
        return {
          binding,
          created: false,
          recovered: false,
          repaired: true,
        };
      }
      return {
        binding,
        created: false,
        recovered: false,
        repaired: false,
      };
    }

    const result = await this.createWorkspace({
      operationId: parsed.operationId,
      title: parsed.title,
      focus: parsed.focus,
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.command ? { command: parsed.command } : {}),
    });
    const existing = workspaces.find(
      (workspace) => workspace.id === result.workspace_id,
    );
    const repaired = existing !== undefined && existing.title !== result.title;
    if (repaired) await this.renameWorkspace(result);
    return {
      binding: result,
      created: existing === undefined,
      recovered: existing !== undefined,
      repaired,
    };
  }

  async ensurePane(
    options: EnsureCmuxPaneOptions,
  ): Promise<CmuxEnsureResult<CmuxPaneBinding>> {
    const {
      binding: inputBinding,
      intent: inputIntent,
      ...createOptions
    } = options;
    const parsed = CreatePaneOptionsSchema.parse(createOptions);
    const binding = inputBinding
      ? CmuxPaneBindingSchema.parse(inputBinding)
      : null;
    if (binding) {
      if (binding.operation_id !== parsed.operationId) {
        throw new OrchestratorError(
          "cmux_binding_conflict",
          `cmux Pane binding operation '${binding.operation_id}' does not match '${parsed.operationId}'`,
        );
      }
      if (binding.workspace_id !== parsed.workspace.workspace_id) {
        throw new OrchestratorError(
          "cmux_binding_conflict",
          "cmux Pane binding belongs to a different Workspace",
        );
      }
      if (binding.title !== parsed.title) {
        throw new OrchestratorError(
          "cmux_binding_conflict",
          `cmux Pane binding title '${binding.title}' does not match '${parsed.title}'`,
        );
      }
    }

    const intent = inputIntent
      ? CmuxPaneCreationIntentSchema.parse(inputIntent)
      : null;
    if (!binding && !intent) {
      throw new OrchestratorError(
        "cmux_intent_required",
        "A durable cmux Pane creation intent is required before creating or recovering an Agent Pane",
      );
    }
    if (
      intent &&
      (intent.operation_id !== parsed.operationId ||
        intent.workspace_id !== parsed.workspace.workspace_id ||
        intent.title !== parsed.title)
    ) {
      throw new OrchestratorError(
        "cmux_intent_conflict",
        "cmux Pane creation intent does not match the requested operation, Workspace, and title",
      );
    }

    const panes = await this.listPanes(parsed.workspace.workspace_id);
    if (binding) {
      const pane = panes.find((candidate) => candidate.id === binding.pane_id);
      if (!pane) {
        throw new OrchestratorError(
          "cmux_pane_missing",
          `Bound cmux Pane '${binding.pane_id}' is missing`,
        );
      }
      if (!pane.surface_ids.includes(binding.surface_id)) {
        throw new OrchestratorError(
          "cmux_surface_missing",
          `Bound cmux Surface '${binding.surface_id}' is missing from Pane '${binding.pane_id}'`,
        );
      }
      const surfaces = await this.listPaneSurfaces(
        binding.workspace_id,
        binding.pane_id,
      );
      const surface = surfaces.find(
        (candidate) => candidate.id === binding.surface_id,
      );
      if (!surface) {
        throw new OrchestratorError(
          "cmux_surface_missing",
          `Bound cmux Surface '${binding.surface_id}' is missing`,
        );
      }
      if (surface.title !== binding.title) {
        await this.renameSurface(binding);
        return {
          binding,
          created: false,
          recovered: false,
          repaired: true,
        };
      }
      return {
        binding,
        created: false,
        recovered: false,
        repaired: false,
      };
    }

    const surfacesByPane = await Promise.all(
      panes.map(async (pane) => ({
        pane,
        surfaces: await this.listPaneSurfaces(
          parsed.workspace.workspace_id,
          pane.id,
        ),
      })),
    );
    const matches = surfacesByPane.flatMap(({ pane, surfaces }) =>
      surfaces
        .filter((surface) => surface.title === parsed.title)
        .map((surface) => ({ pane, surface })),
    );
    const priorPaneIds = new Set(intent!.prior_pane_ids);
    const unaccounted = surfacesByPane.filter(
      ({ pane }) => !priorPaneIds.has(pane.id),
    );
    if (unaccounted.length > 1) {
      throw new OrchestratorError(
        "cmux_ambiguous_pane",
        `More than one cmux Pane appeared after operation '${intent!.operation_id}' was prepared`,
      );
    }
    if (unaccounted[0]) {
      const { pane, surfaces } = unaccounted[0];
      if (matches.some((match) => match.pane.id !== pane.id)) {
        throw new OrchestratorError(
          "cmux_ambiguous_pane",
          `Agent title '${parsed.title}' and operation '${intent!.operation_id}' resolve to different Panes`,
        );
      }
      if (
        pane.surface_count !== 1 ||
        surfaces.length !== 1 ||
        pane.surface_ids[0] !== surfaces[0]!.id
      ) {
        throw new OrchestratorError(
          "cmux_pane_shape",
          `Cannot recover operation '${intent!.operation_id}' from a multi-Surface Pane`,
        );
      }
      const repaired = surfaces[0]!.title !== parsed.title;
      const recovered = CmuxPaneBindingSchema.parse({
        operation_id: parsed.operationId,
        workspace_id: parsed.workspace.workspace_id,
        pane_id: pane.id,
        surface_id: surfaces[0]!.id,
        title: parsed.title,
      });
      if (repaired) await this.renameSurface(recovered);
      return {
        binding: recovered,
        created: false,
        recovered: true,
        repaired,
      };
    }
    if (matches.length > 1) {
      throw new OrchestratorError(
        "cmux_ambiguous_pane",
        `More than one cmux Surface is titled '${parsed.title}' in Workspace '${parsed.workspace.workspace_id}'`,
      );
    }
    if (matches[0]) {
      if (
        matches[0].pane.surface_count !== 1 ||
        matches[0].pane.surface_ids[0] !== matches[0].surface.id
      ) {
        throw new OrchestratorError(
          "cmux_pane_shape",
          `Cannot recover Agent title '${parsed.title}' from a multi-Surface Pane`,
        );
      }
      return {
        binding: CmuxPaneBindingSchema.parse({
          operation_id: parsed.operationId,
          workspace_id: parsed.workspace.workspace_id,
          pane_id: matches[0].pane.id,
          surface_id: matches[0].surface.id,
          title: parsed.title,
        }),
        created: false,
        recovered: true,
        repaired: false,
      };
    }

    return {
      binding: await this.createPane({
        operationId: parsed.operationId,
        workspace: parsed.workspace,
        title: parsed.title,
        direction: parsed.direction,
        focus: parsed.focus,
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(parsed.command ? { command: parsed.command } : {}),
      }),
      created: true,
      recovered: false,
      repaired: false,
    };
  }

  async reconcile(projection: CmuxProjection): Promise<CmuxReconciliation> {
    const expected = CmuxProjectionSchema.parse(projection);
    const workspaces = await this.listWorkspaces();
    const actualWorkspace = workspaces.find(
      (workspace) => workspace.id === expected.workspace.workspace_id,
    );
    if (!actualWorkspace) {
      const panes = Object.fromEntries(
        Object.entries(expected.panes).map(([agent, binding]) => [
          agent,
          { binding, status: "workspace_missing" as const },
        ]),
      );
      return {
        healthy: false,
        workspace: { binding: expected.workspace, status: "missing" },
        panes,
      };
    }

    const workspaceStatus: CmuxWorkspaceProjectionStatus =
      actualWorkspace.title === expected.workspace.title
        ? "present"
        : "title_mismatch";
    const actualPanes = await this.listPanes(expected.workspace.workspace_id);
    const surfaceLists = new Map<string, CmuxSurface[]>();
    await Promise.all(
      Object.values(expected.panes).map(async (binding) => {
        if (surfaceLists.has(binding.pane_id)) return;
        const pane = actualPanes.find(
          (candidate) => candidate.id === binding.pane_id,
        );
        if (!pane || !pane.surface_ids.includes(binding.surface_id)) return;
        surfaceLists.set(
          binding.pane_id,
          await this.listPaneSurfaces(binding.workspace_id, binding.pane_id),
        );
      }),
    );

    const paneResults: Record<string, CmuxReconciliation["panes"][string]> = {};
    for (const [agent, binding] of Object.entries(expected.panes)) {
      const pane = actualPanes.find(
        (candidate) => candidate.id === binding.pane_id,
      );
      if (!pane) {
        paneResults[agent] = { binding, status: "missing" };
        continue;
      }
      if (!pane.surface_ids.includes(binding.surface_id)) {
        paneResults[agent] = { binding, status: "surface_missing" };
        continue;
      }
      const surface = surfaceLists
        .get(binding.pane_id)
        ?.find((candidate) => candidate.id === binding.surface_id);
      if (!surface) {
        paneResults[agent] = { binding, status: "surface_missing" };
        continue;
      }
      paneResults[agent] =
        surface.title === binding.title
          ? { binding, status: "present", actualTitle: surface.title }
          : {
              binding,
              status: "title_mismatch",
              actualTitle: surface.title,
            };
    }

    return {
      healthy:
        workspaceStatus === "present" &&
        Object.values(paneResults).every(
          (result) => result.status === "present",
        ),
      workspace: {
        binding: expected.workspace,
        status: workspaceStatus,
        actualTitle: actualWorkspace.title,
      },
      panes: paneResults,
    };
  }
}
