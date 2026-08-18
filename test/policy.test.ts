import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSandboxPolicy,
  parseSandboxPolicy,
  type SandboxProfile,
} from "../src/policy.js";

describe("Sandbox policies", () => {
  it("pins the probe base image by digest", async () => {
    const dockerfile = await readFile(
      path.resolve("sandbox", "probe", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(
      /^FROM docker\.io\/library\/debian:bookworm-slim@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).not.toContain(":latest");
  });

  it("pins the Pi base image and runtime version", async () => {
    const dockerfile = await readFile(
      path.resolve("sandbox", "pi", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(
      /^FROM docker\.io\/library\/node:22\.19\.0-bookworm-slim@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toContain("ARG PI_VERSION=0.84.2");
    expect(dockerfile).toContain(
      'npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}"',
    );
    expect(dockerfile).not.toContain(":latest");
  });

  for (const profile of ["read", "write", "check"] as const) {
    it(`validates the committed ${profile} profile`, async () => {
      const loaded = await loadSandboxPolicy(
        profile,
        path.resolve("sandbox", "policies", `${profile}.yaml`),
      );
      expect(loaded).toMatchObject({ profile });
      expect(loaded.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
  }

  it("rejects network access in a base profile", async () => {
    const filePath = path.resolve("sandbox", "policies", "read.yaml");
    const source = await readFile(filePath, "utf8");
    expect(() =>
      parseSandboxPolicy(
        "read",
        source.replace(
          "network_policies: {}",
          `network_policies:\n  broad:\n    endpoints: []`,
        ),
        filePath,
      ),
    ).toThrow("must default to no network access");
  });

  it("rejects writable source for the read profile", async () => {
    const writePath = path.resolve("sandbox", "policies", "write.yaml");
    const source = await readFile(writePath, "utf8");
    expect(() => parseSandboxPolicy("read", source, writePath)).toThrow(
      "missing required paths",
    );
  });

  it("rejects process overrides for the pinned baseline", async () => {
    const filePath = path.resolve("sandbox", "policies", "read.yaml");
    const source = await readFile(filePath, "utf8");
    expect(() =>
      parseSandboxPolicy(
        "read",
        source.replace(
          "network_policies: {}",
          `process:\n  run_as_user: "10001"\n  run_as_group: "10001"\n\nnetwork_policies: {}`,
        ),
        filePath,
      ),
    ).toThrow("process overrides are not permitted");
  });

  it("keeps the profile type closed", () => {
    const profile: SandboxProfile = "check";
    expect(profile).toBe("check");
  });
});
