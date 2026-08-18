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
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { HostLink, TcpLinkTransport } from "./link.js";
import { VersionSchema } from "./local.js";
import type { Message } from "./message.js";
import { ResolvedModelRouteSchema, type ResolvedModelRoute } from "./model.js";
import type {
  OpenShellClient,
  OpenShellForward,
  OpenShellInferenceRoute,
  OpenShellPreflight,
  OpenShellSandbox,
} from "./openshell.js";
import { loadSandboxPolicy } from "./policy.js";
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
export const PI_CLIENT_VERSION = "0.2.1";
export const PI_LINK_PORT = 41_727;

export const PiSessionModelSchema = z
  .object({
    alias: z.enum(["plan", "code", "quant", "review", "fast"]),
    pi_model: z.string().min(1).max(256),
    api: z.enum([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
    ]),
    context_window: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    reasoning: z.boolean(),
  })
  .strict()
  .refine((model) => model.max_tokens <= model.context_window, {
    message: "max_tokens must not exceed context_window",
    path: ["max_tokens"],
  });
export type PiSessionModel = z.infer<typeof PiSessionModelSchema>;

const PiSessionBriefSchema = z
  .object({
    path: z.literal("/workspace/input/brief.md"),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
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
    profile: z.enum(["read", "write"]).default("read"),
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
  Partial<Pick<OpenShellClient, "getInferenceRoute">>;

export type WriteSessionOpenShell = ReadSessionOpenShell;

export type ResumeReadSessionOpenShell = Pick<
  OpenShellClient,
  | "deleteSandbox"
  | "execSandbox"
  | "getSandbox"
  | "preflight"
  | "startServiceForward"
> &
  Partial<Pick<OpenShellClient, "getInferenceRoute">>;

export type ResumeWriteSessionOpenShell = ResumeReadSessionOpenShell;

type ReadSessionCleanupOpenShell = Pick<OpenShellClient, "deleteSandbox">;

interface StartSessionOptions {
  readonly client: ReadSessionOpenShell;
  readonly identity: SessionIdentity;
  readonly imageContext?: string;
  readonly policyDirectory?: string;
  readonly sandboxName?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly linkPort?: number;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly model?: ResolvedModelRoute;
  readonly brief?: Pick<CompiledBrief, "content" | "digest">;
  readonly inputs?: readonly SessionInput[];
}

export type StartReadSessionOptions = StartSessionOptions &
  (
    | {
        readonly snapshot: SourceSnapshot;
        readonly workspaceSource?: never;
      }
    | {
        readonly snapshot?: never;
        readonly workspaceSource: WorkspaceSessionSource;
      }
  );

export type StartWriteSessionOptions = StartSessionOptions & {
  readonly snapshot: SourceSnapshot;
  readonly workspaceSource?: never;
};

export interface ResumeReadSessionOptions {
  readonly client: ResumeReadSessionOpenShell;
  readonly identity: SessionIdentity;
  readonly sandbox: SessionSandbox;
  readonly policyDirectory?: string;
  readonly piVersion?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly model?: ResolvedModelRoute;
  readonly briefDigest?: string;
}

export type ResumeWriteSessionOptions = ResumeReadSessionOptions;

export type AgentSessionProfile = "read" | "write";

export interface ReadSessionInfo {
  readonly sandbox: OpenShellSandbox;
  readonly identity: SessionIdentity;
  readonly sourceDigest: string;
  readonly profile: AgentSessionProfile;
  readonly policyDigest: string;
  readonly readPolicyDigest: string;
  readonly openshell: OpenShellPreflight;
  readonly piVersion: string;
  readonly clientVersion: string;
  readonly model?: ResolvedModelRoute;
  readonly inference?: OpenShellInferenceRoute;
  readonly briefDigest?: string;
  readonly inputs: readonly PiSessionInput[];
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
  options: StartReadSessionOptions,
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
  const manifest = await verifySourceSnapshot(options.snapshot);
  return {
    kind: "snapshot",
    archivePath: options.snapshot.archivePath,
    manifestPath: options.snapshot.manifestPath,
    manifest,
    sourceDigest: manifest.source_digest,
  };
}

async function createSessionImageContext(options: {
  readonly image: string;
  readonly source: VerifiedSessionSource;
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

function generatedSandboxName(profile: AgentSessionProfile): string {
  return `pio-${profile === "read" ? "r" : "w"}-${randomBytes(4).toString("hex")}`;
}

function immutableInputVerification(
  hasBrief: boolean,
  inputs: readonly PiSessionInput[],
): string {
  return `test -r /workspace/input/session.json && test -r /workspace/input/snapshot.json${hasBrief ? " && test -r /workspace/input/brief.md" : ""}${inputs
    .map(
      (input) =>
        ` && test -r ${input.path} && test "$(stat -c %s ${input.path})" -eq ${input.byte_count} && test "$(sha256sum ${input.path} | cut -d ' ' -f 1)" = "${input.digest.slice("sha256:".length)}"`,
    )
    .join("")}`;
}

function boundaryVerification(
  profile: AgentSessionProfile,
  hasBrief: boolean,
  inputs: readonly PiSessionInput[],
): string {
  const inputChecks = immutableInputVerification(hasBrief, inputs);
  if (profile === "write") {
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
  ) {
    this.info = info;
  }

  get identity(): SessionIdentity {
    return this.info.identity;
  }

  ping(): Promise<string> {
    return this.link.ping();
  }

  deliver(message: Message): Promise<"queued" | "duplicate"> {
    return this.link.deliver(message);
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
      return result;
    } finally {
      this.running = false;
    }
  }

  private assertTurnBinding(
    messageId: string,
    turn: Pick<
      ModelTurnResult,
      "message_ids" | "model_alias" | "requested_model"
    >,
  ): void {
    const model = this.info.model!;
    if (
      !turn.message_ids.includes(messageId) ||
      turn.model_alias !== model.alias ||
      turn.requested_model !== model.pi_model
    ) {
      throw new OrchestratorError(
        "model_turn_binding_mismatch",
        `Pi model turn does not match Message '${messageId}' and route '${model.alias}/${model.pi_model}'`,
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
  return PiSessionModelSchema.parse({
    alias: model.alias,
    pi_model: model.pi_model,
    api: model.api,
    context_window: model.context_window,
    max_tokens: model.max_tokens,
    reasoning: model.reasoning,
  });
}

async function resumeSession(
  options: ResumeReadSessionOptions,
  profile: AgentSessionProfile,
): Promise<ReadSession> {
  const identity = SessionIdentitySchema.parse(options.identity);
  const expectedSandbox = SessionSandboxSchema.parse(options.sandbox);
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
  if (!sameSessionIdentity(config.identity, identity)) {
    throw new OrchestratorError(
      "stale_session_epoch",
      "Immutable Sandbox configuration identifies another Session or epoch",
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
  if (config.policy_digest !== policy.digest) {
    throw new OrchestratorError(
      "session_policy_stale",
      `Sandbox Session was created under another ${profile} policy digest`,
    );
  }

  if ((config.model === undefined) !== (model === undefined)) {
    throw new OrchestratorError(
      "model_route_mismatch",
      "Recovered Session model routing does not match the current Seat route",
    );
  }
  if (
    config.model &&
    model &&
    canonicalJson(config.model) !== canonicalJson(expectedPiModel(model))
  ) {
    throw new OrchestratorError(
      "model_route_mismatch",
      `Recovered Session route does not match '${model.alias}/${model.pi_model}'`,
    );
  }
  if (briefDigest !== undefined && config.brief?.digest !== briefDigest) {
    throw new OrchestratorError(
      "brief_digest_mismatch",
      "Recovered Session Brief does not match the expected digest",
    );
  }
  await requireSuccess(
    "immutable Session input verification",
    options.client.execSandbox(
      expectedSandbox.name,
      [
        "/bin/sh",
        "-c",
        immutableInputVerification(config.brief !== undefined, config.inputs),
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
        `Model alias '${model.alias}' resolved to gateway '${model.gateway}', but the recovery client reached '${preflight.status.gateway}'`,
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
        sandbox,
        identity,
        sourceDigest: config.source_digest,
        profile,
        policyDigest: config.policy_digest,
        readPolicyDigest: config.policy_digest,
        openshell: preflight,
        piVersion,
        clientVersion,
        ...(model ? { model } : {}),
        ...(inference ? { inference } : {}),
        ...(config.brief ? { briefDigest: config.brief.digest } : {}),
        inputs: config.inputs,
      },
      config.token,
      startupTimeoutMs,
      turnTimeoutMs,
    );
  } catch (error) {
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
  options: StartReadSessionOptions,
  profile: AgentSessionProfile,
): Promise<ReadSession> {
  const source = await verifiedSessionSource(options, profile);
  const inputs = validateSessionInputs(options.inputs);
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
  const turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60_000;
  const model = options.model
    ? ResolvedModelRouteSchema.parse(options.model)
    : undefined;
  if ((model === undefined) !== (options.brief === undefined)) {
    throw new OrchestratorError(
      "invalid_session_input",
      "A model-routed Session requires both a model route and a compiled Brief",
    );
  }
  if (
    options.brief &&
    digestParts("pi-orchestrator/brief/v1", [
      ["brief.md", options.brief.content],
    ]) !== options.brief.digest
  ) {
    throw new OrchestratorError(
      "invalid_brief_digest",
      "Compiled Brief content does not match its digest",
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
        `Model alias '${model.alias}' resolved to gateway '${model.gateway}', but the Session client reached '${preflight.status.gateway}'`,
      );
    }
    if (inference?.model !== model.pi_model) {
      throw new OrchestratorError(
        "model_route_mismatch",
        `OpenShell gateway '${model.gateway}' routes '${inference?.model ?? "nothing"}', not '${model.pi_model}'`,
      );
    }
  }

  const token = randomBytes(32).toString("hex");
  const config = PiClientConfigSchema.parse({
    version: 1,
    identity,
    token,
    listen: { host: "127.0.0.1", port: linkPort },
    client_version: clientVersion,
    pi_version: piVersion,
    profile,
    source_digest: source.sourceDigest,
    policy_digest: policy.digest,
    inputs: inputs.map((input) => input.config),
    ...(model
      ? {
          model: {
            alias: model.alias,
            pi_model: model.pi_model,
            api: model.api,
            context_window: model.context_window,
            max_tokens: model.max_tokens,
            reasoning: model.reasoning,
          },
          brief: {
            path: "/workspace/input/brief.md" as const,
            digest: options.brief!.digest,
          },
        }
      : {}),
  });
  const sandboxName = options.sandboxName ?? generatedSandboxName(profile);
  const imageContext = await createSessionImageContext({
    image,
    source,
    config,
    profile,
    inputs,
    ...(options.brief ? { brief: options.brief } : {}),
  });

  let sandbox: OpenShellSandbox | undefined;
  let forward: OpenShellForward | undefined;
  let link: HostLink | undefined;
  try {
    sandbox = await options.client.createSandbox({
      name: sandboxName,
      from: imageContext,
      policyPath: policy.path,
      command: ["/usr/bin/true"],
    });
    if (sandbox.phase !== "Ready") {
      sandbox = await options.client.waitForSandbox(sandboxName);
    }

    await requireSuccess(
      `${profile} boundary verification`,
      options.client.execSandbox(
        sandboxName,
        [
          "/bin/sh",
          "-c",
          boundaryVerification(profile, !!options.brief, config.inputs),
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
        sandbox,
        identity,
        sourceDigest: source.sourceDigest,
        profile,
        policyDigest: policy.digest,
        readPolicyDigest: policy.digest,
        openshell: preflight,
        piVersion,
        clientVersion,
        ...(model ? { model } : {}),
        ...(inference ? { inference } : {}),
        ...(options.brief ? { briefDigest: options.brief.digest } : {}),
        inputs: config.inputs,
      },
      token,
      startupTimeoutMs,
      turnTimeoutMs,
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
