import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestParts } from "../src/digest.js";
import { MessageSchema } from "../src/message.js";
import type {
  OpenShellForward,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "../src/openshell.js";
import {
  PiClientConfigSchema,
  resumeReadSession,
  resumeWriteSession,
  startReadSession,
  startWriteSession,
  type ReadSessionOpenShell,
  type ResumeReadSessionOpenShell,
} from "../src/seat.js";
import { loadSandboxPolicy } from "../src/policy.js";
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
      expect(config).toMatchObject({
        profile: "read",
        source_digest: snapshot.manifest.source_digest,
        policy_digest: session.info.readPolicyDigest,
      });
      expect(session.identity).toEqual({
        run: "run-one",
        seat: "scout",
        session: "session-one",
        epoch: 1,
      });
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

  it("stages immutable base and writable project trees for an implementation Session", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    const port = await availablePort();
    const writeSandbox = { ...sandbox(1), name: "pio-write-test" };
    let config: ReturnType<typeof PiClientConfigSchema.parse> | undefined;
    let dockerfile = "";
    let boundary = "";
    let server: Awaited<ReturnType<typeof startLinkServer>> | undefined;
    const client: ReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      async createSandbox(options) {
        config = PiClientConfigSchema.parse(
          JSON.parse(
            await readFile(path.join(options.from, "session.json"), "utf8"),
          ) as unknown,
        );
        dockerfile = await readFile(
          path.join(options.from, "Dockerfile"),
          "utf8",
        );
        expect(options.policyPath).toBe(
          path.join(process.cwd(), "sandbox", "policies", "write.yaml"),
        );
        return writeSandbox;
      },
      waitForSandbox: () => Promise.resolve(writeSandbox),
      execSandbox(_name, command) {
        if (command[0] === "/bin/sh") boundary = command[2] ?? "";
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startServiceForward(): Promise<OpenShellForward> {
        if (!config) throw new Error("Session config was not staged");
        server = await startLinkServer({ config, deliver() {} });
        return {
          sandboxName: writeSandbox.name,
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: async () => server?.close(),
        };
      },
      deleteSandbox: () => Promise.resolve(),
    };

    let session: Awaited<ReturnType<typeof startWriteSession>> | undefined;
    try {
      session = await startWriteSession({
        client,
        identity: {
          run: "run-one",
          seat: "implementer",
          session: "session-write",
          epoch: 1,
        },
        snapshot,
        linkPort: port,
        sandboxName: writeSandbox.name,
      });
      expect(session.info.profile).toBe("write");
      expect(config?.profile).toBe("write");
      expect(session.info.policyDigest).toBe(session.info.readPolicyDigest);
      expect(dockerfile).toContain(
        "ADD --chown=0:0 source.tar /workspace/base/",
      );
      expect(dockerfile).toContain(
        "ADD --chown=10001:10001 source.tar /workspace/project/",
      );
      expect(dockerfile).toContain(
        "RUN chown -R 10001:10001 /workspace/project",
      );
      expect(dockerfile).toContain("WORKDIR /sandbox");
      expect(boundary).toContain("! touch /workspace/base/");
      expect(boundary).toContain("probe_dir=$(find /workspace/project");
      expect(boundary).toContain("${probe_dir:-/workspace/project}");
    } finally {
      if (session) await session.stop();
      else await server?.close();
      await snapshot.dispose();
    }
  });

  it("recovers a Link from immutable Sandbox input without deleting the Sandbox", async () => {
    const identity = {
      run: "run-one",
      seat: "scout",
      session: "session-one",
      epoch: 1,
    } as const;
    const port = await availablePort();
    const policy = await loadSandboxPolicy(
      "read",
      path.join(process.cwd(), "sandbox", "policies", "read.yaml"),
    );
    const config = PiClientConfigSchema.parse({
      version: 1,
      identity,
      token: "a".repeat(64),
      listen: { host: "127.0.0.1", port },
      client_version: "0.2.0",
      pi_version: "0.84.2",
      source_digest: `sha256:${"1".repeat(64)}`,
      policy_digest: policy.digest,
    });
    const delivered: string[] = [];
    const server = await startLinkServer({
      config,
      deliver(message) {
        delivered.push(message.id);
      },
    });
    let deletes = 0;
    let forwards = 0;
    const client: ResumeReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      getSandbox: () => Promise.resolve(sandbox(1)),
      execSandbox(_name, command) {
        expect(command).toEqual(["/bin/cat", "/workspace/input/session.json"]);
        return Promise.resolve({
          stdout: JSON.stringify(config),
          stderr: "",
          exitCode: 0,
        });
      },
      startServiceForward: () => {
        forwards += 1;
        return Promise.resolve({
          sandboxName: "pio-read-test",
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: () => Promise.resolve(),
        });
      },
      deleteSandbox: () => {
        deletes += 1;
        return Promise.resolve();
      },
    };
    const expectedSandbox = {
      id: sandbox(1).id,
      name: sandbox(1).name,
      workspace: sandbox(1).workspace,
    };
    const message = MessageSchema.parse({
      version: 1,
      id: "recovery-message",
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
      body: { instruction: "Recover this delivery." },
      references: [],
      created_at: "2026-08-18T12:00:00.000Z",
    });

    let first: Awaited<ReturnType<typeof resumeReadSession>> | undefined;
    let second: Awaited<ReturnType<typeof resumeReadSession>> | undefined;
    try {
      first = await resumeReadSession({
        client,
        identity,
        sandbox: expectedSandbox,
      });
      await expect(first.deliver(message)).resolves.toBe("queued");
      await first.release();
      expect(deletes).toBe(0);

      second = await resumeReadSession({
        client,
        identity,
        sandbox: expectedSandbox,
      });
      await expect(second.deliver(message)).resolves.toBe("duplicate");
      expect(delivered).toEqual(["recovery-message"]);
      expect(forwards).toBe(2);
      await second.stop();
      expect(deletes).toBe(1);
      second = undefined;
    } finally {
      await first?.release().catch(() => undefined);
      await second?.release().catch(() => undefined);
      await server.close();
    }
  });

  it("fails recovery before forwarding when Sandbox provenance changed", async () => {
    const identity = {
      run: "run-one",
      seat: "scout",
      session: "session-one",
      epoch: 1,
    } as const;
    let forwarded = false;
    let executed = false;
    const client: ResumeReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      getSandbox: () =>
        Promise.resolve({
          ...sandbox(1),
          id: "53502221-db6b-49f2-a316-673792b3faae",
        }),
      execSandbox: () => {
        executed = true;
        return Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 });
      },
      startServiceForward: () => {
        forwarded = true;
        throw new Error("must not forward");
      },
      deleteSandbox: () => Promise.resolve(),
    };

    await expect(
      resumeReadSession({
        client,
        identity,
        sandbox: {
          id: sandbox(1).id,
          name: sandbox(1).name,
          workspace: sandbox(1).workspace,
        },
      }),
    ).rejects.toMatchObject({ code: "sandbox_identity_mismatch" });
    expect(executed).toBe(false);
    expect(forwarded).toBe(false);
  });

  it("rejects recovery under a different immutable Session profile", async () => {
    const identity = {
      run: "run-one",
      seat: "scout",
      session: "session-one",
      epoch: 1,
    } as const;
    const policy = await loadSandboxPolicy(
      "read",
      path.join(process.cwd(), "sandbox", "policies", "read.yaml"),
    );
    const config = PiClientConfigSchema.parse({
      version: 1,
      identity,
      token: "a".repeat(64),
      listen: { host: "127.0.0.1", port: 41_727 },
      client_version: "0.2.0",
      pi_version: "0.84.2",
      profile: "read",
      source_digest: `sha256:${"1".repeat(64)}`,
      policy_digest: policy.digest,
    });
    let forwarded = false;
    const client: ResumeReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      getSandbox: () => Promise.resolve(sandbox(1)),
      execSandbox: () =>
        Promise.resolve({
          stdout: JSON.stringify(config),
          stderr: "",
          exitCode: 0,
        }),
      startServiceForward: () => {
        forwarded = true;
        throw new Error("must not forward");
      },
      deleteSandbox: () => Promise.resolve(),
    };

    await expect(
      resumeWriteSession({
        client,
        identity,
        sandbox: {
          id: sandbox(1).id,
          name: sandbox(1).name,
          workspace: sandbox(1).workspace,
        },
      }),
    ).rejects.toMatchObject({ code: "session_profile_mismatch" });
    expect(forwarded).toBe(false);
  });

  it("requires an expected Brief digest before model-routed recovery", async () => {
    const identity = {
      run: "run-one",
      seat: "scout",
      session: "session-one",
      epoch: 1,
    } as const;
    let touchedOpenShell = false;
    const client: ResumeReadSessionOpenShell = {
      preflight: () => {
        touchedOpenShell = true;
        return Promise.resolve(preflight);
      },
      getSandbox: () => {
        touchedOpenShell = true;
        return Promise.resolve(sandbox(1));
      },
      execSandbox: () => {
        touchedOpenShell = true;
        return Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 });
      },
      startServiceForward: () => {
        touchedOpenShell = true;
        throw new Error("must not forward");
      },
      deleteSandbox: () => Promise.resolve(),
      getInferenceRoute: () => {
        touchedOpenShell = true;
        return Promise.resolve({ provider: "fixture", model: "fixture-model" });
      },
    };

    await expect(
      resumeReadSession({
        client,
        identity,
        sandbox: {
          id: sandbox(1).id,
          name: sandbox(1).name,
          workspace: sandbox(1).workspace,
        },
        model: {
          alias: "fast",
          gateway_alias: "code",
          gateway: "openshell",
          pi_model: "fixture-model",
          api: "openai-completions",
          locality: "local",
          context_window: 32768,
          max_tokens: 4096,
          reasoning: false,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_session_input" });
    expect(touchedOpenShell).toBe(false);
  });

  it("binds a compiled Brief and verified model route to a completed Pi turn", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    const port = await availablePort();
    const briefContent = "# Session Brief\n\nReturn a bounded result.\n";
    const brief = {
      content: briefContent,
      digest: digestParts("pi-orchestrator/brief/v1", [
        ["brief.md", briefContent],
      ]),
    };
    const model = {
      alias: "fast" as const,
      gateway_alias: "code",
      gateway: "openshell",
      pi_model: "fixture-model",
      api: "openai-completions" as const,
      locality: "local" as const,
      context_window: 32768,
      max_tokens: 4096,
      reasoning: false,
    };
    let config: ReturnType<typeof PiClientConfigSchema.parse> | undefined;
    let server: Awaited<ReturnType<typeof startLinkServer>> | undefined;

    const client: ReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      getInferenceRoute: () =>
        Promise.resolve({ provider: "fixture", model: "fixture-model" }),
      async createSandbox(options) {
        config = PiClientConfigSchema.parse(
          JSON.parse(
            await readFile(path.join(options.from, "session.json"), "utf8"),
          ) as unknown,
        );
        expect(
          await readFile(path.join(options.from, "brief.md"), "utf8"),
        ).toBe(briefContent);
        return sandbox(1);
      },
      waitForSandbox: () => Promise.resolve(sandbox(1)),
      execSandbox: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      async startServiceForward(): Promise<OpenShellForward> {
        if (!config) throw new Error("Session config was not staged");
        server = await startLinkServer({
          config,
          deliver(message) {
            queueMicrotask(() =>
              server!.emit("turn-completed", {
                message_ids: [message.id],
                model_alias: "fast",
                requested_model: "fixture-model",
                response_model: "fixture-model",
                stop_reason: "stop",
                text: "bounded result",
                truncated: false,
                usage: { input: 12, output: 3 },
              }),
            );
          },
        });
        return {
          sandboxName: "pio-read-test",
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: async () => server?.close(),
        };
      },
      deleteSandbox: () => Promise.resolve(),
    };

    let session: Awaited<ReturnType<typeof startReadSession>> | undefined;
    try {
      session = await startReadSession({
        client,
        identity: {
          run: "run-one",
          seat: "scout",
          session: "session-model",
          epoch: 1,
        },
        snapshot,
        model,
        brief,
        linkPort: port,
        sandboxName: "pio-read-test",
      });
      expect(session.info.model).toEqual(model);
      expect(session.info.briefDigest).toBe(brief.digest);
      const message = MessageSchema.parse({
        version: 1,
        id: "model-turn",
        run: "run-one",
        from: { host: true },
        to: { seat: "scout", session: "session-model", epoch: 1 },
        type: "instruction",
        priority: "normal",
        reply_to: null,
        body: { instruction: "Return the result." },
        references: [],
        created_at: new Date().toISOString(),
      });
      await expect(session.run(message, 1_000)).resolves.toMatchObject({
        message_ids: ["model-turn"],
        model_alias: "fast",
        text: "bounded result",
      });
    } finally {
      await session?.stop();
      await snapshot.dispose();
    }
  });

  it("rejects a turn event that does not match the verified model route", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    const port = await availablePort();
    const briefContent = "# Session Brief\n\nReturn a bounded result.\n";
    const brief = {
      content: briefContent,
      digest: digestParts("pi-orchestrator/brief/v1", [
        ["brief.md", briefContent],
      ]),
    };
    const model = {
      alias: "fast" as const,
      gateway_alias: "code",
      gateway: "openshell",
      pi_model: "fixture-model",
      api: "openai-completions" as const,
      locality: "local" as const,
      context_window: 32768,
      max_tokens: 4096,
      reasoning: false,
    };
    let config: ReturnType<typeof PiClientConfigSchema.parse> | undefined;
    let server: Awaited<ReturnType<typeof startLinkServer>> | undefined;
    const client: ReadSessionOpenShell = {
      preflight: () => Promise.resolve(preflight),
      getInferenceRoute: () =>
        Promise.resolve({ provider: "fixture", model: "fixture-model" }),
      async createSandbox(options) {
        config = PiClientConfigSchema.parse(
          JSON.parse(
            await readFile(path.join(options.from, "session.json"), "utf8"),
          ) as unknown,
        );
        return sandbox(1);
      },
      waitForSandbox: () => Promise.resolve(sandbox(1)),
      execSandbox: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      async startServiceForward(): Promise<OpenShellForward> {
        if (!config) throw new Error("Session config was not staged");
        server = await startLinkServer({
          config,
          deliver(message) {
            queueMicrotask(() =>
              server!.emit("turn-completed", {
                message_ids: [message.id],
                model_alias: "code",
                requested_model: "other-model",
                stop_reason: "stop",
                text: "untrusted result",
                truncated: false,
                usage: {},
              }),
            );
          },
        });
        return {
          sandboxName: "pio-read-test",
          localHost: "127.0.0.1",
          localPort: port,
          targetHost: "127.0.0.1",
          targetPort: port,
          closed: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          stop: async () => server?.close(),
        };
      },
      deleteSandbox: () => Promise.resolve(),
    };

    let session: Awaited<ReturnType<typeof startReadSession>> | undefined;
    try {
      session = await startReadSession({
        client,
        identity: {
          run: "run-one",
          seat: "scout",
          session: "session-model",
          epoch: 1,
        },
        snapshot,
        model,
        brief,
        linkPort: port,
        sandboxName: "pio-read-test",
      });
      const message = MessageSchema.parse({
        version: 1,
        id: "model-turn",
        run: "run-one",
        from: { host: true },
        to: { seat: "scout", session: "session-model", epoch: 1 },
        type: "instruction",
        priority: "normal",
        reply_to: null,
        body: { instruction: "Return the result." },
        references: [],
        created_at: new Date().toISOString(),
      });
      await expect(session.run(message, 1_000)).rejects.toMatchObject({
        code: "model_turn_binding_mismatch",
      });
    } finally {
      await session?.stop();
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
