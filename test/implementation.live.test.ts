import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bundledPiPolicyDirectory,
  startWriteSession,
  type WriteSession,
} from "../src/agent.js";
import path from "node:path";
import { sha256 } from "../src/digest.js";
import { createWriteLease } from "../src/lease.js";
import { loadLocalConfig } from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { loadSandboxPolicy } from "../src/policy.js";
import { gitHead, loadProject } from "../src/project.js";
import { pathPolicyDigest } from "../src/scope.js";
import {
  createRunSourceWorkspace,
  verifyWorkspaceGateway,
} from "../src/source.js";
import { DockerVolumeClient } from "../src/volume.js";
import {
  compareWorkspaceManifests,
  createWorkspaceManifestFromEntries,
  effectiveRestrictedPaths,
} from "../src/workspace.js";
import { fixturePermissionCeiling } from "./fixture.js";

const live = process.env.PI_ORCHESTRATOR_LIVE_IMPLEMENTATION === "1";

(live ? describe : describe.skip)(
  "live leased implementation Workspace",
  () => {
    it(
      "mounts one Task root writable and inspects its change only after writer removal",
      async () => {
        const project = await loadProject(process.cwd());
        const local = await loadLocalConfig(".pi/orchestrator.local.yaml");
        const settings = local.openshell.shared_workspace;
        if (
          !settings?.enabled ||
          !settings.gateway ||
          !settings.driver_version
        ) {
          throw new Error("Shared Workspace configuration is not enabled");
        }
        const runId = `live-implementation-${randomBytes(3).toString("hex")}`;
        const docker = new DockerVolumeClient({
          command: settings.docker_command,
          requiredVersion: settings.driver_version,
        });
        const client = new OpenShellClient({
          command: local.openshell.command,
          gateway: settings.gateway,
          workspace: local.openshell.workspace,
          ...(local.openshell.required_version
            ? { requiredVersion: local.openshell.required_version }
            : {}),
        });
        const workspace = await createRunSourceWorkspace({
          projectRoot: project.root,
          projectId: project.config.project.id,
          runId,
          commit: await gitHead(project.root),
          local,
          docker,
        });
        let session: WriteSession | undefined;
        try {
          const identity = {
            run: runId,
            agent: "implementer",
            session: "implementation-one",
            generation: 1,
          } as const;
          const permissionCeiling = fixturePermissionCeiling(
            { kind: "task", task: "bounded-change" },
            "implementer",
          );
          const source = await workspace.inspect(0);
          const baseline = createWorkspaceManifestFromEntries(source.entries);
          const restrictedPatterns = effectiveRestrictedPaths(
            project.config.restricted_paths,
            local.workspace.restricted_paths,
          );
          const mountSet = workspace.writeMountSet({
            source,
            writePaths: ["src"],
            protectedPatterns: project.config.protected,
            restrictedPatterns,
          });
          const [preflight, policy] = await Promise.all([
            client.preflight(),
            loadSandboxPolicy(
              "write",
              path.join(bundledPiPolicyDirectory(), "write.yaml"),
            ),
          ]);
          const gateway = await verifyWorkspaceGateway(
            workspace,
            {
              gateway: settings.gateway,
              listGateways: client.listGateways.bind(client),
              getGatewayInfo: client.getGatewayInfo.bind(client),
            },
            preflight,
          );
          const createdAt = new Date().toISOString();
          const lease = createWriteLease({
            version: 2,
            id: "lease-one",
            run: runId,
            plan: "live-plan",
            plan_revision: 1,
            plan_digest: sha256("live plan"),
            task: "bounded-change",
            identity,
            workspace_generation: 0,
            baseline_manifest_digest: baseline.digest,
            write_roots: ["src"],
            write_roots_digest: pathPolicyDigest("write-roots", ["src"]),
            scope_policy_digest: pathPolicyDigest("scope", ["src/**"]),
            protected_policy_digest: pathPolicyDigest(
              "protected",
              project.config.protected,
            ),
            restricted_policy_digest: pathPolicyDigest(
              "restricted",
              restrictedPatterns,
            ),
            permission_ceiling_digest:
              permissionCeiling.permission_ceiling_digest,
            route_digest: sha256("live route"),
            policy_digest: policy.digest,
            image_digest: workspace.imageDigest,
            gateway_digest: gateway.digest,
            mount_set_digest: mountSet.digest,
            mount_table_digest: null,
            sandbox_name: "pio-w-live",
            sandbox_workspace: "default",
            sandbox_id: null,
            sandbox_digest: null,
            created_at: createdAt,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            renewal_count: 0,
            status: "preparing",
            activated_at: null,
            revocation_started_at: null,
            sandbox_deleted_at: null,
            released_at: null,
            reason: null,
          });
          const writer = workspace.bindWriter({
            source,
            mountSet,
            lease,
            gatewayDigest: gateway.digest,
          });
          session = await startWriteSession({
            client,
            identity,
            workspace: writer,
            permissionCeiling,
            writeGrant: { task: "bounded-change" },
            sandboxName: lease.sandbox_name,
          });
          expect(session.info.workspaceProjection).toMatchObject({
            lease_id: lease.id,
            lease_digest: lease.digest,
            mount_set_digest: mountSet.digest,
          });
          const change = await client.execSandbox(session.info.sandbox.name, [
            "/bin/sh",
            "-c",
            "printf 'live implementation probe\\n' > /workspace/project/src/orchestrator-live-probe.txt",
          ]);
          expect(change).toMatchObject({ exitCode: 0, stderr: "" });
          await session.stop();
          session = undefined;

          const resultSource = await workspace.inspect(1);
          const result = createWorkspaceManifestFromEntries(
            resultSource.entries,
          );
          const changes = compareWorkspaceManifests(baseline, result);
          const gitDiff = await workspace.gitDiff(resultSource);
          expect(changes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: "src/orchestrator-live-probe.txt",
                kind: "addition",
              }),
            ]),
          );
          expect(gitDiff.changes).toContainEqual({
            path: "src/orchestrator-live-probe.txt",
            index_status: "?",
            worktree_status: "?",
          });
        } finally {
          await session?.stop();
          await docker.removeVolume(workspace.volume.name, true);
        }
      },
      15 * 60_000,
    );
  },
);
