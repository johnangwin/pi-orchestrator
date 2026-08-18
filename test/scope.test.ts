import { describe, expect, it } from "vitest";
import type { PatchChange, VerifiedPatch } from "../src/patch.js";
import { validatePatchPaths } from "../src/scope.js";
import { fixtureTask } from "./fixture.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function patch(...paths: readonly string[]): Pick<VerifiedPatch, "bundle"> {
  const changes: PatchChange[] = [...paths].sort().map((entryPath) => ({
    path: entryPath,
    status: "added",
    after: {
      path: entryPath,
      mode: "100644",
      size: 1,
      content_digest: digest,
    },
  }));
  return { bundle: { changes } } as Pick<VerifiedPatch, "bundle">;
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
});
