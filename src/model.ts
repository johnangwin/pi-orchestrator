import { z } from "zod";
import {
  ModelAliasSchema,
  ReviewLensSchema,
  type ModelAlias,
  type ProjectConfig,
  type ReviewLens,
} from "./config.js";
import { OrchestratorError } from "./error.js";
import {
  LocalModelRouteSchema,
  type LocalConfig,
  type ModelLocality,
} from "./local.js";

export const ResolvedModelRouteSchema = LocalModelRouteSchema.safeExtend({
  alias: ModelAliasSchema,
  gateway_alias: z.string().min(1),
  gateway: z.string().min(1),
}).strict();
export type ResolvedModelRoute = z.infer<typeof ResolvedModelRouteSchema>;

export function resolveModelRoute(
  config: LocalConfig,
  alias: ModelAlias,
): ResolvedModelRoute {
  const parsedAlias = ModelAliasSchema.parse(alias);
  const route = config.models[parsedAlias];
  if (!route) {
    throw new OrchestratorError(
      "model_route_not_found",
      `Logical model alias '${parsedAlias}' has no machine-local route`,
    );
  }
  const gateway = config.openshell.gateways[route.gateway];
  if (!gateway) {
    throw new OrchestratorError(
      "model_gateway_not_found",
      `Model alias '${parsedAlias}' references unknown OpenShell gateway alias '${route.gateway}'`,
    );
  }
  return ResolvedModelRouteSchema.parse({
    ...route,
    alias: parsedAlias,
    gateway_alias: route.gateway,
    gateway,
  });
}

function localityAllowed(
  policy: "local" | "prefer-local" | "remote" | undefined,
  locality: ModelLocality,
): boolean {
  if (policy === undefined || policy === "prefer-local") return true;
  return policy === locality;
}

export function resolveRoleModelRoute(
  project: ProjectConfig,
  local: LocalConfig,
  role: string,
  inference?: "local" | "prefer-local" | "remote",
): ResolvedModelRoute {
  const configured = project.models[role];
  const alias =
    typeof configured === "string" ? configured : configured?.default;
  if (!alias) {
    throw new OrchestratorError(
      "model_route_not_found",
      `Role '${role}' has no logical model route`,
    );
  }
  const route = resolveModelRoute(local, alias);
  if (!localityAllowed(inference, route.locality)) {
    throw new OrchestratorError(
      "model_locality_denied",
      `Role '${role}' requires ${inference} inference but alias '${alias}' is ${route.locality}`,
    );
  }
  return route;
}

export function reviewModelAlias(
  project: ProjectConfig,
  lens: ReviewLens,
): ModelAlias {
  const parsedLens = ReviewLensSchema.parse(lens);
  const configured = project.models.reviewer;
  const alias =
    typeof configured === "string"
      ? configured
      : parsedLens === "quant"
        ? (configured?.quant ?? configured?.default)
        : configured?.default;
  if (!alias) {
    throw new OrchestratorError(
      "model_route_not_found",
      `Reviewer Lens '${parsedLens}' has no logical model route`,
    );
  }
  return alias;
}

export function resolveReviewModelRoute(
  project: ProjectConfig,
  local: LocalConfig,
  lens: ReviewLens,
  inference?: "local" | "prefer-local" | "remote",
): ResolvedModelRoute {
  const alias = reviewModelAlias(project, lens);
  const route = resolveModelRoute(local, alias);
  if (!localityAllowed(inference, route.locality)) {
    throw new OrchestratorError(
      "model_locality_denied",
      `Reviewer Lens '${lens}' requires ${inference} inference but alias '${alias}' is ${route.locality}`,
    );
  }
  return route;
}
