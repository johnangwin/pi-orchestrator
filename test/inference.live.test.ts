import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { digestParts } from "../src/digest.js";
import { loadLocalConfig } from "../src/local.js";
import { MessageSchema } from "../src/message.js";
import { OpenShellClient } from "../src/openshell.js";
import { gitHead } from "../src/project.js";
import { startReadSession, type ReadSession } from "../src/agent.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { fixturePermissionCeiling } from "./fixture.js";

const execFileAsync = promisify(execFile);
const live = process.env.PI_ORCHESTRATOR_LIVE_INFERENCE === "1";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No mock port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

(live ? describe : describe.skip)("live model-routed Pi Session", () => {
  it(
    "routes an isolated Pi turn through inference.local and returns a Link event",
    async () => {
      const requests: unknown[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          );
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const base = {
            id: "chatcmpl-orchestrator",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1_000),
            model: "fixture-model",
          };
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "ROUTED_OK" }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      });

      const port = await listen(server);
      const root = process.cwd();
      const local = await loadLocalConfig(
        path.resolve(".pi", "orchestrator.local.yaml"),
      );
      const command = local.openshell.command;
      const gateway = local.openshell.gateways.code ?? "openshell";
      const workspace = `pio-inf-${process.pid}`;
      const provider = "pio-fixture";
      const globalArgs = ["--gateway", gateway, "--workspace", workspace];
      const runGateway = (args: readonly string[]) =>
        execFileAsync(command, [...args, "--gateway", gateway], {
          encoding: "utf8",
          timeout: 60_000,
        });
      const runOpenShell = (args: readonly string[]) =>
        execFileAsync(command, [...args, ...globalArgs], {
          encoding: "utf8",
          timeout: 60_000,
        });

      let session: ReadSession | undefined;
      let snapshot:
        Awaited<ReturnType<typeof createSourceSnapshot>> | undefined;
      let providerCreated = false;
      let inferenceCreated = false;
      let workspaceCreated = false;
      try {
        await runGateway(["workspace", "create", "--name", workspace]);
        workspaceCreated = true;
        await runOpenShell([
          "provider",
          "create",
          "--name",
          provider,
          "--type",
          "openai",
          "--credential",
          "OPENAI_API_KEY=unused",
          "--config",
          `OPENAI_BASE_URL=http://host.openshell.internal:${port}/v1`,
        ]);
        providerCreated = true;
        await runOpenShell([
          "inference",
          "set",
          "--provider",
          provider,
          "--model",
          "fixture-model",
          "--no-verify",
        ]);
        inferenceCreated = true;

        const client = new OpenShellClient({
          command,
          gateway,
          workspace,
          ...(local.openshell.required_version
            ? { requiredVersion: local.openshell.required_version }
            : {}),
        });
        snapshot = await createSourceSnapshot({
          projectRoot: root,
          commit: await gitHead(root),
          paths: ["README.md", "src"],
        });
        const briefContent =
          "# Session Brief\n\nReply to the instruction with the exact requested token.\n";
        const brief = {
          content: briefContent,
          digest: digestParts("pi-orchestrator/brief/v1", [
            ["brief.md", briefContent],
          ]),
        };
        session = await startReadSession({
          client,
          permissionCeiling: fixturePermissionCeiling(),
          identity: {
            run: "live-inference",
            agent: "scout",
            session: "session-one",
            generation: 1,
          },
          snapshot,
          model: {
            alias: "fast",
            gateway_alias: "code",
            gateway,
            pi_model: "fixture-model",
            api: "openai-completions",
            locality: "local",
            context_window: 32_768,
            max_tokens: 4_096,
            reasoning: false,
          },
          brief,
          startupTimeoutMs: 60_000,
          turnTimeoutMs: 60_000,
        });
        const isolation = await client.execSandbox(
          session.info.sandbox.name,
          [
            "/bin/sh",
            "-c",
            "! printenv OPENAI_API_KEY && ! printenv ANTHROPIC_API_KEY && ! curl --silent --show-error --max-time 5 https://example.com",
          ],
          { timeoutMs: 10_000 },
        );
        expect(isolation.exitCode).toBe(0);
        const message = MessageSchema.parse({
          version: 2,
          id: "live-model-turn",
          run: "live-inference",
          from: { host: true },
          to: { agent: "scout", session: "session-one", generation: 1 },
          type: "instruction",
          priority: "normal",
          reply_to: null,
          body: { instruction: "Reply with exactly ROUTED_OK." },
          references: [],
          created_at: new Date().toISOString(),
        });
        await expect(session.run(message)).resolves.toMatchObject({
          message_ids: ["live-model-turn"],
          model_alias: "fast",
          requested_model: "fixture-model",
          text: "ROUTED_OK",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ model: "fixture-model" });
      } finally {
        await session?.stop();
        await snapshot?.dispose();
        if (inferenceCreated)
          await runOpenShell(["inference", "delete"]).catch(() => undefined);
        if (providerCreated)
          await runOpenShell(["provider", "delete", provider]).catch(
            () => undefined,
          );
        if (workspaceCreated)
          await runGateway(["workspace", "delete", workspace]).catch(
            () => undefined,
          );
        await close(server);
      }
    },
    15 * 60_000,
  );
});
