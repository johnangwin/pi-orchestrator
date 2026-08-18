import { randomBytes } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { HostLink, TcpLinkTransport } from "./link.js";
import { VersionSchema } from "./local.js";
import type { Message } from "./message.js";
import type {
  OpenShellClient,
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
} from "./openshell.js";
import { loadSandboxPolicy } from "./policy.js";
import { SessionIdentitySchema, type SessionIdentity } from "./session.js";
import { verifySourceSnapshot, type SourceSnapshot } from "./snapshot.js";

export const PI_RUNTIME_VERSION = "0.84.2";
export const PI_CLIENT_VERSION = "0.1.0";
export const PI_LINK_PORT = 41_727;

export const PiClientConfigSchema = z
  .object({
    version: z.literal(1),
    identity: SessionIdentitySchema,
    token: z.string().regex(/^[a-f0-9]{64}$/),
    listen: z
      .object({
        host: z.literal("127.0.0.1"),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    client_version: VersionSchema,
    pi_version: VersionSchema,
  })
  .strict();
export type PiClientConfig = z.infer<typeof PiClientConfigSchema>;

export type ReadSessionOpenShell = Pick<
  OpenShellClient,
  | "createSandbox"
  | "deleteSandbox"
  | "execSandbox"
  | "preflight"
  | "startServiceForward"
  | "waitForSandbox"
>;

export interface StartReadSessionOptions {
  readonly client: ReadSessionOpenShell;
  readonly identity: SessionIdentity;
  readonly snapshot: SourceSnapshot;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly sandboxName?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly linkPort?: number;
  readonly startupTimeoutMs?: number;
}

export interface ReadSessionInfo {
  readonly sandbox: OpenShellSandbox;
  readonly identity: SessionIdentity;
  readonly sourceDigest: string;
  readonly readPolicyDigest: string;
  readonly openshell: OpenShellPreflight;
  readonly piVersion: string;
  readonly clientVersion: string;
}

function bundledPath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../sandbox/${segments.join("/")}`, import.meta.url),
  );
}

export function bundledPiImageContext(): string {
  return bundledPath("pi");
}

async function createSessionImageContext(options: {
  readonly image: string;
  readonly snapshot: SourceSnapshot;
  readonly config: PiClientConfig;
}): Promise<string> {
  const image = path.resolve(options.image);
  const imageState = await stat(image).catch((error: unknown) => {
    throw new OrchestratorError(
      "invalid_pi_image",
      `Pi image context '${image}' is not accessible`,
      { cause: error },
    );
  });
  if (!imageState.isDirectory()) {
    throw new OrchestratorError(
      "invalid_pi_image",
      `Pi image context '${image}' is not a directory`,
    );
  }

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-image-"),
  );
  try {
    for (const entry of await readdir(image)) {
      await cp(path.join(image, entry), path.join(directory, entry), {
        recursive: true,
      });
    }
    await cp(options.snapshot.archivePath, path.join(directory, "source.tar"));
    await cp(
      options.snapshot.manifestPath,
      path.join(directory, "snapshot.json"),
    );
    await verifySourceSnapshot({
      archivePath: path.join(directory, "source.tar"),
      manifestPath: path.join(directory, "snapshot.json"),
      manifest: options.snapshot.manifest,
    });
    await writeFile(
      path.join(directory, "session.json"),
      `${JSON.stringify(options.config, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const dockerfilePath = path.join(directory, "Dockerfile");
    const dockerfile = await readFile(dockerfilePath, "utf8");
    await writeFile(
      dockerfilePath,
      `${dockerfile.trimEnd()}

# Session inputs come only from the trusted Git snapshot context.
USER root
ADD --chown=10001:10001 source.tar /workspace/project/
COPY --chown=0:0 snapshot.json session.json /workspace/input/
RUN chmod 0444 /workspace/input/snapshot.json /workspace/input/session.json
USER 10001:10001
WORKDIR /workspace/project
`,
      "utf8",
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function generatedSandboxName(): string {
  return `pio-r-${randomBytes(4).toString("hex")}`;
}

async function requireSuccess(
  operation: string,
  promise: ReturnType<ReadSessionOpenShell["execSandbox"]>,
): Promise<void> {
  const result = await promise;
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new OrchestratorError(
      "session_bootstrap_failed",
      `${operation} exited ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 1_000)}` : ""}`,
    );
  }
}

async function connectWithRetry(options: {
  readonly forward: OpenShellForward;
  readonly identity: SessionIdentity;
  readonly token: string;
  readonly piVersion: string;
  readonly clientVersion: string;
  readonly timeoutMs: number;
}): Promise<HostLink> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const transport = new TcpLinkTransport({
      host: options.forward.localHost,
      port: options.forward.localPort,
    });
    try {
      return await HostLink.connect({
        transport,
        identity: options.identity,
        token: options.token,
        expectedClientVersion: options.clientVersion,
        expectedPiVersion: options.piVersion,
        timeoutMs: Math.min(5_000, options.timeoutMs),
      });
    } catch (error) {
      lastError = error;
      const code =
        error instanceof OrchestratorError ? error.code : "unknown_error";
      if (
        ![
          "link_connect_failed",
          "link_disconnected",
          "link_receive_failed",
          "link_timeout",
        ].includes(code)
      ) {
        throw error;
      }
      await sleep(250);
    }
  }
  throw new OrchestratorError(
    "session_startup_timeout",
    `Pi client did not establish its Link within ${options.timeoutMs}ms: ${formatUnknownError(lastError)}`,
    { cause: lastError },
  );
}

export class ReadSession {
  readonly info: ReadSessionInfo;
  private stopped = false;

  constructor(
    private readonly client: ReadSessionOpenShell,
    private readonly forward: OpenShellForward,
    private link: HostLink,
    info: ReadSessionInfo,
    private readonly token: string,
    private readonly startupTimeoutMs: number,
  ) {
    this.info = info;
  }

  ping(): Promise<string> {
    return this.link.ping();
  }

  deliver(message: Message): Promise<"queued" | "duplicate"> {
    return this.link.deliver(message);
  }

  async reconnect(): Promise<void> {
    if (this.stopped) {
      throw new OrchestratorError(
        "session_stopped",
        "Cannot reconnect a stopped Session",
      );
    }
    await this.link.close();
    this.link = await connectWithRetry({
      forward: this.forward,
      identity: this.info.identity,
      token: this.token,
      piVersion: this.info.piVersion,
      clientVersion: this.info.clientVersion,
      timeoutMs: this.startupTimeoutMs,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const failures: string[] = [];
    try {
      await this.link.close();
    } catch (error) {
      failures.push(`Link: ${formatUnknownError(error)}`);
    }
    try {
      await this.forward.stop();
    } catch (error) {
      failures.push(`forward: ${formatUnknownError(error)}`);
    }
    try {
      await this.client.deleteSandbox(this.info.sandbox.name, {
        missingOk: true,
      });
    } catch (error) {
      failures.push(`Sandbox: ${formatUnknownError(error)}`);
    }
    if (failures.length > 0) {
      throw new OrchestratorError(
        "session_cleanup_failed",
        failures.join("; "),
      );
    }
  }
}

export async function startReadSession(
  options: StartReadSessionOptions,
): Promise<ReadSession> {
  const snapshotManifest = await verifySourceSnapshot(options.snapshot);
  const identity = SessionIdentitySchema.parse(options.identity);
  const piVersion = VersionSchema.parse(
    options.piVersion ?? PI_RUNTIME_VERSION,
  );
  const clientVersion = VersionSchema.parse(
    options.clientVersion ?? PI_CLIENT_VERSION,
  );
  const linkPort = z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(options.linkPort ?? PI_LINK_PORT);
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const image = options.imageContext ?? bundledPiImageContext();
  const policyDirectory = options.policyDirectory ?? bundledPath("policies");
  const [readPolicy, preflight] = await Promise.all([
    loadSandboxPolicy("read", path.join(policyDirectory, "read.yaml")),
    options.client.preflight(),
  ]);
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "A Pi Session requires an exact OpenShell version pin",
    );
  }

  const token = randomBytes(32).toString("hex");
  const config = PiClientConfigSchema.parse({
    version: 1,
    identity,
    token,
    listen: { host: "127.0.0.1", port: linkPort },
    client_version: clientVersion,
    pi_version: piVersion,
  });
  const sandboxName = options.sandboxName ?? generatedSandboxName();
  const imageContext = await createSessionImageContext({
    image,
    snapshot: options.snapshot,
    config,
  });

  let sandbox: OpenShellSandbox | undefined;
  let forward: OpenShellForward | undefined;
  let link: HostLink | undefined;
  try {
    sandbox = await options.client.createSandbox({
      name: sandboxName,
      from: imageContext,
      policyPath: readPolicy.path,
      command: ["/usr/bin/true"],
    });
    if (sandbox.phase !== "Ready") {
      sandbox = await options.client.waitForSandbox(sandboxName);
    }

    await requireSuccess(
      "read-only boundary verification",
      options.client.execSandbox(
        sandboxName,
        [
          "/bin/sh",
          "-c",
          'test -r /workspace/input/session.json && test -r /workspace/input/snapshot.json && test -n "$(find /workspace/project -mindepth 1 -print -quit)" && test ! -e /workspace/project/.git && ! touch /workspace/project/.orchestrator-write-probe && ! touch /workspace/input/.orchestrator-write-probe',
        ],
        { timeoutMs: 10_000 },
      ),
    );
    await requireSuccess(
      "Pi launch",
      options.client.execSandbox(
        sandboxName,
        ["/usr/local/bin/orchestrator-start-pi"],
        { timeoutMs: 30_000 },
      ),
    );

    forward = await options.client.startServiceForward({
      sandboxName,
      targetPort: linkPort,
      readyTimeoutMs: 10_000,
    });
    link = await connectWithRetry({
      forward,
      identity,
      token,
      piVersion,
      clientVersion,
      timeoutMs: startupTimeoutMs,
    });
    return new ReadSession(
      options.client,
      forward,
      link,
      {
        sandbox,
        identity,
        sourceDigest: snapshotManifest.source_digest,
        readPolicyDigest: readPolicy.digest,
        openshell: preflight,
        piVersion,
        clientVersion,
      },
      token,
      startupTimeoutMs,
    );
  } catch (error) {
    const cleanupFailures: string[] = [];
    await link?.close().catch((cleanupError: unknown) => {
      cleanupFailures.push(`Link: ${formatUnknownError(cleanupError)}`);
    });
    await forward?.stop().catch((cleanupError: unknown) => {
      cleanupFailures.push(`forward: ${formatUnknownError(cleanupError)}`);
    });
    await options.client
      .deleteSandbox(sandboxName, { missingOk: true })
      .catch((cleanupError: unknown) => {
        cleanupFailures.push(`Sandbox: ${formatUnknownError(cleanupError)}`);
      });
    if (cleanupFailures.length > 0) {
      throw new OrchestratorError(
        "session_cleanup_failed",
        `Session startup failed (${formatUnknownError(error)}); cleanup also failed: ${cleanupFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await rm(imageContext, { recursive: true, force: true });
  }
}
