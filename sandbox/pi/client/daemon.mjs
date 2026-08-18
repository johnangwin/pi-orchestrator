import { spawn } from "node:child_process";
import { readRuntimeIdentity, sessionEnvironment } from "./environment.mjs";

const runtime = await readRuntimeIdentity(
  "/usr/local/lib/pi-orchestrator/runtime.json",
);

const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--extension",
    "/usr/local/lib/pi-orchestrator/client/index.mjs",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    "read,grep,find,ls",
    "--offline",
  ],
  {
    cwd: "/workspace/project",
    env: sessionEnvironment(runtime),
    stdio: ["pipe", "inherit", "inherit"],
  },
);

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("error", (error) => {
  process.stderr.write(`Cannot launch Pi: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
