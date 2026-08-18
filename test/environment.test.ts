import { describe, expect, it } from "vitest";
import {
  runtimeIdentity,
  sessionEnvironment,
} from "../sandbox/pi/client/environment.mjs";
import { sessionTools } from "../sandbox/pi/client/tools.mjs";

describe("Pi child environment", () => {
  it("passes only fixed runtime values and committed version identity", () => {
    const source = {
      ORCHESTRATOR_CLIENT_VERSION: "0.2.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
      AWS_ACCESS_KEY_ID: "host-secret",
      SSH_AUTH_SOCK: "/host/agent.sock",
    };
    const environment = sessionEnvironment(source);

    expect(environment).toEqual({
      HOME: "/home/sandbox",
      LANG: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      PI_CODING_AGENT_DIR: "/home/sandbox/.pi/agent",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TERM: "dumb",
      ORCHESTRATOR_CLIENT_VERSION: "0.2.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
    });
  });

  it("fails when the pinned runtime identity is invalid", () => {
    expect(() => sessionEnvironment({} as never)).toThrow(
      "Invalid pinned Pi runtime identity",
    );
  });

  it("admits only the validated OpenShell proxy and CA for inference", () => {
    const source = {
      ORCHESTRATOR_CLIENT_VERSION: "0.2.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
      HTTP_PROXY: "http://10.200.0.1:3128",
      HTTPS_PROXY: "http://10.200.0.1:3128",
      NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem",
      NODE_USE_ENV_PROXY: "1",
      OPENAI_API_KEY: "host-secret",
    };
    const environment = sessionEnvironment(source, true);

    expect(environment).toMatchObject({
      HTTP_PROXY: "http://10.200.0.1:3128",
      HTTPS_PROXY: "http://10.200.0.1:3128",
      NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(() =>
      sessionEnvironment(
        {
          ...source,
          HTTP_PROXY: "http://user:secret@example.test:3128",
          HTTPS_PROXY: "http://user:secret@example.test:3128",
        },
        true,
      ),
    ).toThrow("Invalid OpenShell inference proxy");
  });

  it("derives handshake identity only from the image environment", () => {
    expect(
      runtimeIdentity({ client_version: "0.2.0", pi_version: "0.84.2" }),
    ).toEqual({
      ORCHESTRATOR_CLIENT_VERSION: "0.2.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
    });
  });

  it("enables mutating Pi tools only for write-profile Sessions", () => {
    expect(sessionTools("read")).toBe("read,grep,find,ls");
    expect(sessionTools("write")).toBe("read,write,edit,bash,grep,find,ls");
    expect(() => sessionTools("check" as never)).toThrow(
      "Unsupported Session profile",
    );
  });
});
