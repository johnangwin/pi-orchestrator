import { describe, expect, it } from "vitest";
import { ApprovalSchema, approvalFreshness } from "../src/approval.js";
import { briefStaleReasons, type BriefBinding } from "../src/brief.js";
import { sha256 } from "../src/digest.js";
import {
  PermissionSetSchema,
  actionAllowed,
  createPermissionCeiling,
  effectivePiTools,
  formatProjectPermissionPolicy,
  permissionRuntimeState,
  projectPermissionPolicyDigest,
  requireAgentAction,
  requireWritableGrant,
  type PermissionSet,
} from "../src/permission.js";
import { RoleSchema } from "../src/role.js";
import { actionAllowed as clientActionAllowed } from "../sandbox/pi/client/index.mjs";

const readPermissions: PermissionSet = {
  source: "read",
  write_lease: "never",
  pi_tools: ["read", "grep", "find", "ls", "bash"],
  actions: ["message", "consult", "report", "handoff", "block"],
};

const writePermissions: PermissionSet = {
  source: "read",
  write_lease: "task",
  pi_tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
  actions: ["message", "consult", "report", "handoff", "block", "finish"],
};

function roleInput(permissions: PermissionSet, lifetime = "task") {
  return {
    version: 2,
    name: "fixture-role",
    description: "Exercise the permission boundary.",
    skills: [],
    lifetime,
    needs: [],
    permissions,
  };
}

function binding(permissionCeilingDigest: `sha256:${string}`): BriefBinding {
  const digest = sha256("fixed-binding");
  return {
    planDigest: digest,
    roleDigest: digest,
    permissionCeilingDigest,
    taskDigest: digest,
    decisionsDigest: digest,
    sourceDigests: { "src/fixture.ts": digest },
    identity: {
      run: "run-one",
      agent: "implementer",
      session: "session-one",
      generation: 1,
    },
  };
}

describe("Role permission validation", () => {
  it("rejects unknown, contradictory, and omitted required permissions", () => {
    expect(
      PermissionSetSchema.safeParse({
        ...readPermissions,
        actions: ["commit"],
      }).success,
    ).toBe(false);
    expect(
      PermissionSetSchema.safeParse({
        ...readPermissions,
        pi_tools: [...readPermissions.pi_tools, "write"],
      }).success,
    ).toBe(false);
    expect(
      PermissionSetSchema.safeParse({
        source: "read",
        write_lease: "never",
        pi_tools: [],
      }).success,
    ).toBe(false);
    expect(
      RoleSchema.safeParse(roleInput(writePermissions, "run")).success,
    ).toBe(false);
    expect(
      createPermissionCeiling.bind(null, {
        role: "reviewer",
        rolePermissions: readPermissions,
        assignment: { kind: "review" },
      }),
    ).toThrowError(/Task or Review assignment/);
  });

  it.each([
    "approve",
    "git",
    "commit",
    "sandbox",
    "cmux",
    "waive_gate",
    "credential",
    "human_confirmation",
  ])("does not admit non-delegable '%s' authority", (action) => {
    expect(
      PermissionSetSchema.safeParse({
        ...readPermissions,
        actions: [...readPermissions.actions, action],
      }).success,
    ).toBe(false);
  });
});

describe("effective Session permissions", () => {
  it("intersects host, local, Role, and assignment ceilings", () => {
    const ceiling = createPermissionCeiling({
      role: "implementer",
      rolePermissions: writePermissions,
      assignment: { kind: "task", task: "bounded-change" },
      localPolicy: {
        source: "read",
        write_lease: "never",
        pi_tools: ["read", "grep"],
        actions: ["report", "handoff", "block"],
      },
    });

    expect(ceiling).toMatchObject({
      source: "read",
      write_lease: "never",
      pi_tools: ["read", "grep"],
      actions: ["report", "handoff", "block"],
    });
  });

  it("does not turn Task Write Lease eligibility into an active grant", () => {
    const ceiling = createPermissionCeiling({
      role: "implementer",
      rolePermissions: writePermissions,
      assignment: { kind: "task", task: "bounded-change" },
    });

    expect(
      effectivePiTools(ceiling, { write_lease_active: false }),
    ).not.toContain("write");
    expect(() => requireWritableGrant(ceiling, undefined)).toThrowError(
      /exact trusted Task write grant/,
    );
    expect(() => requireWritableGrant(ceiling, "other-task")).toThrowError(
      /exact trusted Task write grant/,
    );
    expect(() => requireWritableGrant(ceiling, "bounded-change")).not.toThrow();
  });

  it("denies Reviewer coordination until its independent Review is frozen", () => {
    const ceiling = createPermissionCeiling({
      role: "reviewer",
      rolePermissions: {
        ...readPermissions,
        actions: [...readPermissions.actions, "coordinate"],
      },
      assignment: {
        kind: "review",
        task: "bounded-change",
        lens: "quality",
      },
    });
    const activeReview = {
      session_current: true,
      run_allows_actions: true,
      review_frozen: false,
      write_lease_active: false,
    };

    expect(actionAllowed(ceiling, "coordinate", activeReview)).toBe(false);
    expect(() =>
      requireAgentAction(ceiling, "coordinate", activeReview),
    ).toThrowError(/cannot request Orchestrator action/);
    expect(
      actionAllowed(ceiling, "coordinate", {
        ...activeReview,
        review_frozen: true,
      }),
    ).toBe(true);
  });

  it("rejects actions from a stale Session even when its Role permits them", () => {
    const ceiling = createPermissionCeiling({
      role: "scout",
      rolePermissions: readPermissions,
      assignment: { kind: "query" },
    });
    expect(
      actionAllowed(ceiling, "report", {
        session_current: false,
        run_allows_actions: true,
        review_frozen: false,
        write_lease_active: false,
      }),
    ).toBe(false);
  });

  it("derives current generation and Task write lease state from the durable Run", () => {
    const ceiling = createPermissionCeiling({
      role: "implementer",
      rolePermissions: writePermissions,
      assignment: { kind: "task", task: "bounded-change" },
    });
    const run = {
      status: "active",
      agents: {
        implementer: { session: "session-two", generation: 2 },
      },
      tasks: { "bounded-change": { status: "active" } },
    };

    expect(
      permissionRuntimeState({
        ceiling,
        identity: {
          agent: "implementer",
          session: "session-two",
          generation: 2,
        },
        run,
      }),
    ).toMatchObject({ session_current: true, write_lease_active: true });
    expect(
      permissionRuntimeState({
        ceiling,
        identity: {
          agent: "implementer",
          session: "session-one",
          generation: 1,
        },
        run,
      }),
    ).toMatchObject({ session_current: false, write_lease_active: false });
  });

  it("applies the same static ceiling in the Pi client", () => {
    const reviewer = createPermissionCeiling({
      role: "reviewer",
      rolePermissions: {
        ...readPermissions,
        actions: [...readPermissions.actions, "coordinate"],
      },
      assignment: {
        kind: "review",
        task: "bounded-change",
        lens: "spec",
      },
    });
    const config = {
      permission_ceiling: reviewer,
      profile: "read" as const,
    };

    expect(clientActionAllowed(config, "report")).toBe(true);
    expect(clientActionAllowed(config, "coordinate")).toBe(false);
    expect(clientActionAllowed(config, "finish")).toBe(false);
    expect(clientActionAllowed(config, "approve")).toBe(false);
  });
});

describe("permission evidence freshness", () => {
  it("invalidates approval and Brief evidence after a Role permission change", () => {
    const before = projectPermissionPolicyDigest(
      new Map([
        [
          "worker",
          { definition: { version: 2 as const, permissions: readPermissions } },
        ],
      ]),
    );
    const after = projectPermissionPolicyDigest(
      new Map([
        [
          "worker",
          {
            definition: { version: 2 as const, permissions: writePermissions },
          },
        ],
      ]),
    );
    const approval = ApprovalSchema.parse({
      version: 2,
      plan_id: "fixture-plan",
      plan_revision: 1,
      plan_digest: sha256("plan"),
      permission_policy_digest: before,
      base_commit: "base-commit",
      approved_by: "tester",
      approved_at: "2026-08-19T12:00:00.000Z",
    });

    expect(before).not.toBe(after);
    expect(
      approvalFreshness(approval, {
        planId: approval.plan_id,
        planRevision: approval.plan_revision,
        planDigest: approval.plan_digest as `sha256:${string}`,
        permissionPolicyDigest: after,
        baseCommit: approval.base_commit,
      }),
    ).toEqual({
      fresh: false,
      reasons: ["Role permission policy changed"],
    });
    expect(briefStaleReasons(binding(before), binding(after))).toContain(
      "Permission ceiling changed",
    );
  });

  it("renders every requested Role capability for human approval", () => {
    const policy = formatProjectPermissionPolicy(
      new Map([
        [
          "reader",
          { definition: { version: 2 as const, permissions: readPermissions } },
        ],
        [
          "writer",
          {
            definition: { version: 2 as const, permissions: writePermissions },
          },
        ],
      ]),
    );

    expect(policy).toContain("reader: source=read; write_lease=never");
    expect(policy).toContain("writer: source=read; write_lease=task");
    expect(policy).toContain("write");
    expect(policy).toContain("finish");
  });
});
