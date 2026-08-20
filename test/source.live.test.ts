import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_CLIENT_VERSION,
  PI_RUNTIME_VERSION,
  startReadSession,
  type ReadSession,
} from "../src/agent.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { gitHead, loadProject } from "../src/project.js";
import { createReadOnlySourceWorkspace } from "../src/source.js";
import { fixturePermissionCeiling } from "./fixture.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_WORKSPACE_SESSION === "1";

(live ? describe : describe.skip)("live shared Workspace Pi Session", () => {
  it(
    "mounts the exact commit read-only through the pinned static image",
    async () => {
      const project = await loadProject(process.cwd());
      const local = await loadLocalConfig(
        path.resolve(project.root, ".pi", "orchestrator.local.yaml"),
      );
      const settings = local.openshell.shared_workspace;
      if (!settings?.enabled || !settings.gateway) {
        throw new Error("Shared Workspace volumes are not enabled");
      }
      const workspace = await createReadOnlySourceWorkspace({
        projectRoot: project.root,
        projectId: project.config.project.id,
        workspaceId: "live-workspace-session",
        commit: await gitHead(project.root),
        local,
        restrictedPaths: project.config.restricted_paths,
      });
      const client = new OpenShellClient({
        command: local.openshell.command,
        gateway: settings.gateway,
        workspace: local.openshell.workspace,
        ...(local.openshell.required_version
          ? { requiredVersion: local.openshell.required_version }
          : {}),
      });
      let session: ReadSession | undefined;
      try {
        session = await startReadSession({
          client,
          identity: {
            run: "live-workspace-session",
            agent: "scout",
            session: "session-one",
            generation: 1,
          },
          workspace,
          permissionCeiling: fixturePermissionCeiling(),
          startupTimeoutMs: 60_000,
        });
        expect(session.info.piVersion).toBe(PI_RUNTIME_VERSION);
        expect(session.info.clientVersion).toBe(PI_CLIENT_VERSION);
        expect(session.info.sourceDigest).toBe(
          workspace.manifest.source_digest,
        );
        expect(session.info.workspaceProjection).toMatchObject({
          workspace_generation: workspace.manifest.workspace_generation,
          volume_digest: workspace.volume.digest,
          mount_set_digest: workspace.mountSet.digest,
          image_digest: workspace.imageDigest,
        });
        await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
        await session.reconnect();
        await expect(session.ping()).resolves.toMatch(/^[a-f0-9]{32}$/);
      } finally {
        await session?.stop();
        await workspace.dispose();
      }
    },
    15 * 60_000,
  );
});
