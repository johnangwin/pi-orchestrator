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

function inferenceEnvironment(source) {
  const httpProxy = source.HTTP_PROXY;
  const httpsProxy = source.HTTPS_PROXY;
  const certificate = source.NODE_EXTRA_CA_CERTS;
  let parsed;
  try {
    parsed = new URL(httpProxy);
  } catch {
    throw new Error("Invalid OpenShell inference proxy");
  }
  if (
    httpProxy !== httpsProxy ||
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    parsed.port === "" ||
    source.NODE_USE_ENV_PROXY !== "1" ||
    certificate !== "/etc/openshell-tls/openshell-ca.pem"
  ) {
    throw new Error("Invalid OpenShell inference proxy");
  }
  return {
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: httpsProxy,
    NODE_EXTRA_CA_CERTS: certificate,
    NODE_USE_ENV_PROXY: "1",
  };
}

export function sessionEnvironment(identity, inference = false) {
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
    ...(inference ? inferenceEnvironment(identity) : {}),
  };
  return environment;
}
