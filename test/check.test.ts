import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckSourceManifestSchema,
  CheckStore,
  CheckIntentSchema,
  createCheckSource,
  runCheck,
  runRequiredChecks,
  verifyCheckImage,
  verifyCheckSource,
  type CheckImage,
  type CheckOpenShell,
} from "../src/check.js";
import { canonicalJson, digestParts, sha256 } from "../src/digest.js";
import { OrchestratorError } from "../src/error.js";
import type {
  CreateSandboxOptions,
  DeleteSandboxOptions,
  OpenShellInferenceRoute,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
  SandboxExecOptions,
} from "../src/openshell.js";
import { fixtureTask } from "./fixture.js";
import {
  createAppliedFixture,
  type AppliedFixture,
} from "./applied-fixture.js";
import {
  candidateLocal,
  createCandidateFixture,
  type CandidateFixture,
} from "./candidate-fixture.js";

const execFileAsync = promisify(execFile);
const fixtures: AppliedFixture[] = [];
const temporaryRoots: string[] = [];
const fixedToken = "a".repeat(64);
const replacementToken = "b".repeat(64);
const checkImageDigest = sha256("fixture Check image");
const checkImage: CheckImage = {
  source: `fixture-check-image@${checkImageDigest}`,
  digest: checkImageDigest,
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sandbox(
  name: string,
  labels: Readonly<Record<string, string>> = {},
): OpenShellSandbox {
  return {
    annotations: {},
    created_at: "2026-08-18 16:00:00",
    current_policy_version: 1,
    id: "44f7fc5f-31f4-49e7-823d-1a1d81ad4463",
    labels: { ...labels },
    name,
    phase: "Ready",
    resource_version: 1,
    workspace: "checks",
  };
}

class FakeCheckOpenShell implements CheckOpenShell {
  readonly createCalls: CreateSandboxOptions[] = [];
  readonly deleteCalls: string[] = [];
  readonly execCalls: Array<{
    readonly command: readonly string[];
    readonly options?: SandboxExecOptions;
  }> = [];
  readonly uploads = new Map<string, Buffer>();
  preflightCalls = 0;
  gateway = "checks";
  inferenceConfigured = false;
  markerValid = true;
  failCreateAfterProvision = false;
  retainAfterDelete = false;
  result: ProcessResult = {
    stdout: "deterministic Check passed\n",
    stderr: "",
    exitCode: 0,
  };
  onCheck: (() => void | Promise<void>) | undefined;
  private active: OpenShellSandbox | undefined;
  private marker: { readonly job: string; readonly token: string } | undefined;

  seedSandbox(value: OpenShellSandbox): void {
    this.active = value;
  }

  async preflight(): Promise<OpenShellPreflight> {
    this.preflightCalls += 1;
    return {
      command: "openshell",
      requiredVersion: "0.0.106",
      installedVersion: "0.0.106",
      versionMatches: true,
      status: {
        authentication: { provider: "fixture", status: "authenticated" },
        gateway: this.gateway,
        server: "https://openshell.example.test",
        status: "connected",
        version: "0.0.106",
      },
    };
  }

  async getInferenceRoute(): Promise<OpenShellInferenceRoute> {
    if (this.inferenceConfigured) {
      return { provider: "fixture", model: "must-not-run" };
    }
    throw new OrchestratorError(
      "openshell_inference_unconfigured",
      "No inference route is configured",
    );
  }

  async listSandboxes(): Promise<OpenShellSandbox[]> {
    return this.active ? [this.active] : [];
  }

  async createSandbox(
    options: CreateSandboxOptions,
  ): Promise<OpenShellSandbox> {
    this.createCalls.push(options);
    const [, action, job, token] = options.command ?? [];
    if (action === "init" && job && token) this.marker = { job, token };
    this.active = sandbox(options.name, options.labels);
    if (this.failCreateAfterProvision) {
      throw new OrchestratorError(
        "openshell_failed",
        "Provisioning failed after the Sandbox record was created",
      );
    }
    return this.active;
  }

  async waitForSandbox(name: string): Promise<OpenShellSandbox> {
    if (!this.active || this.active.name !== name) {
      throw new Error(`Sandbox '${name}' is not active`);
    }
    return this.active;
  }

  async deleteSandbox(
    name: string,
    _options?: DeleteSandboxOptions,
  ): Promise<void> {
    this.deleteCalls.push(name);
    if (!this.retainAfterDelete && this.active?.name === name) {
      this.active = undefined;
    }
  }

  async upload(
    _name: string,
    localPath: string,
    sandboxPath: string,
  ): Promise<void> {
    this.uploads.set(sandboxPath, await readFile(localPath));
  }

  async execSandbox(
    _name: string,
    command: readonly string[],
    options?: SandboxExecOptions,
  ): Promise<ProcessResult> {
    this.execCalls.push({
      command: [...command],
      ...(options ? { options } : {}),
    });
    if (command[0] === "/usr/local/bin/orchestrator-prepare-check") {
      const [, action, job, token] = command;
      const valid =
        this.markerValid &&
        this.marker?.job === job &&
        this.marker?.token === token;
      if (!valid) {
        return { stdout: "", stderr: "identity mismatch\n", exitCode: 1 };
      }
      if (action === "verify") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (action === "source") {
        const bytes = this.uploads.get("/sandbox/input/source.json");
        if (!bytes) {
          return { stdout: "", stderr: "source missing\n", exitCode: 1 };
        }
        const manifest = CheckSourceManifestSchema.parse(
          JSON.parse(bytes.toString("utf8")) as unknown,
        );
        return {
          stdout: `${manifest.source_digest}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
    }
    if (
      command[0] === "/usr/bin/cat" &&
      command[1] === "/proc/self/mountinfo"
    ) {
      const mountSet = this.createCalls.at(-1)?.mountSet;
      if (!mountSet) {
        return { stdout: "", stderr: "mount set missing\n", exitCode: 1 };
      }
      return {
        stdout: `${mountSet.mounts
          .map((mount, index) => {
            const mode = mount.readOnly ? "ro" : "rw";
            return `${index + 10} 1 0:1 /${mount.subpath} ${mount.target} ${mode},relatime - ext4 ${mount.source} ${mode}`;
          })
          .join("\n")}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    await this.onCheck?.();
    return this.result;
  }
}

async function applied(
  options: Parameters<typeof createAppliedFixture>[0] = {},
): Promise<AppliedFixture> {
  const fixture = await createAppliedFixture(options);
  fixtures.push(fixture);
  return fixture;
}

async function candidate(
  options: Parameters<typeof createCandidateFixture>[0] = {},
): Promise<CandidateFixture> {
  const fixture = await createCandidateFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function execute(
  fixture: CandidateFixture,
  client: CheckOpenShell,
  options: {
    readonly checkId?: string;
    readonly token?: string;
  } = {},
) {
  return runCheck({
    store: fixture.store,
    project: fixture.project,
    plan: fixture.plan,
    runId: fixture.runId,
    taskId: fixture.task.id,
    checkId: options.checkId ?? "project-test",
    client,
    workspaceClient: client,
    local: fixture.local,
    workspaceFactory: fixture.workspaceFactory,
    image: checkImage,
    token: () => options.token ?? fixedToken,
    now: () => new Date("2026-08-20T16:00:00.000Z"),
  });
}

function resultDirectory(
  fixture: AppliedFixture,
  check: string,
  job: string,
): string {
  return path.join(
    fixture.store.runDirectory(fixture.runId),
    "checks",
    fixture.task.id,
    check,
    job,
    "result",
  );
}

describe("authoritative Checks", { timeout: 15_000 }, () => {
  it("runs a registered argv in a fresh no-inference Sandbox and reuses exact evidence", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    const first = await execute(fixture, client);

    expect(first).toMatchObject({
      reused: false,
      record: {
        version: 2,
        verdict: "pass",
        argv: ["node", "--test"],
        cwd: ".",
        exit_code: 0,
        plan_digest: fixture.plan.digest,
        image: checkImage,
        cleanup: { sandbox_deleted: true },
        candidate: {
          id: fixture.candidate.id,
          digest: fixture.candidate.digest,
        },
        openshell: {
          cli_version: "0.0.106",
          gateway: "checks",
          gateway_version: "0.0.106",
        },
      },
      task: { status: "reviewing" },
    });
    expect(first.task.gates["check-project-test"]).toEqual({
      status: "pass",
      digest: first.record.record_digest,
      updated_at: "2026-08-20T16:00:00.000Z",
    });
    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]).toMatchObject({
      name: first.intent.sandbox,
      from: checkImage.source,
      labels: {
        "pio-check-job": first.intent.id,
        "pio-check-token": sha256(fixedToken).slice(7, 39),
        "pio.run": fixture.runId,
        "pio.access": "read",
        "pio.candidate": fixture.candidate.digest.slice(7, 63),
        "pio.volume": fixture.workspace.volume.digest.slice(7, 63),
      },
    });
    expect(client.createCalls[0]!.command).toEqual([
      "/usr/local/bin/orchestrator-prepare-check",
      "init",
      first.intent.id,
      fixedToken,
    ]);
    expect(client.deleteCalls).toEqual([first.intent.sandbox]);
    expect(client.execCalls.find((call) => call.command[0] === "node")).toEqual(
      {
        command: ["node", "--test"],
        options: {
          timeoutMs: 30 * 60_000,
          workdir: "/workspace/project",
          env: first.intent.scratch!.environment,
        },
      },
    );
    expect(first.intent).toMatchObject({
      version: 2,
      candidate: {
        id: fixture.candidate.id,
        digest: fixture.candidate.digest,
      },
      workspace: {
        generation: fixture.candidate.workspace_generation,
        manifest_digest: fixture.candidate.manifest_digest,
        git_diff_digest: fixture.candidate.git_diff_digest,
        volume_name: fixture.workspace.volume.name,
        volume_digest: fixture.workspace.volume.digest,
      },
      scratch: {
        root: "/sandbox/check-scratch",
        environment: {
          CARGO_TARGET_DIR: "/sandbox/check-scratch/build/cargo",
          HOME: "/sandbox/check-scratch/home",
          TMPDIR: "/sandbox/check-scratch/tmp",
        },
      },
    });
    expect(client.createCalls[0]!.mountSet?.mounts[0]).toMatchObject({
      source: fixture.workspace.volume.name,
      target: "/workspace/project",
      subpath: "project",
      readOnly: true,
      purpose: "workspace",
    });
    expect(client.uploads.size).toBe(0);

    const directory = resultDirectory(
      fixture,
      first.intent.check,
      first.intent.id,
    );
    expect(await readFile(path.join(directory, "stdout.log"), "utf8")).toBe(
      "deterministic Check passed\n",
    );
    expect((await stat(path.join(directory, "record.json"))).mode & 0o777).toBe(
      0o400,
    );

    await fixture.store.updateRun(fixture.runId, (run) => ({
      ...run,
      tasks: {
        ...run.tasks,
        [fixture.task.id]: {
          ...run.tasks[fixture.task.id]!,
          status: "checking",
          gates: {
            ...run.tasks[fixture.task.id]!.gates,
            "check-project-test": {
              status: "pending",
              digest: first.intent.binding_digest,
              updated_at: "2026-08-20T16:00:00.000Z",
            },
          },
        },
      },
    }));
    const reused = await execute(fixture, client, {
      token: replacementToken,
    });
    expect(reused.reused).toBe(true);
    expect(reused.record).toEqual(first.record);
    expect(reused.intent.token).toBe(fixedToken);
    expect(client.createCalls).toHaveLength(1);
    expect(client.preflightCalls).toBe(1);
  });

  it("keeps the Task checking until every required Check passes", async () => {
    const task = fixtureTask({
      checks: ["project-build", "project-test"],
    });
    const fixture = await candidate({
      task,
      checks: {
        "project-build": { argv: ["node", "--version"] },
        "project-test": { argv: ["node", "--test"], cwd: "src" },
      },
    });
    const client = new FakeCheckOpenShell();

    const build = await execute(fixture, client, { checkId: "project-build" });
    expect(build.task.status).toBe("checking");
    expect(build.task.gates["check-project-build"]?.status).toBe("pass");

    const test = await execute(fixture, client, { checkId: "project-test" });
    expect(test.task.status).toBe("reviewing");
    expect(test.task.gates["check-project-test"]?.status).toBe("pass");
    expect(
      client.execCalls.find(
        (call) =>
          canonicalJson(call.command) === canonicalJson(["node", "--test"]),
      )?.options?.workdir,
    ).toBe("/workspace/project/src");
    expect(client.createCalls).toHaveLength(2);
    expect(new Set(client.createCalls.map((call) => call.name)).size).toBe(2);
  });

  it("records failed commands as immutable evidence and sends the Task to rework", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.result = {
      stdout: "",
      stderr: "assertion failed\n",
      exitCode: 2,
    };

    const result = await execute(fixture, client);
    expect(result).toMatchObject({
      reused: false,
      record: { verdict: "fail", exit_code: 2 },
      task: { status: "rework" },
    });
    expect(result.task.gates["check-project-test"]?.status).toBe("fail");
    expect(
      await readFile(
        path.join(
          resultDirectory(fixture, result.intent.check, result.intent.id),
          "stderr.log",
        ),
        "utf8",
      ),
    ).toBe("assertion failed\n");
  });

  it("fails a source-mutating Check while keeping the Candidate unchanged", async () => {
    const task = fixtureTask({ checks: ["source-mutation"] });
    const fixture = await candidate({
      task,
      checks: {
        "source-mutation": {
          argv: ["touch", "src/forbidden.ts"],
        },
      },
    });
    const client = new FakeCheckOpenShell();
    client.result = {
      stdout: "",
      stderr: "touch: Read-only file system\n",
      exitCode: 1,
    };

    const result = await execute(fixture, client, {
      checkId: "source-mutation",
    });

    expect(result.record).toMatchObject({ verdict: "fail", exit_code: 1 });
    expect(client.createCalls[0]!.mountSet?.mounts).toEqual([
      expect.objectContaining({
        target: "/workspace/project",
        readOnly: true,
      }),
    ]);
    await expect(
      stat(path.join(fixture.volumeRoot, "project", "src", "forbidden.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const run = await fixture.store.readRun(fixture.runId);
    expect(run.workspace?.candidate).toMatchObject({
      digest: fixture.candidate.digest,
      status: "frozen",
    });
  });

  it("rejects a Check gateway with inference before creating a Sandbox", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.inferenceConfigured = true;

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_inference_enabled",
    });
    expect(client.createCalls).toHaveLength(0);
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]!
        .gates["check-project-test"],
    ).toBeUndefined();
  });

  it("rejects a Check Sandbox launched through another gateway", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.gateway = "code";

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_gateway_mismatch",
    });
    expect(client.createCalls).toHaveLength(0);
  });

  it("blocks before reading a Candidate while an unleased writer exists", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.seedSandbox(
      sandbox("pio-write-live", {
        "pio.run": fixture.runId,
        "pio.access": "write",
      }),
    );

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "writable_sandbox_without_lease",
    });
    expect(client.createCalls).toHaveLength(0);
    const run = await fixture.store.readRun(fixture.runId);
    expect(run.status).toBe("blocked");
    expect(run.workspace?.candidate?.status).toBe("stale");
  });

  it("deletes a newly created Sandbox when startup verification fails", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.markerValid = false;

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_execution_failed",
    });
    expect(client.createCalls).toHaveLength(1);
    expect(client.deleteCalls).toHaveLength(1);
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]!
        .gates["check-project-test"]?.status,
    ).toBe("pending");
  });

  it("deletes an owned Sandbox record when provisioning fails", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.failCreateAfterProvision = true;

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_execution_failed",
    });
    expect(client.createCalls).toHaveLength(1);
    expect(client.deleteCalls).toHaveLength(1);
    expect(await client.listSandboxes()).toEqual([]);
  });

  it("publishes no evidence unless Sandbox deletion is observable", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.retainAfterDelete = true;

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_execution_failed",
    });
    expect(await client.listSandboxes()).toHaveLength(1);
    const checkRoot = path.join(
      fixture.store.runDirectory(fixture.runId),
      "checks",
      fixture.task.id,
      "project-test",
    );
    const [job] = await readdir(checkRoot);
    await expect(
      readFile(path.join(checkRoot, job!, "result", "record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete a same-named Sandbox with foreign ownership", async () => {
    const fixture = await candidate();
    const preparation = new FakeCheckOpenShell();
    preparation.inferenceConfigured = true;
    await expect(execute(fixture, preparation)).rejects.toMatchObject({
      code: "check_inference_enabled",
    });
    const checkRoot = path.join(
      fixture.store.runDirectory(fixture.runId),
      "checks",
      fixture.task.id,
      "project-test",
    );
    const [job] = await readdir(checkRoot);
    const intent = CheckIntentSchema.parse(
      JSON.parse(
        await readFile(path.join(checkRoot, job!, "intent.json"), "utf8"),
      ) as unknown,
    );
    const client = new FakeCheckOpenShell();
    client.seedSandbox(
      sandbox(intent.sandbox, {
        "pio-check-job": intent.id,
        "pio-check-token": "foreign",
      }),
    );

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_execution_failed",
    });
    expect(client.createCalls).toHaveLength(0);
    expect(client.deleteCalls).toHaveLength(0);
    expect(await client.listSandboxes()).toHaveLength(1);
  });

  it("invalidates Candidate evidence when the Workspace changes during execution", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    client.onCheck = () =>
      writeFile(
        path.join(fixture.volumeRoot, "project", "src", "unexpected.ts"),
        "drift\n",
      );

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "workspace_changed_without_lease",
    });
    expect(client.deleteCalls).toHaveLength(1);
    const checkRoot = path.join(
      fixture.store.runDirectory(fixture.runId),
      "checks",
      fixture.task.id,
      "project-test",
    );
    const [job] = await readdir(checkRoot);
    expect(job).toMatch(/^check-[a-f0-9]{16}$/);
    await expect(
      readFile(path.join(checkRoot, job!, "result", "record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        path.join(fixture.volumeRoot, "project", "src", "unexpected.ts"),
        "utf8",
      ),
    ).toBe("drift\n");
    const run = await fixture.store.readRun(fixture.runId);
    expect(run.status).toBe("blocked");
    expect(run.workspace?.candidate?.status).toBe("stale");
    expect(
      run.tasks[fixture.task.id]!.gates["check-project-test"]?.status,
    ).toBe("stale");
  });

  it("stales prior Check evidence when the frozen Candidate later changes", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    const first = await execute(fixture, client);
    expect(first.record.verdict).toBe("pass");

    await writeFile(
      path.join(fixture.volumeRoot, "project", "src", "fixture.ts"),
      "export const fixture = 'changed-after-check';\n",
    );
    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "workspace_changed_without_lease",
    });

    const run = await fixture.store.readRun(fixture.runId);
    expect(run.workspace?.candidate?.status).toBe("stale");
    expect(
      run.tasks[fixture.task.id]!.gates["check-project-test"],
    ).toMatchObject({
      status: "stale",
      digest: first.record.record_digest,
    });
    expect(client.createCalls).toHaveLength(1);
  });

  it("rejects a Plan change made while the Check is running", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    const planPath = path.join(fixture.plan.directory, "plan.md");
    client.onCheck = async () => {
      const current = await readFile(planPath, "utf8");
      await writeFile(planPath, `${current}\nChanged during Check.\n`);
    };

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_stale",
    });
    expect(client.deleteCalls).toHaveLength(1);
    expect(
      (await fixture.store.readRun(fixture.runId)).tasks[fixture.task.id]!
        .gates["check-project-test"]?.status,
    ).toBe("pending");
  });

  it("rejects a self-consistent stored result rebound to another intent", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    const result = await execute(fixture, client);
    const recordPath = path.join(
      resultDirectory(fixture, result.intent.check, result.intent.id),
      "record.json",
    );
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    record.plan_digest = sha256("another Plan");
    const { record_digest: _recordDigest, ...digestInput } = record;
    record.record_digest = digestParts("pi-orchestrator/check-record/v2", [
      ["record", canonicalJson(digestInput)],
    ]);
    await chmod(recordPath, 0o600);
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await chmod(recordPath, 0o400);

    await expect(execute(fixture, client)).rejects.toMatchObject({
      code: "check_result_mismatch",
    });
    expect(client.preflightCalls).toBe(1);
    expect(client.createCalls).toHaveLength(1);
  });
});

describe("Check source packages", () => {
  it("rejects an unpinned Check image reference", async () => {
    await expect(
      verifyCheckImage({
        source: "node:latest",
        digest: sha256("untrusted label"),
      }),
    ).rejects.toMatchObject({ code: "check_image_unpinned" });
  });

  it("reconstructs the complete patched Project and detects archive tampering", async () => {
    const fixture = await applied();
    const task = (await fixture.store.readRun(fixture.runId)).tasks[
      fixture.task.id
    ]!;
    const source = await createCheckSource({
      projectRoot: fixture.project.root,
      inputCommit: task.input_commit!,
      taskSourceDigest: task.output_source_digest!,
      diffDigest: task.diff_digest!,
      patch: fixture.patch.value,
    });
    const extracted = await mkdtemp(path.join(os.tmpdir(), "pi-check-source-"));
    temporaryRoots.push(extracted);
    try {
      await execFileAsync("tar", ["-xf", source.archivePath, "-C", extracted]);
      expect(
        await readFile(path.join(extracted, "src", "fixture.ts"), "utf8"),
      ).toBe("export const fixture = 'checked';\n");
      await expect(stat(path.join(extracted, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await verifyCheckSource(source)).toEqual(source.manifest);

      await writeFile(source.archivePath, "tampered", { flag: "a" });
      await expect(verifyCheckSource(source)).rejects.toMatchObject({
        code: "invalid_check_source",
      });
    } finally {
      await source.dispose();
    }
  });

  it("fails closed when stored Check logs no longer match their record", async () => {
    const fixture = await candidate();
    const client = new FakeCheckOpenShell();
    const result = await execute(fixture, client);
    const directory = resultDirectory(
      fixture,
      result.intent.check,
      result.intent.id,
    );
    const stdout = path.join(directory, "stdout.log");
    await chmod(stdout, 0o600);
    await writeFile(stdout, "changed output\n");

    const store = new CheckStore(fixture.store.runDirectory(fixture.runId));
    await expect(
      store.getResult(fixture.task.id, result.intent.check, result.intent.id),
    ).rejects.toMatchObject({ code: "check_store_corrupt" });
  });
});

describe("required Check orchestration", () => {
  it("runs Checks in Plan order and stops after the first failure", async () => {
    const task = fixtureTask({ checks: ["first-check", "second-check"] });
    const fixture = await createAppliedFixture({
      task,
      checks: {
        "first-check": { argv: ["node", "--test"] },
        "second-check": { argv: ["node", "--check", "src/fixture.ts"] },
      },
    });
    fixtures.push(fixture);
    const executed: string[] = [];
    const result = await runRequiredChecks({
      store: fixture.store,
      project: fixture.project,
      plan: fixture.plan,
      runId: fixture.runId,
      taskId: task.id,
      client: new FakeCheckOpenShell(),
      local: candidateLocal,
      executeCheck: async (options) => {
        executed.push(options.checkId);
        return {
          intent: {} as Awaited<ReturnType<typeof runCheck>>["intent"],
          record: {
            check: options.checkId,
            verdict: options.checkId === "first-check" ? "fail" : "pass",
          } as Awaited<ReturnType<typeof runCheck>>["record"],
          reused: false,
          task: (await fixture.store.readRun(fixture.runId)).tasks[task.id]!,
        };
      },
    });

    expect(executed).toEqual(["first-check"]);
    expect(result).toMatchObject({
      verdict: "fail",
      required: ["first-check", "second-check"],
    });
  });
});
