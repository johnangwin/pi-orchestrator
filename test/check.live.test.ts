import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { createAppliedFixture } from "./applied-fixture.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_CHECK === "1";

(live ? describe : describe.skip)("live authoritative Check", () => {
  it(
    "runs registered argv in a fresh no-inference OpenShell Sandbox",
    async () => {
      const fixture = await createAppliedFixture({
        mutate: async (project) => {
          await Promise.all([
            writeFile(
              path.join(project, "src", "fixture.ts"),
              "export const fixture = 'live-check';\n",
            ),
            writeFile(
              path.join(project, "src", "fixture.test.js"),
              `import assert from "node:assert/strict";
import test from "node:test";

test("fixture", () => assert.equal(2 + 2, 4));
`,
            ),
          ]);
        },
      });
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
      try {
        const result = await runCheck({
          store: fixture.store,
          project: fixture.project,
          plan: fixture.plan,
          runId: fixture.runId,
          taskId: fixture.task.id,
          checkId: "project-test",
          client,
        });
        expect(result).toMatchObject({
          reused: false,
          record: { verdict: "pass", exit_code: 0 },
          task: { status: "reviewing" },
        });
        expect(
          (await client.listSandboxes()).some(
            (sandbox) => sandbox.name === result.intent.sandbox,
          ),
        ).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
    15 * 60_000,
  );
});
