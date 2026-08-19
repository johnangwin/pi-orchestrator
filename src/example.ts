import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { OrchestratorError } from "./error.js";
import { initializeProject } from "./init.js";
import { loadLocalConfig } from "./local.js";

const execFileAsync = promisify(execFile);

export interface CreateExampleOptions {
  readonly directory: string;
  readonly localConfig?: string;
}

export interface CreateExampleResult {
  readonly root: string;
  readonly projectId: "price-calculator";
  readonly planId: "percentage-discount";
  readonly taskId: "add-discount";
  readonly commit: string;
  readonly localConfig: "provided" | "example";
}

function templateDirectory(): string {
  return fileURLToPath(
    new URL("../examples/price-calculator", import.meta.url),
  );
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.stdout.trim();
  } catch (error) {
    throw new OrchestratorError(
      "example_git_failed",
      `Cannot initialize the first-run example with git ${args.join(" ")}`,
      { cause: error },
    );
  }
}

async function registerCheck(root: string): Promise<void> {
  const configPath = path.join(root, ".agents", "orchestrator.yaml");
  const config = parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.checks = {
    test: {
      argv: ["node", "--test"],
    },
  };
  await writeFile(configPath, stringify(config), "utf8");
}

async function installLocalConfig(
  root: string,
  requested?: string,
): Promise<"provided" | "example"> {
  const destination = path.join(root, ".pi", "orchestrator.local.yaml");
  if (requested) {
    const source = path.resolve(requested);
    await loadLocalConfig(source);
    await copyFile(source, destination);
    return "provided";
  }
  await copyFile(
    path.join(root, ".pi", "orchestrator.local.yaml.example"),
    destination,
  );
  return "example";
}

export async function createExampleProject(
  options: CreateExampleOptions,
): Promise<CreateExampleResult> {
  const destination = path.resolve(options.directory);
  const existing = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    throw new OrchestratorError(
      "example_destination_exists",
      `Example destination '${destination}' already exists`,
    );
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(
    path.join(parent, `.${path.basename(destination)}.staging-`),
  );
  try {
    await cp(templateDirectory(), staging, { recursive: true });
    await writeFile(
      path.join(staging, ".gitignore"),
      ".pi/orchestrator.local.yaml\ncoverage/\n",
      "utf8",
    );
    await initializeProject(staging, "price-calculator");
    await registerCheck(staging);
    const localConfig = await installLocalConfig(staging, options.localConfig);
    await git(staging, ["init", "-b", "main"]);
    await git(staging, ["add", "."]);
    await git(staging, [
      "-c",
      "user.name=Pi Orchestrator Example",
      "-c",
      "user.email=example@pi-orchestrator.local",
      "commit",
      "-m",
      "Create the price calculator example.",
    ]);
    const commit = await git(staging, ["rev-parse", "HEAD"]);
    try {
      await rename(staging, destination);
    } catch (error) {
      if (
        ["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw new OrchestratorError(
          "example_destination_exists",
          `Example destination '${destination}' already exists`,
          { cause: error },
        );
      }
      throw error;
    }
    return {
      root: destination,
      projectId: "price-calculator",
      planId: "percentage-discount",
      taskId: "add-discount",
      commit,
      localConfig,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
