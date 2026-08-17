import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { OrchestratorError } from "./error.js";
import { VersionSchema } from "./local.js";

const execFileAsync = promisify(execFile);

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<ProcessResult>;

const defaultRunner: ProcessRunner = async (command, args) => {
  const result = await execFileAsync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

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

export interface OpenShellPreflight {
  readonly command: string;
  readonly requiredVersion?: string;
  readonly installedVersion: string;
  readonly versionMatches: boolean | null;
  readonly status: OpenShellStatus;
}

export interface OpenShellClientOptions {
  readonly command?: string;
  readonly gateway?: string;
  readonly workspace?: string;
  readonly requiredVersion?: string;
  readonly runner?: ProcessRunner;
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

export class OpenShellClient {
  readonly command: string;
  readonly gateway: string | undefined;
  readonly workspace: string;
  readonly requiredVersion: string | undefined;
  private readonly runner: ProcessRunner;

  constructor(options: OpenShellClientOptions = {}) {
    this.command = options.command ?? "openshell";
    this.gateway = options.gateway;
    this.workspace = options.workspace ?? "default";
    this.requiredVersion = options.requiredVersion
      ? VersionSchema.parse(options.requiredVersion)
      : undefined;
    this.runner = options.runner ?? defaultRunner;
  }

  private globalArgs(): string[] {
    return [
      ...(this.gateway ? ["--gateway", this.gateway] : []),
      "--workspace",
      this.workspace,
    ];
  }

  private async execute(args: readonly string[]): Promise<ProcessResult> {
    try {
      return await this.runner(this.command, args);
    } catch (error) {
      throw new OrchestratorError(
        "openshell_failed",
        `OpenShell command failed: ${this.command} ${args.join(" ")}`,
        { cause: error },
      );
    }
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
}
