import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { OrchestratorError } from "./error.js";

export const IdentifierSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must be a lowercase descriptive identifier",
  );

export const ModelAliasSchema = z.enum([
  "plan",
  "code",
  "quant",
  "review",
  "fast",
]);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ReviewLensSchema = z.enum([
  "spec",
  "architecture",
  "quality",
  "quant",
]);
export type ReviewLens = z.infer<typeof ReviewLensSchema>;

const ModelRouteSchema = z.union([
  ModelAliasSchema,
  z
    .object({
      default: ModelAliasSchema,
      quant: ModelAliasSchema.optional(),
    })
    .strict(),
]);

export const CheckDefinitionSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        id: IdentifierSchema,
      })
      .strict(),
    roles: z.array(IdentifierSchema).min(1),
    models: z.record(IdentifierSchema, ModelRouteSchema),
    context: z
      .object({
        initial_fraction: z.number().positive().max(1),
        warn_fraction: z.number().positive().max(1),
        handoff_fraction: z.number().positive().max(1),
        stop_fraction: z.number().positive().max(1),
      })
      .strict(),
    attempts: z
      .object({
        implementation: z.number().int().positive(),
        review: z.number().int().positive(),
        consultation_hops: z.number().int().nonnegative(),
      })
      .strict(),
    git: z
      .object({
        branch_prefix: z.string().min(1),
        commit: z.literal("human"),
        push: z.literal("disabled"),
        merge: z.literal("disabled"),
      })
      .strict(),
    network: z
      .object({
        default: z.literal("none"),
      })
      .strict(),
    protected: z.array(z.string().min(1)),
    checks: z.record(IdentifierSchema, CheckDefinitionSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const fractions = [
      config.context.initial_fraction,
      config.context.warn_fraction,
      config.context.handoff_fraction,
      config.context.stop_fraction,
    ];
    if (
      !fractions.every(
        (fraction, index) => index === 0 || fraction > fractions[index - 1]!,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["context"],
        message: "context fractions must increase from initial through stop",
      });
    }

    if (new Set(config.roles).size !== config.roles.length) {
      context.addIssue({
        code: "custom",
        path: ["roles"],
        message: "role names must be unique",
      });
    }

    for (const role of config.roles) {
      if (!(role in config.models)) {
        context.addIssue({
          code: "custom",
          path: ["models", role],
          message: `missing model route for role '${role}'`,
        });
      }
    }
  });

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

function issues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "configuration" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("\n");
}

export function parseProjectConfig(
  source: string,
  path = ".agents/orchestrator.yaml",
): ProjectConfig {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_yaml",
      `Cannot parse ${path}: ${String(error)}`,
      { cause: error },
    );
  }

  const result = ProjectConfigSchema.safeParse(value);
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_config",
      `Invalid ${path}:\n${issues(result.error)}`,
    );
  }
  return result.data;
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  return parseProjectConfig(await readFile(path, "utf8"), path);
}

export function defaultModelForRole(
  config: ProjectConfig,
  role: string,
): ModelAlias | undefined {
  const route = config.models[role];
  return typeof route === "string" ? route : route?.default;
}
