import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  IdentifierSchema,
  ReviewLensSchema,
  type ProjectConfig,
} from "./config.js";
import { digestPlan, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { PathPatternSchema, validateTaskWritePaths } from "./scope.js";
import { WritePathSchema } from "./workspace.js";

export const SourceAnchorSchema = z
  .object({
    path: z.string().min(1),
    symbol: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;

export const PlanTaskSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    role: IdentifierSchema,
    goal: z.string().min(1),
    depends: z.array(IdentifierSchema),
    write_paths: z.array(WritePathSchema).min(1).max(1_024),
    scope: z.array(PathPatternSchema).min(1).max(1_024),
    non_goals: z.array(z.string().min(1)),
    acceptance: z.array(z.string().min(1)).min(1),
    checks: z.array(IdentifierSchema).min(1),
    reviews: z.array(ReviewLensSchema).min(1),
  })
  .strict()
  .superRefine((task, context) => {
    if (new Set(task.write_paths).size !== task.write_paths.length) {
      context.addIssue({
        code: "custom",
        path: ["write_paths"],
        message: "write paths must be unique",
      });
    }
    if (new Set(task.reviews).size !== task.reviews.length) {
      context.addIssue({
        code: "custom",
        path: ["reviews"],
        message: "Review Lenses must be unique",
      });
    }
    try {
      validateTaskWritePaths({
        task,
        protectedPatterns: [],
        restrictedPatterns: [],
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["write_paths"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const TasksFileSchema = z
  .object({
    version: z.literal(2),
    plan: z
      .object({
        id: IdentifierSchema,
        revision: z.number().int().positive(),
      })
      .strict(),
    tasks: z.array(PlanTaskSchema).min(1),
  })
  .strict();
export type TasksFile = z.infer<typeof TasksFileSchema>;

const requiredSections = [
  "Context",
  "Goal",
  "Non-goals",
  "Current structure",
  "Proposed direction",
  "Architecture",
  "Quantitative implications",
  "Risks",
  "Open questions",
] as const;

export interface PlanCatalog {
  readonly roles: ReadonlySet<string>;
  readonly checks: ReadonlySet<string>;
  readonly protectedPatterns: readonly string[];
  readonly restrictedPatterns: readonly string[];
}

export interface LoadedPlan {
  readonly id: string;
  readonly revision: number;
  readonly directory: string;
  readonly markdown: string;
  readonly tasks: readonly PlanTask[];
  readonly digest: Digest;
}

export interface ValidatedPlanDraft {
  readonly id: string;
  readonly revision: number;
  readonly markdown: string;
  readonly tasksYaml: string;
  readonly tasks: readonly PlanTask[];
  readonly digest: Digest;
}

function validateMarkdown(markdown: string, filePath: string): void {
  let previous = -1;
  for (const section of requiredSections) {
    const expression = new RegExp(`^#{1,6}\\s+${section}\\s*$`, "m");
    const match = expression.exec(markdown);
    if (!match) {
      throw new OrchestratorError(
        "invalid_plan",
        `${filePath} is missing the '${section}' section`,
      );
    }
    if (match.index <= previous) {
      throw new OrchestratorError(
        "invalid_plan",
        `${filePath} has required sections out of order`,
      );
    }
    previous = match.index;
  }
}

function validateGraph(tasks: readonly PlanTask[]): void {
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new OrchestratorError(
        "duplicate_task",
        `Task identifier '${task.id}' is duplicated`,
      );
    }
    taskIds.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.depends) {
      if (!taskIds.has(dependency)) {
        throw new OrchestratorError(
          "unknown_dependency",
          `Task '${task.id}' depends on unknown Task '${dependency}'`,
        );
      }
      if (dependency === task.id) {
        throw new OrchestratorError(
          "dependency_cycle",
          `Task '${task.id}' depends on itself`,
        );
      }
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, trail: readonly string[]): void => {
    if (visiting.has(id)) {
      throw new OrchestratorError(
        "dependency_cycle",
        `Task dependency cycle: ${[...trail, id].join(" -> ")}`,
      );
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const task = byId.get(id)!;
    for (const dependency of task.depends) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task.id, []);
}

function validateCatalog(
  tasks: readonly PlanTask[],
  catalog: PlanCatalog,
): void {
  for (const task of tasks) {
    if (!catalog.roles.has(task.role)) {
      throw new OrchestratorError(
        "unknown_role",
        `Task '${task.id}' references unknown Role '${task.role}'`,
      );
    }
    for (const check of task.checks) {
      if (!catalog.checks.has(check)) {
        throw new OrchestratorError(
          "unknown_check",
          `Task '${task.id}' references unknown Check '${check}'`,
        );
      }
    }
    validateTaskWritePaths({
      task,
      protectedPatterns: catalog.protectedPatterns,
      restrictedPatterns: catalog.restrictedPatterns,
    });
  }
}

function parseTasks(source: string, filePath: string): TasksFile {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new OrchestratorError("invalid_yaml", `Cannot parse ${filePath}`, {
      cause: error,
    });
  }
  const result = TasksFileSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "tasks"}: ${issue.message}`)
      .join("\n");
    throw new OrchestratorError(
      "invalid_plan",
      `Invalid ${filePath}:\n${detail}`,
    );
  }
  return result.data;
}

export async function loadPlan(
  directory: string,
  catalog: PlanCatalog,
): Promise<LoadedPlan> {
  const markdownPath = path.join(directory, "plan.md");
  const tasksPath = path.join(directory, "tasks.yaml");
  const [markdownBytes, tasksBytes] = await Promise.all([
    readFile(markdownPath),
    readFile(tasksPath),
  ]);
  const markdown = markdownBytes.toString("utf8");
  const tasksSource = tasksBytes.toString("utf8");
  const draft = validatePlanDraft(
    {
      id: path.basename(path.resolve(directory)),
      markdown,
      tasksYaml: tasksSource,
      markdownPath,
      tasksPath,
    },
    catalog,
  );

  return {
    id: draft.id,
    revision: draft.revision,
    directory: path.resolve(directory),
    markdown: draft.markdown,
    tasks: draft.tasks,
    digest: draft.digest,
  };
}

export function validatePlanDraft(
  input: {
    readonly id: string;
    readonly markdown: string;
    readonly tasksYaml: string;
    readonly markdownPath?: string;
    readonly tasksPath?: string;
  },
  catalog: PlanCatalog,
): ValidatedPlanDraft {
  const id = IdentifierSchema.parse(input.id);
  const markdownPath = input.markdownPath ?? `${id}/plan.md`;
  const tasksPath = input.tasksPath ?? `${id}/tasks.yaml`;
  const tasksFile = parseTasks(input.tasksYaml, tasksPath);

  validateMarkdown(input.markdown, markdownPath);
  validateGraph(tasksFile.tasks);
  validateCatalog(tasksFile.tasks, catalog);
  if (tasksFile.plan.id !== id) {
    throw new OrchestratorError(
      "invalid_plan",
      `Plan directory '${id}' does not match Plan ID '${tasksFile.plan.id}'`,
    );
  }

  return {
    id,
    revision: tasksFile.plan.revision,
    markdown: input.markdown,
    tasksYaml: input.tasksYaml,
    tasks: tasksFile.tasks,
    digest: digestPlan(
      Buffer.from(input.markdown, "utf8"),
      Buffer.from(input.tasksYaml, "utf8"),
    ),
  };
}

export function catalogFromConfig(config: ProjectConfig): PlanCatalog {
  return {
    roles: new Set(config.roles),
    checks: new Set(Object.keys(config.checks)),
    protectedPatterns: config.protected,
    restrictedPatterns: config.restricted_paths,
  };
}
