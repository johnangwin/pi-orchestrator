import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { approvalDigest } from "../src/approval.js";
import {
  candidateReference,
  createCandidate,
  RunWorkspaceStateSchema,
  type Candidate,
  type CandidatePath,
} from "../src/candidate.js";
import { sha256 } from "../src/digest.js";
import { LocalConfigSchema, type LocalConfig } from "../src/local.js";
import { WorkspaceLifecycle } from "../src/lifecycle.js";
import type { ProcessResult } from "../src/openshell.js";
import type { WorkspaceGitChange } from "../src/git.js";
import {
  RunSourceWorkspace,
  type WorkspaceSourceDocker,
} from "../src/source.js";
import { DockerVolumeCapability } from "../src/volume.js";
import { createWorkspaceManifestFromEntries } from "../src/workspace.js";
import {
  createAppliedFixture,
  fixtureCheckImage,
  type AppliedFixture,
} from "./applied-fixture.js";

const execFileAsync = promisify(execFile);
const helper = fileURLToPath(
  new URL("../sandbox/pi/workspace.mjs", import.meta.url),
);
const dockerVersion = "29.5.2";
const piImage =
  "fixture-pi@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const candidateLocal: LocalConfig = LocalConfigSchema.parse({
  version: 2,
  openshell: {
    command: "openshell",
    required_version: "0.0.106",
    workspace: "checks",
    gateways: { check: "checks" },
    images: {
      pi: piImage,
      check: fixtureCheckImage.source,
    },
    shared_workspace: {
      enabled: true,
      gateway: "workspace",
      driver: "docker",
      driver_version: dockerVersion,
      docker_command: "docker",
    },
  },
  workspace: { volume_prefix: "pio-test", restricted_paths: [] },
});

class CandidateDocker implements WorkspaceSourceDocker {
  readonly command = "fixture-docker";
  readonly capability: DockerVolumeCapability;

  constructor(
    readonly root: string,
    readonly commit: string,
    readonly changes: readonly WorkspaceGitChange[],
    labels: Readonly<Record<string, string>>,
  ) {
    this.capability = DockerVolumeCapability.fromInspection(
      {
        CreatedAt: "2026-08-20T00:00:00Z",
        Driver: "local",
        Labels: labels,
        Mountpoint: root,
        Name: "pio-test-candidate-workspace",
        Options: null,
        Scope: "local",
      },
      "pio-test-candidate-workspace",
      labels,
    );
  }

  version(): Promise<string> {
    return Promise.resolve(dockerVersion);
  }

  createVolume(): Promise<DockerVolumeCapability> {
    return Promise.resolve(this.capability);
  }

  inspectVolume(
    name: string,
    labels?: Readonly<Record<string, string>>,
  ): Promise<DockerVolumeCapability | undefined> {
    if (
      name !== this.capability.name ||
      (labels &&
        Object.entries(labels).some(
          ([key, value]) => this.capability.labels[key] !== value,
        ))
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.capability);
  }

  seedGitWorkspace(): Promise<ProcessResult> {
    return Promise.resolve({ stdout: "", stderr: "unused", exitCode: 1 });
  }

  async inspectWorkspaceVolume(): Promise<ProcessResult> {
    const result = await execFileAsync(process.execPath, [
      helper,
      "inspect",
      path.join(this.root, "project"),
    ]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  }

  inspectWorkspaceGitStatus(): Promise<ProcessResult> {
    return Promise.resolve({
      stdout: `${JSON.stringify({
        commit: this.commit,
        changes: this.changes,
      })}\n`,
      stderr: "",
      exitCode: 0,
    });
  }

  removeVolume(): Promise<void> {
    return Promise.resolve();
  }
}

function gitChanges(fixture: AppliedFixture): WorkspaceGitChange[] {
  return fixture.patch.value.bundle.changes.map((change) => ({
    path: change.path,
    index_status: change.status === "added" ? "?" : " ",
    worktree_status:
      change.status === "added" ? "?" : change.status === "deleted" ? "D" : "M",
  }));
}

function candidatePaths(
  fixture: AppliedFixture,
  entries: Awaited<ReturnType<RunSourceWorkspace["inspect"]>>["entries"],
): CandidatePath[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return fixture.patch.value.bundle.changes.map((change) => {
    const entry = byPath.get(change.path);
    if (!entry) {
      return {
        path: change.path,
        mode: "absent",
        byte_count: 0,
        content_digest: null,
      };
    }
    if (entry.type === "directory") {
      return {
        path: entry.path,
        mode: "040000",
        byte_count: 0,
        content_digest: null,
      };
    }
    if (entry.type === "symlink") {
      return {
        path: entry.path,
        mode: "120000",
        byte_count: entry.byte_count,
        content_digest:
          entry.link_target_digest as CandidatePath["content_digest"],
      };
    }
    return {
      path: entry.path,
      mode: entry.type === "executable" ? "100755" : "100644",
      byte_count: entry.byte_count,
      content_digest: entry.content_digest as CandidatePath["content_digest"],
    };
  });
}

export interface CandidateFixture extends AppliedFixture {
  readonly candidate: Candidate;
  readonly local: LocalConfig;
  readonly workspace: RunSourceWorkspace;
  readonly volumeRoot: string;
  readonly workspaceFactory: () => Promise<RunSourceWorkspace>;
}

export async function createCandidateFixture(
  options: Parameters<typeof createAppliedFixture>[0] = {},
): Promise<CandidateFixture> {
  const fixture = await createAppliedFixture(options);
  const volumeRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-candidate-volume-"),
  );
  try {
    const projectRoot = path.join(volumeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    await cp(fixture.worktree, projectRoot, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(fixture.worktree, source);
        return relative !== ".git" && !relative.startsWith(`.git${path.sep}`);
      },
    });
    const run = await fixture.store.readRun(fixture.runId);
    const labels = {
      "pio.kind": "run-workspace",
      "pio.project": fixture.project.config.project.id,
      "pio.run": run.id,
      "pio.commit": run.base_commit.slice(0, 63),
    };
    const docker = new CandidateDocker(
      volumeRoot,
      run.base_commit,
      gitChanges(fixture),
      labels,
    );
    const workspace = new RunSourceWorkspace(
      fixture.project.config.project.id,
      run.id,
      run.base_commit,
      docker.capability,
      piImage,
      dockerVersion,
      labels,
      path.join(fixture.root, ".git"),
      docker,
    );
    const source = await workspace.inspect(1);
    const manifest = createWorkspaceManifestFromEntries(source.entries);
    const gitDiff = await workspace.gitDiff(source);
    const projectRecord = await fixture.store.read();
    const approval = projectRecord.approvals[fixture.plan.id]!;
    const changeSet = {
      id: "change-bounded-change-1",
      digest: sha256("fixture Change Set"),
    };
    const provenance = sha256("fixture Candidate provenance");
    const candidate = createCandidate({
      version: 2,
      id: "candidate-bounded-change-1",
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
      changed_paths: candidatePaths(fixture, source.entries),
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
      frozen_at: "2026-08-20T15:00:00.000Z",
      status: "frozen",
      status_at: "2026-08-20T15:00:00.000Z",
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
    return {
      ...fixture,
      candidate,
      local: candidateLocal,
      workspace,
      volumeRoot,
      workspaceFactory: () => Promise.resolve(workspace),
      async dispose() {
        await rm(volumeRoot, { recursive: true, force: true });
        await fixture.dispose();
      },
    };
  } catch (error) {
    await rm(volumeRoot, { recursive: true, force: true });
    await fixture.dispose();
    throw error;
  }
}
