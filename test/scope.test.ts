import { describe, expect, it } from "vitest";
import {
  validateChangedPaths,
  validatePatchPaths,
  validateTaskWritePaths,
  type PathChange,
} from "../src/scope.js";
import { fixtureTask } from "./fixture.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function patch(...paths: readonly string[]) {
  const changes: PathChange[] = [...paths].sort().map((entryPath) => ({
    path: entryPath,
    status: "added",
    after: {
      path: entryPath,
      mode: "100644",
      size: 1,
      content_digest: digest,
    },
  }));
  return { bundle: { changes } };
}

describe("Task source scope", () => {
  it("allows every changed path covered by deterministic POSIX globs", () => {
    expect(
      validatePatchPaths({
        patch: patch("src/.hidden.ts", "src/domain/value.ts"),
        task: fixtureTask({ scope: ["src/**"] }),
        protectedPatterns: [],
      }),
    ).toMatchObject({
      changedPaths: ["src/.hidden.ts", "src/domain/value.ts"],
      scopePatterns: ["src/**"],
    });
  });

  it("rejects protected paths before considering Task scope", () => {
    expect(() =>
      validatePatchPaths({
        patch: patch(".agents/roles/implementer.md"),
        task: fixtureTask({ scope: ["**"] }),
        protectedPatterns: [".agents/**"],
      }),
    ).toThrowError(expect.objectContaining({ code: "protected_path_change" }));
  });

  it("rejects restricted paths before considering Task scope", () => {
    expect(() =>
      validatePatchPaths({
        patch: patch("secrets/token.txt"),
        task: fixtureTask({ scope: ["**"] }),
        protectedPatterns: [],
        restrictedPatterns: ["secrets/**"],
      }),
    ).toThrowError(expect.objectContaining({ code: "restricted_path_change" }));
  });

  it("treats the root of a protected subtree as protected", () => {
    expect(() =>
      validatePatchPaths({
        patch: patch(".agents"),
        task: fixtureTask({ scope: ["**"] }),
        protectedPatterns: [".agents/**"],
      }),
    ).toThrowError(expect.objectContaining({ code: "protected_path_change" }));
  });

  it("rejects any changed path outside the approved Task scope", () => {
    expect(() =>
      validatePatchPaths({
        patch: patch("README.md", "src/fixture.ts"),
        task: fixtureTask({ scope: ["src/**"] }),
        protectedPatterns: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "scope_exception" }));
  });

  it.each(["!src/**", "../src/**", "src\\**", "src//**", "./src/**"])(
    "rejects ambiguous or unsafe pattern %s",
    (scope) => {
      expect(() =>
        validatePatchPaths({
          patch: patch("src/fixture.ts"),
          task: fixtureTask({ scope: [scope] }),
          protectedPatterns: [],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_path_pattern" }));
    },
  );

  it("validates additions, deletions, modes, symlinks, and binary entries without Patch types", () => {
    const changes: PathChange[] = [
      { path: "src/added.bin", status: "added", after: { type: "regular" } },
      {
        path: "src/deleted.ts",
        status: "deleted",
        before: { type: "regular" },
      },
      {
        path: "src/link.ts",
        status: "modified",
        before: { type: "symlink" },
        after: { type: "symlink" },
      },
      {
        path: "src/mode.sh",
        status: "modified",
        before: { type: "regular" },
        after: { type: "executable" },
      },
    ];
    expect(
      validateChangedPaths({
        changes,
        task: fixtureTask(),
        protectedPatterns: [],
      }).changedPaths,
    ).toEqual([
      "src/added.bin",
      "src/deleted.ts",
      "src/link.ts",
      "src/mode.sh",
    ]);
  });
});

describe("Task write authority", () => {
  it("keeps literal write roots independent from semantic scope globs", () => {
    expect(
      validateTaskWritePaths({
        task: fixtureTask({
          write_paths: ["src", "test"],
          scope: ["src/**", "test/**"],
        }),
        protectedPatterns: [".agents/**"],
        restrictedPatterns: ["secrets/**"],
      }),
    ).toMatchObject({ writePaths: ["src", "test"] });
  });

  it.each([
    ["glob", fixtureTask({ write_paths: ["src/**"] }), "literal path"],
    [
      "outside scope",
      fixtureTask({ write_paths: ["test"], scope: ["src/**"] }),
      "not covered",
    ],
    [
      "protected",
      fixtureTask({ write_paths: ["src"], scope: ["src/**"] }),
      "protected pattern",
      ["src/private/**"],
      [],
    ],
    [
      "restricted",
      fixtureTask({ write_paths: ["secrets"], scope: ["secrets/**"] }),
      "restricted pattern",
      [],
      ["secrets/**"],
    ],
  ])(
    "rejects a %s write root",
    (
      _label,
      task,
      message,
      protectedPatterns = [],
      restrictedPatterns = [],
    ) => {
      expect(() =>
        validateTaskWritePaths({
          task,
          protectedPatterns,
          restrictedPatterns,
        }),
      ).toThrow(message);
    },
  );
});
