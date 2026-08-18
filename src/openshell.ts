import { execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { OrchestratorError } from "./error.js";
import { VersionSchema } from "./local.js";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals;
}

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface ProcessHandle {
  onStdout(listener: (chunk: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  wait(): Promise<ProcessResult>;
  terminate(signal?: NodeJS.Signals): void;
}

export type ProcessStarter = (
  command: string,
  args: readonly string[],
  options?: Pick<ProcessRunOptions, "cwd">,
) => ProcessHandle;

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

const defaultStarter: ProcessStarter = (command, args, options = {}) => {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const listener of stdoutListeners) listener(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    for (const listener of stderrListeners) listener(chunk);
  });

  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        ...(signal ? { signal } : {}),
      });
    });
  });

  return {
    onStdout(listener) {
      stdoutListeners.add(listener);
      return () => stdoutListeners.delete(listener);
    },
    onStderr(listener) {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    wait: () => completion,
    terminate: (signal = "SIGTERM") => child.kill(signal),
  };
};

export const OpenShellSandboxNameSchema = z
  .string()
  .min(1)
  .max(19)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "must contain lowercase letters, digits, or interior hyphens",
  );

export const OpenShellStatusSchema = z.object({
  authentication: z.object({
    provider: z.string().min(1),
    status: z.string().min(1),
  }),
  gateway: z.string().min(1),
  server: z.string().url(),
  status: z.string().min(1),
  version: VersionSchema,
});
export type OpenShellStatus = z.infer<typeof OpenShellStatusSchema>;

export const OpenShellSandboxSchema = z
  .object({
    annotations: z.record(z.string(), z.unknown()).default({}),
    created_at: z.string().min(1),
    current_policy_version: z.number().int().nonnegative(),
    id: z.string().uuid(),
    labels: z.record(z.string(), z.unknown()).default({}),
    name: OpenShellSandboxNameSchema,
    phase: z.string().min(1),
    policy: z.unknown().optional(),
    policy_source: z.string().min(1).optional(),
    resource_version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative().optional(),
    workspace: z.string().min(1),
  })
  .passthrough();
export type OpenShellSandbox = z.infer<typeof OpenShellSandboxSchema>;

const OpenShellSandboxListSchema = z.array(OpenShellSandboxSchema);

export interface OpenShellPreflight {
  readonly command: string;
  readonly requiredVersion?: string;
  readonly installedVersion: string;
  readonly versionMatches: boolean | null;
  readonly status: OpenShellStatus;
}

export interface CreateSandboxOptions {
  readonly name: string;
  readonly from: string;
  readonly policyPath: string;
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
}

export interface SandboxExecOptions {
  readonly timeoutMs?: number;
  readonly workdir?: string;
}

export interface WaitForSandboxOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export interface DeleteSandboxOptions {
  readonly missingOk?: boolean;
}

export interface ServiceForwardOptions {
  readonly sandboxName: string;
  readonly targetPort: number;
  readonly localPort?: number;
  readonly readyTimeoutMs?: number;
}

export interface OpenShellForward {
  readonly sandboxName: string;
  readonly localHost: "127.0.0.1";
  readonly localPort: number;
  readonly targetHost: "127.0.0.1";
  readonly targetPort: number;
  readonly closed: Promise<ProcessResult>;
  stop(): Promise<void>;
}

export interface OpenShellClientOptions {
  readonly command?: string;
  readonly gateway?: string;
  readonly workspace?: string;
  readonly requiredVersion?: string;
  readonly runner?: ProcessRunner;
  readonly starter?: ProcessStarter;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function parseJson(source: string, operation: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "invalid_openshell_output",
      `OpenShell ${operation} returned invalid JSON`,
      { cause: error },
    );
  }
}

function commandFailure(args: readonly string[], result: ProcessResult) {
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  const suffix = diagnostic ? `: ${diagnostic.slice(0, 2_000)}` : "";
  return new OrchestratorError(
    "openshell_failed",
    `OpenShell command failed with exit ${result.exitCode}: ${args.join(" ")}${suffix}`,
  );
}

function port(value: number, allowZero: boolean): number {
  return z
    .number()
    .int()
    .min(allowZero ? 0 : 1)
    .max(65_535)
    .parse(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export class OpenShellClient {
  readonly command: string;
  readonly gateway: string | undefined;
  readonly workspace: string;
  readonly requiredVersion: string | undefined;
  private readonly runner: ProcessRunner;
  private readonly starter: ProcessStarter;
  private readonly pause: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: OpenShellClientOptions = {}) {
    this.command = options.command ?? "openshell";
    this.gateway = options.gateway;
    this.workspace = options.workspace ?? "default";
    this.requiredVersion = options.requiredVersion
      ? VersionSchema.parse(options.requiredVersion)
      : undefined;
    this.runner = options.runner ?? defaultRunner;
    this.starter = options.starter ?? defaultStarter;
    this.pause = options.sleep ?? ((milliseconds) => sleep(milliseconds));
    this.now = options.now ?? Date.now;
  }

  private globalArgs(): string[] {
    return [
      ...(this.gateway ? ["--gateway", this.gateway] : []),
      "--workspace",
      this.workspace,
    ];
  }

  private async execute(
    args: readonly string[],
    options: ProcessRunOptions & { readonly check?: boolean } = {},
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner(this.command, args, options);
    } catch (error) {
      throw new OrchestratorError(
        "openshell_failed",
        `Cannot execute OpenShell command: ${this.command} ${args.join(" ")}`,
        { cause: error },
      );
    }
    if ((options.check ?? true) && result.exitCode !== 0) {
      throw commandFailure(args, result);
    }
    return result;
  }

  async version(): Promise<string> {
    const { stdout } = await this.execute(["--version"]);
    const match =
      /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/.exec(
        stdout,
      );
    if (!match?.[1]) {
      throw new OrchestratorError(
        "invalid_openshell_output",
        "OpenShell --version did not contain a semantic version",
      );
    }
    return VersionSchema.parse(match[1]);
  }

  async status(): Promise<OpenShellStatus> {
    const { stdout } = await this.execute([
      "status",
      "--output",
      "json",
      ...this.globalArgs(),
    ]);
    const result = OpenShellStatusSchema.safeParse(parseJson(stdout, "status"));
    if (!result.success) {
      throw new OrchestratorError(
        "invalid_openshell_output",
        `OpenShell status output did not match the expected contract: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async preflight(): Promise<OpenShellPreflight> {
    const installedVersion = await this.version();
    if (
      this.requiredVersion !== undefined &&
      installedVersion !== this.requiredVersion
    ) {
      throw new OrchestratorError(
        "openshell_version_mismatch",
        `OpenShell ${installedVersion} is installed; ${this.requiredVersion} is required`,
      );
    }

    const status = await this.status();
    if (
      status.status !== "connected" ||
      status.authentication.status !== "authenticated"
    ) {
      throw new OrchestratorError(
        "openshell_unhealthy",
        `OpenShell gateway '${status.gateway}' is ${status.status} with authentication ${status.authentication.status}`,
      );
    }
    if (status.version !== installedVersion) {
      throw new OrchestratorError(
        "openshell_version_mismatch",
        `OpenShell CLI ${installedVersion} does not match gateway ${status.version}`,
      );
    }

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
      status,
    };
  }

  async listSandboxes(): Promise<OpenShellSandbox[]> {
    const { stdout } = await this.execute([
      "sandbox",
      "list",
      "--output",
      "json",
      ...this.globalArgs(),
    ]);
    const result = OpenShellSandboxListSchema.safeParse(
      parseJson(stdout, "sandbox list"),
    );
    if (!result.success) {
      throw new OrchestratorError(
        "invalid_openshell_output",
        `OpenShell sandbox list output did not match the expected contract: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async getSandbox(name: string): Promise<OpenShellSandbox> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    const { stdout } = await this.execute([
      "sandbox",
      "get",
      sandboxName,
      "--output",
      "json",
      ...this.globalArgs(),
    ]);
    const result = OpenShellSandboxSchema.safeParse(
      parseJson(stdout, "sandbox get"),
    );
    if (!result.success) {
      throw new OrchestratorError(
        "invalid_openshell_output",
        `OpenShell sandbox get output did not match the expected contract: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async createSandbox(
    options: CreateSandboxOptions,
  ): Promise<OpenShellSandbox> {
    const name = OpenShellSandboxNameSchema.parse(options.name);
    const command = options.command ?? ["/usr/bin/true"];
    if (command.length === 0) {
      throw new OrchestratorError(
        "invalid_openshell_request",
        "A Sandbox creation command cannot be empty",
      );
    }
    await this.execute(
      [
        "sandbox",
        "create",
        "--name",
        name,
        "--from",
        options.from,
        "--policy",
        options.policyPath,
        "--no-auto-providers",
        "--no-tty",
        ...this.globalArgs(),
        "--",
        ...command,
      ],
      { timeoutMs: options.timeoutMs ?? 10 * 60_000 },
    );
    return this.getSandbox(name);
  }

  async waitForSandbox(
    name: string,
    options: WaitForSandboxOptions = {},
  ): Promise<OpenShellSandbox> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    const timeoutMs = options.timeoutMs ?? 2 * 60_000;
    const pollMs = options.pollMs ?? 500;
    const deadline = this.now() + timeoutMs;

    while (true) {
      const sandbox = await this.getSandbox(sandboxName);
      if (sandbox.phase === "Ready") return sandbox;
      if (["Error", "Failed", "Stopped"].includes(sandbox.phase)) {
        throw new OrchestratorError(
          "openshell_sandbox_failed",
          `Sandbox '${sandboxName}' entered terminal phase ${sandbox.phase}`,
        );
      }
      if (this.now() >= deadline) {
        throw new OrchestratorError(
          "openshell_timeout",
          `Sandbox '${sandboxName}' did not become Ready within ${timeoutMs}ms`,
        );
      }
      await this.pause(pollMs);
    }
  }

  async deleteSandbox(
    name: string,
    options: DeleteSandboxOptions = {},
  ): Promise<void> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    const args = ["sandbox", "delete", sandboxName, ...this.globalArgs()];
    const result = await this.execute(args, { check: false });
    if (result.exitCode === 0) return;
    if (options.missingOk) {
      const exists = (await this.listSandboxes()).some(
        (sandbox) => sandbox.name === sandboxName,
      );
      if (!exists) return;
    }
    throw commandFailure(args, result);
  }

  async execSandbox(
    name: string,
    command: readonly string[],
    options: SandboxExecOptions = {},
  ): Promise<ProcessResult> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    if (command.length === 0) {
      throw new OrchestratorError(
        "invalid_openshell_request",
        "A Sandbox exec command cannot be empty",
      );
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    return this.execute(
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        "--no-tty",
        "--timeout",
        String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
        ...(options.workdir ? ["--workdir", options.workdir] : []),
        ...this.globalArgs(),
        "--",
        ...command,
      ],
      { check: false, timeoutMs: timeoutMs + 5_000 },
    );
  }

  async upload(
    name: string,
    localPath: string,
    sandboxPath: string,
  ): Promise<void> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    await this.execute(
      [
        "sandbox",
        "upload",
        sandboxName,
        localPath,
        sandboxPath,
        ...this.globalArgs(),
      ],
      { timeoutMs: 5 * 60_000 },
    );
  }

  async download(
    name: string,
    sandboxPath: string,
    localPath: string,
  ): Promise<void> {
    const sandboxName = OpenShellSandboxNameSchema.parse(name);
    await this.execute(
      [
        "sandbox",
        "download",
        sandboxName,
        sandboxPath,
        localPath,
        ...this.globalArgs(),
      ],
      { timeoutMs: 5 * 60_000 },
    );
  }

  async startServiceForward(
    options: ServiceForwardOptions,
  ): Promise<OpenShellForward> {
    const sandboxName = OpenShellSandboxNameSchema.parse(options.sandboxName);
    const targetPort = port(options.targetPort, false);
    const requestedLocalPort = port(options.localPort ?? 0, true);
    const args = [
      "forward",
      "service",
      "--target-port",
      String(targetPort),
      "--target-host",
      "127.0.0.1",
      "--local",
      `127.0.0.1:${requestedLocalPort}`,
      sandboxName,
      ...this.globalArgs(),
    ];

    let handle: ProcessHandle;
    try {
      handle = this.starter(this.command, args);
    } catch (error) {
      throw new OrchestratorError(
        "openshell_failed",
        `Cannot start OpenShell service forward for '${sandboxName}'`,
        { cause: error },
      );
    }

    const closed = handle.wait();
    const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    let output = "";
    let settled = false;

    const localPort = await new Promise<number>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let removeStdout = () => {};
      let removeStderr = () => {};
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeStdout();
        removeStderr();
        callback();
      };
      const consume = (chunk: string) => {
        output = `${output}${stripAnsi(chunk)}`.slice(-64 * 1_024);
        const match = /Forwarding\s+127\.0\.0\.1:(\d+)\s+->/.exec(output);
        if (!match?.[1]) return;
        finish(() => resolve(port(Number(match[1]), false)));
      };
      removeStdout = handle.onStdout(consume);
      removeStderr = handle.onStderr(consume);
      timer = setTimeout(() => {
        finish(() => {
          handle.terminate();
          reject(
            new OrchestratorError(
              "openshell_timeout",
              `OpenShell service forward for '${sandboxName}' was not ready within ${readyTimeoutMs}ms`,
            ),
          );
        });
      }, readyTimeoutMs);
      void closed.then(
        (result) => {
          finish(() => reject(commandFailure(args, result)));
        },
        (error: unknown) => {
          finish(() =>
            reject(
              new OrchestratorError(
                "openshell_failed",
                `OpenShell service forward for '${sandboxName}' failed to start`,
                { cause: error },
              ),
            ),
          );
        },
      );
    });

    let stopped = false;
    return {
      sandboxName,
      localHost: "127.0.0.1",
      localPort,
      targetHost: "127.0.0.1",
      targetPort,
      closed,
      async stop() {
        if (stopped) return;
        stopped = true;
        handle.terminate();
        await closed;
      },
    };
  }
}
