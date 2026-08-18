import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { CmuxClient } from "../src/cmux.js";
import { loadLocalConfig } from "../src/local.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_CMUX === "1" ? it : it.skip;

describe("live cmux adapter", () => {
  live(
    "verifies the configured CLI and control-socket capabilities",
    async () => {
      const local = await loadLocalConfig(
        path.resolve(".pi/orchestrator.local.yaml"),
      );
      const client = new CmuxClient({
        command: local.cmux.command,
        ...(local.cmux.required_version
          ? { requiredVersion: local.cmux.required_version }
          : {}),
      });

      const result = await client.preflight();
      expect(result.installedVersion).toBe(local.cmux.required_version);
      expect(result.versionMatches).toBe(true);
    },
  );
});
