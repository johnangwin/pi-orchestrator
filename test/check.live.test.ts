import path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalDigest } from "../src/approval.js";
import {
  candidateReference,
  createCandidate,
  RunWorkspaceStateSchema,
} from "../src/candidate.js";
import { runCheck } from "../src/check.js";
import { sha256 } from "../src/digest.js";
import { WorkspaceLifecycle } from "../src/lifecycle.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { createRunSourceWorkspace } from "../src/source.js";
import { DockerVolumeClient } from "../src/volume.js";
import { createWorkspaceManifestFromEntries } from "../src/workspace.js";
import { createAppliedFixture } from "./applied-fixture.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_CHECK === "1";

(live ? describe : describe.skip)("live authoritative Check", () => {
  it(
    "runs registered argv over a frozen Candidate in a fresh no-inference Sandbox",
    async () => {
      const fixture = await createAppliedFixture({
        checks: {
          "project-test": {
            argv: [
              "node",
              "-e",
              "const fs=require('node:fs'); const out=process.env.NODE_COMPILE_CACHE; if(!out) throw new Error('scratch missing'); fs.mkdirSync(out,{recursive:true}); fs.writeFileSync(`${out}/check-output`,'passed'); fs.readFileSync('src/fixture.ts','utf8');",
            ],
          },
        },
      });
      const local = await loadLocalConfig(
        path.resolve(".pi", "orchestrator.local.yaml"),
      );
      const run = await fixture.store.readRun(fixture.runId);
      const checkGateway = local.openshell.gateways.check;
      const workspaceGateway = local.openshell.shared_workspace?.gateway;
      if (!checkGateway || !workspaceGateway) {
        throw new Error(
          "Live Candidate Checks require configured check and shared Workspace gateways",
        );
      }
      const docker = new DockerVolumeClient({
        command: local.openshell.shared_workspace!.docker_command,
        ...(local.openshell.shared_workspace!.driver_version
          ? {
              requiredVersion: local.openshell.shared_workspace!.driver_version,
            }
          : {}),
      });
      let volumeName: string | undefined;
      try {
        const workspace = await createRunSourceWorkspace({
          projectRoot: fixture.project.root,
          projectId: fixture.project.config.project.id,
          runId: run.id,
          commit: run.base_commit,
          local,
        });
        volumeName = workspace.volume.name;
        const mutation = await docker.runVolume({
          volume: workspace.volume,
          image: local.openshell.images!.pi,
          command: [
            "/usr/bin/node",
            "-e",
            "require('node:fs').writeFileSync('/run-volume/project/src/fixture.ts', \"export const fixture = 'checked';\\n\")",
          ],
        });
        if (mutation.exitCode !== 0) {
          throw new Error(mutation.stderr || "Cannot prepare live Candidate");
        }
        const source = await workspace.inspect(1);
        const manifest = createWorkspaceManifestFromEntries(source.entries);
        const gitDiff = await workspace.gitDiff(source);
        const changed = manifest.entries.find(
          (entry) => entry.path === "src/fixture.ts",
        );
        if (!changed || changed.type === "directory") {
          throw new Error("Live Candidate change is absent");
        }
        const projectRecord = await fixture.store.read();
        const approval = projectRecord.approvals[fixture.plan.id]!;
        const provenance = sha256("live Check fixture provenance");
        const changeSet = {
          id: "change-live-check-1",
          digest: sha256("live Check fixture Change Set"),
        };
        const frozenAt = new Date().toISOString();
        const candidate = createCandidate({
          version: 2,
          id: "candidate-live-check-1",
          run: run.id,
          plan: run.plan_id,
          plan_revision: run.plan_revision,
          plan_digest: run.plan_digest,
          approval_digest: approvalDigest(approval),
          task: fixture.task.id,
          input_commit: run.tasks[fixture.task.id]!.input_commit!,
          workspace_generation: 1,
          manifest_digest: manifest.digest,
          git_diff_digest: gitDiff.digest,
          change_sets: [changeSet],
          changed_paths: [
            {
              path: changed.path,
              mode: changed.type === "executable" ? "100755" : "100644",
              byte_count: changed.byte_count,
              content_digest:
                changed.type === "symlink"
                  ? changed.link_target_digest
                  : changed.content_digest,
            },
          ],
          permission_policy_digest: run.permission_policy_digest,
          routing_policy_digest: run.routing_policy_digest,
          scope_policy_digest: provenance,
          protected_policy_digest: provenance,
          restricted_policy_digest: provenance,
          permission_ceiling_digests: [provenance],
          route_digests: [provenance],
          image_digests: [provenance],
          policy_digests: [provenance],
          gateway_digests: [provenance],
          mount_set_digests: [provenance],
          mount_table_digests: [provenance],
          sandbox_digests: [provenance],
          frozen_at: frozenAt,
          status: "frozen",
          status_at: frozenAt,
          reason: null,
        });
        const lifecycle = new WorkspaceLifecycle(fixture.store, run.id);
        await Promise.all([
          lifecycle.manifests.put(manifest),
          lifecycle.candidates.put(candidate),
        ]);
        await fixture.store.updateRun(run.id, (current) => ({
          ...current,
          workspace: RunWorkspaceStateSchema.parse({
            volume_name: workspace.volume.name,
            volume_digest: workspace.volume.digest,
            branch: current.branch,
            phase: "frozen",
            generation: candidate.workspace_generation,
            manifest_digest: candidate.manifest_digest,
            git_diff_digest: candidate.git_diff_digest,
            active_lease: null,
            change_sets: [changeSet],
            candidate: candidateReference(candidate),
            drift: null,
          }),
        }));
        const clientOptions = {
          command: local.openshell.command,
          workspace: local.openshell.workspace,
          ...(local.openshell.required_version
            ? { requiredVersion: local.openshell.required_version }
            : {}),
        };
        const client = new OpenShellClient({
          ...clientOptions,
          gateway: checkGateway,
        });
        const workspaceClient = new OpenShellClient({
          ...clientOptions,
          gateway: workspaceGateway,
        });
        const result = await runCheck({
          store: fixture.store,
          project: fixture.project,
          plan: fixture.plan,
          runId: fixture.runId,
          taskId: fixture.task.id,
          checkId: "project-test",
          client,
          workspaceClient,
          local,
        });
        expect(result).toMatchObject({
          reused: false,
          record: {
            version: 2,
            verdict: "pass",
            exit_code: 0,
            candidate: {
              id: candidate.id,
              digest: candidate.digest,
            },
          },
          task: { status: "reviewing" },
        });
        expect(result.intent.scratch?.environment.NODE_COMPILE_CACHE).toBe(
          "/sandbox/check-scratch/cache/node",
        );
        expect(
          (await client.listSandboxes()).some(
            (sandbox) => sandbox.name === result.intent.sandbox,
          ),
        ).toBe(false);
      } finally {
        if (volumeName) await docker.removeVolume(volumeName, true);
        await fixture.dispose();
      }
    },
    15 * 60_000,
  );
});
