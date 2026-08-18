import { readFile } from "node:fs/promises";

const versionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function runtimeIdentity(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !versionPattern.test(value.client_version) ||
    !versionPattern.test(value.pi_version)
  ) {
    throw new Error("Invalid pinned Pi runtime identity");
  }
  return {
    ORCHESTRATOR_CLIENT_VERSION: value.client_version,
    ORCHESTRATOR_PI_VERSION: value.pi_version,
  };
}

export async function readRuntimeIdentity(filePath) {
  return runtimeIdentity(JSON.parse(await readFile(filePath, "utf8")));
}

export function sessionEnvironment(identity) {
  const runtime = runtimeIdentity({
    client_version: identity.ORCHESTRATOR_CLIENT_VERSION,
    pi_version: identity.ORCHESTRATOR_PI_VERSION,
  });
  const environment = {
    HOME: "/home/sandbox",
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PI_CODING_AGENT_DIR: "/home/sandbox/.pi/agent",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    TERM: "dumb",
    ...runtime,
  };
  return environment;
}
