import path from "node:path";
import { Minimatch, type MinimatchOptions } from "minimatch";
import { z } from "zod";
import { OrchestratorError } from "./error.js";
import type { PlanTask } from "./plan.js";
import {
  RunWorkspacePathSchema,
  WritePathSchema,
  type WritePath,
} from "./workspace.js";

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

export const PathPolicySchema = z
  .array(PathPatternSchema)
  .max(MAX_PATH_PATTERNS)
  .superRefine((patterns, context) => {
    const seen = new Set<string>();
    for (const [index, pattern] of patterns.entries()) {
      if (seen.has(pattern)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate path pattern '${pattern}'`,
        });
      }
      seen.add(pattern);
    }
  });

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
  readonly literalRoot?: string;
  match(value: string): boolean;
}

export interface PathChange {
  readonly path: string;
  readonly status?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface ChangePathValidation {
  readonly task: string;
  readonly changedPaths: readonly string[];
  readonly scopePatterns: readonly string[];
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
}

export type PatchPathValidation = ChangePathValidation;

export interface TaskWritePathValidation {
  readonly task: string;
  readonly writePaths: readonly WritePath[];
  readonly scopePatterns: readonly string[];
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
}

function literalRoot(source: string): string | undefined {
  const segments: string[] = [];
  for (const segment of source.split("/")) {
    if (/[*?[\]]/u.test(segment)) break;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

function compilePatterns(
  values: readonly string[],
  kind: "scope" | "protected" | "restricted",
): readonly CompiledPattern[] {
  if (
    (kind === "scope" && values.length === 0) ||
    values.length > MAX_PATH_PATTERNS
  ) {
    throw new OrchestratorError(
      "invalid_path_pattern",
      `${kind} requires ${kind === "scope" ? "between 1" : "between 0"} and ${MAX_PATH_PATTERNS} path patterns`,
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
    const root = literalRoot(source.data);
    return {
      source: source.data,
      ...(root !== undefined ? { literalRoot: root } : {}),
      match(candidate: string) {
        return (
          matcher.match(candidate) || rootMatcher?.match(candidate) === true
        );
      },
    };
  });
}

function contains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function patternOverlapsRoot(
  pattern: CompiledPattern,
  root: WritePath,
): boolean {
  return (
    pattern.match(root) ||
    (pattern.literalRoot !== undefined && overlaps(pattern.literalRoot, root))
  );
}

export function pathMatchesPatterns(
  candidate: string,
  patterns: readonly string[],
): boolean {
  const parsed = RunWorkspacePathSchema.parse(candidate);
  return compilePatterns(patterns, "protected").some((pattern) =>
    pattern.match(parsed),
  );
}

export function validateTaskWritePaths(options: {
  readonly task: Pick<PlanTask, "id" | "scope" | "write_paths">;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
}): TaskWritePathValidation {
  const scope = compilePatterns(options.task.scope, "scope");
  const protectedPaths = compilePatterns(
    options.protectedPatterns,
    "protected",
  );
  const restrictedPaths = compilePatterns(
    options.restrictedPatterns,
    "restricted",
  );
  const writePaths = options.task.write_paths
    .map((value) => WritePathSchema.parse(value))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
  if (writePaths.length === 0) {
    throw new OrchestratorError(
      "invalid_write_path",
      `Task '${options.task.id}' requires at least one literal write path`,
    );
  }
  for (let index = 0; index < writePaths.length; index += 1) {
    const writePath = writePaths[index]!;
    if (index > 0 && overlaps(writePaths[index - 1]!, writePath)) {
      throw new OrchestratorError(
        "overlapping_write_paths",
        `Task '${options.task.id}' write path '${writePaths[index - 1]}' overlaps '${writePath}'`,
      );
    }
    if (!scope.some((pattern) => pattern.match(writePath))) {
      throw new OrchestratorError(
        "write_path_outside_scope",
        `Task '${options.task.id}' write path '${writePath}' is not covered by its semantic scope`,
      );
    }
    const protectedPath = protectedPaths.find((pattern) =>
      patternOverlapsRoot(pattern, writePath),
    );
    if (protectedPath) {
      throw new OrchestratorError(
        "write_path_protected",
        `Task '${options.task.id}' write path '${writePath}' overlaps protected pattern '${protectedPath.source}'`,
      );
    }
    const restrictedPath = restrictedPaths.find((pattern) =>
      patternOverlapsRoot(pattern, writePath),
    );
    if (restrictedPath) {
      throw new OrchestratorError(
        "write_path_restricted",
        `Task '${options.task.id}' write path '${writePath}' overlaps restricted pattern '${restrictedPath.source}'`,
      );
    }
  }
  return {
    task: options.task.id,
    writePaths,
    scopePatterns: scope.map((pattern) => pattern.source),
    protectedPatterns: protectedPaths.map((pattern) => pattern.source),
    restrictedPatterns: restrictedPaths.map((pattern) => pattern.source),
  };
}

export function validateChangedPaths(options: {
  readonly changes: readonly PathChange[];
  readonly task: Pick<PlanTask, "id" | "scope">;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns?: readonly string[];
}): ChangePathValidation {
  const scope = compilePatterns(options.task.scope, "scope");
  const protectedPaths = compilePatterns(
    options.protectedPatterns,
    "protected",
  );
  const restrictedPaths = compilePatterns(
    options.restrictedPatterns ?? [],
    "restricted",
  );
  const paths = options.changes.map((change) =>
    RunWorkspacePathSchema.parse(change.path),
  );
  if (new Set(paths).size !== paths.length) {
    throw new OrchestratorError(
      "duplicate_changed_path",
      `Task '${options.task.id}' contains duplicate changed paths`,
    );
  }
  const restrictedChanges = paths.filter((candidate) =>
    restrictedPaths.some((pattern) => pattern.match(candidate)),
  );
  if (restrictedChanges.length > 0) {
    throw new OrchestratorError(
      "restricted_path_change",
      `Task '${options.task.id}' changes restricted paths: ${restrictedChanges.join(", ")}`,
    );
  }
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
    restrictedPatterns: restrictedPaths.map((pattern) => pattern.source),
  };
}

export function validatePatchPaths(options: {
  readonly patch: {
    readonly bundle: { readonly changes: readonly PathChange[] };
  };
  readonly task: Pick<PlanTask, "id" | "scope">;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns?: readonly string[];
}): PatchPathValidation {
  return validateChangedPaths({
    changes: options.patch.bundle.changes,
    task: options.task,
    protectedPatterns: options.protectedPatterns,
    ...(options.restrictedPatterns
      ? { restrictedPatterns: options.restrictedPatterns }
      : {}),
  });
}
