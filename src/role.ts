import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { IdentifierSchema, type ProjectConfig } from "./config.js";
import { digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { PermissionSetSchema } from "./permission.js";

export const RoleSchema = z
  .object({
    version: z.literal(2),
    name: IdentifierSchema,
    description: z.string().min(1),
    skills: z.array(IdentifierSchema),
    lifetime: z.enum(["run", "design", "task", "review", "query"]),
    needs: z.array(IdentifierSchema),
    permissions: PermissionSetSchema,
  })
  .strict()
  .superRefine((role, context) => {
    if (role.permissions.write_lease === "task" && role.lifetime !== "task") {
      context.addIssue({
        code: "custom",
        path: ["permissions", "write_lease"],
        message: "Task Write Lease eligibility requires a Task-scoped Role",
      });
    }
  });

export type Role = z.infer<typeof RoleSchema>;

export interface LoadedRole {
  readonly definition: Role;
  readonly body: string;
  readonly path: string;
  readonly digest: Digest;
}

export function parseRole(source: string, filePath: string): LoadedRole {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) {
    throw new OrchestratorError(
      "invalid_role",
      `${filePath} must begin with YAML front matter`,
    );
  }

  let frontMatter: unknown;
  try {
    frontMatter = parse(match[1]!);
  } catch (error) {
    throw new OrchestratorError(
      "invalid_yaml",
      `Cannot parse Role front matter in ${filePath}`,
      {
        cause: error,
      },
    );
  }

  const result = RoleSchema.safeParse(frontMatter);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "role"}: ${issue.message}`)
      .join("\n");
    throw new OrchestratorError(
      "invalid_role",
      `Invalid Role ${filePath}:\n${detail}`,
    );
  }

  const body = match[2]!.trim();
  if (body.length === 0) {
    throw new OrchestratorError(
      "invalid_role",
      `${filePath} must contain Role instructions`,
    );
  }

  return {
    definition: result.data,
    body,
    path: filePath,
    digest: digestParts("pi-orchestrator/role/v2", [
      [path.basename(filePath), source],
    ]),
  };
}

export async function loadRole(filePath: string): Promise<LoadedRole> {
  return parseRole(await readFile(filePath, "utf8"), filePath);
}

export async function loadRoles(
  projectRoot: string,
  config: ProjectConfig,
): Promise<ReadonlyMap<string, LoadedRole>> {
  const roles = new Map<string, LoadedRole>();

  for (const name of config.roles) {
    const filePath = path.join(projectRoot, ".agents", "roles", `${name}.md`);
    const role = await loadRole(filePath);
    if (role.definition.name !== name) {
      throw new OrchestratorError(
        "invalid_role",
        `${filePath} declares Role '${role.definition.name}', expected '${name}'`,
      );
    }

    for (const skill of role.definition.skills) {
      const skillPath = path.join(
        projectRoot,
        ".agents",
        "skills",
        skill,
        "SKILL.md",
      );
      try {
        await readFile(skillPath, "utf8");
      } catch (error) {
        throw new OrchestratorError(
          "unknown_skill",
          `Role '${name}' references missing Skill '${skill}' at ${skillPath}`,
          { cause: error },
        );
      }
    }

    roles.set(name, role);
  }

  return roles;
}
