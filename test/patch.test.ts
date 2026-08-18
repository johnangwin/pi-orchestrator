import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactStore,
  type ArtifactDescriptor,
  type ArtifactOpenShell,
} from "../src/artifact.js";
import { canonicalJson, digestParts, sha256 } from "../src/digest.js";
import { importPatchArtifact, type PatchBundle } from "../src/patch.js";
import type { OpenShellSandbox } from "../src/openshell.js";
import { createSourceSnapshot } from "../src/snapshot.js";
import { exportPatch } from "../sandbox/pi/export.mjs";
import { commitFixture, createFixtureProject } from "./fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const identity = {
  run: "run-one",
  seat: "implementer",
  session: "session-one",
  epoch: 1,
} as const;
const sourceSandbox: OpenShellSandbox = {
  annotations: {},
  created_at: "2026-08-18 10:00:00",
  current_policy_version: 1,
  id: "53502221-db6b-49f2-a316-673792b3faae",
  labels: {},
  name: "pio-write-one",
  phase: "Ready",
  resource_version: 1,
  workspace: "default",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function extract(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar", ["-xf", archive, "-C", destination]);
}

function copyingClient(payloadPath: string): ArtifactOpenShell {
  return {
    getSandbox: vi.fn(() => Promise.resolve(sourceSandbox)),
    execSandbox: vi.fn(async (_sandbox, command) => {
      const bytes = await readFile(payloadPath);
      if (command[0] === "/usr/bin/stat") {
        return {
          stdout: `regular file\t${bytes.byteLength}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: `${sha256(bytes).slice("sha256:".length)}  ${command.at(-1)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }),
    download: vi.fn(async (_sandbox, _source, destination) => {
      await copyFile(payloadPath, destination);
    }),
  };
}

function recomputeDiffDigest(bundle: PatchBundle): string {
  return digestParts("pi-orchestrator/patch/v1", [
    ["source-digest", bundle.source_digest],
    ["base-tree-digest", bundle.base_tree_digest],
    ["result-tree-digest", bundle.result_tree_digest],
    ["changes", canonicalJson(bundle.changes)],
    ["patch-digest", bundle.patch.content_digest],
  ]);
}

async function fixture() {
  const root = await createFixtureProject();
  roots.push(root);
  await writeFile(path.join(root, "src", "delete.ts"), "delete me\n");
  await writeFile(path.join(root, "src", "mode.sh"), "#!/bin/sh\nexit 0\n");
  const commit = await commitFixture(root);
  const snapshot = await createSourceSnapshot({
    projectRoot: root,
    commit,
    paths: ["src"],
  });
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-export-test-"),
  );
  roots.push(workspace);
  await Promise.all([
    extract(snapshot.archivePath, path.join(workspace, "base")),
    extract(snapshot.archivePath, path.join(workspace, "project")),
  ]);
  const sessionConfigPath = path.join(workspace, "session.json");
  await writeFile(
    sessionConfigPath,
    JSON.stringify({
      version: 1,
      identity,
      profile: "write",
      source_digest: snapshot.manifest.source_digest,
    }),
  );
  const outputRoot = path.join(workspace, "output");
  return { root, snapshot, workspace, sessionConfigPath, outputRoot };
}

async function changedExport() {
  const value = await fixture();
  const project = path.join(value.workspace, "project", "src");
  await writeFile(
    path.join(project, "fixture.ts"),
    "export const fixture = 'changed';\n",
  );
  await unlink(path.join(project, "delete.ts"));
  await chmod(path.join(project, "mode.sh"), 0o755);
  await writeFile(
    path.join(project, "binary.bin"),
    Buffer.from([0, 255, 1, 254, 2, 253]),
  );
  await symlink("fixture.ts", path.join(project, "fixture-link.ts"));
  const exported = await exportPatch({
    artifactId: "task-patch",
    task: "bounded-change",
    workspaceRoot: value.workspace,
    sessionConfigPath: value.sessionConfigPath,
    outputRoot: value.outputRoot,
  });
  return { ...value, exported };
}

describe("implementation Patch Artifacts", () => {
  it("exports and independently replays text, deletion, mode, and binary changes", async () => {
    const value = await changedExport();
    try {
      const store = new ArtifactStore(path.join(value.workspace, "run"));
      const imported = await importPatchArtifact({
        store,
        client: copyingClient(value.exported.artifactPath),
        descriptor: value.exported.descriptor as ArtifactDescriptor,
        identity,
        task: "bounded-change",
        sourceSandbox,
        snapshot: value.snapshot,
      });

      expect(imported.value.bundle.source_digest).toBe(
        value.snapshot.manifest.source_digest,
      );
      expect(
        imported.value.bundle.changes.map((change) => [
          change.path,
          change.status,
        ]),
      ).toEqual([
        ["src/binary.bin", "added"],
        ["src/delete.ts", "deleted"],
        ["src/fixture-link.ts", "added"],
        ["src/fixture.ts", "modified"],
        ["src/mode.sh", "modified"],
      ]);
      expect(
        imported.value.resultEntries.find(
          (entry) => entry.path === "src/mode.sh",
        )?.mode,
      ).toBe("100755");
      expect(
        imported.value.resultEntries.find(
          (entry) => entry.path === "src/binary.bin",
        )?.size,
      ).toBe(6);
      expect(
        imported.value.resultEntries.find(
          (entry) => entry.path === "src/fixture-link.ts",
        )?.mode,
      ).toBe("120000");
      expect((await stat(store.payloadPath("task-patch"))).mode & 0o777).toBe(
        0o400,
      );
      expect(
        await readFile(path.join(value.root, "src", "fixture.ts"), "utf8"),
      ).toBe("export const fixture = true;\n");
      expect(
        (
          await execFileAsync("git", ["status", "--porcelain=v1"], {
            cwd: value.root,
            encoding: "utf8",
          })
        ).stdout,
      ).toBe("");

      const retried = await exportPatch({
        artifactId: "task-patch",
        task: "bounded-change",
        workspaceRoot: value.workspace,
        sessionConfigPath: value.sessionConfigPath,
        outputRoot: value.outputRoot,
      });
      expect(retried.descriptor).toEqual(value.exported.descriptor);
    } finally {
      await value.snapshot.dispose();
    }
  });

  it("rejects a foreign source digest before publishing the Artifact", async () => {
    const value = await changedExport();
    try {
      const bundle = JSON.parse(
        await readFile(value.exported.artifactPath, "utf8"),
      ) as PatchBundle;
      const forged = {
        ...bundle,
        source_digest: `sha256:${"f".repeat(64)}`,
      };
      const payload = Buffer.from(`${JSON.stringify(forged)}\n`);
      await writeFile(value.exported.artifactPath, payload);
      const descriptor: ArtifactDescriptor = {
        ...value.exported.descriptor,
        byte_count: payload.byteLength,
        content_digest: sha256(payload),
      };
      const store = new ArtifactStore(path.join(value.workspace, "run-source"));
      await expect(
        importPatchArtifact({
          store,
          client: copyingClient(value.exported.artifactPath),
          descriptor,
          identity,
          task: "bounded-change",
          sourceSandbox,
          snapshot: value.snapshot,
        }),
      ).rejects.toMatchObject({ code: "invalid_artifact_schema" });
      await expect(
        access(store.artifactDirectory("task-patch")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await value.snapshot.dispose();
    }
  });

  it("rejects a self-consistent claim whose replayed result differs", async () => {
    const value = await changedExport();
    try {
      const bundle = JSON.parse(
        await readFile(value.exported.artifactPath, "utf8"),
      ) as PatchBundle;
      const forged = {
        ...bundle,
        result_tree_digest: `sha256:${"e".repeat(64)}`,
      } as PatchBundle;
      forged.diff_digest = recomputeDiffDigest(forged);
      const payload = Buffer.from(`${JSON.stringify(forged)}\n`);
      await writeFile(value.exported.artifactPath, payload);
      const descriptor: ArtifactDescriptor = {
        ...value.exported.descriptor,
        byte_count: payload.byteLength,
        content_digest: sha256(payload),
      };
      const store = new ArtifactStore(path.join(value.workspace, "run-result"));
      await expect(
        importPatchArtifact({
          store,
          client: copyingClient(value.exported.artifactPath),
          descriptor,
          identity,
          task: "bounded-change",
          sourceSandbox,
          snapshot: value.snapshot,
        }),
      ).rejects.toMatchObject({ code: "invalid_artifact_schema" });
      await expect(
        access(store.artifactDirectory("task-patch")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await value.snapshot.dispose();
    }
  });

  it("rejects an implementation workspace with no changes", async () => {
    const value = await fixture();
    try {
      await expect(
        exportPatch({
          artifactId: "empty-patch",
          task: "bounded-change",
          workspaceRoot: value.workspace,
          sessionConfigPath: value.sessionConfigPath,
          outputRoot: value.outputRoot,
        }),
      ).rejects.toThrow("Implementation produced no changes");
    } finally {
      await value.snapshot.dispose();
    }
  });

  it("rejects Git metadata introduced in the writable project copy", async () => {
    const value = await fixture();
    try {
      await mkdir(path.join(value.workspace, "project", ".git"));
      await writeFile(
        path.join(value.workspace, "project", ".git", "config"),
        "[core]\n",
      );
      await expect(
        exportPatch({
          artifactId: "metadata-patch",
          task: "bounded-change",
          workspaceRoot: value.workspace,
          sessionConfigPath: value.sessionConfigPath,
          outputRoot: value.outputRoot,
        }),
      ).rejects.toThrow("Unsafe workspace path '.git'");
    } finally {
      await value.snapshot.dispose();
    }
  });

  it("rejects export from a read-profile Session", async () => {
    const value = await fixture();
    try {
      await writeFile(
        value.sessionConfigPath,
        JSON.stringify({
          version: 1,
          identity,
          profile: "read",
          source_digest: value.snapshot.manifest.source_digest,
        }),
      );
      await expect(
        exportPatch({
          artifactId: "read-patch",
          task: "bounded-change",
          workspaceRoot: value.workspace,
          sessionConfigPath: value.sessionConfigPath,
          outputRoot: value.outputRoot,
        }),
      ).rejects.toThrow("Invalid immutable Session configuration");
    } finally {
      await value.snapshot.dispose();
    }
  });
});
