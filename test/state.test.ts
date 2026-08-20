import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Mailbox, type Message } from "../src/message.js";
import { createReport, ReportStore } from "../src/report.js";
import { ProjectStore, writeJsonAtomic } from "../src/state.js";
import { fixtureDigest } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-state-"));
  roots.push(root);
  return root;
}

describe("filesystem state", () => {
  it("preserves the prior state when a temporary write fails", async () => {
    const root = await temporaryRoot();
    const file = path.join(root, "state.json");
    await writeJsonAtomic(file, { generation: 1 });

    await expect(
      writeJsonAtomic(
        file,
        { generation: 2 },
        { beforeRename: () => Promise.reject(new Error("injected")) },
      ),
    ).rejects.toThrow("injected");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ generation: 1 });
  });

  it("prevents a second authoritative writer", async () => {
    const home = await temporaryRoot();
    const first = await ProjectStore.open({
      home,
      projectId: "fixture",
      projectRoot: "/project",
    });
    try {
      await expect(
        ProjectStore.open({
          home,
          projectId: "fixture",
          projectRoot: "/project",
        }),
      ).rejects.toMatchObject({ code: "concurrent_writer" });
    } finally {
      await first.close();
    }

    const replacement = await ProjectStore.open({
      home,
      projectId: "fixture",
      projectRoot: "/project",
    });
    await replacement.close();
  });

  it("rejects identifiers before using them as state paths", async () => {
    const home = await temporaryRoot();
    await expect(
      ProjectStore.open({
        home,
        projectId: "../escape",
        projectRoot: "/project",
      }),
    ).rejects.toThrow("lowercase descriptive identifier");

    const store = await ProjectStore.open({
      home,
      projectId: "fixture",
      projectRoot: "/project",
    });
    try {
      expect(() => store.runDirectory("../escape")).toThrow(
        "lowercase descriptive identifier",
      );
    } finally {
      await store.close();
    }
  });

  it("moves immutable Messages atomically and handles retries", async () => {
    const run = await temporaryRoot();
    const mailbox = new Mailbox(run);
    const message: Message = {
      version: 2,
      id: "msg-0001",
      run: "run-0001",
      from: { agent: "implementer" },
      to: { agent: "quant", session: "session-001", generation: 5 },
      type: "consultation",
      priority: "normal",
      reply_to: null,
      body: { question: "Are the units unchanged?" },
      references: ["src/quant.ts:NetVega"],
      created_at: new Date().toISOString(),
    };

    expect((await mailbox.put(message)).lifecycle).toBe("pending");
    expect((await mailbox.put(message)).lifecycle).toBe("pending");
    expect(
      (await mailbox.move(message.id, "pending", "queued")).lifecycle,
    ).toBe("queued");
    expect(
      (await mailbox.move(message.id, "pending", "queued")).lifecycle,
    ).toBe("queued");
    expect((await mailbox.find(message.id))?.message.body).toEqual(
      message.body,
    );
  });

  it("stores Reports immutably", async () => {
    const run = await temporaryRoot();
    const store = new ReportStore(run);
    const content = [
      "# Summary\nDone.",
      "# Files changed\nsrc/a.ts",
      "# Contracts changed\nNone.",
      "# Behavior changed\nNone.",
      "# Checks attempted\nproject-test",
      "# Deviations\nNone.",
      "# Risks\nNone.",
      "# Questions\nNone.",
      "# Downstream\nNone.",
    ].join("\n\n");
    const report = createReport({
      id: "report-001",
      kind: "implementation",
      run: "run-001",
      agent: "implementer",
      session: "session-001",
      generation: 1,
      permission_ceiling_digest: fixtureDigest,
      model_profile: "local-code",
      route_digest: fixtureDigest,
      task: "bounded-change",
      content,
      created_at: new Date().toISOString(),
    });

    await expect(store.put(report)).resolves.toEqual(report);
    await expect(store.put(report)).resolves.toEqual(report);
    await expect(
      store.put({ ...report, content: `${content}\nchanged` }),
    ).rejects.toMatchObject({
      code: "invalid_report",
    });
  });
});
