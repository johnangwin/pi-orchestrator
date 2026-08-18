import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";

export const SandboxProfileSchema = z.enum(["read", "write", "check"]);
export type SandboxProfile = z.infer<typeof SandboxProfileSchema>;

const SandboxPathSchema = z
  .string()
  .refine((value) => path.posix.isAbsolute(value), "must be absolute")
  .refine(
    (value) => !value.split("/").includes(".."),
    "must not contain parent traversal",
  )
  .refine((value) => value !== "/", "must not grant the filesystem root");

const ProcessIdentitySchema = z
  .string()
  .regex(/^(?:sandbox|[1-9]\d*)$/, "must be sandbox or a non-root numeric ID");

export const SandboxPolicySchema = z
  .object({
    version: z.literal(1),
    filesystem_policy: z
      .object({
        include_workdir: z.literal(false),
        read_only: z.array(SandboxPathSchema),
        read_write: z.array(SandboxPathSchema),
      })
      .strict(),
    landlock: z
      .object({
        compatibility: z.literal("hard_requirement"),
      })
      .strict(),
    process: z
      .object({
        run_as_user: ProcessIdentitySchema.optional(),
        run_as_group: ProcessIdentitySchema.optional(),
      })
      .strict()
      .optional(),
    network_policies: z.record(z.string(), z.unknown()),
    network_middlewares: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const readOnly = policy.filesystem_policy.read_only;
    const readWrite = policy.filesystem_policy.read_write;
    for (const [key, values] of [
      ["read_only", readOnly],
      ["read_write", readWrite],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["filesystem_policy", key],
          message: "paths must be unique",
        });
      }
    }
    for (const value of readOnly) {
      if (readWrite.includes(value)) {
        context.addIssue({
          code: "custom",
          path: ["filesystem_policy"],
          message: `'${value}' cannot be both read-only and read-write`,
        });
      }
    }
  });
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export interface LoadedSandboxPolicy {
  readonly profile: SandboxProfile;
  readonly path: string;
  readonly digest: Digest;
  readonly policy: SandboxPolicy;
}

const commonReadOnly = ["/workspace/base", "/workspace/input"];
const commonReadWrite = [
  "/sandbox",
  "/home/sandbox",
  "/tmp",
  "/dev/null",
  "/dev/pts",
];

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "policy" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("\n");
}

function requirePaths(
  actual: readonly string[],
  required: readonly string[],
  field: string,
): void {
  const missing = required.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new OrchestratorError(
      "invalid_sandbox_policy",
      `${field} is missing required paths: ${missing.join(", ")}`,
    );
  }
}

export function parseSandboxPolicy(
  profile: SandboxProfile,
  source: string,
  filePath: string,
): LoadedSandboxPolicy {
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

  const result = SandboxPolicySchema.safeParse(value);
  if (!result.success) {
    throw new OrchestratorError(
      "invalid_sandbox_policy",
      `Invalid ${filePath}:\n${formatIssues(result.error)}`,
    );
  }

  const policy = result.data;
  if (policy.process !== undefined) {
    throw new OrchestratorError(
      "invalid_sandbox_policy",
      `${filePath} must use the pinned image's non-root OCI USER; OpenShell 0.0.106 process overrides are not permitted`,
    );
  }
  if (Object.keys(policy.network_policies).length !== 0) {
    throw new OrchestratorError(
      "invalid_sandbox_policy",
      `${filePath} is a base profile and must default to no network access`,
    );
  }

  const readOnly = policy.filesystem_policy.read_only;
  const readWrite = policy.filesystem_policy.read_write;
  requirePaths(readOnly, commonReadOnly, `${filePath} read_only`);
  requirePaths(readWrite, commonReadWrite, `${filePath} read_write`);
  if (profile === "read") {
    requirePaths(readOnly, ["/workspace/project"], `${filePath} read_only`);
    if (readWrite.includes("/workspace/project")) {
      throw new OrchestratorError(
        "invalid_sandbox_policy",
        `${filePath} cannot make /workspace/project writable for the read profile`,
      );
    }
  } else {
    requirePaths(readWrite, ["/workspace/project"], `${filePath} read_write`);
  }

  return {
    profile,
    path: filePath,
    digest: sha256(source),
    policy,
  };
}

export async function loadSandboxPolicy(
  profile: SandboxProfile,
  filePath: string,
): Promise<LoadedSandboxPolicy> {
  return parseSandboxPolicy(
    profile,
    await readFile(filePath, "utf8"),
    filePath,
  );
}
