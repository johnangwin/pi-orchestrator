import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  HostLink,
  LinkFrameDecoder,
  TcpLinkTransport,
  encodeLinkFrame,
} from "../src/link.js";
import { MessageSchema, type Message } from "../src/message.js";
import type { SessionIdentity } from "../src/session.js";
import type { LinkFrame, LinkTransport } from "../src/transport.js";
import { startLinkServer } from "../sandbox/pi/client/link.mjs";

const identity: SessionIdentity = {
  run: "run-one",
  seat: "scout",
  session: "session-one",
  epoch: 1,
};
const token = "a".repeat(64);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function message(): Message {
  return MessageSchema.parse({
    version: 1,
    id: "msg-one",
    run: identity.run,
    from: { host: true },
    to: {
      seat: identity.seat,
      session: identity.session,
      epoch: identity.epoch,
    },
    type: "instruction",
    priority: "normal",
    reply_to: null,
    body: { question: "Inspect the source." },
    references: ["src/index.ts"],
    created_at: "2026-08-17T18:42:00.000Z",
  });
}

describe("Link framing", () => {
  it("decodes frames split across UTF-8 chunks", () => {
    const frame: LinkFrame = {
      version: 1,
      id: "ping-one",
      identity,
      type: "ping",
      payload: { nonce: "quant-π" },
    };
    const encoded = encodeLinkFrame(frame);
    const split = encoded.indexOf(Buffer.from("π")) + 1;
    const decoder = new LinkFrameDecoder();
    expect(decoder.push(encoded.subarray(0, split))).toEqual([]);
    expect(decoder.push(encoded.subarray(split))).toEqual([frame]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects oversized and truncated frames", () => {
    expect(() =>
      new LinkFrameDecoder(8).push(Buffer.from("123456789")),
    ).toThrow("exceeds 8 bytes");
    const decoder = new LinkFrameDecoder();
    decoder.push(Buffer.from('{"version":1'));
    expect(() => decoder.end()).toThrow("partial frame");
  });

  it("requires LF rather than CRLF framing", () => {
    const frame: LinkFrame = {
      version: 1,
      id: "ping-one",
      identity,
      type: "ping",
      payload: { nonce: "one" },
    };
    const encoded = Buffer.from(
      `${encodeLinkFrame(frame).toString("utf8").trimEnd()}\r\n`,
    );
    expect(() => new LinkFrameDecoder().push(encoded)).toThrow("requires LF");
  });

  it("rejects malformed UTF-8", () => {
    const encoded = encodeLinkFrame({
      version: 1,
      id: "ping-one",
      identity,
      type: "ping",
      payload: { nonce: "marker" },
    });
    const marker = encoded.indexOf("marker");
    encoded[marker] = 0xff;
    expect(() => new LinkFrameDecoder().push(encoded)).toThrow(
      "not valid UTF-8",
    );
  });
});

describe("Pi client Link", () => {
  it("authenticates, pings, deduplicates delivery, and reconnects", async () => {
    const port = await availablePort();
    const delivered: string[] = [];
    const server = await startLinkServer({
      config: {
        version: 1,
        identity,
        token,
        listen: { host: "127.0.0.1", port },
        client_version: "0.2.0",
        pi_version: "0.84.2",
      },
      deliver(value) {
        delivered.push(value.id);
      },
    });

    let link: HostLink | undefined;
    try {
      link = await HostLink.connect({
        transport: new TcpLinkTransport({ port }),
        identity,
        token,
        expectedClientVersion: "0.2.0",
        expectedPiVersion: "0.84.2",
      });
      await expect(link.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      await expect(link.deliver(message())).resolves.toBe("queued");
      await expect(link.deliver(message())).resolves.toBe("duplicate");
      expect(delivered).toEqual(["msg-one"]);

      await link.close();
      link = await HostLink.connect({
        transport: new TcpLinkTransport({ port }),
        identity,
        token,
        expectedClientVersion: "0.2.0",
        expectedPiVersion: "0.84.2",
      });
      await expect(link.deliver(message())).resolves.toBe("duplicate");
      expect(delivered).toEqual(["msg-one"]);
    } finally {
      await link?.close();
      await server.close();
    }
  });

  it("queues structured Session events until the authenticated host reads them", async () => {
    const port = await availablePort();
    const server = await startLinkServer({
      config: {
        version: 1,
        identity,
        token,
        listen: { host: "127.0.0.1", port },
        client_version: "0.2.0",
        pi_version: "0.84.2",
      },
      deliver() {},
    });
    server.emit("session-started", { model_alias: "fast" });

    let link: HostLink | undefined;
    try {
      link = await HostLink.connect({
        transport: new TcpLinkTransport({ port }),
        identity,
        token,
        expectedClientVersion: "0.2.0",
        expectedPiVersion: "0.84.2",
      });
      expect(link.peer.capabilities).toContain("events");
      await expect(
        link.waitForEvent(
          (frame) => frame.payload.event === "session-started",
          1_000,
        ),
      ).resolves.toMatchObject({
        type: "event",
        payload: {
          event: "session-started",
          data: { model_alias: "fast" },
        },
      });
    } finally {
      await link?.close();
      await server.close();
    }
  });

  it("serializes simultaneous duplicate deliveries", async () => {
    const port = await availablePort();
    const delivered: string[] = [];
    const server = await startLinkServer({
      config: {
        version: 1,
        identity,
        token,
        listen: { host: "127.0.0.1", port },
        client_version: "0.2.0",
        pi_version: "0.84.2",
      },
      async deliver(value) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        delivered.push(value.id);
      },
    });
    const transport = new TcpLinkTransport({ port });
    try {
      await transport.connect();
      const frames = transport.receive()[Symbol.asyncIterator]();
      await transport.send({
        version: 1,
        id: "hello-concurrent",
        identity,
        type: "hello",
        payload: { token },
      });
      expect((await frames.next()).value?.type).toBe("ready");
      await Promise.all([
        transport.send({
          version: 1,
          id: "deliver-one",
          identity,
          type: "deliver",
          payload: { message: message() },
        }),
        transport.send({
          version: 1,
          id: "deliver-two",
          identity,
          type: "deliver",
          payload: { message: message() },
        }),
      ]);
      const responses = [
        (await frames.next()).value,
        (await frames.next()).value,
      ];
      expect(
        responses
          .filter((frame) => frame?.type === "ack")
          .map((frame) => frame.payload.status)
          .sort(),
      ).toEqual(["duplicate", "queued"]);
      expect(delivered).toEqual(["msg-one"]);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it("rejects an unauthorized host and a stale epoch", async () => {
    const port = await availablePort();
    const server = await startLinkServer({
      config: {
        version: 1,
        identity,
        token,
        listen: { host: "127.0.0.1", port },
        client_version: "0.2.0",
        pi_version: "0.84.2",
      },
      deliver() {},
    });
    try {
      await expect(
        HostLink.connect({
          transport: new TcpLinkTransport({ port }),
          identity,
          token: "b".repeat(64),
          expectedClientVersion: "0.2.0",
          expectedPiVersion: "0.84.2",
        }),
      ).rejects.toMatchObject({ code: "link_peer_unauthorized" });

      await expect(
        HostLink.connect({
          transport: new TcpLinkTransport({ port }),
          identity: { ...identity, epoch: 2 },
          token,
          expectedClientVersion: "0.2.0",
          expectedPiVersion: "0.84.2",
        }),
      ).rejects.toMatchObject({ code: "stale_session_epoch" });
    } finally {
      await server.close();
    }
  });

  it("closes a Link after a response timeout", async () => {
    const sent: LinkFrame[] = [];
    let closed = false;
    const transport: LinkTransport = {
      name: "timeout-test",
      connect: () => Promise.resolve(),
      send(frame) {
        sent.push(frame);
        return Promise.resolve();
      },
      async *receive() {
        const hello = sent[0];
        if (!hello || hello.type !== "hello") throw new Error("Missing hello");
        yield {
          version: 1,
          id: "ready-timeout",
          identity,
          type: "ready",
          payload: {
            reply_to: hello.id,
            client_version: "0.2.0",
            pi_version: "0.84.2",
            capabilities: ["deliver", "ping"],
          },
        };
        await new Promise(() => undefined);
      },
      close() {
        closed = true;
        return Promise.resolve();
      },
    };
    const link = await HostLink.connect({
      transport,
      identity,
      token,
      expectedClientVersion: "0.2.0",
      expectedPiVersion: "0.84.2",
      timeoutMs: 10,
    });
    await expect(link.ping()).rejects.toMatchObject({ code: "link_timeout" });
    expect(closed).toBe(true);
    await expect(link.ping()).rejects.toMatchObject({
      code: "link_disconnected",
    });
  });
});
