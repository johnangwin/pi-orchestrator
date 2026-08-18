import { describe, expect, it } from "vitest";
import {
  runtimeIdentity,
  sessionEnvironment,
} from "../sandbox/pi/client/environment.mjs";

describe("Pi child environment", () => {
  it("passes only fixed runtime values and committed version identity", () => {
    const source = {
      ORCHESTRATOR_CLIENT_VERSION: "0.1.0",
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
      ORCHESTRATOR_CLIENT_VERSION: "0.1.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
    });
  });

  it("fails when the pinned runtime identity is invalid", () => {
    expect(() => sessionEnvironment({} as never)).toThrow(
      "Invalid pinned Pi runtime identity",
    );
  });

  it("derives handshake identity only from the image environment", () => {
    expect(
      runtimeIdentity({ client_version: "0.1.0", pi_version: "0.84.2" }),
    ).toEqual({
      ORCHESTRATOR_CLIENT_VERSION: "0.1.0",
      ORCHESTRATOR_PI_VERSION: "0.84.2",
    });
  });
});
