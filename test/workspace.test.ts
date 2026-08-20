import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareWorkspaceManifests,
  createWorkspaceManifest,
  effectiveRestrictedPaths,
  resolveWorkspaceMountRoots,
  validateWorkspaceManifest,
} from "../src/workspace.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-test-"));
  roots.push(root);
  return root;
}

async function populate(root: string, reverse = false): Promise<void> {
  const operations = [
    () => mkdir(path.join(root, "empty"), { recursive: true }),
    async () => {
      await mkdir(path.join(root, "bin"), { recursive: true });
      await writeFile(path.join(root, "bin", "tool.sh"), "#!/bin/sh\n");
      await chmod(path.join(root, "bin", "tool.sh"), 0o755);
    },
    async () => {
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(
        path.join(root, "data", "binary.bin"),
        Buffer.from([0, 255, 1, 254]),
      );
    },
  ];
  for (const operation of reverse ? operations.reverse() : operations) {
    await operation();
  }
  await symlink("tool.sh", path.join(root, "bin", "tool-link"));
}

describe("complete Run Workspace manifests", () => {
  it("produces the same complete manifest regardless of enumeration order", async () => {
    const left = await workspace();
    const right = await workspace();
    await populate(left);
    await populate(right, true);

    const first = await createWorkspaceManifest(left);
    const second = await createWorkspaceManifest(right);

    expect(first).toEqual(second);
    expect(first.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["bin", "directory"],
      ["bin/tool-link", "symlink"],
      ["bin/tool.sh", "executable"],
      ["data", "directory"],
      ["data/binary.bin", "regular"],
      ["empty", "directory"],
    ]);
    const linkEntry = first.entries.find(
      (entry) => entry.path === "bin/tool-link",
    );
    expect(linkEntry).toMatchObject({
      type: "symlink",
      byte_count: Buffer.byteLength("tool.sh"),
      link_target_base64: Buffer.from("tool.sh").toString("base64"),
    });
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
  });

  it("includes ignored and untracked content in the digest", async () => {
    const root = await workspace();
    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    await writeFile(path.join(root, "ignored.log"), "first\n");
    await writeFile(path.join(root, "untracked.txt"), "first\n");
    const baseline = await createWorkspaceManifest(root);

    await writeFile(path.join(root, "ignored.log"), "second\n");
    const ignoredChanged = await createWorkspaceManifest(root);
    await writeFile(path.join(root, "untracked.txt"), "second\n");
    const untrackedChanged = await createWorkspaceManifest(root);

    expect(ignoredChanged.digest).not.toBe(baseline.digest);
    expect(untrackedChanged.digest).not.toBe(ignoredChanged.digest);
    expect(ignoredChanged.entries.map((entry) => entry.path)).toContain(
      "ignored.log",
    );
  });

  it("hashes symlink targets without traversing them and rejects escapes", async () => {
    const parent = await workspace();
    const root = path.join(parent, "project");
    await mkdir(root);
    await writeFile(path.join(root, "target.txt"), "inside\n");
    await symlink("target.txt", path.join(root, "safe-link"));
    const manifest = await createWorkspaceManifest(root);
    const linkEntry = manifest.entries.find(
      (entry) => entry.path === "safe-link",
    );
    expect(linkEntry).toMatchObject({ type: "symlink" });
    expect(
      Buffer.from(
        linkEntry?.type === "symlink" ? linkEntry.link_target_base64 : "",
        "base64",
      ).toString("utf8"),
    ).toBe("target.txt");

    await writeFile(path.join(parent, "outside.txt"), "outside\n");
    await symlink("../outside.txt", path.join(root, "escape"));
    await expect(createWorkspaceManifest(root)).rejects.toMatchObject({
      code: "unsafe_workspace_symlink",
    });
    expect(await readFile(path.join(parent, "outside.txt"), "utf8")).toBe(
      "outside\n",
    );
  });

  it("fails closed on Git metadata, special files, and hard links", async () => {
    const gitRoot = await workspace();
    await mkdir(path.join(gitRoot, ".git"));
    await expect(createWorkspaceManifest(gitRoot)).rejects.toMatchObject({
      code: "workspace_git_metadata",
    });

    const specialRoot = await workspace();
    await execFileAsync("mkfifo", [path.join(specialRoot, "pipe")]);
    await expect(createWorkspaceManifest(specialRoot)).rejects.toMatchObject({
      code: "unsupported_workspace_entry",
    });

    const linkedRoot = await workspace();
    await writeFile(path.join(linkedRoot, "first"), "same inode\n");
    await link(path.join(linkedRoot, "first"), path.join(linkedRoot, "second"));
    await expect(createWorkspaceManifest(linkedRoot)).rejects.toMatchObject({
      code: "unsafe_workspace_hardlink",
    });
  });

  it("enforces explicit entry and byte bounds", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "one"), "1234");
    await writeFile(path.join(root, "two"), "5678");
    await expect(
      createWorkspaceManifest(root, { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "workspace_too_large" });
    await expect(
      createWorkspaceManifest(root, { maxBytes: 7 }),
    ).rejects.toMatchObject({ code: "workspace_too_large" });
  });

  it("rejects a tampered self-digested manifest", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "source.ts"), "export {};\n");
    const manifest = await createWorkspaceManifest(root);
    const forged = structuredClone(manifest);
    forged.entries[0]!.byte_count += 1;
    expect(() => validateWorkspaceManifest(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_workspace_manifest" }),
    );
  });

  it("classifies additions, content, deletion, mode, and symlink changes", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "content"), "before\n");
    await writeFile(path.join(root, "mode"), "same\n");
    await writeFile(path.join(root, "removed"), "gone\n");
    await writeFile(path.join(root, "target-one"), "one\n");
    await writeFile(path.join(root, "target-two"), "two\n");
    await symlink("target-one", path.join(root, "linked"));
    const baseline = await createWorkspaceManifest(root);

    await writeFile(path.join(root, "added"), "new\n");
    await writeFile(path.join(root, "content"), "after\n");
    await chmod(path.join(root, "mode"), 0o755);
    await rm(path.join(root, "removed"));
    await rm(path.join(root, "linked"));
    await symlink("target-two", path.join(root, "linked"));
    const result = await createWorkspaceManifest(root);

    expect(
      compareWorkspaceManifests(baseline, result).map((change) => [
        change.path,
        change.kind,
      ]),
    ).toEqual([
      ["added", "addition"],
      ["content", "modification"],
      ["linked", "symlink"],
      ["mode", "mode"],
      ["removed", "deletion"],
    ]);
  });
});

describe("Workspace mount-root resolution", () => {
  it("resolves sorted literal files and directories beneath a canonical root", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "entry.ts"), "export {};\n");

    const resolved = await resolveWorkspaceMountRoots(root, [
      "src/entry.ts",
      "src",
    ]).catch((error: unknown) => error);
    expect(resolved).toMatchObject({ code: "overlapping_write_paths" });

    await expect(
      resolveWorkspaceMountRoots(root, ["src/entry.ts"]),
    ).resolves.toMatchObject([
      {
        path: "src/entry.ts",
        type: "regular",
        canonicalPath: await realpath(path.join(root, "src", "entry.ts")),
      },
    ]);
  });

  it("rejects glob roots, symlink traversal, and paths outside the Workspace", async () => {
    const parent = await workspace();
    const root = path.join(parent, "project");
    await mkdir(root);
    await mkdir(path.join(parent, "outside"));
    await symlink("../outside", path.join(root, "linked"));

    await expect(resolveWorkspaceMountRoots(root, ["src/**"])).rejects.toThrow(
      "literal path",
    );
    await expect(
      resolveWorkspaceMountRoots(root, ["linked"]),
    ).rejects.toMatchObject({ code: "unsafe_workspace_mount_root" });
    await expect(
      resolveWorkspaceMountRoots(root, ["../outside"]),
    ).rejects.toThrow();
  });

  it("combines committed and additive machine-local restrictions", () => {
    expect(
      effectiveRestrictedPaths(["secrets/**", ".env"], ["private/**", ".env"]),
    ).toEqual([".env", "private/**", "secrets/**"]);
  });
});
