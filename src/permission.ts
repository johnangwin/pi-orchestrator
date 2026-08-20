import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";

export const SourcePermissionSchema = z.enum(["none", "read"]);
export type SourcePermission = z.infer<typeof SourcePermissionSchema>;

export const WriteLeasePermissionSchema = z.enum(["never", "task"]);
export type WriteLeasePermission = z.infer<typeof WriteLeasePermissionSchema>;

export const PiToolPermissionSchema = z.enum([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
]);
export type PiToolPermission = z.infer<typeof PiToolPermissionSchema>;

export const OrchestratorActionPermissionSchema = z.enum([
  "ask",
  "message",
  "consult",
  "report",
  "handoff",
  "block",
  "finish",
  "propose_plan",
  "propose_decision",
  "coordinate",
]);
export type OrchestratorActionPermission = z.infer<
  typeof OrchestratorActionPermissionSchema
>;

function uniquePermissions<T extends string>(
  values: readonly T[],
  context: z.RefinementCtx,
  path: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "permissions must be unique",
    });
  }
}

export const PermissionSetSchema = z
  .object({
    source: SourcePermissionSchema,
    write_lease: WriteLeasePermissionSchema,
    pi_tools: z.array(PiToolPermissionSchema).max(32),
    actions: z.array(OrchestratorActionPermissionSchema).max(32),
  })
  .strict()
  .superRefine((permissions, context) => {
    uniquePermissions(permissions.pi_tools, context, "pi_tools");
    uniquePermissions(permissions.actions, context, "actions");
    const writeTools = permissions.pi_tools.filter((tool) =>
      ["write", "edit"].includes(tool),
    );
    if (permissions.source === "none" && permissions.pi_tools.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["pi_tools"],
        message: "source tools require source read permission",
      });
    }
    if (permissions.write_lease === "task" && permissions.source !== "read") {
      context.addIssue({
        code: "custom",
        path: ["write_lease"],
        message: "a Task Write Lease requires source read permission",
      });
    }
    if (writeTools.length > 0 && permissions.write_lease !== "task") {
      context.addIssue({
        code: "custom",
        path: ["pi_tools"],
        message: "write and edit tools require Task Write Lease eligibility",
      });
    }
    if (
      permissions.actions.includes("finish") &&
      permissions.write_lease !== "task"
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "finish requires Task Write Lease eligibility",
      });
    }
  });
export type PermissionSet = z.infer<typeof PermissionSetSchema>;

export const PermissionAssignmentSchema = z
  .object({
    kind: z.enum(["run", "design", "task", "review", "query"]),
    task: IdentifierSchema.optional(),
    lens: z.enum(["spec", "architecture", "quality", "quant"]).optional(),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (
      (assignment.kind === "task" || assignment.kind === "review") &&
      assignment.task === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["task"],
        message: "is required for a Task or Review assignment",
      });
    }
    if (
      assignment.kind !== "task" &&
      assignment.kind !== "review" &&
      assignment.task !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["task"],
        message: "is only valid for Task and Review assignments",
      });
    }
    if (assignment.kind !== "review" && assignment.lens !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["lens"],
        message: "is only valid for a Review assignment",
      });
    }
    if (assignment.kind === "review" && assignment.lens === undefined) {
      context.addIssue({
        code: "custom",
        path: ["lens"],
        message: "is required for a Review assignment",
      });
    }
  });
export type PermissionAssignment = z.infer<typeof PermissionAssignmentSchema>;

export const HOST_PERMISSION_CEILING: PermissionSet = {
  source: "read",
  write_lease: "task",
  pi_tools: [...PiToolPermissionSchema.options],
  actions: [...OrchestratorActionPermissionSchema.options],
};

export const DEFAULT_LOCAL_PERMISSION_POLICY: PermissionSet = {
  ...HOST_PERMISSION_CEILING,
  pi_tools: [...HOST_PERMISSION_CEILING.pi_tools],
  actions: [...HOST_PERMISSION_CEILING.actions],
};

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);

const PermissionCeilingRecordSchema = z
  .object({
    version: z.literal(2),
    role: IdentifierSchema,
    assignment: PermissionAssignmentSchema,
    source: SourcePermissionSchema,
    write_lease: WriteLeasePermissionSchema,
    pi_tools: z.array(PiToolPermissionSchema),
    actions: z.array(OrchestratorActionPermissionSchema),
    host_policy_digest: DigestSchema,
    local_policy_digest: DigestSchema,
    role_permissions_digest: DigestSchema,
    assignment_digest: DigestSchema,
  })
  .strict();

function permissionRecordDigest(
  record: z.infer<typeof PermissionCeilingRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/permission-ceiling/v2", [
    ["record", canonicalJson(record)],
  ]);
}

export const PermissionCeilingSchema = PermissionCeilingRecordSchema.extend({
  permission_ceiling_digest: DigestSchema,
})
  .strict()
  .superRefine((ceiling, context) => {
    const { permission_ceiling_digest: digest, ...record } = ceiling;
    if (permissionRecordDigest(record) !== digest) {
      context.addIssue({
        code: "custom",
        path: ["permission_ceiling_digest"],
        message: "does not match the permission ceiling record",
      });
    }
    uniquePermissions(ceiling.pi_tools, context, "pi_tools");
    uniquePermissions(ceiling.actions, context, "actions");
    const effective = PermissionSetSchema.safeParse({
      source: ceiling.source,
      write_lease: ceiling.write_lease,
      pi_tools: ceiling.pi_tools,
      actions: ceiling.actions,
    });
    if (!effective.success) {
      for (const issue of effective.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
    if (ceiling.assignment.kind !== "task" && ceiling.write_lease !== "never") {
      context.addIssue({
        code: "custom",
        path: ["write_lease"],
        message: "only a Task assignment may retain Write Lease eligibility",
      });
    }
    if (ceiling.host_policy_digest !== HOST_PERMISSION_POLICY_DIGEST) {
      context.addIssue({
        code: "custom",
        path: ["host_policy_digest"],
        message: "does not match the hard-coded host permission policy",
      });
    }
  });
export type PermissionCeiling = z.infer<typeof PermissionCeilingSchema>;

function normalizedSet(permissions: PermissionSet): PermissionSet {
  const parsed = PermissionSetSchema.parse(permissions);
  return {
    source: parsed.source,
    write_lease: parsed.write_lease,
    pi_tools: [...parsed.pi_tools].sort(),
    actions: [...parsed.actions].sort(),
  };
}

function setDigest(domain: string, permissions: PermissionSet): Digest {
  return digestParts(domain, [
    ["record", canonicalJson(normalizedSet(permissions))],
  ]);
}

export const HOST_PERMISSION_POLICY_DIGEST = setDigest(
  "pi-orchestrator/host-permission-policy/v2",
  HOST_PERMISSION_CEILING,
);

function assignmentPermissions(
  assignment: PermissionAssignment,
): PermissionSet {
  const task = assignment.kind === "task";
  return {
    source: "read",
    write_lease: task ? "task" : "never",
    pi_tools: PiToolPermissionSchema.options.filter(
      (tool) => task || !["write", "edit"].includes(tool),
    ),
    actions: OrchestratorActionPermissionSchema.options.filter(
      (action) => task || action !== "finish",
    ),
  };
}

function intersectSets(sets: readonly PermissionSet[]): PermissionSet {
  const source = sets.every((value) => value.source === "read")
    ? "read"
    : "none";
  const writeLease = sets.every((value) => value.write_lease === "task")
    ? "task"
    : "never";
  const piTools = PiToolPermissionSchema.options.filter((tool) =>
    sets.every((value) => value.pi_tools.includes(tool)),
  );
  const actions = OrchestratorActionPermissionSchema.options.filter((action) =>
    sets.every((value) => value.actions.includes(action)),
  );
  return PermissionSetSchema.parse({
    source,
    write_lease: writeLease,
    pi_tools: piTools,
    actions,
  });
}

export function createPermissionCeiling(input: {
  readonly role: string;
  readonly rolePermissions: PermissionSet;
  readonly assignment: PermissionAssignment;
  readonly localPolicy?: PermissionSet;
}): PermissionCeiling {
  const role = IdentifierSchema.parse(input.role);
  const rolePermissions = normalizedSet(input.rolePermissions);
  const localPolicy = normalizedSet(
    input.localPolicy ?? DEFAULT_LOCAL_PERMISSION_POLICY,
  );
  const assignment = PermissionAssignmentSchema.parse(input.assignment);
  const assignmentPolicy = assignmentPermissions(assignment);
  const effective = intersectSets([
    HOST_PERMISSION_CEILING,
    localPolicy,
    rolePermissions,
    assignmentPolicy,
  ]);
  const record = PermissionCeilingRecordSchema.parse({
    version: 2,
    role,
    assignment,
    ...effective,
    host_policy_digest: HOST_PERMISSION_POLICY_DIGEST,
    local_policy_digest: setDigest(
      "pi-orchestrator/local-permission-policy/v2",
      localPolicy,
    ),
    role_permissions_digest: setDigest(
      "pi-orchestrator/role-permissions/v2",
      rolePermissions,
    ),
    assignment_digest: digestParts("pi-orchestrator/permission-assignment/v2", [
      ["record", canonicalJson(assignment)],
    ]),
  });
  return PermissionCeilingSchema.parse({
    ...record,
    permission_ceiling_digest: permissionRecordDigest(record),
  });
}

export function resolveRolePermissionCeiling(input: {
  readonly role: {
    readonly definition: {
      readonly name: string;
      readonly lifetime: PermissionAssignment["kind"];
      readonly permissions: PermissionSet;
    };
  };
  readonly assignment: PermissionAssignment;
  readonly localPolicy?: PermissionSet;
}): PermissionCeiling {
  const assignment = PermissionAssignmentSchema.parse(input.assignment);
  if (input.role.definition.lifetime !== assignment.kind) {
    throw new OrchestratorError(
      "permission_assignment_mismatch",
      `Role '${input.role.definition.name}' has '${input.role.definition.lifetime}' lifetime and cannot receive a '${assignment.kind}' assignment`,
    );
  }
  return createPermissionCeiling({
    role: input.role.definition.name,
    rolePermissions: input.role.definition.permissions,
    assignment,
    ...(input.localPolicy ? { localPolicy: input.localPolicy } : {}),
  });
}

type ProjectPermissionRoles = ReadonlyMap<
  string,
  {
    readonly definition: {
      readonly version: 2;
      readonly permissions: PermissionSet;
    };
  }
>;

function projectPermissionEntries(roles: ProjectPermissionRoles) {
  return [...roles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, role]) =>
        [name, normalizedSet(role.definition.permissions)] as const,
    );
}

export function projectPermissionPolicyDigest(
  roles: ProjectPermissionRoles,
): Digest {
  const policy = {
    version: 2,
    host_policy_digest: HOST_PERMISSION_POLICY_DIGEST,
    roles: Object.fromEntries(projectPermissionEntries(roles)),
  };
  return digestParts("pi-orchestrator/permission-policy/v2", [
    ["record", canonicalJson(policy)],
  ]);
}

export function formatProjectPermissionPolicy(
  roles: ProjectPermissionRoles,
): string {
  return projectPermissionEntries(roles)
    .map(
      ([name, permissions]) =>
        `${name}: source=${permissions.source}; write_lease=${permissions.write_lease}; pi_tools=[${permissions.pi_tools.join(", ")}]; actions=[${permissions.actions.join(", ")}]`,
    )
    .join("\n");
}

export const PermissionRuntimeStateSchema = z
  .object({
    session_current: z.boolean(),
    run_allows_actions: z.boolean(),
    review_frozen: z.boolean(),
    write_lease_active: z.boolean(),
  })
  .strict();
export type PermissionRuntimeState = z.infer<
  typeof PermissionRuntimeStateSchema
>;

export const DEFAULT_PERMISSION_RUNTIME_STATE: PermissionRuntimeState = {
  session_current: true,
  run_allows_actions: true,
  review_frozen: false,
  write_lease_active: false,
};

export function permissionRuntimeState(input: {
  readonly ceiling: PermissionCeiling;
  readonly identity: {
    readonly agent: string;
    readonly session: string;
    readonly generation: number;
  };
  readonly run: {
    readonly status: string;
    readonly agents: Readonly<
      Record<
        string,
        { readonly session: string | null; readonly generation: number }
      >
    >;
    readonly tasks: Readonly<Record<string, { readonly status: string }>>;
  };
  readonly reviewFrozen?: boolean;
}): PermissionRuntimeState {
  const ceiling = PermissionCeilingSchema.parse(input.ceiling);
  const agent = input.run.agents[input.identity.agent];
  const sessionCurrent =
    agent?.session === input.identity.session &&
    agent.generation === input.identity.generation;
  const assignedTask = ceiling.assignment.task;
  const task = assignedTask ? input.run.tasks[assignedTask] : undefined;
  return PermissionRuntimeStateSchema.parse({
    session_current: sessionCurrent,
    run_allows_actions: input.run.status === "active",
    review_frozen: input.reviewFrozen ?? false,
    write_lease_active:
      sessionCurrent &&
      input.run.status === "active" &&
      ceiling.assignment.kind === "task" &&
      task?.status === "active",
  });
}

export function actionAllowed(
  ceiling: PermissionCeiling,
  action: OrchestratorActionPermission,
  runtime: PermissionRuntimeState = DEFAULT_PERMISSION_RUNTIME_STATE,
): boolean {
  const parsed = PermissionCeilingSchema.parse(ceiling);
  const state = PermissionRuntimeStateSchema.parse(runtime);
  if (!state.session_current || !parsed.actions.includes(action)) return false;
  if (
    !state.run_allows_actions &&
    !["report", "handoff", "block"].includes(action)
  ) {
    return false;
  }
  if (
    parsed.assignment.kind === "review" &&
    !state.review_frozen &&
    ["message", "consult", "coordinate"].includes(action)
  ) {
    return false;
  }
  if (action === "finish" && !state.write_lease_active) return false;
  return true;
}

export function requireAgentAction(
  ceiling: PermissionCeiling,
  action: OrchestratorActionPermission,
  runtime?: PermissionRuntimeState,
): void {
  if (!actionAllowed(ceiling, action, runtime)) {
    throw new OrchestratorError(
      "permission_denied",
      `Role '${ceiling.role}' cannot request Orchestrator action '${action}' in the current Run state`,
    );
  }
}

export function effectivePiTools(
  ceiling: PermissionCeiling,
  runtime: Pick<PermissionRuntimeState, "write_lease_active">,
): readonly PiToolPermission[] {
  const parsed = PermissionCeilingSchema.parse(ceiling);
  return parsed.pi_tools.filter(
    (tool) => !["write", "edit"].includes(tool) || runtime.write_lease_active,
  );
}

export function requireWritableGrant(
  ceiling: PermissionCeiling,
  task: string | undefined,
): void {
  const parsed = PermissionCeilingSchema.parse(ceiling);
  const requestedTask =
    task === undefined ? undefined : IdentifierSchema.parse(task);
  if (
    parsed.write_lease !== "task" ||
    parsed.assignment.kind !== "task" ||
    requestedTask === undefined ||
    parsed.assignment.task !== requestedTask
  ) {
    throw new OrchestratorError(
      "write_grant_required",
      `Role '${parsed.role}' requires an exact trusted Task write grant before a writable Sandbox may start`,
    );
  }
}

export function roleHasReadSource(input: {
  readonly permissions: PermissionSet;
}): boolean {
  return input.permissions.source === "read";
}

export function roleCanImplementTask(input: {
  readonly permissions: PermissionSet;
}): boolean {
  return (
    input.permissions.source === "read" &&
    input.permissions.write_lease === "task" &&
    input.permissions.pi_tools.includes("write") &&
    input.permissions.pi_tools.includes("edit") &&
    input.permissions.actions.includes("finish")
  );
}
