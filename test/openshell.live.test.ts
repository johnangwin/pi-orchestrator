import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_OPENSHELL === "1";

(live ? describe : describe.skip)("live OpenShell isolation", () => {
  it(
    "passes every disposable Sandbox profile",
    async () => {
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

      const output = await runCanary({ client });
      expect(output.passed).toBe(true);
    },
    15 * 60_000,
  );
});
