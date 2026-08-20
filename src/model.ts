import { z } from "zod";
import {
  ModelProfileSchema,
  ReviewLensSchema,
  RoleRoutingPolicySchema,
  RoutingPolicySchema,
  type ModelProfile,
  type ProjectConfig,
  type ReviewLens,
  type RoleRoutingPolicy,
} from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { LocalModelRouteSchema, type LocalConfig } from "./local.js";

const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): Digest => value as Digest);

const ResolvedModelRouteRecordSchema = LocalModelRouteSchema.safeExtend({
  profile: ModelProfileSchema,
  gateway_alias: z.string().min(1),
  gateway: z.string().min(1),
}).strict();

function resolvedRouteDigest(
  route: z.infer<typeof ResolvedModelRouteRecordSchema>,
): Digest {
  return digestParts("pi-orchestrator/model-route/v2", [
    ["record", canonicalJson(route)],
  ]);
}

export const ResolvedModelRouteSchema =
  ResolvedModelRouteRecordSchema.safeExtend({
    route_digest: DigestSchema,
  })
    .strict()
    .superRefine((route, context) => {
      const { route_digest: digest, ...record } = route;
      if (resolvedRouteDigest(record) !== digest) {
        context.addIssue({
          code: "custom",
          path: ["route_digest"],
          message: "does not match the resolved Model Profile route",
        });
      }
    });
export type ResolvedModelRoute = z.infer<typeof ResolvedModelRouteSchema>;

function normalizedRoutingPolicy(project: ProjectConfig) {
  const routing = RoutingPolicySchema.parse(project.routing);
  return {
    roles: Object.fromEntries(
      Object.entries(routing.roles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, policy]) => [
          role,
          {
            default: policy.default,
            allowed: [...policy.allowed].sort(),
            ...(policy.focuses
              ? {
                  focuses: Object.fromEntries(
                    Object.entries(policy.focuses).sort(([left], [right]) =>
                      left.localeCompare(right),
                    ),
                  ),
                }
              : {}),
            remote: policy.remote,
          },
        ]),
    ),
  };
}

export function routingPolicyDigest(project: ProjectConfig): Digest {
  return digestParts("pi-orchestrator/routing-policy/v2", [
    ["record", canonicalJson(normalizedRoutingPolicy(project))],
  ]);
}

export function formatRoutingPolicy(project: ProjectConfig): string {
  return Object.entries(normalizedRoutingPolicy(project).roles)
    .map(([role, policy]) => {
      const focuses = Object.entries(policy.focuses ?? {})
        .map(([focus, profile]) => `${focus}=${profile}`)
        .join(", ");
      return `${role}: default=${policy.default}; allowed=[${policy.allowed.join(", ")}]; focuses=[${focuses}]; remote=${policy.remote}`;
    })
    .join("\n");
}

export function roleRoutingPolicy(
  project: ProjectConfig,
  role: string,
): RoleRoutingPolicy {
  const parsedRole = ModelProfileSchema.parse(role);
  const policy = project.routing.roles[parsedRole];
  if (!policy) {
    throw new OrchestratorError(
      "model_policy_not_found",
      `Role '${parsedRole}' has no committed Model Profile policy`,
    );
  }
  return RoleRoutingPolicySchema.parse(policy);
}

export function selectModelProfile(input: {
  readonly project: ProjectConfig;
  readonly role: string;
  readonly profile?: string;
  readonly focus?: ReviewLens;
}): ModelProfile {
  const policy = roleRoutingPolicy(input.project, input.role);
  const focus =
    input.focus === undefined ? undefined : ReviewLensSchema.parse(input.focus);
  const selected = ModelProfileSchema.parse(
    input.profile ??
      (focus ? policy.focuses?.[focus] : undefined) ??
      policy.default,
  );
  if (!policy.allowed.includes(selected)) {
    throw new OrchestratorError(
      "model_profile_denied",
      `Role '${input.role}' does not allow Model Profile '${selected}'`,
    );
  }
  return selected;
}

export function resolveModelRoute(
  config: LocalConfig,
  profile: ModelProfile,
): ResolvedModelRoute {
  const parsedProfile = ModelProfileSchema.parse(profile);
  const route = config.models[parsedProfile];
  if (!route) {
    throw new OrchestratorError(
      "model_route_not_found",
      `Model Profile '${parsedProfile}' has no machine-local route`,
    );
  }
  const gateway = config.openshell.gateways[route.gateway];
  if (!gateway) {
    throw new OrchestratorError(
      "model_gateway_not_found",
      `Model Profile '${parsedProfile}' references unknown OpenShell gateway alias '${route.gateway}'`,
    );
  }
  const record = ResolvedModelRouteRecordSchema.parse({
    ...route,
    profile: parsedProfile,
    gateway_alias: route.gateway,
    gateway,
  });
  return ResolvedModelRouteSchema.parse({
    ...record,
    route_digest: resolvedRouteDigest(record),
  });
}

function requireLocality(
  role: string,
  policy: RoleRoutingPolicy,
  route: ResolvedModelRoute,
): void {
  if (policy.remote === "denied" && route.locality === "remote") {
    throw new OrchestratorError(
      "model_locality_denied",
      `Role '${role}' denies remote inference, but Model Profile '${route.profile}' is remote`,
    );
  }
}

export function resolveRoleModelRoute(
  project: ProjectConfig,
  local: LocalConfig,
  role: string,
  options: { readonly profile?: string } = {},
): ResolvedModelRoute {
  const policy = roleRoutingPolicy(project, role);
  const profile = selectModelProfile({ project, role, ...options });
  const route = resolveModelRoute(local, profile);
  requireLocality(role, policy, route);
  return route;
}

export function reviewModelProfile(
  project: ProjectConfig,
  lens: ReviewLens,
  override?: string,
): ModelProfile {
  return selectModelProfile({
    project,
    role: "reviewer",
    focus: ReviewLensSchema.parse(lens),
    ...(override ? { profile: override } : {}),
  });
}

export function resolveReviewModelRoute(
  project: ProjectConfig,
  local: LocalConfig,
  lens: ReviewLens,
  options: { readonly profile?: string } = {},
): ResolvedModelRoute {
  const profile = reviewModelProfile(project, lens, options.profile);
  return resolveRoleModelRoute(project, local, "reviewer", { profile });
}

export function resolveAgentProfileChange(input: {
  readonly project: ProjectConfig;
  readonly local: LocalConfig;
  readonly role: string;
  readonly currentProfile: string;
  readonly targetProfile: string;
  readonly remoteEgressApproved?: boolean;
}): ResolvedModelRoute {
  const current = resolveModelRoute(
    input.local,
    ModelProfileSchema.parse(input.currentProfile),
  );
  const target = resolveRoleModelRoute(input.project, input.local, input.role, {
    profile: input.targetProfile,
  });
  if (
    current.locality === "local" &&
    target.locality === "remote" &&
    input.remoteEgressApproved !== true
  ) {
    throw new OrchestratorError(
      "model_egress_approval_required",
      `Changing Agent inference from local Profile '${current.profile}' to remote Profile '${target.profile}' requires trusted human approval`,
    );
  }
  return target;
}
