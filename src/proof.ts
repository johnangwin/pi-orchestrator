import { randomBytes } from "node:crypto";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, digestParts, sha256, type Digest } from "./digest.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import type { SharedWorkspaceSettings } from "./local.js";
import { OpenShellMountSet } from "./mount.js";
import type {
  OpenShellClient,
  OpenShellGatewayInfo,
  OpenShellGatewayRegistration,
  OpenShellPreflight,
  OpenShellSandbox,
  ProcessResult,
} from "./openshell.js";
import { inspectWorkspaceEntries, workspaceTreeDigest } from "./patch.js";
import { loadSandboxPolicy, type LoadedSandboxPolicy } from "./policy.js";
import { defaultOrchestratorHome } from "./state.js";
import { DockerVolumeCapability, DockerVolumeClient } from "./volume.js";
import { bundledCanaryImage, bundledPolicyDirectory } from "./canary.js";

const PROJECT_TARGET = "/workspace/project";
const VOLUME_HELPER_IMAGE =
  "docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241";

const SEED_SCRIPT = `
set -eu
token=$1
umask 000
mkdir -p \
  /run-volume/project/task/protected \
  /run-volume/project/sibling \
  /run-volume/project/restricted-dir \
  /run-volume/git \
  /run-volume/control/masks/empty-directory
printf 'visible\\n' >/run-volume/project/visible.txt
printf 'protected\\n' >/run-volume/project/task/protected/protected.txt
printf '%s\\n' "$token" >/run-volume/project/restricted.txt
printf '%s\\n' "$token" >/run-volume/project/restricted-dir/secret.txt
printf '%s\\n' "$token" >/run-volume/git/secret
printf '%s\\n' "$token" >/run-volume/control/secret
printf 'pi-orchestrator opaque mount\\n' >/run-volume/control/masks/opaque-file
chmod 0777 \
  /run-volume/project \
  /run-volume/project/task \
  /run-volume/project/task/protected \
  /run-volume/project/sibling \
  /run-volume/project/restricted-dir
chmod 0666 \
  /run-volume/project/visible.txt \
  /run-volume/project/task/protected/protected.txt \
  /run-volume/project/restricted.txt \
  /run-volume/project/restricted-dir/secret.txt
chmod 0700 /run-volume/git /run-volume/control
`;

export type WorkspaceVolumeOpenShell = Pick<
  OpenShellClient,
  | "createSandbox"
  | "deleteSandbox"
  | "execSandbox"
  | "getGatewayInfo"
  | "listGateways"
  | "listSandboxes"
  | "preflight"
  | "waitForSandbox"
> & { readonly gateway: string | undefined };

export type WorkspaceVolumeDocker = Pick<
  DockerVolumeClient,
  "createVolume" | "inspectVolume" | "removeVolume" | "runVolume" | "version"
> & { readonly command: string };

export interface LinuxMountInfoEntry {
  readonly id: number;
  readonly parentId: number;
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: readonly string[];
  readonly optionalFields: readonly string[];
  readonly filesystem: string;
  readonly mountSource: string;
  readonly superOptions: readonly string[];
}

export interface MountTableEvidence {
  readonly rawDigest: Digest;
  readonly selectedDigest: Digest;
  readonly entries: readonly LinuxMountInfoEntry[];
}

export interface WorkspaceVolumeAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface WorkspaceVolumeCanaryResult {
  readonly version: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly openshell: {
    readonly cliVersion: string;
    readonly gateway: string;
    readonly gatewayVersion: string;
    readonly driver: "docker";
    readonly driverVersion: string;
  };
  readonly docker: {
    readonly command: string;
    readonly version: string;
    readonly helperImage: string;
  };
  readonly image: {
    readonly source: string;
    readonly contextDigest: Digest;
  };
  readonly policies: {
    readonly read: Digest;
    readonly write: Digest;
  };
  readonly volume: {
    readonly name: string;
    readonly digest?: Digest;
    readonly writerMountSetDigest?: Digest;
    readonly readerMountSetDigest?: Digest;
  };
  readonly sandboxes: {
    readonly writer: {
      readonly name: string;
      readonly id?: string;
      readonly mounts?: MountTableEvidence;
    };
    readonly reader: {
      readonly name: string;
      readonly id?: string;
      readonly mounts?: MountTableEvidence;
    };
  };
  readonly assertions: readonly WorkspaceVolumeAssertion[];
  readonly evidenceDigest: Digest;
  readonly passed: boolean;
}

export interface WorkspaceVolumeCanaryOptions {
  readonly client: WorkspaceVolumeOpenShell;
  readonly settings: SharedWorkspaceSettings;
  readonly docker?: WorkspaceVolumeDocker;
  readonly image?: string;
  readonly policyDirectory?: string;
  readonly projectRoot?: string;
  readonly stateRoot?: string;
  readonly hostHome?: string;
  readonly now?: () => Date;
  readonly nameSuffix?: () => string;
}

interface EnabledSharedWorkspaceSettings {
  readonly gateway: string;
  readonly driver: "docker";
  readonly driverVersion: string;
  readonly dockerCommand: string;
}

const writerAssertionDetails = new Map<string, string>([
  ["unprivileged-uid", "writer UID is 10001"],
  ["unprivileged-groups", "writer has no supplementary root group"],
  ["workspace-readable", "Workspace source is readable"],
  ["root-read-only", "Workspace root rejects writes"],
  ["sibling-read-only", "sibling path rejects writes"],
  ["protected-read-only", "protected descendant rejects writes"],
  ["write-create", "write root permits file creation"],
  ["write-replace", "write root permits file replacement"],
  ["write-rename", "write root permits file rename"],
  ["write-delete", "write root permits file deletion"],
  ["git-absent", "Git metadata is absent from the Project subtree"],
  ["git-create-denied", "the Agent cannot create Project-root Git metadata"],
  ["restricted-file-masked", "restricted file content is opaque"],
  ["restricted-directory-masked", "restricted directory content is absent"],
  ["volume-control-inaccessible", "volume control paths are not projected"],
  ["shared-write-created", "writer created the shared visibility marker"],
  ["openshell-token-inaccessible", "OpenShell token is unreadable"],
  ["openshell-key-inaccessible", "OpenShell client key is unreadable"],
  ["docker-socket-absent", "Docker socket is absent"],
  ["host-sentinel-inaccessible", "host-only sentinel is inaccessible"],
  ["host-home-inaccessible", "host home is inaccessible"],
  ["host-state-inaccessible", "host state is inaccessible"],
  ["host-checkout-inaccessible", "primary checkout is inaccessible"],
  [
    "sibling-repositories-inaccessible",
    "sibling repositories are inaccessible",
  ],
  ["volume-source-inaccessible", "Docker's backing path is inaccessible"],
  ["host-ssh-agent-inaccessible", "host SSH agent is inaccessible"],
  ["host-credentials-absent", "host credential environment is absent"],
  ["external-network-denied", "external network is denied"],
  ["host-gateway-denied", "host-local gateway access is denied"],
  ["privileged-mount-denied", "privileged mount namespace creation is denied"],
]);

const readerAssertionDetails = new Map<string, string>([
  ["shared-write-visible", "writer change is visible to the reader"],
  ["reader-root-read-only", "reader Workspace root rejects writes"],
  ["reader-task-read-only", "reader Task path rejects writes"],
]);

function enabledSettings(
  settings: SharedWorkspaceSettings,
): EnabledSharedWorkspaceSettings {
  if (!settings.enabled) {
    throw new OrchestratorError(
      "shared_workspace_disabled",
      "Shared Workspace volumes must be explicitly enabled",
    );
  }
  if (settings.gateway === undefined || settings.driver_version === undefined) {
    throw new OrchestratorError(
      "invalid_shared_workspace_config",
      "Enabled shared workspaces require a gateway and driver version",
    );
  }
  return {
    gateway: settings.gateway,
    driver: settings.driver,
    driverVersion: settings.driver_version,
    dockerCommand: settings.docker_command,
  };
}

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseLinuxMountInfo(source: string): LinuxMountInfoEntry[] {
  const entries: LinuxMountInfoEntry[] = [];
  for (const [index, line] of source.trimEnd().split("\n").entries()) {
    if (!line) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) {
      throw new OrchestratorError(
        "invalid_mount_table",
        `Mount table line ${index + 1} is malformed`,
      );
    }
    const id = Number(fields[0]);
    const parentId = Number(fields[1]);
    const device = fields[2];
    const root = fields[3];
    const mountPoint = fields[4];
    const mountOptions = fields[5];
    const filesystem = fields[separator + 1];
    const mountSource = fields[separator + 2];
    const superOptions = fields[separator + 3];
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(parentId) ||
      !device ||
      !root ||
      !mountPoint ||
      !mountOptions ||
      !filesystem ||
      !mountSource ||
      !superOptions
    ) {
      throw new OrchestratorError(
        "invalid_mount_table",
        `Mount table line ${index + 1} has invalid required fields`,
      );
    }
    entries.push({
      id,
      parentId,
      device,
      root: decodeMountField(root),
      mountPoint: decodeMountField(mountPoint),
      mountOptions: mountOptions.split(","),
      optionalFields: fields.slice(6, separator).map(decodeMountField),
      filesystem,
      mountSource: decodeMountField(mountSource),
      superOptions: superOptions.split(","),
    });
  }
  return entries;
}

function selectedMounts(
  entries: readonly LinuxMountInfoEntry[],
): LinuxMountInfoEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.mountPoint === PROJECT_TARGET ||
        entry.mountPoint.startsWith(`${PROJECT_TARGET}/`),
    )
    .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
}

function validateMountTable(
  source: string,
  mountSet: OpenShellMountSet,
): MountTableEvidence {
  const entries = selectedMounts(parseLinuxMountInfo(source));
  const expected = new Map(
    mountSet.mounts.map((mount) => [mount.target, mount] as const),
  );
  if (entries.length !== expected.size) {
    throw new OrchestratorError(
      "mount_table_mismatch",
      `Observed ${entries.length} Project mounts; expected ${expected.size}`,
    );
  }
  for (const entry of entries) {
    const requested = expected.get(entry.mountPoint);
    if (!requested) {
      throw new OrchestratorError(
        "mount_table_mismatch",
        `Unexpected Project mount '${entry.mountPoint}'`,
      );
    }
    const expectedMode = requested.readOnly ? "ro" : "rw";
    if (
      !entry.mountOptions.includes(expectedMode) ||
      entry.filesystem === "fakeowner"
    ) {
      throw new OrchestratorError(
        "mount_table_mismatch",
        `Project mount '${entry.mountPoint}' is not a ${expectedMode} native volume mount`,
      );
    }
  }
  return {
    rawDigest: sha256(source),
    selectedDigest: digestParts("pi-orchestrator/observed-mount-table/v1", [
      ["entries", canonicalJson(entries)],
    ]),
    entries,
  };
}

function parseAssertions(
  result: ProcessResult,
  expected: ReadonlyMap<string, string>,
): WorkspaceVolumeAssertion[] {
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    return [
      {
        id: "volume-canary-script",
        passed: false,
        detail: `script exited ${result.exitCode}${diagnostic ? `: ${diagnostic.slice(0, 240)}` : ""}`,
      },
    ];
  }
  const observed = new Map<string, string>();
  const malformed: string[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    const [id, status, ...extra] = line.split("\t");
    if (
      !id ||
      !status ||
      extra.length > 0 ||
      !expected.has(id) ||
      !["pass", "fail"].includes(status) ||
      observed.has(id)
    ) {
      malformed.push(line);
      continue;
    }
    observed.set(id, status);
  }
  const assertions = [...expected].map(([id, detail]) => ({
    id,
    passed: observed.get(id) === "pass",
    detail:
      observed.get(id) === "pass"
        ? detail
        : observed.has(id)
          ? `Sandbox behavior violated: ${detail}`
          : `Canary output omitted '${id}'`,
  }));
  if (malformed.length > 0) {
    assertions.push({
      id: "volume-canary-output",
      passed: false,
      detail: `Malformed output: ${malformed.join(" | ").slice(0, 240)}`,
    });
  }
  return assertions;
}

function assertGateway(
  expected: EnabledSharedWorkspaceSettings,
  client: WorkspaceVolumeOpenShell,
  preflight: OpenShellPreflight,
  registration: OpenShellGatewayRegistration | undefined,
  info: OpenShellGatewayInfo,
): void {
  if (preflight.requiredVersion === undefined) {
    throw new OrchestratorError(
      "openshell_version_unpinned",
      "Shared Workspace canaries require an exact OpenShell version pin",
    );
  }
  if (client.gateway !== expected.gateway) {
    throw new OrchestratorError(
      "shared_workspace_gateway_mismatch",
      `Shared workspaces require explicit gateway '${expected.gateway}'`,
    );
  }
  if (
    !registration ||
    registration.is_remote ||
    registration.type !== "local" ||
    registration.name !== expected.gateway ||
    registration.auth !== "mtls"
  ) {
    throw new OrchestratorError(
      "shared_workspace_gateway_not_local",
      `Gateway '${expected.gateway}' is not a registered local gateway`,
    );
  }
  if (
    preflight.status.gateway !== expected.gateway ||
    info.gateway !== expected.gateway ||
    info.status !== "healthy" ||
    info.version !== preflight.installedVersion ||
    info.server !== preflight.status.server ||
    registration.endpoint !== info.server
  ) {
    throw new OrchestratorError(
      "shared_workspace_gateway_mismatch",
      `Gateway '${expected.gateway}' information does not match preflight`,
    );
  }
  const driver = info.compute_drivers.find(
    (candidate) => candidate.name === expected.driver,
  );
  if (
    info.compute_drivers.length !== 1 ||
    !driver ||
    driver.capabilities.driver_name !== expected.driver ||
    driver.capabilities.driver_version !== expected.driverVersion
  ) {
    throw new OrchestratorError(
      "shared_workspace_driver_mismatch",
      `Gateway '${expected.gateway}' does not expose only ${expected.driver} ${expected.driverVersion}`,
    );
  }
}

async function readySandbox(
  client: WorkspaceVolumeOpenShell,
  options: {
    readonly name: string;
    readonly image: string;
    readonly policy: LoadedSandboxPolicy;
    readonly mountSet: OpenShellMountSet;
  },
): Promise<OpenShellSandbox> {
  let sandbox = await client.createSandbox({
    name: options.name,
    from: options.image,
    policyPath: options.policy.path,
    mountSet: options.mountSet,
    labels: {
      "pio.purpose": "volume-proof",
      "pio.mounts": options.mountSet.digest.slice("sha256:".length, 48),
    },
    command: ["/usr/bin/true"],
  });
  if (sandbox.phase !== "Ready") {
    sandbox = await client.waitForSandbox(options.name);
  }
  if (sandbox.phase !== "Ready") {
    throw new OrchestratorError(
      "openshell_sandbox_failed",
      `Sandbox '${options.name}' did not become Ready`,
    );
  }
  return sandbox;
}

async function mountEvidence(
  client: WorkspaceVolumeOpenShell,
  sandbox: string,
  mountSet: OpenShellMountSet,
): Promise<MountTableEvidence> {
  const result = await client.execSandbox(
    sandbox,
    ["/usr/bin/cat", "/proc/self/mountinfo"],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new OrchestratorError(
      "mount_table_unavailable",
      `Cannot inspect mount table in '${sandbox}': ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return validateMountTable(result.stdout, mountSet);
}

async function stageImage(source: string): Promise<{
  readonly directory: string;
  readonly image: string;
  readonly digest: Digest;
}> {
  const sourceRoot = await realpath(path.resolve(source));
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "pi-orchestrator-volume-image-"),
  );
  const image = path.join(directory, "probe");
  try {
    await cp(sourceRoot, image, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    const entries = await inspectWorkspaceEntries(image);
    if (entries.some((entry) => entry.mode === "120000")) {
      throw new OrchestratorError(
        "invalid_canary_image",
        "Workspace volume canary image contexts cannot contain symlinks",
      );
    }
    return {
      directory,
      image,
      digest: workspaceTreeDigest(entries),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function evidenceDigest(
  result: Omit<WorkspaceVolumeCanaryResult, "evidenceDigest" | "passed">,
): Digest {
  return digestParts("pi-orchestrator/workspace-volume-canary/v1", [
    ["evidence", canonicalJson(result)],
  ]);
}

export async function runWorkspaceVolumeCanary(
  options: WorkspaceVolumeCanaryOptions,
): Promise<WorkspaceVolumeCanaryResult> {
  const settings = enabledSettings(options.settings);
  const docker =
    options.docker ??
    new DockerVolumeClient({
      command: settings.dockerCommand,
      requiredVersion: settings.driverVersion,
    });
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const hostHome = options.hostHome ?? os.homedir();
  const preflight = await options.client.preflight();
  const registrations = await options.client.listGateways();
  const info = await options.client.getGatewayInfo();
  const registration = registrations.find(
    (candidate) => candidate.name === settings.gateway,
  );
  assertGateway(settings, options.client, preflight, registration, info);
  const dockerVersion = await docker.version();
  if (dockerVersion !== settings.driverVersion) {
    throw new OrchestratorError(
      "docker_version_mismatch",
      `Docker ${dockerVersion} does not match OpenShell driver ${settings.driverVersion}`,
    );
  }

  const policyDirectory = path.resolve(
    options.policyDirectory ?? bundledPolicyDirectory(),
  );
  const [readPolicy, writePolicy] = await Promise.all([
    loadSandboxPolicy("read", path.join(policyDirectory, "read.yaml")),
    loadSandboxPolicy("write", path.join(policyDirectory, "write.yaml")),
  ]);
  const stagedImage = await stageImage(options.image ?? bundledCanaryImage());
  const proofRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-volume-proof-")),
  );
  const hostSentinel = path.join(proofRoot, "host-only");
  await writeFile(hostSentinel, randomBytes(32), { mode: 0o600 });

  const token = randomBytes(16).toString("hex");
  const suffix = (
    options.nameSuffix ?? (() => randomBytes(3).toString("hex"))
  )();
  const writerName = `pio-vol-w-${suffix}`;
  const readerName = `pio-vol-r-${suffix}`;
  const volumeName = `pio-proof-${suffix}`;
  const volumeLabels = {
    "io.pi-orchestrator.kind": "workspace-proof",
    "io.pi-orchestrator.token": suffix,
  };
  const assertions: WorkspaceVolumeAssertion[] = [];
  let volume: DockerVolumeCapability | undefined;
  let writer: OpenShellSandbox | undefined;
  let reader: OpenShellSandbox | undefined;
  let writerMountSet: OpenShellMountSet | undefined;
  let readerMountSet: OpenShellMountSet | undefined;
  let writerMounts: MountTableEvidence | undefined;
  let readerMounts: MountTableEvidence | undefined;
  let writerDeleted = false;
  let readerDeleted = false;
  let volumeDeleted = false;

  const result = (): WorkspaceVolumeCanaryResult => {
    const withoutDigest: Omit<
      WorkspaceVolumeCanaryResult,
      "evidenceDigest" | "passed"
    > = {
      version: 1,
      startedAt,
      completedAt: now().toISOString(),
      openshell: {
        cliVersion: preflight.installedVersion,
        gateway: info.gateway,
        gatewayVersion: info.version,
        driver: settings.driver,
        driverVersion: settings.driverVersion,
      },
      docker: {
        command: docker.command,
        version: dockerVersion,
        helperImage: VOLUME_HELPER_IMAGE,
      },
      image: {
        source: path.resolve(options.image ?? bundledCanaryImage()),
        contextDigest: stagedImage.digest,
      },
      policies: {
        read: readPolicy.digest,
        write: writePolicy.digest,
      },
      volume: {
        name: volumeName,
        ...(volume ? { digest: volume.digest } : {}),
        ...(writerMountSet
          ? { writerMountSetDigest: writerMountSet.digest }
          : {}),
        ...(readerMountSet
          ? { readerMountSetDigest: readerMountSet.digest }
          : {}),
      },
      sandboxes: {
        writer: {
          name: writerName,
          ...(writer ? { id: writer.id } : {}),
          ...(writerMounts ? { mounts: writerMounts } : {}),
        },
        reader: {
          name: readerName,
          ...(reader ? { id: reader.id } : {}),
          ...(readerMounts ? { mounts: readerMounts } : {}),
        },
      },
      assertions,
    };
    return {
      ...withoutDigest,
      evidenceDigest: evidenceDigest(withoutDigest),
      passed: assertions.length > 0 && assertions.every(({ passed }) => passed),
    };
  };

  try {
    volume = await docker.createVolume(volumeName, volumeLabels);
    assertions.push({
      id: "volume-created",
      passed: true,
      detail: "a plain labeled Docker volume was created and inspected",
    });
    await docker.runVolume({
      volume,
      image: VOLUME_HELPER_IMAGE,
      command: ["/bin/sh", "-eu", "-c", SEED_SCRIPT, "seed", token],
    });

    writerMountSet = OpenShellMountSet.forVolume({
      volume,
      writePaths: ["task"],
      protectedPaths: ["task/protected"],
      restrictedFiles: ["restricted.txt"],
      restrictedDirectories: ["restricted-dir"],
    });
    readerMountSet = OpenShellMountSet.forVolume({
      volume,
      protectedPaths: ["task/protected"],
      restrictedFiles: ["restricted.txt"],
      restrictedDirectories: ["restricted-dir"],
    });

    try {
      writer = await readySandbox(options.client, {
        name: writerName,
        image: stagedImage.image,
        policy: writePolicy,
        mountSet: writerMountSet,
      });
      reader = await readySandbox(options.client, {
        name: readerName,
        image: stagedImage.image,
        policy: readPolicy,
        mountSet: readerMountSet,
      });
      assertions.push({
        id: "sandboxes-ready",
        passed: true,
        detail: "writer and reader Sandboxes are Ready",
      });
    } catch (error) {
      assertions.push({
        id: "sandbox-lifecycle",
        passed: false,
        detail: formatUnknownError(error),
      });
      throw error;
    }

    for (const [name, mountSet, record] of [
      [
        writerName,
        writerMountSet,
        (value: MountTableEvidence) => (writerMounts = value),
      ],
      [
        readerName,
        readerMountSet,
        (value: MountTableEvidence) => (readerMounts = value),
      ],
    ] as const) {
      try {
        record(await mountEvidence(options.client, name, mountSet));
        assertions.push({
          id: `${name === writerName ? "writer" : "reader"}-mount-table`,
          passed: true,
          detail:
            "mount table contains exactly the compiled native-volume targets and access modes",
        });
      } catch (error) {
        assertions.push({
          id: `${name === writerName ? "writer" : "reader"}-mount-table`,
          passed: false,
          detail: formatUnknownError(error),
        });
      }
    }

    const gatewayUrl = new URL(preflight.status.server);
    gatewayUrl.hostname = "host.openshell.internal";
    const hostPaths = [
      hostSentinel,
      hostHome,
      path.resolve(options.stateRoot ?? defaultOrchestratorHome()),
      projectRoot,
      path.dirname(projectRoot),
      volume.mountpoint,
      process.env.SSH_AUTH_SOCK ?? "/run/host-services/ssh-auth.sock",
    ];
    const writerResult = await options.client.execSandbox(
      writerName,
      [
        "/usr/local/bin/orchestrator-mount-canary",
        "writer",
        token,
        gatewayUrl.toString(),
        ...hostPaths,
      ],
      { timeoutMs: 30_000 },
    );
    assertions.push(...parseAssertions(writerResult, writerAssertionDetails));

    const readerResult = await options.client.execSandbox(
      readerName,
      ["/usr/local/bin/orchestrator-mount-canary", "reader", token],
      { timeoutMs: 30_000 },
    );
    assertions.push(...parseAssertions(readerResult, readerAssertionDetails));

    const controllerRead = await docker.runVolume({
      volume,
      image: VOLUME_HELPER_IMAGE,
      command: ["/bin/cat", "/run-volume/project/task/shared.txt"],
      readOnly: true,
    });
    assertions.push({
      id: "controller-shared-visible",
      passed: controllerRead.stdout === `${token}\n`,
      detail: "the trusted controller sees the writer change in the Run volume",
    });

    await options.client.deleteSandbox(writerName);
    writerDeleted = true;
    const afterWriterDelete = await options.client.listSandboxes();
    assertions.push({
      id: "writer-projection-removed",
      passed: !afterWriterDelete.some((sandbox) => sandbox.name === writerName),
      detail: "writer Sandbox and writable projection are absent",
    });
    const postDeleteReader = await options.client.execSandbox(
      readerName,
      ["/usr/local/bin/orchestrator-mount-canary", "reader", token],
      { timeoutMs: 30_000 },
    );
    for (const assertion of parseAssertions(
      postDeleteReader,
      readerAssertionDetails,
    )) {
      assertions.push({ ...assertion, id: `post-delete-${assertion.id}` });
    }

    await options.client.deleteSandbox(readerName);
    readerDeleted = true;
    const afterCleanup = await options.client.listSandboxes();
    assertions.push({
      id: "sandbox-cleanup",
      passed: !afterCleanup.some(
        (sandbox) => sandbox.name === writerName || sandbox.name === readerName,
      ),
      detail: "both Workspace-volume Sandboxes are absent",
    });

    await docker.removeVolume(volumeName);
    volumeDeleted = true;
    assertions.push({
      id: "volume-cleanup",
      passed: (await docker.inspectVolume(volumeName)) === undefined,
      detail: "the disposable Run volume is absent",
    });
    return result();
  } catch (error) {
    if (!assertions.some(({ id }) => id === "sandbox-lifecycle")) {
      assertions.push({
        id: "workspace-volume-canary",
        passed: false,
        detail: formatUnknownError(error),
      });
    }
    for (const [name, deleted, markDeleted] of [
      [writerName, writerDeleted, () => (writerDeleted = true)],
      [readerName, readerDeleted, () => (readerDeleted = true)],
    ] as const) {
      if (deleted) continue;
      try {
        await options.client.deleteSandbox(name, { missingOk: true });
        markDeleted();
      } catch (cleanupError) {
        assertions.push({
          id: `${name === writerName ? "writer" : "reader"}-cleanup`,
          passed: false,
          detail: formatUnknownError(cleanupError),
        });
      }
    }
    try {
      const afterCleanup = await options.client.listSandboxes();
      assertions.push({
        id: "sandbox-cleanup",
        passed: !afterCleanup.some(
          (sandbox) =>
            sandbox.name === writerName || sandbox.name === readerName,
        ),
        detail: "both Workspace-volume Sandboxes are absent after failure",
      });
    } catch (cleanupError) {
      assertions.push({
        id: "sandbox-cleanup",
        passed: false,
        detail: formatUnknownError(cleanupError),
      });
    }
    if (!volumeDeleted) {
      try {
        await docker.removeVolume(volumeName, true);
        volumeDeleted = true;
        assertions.push({
          id: "volume-cleanup",
          passed: (await docker.inspectVolume(volumeName)) === undefined,
          detail: "the disposable Run volume is absent after failure",
        });
      } catch (cleanupError) {
        assertions.push({
          id: "volume-cleanup",
          passed: false,
          detail: formatUnknownError(cleanupError),
        });
      }
    }
    return result();
  } finally {
    if (!writerDeleted) {
      try {
        await options.client.deleteSandbox(writerName, { missingOk: true });
      } catch {
        // Cleanup failure is represented by the proof result when observable.
      }
    }
    if (!readerDeleted) {
      try {
        await options.client.deleteSandbox(readerName, { missingOk: true });
      } catch {
        // Cleanup failure is represented by the proof result when observable.
      }
    }
    if (!volumeDeleted) {
      try {
        await docker.removeVolume(volumeName, true);
      } catch {
        // Cleanup failure is represented by the proof result when observable.
      }
    }
    await rm(proofRoot, { recursive: true, force: true });
    await rm(stagedImage.directory, { recursive: true, force: true });
  }
}
