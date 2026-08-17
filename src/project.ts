import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "./config.js";
import { loadProjectConfig } from "./config.js";
import { digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { loadRoles, type LoadedRole } from "./role.js";

const execFileAsync = promisify(execFile);

export interface LoadedSkill {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly digest: Digest;
}

export interface Project {
  readonly root: string;
  readonly agents: string;
  readonly config: ProjectConfig;
  readonly roles: ReadonlyMap<string, LoadedRole>;
  readonly skills: ReadonlyMap<string, LoadedSkill>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverProject(start = process.cwd()): Promise<string> {
  let current = await realpath(start);
  while (true) {
    if (await exists(path.join(current, ".agents", "orchestrator.yaml")))
      return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new OrchestratorError(
        "project_not_found",
        `No .agents/orchestrator.yaml found from ${start} to the filesystem root`,
      );
    }
    current = parent;
  }
}

export async function loadProject(start = process.cwd()): Promise<Project> {
  const root = await discoverProject(start);
  const config = await loadProjectConfig(
    path.join(root, ".agents", "orchestrator.yaml"),
  );
  const roles = await loadRoles(root, config);
  const skillNames = new Set(
    [...roles.values()].flatMap((role) => role.definition.skills),
  );
  const skills = new Map<string, LoadedSkill>();

  for (const name of [...skillNames].sort()) {
    const skillPath = path.join(root, ".agents", "skills", name, "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    skills.set(name, {
      name,
      path: skillPath,
      content,
      digest: digestParts("pi-orchestrator/skill/v1", [[name, content]]),
    });
  }

  const agentsPath = path.join(root, "AGENTS.md");
  if (!(await exists(agentsPath))) {
    throw new OrchestratorError(
      "missing_agents",
      `Project is missing ${agentsPath}`,
    );
  }

  return {
    root,
    agents: await readFile(agentsPath, "utf8"),
    config,
    roles,
    skills,
  };
}

export async function gitOutput(
  root: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new OrchestratorError(
      "git_failed",
      `git ${args.join(" ")} failed in ${root}`,
      { cause: error },
    );
  }
}

export async function gitHead(root: string): Promise<string> {
  return gitOutput(root, ["rev-parse", "HEAD"]);
}

export function resolvePlanDirectory(
  projectRoot: string,
  value: string,
): string {
  return path.resolve(
    value.includes(path.sep)
      ? value
      : path.join(projectRoot, "docs", "plans", value),
  );
}
