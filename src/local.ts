import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ModelProfileSchema } from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  DEFAULT_LOCAL_PERMISSION_POLICY,
  PermissionSetSchema,
} from "./permission.js";
import { PathPolicySchema } from "./scope.js";

export const VersionSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "must be a semantic version without a leading v",
  );

export const PinnedImageReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine(
    (value) => /@sha256:[a-f0-9]{64}$/.test(value),
    "must end with an exact sha256 image digest",
  );
export type PinnedImageReference = z.infer<typeof PinnedImageReferenceSchema>;

export const OpenShellImagesSchema = z
  .object({
    pi: PinnedImageReferenceSchema,
    check: PinnedImageReferenceSchema.optional(),
  })
  .strict();
export type OpenShellImages = z.infer<typeof OpenShellImagesSchema>;

export const SharedWorkspaceSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    gateway: z.string().min(1).optional(),
    driver: z.literal("docker").default("docker"),
    driver_version: VersionSchema.optional(),
    docker_command: z.string().min(1).default("docker"),
  })
  .strict()
  .superRefine((settings, context) => {
    if (!settings.enabled) return;
    for (const field of ["gateway", "driver_version"] as const) {
      if (settings[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "is required when shared workspaces are enabled",
        });
      }
    }
  });
export type SharedWorkspaceSettings = z.infer<
  typeof SharedWorkspaceSettingsSchema
>;

const OpenShellSettingsSchema = z
  .object({
    command: z.string().min(1).default("openshell"),
    required_version: VersionSchema.optional(),
    workspace: z.string().min(1).default("default"),
    gateways: z.record(z.string(), z.string().min(1)).default({}),
    images: OpenShellImagesSchema.optional(),
    shared_workspace: SharedWorkspaceSettingsSchema.optional(),
  })
  .passthrough()
  .superRefine((settings, context) => {
    if (settings.shared_workspace?.enabled && !settings.images?.pi) {
      context.addIssue({
        code: "custom",
        path: ["images", "pi"],
        message:
          "is required as an exact digest when shared workspaces are enabled",
      });
    }
  });

export const CmuxSettingsSchema = z
  .object({
    command: z.string().min(1).default("cmux"),
    required_version: VersionSchema.optional(),
    workspace_prefix: z.string().trim().min(1).max(80).default("orchestrator"),
  })
  .passthrough();
export type CmuxSettings = z.infer<typeof CmuxSettingsSchema>;

export const WorktreeSettingsSchema = z
  .object({
    root: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !value.includes("\0"), "must not contain NUL"),
  })
  .strict();
export type WorktreeSettings = z.infer<typeof WorktreeSettingsSchema>;

export const LocalWorkspaceSettingsSchema = z
  .object({
    volume_prefix: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-z0-9][a-z0-9.-]*$/,
        "must be a lowercase Docker volume-name prefix",
      )
      .default("pi-orchestrator"),
    restricted_paths: PathPolicySchema.default([]),
  })
  .strict();
export type LocalWorkspaceSettings = z.infer<
  typeof LocalWorkspaceSettingsSchema
>;

export const PiModelApiSchema = z.enum([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);
export type PiModelApi = z.infer<typeof PiModelApiSchema>;

export const ModelLocalitySchema = z.enum(["local", "remote"]);
export type ModelLocality = z.infer<typeof ModelLocalitySchema>;

export const ModelPricingSchema = z
  .object({
    currency: z.literal("USD").default("USD"),
    input_per_million: z.number().finite().nonnegative(),
    output_per_million: z.number().finite().nonnegative(),
    cache_read_per_million: z.number().finite().nonnegative().default(0),
    cache_write_per_million: z.number().finite().nonnegative().default(0),
  })
  .strict();
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const LocalModelRouteSchema = z
  .object({
    gateway: z.string().min(1),
    pi_model: z.string().min(1).max(256),
    api: PiModelApiSchema,
    locality: ModelLocalitySchema,
    context_window: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
    pricing: ModelPricingSchema.optional(),
  })
  .strict()
  .refine((route) => route.max_tokens <= route.context_window, {
    message: "max_tokens must not exceed context_window",
    path: ["max_tokens"],
  });
export type LocalModelRoute = z.infer<typeof LocalModelRouteSchema>;

const LocalModelRoutesSchema = z
  .record(z.string(), LocalModelRouteSchema)
  .default({})
  .superRefine((routes, context) => {
    for (const alias of Object.keys(routes)) {
      if (!ModelProfileSchema.safeParse(alias).success) {
        context.addIssue({
          code: "custom",
          path: [alias],
          message: "must be a descriptive Model Profile identifier",
        });
      }
    }
  });

export const LocalConfigSchema = z
  .object({
    version: z.literal(2),
    openshell: OpenShellSettingsSchema,
    models: LocalModelRoutesSchema,
    permissions: PermissionSetSchema.default(DEFAULT_LOCAL_PERMISSION_POLICY),
    cmux: CmuxSettingsSchema.default({
      command: "cmux",
      workspace_prefix: "orchestrator",
    }),
    worktrees: WorktreeSettingsSchema.default({
      root: "~/.local/share/pi-orchestrator/worktrees",
    }),
    workspace: LocalWorkspaceSettingsSchema.default({
      volume_prefix: "pi-orchestrator",
      restricted_paths: [],
    }),
  })
  .passthrough();
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function parseLocalConfig(
  source: string,
  filePath = ".pi/orchestrator.local.yaml",
): LocalConfig {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_yaml",
      `Cannot parse ${filePath}: ${String(error)}`,
      { cause: error },
    );
  }

  const result = LocalConfigSchema.safeParse(value);
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_local_config",
      `Invalid ${filePath}: ${result.error.message}`,
    );
  }
  return result.data;
}

export async function loadLocalConfig(filePath: string): Promise<LocalConfig> {
  return parseLocalConfig(await readFile(filePath, "utf8"), filePath);
}

export function resolveMachinePath(
  value: string,
  home = os.homedir(),
  cwd = process.cwd(),
): string {
  if (value.includes("\0")) {
    throw new OrchestratorError(
      "invalid_local_path",
      "Machine-local paths must not contain NUL",
    );
  }
  if (value === "~") return path.resolve(home);
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  if (value.startsWith("~")) {
    throw new OrchestratorError(
      "invalid_local_path",
      `Machine-local path '${value}' uses an unsupported home expansion`,
    );
  }
  return path.resolve(cwd, value);
}
