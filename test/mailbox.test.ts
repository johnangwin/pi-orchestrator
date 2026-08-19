import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorError } from "../src/error.js";
import {
  MailboxRouter,
  type MailboxAcknowledgement,
  type MailboxLink,
} from "../src/mailbox.js";
import { MessageSchema, type Message } from "../src/message.js";
import { MetricStore } from "../src/metric.js";
import { SeatRegistry } from "../src/registry.js";
import type { SessionIdentity } from "../src/session.js";
import { ProjectStore } from "../src/state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{
  store: ProjectStore;
  registry: SeatRegistry;
  identity: SessionIdentity;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-mailbox-test-"));
  roots.push(home);
  const store = await ProjectStore.open({
    home,
    projectId: "fixture",
    projectRoot: "/project",
  });
  await store.writeRun({
    version: 1,
    id: "run-one",
    project_id: "fixture",
    plan_id: "fixture-plan",
    plan_revision: 1,
    plan_digest: "sha256:plan",
    base_commit: "0123456789abcdef",
    branch: "orchestrator/run-one",
    worktree: "/worktrees/run-one",
    status: "active",
    tasks: {},
    created_at: "2026-08-18T12:00:00.000Z",
    updated_at: "2026-08-18T12:00:00.000Z",
  });
  const registry = new SeatRegistry(store, "run-one");
  await registry.register({ seat: "lead", role: "lead", model: "plan" });
  const session = await registry.start({
    seat: "lead",
    session: "session-one",
  });
  return { store, registry, identity: session.identity };
}

function target(identity: SessionIdentity): Message["to"] {
  return {
    seat: identity.seat,
    session: identity.session,
    epoch: identity.epoch,
  };
}

function message(
  id = "msg-one",
  overrides: Partial<Pick<Message, "body" | "to">> = {},
): Message {
  return MessageSchema.parse({
    version: 1,
    id,
    run: "run-one",
    from: { host: true },
    to: { seat: "lead" },
    type: "instruction",
    priority: "normal",
    reply_to: null,
    body: { instruction: "Inspect the current Task." },
    references: [],
    created_at: "2026-08-18T12:01:00.000Z",
    ...overrides,
  });
}

function link(
  identity: SessionIdentity,
  deliver: (
    message: Message,
  ) => MailboxAcknowledgement | Promise<MailboxAcknowledgement>,
): MailboxLink {
  return { identity, deliver: (value) => Promise.resolve(deliver(value)) };
}

describe("durable Mailbox routing", () => {
  it("binds a Seat Message to the current Session and queues it only after acknowledgement", async () => {
    const { store, registry, identity } = await setup();
    try {
      const delivered: Message[] = [];
      const router = new MailboxRouter(store, "run-one", {
        now: () => new Date("2026-08-18T12:01:02.000Z"),
      });
      await expect(
        router.attach(
          link(identity, (value) => {
            delivered.push(value);
            return "queued";
          }),
        ),
      ).resolves.toEqual([]);

      const result = await router.send(message());
      expect(result).toMatchObject({
        acknowledgement: "queued",
        stored: { lifecycle: "queued" },
      });
      expect(result.stored.message.to).toEqual({
        seat: "lead",
        session: "session-one",
        epoch: 1,
      });
      expect(delivered).toEqual([result.stored.message]);
      expect(await router.mailbox.list("answered")).toEqual([]);
      expect((await registry.get("lead")).session?.status).toBe("active");
      await expect(
        new MetricStore(store.runDirectory("run-one"), "run-one").list(),
      ).resolves.toMatchObject([
        {
          metric: {
            kind: "message-delivery",
            message: "msg-one",
            acknowledgement: "queued",
            latency_ms: 2_000,
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("persists a bound pending Message before a Link is available", async () => {
    const { store, identity } = await setup();
    const router = new MailboxRouter(store, "run-one");
    try {
      await expect(router.send(message())).resolves.toMatchObject({
        acknowledgement: null,
        stored: {
          lifecycle: "pending",
          message: { to: target(identity) },
        },
      });
    } finally {
      await store.close();
    }

    const reopened = await ProjectStore.open({
      home: roots.at(-1)!,
      projectId: "fixture",
      projectRoot: "/project",
    });
    try {
      const recovered = new MailboxRouter(reopened, "run-one");
      await expect(recovered.mailbox.list("pending")).resolves.toMatchObject([
        {
          lifecycle: "pending",
          message: { id: "msg-one", to: target(identity) },
        },
      ]);
    } finally {
      await reopened.close();
    }
  });

  it("redelivers an accepted Message after acknowledgement loss", async () => {
    const { store, registry, identity } = await setup();
    try {
      const attempts: string[] = [];
      const router = new MailboxRouter(store, "run-one");
      await router.attach(
        link(identity, (value) => {
          attempts.push(value.id);
          throw new OrchestratorError(
            "link_disconnected",
            "Connection closed before acknowledgement",
          );
        }),
      );

      await expect(router.send(message())).rejects.toMatchObject({
        code: "link_disconnected",
      });
      expect((await router.mailbox.find("msg-one"))?.lifecycle).toBe("pending");
      expect((await registry.get("lead")).session?.status).toBe("disconnected");

      await expect(
        router.attach(
          link(identity, (value) => {
            attempts.push(value.id);
            return "duplicate";
          }),
        ),
      ).resolves.toMatchObject([
        {
          acknowledgement: "duplicate",
          stored: { lifecycle: "queued", message: { id: "msg-one" } },
        },
      ]);
      expect(attempts).toEqual(["msg-one", "msg-one"]);
      expect((await registry.get("lead")).session?.status).toBe("active");
    } finally {
      await store.close();
    }
  });

  it("does not inject an already queued Message twice", async () => {
    const { store, identity } = await setup();
    try {
      let deliveries = 0;
      const router = new MailboxRouter(store, "run-one");
      await router.attach(
        link(identity, () => {
          deliveries += 1;
          return "queued" as const;
        }),
      );

      await router.send(message());
      await expect(router.send(message())).resolves.toMatchObject({
        acknowledgement: null,
        stored: { lifecycle: "queued" },
      });
      expect(deliveries).toBe(1);
      await expect(
        router.send(
          message("msg-one", {
            body: { instruction: "Reuse the ID for other content." },
          }),
        ),
      ).rejects.toMatchObject({ code: "duplicate_message" });
    } finally {
      await store.close();
    }
  });

  it("rejects stale Links and never routes an old pending Message to a replacement", async () => {
    const { store, registry, identity } = await setup();
    try {
      const router = new MailboxRouter(store, "run-one");
      await router.send(message());
      const replacement = await registry.replace({
        expected: identity,
        session: "session-two",
        reason: "Replace lost context",
      });

      await expect(
        router.attach(link(identity, () => "queued")),
      ).rejects.toMatchObject({ code: "stale_session" });
      let replacementDeliveries = 0;
      await expect(
        router.attach(
          link(replacement.identity, () => {
            replacementDeliveries += 1;
            return "queued";
          }),
        ),
      ).resolves.toEqual([]);
      expect(replacementDeliveries).toBe(0);
      expect((await router.mailbox.find("msg-one"))?.lifecycle).toBe("pending");
    } finally {
      await store.close();
    }
  });

  it("does not record a late acknowledgement after the Session epoch changes", async () => {
    const { store, registry, identity } = await setup();
    try {
      const router = new MailboxRouter(store, "run-one");
      await router.attach(
        link(identity, async () => {
          await registry.replace({
            expected: identity,
            session: "session-two",
            reason: "Replacement raced with delivery",
          });
          return "queued" as const;
        }),
      );

      await expect(router.send(message())).rejects.toMatchObject({
        code: "stale_session",
      });
      expect((await router.mailbox.find("msg-one"))?.lifecycle).toBe("pending");
      await expect(router.flush("lead")).rejects.toMatchObject({
        code: "link_disconnected",
      });
    } finally {
      await store.close();
    }
  });

  it("serializes concurrent sends for the single-exchange Link", async () => {
    const { store, identity } = await setup();
    try {
      let active = 0;
      let maximum = 0;
      const router = new MailboxRouter(store, "run-one");
      await router.attach(
        link(identity, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return "queued" as const;
        }),
      );

      await expect(
        Promise.all([
          router.send(message("msg-one")),
          router.send(message("msg-two")),
        ]),
      ).resolves.toMatchObject([
        { stored: { lifecycle: "queued" } },
        { stored: { lifecycle: "queued" } },
      ]);
      expect(maximum).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("requires Session and epoch targets as one identity pair", () => {
    expect(() =>
      message("msg-partial", {
        to: { seat: "lead", session: "session-one" },
      }),
    ).toThrow(
      "session and epoch must either both be present or both be absent",
    );
  });

  it("fails closed when one Message appears in multiple lifecycle directories", async () => {
    const { store } = await setup();
    try {
      const router = new MailboxRouter(store, "run-one");
      await router.send(message());
      const pending = path.join(
        store.runDirectory("run-one"),
        "messages",
        "pending",
        "msg-one.json",
      );
      const queued = path.join(
        store.runDirectory("run-one"),
        "messages",
        "queued",
        "msg-one.json",
      );
      await mkdir(path.dirname(queued), { recursive: true });
      await copyFile(pending, queued);

      await expect(router.mailbox.list("pending")).rejects.toMatchObject({
        code: "invalid_message_store",
      });
      await expect(router.mailbox.find("msg-one")).rejects.toMatchObject({
        code: "invalid_message_store",
      });
    } finally {
      await store.close();
    }
  });
});
