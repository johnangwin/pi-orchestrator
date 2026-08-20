import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLocalConfig } from "../src/local.js";
import { MessageSchema } from "../src/message.js";
import { OpenShellClient } from "../src/openshell.js";
import { gitHead } from "../src/project.js";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  startReadSession,
  type ReadSession,
} from "../src/agent.js";
import { createSourceSnapshot } from "../src/snapshot.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_OPENSHELL === "1";

(live ? describe : describe.skip)("live read-only Pi Session", () => {
  it(
    "stages committed source, handshakes with Pi, and reconnects",
    async () => {
      const root = process.cwd();
      const local = await loadLocalConfig(
        path.resolve(".pi", "orchestrator.local.yaml"),
      );
      const client = new OpenShellClient({
        command: local.openshell.command,
        workspace: local.openshell.workspace,
        ...(local.openshell.required_version
          ? { requiredVersion: local.openshell.required_version }
          : {}),
      });
      const snapshot = await createSourceSnapshot({
        projectRoot: root,
        commit: await gitHead(root),
        paths: ["README.md", "src"],
      });
      let session: ReadSession | undefined;
      try {
        session = await startReadSession({
          client,
          identity: {
            run: "live-probe",
            agent: "scout",
            session: "session-one",
            generation: 1,
          },
          snapshot,
          startupTimeoutMs: 60_000,
        });
        expect(session.info.piVersion).toBe(PI_RUNTIME_VERSION);
        expect(session.info.clientVersion).toBe(PI_CLIENT_VERSION);
        expect(session.info.sourceDigest).toBe(snapshot.manifest.source_digest);
        await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
        const message = MessageSchema.parse({
          version: 2,
          id: "live-message",
          run: "live-probe",
          from: { host: true },
          to: { agent: "scout", session: "session-one", generation: 1 },
          type: "instruction",
          priority: "normal",
          reply_to: null,
          body: { instruction: "Record this isolated delivery probe." },
          references: ["README.md"],
          created_at: new Date().toISOString(),
        });
        await expect(session.deliver(message)).resolves.toBe("queued");
        await expect(session.deliver(message)).resolves.toBe("duplicate");
        await session.reconnect();
        await expect(session.deliver(message)).resolves.toBe("duplicate");
        await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      } finally {
        await session?.stop();
        await snapshot.dispose();
      }
    },
    15 * 60_000,
  );
});
