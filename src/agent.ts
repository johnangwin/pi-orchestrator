import { randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
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
import type { CompiledBrief } from "./brief.js";
import {
  ContextThresholdsSchema,
  DEFAULT_CONTEXT_THRESHOLDS,
  type ContextThresholds,
} from "./config.js";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { HostLink, TcpLinkTransport, type LinkEventFrame } from "./link.js";
import { VersionSchema } from "./local.js";
import type { Message } from "./message.js";
import type { SessionMetricRecorder } from "./metric.js";
import { ResolvedModelRouteSchema, type ResolvedModelRoute } from "./model.js";
import type {
  OpenShellClient,
  OpenShellForward,
  OpenShellInferenceRoute,
  OpenShellPreflight,
  OpenShellSandbox,
} from "./openshell.js";
import {
  ReadOnlySourceWorkspace,
  SessionWorkspaceProjectionSchema,
  WritableSourceWorkspace,
  WorkspaceSessionProjectionSchema,
  WritableWorkspaceSessionProjectionSchema,
  verifyWorkspaceGateway,
  type SessionWorkspaceProjection,
} from "./source.js";
import { validateOpenShellMountTable } from "./mount.js";
import { loadSandboxPolicy } from "./policy.js";
import {
  PermissionCeilingSchema,
  requireWritableGrant,
  type PermissionCeiling,
  type PermissionRuntimeState,
} from "./permission.js";
import {
  ModelTurnFailureSchema,
  ModelTurnResultSchema,
  sameSessionIdentity,
  SessionIdentitySchema,
  SessionSandboxSchema,
  type ModelTurnResult,
  type SessionIdentity,
  type SessionSandbox,
} from "./session.js";
import { verifySourceSnapshot, type SourceSnapshot } from "./snapshot.js";

export const PI_RUNTIME_VERSION = "0.84.2";
export const PI_CLIENT_VERSION = "0.3.0";
export const PI_LINK_PORT = 41_727;
export const PI_CLIENT_CONFIG_VERSION = 2 as const;

export const PiSessionModelSchema = ResolvedModelRouteSchema;
export type PiSessionModel = z.infer<typeof PiSessionModelSchema>;

const PiSessionBriefSchema = z
  .object({
    path: z.literal("/workspace/input/brief.md"),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const SessionInputNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/)
  .refine(
    (name) => !["brief.md", "session.json", "snapshot.json"].includes(name),
    "is reserved",
  );

const PiSessionInputSchema = z
  .object({
    path: z.string().regex(/^\/workspace\/input\/[a-z0-9][a-z0-9._-]*$/),
    byte_count: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type PiSessionInput = z.infer<typeof PiSessionInputSchema>;

export interface SessionInput {
  readonly name: string;
  readonly content: string | Uint8Array;
  readonly digest: Digest;
}

export interface WorkspaceSessionSource {
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly sourceDigest: Digest;
  verify(copy: {
    readonly archivePath: string;
    readonly manifestPath: string;
  }): Promise<Digest>;
}

export const PiClientConfigSchema = z
  .object({
    version: z.literal(PI_CLIENT_CONFIG_VERSION),
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
    profile: z.enum(["read", "write"]).default("read"),
    permission_ceiling: PermissionCeilingSchema,
    context: ContextThresholdsSchema.default(DEFAULT_CONTEXT_THRESHOLDS),
    source_digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    policy_digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    model: PiSessionModelSchema.optional(),
    brief: PiSessionBriefSchema.optional(),
    inputs: z.array(PiSessionInputSchema).max(16).default([]),
    workspace_projection: SessionWorkspaceProjectionSchema.optional(),
  })
  .strict()
  .refine(
    (config) => (config.model === undefined) === (config.brief === undefined),
    {
      message: "model and brief must either both be present or both be absent",
    },
  );
export type PiClientConfig = z.infer<typeof PiClientConfigSchema>;

export type ReadSessionOpenShell = Pick<
  OpenShellClient,
  | "createSandbox"
  | "deleteSandbox"
  | "execSandbox"
  | "preflight"
  | "startServiceForward"
  | "waitForSandbox"
> &
  Partial<
    Pick<
      OpenShellClient,
      "getGatewayInfo" | "getInferenceRoute" | "listGateways" | "upload"
    >
  >;

export type WriteSessionOpenShell = ReadSessionOpenShell;

export type ResumeReadSessionOpenShell = Pick<
  OpenShellClient,
  | "deleteSandbox"
  | "execSandbox"
  | "getSandbox"
  | "preflight"
  | "startServiceForward"
> &
  Partial<
    Pick<
      OpenShellClient,
      "getGatewayInfo" | "getInferenceRoute" | "listGateways"
    >
  >;

export type ResumeWriteSessionOpenShell = ResumeReadSessionOpenShell;

type ReadSessionCleanupOpenShell = Pick<OpenShellClient, "deleteSandbox">;
type CurrentActionState = () =>
  PermissionRuntimeState | Promise<PermissionRuntimeState>;

function clientGateway(client: object): string | undefined {
  const value = (client as { readonly gateway?: unknown }).gateway;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface StartSessionOptions {
  readonly client: ReadSessionOpenShell;
  readonly identity: SessionIdentity;
  readonly permissionCeiling: PermissionCeiling;
  readonly currentActionState?: CurrentActionState;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly sandboxName?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly linkPort?: number;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly context?: ContextThresholds;
  readonly model?: ResolvedModelRoute;
  readonly brief?: Pick<CompiledBrief, "content" | "digest"> &
    Partial<Pick<CompiledBrief, "binding">>;
  readonly inputs?: readonly SessionInput[];
  readonly metrics?: SessionMetricRecorder;
  readonly task?: string;
  readonly now?: () => Date;
}

export type StartReadSessionOptions = StartSessionOptions &
  (
    | {
        readonly snapshot: SourceSnapshot;
        readonly workspaceSource?: never;
        readonly workspace?: never;
      }
    | {
        readonly snapshot?: never;
        readonly workspaceSource: WorkspaceSessionSource;
        readonly workspace?: never;
      }
    | {
        readonly snapshot?: never;
        readonly workspaceSource?: never;
        readonly workspace: ReadOnlySourceWorkspace;
      }
  );

export type StartWriteSessionOptions = StartSessionOptions &
  (
    | {
        readonly snapshot: SourceSnapshot;
        readonly workspaceSource?: never;
        readonly workspace?: never;
      }
    | {
        readonly snapshot?: never;
        readonly workspaceSource?: never;
        readonly workspace: WritableSourceWorkspace;
      }
  ) & {
    readonly writeGrant: { readonly task: string };
  };

export interface ResumeReadSessionOptions {
  readonly client: ResumeReadSessionOpenShell;
  readonly identity: SessionIdentity;
  readonly sandbox: SessionSandbox;
  readonly permissionCeilingDigest: Digest;
  readonly currentActionState?: CurrentActionState;
  readonly policyDirectory?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly context?: ContextThresholds;
  readonly model?: ResolvedModelRoute;
  readonly briefDigest?: string;
  readonly metrics?: SessionMetricRecorder;
  readonly task?: string;
  readonly now?: () => Date;
  readonly workspace?: ReadOnlySourceWorkspace;
}

export type ResumeWriteSessionOptions = ResumeReadSessionOptions;

export type AgentSessionProfile = "read" | "write";

export interface ReadSessionInfo {
  readonly sandbox: OpenShellSandbox & {
    readonly projection?: SessionWorkspaceProjection;
  };
  readonly identity: SessionIdentity;
  readonly sourceDigest: string;
  readonly profile: AgentSessionProfile;
  readonly permissionCeiling: PermissionCeiling;
  readonly policyDigest: string;
  readonly readPolicyDigest: string;
  readonly openshell: OpenShellPreflight;
  readonly piVersion: string;
  readonly clientVersion: string;
  readonly context?: ContextThresholds;
  readonly model?: ResolvedModelRoute;
  readonly inference?: OpenShellInferenceRoute;
  readonly briefDigest?: string;
  readonly inputs: readonly PiSessionInput[];
  readonly workspaceProjection?: SessionWorkspaceProjection;
}

export type WriteSessionInfo = ReadSessionInfo;

function bundledPath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../sandbox/${segments.join("/")}`, import.meta.url),
  );
}

export function bundledPiImageContext(): string {
  return bundledPath("pi");
}

export function bundledPiPolicyDirectory(): string {
  return bundledPath("policies");
}

type VerifiedSessionSource =
  | {
      readonly kind: "snapshot";
      readonly archivePath: string;
      readonly manifestPath: string;
      readonly manifest: SourceSnapshot["manifest"];
      readonly sourceDigest: string;
    }
  | {
      readonly kind: "workspace";
      readonly archivePath: string;
      readonly manifestPath: string;
      readonly verify: WorkspaceSessionSource["verify"];
      readonly sourceDigest: string;
    }
  | {
      readonly kind: "workspace-projection";
      readonly workspace: ReadOnlySourceWorkspace | WritableSourceWorkspace;
      readonly sourceDigest: string;
    };

interface ValidatedSessionInput {
  readonly name: string;
  readonly bytes: Buffer;
  readonly config: PiSessionInput;
}

function validateSessionInputs(
  values: readonly SessionInput[] = [],
): ValidatedSessionInput[] {
  if (values.length > 16) {
    throw new OrchestratorError(
      "invalid_session_input",
      "A Session may receive at most 16 additional immutable inputs",
    );
  }
  const names = new Set<string>();
  let totalBytes = 0;
  return values.map((value) => {
    const name = SessionInputNameSchema.parse(value.name);
    if (names.has(name)) {
      throw new OrchestratorError(
        "invalid_session_input",
        `Session input '${name}' is duplicated`,
      );
    }
    names.add(name);
    const bytes =
      typeof value.content === "string"
        ? Buffer.from(value.content, "utf8")
        : Buffer.from(value.content);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > 32 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) {
      throw new OrchestratorError(
        "session_input_too_large",
        "Session immutable inputs exceed their byte limit",
      );
    }
    if (sha256(bytes) !== value.digest) {
      throw new OrchestratorError(
        "invalid_session_input_digest",
        `Session input '${name}' does not match its digest`,
      );
    }
    return {
      name,
      bytes,
      config: PiSessionInputSchema.parse({
        path: `/workspace/input/${name}`,
        byte_count: bytes.byteLength,
        digest: value.digest,
      }),
    };
  });
}

async function verifiedSessionSource(
  options: StartReadSessionOptions | StartWriteSessionOptions,
  profile: AgentSessionProfile,
): Promise<VerifiedSessionSource> {
  if (options.workspaceSource) {
    if (profile !== "read") {
      throw new OrchestratorError(
        "invalid_session_source",
        "A reconstructed Run source may only initialize a read Session",
      );
    }
    const sourceDigest = await options.workspaceSource.verify({
      archivePath: options.workspaceSource.archivePath,
      manifestPath: options.workspaceSource.manifestPath,
    });
    if (sourceDigest !== options.workspaceSource.sourceDigest) {
      throw new OrchestratorError(
        "invalid_session_source",
        "Reconstructed Run source verification returned another digest",
      );
    }
    return {
      kind: "workspace",
      archivePath: options.workspaceSource.archivePath,
      manifestPath: options.workspaceSource.manifestPath,
      verify: options.workspaceSource.verify.bind(options.workspaceSource),
      sourceDigest,
    };
  }
  if (options.workspace) {
    const trusted =
      (profile === "read" &&
        options.workspace instanceof ReadOnlySourceWorkspace) ||
      (profile === "write" &&
        options.workspace instanceof WritableSourceWorkspace);
    if (!trusted) {
      throw new OrchestratorError(
        "invalid_workspace_projection",
        `${profile === "read" ? "Read" : "Write"} Session Workspace source is not its trusted projection type`,
      );
    }
    const source = await options.workspace.verify();
    return {
      kind: "workspace-projection",
      workspace: options.workspace,
      sourceDigest: source.source_digest,
    };
  }
  const manifest = await verifySourceSnapshot(options.snapshot);
  return {
    kind: "snapshot",
    archivePath: options.snapshot.archivePath,
    manifestPath: options.snapshot.manifestPath,
    manifest,
    sourceDigest: manifest.source_digest,
  };
}

function hasWriteGrant(
  options: StartReadSessionOptions | StartWriteSessionOptions,
): options is StartWriteSessionOptions {
  const candidate = options as { readonly writeGrant?: unknown };
  return (
    typeof candidate.writeGrant === "object" &&
    candidate.writeGrant !== null &&
    "task" in candidate.writeGrant
  );
}

async function createSessionImageContext(options: {
  readonly image: string;
  readonly source: Exclude<
    VerifiedSessionSource,
    { readonly kind: "workspace-projection" }
  >;
  readonly config: PiClientConfig;
  readonly profile: AgentSessionProfile;
  readonly brief?: Pick<CompiledBrief, "content" | "digest">;
  readonly inputs: readonly ValidatedSessionInput[];
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
    await cp(options.source.archivePath, path.join(directory, "source.tar"));
    await cp(
      options.source.manifestPath,
      path.join(directory, "snapshot.json"),
    );
    if (options.source.kind === "snapshot") {
      await verifySourceSnapshot({
        archivePath: path.join(directory, "source.tar"),
        manifestPath: path.join(directory, "snapshot.json"),
        manifest: options.source.manifest,
      });
    } else {
      const digest = await options.source.verify({
        archivePath: path.join(directory, "source.tar"),
        manifestPath: path.join(directory, "snapshot.json"),
      });
      if (digest !== options.source.sourceDigest) {
        throw new OrchestratorError(
          "invalid_session_source",
          "Staged reconstructed Run source has another digest",
        );
      }
    }
    await writeFile(
      path.join(directory, "session.json"),
      `${JSON.stringify(options.config, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (options.brief) {
      await writeFile(path.join(directory, "brief.md"), options.brief.content, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (
        sha256(await readFile(path.join(directory, "brief.md"))) !==
        options.config.brief?.content_digest
      ) {
        throw new OrchestratorError(
          "invalid_brief_digest",
          "Staged Brief content does not match its content digest",
        );
      }
    }
    const extraInputDirectory = path.join(directory, "extra-inputs");
    if (options.inputs.length > 0) {
      await mkdir(extraInputDirectory, { mode: 0o700 });
    }
    for (const input of options.inputs) {
      const stagedPath = path.join(extraInputDirectory, input.name);
      await writeFile(stagedPath, input.bytes, {
        mode: 0o600,
      });
      if (sha256(await readFile(stagedPath)) !== input.config.digest) {
        throw new OrchestratorError(
          "invalid_session_input_digest",
          `Staged Session input '${input.name}' changed during image preparation`,
        );
      }
    }

    const dockerfilePath = path.join(directory, "Dockerfile");
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const coreInputNames = [
      "snapshot.json",
      "session.json",
      ...(options.brief ? ["brief.md"] : []),
    ];
    const inputFiles = coreInputNames.join(" ");
    const extraInputCopies = options.inputs
      .map(
        (input) =>
          `COPY --chown=0:0 extra-inputs/${input.name} /workspace/input/${input.name}`,
      )
      .join("\n");
    const immutableInputs = [
      ...coreInputNames,
      ...options.inputs.map((input) => input.name),
    ]
      .map((name) => `/workspace/input/${name}`)
      .join(" ");
    const sourceLayers =
      options.profile === "write"
        ? `ADD --chown=0:0 source.tar /workspace/base/
RUN chmod -R a-w /workspace/base
ADD --chown=10001:10001 source.tar /workspace/project/
RUN chown -R 10001:10001 /workspace/project`
        : "ADD --chown=10001:10001 source.tar /workspace/project/";
    await writeFile(
      dockerfilePath,
      `${dockerfile.trimEnd()}

# Session inputs come only from the verified host source context.
USER root
${sourceLayers}
COPY --chown=0:0 ${inputFiles} /workspace/input/
${extraInputCopies}
RUN chmod 0444 ${immutableInputs}
USER 10001:10001
WORKDIR /sandbox
`,
      "utf8",
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function createSessionInputDirectory(options: {
  readonly config: PiClientConfig;
  readonly brief?: Pick<CompiledBrief, "content" | "digest">;
  readonly inputs: readonly ValidatedSessionInput[];
}): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-input-"),
  );
  try {
    await writeFile(
      path.join(directory, "session.json"),
      `${JSON.stringify(options.config, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (options.brief) {
      await writeFile(path.join(directory, "brief.md"), options.brief.content, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (
        sha256(await readFile(path.join(directory, "brief.md"))) !==
        options.config.brief?.content_digest
      ) {
        throw new OrchestratorError(
          "invalid_brief_digest",
          "Staged Brief content does not match its content digest",
        );
      }
    }
    for (const input of options.inputs) {
      const stagedPath = path.join(directory, input.name);
      await writeFile(stagedPath, input.bytes, { mode: 0o600 });
      if (sha256(await readFile(stagedPath)) !== input.config.digest) {
        throw new OrchestratorError(
          "invalid_session_input_digest",
          `Staged Session input '${input.name}' changed before upload`,
        );
      }
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function uploadSessionInputs(options: {
  readonly client: ReadSessionOpenShell;
  readonly sandbox: string;
  readonly directory: string;
  readonly brief: boolean;
  readonly inputs: readonly ValidatedSessionInput[];
}): Promise<void> {
  if (!options.client.upload) {
    throw new OrchestratorError(
      "openshell_upload_unavailable",
      "Static Workspace Sessions require OpenShell immutable-input upload support",
    );
  }
  const files = [
    "session.json",
    ...(options.brief ? ["brief.md"] : []),
    ...options.inputs.map((input) => input.name),
  ];
  for (const name of files) {
    await options.client.upload(
      options.sandbox,
      path.join(options.directory, name),
      `/workspace/input/${name}`,
    );
  }
}

function generatedSandboxName(profile: AgentSessionProfile): string {
  return `pio-${profile === "read" ? "r" : "w"}-${randomBytes(4).toString("hex")}`;
}

function immutableInputVerification(
  briefContentDigest: string | undefined,
  inputs: readonly PiSessionInput[],
  hasSnapshot = true,
): string {
  return `test -r /workspace/input/session.json${hasSnapshot ? " && test -r /workspace/input/snapshot.json" : ""}${briefContentDigest ? ` && test -r /workspace/input/brief.md && test "$(sha256sum /workspace/input/brief.md | cut -d ' ' -f 1)" = "${briefContentDigest.slice("sha256:".length)}"` : ""}${inputs
    .map(
      (input) =>
        ` && test -r ${input.path} && test "$(stat -c %s ${input.path})" -eq ${input.byte_count} && test "$(sha256sum ${input.path} | cut -d ' ' -f 1)" = "${input.digest.slice("sha256:".length)}"`,
    )
    .join("")}`;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundaryVerification(
  profile: AgentSessionProfile,
  briefContentDigest: string | undefined,
  inputs: readonly PiSessionInput[],
  hasSnapshot = true,
  workspace?: ReadOnlySourceWorkspace | WritableSourceWorkspace,
): string {
  const inputChecks = immutableInputVerification(
    briefContentDigest,
    inputs,
    hasSnapshot,
  );
  if (profile === "write") {
    if (workspace instanceof WritableSourceWorkspace) {
      const writeChecks = workspace.mountSet.mounts
        .filter((mount) => mount.purpose === "write")
        .map((mount) => `test -w ${shellLiteral(mount.target)}`)
        .join(" && ");
      return `${inputChecks} && test -n "$(find /workspace/project -mindepth 1 -print -quit)" && test ! -e /workspace/project/.git && ! touch /workspace/project/.orchestrator-write-probe && ! touch /workspace/input/.orchestrator-write-probe && ${writeChecks}`;
    }
    return `${inputChecks} && test -n "$(find /workspace/base -mindepth 1 -print -quit)" && test -n "$(find /workspace/project -mindepth 1 -print -quit)" && test ! -e /workspace/base/.git && test ! -e /workspace/project/.git && ! touch /workspace/base/.orchestrator-write-probe && ! touch /workspace/input/.orchestrator-write-probe && probe_dir=$(find /workspace/project -mindepth 1 -type d -print -quit) && touch "\${probe_dir:-/workspace/project}/.orchestrator-write-probe" && rm "\${probe_dir:-/workspace/project}/.orchestrator-write-probe"`;
  }
  return `${inputChecks} && test -n "$(find /workspace/project -mindepth 1 -print -quit)" && test ! -e /workspace/project/.git && ! touch /workspace/project/.orchestrator-write-probe && ! touch /workspace/input/.orchestrator-write-probe`;
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
  readonly permissionCeiling: PermissionCeiling;
  readonly currentActionState?: CurrentActionState;
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
        permissionCeiling: options.permissionCeiling,
        ...(options.currentActionState
          ? { currentActionState: options.currentActionState }
          : {}),
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
  private releaseRequested = false;
  private linkReleased = false;
  private forwardReleased = false;
  private deleted = false;
  private running = false;

  constructor(
    private readonly client: ReadSessionCleanupOpenShell,
    private readonly forward: OpenShellForward,
    private link: HostLink,
    info: ReadSessionInfo,
    private readonly token: string,
    private readonly startupTimeoutMs: number,
    private readonly turnTimeoutMs: number,
    private readonly metrics: SessionMetricRecorder | undefined,
    private readonly task: string | undefined,
    private readonly now: () => Date,
    private readonly currentActionState: CurrentActionState | undefined,
  ) {
    this.info = info;
  }

  get identity(): SessionIdentity {
    return this.info.identity;
  }

  async ping(): Promise<string> {
    try {
      return await this.link.ping();
    } catch (error) {
      await this.recordLinkFailure("ping", error);
      throw error;
    }
  }

  async deliver(message: Message): Promise<"queued" | "duplicate"> {
    try {
      return await this.link.deliver(message);
    } catch (error) {
      await this.recordLinkFailure("deliver", error);
      throw error;
    }
  }

  async waitForEvent(
    predicate: (frame: LinkEventFrame) => boolean,
    timeoutMs?: number,
  ): Promise<LinkEventFrame> {
    try {
      return await this.link.waitForEvent(predicate, timeoutMs);
    } catch (error) {
      await this.recordLinkFailure("receive", error);
      throw error;
    }
  }

  async run(
    message: Message,
    timeoutMs = this.turnTimeoutMs,
  ): Promise<ModelTurnResult> {
    if (!this.info.model) {
      throw new OrchestratorError(
        "session_has_no_model",
        "This Session was not configured for inference",
      );
    }
    if (this.running) {
      throw new OrchestratorError(
        "session_busy",
        "A model turn is already active in this Session",
      );
    }
    this.running = true;
    const startedAt = this.now();
    try {
      try {
        await this.link.deliver(message);
        const frame = await this.link.waitForEvent((candidate) => {
          if (
            !["turn-completed", "turn-failed"].includes(candidate.payload.event)
          )
            return false;
          const ids = candidate.payload.data.message_ids;
          return Array.isArray(ids) && ids.includes(message.id);
        }, timeoutMs);
        if (frame.payload.event === "turn-failed") {
          const failure = ModelTurnFailureSchema.parse(frame.payload.data);
          this.assertTurnBinding(message.id, failure);
          throw new OrchestratorError(
            "model_turn_failed",
            `Pi model turn for Message '${message.id}' failed: ${failure.error}`,
          );
        }
        const result = ModelTurnResultSchema.parse(frame.payload.data);
        this.assertTurnBinding(message.id, result);
        await this.metrics
          ?.recordModelTurn({
            identity: this.identity,
            ...(this.task ? { task: this.task } : {}),
            model: this.info.model,
            messageIds: result.message_ids,
            outcome: "success",
            startedAt,
            endedAt: this.now(),
            usage: result.usage,
          })
          .catch(() => undefined);
        return result;
      } catch (error) {
        const endedAt = this.now();
        await this.metrics
          ?.recordModelTurn({
            identity: this.identity,
            ...(this.task ? { task: this.task } : {}),
            model: this.info.model,
            messageIds: [message.id],
            outcome: "failure",
            startedAt,
            endedAt,
            error,
          })
          .catch(() => undefined);
        if (
          error instanceof OrchestratorError &&
          (error.code.startsWith("link_") ||
            error.code === "session_startup_timeout")
        ) {
          await this.recordLinkFailure("turn", error, endedAt);
        }
        throw error;
      }
    } finally {
      this.running = false;
    }
  }

  private assertTurnBinding(
    messageId: string,
    turn: Pick<
      ModelTurnResult,
      "message_ids" | "model_profile" | "requested_model"
    >,
  ): void {
    const model = this.info.model!;
    if (
      !turn.message_ids.includes(messageId) ||
      turn.model_profile !== model.profile ||
      turn.requested_model !== model.pi_model
    ) {
      throw new OrchestratorError(
        "model_turn_binding_mismatch",
        `Pi model turn does not match Message '${messageId}' and route '${model.profile}/${model.pi_model}'`,
      );
    }
  }

  async reconnect(): Promise<void> {
    if (this.releaseRequested) {
      throw new OrchestratorError(
        "session_stopped",
        "Cannot reconnect a released Session",
      );
    }
    try {
      await this.link.close();
      this.link = await connectWithRetry({
        forward: this.forward,
        identity: this.info.identity,
        token: this.token,
        piVersion: this.info.piVersion,
        clientVersion: this.info.clientVersion,
        timeoutMs: this.startupTimeoutMs,
        permissionCeiling: this.info.permissionCeiling,
        ...(this.currentActionState
          ? { currentActionState: this.currentActionState }
          : {}),
      });
    } catch (error) {
      await this.recordLinkFailure("reconnect", error);
      throw error;
    }
  }

  private async recordLinkFailure(
    operation: Parameters<
      SessionMetricRecorder["recordLinkFailure"]
    >[0]["operation"],
    error: unknown,
    occurredAt = this.now(),
  ): Promise<void> {
    await this.metrics
      ?.recordLinkFailure({
        identity: this.identity,
        operation,
        occurredAt,
        error,
      })
      .catch(() => undefined);
  }

  private async releaseHandles(): Promise<string[]> {
    this.releaseRequested = true;
    const failures: string[] = [];
    if (!this.linkReleased) {
      try {
        await this.link.close();
        this.linkReleased = true;
      } catch (error) {
        failures.push(`Link: ${formatUnknownError(error)}`);
      }
    }
    if (!this.forwardReleased) {
      try {
        await this.forward.stop();
        this.forwardReleased = true;
      } catch (error) {
        failures.push(`forward: ${formatUnknownError(error)}`);
      }
    }
    return failures;
  }

  async release(): Promise<void> {
    const failures = await this.releaseHandles();
    if (failures.length > 0) {
      throw new OrchestratorError(
        "session_release_failed",
        failures.join("; "),
      );
    }
  }

  async stop(): Promise<void> {
    const failures = await this.releaseHandles();
    if (!this.deleted) {
      try {
        await this.client.deleteSandbox(this.info.sandbox.name, {
          missingOk: true,
        });
        this.deleted = true;
      } catch (error) {
        failures.push(`Sandbox: ${formatUnknownError(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new OrchestratorError(
        "session_cleanup_failed",
        failures.join("; "),
      );
    }
  }
}

export type WriteSession = ReadSession;

async function readSandboxJson(
  client: ResumeReadSessionOpenShell,
  sandboxName: string,
  filePath: string,
): Promise<unknown> {
  const result = await client.execSandbox(sandboxName, ["/bin/cat", filePath], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new OrchestratorError(
      "session_recovery_failed",
      `Cannot read immutable Session input '${filePath}'${diagnostic ? `: ${diagnostic.slice(0, 1_000)}` : ""}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new OrchestratorError(
      "session_recovery_failed",
      `Immutable Session input '${filePath}' is not valid JSON`,
      { cause: error },
    );
  }
}

function expectedPiModel(model: ResolvedModelRoute): PiSessionModel {
  return PiSessionModelSchema.parse(model);
}

async function resumeSession(
  options: ResumeReadSessionOptions,
  profile: AgentSessionProfile,
): Promise<ReadSession> {
  const now = options.now ?? (() => new Date());
  const identity = SessionIdentitySchema.parse(options.identity);
  const expectedSandbox = SessionSandboxSchema.parse(options.sandbox);
  const expectedPermissionCeilingDigest = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(options.permissionCeilingDigest);
  const piVersion = VersionSchema.parse(
    options.piVersion ?? PI_RUNTIME_VERSION,
  );
  const clientVersion = VersionSchema.parse(
    options.clientVersion ?? PI_CLIENT_VERSION,
  );
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60_000;
  const policyDirectory = options.policyDirectory ?? bundledPath("policies");
  const model = options.model
    ? ResolvedModelRouteSchema.parse(options.model)
    : undefined;
  const briefDigest =
    options.briefDigest === undefined
      ? undefined
      : z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .parse(options.briefDigest);
  if ((model === undefined) !== (briefDigest === undefined)) {
    throw new OrchestratorError(
      "invalid_session_input",
      "Model-routed Session recovery requires both a model route and an expected Brief digest",
    );
  }
  const context = ContextThresholdsSchema.parse(
    options.context ?? DEFAULT_CONTEXT_THRESHOLDS,
  );

  const [sandbox, preflight, policy] = await Promise.all([
    options.client.getSandbox(expectedSandbox.name),
    options.client.preflight(),
    loadSandboxPolicy(profile, path.join(policyDirectory, `${profile}.yaml`)),
  ]);
  if (
    sandbox.id !== expectedSandbox.id ||
    sandbox.name !== expectedSandbox.name ||
    sandbox.workspace !== expectedSandbox.workspace
  ) {
    throw new OrchestratorError(
      "sandbox_identity_mismatch",
      `Sandbox '${expectedSandbox.name}' no longer matches its durable Session binding`,
    );
  }
  if (sandbox.phase !== "Ready") {
    throw new OrchestratorError(
      "sandbox_not_ready",
      `Sandbox '${sandbox.name}' is ${sandbox.phase}, not Ready`,
    );
  }
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "Session recovery requires an exact OpenShell version pin",
    );
  }

  const rawConfig = await readSandboxJson(
    options.client,
    expectedSandbox.name,
    "/workspace/input/session.json",
  );
  const config = PiClientConfigSchema.parse(rawConfig);
  if (
    config.permission_ceiling.permission_ceiling_digest !==
    expectedPermissionCeilingDigest
  ) {
    throw new OrchestratorError(
      "session_permission_stale",
      "Immutable Sandbox configuration uses another permission ceiling",
    );
  }
  if (!sameSessionIdentity(config.identity, identity)) {
    throw new OrchestratorError(
      "stale_session_generation",
      "Immutable Sandbox configuration identifies another Session or generation",
    );
  }
  if (
    config.pi_version !== piVersion ||
    config.client_version !== clientVersion
  ) {
    throw new OrchestratorError(
      "link_version_mismatch",
      `Sandbox Session uses client ${config.client_version} and Pi ${config.pi_version}`,
    );
  }
  if (!config.source_digest || !config.policy_digest) {
    throw new OrchestratorError(
      "session_recovery_unsupported",
      "Sandbox Session configuration predates durable recovery metadata",
    );
  }
  if (config.profile !== profile) {
    throw new OrchestratorError(
      "session_profile_mismatch",
      `Immutable Sandbox configuration declares '${config.profile}', not '${profile}'`,
    );
  }
  if (
    options.context !== undefined &&
    canonicalJson(config.context) !== canonicalJson(context)
  ) {
    throw new OrchestratorError(
      "session_context_policy_stale",
      "Sandbox Session was created under another context-pressure policy",
    );
  }
  if (config.policy_digest !== policy.digest) {
    throw new OrchestratorError(
      "session_policy_stale",
      `Sandbox Session was created under another ${profile} policy digest`,
    );
  }

  if ((config.model === undefined) !== (model === undefined)) {
    throw new OrchestratorError(
      "model_route_mismatch",
      "Recovered Session model routing does not match the current Agent route",
    );
  }
  if (
    config.model &&
    model &&
    canonicalJson(config.model) !== canonicalJson(expectedPiModel(model))
  ) {
    throw new OrchestratorError(
      "model_route_mismatch",
      `Recovered Session route does not match '${model.profile}/${model.pi_model}'`,
    );
  }
  if (briefDigest !== undefined && config.brief?.digest !== briefDigest) {
    throw new OrchestratorError(
      "brief_digest_mismatch",
      "Recovered Session Brief does not match the expected digest",
    );
  }
  const projected = config.workspace_projection;
  if (
    (projected === undefined) !== (expectedSandbox.projection === undefined) ||
    (projected !== undefined) !== (options.workspace !== undefined)
  ) {
    throw new OrchestratorError(
      "workspace_projection_mismatch",
      "Recovered Session Workspace projection does not match durable state",
    );
  }
  if (projected && expectedSandbox.projection && options.workspace) {
    const gateway = clientGateway(options.client);
    if (
      profile !== "read" ||
      canonicalJson(projected) !== canonicalJson(expectedSandbox.projection) ||
      !(options.workspace instanceof ReadOnlySourceWorkspace) ||
      projected.source_digest !== options.workspace.manifest.source_digest ||
      projected.workspace_generation !==
        options.workspace.manifest.workspace_generation ||
      projected.manifest_digest !==
        options.workspace.manifest.manifest_digest ||
      projected.volume_name !== options.workspace.volume.name ||
      projected.volume_digest !== options.workspace.volume.digest ||
      projected.mount_set_digest !== options.workspace.mountSet.digest ||
      projected.image_digest !== options.workspace.imageDigest ||
      projected.projection_digest !== options.workspace.projectionDigest
    ) {
      throw new OrchestratorError(
        "workspace_projection_mismatch",
        "Recovered Session uses another Workspace source or projection capability",
      );
    }
    await options.workspace.verify();
    if (
      !gateway ||
      !options.client.listGateways ||
      !options.client.getGatewayInfo
    ) {
      throw new OrchestratorError(
        "workspace_gateway_uninspectable",
        "Workspace recovery requires inspectable local OpenShell gateway provenance",
      );
    }
    await verifyWorkspaceGateway(
      options.workspace,
      {
        gateway,
        listGateways: options.client.listGateways.bind(options.client),
        getGatewayInfo: options.client.getGatewayInfo.bind(options.client),
      },
      preflight,
    );
    const mountInfo = await options.client.execSandbox(
      expectedSandbox.name,
      ["/usr/bin/cat", "/proc/self/mountinfo"],
      { timeoutMs: 10_000 },
    );
    if (mountInfo.exitCode !== 0) {
      throw new OrchestratorError(
        "mount_table_unavailable",
        `Cannot inspect recovered Workspace mounts: ${mountInfo.stderr.trim() || mountInfo.stdout.trim()}`,
      );
    }
    const evidence = validateOpenShellMountTable(
      mountInfo.stdout,
      options.workspace.mountSet,
    );
    if (evidence.selectedDigest !== projected.mount_table_digest) {
      throw new OrchestratorError(
        "mount_table_mismatch",
        "Recovered Workspace mount table changed from durable Session evidence",
      );
    }
  }
  await requireSuccess(
    "immutable Session input verification",
    options.client.execSandbox(
      expectedSandbox.name,
      [
        "/bin/sh",
        "-c",
        immutableInputVerification(
          config.brief?.content_digest,
          config.inputs,
          projected === undefined,
        ),
      ],
      { timeoutMs: 10_000 },
    ),
  );
  if (model && !options.client.getInferenceRoute) {
    throw new OrchestratorError(
      "openshell_inference_unavailable",
      "The OpenShell adapter cannot inspect the configured inference route",
    );
  }
  const inference = model
    ? await options.client.getInferenceRoute!()
    : undefined;
  if (model) {
    if (preflight.status.gateway !== model.gateway) {
      throw new OrchestratorError(
        "model_gateway_mismatch",
        `Model Profile '${model.profile}' resolved to gateway '${model.gateway}', but the recovery client reached '${preflight.status.gateway}'`,
      );
    }
    if (inference?.model !== model.pi_model) {
      throw new OrchestratorError(
        "model_route_mismatch",
        `OpenShell gateway '${model.gateway}' routes '${inference?.model ?? "nothing"}', not '${model.pi_model}'`,
      );
    }
  }

  let forward: OpenShellForward | undefined;
  let link: HostLink | undefined;
  try {
    forward = await options.client.startServiceForward({
      sandboxName: sandbox.name,
      targetPort: config.listen.port,
      readyTimeoutMs: 10_000,
    });
    link = await connectWithRetry({
      forward,
      identity,
      token: config.token,
      piVersion,
      clientVersion,
      timeoutMs: startupTimeoutMs,
      permissionCeiling: config.permission_ceiling,
      ...(options.currentActionState
        ? { currentActionState: options.currentActionState }
        : {}),
    });
    if (model && !link.peer.capabilities.includes("events")) {
      throw new OrchestratorError(
        "link_capability_mismatch",
        "A model-routed Session requires Link event delivery",
      );
    }
    return new ReadSession(
      options.client,
      forward,
      link,
      {
        sandbox: projected ? { ...sandbox, projection: projected } : sandbox,
        identity,
        sourceDigest: config.source_digest,
        profile,
        permissionCeiling: config.permission_ceiling,
        policyDigest: config.policy_digest,
        readPolicyDigest: config.policy_digest,
        openshell: preflight,
        piVersion,
        clientVersion,
        context: config.context,
        ...(model ? { model } : {}),
        ...(inference ? { inference } : {}),
        ...(config.brief ? { briefDigest: config.brief.digest } : {}),
        inputs: config.inputs,
        ...(projected ? { workspaceProjection: projected } : {}),
      },
      config.token,
      startupTimeoutMs,
      turnTimeoutMs,
      options.metrics,
      options.task,
      now,
      options.currentActionState,
    );
  } catch (error) {
    await options.metrics
      ?.recordLinkFailure({
        identity,
        operation: "connect",
        occurredAt: now(),
        error,
      })
      .catch(() => undefined);
    await link?.close().catch(() => undefined);
    await forward?.stop().catch(() => undefined);
    throw error;
  }
}

export function resumeReadSession(
  options: ResumeReadSessionOptions,
): Promise<ReadSession> {
  return resumeSession(options, "read");
}

export function resumeWriteSession(
  options: ResumeWriteSessionOptions,
): Promise<ReadSession> {
  return resumeSession(options, "write");
}

async function startSession(
  options: StartReadSessionOptions | StartWriteSessionOptions,
  profile: AgentSessionProfile,
): Promise<ReadSession> {
  const now = options.now ?? (() => new Date());
  const source = await verifiedSessionSource(options, profile);
  const inputs = validateSessionInputs(options.inputs);
  const identity = SessionIdentitySchema.parse(options.identity);
  const permissionCeiling = PermissionCeilingSchema.parse(
    options.permissionCeiling,
  );
  if (permissionCeiling.source !== "read") {
    throw new OrchestratorError(
      "permission_denied",
      `Role '${permissionCeiling.role}' cannot receive Project source`,
    );
  }
  if (profile === "write") {
    if (!hasWriteGrant(options)) {
      throw new OrchestratorError(
        "write_grant_required",
        "A writable Sandbox requires an exact trusted Task write grant",
      );
    }
    requireWritableGrant(permissionCeiling, options.writeGrant.task);
  }
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
  const turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60_000;
  const model = options.model
    ? ResolvedModelRouteSchema.parse(options.model)
    : undefined;
  const context = ContextThresholdsSchema.parse(
    options.context ?? DEFAULT_CONTEXT_THRESHOLDS,
  );
  if ((model === undefined) !== (options.brief === undefined)) {
    throw new OrchestratorError(
      "invalid_session_input",
      "A model-routed Session requires both a model route and a compiled Brief",
    );
  }
  if (
    options.brief &&
    "binding" in options.brief &&
    digestParts("pi-orchestrator/brief/v2", [
      ["content", options.brief.content],
      ["binding", canonicalJson(options.brief.binding)],
    ]) !== options.brief.digest
  ) {
    throw new OrchestratorError(
      "invalid_brief_digest",
      "Compiled Brief content does not match its digest",
    );
  }
  if (source.kind === "workspace-projection" && options.imageContext) {
    throw new OrchestratorError(
      "invalid_pi_image",
      "Shared Workspace Sessions use only their configured pinned static image",
    );
  }
  const image = options.imageContext ?? bundledPiImageContext();
  const policyDirectory = options.policyDirectory ?? bundledPath("policies");
  if (model && !options.client.getInferenceRoute) {
    throw new OrchestratorError(
      "openshell_inference_unavailable",
      "The OpenShell adapter cannot inspect the configured inference route",
    );
  }
  const [policy, preflight] = await Promise.all([
    loadSandboxPolicy(profile, path.join(policyDirectory, `${profile}.yaml`)),
    options.client.preflight(),
  ]);
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "A Pi Session requires an exact OpenShell version pin",
    );
  }
  const inference = model
    ? await options.client.getInferenceRoute!()
    : undefined;
  if (model) {
    if (preflight.status.gateway !== model.gateway) {
      throw new OrchestratorError(
        "model_gateway_mismatch",
        `Model Profile '${model.profile}' resolved to gateway '${model.gateway}', but the Session client reached '${preflight.status.gateway}'`,
      );
    }
    if (inference?.model !== model.pi_model) {
      throw new OrchestratorError(
        "model_route_mismatch",
        `OpenShell gateway '${model.gateway}' routes '${inference?.model ?? "nothing"}', not '${model.pi_model}'`,
      );
    }
  }

  if (source.kind === "workspace-projection") {
    const gateway = clientGateway(options.client);
    if (
      !gateway ||
      !options.client.listGateways ||
      !options.client.getGatewayInfo
    ) {
      throw new OrchestratorError(
        "workspace_gateway_uninspectable",
        "Shared Workspace Sessions require inspectable local OpenShell gateway provenance",
      );
    }
    const gatewayEvidence = await verifyWorkspaceGateway(
      source.workspace,
      {
        gateway,
        listGateways: options.client.listGateways.bind(options.client),
        getGatewayInfo: options.client.getGatewayInfo.bind(options.client),
      },
      preflight,
    );
    if (
      source.workspace instanceof WritableSourceWorkspace &&
      gatewayEvidence.digest !== source.workspace.gatewayDigest
    ) {
      throw new OrchestratorError(
        "workspace_gateway_mismatch",
        "Writable Workspace lease is bound to another gateway capability",
      );
    }
  }

  const token = randomBytes(32).toString("hex");
  const sessionConfig = (
    workspaceProjection?: SessionWorkspaceProjection,
  ): PiClientConfig =>
    PiClientConfigSchema.parse({
      version: PI_CLIENT_CONFIG_VERSION,
      identity,
      token,
      listen: { host: "127.0.0.1", port: linkPort },
      client_version: clientVersion,
      pi_version: piVersion,
      profile,
      permission_ceiling: permissionCeiling,
      context,
      source_digest: source.sourceDigest,
      policy_digest: policy.digest,
      inputs: inputs.map((input) => input.config),
      ...(workspaceProjection
        ? { workspace_projection: workspaceProjection }
        : {}),
      ...(model
        ? {
            model,
            brief: {
              path: "/workspace/input/brief.md" as const,
              digest: options.brief!.digest,
              content_digest: sha256(options.brief!.content),
            },
          }
        : {}),
    });
  const sandboxName = options.sandboxName ?? generatedSandboxName(profile);

  let sandbox: OpenShellSandbox | undefined;
  let forward: OpenShellForward | undefined;
  let link: HostLink | undefined;
  let config: PiClientConfig | undefined;
  let stagingDirectory: string | undefined;
  const startupStartedAt = now();
  try {
    if (source.kind === "workspace-projection") {
      const writable = source.workspace instanceof WritableSourceWorkspace;
      sandbox = await options.client.createSandbox({
        name: sandboxName,
        from: source.workspace.image,
        policyPath: policy.path,
        mountSet: source.workspace.mountSet,
        labels: {
          "pio.purpose": writable ? "write-session" : "read-session",
          "pio.run": identity.run,
          "pio.access": writable ? "write" : "read",
          "pio.volume": source.workspace.volume.digest.slice(
            "sha256:".length,
            62,
          ),
          ...(writable
            ? {
                "pio.lease": source.workspace.lease.digest.slice(
                  "sha256:".length,
                  62,
                ),
              }
            : {}),
          "pio.projection": source.workspace.projectionDigest.slice(
            "sha256:".length,
            55,
          ),
        },
        command: ["/usr/bin/true"],
      });
    } else {
      config = sessionConfig();
      stagingDirectory = await createSessionImageContext({
        image,
        source,
        config,
        profile,
        inputs,
        ...(options.brief ? { brief: options.brief } : {}),
      });
      sandbox = await options.client.createSandbox({
        name: sandboxName,
        from: stagingDirectory,
        policyPath: policy.path,
        command: ["/usr/bin/true"],
      });
    }
    if (sandbox.phase !== "Ready") {
      sandbox = await options.client.waitForSandbox(sandboxName);
    }

    let workspaceProjection: SessionWorkspaceProjection | undefined;
    if (source.kind === "workspace-projection") {
      const mountInfo = await options.client.execSandbox(
        sandboxName,
        ["/usr/bin/cat", "/proc/self/mountinfo"],
        { timeoutMs: 10_000 },
      );
      if (mountInfo.exitCode !== 0) {
        throw new OrchestratorError(
          "mount_table_unavailable",
          `Cannot inspect Workspace mounts: ${mountInfo.stderr.trim() || mountInfo.stdout.trim()}`,
        );
      }
      const evidence = validateOpenShellMountTable(
        mountInfo.stdout,
        source.workspace.mountSet,
      );
      const baseProjection = {
        source_digest: source.workspace.manifest.source_digest,
        workspace_generation: source.workspace.manifest.workspace_generation,
        manifest_digest: source.workspace.manifest.manifest_digest,
        volume_name: source.workspace.volume.name,
        volume_digest: source.workspace.volume.digest,
        mount_set_digest: source.workspace.mountSet.digest,
        mount_table_digest: evidence.selectedDigest,
        image_digest: source.workspace.imageDigest,
        projection_digest: source.workspace.projectionDigest,
      };
      workspaceProjection =
        source.workspace instanceof WritableSourceWorkspace
          ? WritableWorkspaceSessionProjectionSchema.parse({
              ...baseProjection,
              lease_id: source.workspace.lease.id,
              lease_digest: source.workspace.lease.digest,
              write_roots_digest: source.workspace.lease.write_roots_digest,
              gateway_digest: source.workspace.gatewayDigest,
            })
          : WorkspaceSessionProjectionSchema.parse(baseProjection);
      config = sessionConfig(workspaceProjection);
      stagingDirectory = await createSessionInputDirectory({
        config,
        inputs,
        ...(options.brief ? { brief: options.brief } : {}),
      });
      await uploadSessionInputs({
        client: options.client,
        sandbox: sandboxName,
        directory: stagingDirectory,
        brief: !!options.brief,
        inputs,
      });
    }
    if (!config) {
      throw new OrchestratorError(
        "session_bootstrap_failed",
        "Session immutable configuration was not prepared",
      );
    }

    await requireSuccess(
      `${profile} boundary verification`,
      options.client.execSandbox(
        sandboxName,
        [
          "/bin/sh",
          "-c",
          boundaryVerification(
            profile,
            config.brief?.content_digest,
            config.inputs,
            source.kind !== "workspace-projection",
            source.kind === "workspace-projection"
              ? source.workspace
              : undefined,
          ),
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
      permissionCeiling,
      ...(options.currentActionState
        ? { currentActionState: options.currentActionState }
        : {}),
    });
    if (model && !link.peer.capabilities.includes("events")) {
      throw new OrchestratorError(
        "link_capability_mismatch",
        "A model-routed Session requires Link event delivery",
      );
    }
    const runtime = new ReadSession(
      options.client,
      forward,
      link,
      {
        sandbox: workspaceProjection
          ? { ...sandbox, projection: workspaceProjection }
          : sandbox,
        identity,
        sourceDigest: source.sourceDigest,
        profile,
        permissionCeiling,
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight,
        piVersion,
        clientVersion,
        context: config.context,
        ...(model ? { model } : {}),
        ...(inference ? { inference } : {}),
        ...(options.brief ? { briefDigest: options.brief.digest } : {}),
        inputs: config.inputs,
        ...(workspaceProjection ? { workspaceProjection } : {}),
      },
      token,
      startupTimeoutMs,
      turnTimeoutMs,
      options.metrics,
      options.task,
      now,
      options.currentActionState,
    );
    await options.metrics?.recordSandboxStartup({
      identity,
      profile,
      ...(model ? { model } : {}),
      outcome: "success",
      startedAt: startupStartedAt,
      endedAt: now(),
    });
    return runtime;
  } catch (error) {
    await options.metrics
      ?.recordSandboxStartup({
        identity,
        profile,
        ...(model ? { model } : {}),
        outcome: "failure",
        startedAt: startupStartedAt,
        endedAt: now(),
        error,
      })
      .catch(() => undefined);
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
    if (stagingDirectory) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

export function startReadSession(
  options: StartReadSessionOptions,
): Promise<ReadSession> {
  return startSession(options, "read");
}

export function startWriteSession(
  options: StartWriteSessionOptions,
): Promise<ReadSession> {
  return startSession(options, "write");
}
