# ADR 0019: Stage independently criticized Plan drafts outside the Project

## Status

Accepted; Plan publication amended by [ADR 0029](0029-plan-publication.md)

## Context

The questionnaire and specialist consultations produce durable planning evidence, but they do not produce an implementation Plan. Lead synthesis must use that evidence without inheriting transcripts, and model output must not become an approved repository Plan merely because it is well formed. Criticism and synthesis also need independent model routes, fresh Sessions, exact provenance, and restart-safe retry behavior.

## Decision

`orchestrator draft <planning-id>` revalidates the clean source snapshot, questionnaire, Decisions, and frozen Architecture and Quant Reports before doing new model work. It first launches a fresh read-only Session in the `critic` Seat using the `reviewer` Role and default review route. The critic receives both specialist Reports but no transcripts or Lead output and returns a structured verdict, findings, evidence, and corrections.

After the critique is stored as an immutable Report, the host launches a fresh read-only Lead Session through the `lead` Role and plan route. Its Brief contains only durable planning inputs, the frozen critique, exact source identity, and the configured Role and Check catalog. The Lead returns structured Plan metadata, markdown, Tasks, critic resolutions, and source anchors.

The host, not the model, validates the required Plan sections, revision, dependency graph, Roles, Checks, scopes, acceptance criteria, Review Lenses, critic resolutions, and source anchors. Every generated Task requires Spec, Architecture, and Quality Reviews, plus Quant when the frozen Quant Report declares material applicability.

Critique and synthesis have separate monotonic attempts and immutable request, Brief, response, turn, Sandbox, Report, and record evidence. A stored output can be adopted after interrupted state publication. Otherwise a failed stage advances to a fresh Session without rerunning a completed upstream stage.

The validated files are staged under the host-only planning directory as `draft/<plan-id>/plan.md` and `draft/<plan-id>/tasks.yaml`, with a sibling self-digested manifest. They are not written into the Project, approved, committed, or used to create a Run.

## Consequences

Planning can now survive the loss of every Pi Session and still produce a repository-valid Plan without using a transcript as memory. A human retains the consequential boundary: they must review and deliberately place or revise the draft in `docs/plans/` before the existing validation and approval flow applies.

The host state machine gains `criticizing`, `criticized`, `synthesizing`, and `drafted` states. Existing version-one planning files remain readable through empty progress defaults. General consultation, automatic Plan publication, cmux projection for planning Sessions, and the real Stepout proving run remain later work.
