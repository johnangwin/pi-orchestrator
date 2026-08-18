import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  artifactSandboxPath,
  ArtifactStore,
  jsonArtifactContract,
  reportArtifactContract,
  type ArtifactContract,
  type ArtifactDescriptor,
  type ArtifactOpenShell,
} from "../src/artifact.js";
import { sha256 } from "../src/digest.js";
import type { OpenShellSandbox } from "../src/openshell.js";
import { createReport } from "../src/report.js";
import type { SessionIdentity } from "../src/session.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-artifact-"),
  );
  roots.push(root);
  return root;
}

const identity: SessionIdentity = {
  run: "run-one",
  seat: "implementer",
  session: "session-one",
  epoch: 3,
};

const sourceSandbox: OpenShellSandbox = {
  annotations: {},
  created_at: "2026-08-17 23:39:16",
  current_policy_version: 1,
  id: "43502221-db6b-49f2-a316-673792b3faae",
  labels: {},
  name: "pio-artifact-one",
  phase: "Ready",
  resource_version: 1,
  workspace: "default",
};

const contract = jsonArtifactContract({
  kind: "fixture",
  schema: "fixture/v1",
  maxBytes: 1024,
  valueSchema: z.object({ status: z.literal("ok") }).strict(),
});

function descriptor(
  payload: Uint8Array,
  overrides: Partial<ArtifactDescriptor> = {},
): ArtifactDescriptor {
  const id = overrides.id ?? "artifact-one";
  return {
    version: 1,
    id,
    kind: "fixture",
    run: identity.run,
    seat: identity.seat,
    session: identity.session,
    epoch: identity.epoch,
    task: "task-one",
    sandbox_path: artifactSandboxPath(id),
    media_type: "application/json",
    schema: "fixture/v1",
    byte_count: payload.byteLength,
    content_digest: sha256(payload),
    created_at: "2026-08-17T18:42:00Z",
    ...overrides,
  };
}

function copyingClient(
  payloadPath: string,
  getSandbox: () => Promise<OpenShellSandbox> = () =>
    Promise.resolve(sourceSandbox),
): {
  readonly client: ArtifactOpenShell;
  readonly download: ReturnType<typeof vi.fn>;
  readonly exec: ReturnType<typeof vi.fn>;
  readonly inspect: ReturnType<typeof vi.fn>;
} {
  const download = vi.fn(
    async (_sandbox: string, _source: string, destination: string) => {
      await copyFile(payloadPath, destination);
    },
  );
  const exec = vi.fn(async (_sandbox: string, command: readonly string[]) => {
    const bytes = await readFile(payloadPath);
    if (command[0] === "/usr/bin/stat") {
      return {
        stdout: `regular file\t${bytes.byteLength}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: `${sha256(bytes).slice("sha256:".length)}  ${command.at(-1)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
  const inspect = vi.fn(getSandbox);
  return {
    client: { download, execSandbox: exec, getSandbox: inspect },
    download,
    exec,
    inspect,
  };
}

async function payloadFixture(
  root: string,
  content = '{"status":"ok"}',
): Promise<{ readonly bytes: Buffer; readonly path: string }> {
  const bytes = Buffer.from(content, "utf8");
  const filePath = path.join(root, `payload-${Math.random()}`);
  await writeFile(filePath, bytes);
  return { bytes, path: filePath };
}

describe("Artifact import", () => {
  it("validates, atomically stores, and idempotently reads an Artifact", async () => {
    const root = await temporaryRoot();
    const payload = await payloadFixture(root);
    const transport = copyingClient(payload.path);
    const store = new ArtifactStore(
      path.join(root, "run"),
      () => new Date("2026-08-17T19:00:00Z"),
    );
    const metadata = descriptor(payload.bytes);

    const imported = await store.importFromSandbox({
      client: transport.client,
      descriptor: metadata,
      contract,
      identity,
      task: "task-one",
      sourceSandbox,
    });

    expect(imported.value).toEqual({ status: "ok" });
    expect(imported.record).toMatchObject({
      id: "artifact-one",
      content_digest: sha256(payload.bytes),
      source: {
        sandbox_id: sourceSandbox.id,
        sandbox_name: sourceSandbox.name,
        workspace: "default",
      },
      imported_at: "2026-08-17T19:00:00.000Z",
    });
    expect(transport.download).toHaveBeenCalledWith(
      sourceSandbox.name,
      artifactSandboxPath("artifact-one"),
      expect.stringContaining(".import-artifact-one-"),
    );
    expect(transport.inspect).toHaveBeenCalledTimes(2);
    expect((await stat(store.payloadPath("artifact-one"))).mode & 0o777).toBe(
      0o400,
    );
    expect((await stat(store.recordPath("artifact-one"))).mode & 0o777).toBe(
      0o400,
    );
    expect(await readFile(store.payloadPath("artifact-one"))).toEqual(
      payload.bytes,
    );
    await expect(store.get("artifact-one", contract)).resolves.toEqual(
      imported,
    );

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: metadata,
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).resolves.toEqual(imported);
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(transport.inspect).toHaveBeenCalledTimes(2);
  });

  it("rejects descriptor, contract, and workflow binding mismatches before download", async () => {
    const root = await temporaryRoot();
    const payload = await payloadFixture(root);
    const transport = copyingClient(payload.path);
    const store = new ArtifactStore(path.join(root, "run"));

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: {
          ...descriptor(payload.bytes),
          sandbox_path: "/sandbox/output/other",
        },
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "invalid_artifact_descriptor" });

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: { ...descriptor(payload.bytes), run: "run-other" },
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_binding_mismatch" });

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: descriptor(payload.bytes),
        contract: { ...contract, schema: "fixture/v2" },
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_contract_mismatch" });

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: descriptor(payload.bytes),
        contract,
        identity,
        task: "task-other",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_binding_mismatch" });
    expect(transport.download).not.toHaveBeenCalled();
  });

  it("checks Sandbox provenance before and after transfer", async () => {
    const root = await temporaryRoot();
    const payload = await payloadFixture(root);
    const replacement = {
      ...sourceSandbox,
      id: "d8ef8475-df07-448a-a48a-b416e54e61eb",
    };
    let inspections = 0;
    const transport = copyingClient(payload.path, () => {
      inspections += 1;
      return Promise.resolve(inspections === 1 ? sourceSandbox : replacement);
    });
    const store = new ArtifactStore(path.join(root, "run"));

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: descriptor(payload.bytes),
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_source_mismatch" });
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it("independently rejects content changed after remote inspection", async () => {
    const root = await temporaryRoot();
    const expected = await payloadFixture(root, '{"status":"ok"}');
    const changed = await payloadFixture(root, '{"status":"no"}');
    const inspected = copyingClient(expected.path);
    const client: ArtifactOpenShell = {
      execSandbox: inspected.client.execSandbox,
      getSandbox: inspected.client.getSandbox,
      async download(_sandbox, _source, destination) {
        await copyFile(changed.path, destination);
      },
    };
    const store = new ArtifactStore(path.join(root, "run"));

    await expect(
      store.importFromSandbox({
        client,
        descriptor: descriptor(expected.bytes),
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    expect(await readdir(store.directory)).toEqual([]);
  });

  it("rejects oversized, truncated, changed, and schema-invalid payloads", async () => {
    const root = await temporaryRoot();
    const valid = await payloadFixture(root);

    const cases: Array<{
      readonly id: string;
      readonly payload: Awaited<ReturnType<typeof payloadFixture>>;
      readonly metadata: ArtifactDescriptor;
      readonly expectedCode: string;
      readonly selectedContract?: ArtifactContract<unknown>;
    }> = [
      {
        id: "claimed-too-large",
        payload: valid,
        metadata: descriptor(valid.bytes, {
          id: "claimed-too-large",
          sandbox_path: artifactSandboxPath("claimed-too-large"),
          byte_count: 1025,
        }),
        expectedCode: "artifact_too_large",
      },
      {
        id: "wrong-size",
        payload: valid,
        metadata: descriptor(valid.bytes, {
          id: "wrong-size",
          sandbox_path: artifactSandboxPath("wrong-size"),
          byte_count: valid.bytes.byteLength - 1,
        }),
        expectedCode: "artifact_size_mismatch",
      },
      {
        id: "wrong-digest",
        payload: valid,
        metadata: descriptor(valid.bytes, {
          id: "wrong-digest",
          sandbox_path: artifactSandboxPath("wrong-digest"),
          content_digest: sha256("other"),
        }),
        expectedCode: "artifact_digest_mismatch",
      },
      {
        id: "invalid-schema",
        payload: await payloadFixture(root, '{"status":"wrong"}'),
        metadata: descriptor(Buffer.from('{"status":"wrong"}'), {
          id: "invalid-schema",
          sandbox_path: artifactSandboxPath("invalid-schema"),
        }),
        expectedCode: "invalid_artifact_schema",
      },
    ];

    for (const item of cases) {
      const transport = copyingClient(item.payload.path);
      const store = new ArtifactStore(path.join(root, `run-${item.id}`));
      await expect(
        store.importFromSandbox({
          client: transport.client,
          descriptor: item.metadata,
          contract: item.selectedContract ?? contract,
          identity,
          task: "task-one",
          sourceSandbox,
        }),
      ).rejects.toMatchObject({ code: item.expectedCode });
      if (item.expectedCode === "artifact_too_large") {
        expect(transport.download).not.toHaveBeenCalled();
      } else {
        expect(await readdir(store.directory)).toEqual([]);
      }
    }
  });

  it("rejects non-regular downloads and partial stored Artifacts", async () => {
    const root = await temporaryRoot();
    const payload = await payloadFixture(root);
    const download = vi.fn(
      async (_sandbox: string, _source: string, destination: string) => {
        await symlink(payload.path, destination);
      },
    );
    const store = new ArtifactStore(path.join(root, "run"));
    const client: ArtifactOpenShell = {
      download,
      execSandbox: copyingClient(payload.path).client.execSandbox,
      getSandbox: () => Promise.resolve(sourceSandbox),
    };

    await expect(
      store.importFromSandbox({
        client,
        descriptor: descriptor(payload.bytes),
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "invalid_artifact_payload" });
    expect(await readdir(store.directory)).toEqual([]);

    await mkdir(store.artifactDirectory("artifact-one"), { recursive: true });
    await expect(
      store.importFromSandbox({
        client,
        descriptor: descriptor(payload.bytes),
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "artifact_store_corrupt" });
  });

  it("validates Report content and identity inside a Report Artifact", async () => {
    const root = await temporaryRoot();
    const report = createReport({
      id: "report-one",
      kind: "consultation",
      run: identity.run,
      seat: identity.seat,
      session: identity.session,
      epoch: identity.epoch,
      task: "task-one",
      content: "# Conclusion\n\nThe boundary holds.",
      created_at: "2026-08-17T18:42:00Z",
    });
    const payload = await payloadFixture(root, JSON.stringify(report));
    const transport = copyingClient(payload.path);
    const store = new ArtifactStore(path.join(root, "run"));
    const metadata = {
      ...descriptor(payload.bytes, {
        id: "report-one",
        sandbox_path: artifactSandboxPath("report-one"),
      }),
      kind: "report",
      schema: "report/v1",
    };

    await expect(
      store.importFromSandbox({
        client: transport.client,
        descriptor: metadata,
        contract: reportArtifactContract(),
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).resolves.toMatchObject({ value: report });
  });

  it("rejects reuse of an Artifact ID with different content", async () => {
    const root = await temporaryRoot();
    const first = await payloadFixture(root);
    const second = await payloadFixture(root, '{"status":"ok","other":true}');
    const firstTransport = copyingClient(first.path);
    const store = new ArtifactStore(path.join(root, "run"));
    await store.importFromSandbox({
      client: firstTransport.client,
      descriptor: descriptor(first.bytes),
      contract,
      identity,
      task: "task-one",
      sourceSandbox,
    });

    await expect(
      store.importFromSandbox({
        client: copyingClient(second.path).client,
        descriptor: descriptor(second.bytes),
        contract,
        identity,
        task: "task-one",
        sourceSandbox,
      }),
    ).rejects.toMatchObject({ code: "duplicate_artifact" });
  });
});
