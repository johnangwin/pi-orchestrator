import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { OrchestratorError } from "./error.js";

export const VersionSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "must be a semantic version without a leading v",
  );

const OpenShellSettingsSchema = z
  .object({
    command: z.string().min(1).default("openshell"),
    required_version: VersionSchema.optional(),
    workspace: z.string().min(1).default("default"),
    gateways: z.record(z.string(), z.string().min(1)).default({}),
  })
  .passthrough();

export const LocalConfigSchema = z
  .object({
    version: z.literal(1),
    openshell: OpenShellSettingsSchema,
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
