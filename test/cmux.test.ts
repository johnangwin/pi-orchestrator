import { describe, expect, it } from "vitest";
import {
  CMUX_REQUIRED_METHODS,
  CmuxClient,
  cmuxShellCommand,
  type CmuxWorkspaceBinding,
} from "../src/cmux.js";
import type { ProcessRunner } from "../src/openshell.js";

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const operationId = id(900);
const paneOperationId = id(901);

interface FakeSurface {
  id: string;
  title: string;
  selected: boolean;
}

interface FakePane {
  id: string;
  focused: boolean;
  surfaces: FakeSurface[];
}

interface FakeWorkspace {
  id: string;
  title: string;
  description: string | null;
  selected: boolean;
  panes: FakePane[];
  operationId: string;
}

class FakeCmux {
  readonly calls: string[][] = [];
  readonly workspaces: FakeWorkspace[] = [];
  capabilities = [...CMUX_REQUIRED_METHODS];
  createWorkspaceCount = 0;
  createPaneCount = 0;
  renameCount = 0;
  closeCount = 0;
  workspaceCreateParams: Record<string, unknown> | undefined;
  paneCreateParams: Record<string, unknown> | undefined;

  private nextId = 1;

  private allocate(): string {
    return id(this.nextId++);
  }

  private wire(value: string): string {
    return value.toUpperCase();
  }

  private result(value: unknown) {
    return Promise.resolve({
      stdout: `${JSON.stringify(value)}\n`,
      stderr: "",
      exitCode: 0,
    });
  }

  private workspace(workspaceId: string): FakeWorkspace {
    const workspace = this.workspaces.find(
      (candidate) => candidate.id === workspaceId.toLowerCase(),
    );
    if (!workspace) throw new Error(`Unknown Workspace ${workspaceId}`);
    return workspace;
  }

  private pane(workspace: FakeWorkspace, paneId: string): FakePane {
    const pane = workspace.panes.find(
      (candidate) => candidate.id === paneId.toLowerCase(),
    );
    if (!pane) throw new Error(`Unknown Pane ${paneId}`);
    return pane;
  }

  private surface(
    workspace: FakeWorkspace,
    surfaceId: string,
  ): { pane: FakePane; surface: FakeSurface } {
    for (const pane of workspace.panes) {
      const surface = pane.surfaces.find(
        (candidate) => candidate.id === surfaceId.toLowerCase(),
      );
      if (surface) return { pane, surface };
    }
    throw new Error(`Unknown Surface ${surfaceId}`);
  }

  readonly runner: ProcessRunner = (_command, args) => {
    const call = [...args];
    this.calls.push(call);
    if (call.length === 1 && call[0] === "--version") {
      return Promise.resolve({
        stdout: "cmux 0.64.22 (102) [ddd4a01bc]\n",
        stderr: "",
        exitCode: 0,
      });
    }
    expect(call.slice(0, 3)).toEqual(["--json", "--id-format", "uuids"]);
    const command = call.slice(3);

    if (command[0] === "capabilities") {
      return this.result({ methods: this.capabilities });
    }
    if (command[0] === "workspace" && command[1] === "list") {
      return this.result({
        window_id: null,
        workspaces: this.workspaces.map((workspace, index) => ({
          id: this.wire(workspace.id),
          title: workspace.title,
          description: workspace.description,
          selected: workspace.selected,
          index,
        })),
      });
    }
    if (
      command[0] === "rpc" &&
      command[1] === "workspace.create" &&
      command[2]
    ) {
      const params = JSON.parse(command[2]) as Record<string, unknown>;
      this.workspaceCreateParams = params;
      const requestedOperation = String(params.operation_id).toLowerCase();
      const existing = this.workspaces.find(
        (workspace) => workspace.operationId === requestedOperation,
      );
      if (existing) {
        return this.result({
          workspace_id: this.wire(existing.id),
          surface_id: this.wire(existing.panes[0]!.surfaces[0]!.id),
        });
      }
      this.createWorkspaceCount += 1;
      const workspaceId = this.allocate();
      const paneId = this.allocate();
      const surfaceId = this.allocate();
      this.workspaces.push({
        id: workspaceId,
        title: String(params.title),
        description:
          typeof params.description === "string" ? params.description : null,
        selected: Boolean(params.focus),
        operationId: requestedOperation,
        panes: [
          {
            id: paneId,
            focused: true,
            surfaces: [{ id: surfaceId, title: "Shell", selected: true }],
          },
        ],
      });
      return this.result({
        workspace_id: this.wire(workspaceId),
        surface_id: this.wire(surfaceId),
      });
    }
    if (command[0] === "workspace" && command[1] === "rename") {
      const workspace = this.workspace(command[2]!);
      workspace.title = command[4]!;
      return this.result({ workspace_id: this.wire(workspace.id) });
    }
    if (command[0] === "workspace" && command[1] === "select") {
      const workspace = this.workspace(command[2]!);
      for (const candidate of this.workspaces) candidate.selected = false;
      workspace.selected = true;
      return this.result({ workspace_id: this.wire(workspace.id) });
    }
    if (command[0] === "workspace" && command[1] === "close") {
      const workspace = this.workspace(command[2]!);
      this.workspaces.splice(this.workspaces.indexOf(workspace), 1);
      this.closeCount += 1;
      return this.result({ workspace_id: this.wire(workspace.id) });
    }
    if (command[0] === "list-panes") {
      const workspace = this.workspace(command[2]!);
      return this.result({
        workspace_id: this.wire(workspace.id),
        panes: workspace.panes.map((pane, index) => ({
          id: this.wire(pane.id),
          focused: pane.focused,
          surface_ids: pane.surfaces.map((surface) => this.wire(surface.id)),
          selected_surface_id: this.wire(
            (pane.surfaces.find((surface) => surface.selected) ??
              pane.surfaces[0])!.id,
          ),
          surface_count: pane.surfaces.length,
          index,
        })),
      });
    }
    if (command[0] === "list-pane-surfaces") {
      const workspace = this.workspace(command[2]!);
      const pane = this.pane(workspace, command[4]!);
      return this.result({
        workspace_id: this.wire(workspace.id),
        pane_id: this.wire(pane.id),
        surfaces: pane.surfaces.map((surface, index) => ({
          id: this.wire(surface.id),
          title: surface.title,
          type: "terminal",
          selected: surface.selected,
          index,
        })),
      });
    }
    if (command[0] === "rpc" && command[1] === "pane.create" && command[2]) {
      const params = JSON.parse(command[2]) as Record<string, unknown>;
      this.paneCreateParams = params;
      const workspace = this.workspace(String(params.workspace_id));
      const paneId = this.allocate();
      const surfaceId = this.allocate();
      workspace.panes.push({
        id: paneId,
        focused: Boolean(params.focus),
        surfaces: [{ id: surfaceId, title: "Shell", selected: true }],
      });
      this.createPaneCount += 1;
      return this.result({
        workspace_id: this.wire(workspace.id),
        pane_id: this.wire(paneId),
        surface_id: this.wire(surfaceId),
        type: "terminal",
      });
    }
    if (command[0] === "rename-tab") {
      const workspace = this.workspace(command[2]!);
      const { surface } = this.surface(workspace, command[4]!);
      surface.title = command[6]!;
      this.renameCount += 1;
      return this.result({
        workspace_id: this.wire(workspace.id),
        surface_id: this.wire(surface.id),
      });
    }
    if (command[0] === "focus-pane") {
      const workspace = this.workspace(command[2]!);
      const pane = this.pane(workspace, command[4]!);
      for (const candidate of workspace.panes) candidate.focused = false;
      pane.focused = true;
      return this.result({
        workspace_id: this.wire(workspace.id),
        pane_id: this.wire(pane.id),
      });
    }
    if (command[0] === "close-surface") {
      const workspace = this.workspace(command[2]!);
      const { pane, surface } = this.surface(workspace, command[4]!);
      pane.surfaces.splice(pane.surfaces.indexOf(surface), 1);
      if (pane.surfaces.length === 0) {
        workspace.panes.splice(workspace.panes.indexOf(pane), 1);
      }
      this.closeCount += 1;
      return this.result({
        workspace_id: this.wire(workspace.id),
        surface_id: this.wire(surface.id),
      });
    }

    throw new Error(`Unexpected cmux command: ${command.join(" ")}`);
  };
}

async function createWorkspace(client: CmuxClient) {
  return client.ensureWorkspace({
    operationId,
    title: "sample · run-one",
    cwd: "/tmp/run-one",
    description: "Pi Orchestrator Run run-one",
    command: ["orchestrator", "status", "--json"],
  });
}

async function createPane(client: CmuxClient, workspace: CmuxWorkspaceBinding) {
  const intent = await client.preparePaneCreation({
    operationId: paneOperationId,
    workspace,
    title: "implementer · code · task-one",
  });
  return client.ensurePane({
    operationId: paneOperationId,
    workspace,
    intent,
    title: "implementer · code · task-one",
    cwd: "/tmp/run-one",
    command: [
      "/Applications/Open Shell/bin/openshell",
      "sandbox",
      "exec",
      "O'Brien",
      "$(touch /tmp/not-executed)",
    ],
  });
}

describe("cmux preflight", () => {
  it("binds an exact CLI version to the required control methods", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({
      command: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      requiredVersion: "0.64.22",
      runner: fake.runner,
    });

    await expect(client.preflight()).resolves.toMatchObject({
      installedVersion: "0.64.22",
      requiredVersion: "0.64.22",
      versionMatches: true,
    });
    expect(fake.calls).toEqual([
      ["--version"],
      ["--json", "--id-format", "uuids", "capabilities"],
    ]);
  });

  it("fails before socket access when the installed version differs", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = (_command, args) => {
      calls.push([...args]);
      return Promise.resolve({
        stdout: "cmux 0.64.21\n",
        stderr: "",
        exitCode: 0,
      });
    };
    const client = new CmuxClient({
      requiredVersion: "0.64.22",
      runner,
    });

    await expect(client.preflight()).rejects.toMatchObject({
      code: "cmux_version_mismatch",
    });
    expect(calls).toEqual([["--version"]]);
  });

  it("fails closed when a required method is unavailable", async () => {
    const fake = new FakeCmux();
    fake.capabilities = fake.capabilities.filter(
      (method) => method !== "pane.create",
    );
    const client = new CmuxClient({ runner: fake.runner });

    await expect(client.preflight()).rejects.toMatchObject({
      code: "cmux_capability_missing",
    });
  });

  it("explains cmux control-socket authorization failures", async () => {
    const runner: ProcessRunner = (_command, args) =>
      Promise.resolve(
        args[0] === "--version"
          ? { stdout: "cmux 0.64.22\n", stderr: "", exitCode: 0 }
          : {
              stdout: "",
              stderr:
                "ERROR: Access denied - only processes started inside cmux can connect",
              exitCode: 1,
            },
      );
    const client = new CmuxClient({ runner });

    await expect(client.preflight()).rejects.toMatchObject({
      code: "cmux_access_denied",
    });
  });
});

describe("cmux lifecycle", () => {
  it("creates and recovers one Run Workspace by stable operation and title", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });

    const first = await createWorkspace(client);
    const second = await createWorkspace(client);

    expect(first).toMatchObject({ created: true, recovered: false });
    expect(second).toMatchObject({
      binding: first.binding,
      created: false,
      recovered: true,
    });
    expect(fake.createWorkspaceCount).toBe(1);
    expect(
      fake.calls.filter(
        (call) => call[3] === "rpc" && call[4] === "workspace.create",
      ),
    ).toHaveLength(2);
    expect(first.binding.workspace_id).toBe(id(1));
    expect(fake.workspaceCreateParams).toMatchObject({
      operation_id: operationId,
      title: "sample · run-one",
      working_directory: "/tmp/run-one",
      initial_command: "'orchestrator' 'status' '--json'",
      focus: false,
    });
  });

  it("repairs a natively recovered Workspace without adopting one by title", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const first = await createWorkspace(client);
    fake.workspaces[0]!.title = "renamed by user";

    await expect(createWorkspace(client)).resolves.toMatchObject({
      binding: first.binding,
      created: false,
      recovered: true,
      repaired: true,
    });
    expect(fake.workspaces[0]!.title).toBe(first.binding.title);
  });

  it("does not silently replace a missing durable Workspace binding", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const binding = (await createWorkspace(client)).binding;
    fake.workspaces.splice(0);

    await expect(
      client.ensureWorkspace({
        operationId,
        binding,
        title: binding.title,
      }),
    ).rejects.toMatchObject({ code: "cmux_workspace_missing" });
    expect(fake.createWorkspaceCount).toBe(1);
  });

  it("creates, titles, and recovers one Agent Pane without running a Node shell", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;

    const first = await createPane(client, workspace);
    const second = await createPane(client, workspace);

    expect(first).toMatchObject({ created: true, recovered: false });
    expect(second).toMatchObject({
      binding: first.binding,
      created: false,
      recovered: true,
    });
    expect(fake.createPaneCount).toBe(1);
    expect(fake.renameCount).toBe(1);
    expect(fake.paneCreateParams).toMatchObject({
      workspace_id: workspace.workspace_id,
      type: "terminal",
      direction: "right",
      working_directory: "/tmp/run-one",
      initial_command:
        "'/Applications/Open Shell/bin/openshell' 'sandbox' 'exec' 'O'\"'\"'Brien' '$(touch /tmp/not-executed)'",
      focus: false,
    });
  });

  it("recovers an unacknowledged Pane from a durable pre-create intent", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const intent = await client.preparePaneCreation({
      operationId: paneOperationId,
      workspace,
      title: "implementer · code · task-one",
    });
    fake.workspaces[0]!.panes.push({
      id: id(800),
      focused: false,
      surfaces: [{ id: id(801), title: "Shell", selected: true }],
    });

    await expect(
      client.ensurePane({
        operationId: paneOperationId,
        workspace,
        intent,
        title: intent.title,
      }),
    ).resolves.toMatchObject({
      binding: {
        operation_id: paneOperationId,
        pane_id: id(800),
        surface_id: id(801),
      },
      created: false,
      recovered: true,
      repaired: true,
    });
    expect(fake.createPaneCount).toBe(0);
    expect(fake.workspaces[0]!.panes[1]!.surfaces[0]!.title).toBe(intent.title);
  });

  it("repairs title drift only when the durable binding still resolves", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const pane = (await createPane(client, workspace)).binding;
    fake.workspaces[0]!.panes[1]!.surfaces[0]!.title = "changed";

    await expect(
      client.ensurePane({
        operationId: paneOperationId,
        workspace,
        binding: pane,
        title: pane.title,
      }),
    ).resolves.toMatchObject({ repaired: true, created: false });
    expect(fake.workspaces[0]!.panes[1]!.surfaces[0]!.title).toBe(pane.title);
  });

  it("does not silently replace a missing durable Pane binding", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const pane = (await createPane(client, workspace)).binding;
    fake.workspaces[0]!.panes.splice(1, 1);

    await expect(
      client.ensurePane({
        operationId: paneOperationId,
        workspace,
        binding: pane,
        title: pane.title,
      }),
    ).rejects.toMatchObject({ code: "cmux_pane_missing" });
    expect(fake.createPaneCount).toBe(1);
  });

  it("refuses to close a bound Pane after an unrelated Surface is added", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const pane = (await createPane(client, workspace)).binding;
    fake.workspaces[0]!.panes[1]!.surfaces.push({
      id: id(700),
      title: "user tab",
      selected: false,
    });

    await expect(client.closePane(pane)).rejects.toMatchObject({
      code: "cmux_pane_shape",
    });
    expect(fake.closeCount).toBe(0);
  });
});

describe("cmux reconciliation", () => {
  it("reports projection drift without mutating cmux or workflow state", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const pane = (await createPane(client, workspace)).binding;
    const projection = { workspace, panes: { implementer: pane } };

    await expect(client.reconcile(projection)).resolves.toMatchObject({
      healthy: true,
      workspace: { status: "present" },
      panes: { implementer: { status: "present" } },
    });

    fake.workspaces[0]!.title = "renamed by user";
    fake.workspaces[0]!.panes.splice(1, 1);
    const mutationsBefore =
      fake.createWorkspaceCount +
      fake.createPaneCount +
      fake.renameCount +
      fake.closeCount;
    await expect(client.reconcile(projection)).resolves.toMatchObject({
      healthy: false,
      workspace: {
        status: "title_mismatch",
        actualTitle: "renamed by user",
      },
      panes: { implementer: { status: "missing" } },
    });
    expect(
      fake.createWorkspaceCount +
        fake.createPaneCount +
        fake.renameCount +
        fake.closeCount,
    ).toBe(mutationsBefore);
  });

  it("does not infer completion when the entire cmux Workspace is gone", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;
    const pane = (await createPane(client, workspace)).binding;
    fake.workspaces.splice(0);

    await expect(
      client.reconcile({ workspace, panes: { implementer: pane } }),
    ).resolves.toMatchObject({
      healthy: false,
      workspace: { status: "missing" },
      panes: { implementer: { status: "workspace_missing" } },
    });
  });

  it("rejects malformed UUID output instead of adopting unstable handles", async () => {
    const runner: ProcessRunner = (_command, _args) =>
      Promise.resolve({
        stdout: JSON.stringify({
          workspaces: [
            { id: "workspace:1", title: "run", selected: true, index: 0 },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });
    const client = new CmuxClient({ runner });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "invalid_cmux_output",
    });
  });

  it("rejects a successful mutation response bound to another object", async () => {
    const runner: ProcessRunner = (_command, _args) =>
      Promise.resolve({
        stdout: JSON.stringify({ workspace_id: id(2) }),
        stderr: "",
        exitCode: 0,
      });
    const client = new CmuxClient({ runner });

    await expect(client.selectWorkspace(id(1))).rejects.toMatchObject({
      code: "invalid_cmux_output",
    });
  });
});

describe("cmux command serialization", () => {
  it("quotes every argument as inert POSIX shell data", () => {
    expect(cmuxShellCommand(["", "a b", "O'Brien", "$(false)"])).toBe(
      `'' 'a b' 'O'"'"'Brien' '$(false)'`,
    );
  });

  it("requires a durable pre-create intent before an unbound Pane mutation", async () => {
    const fake = new FakeCmux();
    const client = new CmuxClient({ runner: fake.runner });
    const workspace = (await createWorkspace(client)).binding;

    await expect(
      client.ensurePane({
        operationId: paneOperationId,
        workspace,
        title: "implementer · code · task-one",
      }),
    ).rejects.toMatchObject({ code: "cmux_intent_required" });
    expect(fake.createPaneCount).toBe(0);
  });
});
