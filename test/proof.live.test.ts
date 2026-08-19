import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { runWorkspaceVolumeCanary } from "../src/proof.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_WORKSPACE_VOLUME === "1";

(live ? describe : describe.skip)("live OpenShell Workspace volume", () => {
  it(
    "passes the exact local Docker named-volume proof",
    async () => {
      const local = await loadLocalConfig(
        path.resolve(".pi", "orchestrator.local.yaml"),
      );
      const settings = local.openshell.shared_workspace;
      if (!settings?.gateway) {
        throw new Error("Shared Workspace volumes are not configured");
      }
      const client = new OpenShellClient({
        command: local.openshell.command,
        gateway: settings.gateway,
        workspace: local.openshell.workspace,
        ...(local.openshell.required_version
          ? { requiredVersion: local.openshell.required_version }
          : {}),
      });

      const result = await runWorkspaceVolumeCanary({ client, settings });
      expect(result.passed).toBe(true);
    },
    15 * 60_000,
  );
});
