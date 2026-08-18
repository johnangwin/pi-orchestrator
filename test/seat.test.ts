import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import {
  PiClientConfigSchema,
  startReadSession,
  type ReadSessionOpenShell,
} from "../src/seat.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { startLinkServer } from "../sandbox/pi/client/link.mjs";
import { commitFixture, createFixtureProject } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

const preflight: OpenShellPreflight = {
  command: "openshell",
  requiredVersion: "0.0.106",
  installedVersion: "0.0.106",
  versionMatches: true,
  status: {
    authentication: { provider: "mTLS", status: "authenticated" },
    gateway: "openshell",
    server: "https://127.0.0.1:17670",
    status: "connected",
    version: "0.0.106",
  },
};

function sandbox(policyVersion: number): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-17 23:39:16",
    current_policy_version: policyVersion,
    id: "43502221-db6b-49f2-a316-673792b3faae",
    labels: {},
    name: "pio-read-test",
    phase: "Ready",
    resource_version: policyVersion,
    workspace: "default",
  };
}

describe("read Session bootstrap", () => {
  it("stages source, tightens policy, connects, and reconnects", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    const port = await availablePort();
    const calls: string[] = [];
    let config: ReturnType<typeof PiClientConfigSchema.parse> | undefined;
    let deleted = false;

    const client: ReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      async createSandbox(options) {
        calls.push("create");
        config = PiClientConfigSchema.parse(
          JSON.parse(
            await readFile(path.join(options.from, "session.json"), "utf8"),
          ) as unknown,
        );
        return sandbox(1);
      },
      waitForSandbox: () => Promise.resolve(sandbox(1)),
      execSandbox(_name, command) {
        calls.push(`exec:${command[0]}`);
        return Promise.resolve<ProcessResult>({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });
      },
      async startServiceForward(options): Promise<OpenShellForward> {
        calls.push("forward");
        if (!config) throw new Error("Session config was not uploaded");
        expect(options.targetPort).toBe(port);
        const server = await startLinkServer({
          config,
          deliver() {},
        });
        let stopped = false;
        return {
          sandboxName: "pio-read-test",
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          async stop() {
            if (stopped) return;
            stopped = true;
            await server.close();
          },
        };
      },
      deleteSandbox() {
        calls.push("delete");
        deleted = true;
        return Promise.resolve();
      },
    };

    try {
      const session = await startReadSession({
        client,
        identity: {
          run: "run-one",
          seat: "scout",
          session: "session-one",
          epoch: 1,
        },
        snapshot,
        linkPort: port,
        sandboxName: "pio-read-test",
      });
      expect(session.info.sourceDigest).toBe(snapshot.manifest.source_digest);
      await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      await session.reconnect();
      await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      await session.stop();
      expect(deleted).toBe(true);
      expect(calls.indexOf("exec:/bin/sh")).toBeGreaterThan(
        calls.indexOf("create"),
      );
      expect(calls.indexOf("forward")).toBeGreaterThan(
        calls.indexOf("exec:/usr/local/bin/orchestrator-start-pi"),
      );
    } finally {
      await snapshot.dispose();
    }
  });

  it("deletes a named Sandbox when creation fails after allocation", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    let deleted = false;
    const client: ReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      createSandbox: () => Promise.reject(new Error("provisioning failed")),
      waitForSandbox: () => Promise.reject(new Error("unexpected wait")),
      execSandbox: () => Promise.reject(new Error("unexpected exec")),
      startServiceForward: () =>
        Promise.reject(new Error("unexpected forward")),
      deleteSandbox(name, options) {
        expect(name).toBe("pio-read-failed");
        expect(options).toEqual({ missingOk: true });
        deleted = true;
        return Promise.resolve();
      },
    };

    try {
      await expect(
        startReadSession({
          client,
          identity: {
            run: "run-one",
            seat: "scout",
            session: "session-one",
            epoch: 1,
          },
          snapshot,
          sandboxName: "pio-read-failed",
        }),
      ).rejects.toThrow("provisioning failed");
      expect(deleted).toBe(true);
    } finally {
      await snapshot.dispose();
    }
  });
});
