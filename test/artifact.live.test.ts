import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactSandboxPath,
  ArtifactStore,
  jsonArtifactContract,
  type ArtifactDescriptor,
} from "../src/artifact.js";
import { bundledCanaryImage } from "../src/canary.js";
import { sha256 } from "../src/digest.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient, type OpenShellSandbox } from "../src/openshell.js";
import { loadSandboxPolicy } from "../src/policy.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_ARTIFACT === "1";

(live ? describe : describe.skip)("live OpenShell Artifact import", () => {
  it(
    "downloads and atomically imports a validated Sandbox Artifact",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "pi-orchestrator-live-artifact-"),
      );
      const sandboxName = `pio-art-${randomBytes(3).toString("hex")}`;
      const artifactId = "live-artifact";
      const sandboxPath = artifactSandboxPath(artifactId);
      const content = '{"status":"ok","source":"openshell"}';
      const payload = Buffer.from(content, "utf8");
      let client: OpenShellClient | undefined;
      let sandbox: OpenShellSandbox | undefined;

      try {
        const local = await loadLocalConfig(
          path.resolve(".pi", "orchestrator.local.yaml"),
        );
        client = new OpenShellClient({
          command: local.openshell.command,
          workspace: local.openshell.workspace,
          ...(local.openshell.required_version
            ? { requiredVersion: local.openshell.required_version }
            : {}),
        });
        const policy = await loadSandboxPolicy(
          "read",
          path.resolve("sandbox", "policies", "read.yaml"),
        );
        sandbox = await client.createSandbox({
          name: sandboxName,
          from: bundledCanaryImage(),
          policyPath: policy.path,
          command: ["/usr/bin/true"],
        });
        if (sandbox.phase !== "Ready") {
          sandbox = await client.waitForSandbox(sandboxName);
        }
        const exportResult = await client.execSandbox(sandboxName, [
          "/bin/sh",
          "-c",
          'mkdir -p /sandbox/output/artifacts && printf %s "$1" > "$2"',
          "artifact-export",
          content,
          sandboxPath,
        ]);
        expect(exportResult.exitCode).toBe(0);

        const descriptor: ArtifactDescriptor = {
          version: 1,
          id: artifactId,
          kind: "fixture",
          run: "live-artifact-run",
          agent: "scout",
          session: "session-one",
          generation: 1,
          task: "artifact-import",
          sandbox_path: sandboxPath,
          media_type: "application/json",
          schema: "fixture/v1",
          byte_count: payload.byteLength,
          content_digest: sha256(payload),
          created_at: new Date().toISOString(),
        };
        const contract = jsonArtifactContract({
          kind: "fixture",
          schema: "fixture/v1",
          maxBytes: 4096,
          valueSchema: z
            .object({
              status: z.literal("ok"),
              source: z.literal("openshell"),
            })
            .strict(),
        });
        const store = new ArtifactStore(path.join(root, "run"));
        const imported = await store.importFromSandbox({
          client,
          descriptor,
          contract,
          identity: {
            run: "live-artifact-run",
            agent: "scout",
            session: "session-one",
            generation: 1,
          },
          task: "artifact-import",
          sourceSandbox: sandbox,
        });

        expect(imported.value).toEqual({ status: "ok", source: "openshell" });
        expect(imported.record.source.sandbox_id).toBe(sandbox.id);
        expect(await readFile(store.payloadPath(artifactId), "utf8")).toBe(
          content,
        );
        expect((await stat(store.payloadPath(artifactId))).mode & 0o777).toBe(
          0o400,
        );
      } finally {
        try {
          await client?.deleteSandbox(sandboxName, { missingOk: true });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    15 * 60_000,
  );
});
