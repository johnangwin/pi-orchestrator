import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceSnapshot, verifySourceSnapshot } from "../src/snapshot.js";
import { commitFixture, createFixtureProject } from "./fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("source snapshots", () => {
  it("archives only selected tracked content from the exact commit", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    await writeFile(
      `${root}/src/fixture.ts`,
      "export const fixture = false;\n",
    );
    await writeFile(`${root}/untracked-secret.txt`, "not in snapshot\n");

    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    try {
      expect(snapshot.manifest).toMatchObject({
        version: 1,
        commit,
        selected_paths: ["src"],
      });
      expect(snapshot.manifest.entries.map((entry) => entry.path)).toEqual([
        "src/fixture.ts",
      ]);
      expect(snapshot.manifest.source_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const archived = await execFileAsync(
        "tar",
        ["-xOf", snapshot.archivePath, "src/fixture.ts"],
        { encoding: "utf8" },
      );
      expect(archived.stdout).toBe("export const fixture = true;\n");
      const listing = await execFileAsync(
        "tar",
        ["-tf", snapshot.archivePath],
        {
          encoding: "utf8",
        },
      );
      expect(listing.stdout).not.toContain("untracked-secret");
      expect(listing.stdout).not.toContain(".git/");
    } finally {
      await snapshot.dispose();
    }
    await expect(access(snapshot.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("produces the same digest for the same commit and selection", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const first = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src", "src"],
    });
    const second = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["./src"],
    });
    try {
      expect(first.manifest.source_digest).toBe(second.manifest.source_digest);
      expect(first.manifest.archive_digest).toBe(
        second.manifest.archive_digest,
      );
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it("does not inherit ambient Git control variables", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = `${root}/missing-git-directory`;
    let snapshot: Awaited<ReturnType<typeof createSourceSnapshot>> | undefined;
    try {
      snapshot = await createSourceSnapshot({
        projectRoot: root,
        commit,
        paths: ["src"],
      });
      expect(snapshot.manifest.commit).toBe(commit);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      await snapshot?.dispose();
    }
  });

  it("rejects clean filters before Git can execute them on the host", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const marker = `${root}/filter-ran`;
    const filter = `${root}/clean-filter.sh`;
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, "utf8");
    await chmod(filter, 0o755);
    await mkdir(`${root}/.git/info`, { recursive: true });
    await writeFile(
      `${root}/.git/info/attributes`,
      "src/fixture.ts filter=fixture-unsafe\n",
      "utf8",
    );
    await execFileAsync(
      "git",
      ["config", "filter.fixture-unsafe.clean", filter],
      { cwd: root },
    );
    await execFileAsync(
      "git",
      ["config", "filter.fixture-unsafe.required", "true"],
      { cwd: root },
    );

    await expect(
      createSourceSnapshot({ projectRoot: root, commit, paths: ["src"] }),
    ).rejects.toMatchObject({ code: "snapshot_filter_unsupported" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an archive changed after manifest creation", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    const snapshot = await createSourceSnapshot({
      projectRoot: root,
      commit,
      paths: ["src"],
    });
    try {
      await expect(verifySourceSnapshot(snapshot)).resolves.toEqual(
        snapshot.manifest,
      );
      await appendFile(snapshot.archivePath, "tampered");
      await expect(verifySourceSnapshot(snapshot)).rejects.toMatchObject({
        code: "invalid_source_snapshot",
      });
    } finally {
      await snapshot.dispose();
    }
  });

  it("rejects traversal and empty selections", async () => {
    const root = await createFixtureProject();
    roots.push(root);
    const commit = await commitFixture(root);
    await expect(
      createSourceSnapshot({
        projectRoot: root,
        commit,
        paths: ["../other"],
      }),
    ).rejects.toMatchObject({ code: "invalid_snapshot_path" });
    await expect(
      createSourceSnapshot({ projectRoot: root, commit, paths: [] }),
    ).rejects.toMatchObject({ code: "invalid_snapshot_path" });
    await expect(
      createSourceSnapshot({
        projectRoot: root,
        commit,
        paths: [":(top)**"],
      }),
    ).rejects.toMatchObject({ code: "empty_snapshot" });
  });
});
