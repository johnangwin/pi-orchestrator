import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactDescriptorSchema, ArtifactStore } from "../src/artifact.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { importPatchArtifact } from "../src/patch.js";
import { gitHead } from "../src/project.js";
import { startWriteSession, type WriteSession } from "../src/agent.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { fixturePermissionCeiling } from "./fixture.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_IMPLEMENTATION === "1";

(live ? describe : describe.skip)("live implementation Patch import", () => {
  it(
    "exports a write-Sandbox change and independently replays it on the host",
    async () => {
      const root = process.cwd();
      const stateRoot = await mkdtemp(
        path.join(os.tmpdir(), "pi-orchestrator-live-implementation-"),
      );
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
        paths: ["src"],
      });
      const identity = {
        run: "live-implementation",
        agent: "implementer",
        session: "session-one",
        generation: 1,
      } as const;
      let session: WriteSession | undefined;
      try {
        session = await startWriteSession({
          client,
          identity,
          snapshot,
          permissionCeiling: fixturePermissionCeiling(
            { kind: "task", task: "bounded-change" },
            "implementer",
          ),
          writeGrant: { task: "bounded-change" },
        });
        const change = await client.execSandbox(session.info.sandbox.name, [
          "/bin/sh",
          "-c",
          "printf 'live implementation probe\\n' > /workspace/project/src/orchestrator-live-probe.txt",
        ]);
        expect(change).toMatchObject({ exitCode: 0, stderr: "" });
        const exported = await client.execSandbox(session.info.sandbox.name, [
          "/usr/local/bin/orchestrator-export-patch",
          "live-patch",
          "bounded-change",
        ]);
        expect(exported.exitCode).toBe(0);
        const descriptor = ArtifactDescriptorSchema.parse(
          JSON.parse(exported.stdout) as unknown,
        );
        const imported = await importPatchArtifact({
          store: new ArtifactStore(path.join(stateRoot, "run")),
          client,
          descriptor,
          identity,
          task: "bounded-change",
          sourceSandbox: session.info.sandbox,
          snapshot,
        });
        expect(imported.value.bundle.changes).toMatchObject([
          {
            path: "src/orchestrator-live-probe.txt",
            status: "added",
          },
        ]);
      } finally {
        await session?.stop();
        await snapshot.dispose();
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
    15 * 60_000,
  );
});
