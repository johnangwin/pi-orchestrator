import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { OrchestratorError } from "./error.js";
import { PathPolicySchema } from "./scope.js";

export const IdentifierSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must be a lowercase descriptive identifier",
  );

export const ModelProfileSchema = IdentifierSchema;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ReviewLensSchema = z.enum([
  "spec",
  "architecture",
  "quality",
  "quant",
]);
export type ReviewLens = z.infer<typeof ReviewLensSchema>;

export const DEFAULT_CONTEXT_THRESHOLDS = {
  initial_fraction: 0.25,
  warn_fraction: 0.6,
  handoff_fraction: 0.75,
  stop_fraction: 0.85,
} as const;

export const ContextThresholdsSchema = z
  .object({
    initial_fraction: z.number().positive().max(1),
    warn_fraction: z.number().positive().max(1),
    handoff_fraction: z.number().positive().max(1),
    stop_fraction: z.number().positive().max(1),
  })
  .strict()
  .superRefine((thresholds, context) => {
    const fractions = [
      thresholds.initial_fraction,
      thresholds.warn_fraction,
      thresholds.handoff_fraction,
      thresholds.stop_fraction,
    ];
    if (
      !fractions.every(
        (fraction, index) => index === 0 || fraction > fractions[index - 1]!,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "context fractions must increase from initial through stop",
      });
    }
  });
export type ContextThresholds = z.infer<typeof ContextThresholdsSchema>;

export const RemoteInferencePolicySchema = z.enum(["allowed", "denied"]);
export type RemoteInferencePolicy = z.infer<typeof RemoteInferencePolicySchema>;

export const RoleRoutingPolicySchema = z
  .object({
    default: ModelProfileSchema,
    allowed: z.array(ModelProfileSchema).min(1).max(64),
    focuses: z.partialRecord(ReviewLensSchema, ModelProfileSchema).optional(),
    remote: RemoteInferencePolicySchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.allowed).size !== policy.allowed.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed"],
        message: "Model Profiles must be unique",
      });
    }
    if (!policy.allowed.includes(policy.default)) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "default Model Profile must be allowed",
      });
    }
    for (const [focus, profile] of Object.entries(policy.focuses ?? {})) {
      if (!policy.allowed.includes(profile)) {
        context.addIssue({
          code: "custom",
          path: ["focuses", focus],
          message: "Review Focus Model Profile must be allowed",
        });
      }
    }
  });
export type RoleRoutingPolicy = z.infer<typeof RoleRoutingPolicySchema>;

export const RoutingPolicySchema = z
  .object({
    roles: z.record(IdentifierSchema, RoleRoutingPolicySchema),
  })
  .strict();
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

const CheckArgumentSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes("\0"), "must not contain NUL");

const CheckWorkingDirectorySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine((value) => !value.includes("\\"), "must use POSIX separators")
  .refine((value) => !path.posix.isAbsolute(value), "must be relative")
  .refine(
    (value) => path.posix.normalize(value) === value,
    "must be normalized",
  )
  .refine(
    (value) => value !== ".." && !value.startsWith("../"),
    "must remain inside the Project",
  );

export const CheckDefinitionSchema = z
  .object({
    argv: z.array(CheckArgumentSchema).min(1).max(256),
    cwd: CheckWorkingDirectorySchema.optional(),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    version: z.literal(2),
    project: z
      .object({
        id: IdentifierSchema,
      })
      .strict(),
    roles: z.array(IdentifierSchema).min(1),
    routing: RoutingPolicySchema,
    context: ContextThresholdsSchema,
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
    protected: PathPolicySchema,
    restricted_paths: PathPolicySchema,
    checks: z.record(IdentifierSchema, CheckDefinitionSchema),
  })
  .strict()
  .superRefine((config, context) => {
    if (new Set(config.roles).size !== config.roles.length) {
      context.addIssue({
        code: "custom",
        path: ["roles"],
        message: "role names must be unique",
      });
    }

    for (const role of config.roles) {
      if (!(role in config.routing.roles)) {
        context.addIssue({
          code: "custom",
          path: ["routing", "roles", role],
          message: `missing routing policy for Role '${role}'`,
        });
      }
    }
    for (const role of Object.keys(config.routing.roles)) {
      if (!config.roles.includes(role)) {
        context.addIssue({
          code: "custom",
          path: ["routing", "roles", role],
          message: `routing policy references unknown Role '${role}'`,
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

export function defaultModelProfileForRole(
  config: ProjectConfig,
  role: string,
): ModelProfile | undefined {
  return config.routing.roles[role]?.default;
}
