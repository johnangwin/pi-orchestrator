import path from "node:path";
import { Minimatch, type MinimatchOptions } from "minimatch";
import { z } from "zod";
import { OrchestratorError } from "./error.js";
import type { PatchChange, VerifiedPatch } from "./patch.js";
import type { PlanTask } from "./plan.js";

const MAX_PATH_PATTERNS = 1_024;

export const PathPatternSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !value.includes("\\"), "must use POSIX separators")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine((value) => !value.startsWith("!"), "must not use negation")
  .refine((value) => !value.includes("//"), "must not contain empty segments")
  .refine(
    (value) =>
      !value.split("/").some((segment) => segment === "." || segment === ".."),
    "must not contain dot or parent segments",
  );

const matcherOptions: MinimatchOptions = {
  dot: true,
  nocase: false,
  nobrace: true,
  noext: true,
  nonegate: true,
  noglobstar: false,
  matchBase: false,
  platform: "linux",
};

interface CompiledPattern {
  readonly source: string;
  match(value: string): boolean;
}

export interface PatchPathValidation {
  readonly task: string;
  readonly changedPaths: readonly string[];
  readonly scopePatterns: readonly string[];
  readonly protectedPatterns: readonly string[];
}

function compilePatterns(
  values: readonly string[],
  kind: "scope" | "protected",
): readonly CompiledPattern[] {
  if (
    (kind === "scope" && values.length === 0) ||
    values.length > MAX_PATH_PATTERNS
  ) {
    throw new OrchestratorError(
      "invalid_path_pattern",
      `${kind} requires between 1 and ${MAX_PATH_PATTERNS} path patterns`,
    );
  }
  return values.map((value) => {
    const source = PathPatternSchema.safeParse(value);
    if (!source.success) {
      throw new OrchestratorError(
        "invalid_path_pattern",
        `Invalid ${kind} path pattern '${value}': ${source.error.issues.map((issue) => issue.message).join(", ")}`,
      );
    }
    let matcher: Minimatch;
    let rootMatcher: Minimatch | undefined;
    try {
      matcher = new Minimatch(source.data, matcherOptions);
      if (!matcher.makeRe()) throw new Error("pattern does not compile");
      if (source.data.endsWith("/**")) {
        rootMatcher = new Minimatch(source.data.slice(0, -3), matcherOptions);
        if (!rootMatcher.makeRe()) throw new Error("pattern does not compile");
      }
    } catch (error) {
      throw new OrchestratorError(
        "invalid_path_pattern",
        `Invalid ${kind} path pattern '${value}'`,
        { cause: error },
      );
    }
    return {
      source: source.data,
      match(candidate: string) {
        return (
          matcher.match(candidate) || rootMatcher?.match(candidate) === true
        );
      },
    };
  });
}

function changedPaths(changes: readonly PatchChange[]): readonly string[] {
  return changes.map((change) => change.path);
}

export function validatePatchPaths(options: {
  readonly patch: Pick<VerifiedPatch, "bundle">;
  readonly task: Pick<PlanTask, "id" | "scope">;
  readonly protectedPatterns: readonly string[];
}): PatchPathValidation {
  const scope = compilePatterns(options.task.scope, "scope");
  const protectedPaths = compilePatterns(
    options.protectedPatterns,
    "protected",
  );
  const paths = changedPaths(options.patch.bundle.changes);
  const protectedChanges = paths.filter((candidate) =>
    protectedPaths.some((pattern) => pattern.match(candidate)),
  );
  if (protectedChanges.length > 0) {
    throw new OrchestratorError(
      "protected_path_change",
      `Task '${options.task.id}' changes protected paths: ${protectedChanges.join(", ")}`,
    );
  }

  const outsideScope = paths.filter(
    (candidate) => !scope.some((pattern) => pattern.match(candidate)),
  );
  if (outsideScope.length > 0) {
    throw new OrchestratorError(
      "scope_exception",
      `Task '${options.task.id}' changes paths outside its scope: ${outsideScope.join(", ")}`,
    );
  }

  return {
    task: options.task.id,
    changedPaths: paths,
    scopePatterns: scope.map((pattern) => pattern.source),
    protectedPatterns: protectedPaths.map((pattern) => pattern.source),
  };
}
