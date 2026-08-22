import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { approvalDigest } from "../src/approval.js";
import {
  candidateReference,
  createCandidate,
  RunWorkspaceStateSchema,
} from "../src/candidate.js";
import { sha256 } from "../src/digest.js";
import { WorkspaceLifecycle } from "../src/lifecycle.js";
import {
  LocalConfigSchema,
  loadLocalConfig,
  type LocalConfig,
} from "../src/local.js";
import { OpenShellClient } from "../src/openshell.js";
import { runRequiredReviews, type ReviewAssessment } from "../src/review.js";
import {
  createRunSourceWorkspace,
  type RunSourceWorkspace,
} from "../src/source.js";
import { DockerVolumeClient } from "../src/volume.js";
import { createWorkspaceManifestFromEntries } from "../src/workspace.js";
import {
  createAppliedFixture,
  type AppliedFixture,
} from "./applied-fixture.js";
import { passCandidateFixtureChecks } from "./candidate-fixture.js";

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

async function prepareCandidate(options: {
  readonly fixture: AppliedFixture;
  readonly local: LocalConfig;
  readonly docker: DockerVolumeClient;
}): Promise<RunSourceWorkspace> {
  const run = await options.fixture.store.readRun(options.fixture.runId);
  const workspace = await createRunSourceWorkspace({
    projectRoot: options.fixture.project.root,
    projectId: options.fixture.project.config.project.id,
    runId: run.id,
    commit: run.base_commit,
    local: options.local,
  });
  try {
    const mutation = await options.docker.runVolume({
      volume: workspace.volume,
      image: options.local.openshell.images!.pi,
      command: [
        "/usr/bin/node",
        "-e",
        "require('node:fs').writeFileSync('/run-volume/project/src/fixture.ts', \"export const fixture = 'reviewed';\\n\")",
      ],
    });
    if (mutation.exitCode !== 0) {
      throw new Error(
        mutation.stderr || "Cannot prepare live Review Candidate",
      );
    }
    const source = await workspace.inspect(1);
    const manifest = createWorkspaceManifestFromEntries(source.entries);
    const gitDiff = await workspace.gitDiff(source);
    const changed = manifest.entries.find(
      (entry) => entry.path === "src/fixture.ts",
    );
    if (!changed || changed.type === "directory") {
      throw new Error("Live Review Candidate change is absent");
    }
    const projectRecord = await options.fixture.store.read();
    const approval = projectRecord.approvals[options.fixture.plan.id]!;
    const provenance = sha256("live Review fixture provenance");
    const changeSet = {
      id: "change-live-review-1",
      digest: sha256("live Review fixture Change Set"),
    };
    const frozenAt = new Date().toISOString();
    const candidate = createCandidate({
      version: 2,
      id: "candidate-live-review-1",
      run: run.id,
      plan: run.plan_id,
      plan_revision: run.plan_revision,
      plan_digest: run.plan_digest,
      approval_digest: approvalDigest(approval),
      task: options.fixture.task.id,
      input_commit: run.tasks[options.fixture.task.id]!.input_commit!,
      workspace_generation: 1,
      manifest_digest: manifest.digest,
      git_diff_digest: gitDiff.digest,
      change_sets: [changeSet],
      changed_paths: [
        {
          path: changed.path,
          mode:
            changed.type === "symlink"
              ? "120000"
              : changed.type === "executable"
                ? "100755"
                : "100644",
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
    const lifecycle = new WorkspaceLifecycle(options.fixture.store, run.id);
    await Promise.all([
      lifecycle.manifests.put(manifest),
      lifecycle.candidates.put(candidate),
    ]);
    await options.fixture.store.updateRun(run.id, (current) => ({
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
    return workspace;
  } catch (error) {
    await options.docker
      .removeVolume(workspace.volume.name, true)
      .catch(() => undefined);
    throw error;
  }
}

(live ? describe : describe.skip)("live authoritative Review", () => {
  it(
    "runs a fresh Review Sandbox over an exact frozen Candidate",
    async () => {
      const assessment: ReviewAssessment = {
        verdict: "pass",
        conclusion: "The exact bounded change satisfies the Spec Lens.",
        blocking_findings: [],
        improvements: [],
        evidence: ["The frozen Candidate and Check record were supplied."],
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
      const workspaceGateway = configured.openshell.shared_workspace?.gateway;
      if (
        !configured.openshell.shared_workspace?.enabled ||
        !workspaceGateway ||
        !configured.openshell.images?.pi
      ) {
        throw new Error(
          "Live Candidate Reviews require configured Pi image and shared Workspace gateway",
        );
      }
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
      let docker: DockerVolumeClient | undefined;
      let volumeName: string | undefined;
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
        const local = LocalConfigSchema.parse({
          ...configured,
          openshell: {
            ...configured.openshell,
            workspace,
            gateways: {
              ...configured.openshell.gateways,
              check: "checks",
              review: gateway,
            },
          },
          models: {
            ...configured.models,
            "independent-review": {
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
        docker = new DockerVolumeClient({
          command: local.openshell.shared_workspace!.docker_command,
          ...(local.openshell.shared_workspace!.driver_version
            ? {
                requiredVersion:
                  local.openshell.shared_workspace!.driver_version,
              }
            : {}),
        });
        const runWorkspace = await prepareCandidate({
          fixture,
          local,
          docker,
        });
        volumeName = runWorkspace.volume.name;
        await passCandidateFixtureChecks({
          store: fixture.store,
          project: fixture.project,
          plan: fixture.plan,
          runId: fixture.runId,
          task: fixture.task,
          local,
          workspaceFactory: () => Promise.resolve(runWorkspace),
        });

        const client = new OpenShellClient({
          command,
          gateway,
          workspace,
          ...(configured.openshell.required_version
            ? { requiredVersion: configured.openshell.required_version }
            : {}),
        });
        const workspaceClient = new OpenShellClient({
          command,
          gateway: workspaceGateway,
          workspace: configured.openshell.workspace,
          ...(configured.openshell.required_version
            ? { requiredVersion: configured.openshell.required_version }
            : {}),
        });

        const result = await runRequiredReviews({
          store: fixture.store,
          project: fixture.project,
          plan: fixture.plan,
          runId: fixture.runId,
          taskId: fixture.task.id,
          local,
          clients: { spec: client, quality: client },
          workspaceClient,
          workspaceFactory: () => Promise.resolve(runWorkspace),
          nonce: (lens) => (lens === "spec" ? "12345678" : "87654321"),
          startupTimeoutMs: 60_000,
          turnTimeoutMs: 60_000,
        });
        expect(result).toMatchObject({
          verdict: "pass",
          required: ["spec", "quality"],
          reviews: [
            {
              reused: false,
              record: {
                version: 2,
                lens: "spec",
                verdict: "pass",
                assessment,
                candidate: { id: "candidate-live-review-1" },
                workspace: {
                  volume_name: runWorkspace.volume.name,
                  workspace_generation: 1,
                },
              },
            },
            {
              reused: false,
              record: { version: 2, lens: "quality", verdict: "pass" },
            },
          ],
          task: {
            status: "reviewing",
            gates: {
              "review-spec": { status: "pass" },
              "review-quality": { status: "pass" },
            },
          },
        });
        expect(requests).toHaveLength(2);
        const requestBody = JSON.stringify(requests);
        expect(requestBody).toContain("/workspace/input/candidate.json");
        expect(requestBody).toContain(
          result.reviews[0]!.record.candidate!.digest,
        );
        expect(requestBody).not.toContain("review.patch");
        const liveSandboxes = await client.listSandboxes();
        expect(
          result.reviews.some((review) =>
            liveSandboxes.some(
              (sandbox) => sandbox.name === review.record.sandbox.name,
            ),
          ),
        ).toBe(false);
      } finally {
        if (volumeName && docker) {
          await docker.removeVolume(volumeName, true).catch(() => undefined);
        }
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
