import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalConfigSchema, loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { runReview, type ReviewAssessment } from "../src/review.js";
import {
  createAppliedFixture,
  passFixtureChecks,
  type AppliedFixture,
} from "./applied-fixture.js";

const execFileAsync = promisify(execFile);
const live = process.env.PI_ORCHESTRATOR_LIVE_REVIEW === "1";

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

(live ? describe : describe.skip)("live authoritative Review", () => {
  it(
    "runs a fresh Review Sandbox and publishes exact passing evidence",
    async () => {
      const assessment: ReviewAssessment = {
        verdict: "pass",
        conclusion: "The exact bounded change satisfies the Spec Lens.",
        blocking_findings: [],
        improvements: [],
        evidence: ["The frozen source, diff, and Check record were supplied."],
        uncertainty: [],
      };
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
            id: "chatcmpl-review",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1_000),
            model: "fixture-reviewer",
          };
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: JSON.stringify(assessment) }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      });

      const port = await listen(server);
      const configured = await loadLocalConfig(".pi/orchestrator.local.yaml");
      const command = configured.openshell.command;
      const gateway = configured.openshell.gateways.review ?? "openshell";
      const workspace = `pio-rev-${process.pid}`;
      const provider = "pio-review-fixture";
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

      let fixture: AppliedFixture | undefined;
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
          "fixture-reviewer",
          "--no-verify",
        ]);
        inferenceCreated = true;

        fixture = await createAppliedFixture();
        await passFixtureChecks(fixture);
        const client = new OpenShellClient({
          command,
          gateway,
          workspace,
          ...(configured.openshell.required_version
            ? { requiredVersion: configured.openshell.required_version }
            : {}),
        });
        const local = LocalConfigSchema.parse({
          version: 1,
          openshell: {
            command,
            required_version: configured.openshell.required_version,
            workspace,
            gateways: { review: gateway },
          },
          models: {
            review: {
              gateway: "review",
              pi_model: "fixture-reviewer",
              api: "openai-completions",
              locality: "local",
              context_window: 32_768,
              max_tokens: 4_096,
              reasoning: false,
            },
          },
        });

        const result = await runReview({
          store: fixture.store,
          project: fixture.project,
          plan: fixture.plan,
          runId: fixture.runId,
          taskId: fixture.task.id,
          lens: "spec",
          local,
          client,
          nonce: () => "12345678",
          startupTimeoutMs: 60_000,
          turnTimeoutMs: 60_000,
        });
        expect(result).toMatchObject({
          reused: false,
          record: { verdict: "pass", assessment },
          task: {
            status: "reviewing",
            gates: { "review-spec": { status: "pass" } },
          },
        });
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0])).toContain(
          "/workspace/input/review.patch",
        );
        expect(
          (await client.listSandboxes()).some(
            (sandbox) => sandbox.name === result.record.sandbox.name,
          ),
        ).toBe(false);
      } finally {
        await fixture?.dispose();
        if (inferenceCreated) {
          await runOpenShell(["inference", "delete"]).catch(() => undefined);
        }
        if (providerCreated) {
          await runOpenShell(["provider", "delete", provider]).catch(
            () => undefined,
          );
        }
        if (workspaceCreated) {
          await runGateway(["workspace", "delete", workspace]).catch(
            () => undefined,
          );
        }
        await close(server);
      }
    },
    15 * 60_000,
  );
});
