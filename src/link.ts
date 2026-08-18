import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { OrchestratorError } from "./error.js";
import type { Message } from "./message.js";
import {
  sameSessionIdentity,
  SessionIdentitySchema,
  type SessionIdentity,
} from "./session.js";
import {
  LinkFrameSchema,
  LinkTokenSchema,
  MAX_LINK_FRAME_BYTES,
  type LinkFrame,
  type LinkTransport,
} from "./transport.js";

export interface TcpLinkTransportOptions {
  readonly host?: string;
  readonly port: number;
  readonly maxFrameBytes?: number;
}

export class LinkFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = MAX_LINK_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new OrchestratorError(
        "invalid_link_limit",
        "Link frame limit must be a positive integer",
      );
    }
  }

  push(chunk: Uint8Array): LinkFrame[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: LinkFrame[] = [];

    while (true) {
      const delimiter = this.buffer.indexOf(0x0a);
      if (delimiter < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          throw new OrchestratorError(
            "link_frame_too_large",
            `Link frame exceeds ${this.maxFrameBytes} bytes`,
          );
        }
        return frames;
      }
      if (delimiter === 0) {
        throw new OrchestratorError(
          "invalid_link_frame",
          "Link protocol does not permit empty records",
        );
      }
      if (delimiter > this.maxFrameBytes) {
        throw new OrchestratorError(
          "link_frame_too_large",
          `Link frame exceeds ${this.maxFrameBytes} bytes`,
        );
      }

      const record = this.buffer.subarray(0, delimiter);
      this.buffer = this.buffer.subarray(delimiter + 1);
      if (record.at(-1) === 0x0d) {
        throw new OrchestratorError(
          "invalid_link_frame",
          "Link protocol requires LF delimiters, not CRLF",
        );
      }

      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(record);
      } catch (error) {
        throw new OrchestratorError(
          "invalid_link_frame",
          "Link record is not valid UTF-8",
          { cause: error },
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch (error) {
        throw new OrchestratorError(
          "invalid_link_frame",
          "Link record is not valid JSON",
          { cause: error },
        );
      }
      const parsed = LinkFrameSchema.safeParse(value);
      if (!parsed.success) {
        throw new OrchestratorError(
          "invalid_link_frame",
          `Link record violates the protocol: ${parsed.error.message}`,
        );
      }
      frames.push(parsed.data);
    }
  }

  end(): void {
    if (this.buffer.length !== 0) {
      throw new OrchestratorError(
        "truncated_link_frame",
        "Link closed with a partial frame",
      );
    }
  }
}

export function encodeLinkFrame(frame: LinkFrame): Buffer {
  const parsed = LinkFrameSchema.parse(frame);
  const encoded = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (encoded.length - 1 > MAX_LINK_FRAME_BYTES) {
    throw new OrchestratorError(
      "link_frame_too_large",
      `Link frame exceeds ${MAX_LINK_FRAME_BYTES} bytes`,
    );
  }
  return encoded;
}

function abortError(): OrchestratorError {
  return new OrchestratorError("link_aborted", "Link operation was aborted");
}

export class TcpLinkTransport implements LinkTransport {
  readonly name = "tcp-loopback";
  private readonly host: string;
  private readonly port: number;
  private readonly maxFrameBytes: number;
  private socket: Socket | undefined;
  private receiving = false;

  constructor(options: TcpLinkTransportOptions) {
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1") {
      throw new OrchestratorError(
        "invalid_link_endpoint",
        "The host Link listener must use 127.0.0.1",
      );
    }
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535
    ) {
      throw new OrchestratorError(
        "invalid_link_endpoint",
        "Link port must be between 1 and 65535",
      );
    }
    this.port = options.port;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_LINK_FRAME_BYTES;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket) {
      throw new OrchestratorError("link_state", "Link is already connected");
    }
    if (signal?.aborted) throw abortError();

    const socket = createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", connected);
        socket.off("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const connected = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        this.socket = undefined;
        reject(
          new OrchestratorError("link_connect_failed", error.message, {
            cause: error,
          }),
        );
      };
      const aborted = () => {
        cleanup();
        socket.destroy();
        this.socket = undefined;
        reject(abortError());
      };
      socket.once("connect", connected);
      socket.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async send(frame: LinkFrame, signal?: AbortSignal): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new OrchestratorError("link_disconnected", "Link is not connected");
    }
    if (signal?.aborted) throw abortError();
    const encoded = encodeLinkFrame(frame);
    if (socket.write(encoded)) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("drain", drained);
        socket.off("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(
          new OrchestratorError("link_send_failed", error.message, {
            cause: error,
          }),
        );
      };
      const aborted = () => {
        cleanup();
        reject(abortError());
      };
      socket.once("drain", drained);
      socket.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async *receive(signal?: AbortSignal): AsyncIterable<LinkFrame> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new OrchestratorError("link_disconnected", "Link is not connected");
    }
    if (this.receiving) {
      throw new OrchestratorError(
        "link_state",
        "Link frames already have an active consumer",
      );
    }
    this.receiving = true;
    const decoder = new LinkFrameDecoder(this.maxFrameBytes);
    const aborted = () => socket.destroy(abortError());
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      for await (const chunk of socket) {
        for (const frame of decoder.push(chunk as Buffer)) yield frame;
      }
      decoder.end();
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(
        "link_receive_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      signal?.removeEventListener("abort", aborted);
      this.receiving = false;
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.destroyed) return;
    socket.end();
    await Promise.race([
      new Promise<void>((resolve) => socket.once("close", () => resolve())),
      sleep(1_000).then(() => socket.destroy()),
    ]);
  }
}

export interface HostLinkOptions {
  readonly transport: LinkTransport;
  readonly identity: SessionIdentity;
  readonly token: string;
  readonly expectedClientVersion: string;
  readonly expectedPiVersion: string;
  readonly timeoutMs?: number;
  readonly onEvent?: (frame: Extract<LinkFrame, { type: "event" }>) => void;
}

export interface LinkPeer {
  readonly clientVersion: string;
  readonly piVersion: string;
  readonly capabilities: readonly ("deliver" | "ping")[];
}

export class HostLink {
  readonly identity: SessionIdentity;
  readonly peer: LinkPeer;
  private readonly iterator: AsyncIterator<LinkFrame>;
  private readonly abort = new AbortController();
  private busy = false;
  private closed = false;

  private constructor(
    private readonly options: HostLinkOptions,
    iterator: AsyncIterator<LinkFrame>,
    peer: LinkPeer,
  ) {
    this.identity = SessionIdentitySchema.parse(options.identity);
    this.iterator = iterator;
    this.peer = peer;
  }

  static async connect(options: HostLinkOptions): Promise<HostLink> {
    const identity = SessionIdentitySchema.parse(options.identity);
    const token = LinkTokenSchema.parse(options.token);
    const timeoutMs = options.timeoutMs ?? 10_000;
    await options.transport.connect();
    const iterator = options.transport.receive()[Symbol.asyncIterator]();
    const helloId = `hello-${randomUUID()}`;
    try {
      await options.transport.send({
        version: 1,
        id: helloId,
        identity,
        type: "hello",
        payload: { token },
      });
      const ready = await nextFrame(iterator, timeoutMs);
      if (!sameSessionIdentity(ready.identity, identity)) {
        throw new OrchestratorError(
          "stale_session_epoch",
          "Link peer returned another Session identity or epoch",
        );
      }
      if (ready.type === "error") throw remoteError(ready);
      if (ready.type !== "ready" || ready.payload.reply_to !== helloId) {
        throw new OrchestratorError(
          "invalid_link_handshake",
          "Link peer did not acknowledge the hello frame",
        );
      }
      if (
        ready.payload.client_version !== options.expectedClientVersion ||
        ready.payload.pi_version !== options.expectedPiVersion
      ) {
        throw new OrchestratorError(
          "link_version_mismatch",
          `Link peer uses client ${ready.payload.client_version} and Pi ${ready.payload.pi_version}`,
        );
      }
      if (
        !ready.payload.capabilities.includes("deliver") ||
        !ready.payload.capabilities.includes("ping")
      ) {
        throw new OrchestratorError(
          "link_capability_mismatch",
          "Link peer does not provide the required deliver and ping capabilities",
        );
      }
      return new HostLink(options, iterator, {
        clientVersion: ready.payload.client_version,
        piVersion: ready.payload.pi_version,
        capabilities: ready.payload.capabilities,
      });
    } catch (error) {
      await options.transport.close().catch(() => undefined);
      throw error;
    }
  }

  async ping(): Promise<string> {
    const nonce = randomBytes(16).toString("hex");
    const response = await this.exchange({
      version: 1,
      id: `ping-${randomUUID()}`,
      identity: this.identity,
      type: "ping",
      payload: { nonce },
    });
    if (response.type !== "pong" || response.payload.nonce !== nonce) {
      throw new OrchestratorError(
        "invalid_link_response",
        "Link peer returned an invalid ping response",
      );
    }
    return nonce;
  }

  async deliver(message: Message): Promise<"queued" | "duplicate"> {
    if (
      message.run !== this.identity.run ||
      message.to.seat !== this.identity.seat ||
      (message.to.session !== undefined &&
        message.to.session !== this.identity.session) ||
      (message.to.epoch !== undefined &&
        message.to.epoch !== this.identity.epoch)
    ) {
      throw new OrchestratorError(
        "stale_session_epoch",
        `Message '${message.id}' does not target the active Session`,
      );
    }
    const response = await this.exchange({
      version: 1,
      id: `deliver-${randomUUID()}`,
      identity: this.identity,
      type: "deliver",
      payload: { message },
    });
    if (response.type !== "ack" || response.payload.message_id !== message.id) {
      throw new OrchestratorError(
        "invalid_link_response",
        `Link peer did not acknowledge Message '${message.id}'`,
      );
    }
    return response.payload.status;
  }

  private async exchange(
    request: Extract<LinkFrame, { type: "ping" | "deliver" }>,
  ): Promise<LinkFrame> {
    if (this.closed) {
      throw new OrchestratorError("link_disconnected", "Link is closed");
    }
    if (this.busy) {
      throw new OrchestratorError(
        "link_busy",
        "Concurrent Link exchanges are not supported",
      );
    }
    this.busy = true;
    try {
      await this.options.transport.send(request, this.abort.signal);
      while (true) {
        const response = await nextFrame(
          this.iterator,
          this.options.timeoutMs ?? 10_000,
        );
        if (!sameSessionIdentity(response.identity, this.identity)) {
          throw new OrchestratorError(
            "stale_session_epoch",
            "Link peer emitted a frame for another Session identity or epoch",
          );
        }
        if (response.type === "event") {
          this.options.onEvent?.(response);
          continue;
        }
        if (response.type === "error") throw remoteError(response);
        if (
          (response.type === "pong" || response.type === "ack") &&
          response.payload.reply_to === request.id
        ) {
          return response;
        }
        throw new OrchestratorError(
          "invalid_link_response",
          `Unexpected '${response.type}' frame while awaiting '${request.id}'`,
        );
      }
    } catch (error) {
      this.closed = true;
      this.abort.abort();
      await this.options.transport.close().catch(() => undefined);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await this.options.transport.close();
  }
}

async function nextFrame(
  iterator: AsyncIterator<LinkFrame>,
  timeoutMs: number,
): Promise<LinkFrame> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OrchestratorError(
            "link_timeout",
            `Link response was not received within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) {
      throw new OrchestratorError(
        "link_disconnected",
        "Link closed before the expected frame arrived",
      );
    }
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remoteError(
  frame: Extract<LinkFrame, { type: "error" }>,
): OrchestratorError {
  return new OrchestratorError(
    `link_peer_${frame.payload.code}`,
    frame.payload.message,
  );
}
