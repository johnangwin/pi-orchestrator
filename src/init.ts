import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { IdentifierSchema } from "./config.js";
import { OrchestratorError } from "./error.js";

export interface InitResult {
  readonly root: string;
  readonly created: readonly string[];
}

const skills = {
  architecture: `---
name: architecture
description: Preserve project boundaries and distinguish current design from intended direction.
---

# Architecture

Identify the smallest coherent boundary that satisfies the approved Task. Do not add speculative factories, managers, repositories, or generic hierarchies.
`,
  quant: `---
name: quant
description: Verify quantitative definitions, units, assumptions, causality, and boundary behavior.
---

# Quant

Define every material quantity and unit. Check dimensional consistency, assumptions, causal ordering, reproducibility, transaction effects, sensitivity, and boundary cases. Independently reproduce important calculations where practical. When quantitative semantics are not material, identify the repository evidence and verification that support that conclusion.
`,
  development: `---
name: development
description: Implement one bounded Task while preserving its non-goals and source scope.
---

# Development

Implement only the approved Task. Report scope pressure instead of silently widening the change.
`,
  review: `---
name: review
description: Perform evidence-based independent review against one declared Lens.
---

# Review

Ground blocking findings in a location, failure scenario, evidence, and required correction.
`,
  verify: `---
name: verify
description: Evaluate deterministic evidence without treating model prose as a Gate result.
---

# Verify

Bind conclusions to the supplied Plan, source, diff, Check, image, and policy digests.
`,
} as const;

const roles = {
  lead: `---
name: lead
description: Maintain Run-level reasoning and synthesize durable decisions.
model: plan
skills:
  - architecture
access: read
lifetime: run
sandbox: read
needs:
  - plan
  - decisions
inference: remote
---

# Lead

Coordinate through Plans, Decisions, Reports, and targeted consultations. Do not treat Session memory as authoritative state.
`,
  architect: `---
name: architect
description: Design repository-grounded boundaries and distinguish current architecture from intended direction.
model: plan
skills:
  - architecture
access: read
lifetime: design
sandbox: read
needs:
  - decisions
  - scope
inference: remote
---

# Architect

Produce conservative and cleaner target alternatives from exact repository evidence. Recommend the smallest coherent direction that preserves accepted Decisions and state what must not be implemented prematurely.
`,
  quant: `---
name: quant
description: Analyze material quantitative semantics and required verification.
model: quant
skills:
  - architecture
  - quant
access: read
lifetime: design
sandbox: read
needs:
  - decisions
  - scope
inference: prefer-local
---

# Quant

Evaluate definitions, units, assumptions, calculations, causality, reproducibility, and boundary behavior. If quantitative semantics are not material, support that conclusion with repository evidence and a verification recommendation.
`,
  implementer: `---
name: implementer
description: Implement one approved Task in an isolated Sandbox.
model: code
skills:
  - architecture
  - development
access: write
lifetime: task
sandbox: write
needs:
  - task
  - plan
  - decisions
  - dependencies
  - scope
  - checks
inference: prefer-local
---

# Implementer

Remain within the approved Task and produce the required implementation Report and patch metadata.
`,
  reviewer: `---
name: reviewer
description: Perform one fresh independent Review under one Lens.
model: review
skills:
  - architecture
  - review
  - verify
access: read
lifetime: review
sandbox: read
needs:
  - task
  - plan
  - decisions
  - checks
inference: prefer-local
---

# Reviewer

Review only the frozen evidence in the Brief. Do not consult another Reviewer before submitting the Review.
`,
  scout: `---
name: scout
description: Perform bounded read-only repository reconnaissance.
model: fast
skills:
  - architecture
access: read
lifetime: query
sandbox: read
needs:
  - scope
inference: local
---

# Scout

Return concise source anchors and evidence. Do not propose or make source changes.
`,
} as const;

function projectConfig(projectId: string): string {
  return `version: 1

project:
  id: ${projectId}

roles:
  - lead
  - architect
  - quant
  - implementer
  - reviewer
  - scout

models:
  lead: plan
  architect: plan
  quant: quant
  implementer: code
  reviewer:
    default: review
    quant: quant
  scout: fast

context:
  initial_fraction: 0.25
  warn_fraction: 0.60
  handoff_fraction: 0.75
  stop_fraction: 0.85

attempts:
  implementation: 3
  review: 2
  consultation_hops: 2

git:
  branch_prefix: orchestrator/
  commit: human
  push: disabled
  merge: disabled

network:
  default: none

protected:
  - AGENTS.md
  - .agents/**
  - .pi/**
  - .github/**
  - docs/plans/**
  - "**/.env*"
  - "**/*secret*"

# Register deterministic argv arrays before adding a Plan.
checks: {}
`;
}

const localConfigExample = `version: 1

openshell:
  command: openshell
  required_version: "0.0.106"
  workspace: default
  gateways:
    plan: openshell-plan
    code: openshell-code
    quant: openshell-quant
    review: openshell-review
    fast: openshell-fast

models:
  plan:
    gateway: plan
    pi_model: planning
    api: openai-responses
    locality: remote
    context_window: 200000
    max_tokens: 16384
    reasoning: true
    # Optional host-side USD estimates per million tokens:
    # pricing:
    #   currency: USD
    #   input_per_million: 0
    #   output_per_million: 0
    #   cache_read_per_million: 0
    #   cache_write_per_million: 0

  code:
    gateway: code
    pi_model: qwen-local-code
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 16384
    reasoning: false

  quant:
    gateway: quant
    pi_model: quant-reasoner
    api: openai-responses
    locality: prefer-local
    context_window: 131072
    max_tokens: 16384
    reasoning: true

  review:
    gateway: review
    pi_model: reviewer
    api: openai-responses
    locality: prefer-local
    context_window: 131072
    max_tokens: 16384
    reasoning: true

  fast:
    gateway: fast
    pi_model: local-small
    api: openai-completions
    locality: local
    context_window: 32768
    max_tokens: 4096
    reasoning: false

cmux:
  command: /Applications/cmux.app/Contents/Resources/bin/cmux
  required_version: "0.64.22"
  workspace_prefix: orchestrator

worktrees:
  root: ~/.local/share/pi-orchestrator/worktrees
`;

async function create(
  filePath: string,
  content: string,
  created: string[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    created.push(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function initializeProject(
  root: string,
  requestedId?: string,
): Promise<InitResult> {
  const resolvedRoot = path.resolve(root);
  const inferred = path
    .basename(resolvedRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parsed = IdentifierSchema.safeParse(requestedId ?? inferred);
  if (!parsed.success) {
    throw new OrchestratorError(
      "invalid_project_id",
      `Cannot infer a valid Project ID from '${path.basename(resolvedRoot)}'; pass --project-id`,
    );
  }

  const created: string[] = [];
  await create(
    path.join(resolvedRoot, ".agents", "orchestrator.yaml"),
    projectConfig(parsed.data),
    created,
  );
  await create(
    path.join(resolvedRoot, "AGENTS.md"),
    "# Project Instructions\n\nDocument repository-specific constraints and verification commands here.\n",
    created,
  );
  for (const [name, content] of Object.entries(roles)) {
    await create(
      path.join(resolvedRoot, ".agents", "roles", `${name}.md`),
      content,
      created,
    );
  }
  for (const [name, content] of Object.entries(skills)) {
    await create(
      path.join(resolvedRoot, ".agents", "skills", name, "SKILL.md"),
      content,
      created,
    );
  }
  await create(
    path.join(resolvedRoot, "docs", "plans", "README.md"),
    "# Plans\n\nEach Plan lives in `<plan-id>/plan.md` and `<plan-id>/tasks.yaml`.\n",
    created,
  );
  await create(
    path.join(resolvedRoot, "docs", "decisions", "README.md"),
    "# Decisions\n\nStore durable Project decisions here.\n",
    created,
  );
  await create(
    path.join(resolvedRoot, ".pi", "orchestrator.local.yaml.example"),
    localConfigExample,
    created,
  );

  return { root: resolvedRoot, created };
}
