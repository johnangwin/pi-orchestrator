# ADR 0020: Derive required Review completion from per-Lens Gates

## Status

Accepted

## Context

The authoritative Review boundary executes and recovers one Lens correctly, while a Task may require Spec, Architecture, Quality, and Quant Reviews. Calling that primitive manually does not define deterministic ordering, fail-fast behavior, complete client configuration, or restart behavior for the required set. Persisting a second aggregate record would duplicate the approved Task and its Lens Gates as workflow truth.

## Decision

`runRequiredReviews` reads the unique required Lens list from the approved Plan and executes it in declared order. The caller must provide an OpenShell client for every required Lens before any Review Session starts. `orchestrator review <task>` resolves those clients from the current Reviewer Role and Lens-specific model routes.

Each Lens uses the existing `runReview` authority boundary. It receives a fresh Seat epoch, Session, Sandbox, focused Brief, Message, immutable intent, Report, record, and Gate. The Brief states the normative Lens question, and Quant also receives the Project's Quant Skill. Review Message identifiers include the Lens as well as the nonce. Later Briefs contain no earlier Review result or finding.

A passing result is frozen before the next Lens starts. `rework` and `blocked` halt the set immediately. Execution failures remain errors. Retry revalidates and reuses exact passing evidence, adopts an interrupted completed result, and gives only the incomplete Lens a replacement Session epoch within the same Review round.

The coordinator persists no aggregate artifact. It derives `pass`, `rework`, or `blocked` from the approved Task and the results produced during the invocation; the per-Lens Gates remain authoritative. A complete pass leaves the Task in `reviewing`, where only the existing human Commit Gate can accept it.

## Consequences

All required Lenses can now be run through one host operation without reviewer cross-contamination or duplicate state. Sequential execution is chosen for deterministic single-writer mutation; parallel read-only Review execution remains a possible later optimization behind the same per-Lens contracts.

This completes the Review-Lens implementation item but does not prove it against Stepout. Context-pressure Handoff, full operator-driven Task execution, metrics, and the Stepout retrospective remain later work.
