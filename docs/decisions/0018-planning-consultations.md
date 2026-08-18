# ADR 0018: Freeze independent planning consultations as durable Reports

## Status

Accepted

## Context

An answered repository questionnaire supplies human Decisions but not the specialist evidence required for Plan synthesis. Architecture and quantitative analysis must inspect the same exact source independently, remain isolated from one another, and survive the loss of every Pi Session without turning transcripts into planning memory.

## Decision

`orchestrator consult <planning-id>` requires an answered questionnaire and the same clean commit and source digest used by the Lead. It starts one fresh read-only Architect Session on the Role's `plan` route and one fresh read-only Quant Session on the Role's `quant` route. The Sessions run sequentially for deterministic host-state mutation, but their Briefs are independent: each contains the goal, questionnaire, accepted Decisions, source identity, Role, Skills, and its own output contract, and neither contains the other consultation or any transcript.

Architecture returns current constraints, conservative and target alternatives, a recommendation, risks, source anchors, and unresolved questions. Quant returns applicability, evidence, definitions and units, assumptions, analyses, risks, required verification, source anchors, and unresolved questions. A Quant conclusion of no material applicability remains evidence-bearing and requires verification. The host rejects malformed, truncated, wrongly routed, stale, or unknown-path output.

Each Role has monotonic consultation attempts in planning state. Immutable request, Brief, model-turn, Sandbox, structured output, and Report evidence is stored under the host-only planning directory and bound through domain-separated digests. The planning state becomes `consulting` when the first attempt starts and `consulted` only after both exact Reports are published. Completed evidence is reused; a failed Role receives a fresh Session attempt while the other Role's frozen Report remains unchanged.

Newly initialized Projects include `architect` and `quant` Roles and the Quant Skill. Existing consumer repositories are not modified automatically and must add those committed definitions and routes deliberately.

## Consequences

Lead synthesis can later consume two independent, repository-grounded Reports without receiving either Session transcript. A host restart can recover prepared requests, stored outputs, or one completed Role from immutable evidence and planning state.

This increment does not run an independent critic, synthesize `plan.md` or `tasks.yaml`, project planning Sessions into cmux, or implement general agent-to-agent consultation. Those remain later work.
