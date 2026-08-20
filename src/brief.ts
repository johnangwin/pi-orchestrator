import { z } from "zod";
import {
  IdentifierSchema,
  ReviewLensSchema,
  type ReviewLens,
} from "./config.js";
import { canonicalJson, digestParts, type Digest } from "./digest.js";
import type { LoadedPlan, PlanTask, SourceAnchor } from "./plan.js";
import type { PermissionCeiling } from "./permission.js";
import type { ResolvedModelRoute } from "./model.js";
import type { LoadedSkill } from "./project.js";
import type { Report } from "./report.js";
import type { LoadedRole } from "./role.js";

export const DecisionSchema = z
  .object({
    id: IdentifierSchema,
    scope: z.enum(["project", "run", "task"]),
    statement: z.string().min(1),
    rationale: z.string().min(1),
    accepted_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export interface BriefIdentity {
  readonly run: string;
  readonly agent: string;
  readonly session: string;
  readonly generation: number;
}

export interface BriefInput {
  readonly identity: BriefIdentity;
  readonly agents: string;
  readonly role: LoadedRole;
  readonly permissionCeiling: PermissionCeiling;
  readonly model: ResolvedModelRoute;
  readonly task: PlanTask;
  readonly plan: Pick<LoadedPlan, "id" | "revision" | "digest" | "markdown">;
  readonly decisions: readonly Decision[];
  readonly dependencyReports: readonly Report[];
  readonly handoff?: Report;
  readonly skills: readonly LoadedSkill[];
  readonly outputContract: string;
  readonly sourceAnchors: readonly SourceAnchor[];
  readonly sourceDigests: Readonly<Record<string, Digest>>;
  readonly review?: BriefReviewContext;
  readonly contextLimitTokens: number;
  readonly initialFraction?: number;
}

export interface BriefReviewCheck {
  readonly check: string;
  readonly verdict: "pass";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly recordDigest: Digest;
}

export interface BriefReviewContext {
  readonly lens: ReviewLens;
  readonly diff: {
    readonly path: "/workspace/input/review.patch";
    readonly digest: Digest;
  };
  readonly checks: readonly BriefReviewCheck[];
}

export interface BriefBinding {
  readonly planDigest: Digest;
  readonly roleDigest: Digest;
  readonly permissionCeilingDigest: Digest;
  readonly modelProfile: string;
  readonly routeDigest: Digest;
  readonly taskDigest: Digest;
  readonly decisionsDigest: Digest;
  readonly sourceDigests: Readonly<Record<string, Digest>>;
  readonly reviewDigest?: Digest;
  readonly handoffDigest?: Digest;
  readonly identity: BriefIdentity;
}

export interface CompiledBrief {
  readonly content: string;
  readonly digest: Digest;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly omissions: readonly string[];
  readonly binding: BriefBinding;
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function section(title: string, content: string): string {
  return `## ${title}\n\n${content.trim()}\n`;
}

export function compileBrief(input: BriefInput): CompiledBrief {
  const initialFraction = input.initialFraction ?? 0.25;
  const budgetTokens = Math.max(
    1,
    Math.floor(input.contextLimitTokens * initialFraction),
  );
  const omissions: string[] = [];

  const required = [
    section(
      "Identity",
      `Run: ${input.identity.run}\nAgent: ${input.identity.agent}\nSession: ${input.identity.session}\nGeneration: ${input.identity.generation}`,
    ),
    section("Project Instructions", input.agents),
    section(
      "Role",
      `${canonicalJson(input.role.definition)}\n\n${input.role.body}`,
    ),
    section(
      "Permission Ceiling",
      `Digest: ${input.permissionCeiling.permission_ceiling_digest}\n\n${canonicalJson(
        {
          source: input.permissionCeiling.source,
          write_lease: input.permissionCeiling.write_lease,
          pi_tools: input.permissionCeiling.pi_tools,
          actions: input.permissionCeiling.actions,
          assignment: input.permissionCeiling.assignment,
        },
      )}`,
    ),
    section(
      "Model Profile",
      `Profile: ${input.model.profile}\nRoute digest: ${input.model.route_digest}\nConcrete model: ${input.model.pi_model}\nLocality: ${input.model.locality}`,
    ),
    section("Task", canonicalJson(input.task)),
    section(
      "Plan",
      `Plan: ${input.plan.id}\nRevision: ${input.plan.revision}\nDigest: ${input.plan.digest}\n\n${input.plan.markdown}`,
    ),
    section(
      "Accepted Decisions",
      input.decisions.length === 0
        ? "None."
        : input.decisions.map((decision) => canonicalJson(decision)).join("\n"),
    ),
    section(
      "Dependency Reports",
      input.dependencyReports.length === 0
        ? "None."
        : input.dependencyReports
            .map((report) => `### ${report.id}\n\n${report.content}`)
            .join("\n\n"),
    ),
    ...(input.handoff
      ? [
          section(
            "Current Handoff",
            `Report: ${input.handoff.id}\nContent digest: ${input.handoff.content_digest}\n\n${input.handoff.content}`,
          ),
        ]
      : []),
    section("Required Output", input.outputContract),
    section(
      "Source Anchors",
      input.sourceAnchors.length === 0
        ? "None."
        : input.sourceAnchors.map((anchor) => canonicalJson(anchor)).join("\n"),
    ),
    section("Source Digests", canonicalJson(input.sourceDigests)),
  ];
  if (input.review) {
    required.push(
      section(
        "Review Evidence",
        `Lens: ${ReviewLensSchema.parse(input.review.lens)}\n\nChecks:\n${canonicalJson(input.review.checks)}\n\nCurrent diff: ${input.review.diff.path}\nDiff content digest: ${input.review.diff.digest}`,
      ),
    );
  }

  let content = `# Session Brief\n\n${required.join("\n")}`;
  const includedSkills: string[] = [];
  for (const skill of input.skills) {
    const candidate = section(`Skill: ${skill.name}`, skill.content);
    if (estimateTokens(`${content}\n${candidate}`) <= budgetTokens) {
      includedSkills.push(candidate);
    } else {
      omissions.push(
        `Skill '${skill.name}' content omitted; retrieve ${skill.path} if required.`,
      );
    }
  }
  content += `\n${includedSkills.join("\n")}`;

  if (estimateTokens(content) > budgetTokens) {
    omissions.push(
      `Required context exceeds the initial Brief budget of ${budgetTokens} estimated tokens; constraints were preserved without truncation.`,
    );
  }
  if (omissions.length > 0)
    content += `\n${section("Explicit Omissions", omissions.map((item) => `- ${item}`).join("\n"))}`;

  const binding: BriefBinding = {
    planDigest: input.plan.digest,
    roleDigest: input.role.digest,
    permissionCeilingDigest: input.permissionCeiling.permission_ceiling_digest,
    modelProfile: input.model.profile,
    routeDigest: input.model.route_digest,
    taskDigest: digestParts("pi-orchestrator/task/v1", [
      [input.task.id, canonicalJson(input.task)],
    ]),
    decisionsDigest: digestParts("pi-orchestrator/decisions/v1", [
      ["decisions", canonicalJson(input.decisions)],
    ]),
    sourceDigests: { ...input.sourceDigests },
    ...(input.review
      ? {
          reviewDigest: digestParts("pi-orchestrator/review-context/v1", [
            ["review", canonicalJson(input.review)],
          ]),
        }
      : {}),
    ...(input.handoff
      ? {
          handoffDigest: digestParts("pi-orchestrator/handoff-context/v1", [
            ["handoff", canonicalJson(input.handoff)],
          ]),
        }
      : {}),
    identity: { ...input.identity },
  };

  return {
    content,
    digest: digestParts("pi-orchestrator/brief/v2", [
      ["content", content],
      ["binding", canonicalJson(binding)],
    ]),
    estimatedTokens: estimateTokens(content),
    budgetTokens,
    omissions,
    binding,
  };
}

export function briefStaleReasons(
  previous: BriefBinding,
  current: BriefBinding,
): readonly string[] {
  const reasons: string[] = [];
  if (previous.planDigest !== current.planDigest)
    reasons.push("Plan digest changed");
  if (previous.roleDigest !== current.roleDigest) reasons.push("Role changed");
  if (previous.permissionCeilingDigest !== current.permissionCeilingDigest) {
    reasons.push("Permission ceiling changed");
  }
  if (previous.modelProfile !== current.modelProfile) {
    reasons.push("Model Profile changed");
  }
  if (previous.routeDigest !== current.routeDigest) {
    reasons.push("resolved model route changed");
  }
  if (previous.taskDigest !== current.taskDigest) reasons.push("Task changed");
  if (previous.decisionsDigest !== current.decisionsDigest)
    reasons.push("Decisions changed");
  if (
    canonicalJson(previous.sourceDigests) !==
    canonicalJson(current.sourceDigests)
  ) {
    reasons.push("source digest changed");
  }
  if (previous.reviewDigest !== current.reviewDigest) {
    reasons.push("Review evidence changed");
  }
  if (previous.handoffDigest !== current.handoffDigest) {
    reasons.push("Handoff changed");
  }
  if (canonicalJson(previous.identity) !== canonicalJson(current.identity)) {
    reasons.push("Session identity or generation changed");
  }
  return reasons;
}
