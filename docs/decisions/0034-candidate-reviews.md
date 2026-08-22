# ADR 0034: Run fresh Reviews over frozen Candidates

## Status

Accepted

## Context

The v0.2 Review path reconstructed source from an implementation Patch, copied it into a source-derived image, and supplied `review.patch` beside that reconstructed tree. Version 0.3 already keeps the implementation result in one persistent Run volume and freezes its complete manifest and raw Git diff as a Candidate. Checks now evaluate that Candidate directly, so reconstructing a separate Review tree would give model judgment a different source identity from deterministic verification.

Reviews must remain independent model judgments. Each Focus needs a fresh Agent generation, Session, and Sandbox with no Implementer transcript or earlier Review finding. A model response becomes authoritative only while the Candidate, passing Checks, Project policy, Role permissions, model route, and live source projection remain exact.

## Decision

Every Review reopens the current frozen Candidate's durable Run-volume capability. Before launch, the host proves that no Run writer exists on the configured shared Workspace gateway, computes the complete manifest and Git diff with model-free helpers, and compares them with the Candidate. Any unexplained change blocks the Run and stales the Candidate and every Gate.

The Reviewer receives the Candidate through the standard read-only static-image Session projection. Restricted paths retain opaque read-only masks, the Project root and every source mount are read-only, and the observed Linux mount table is bound to the Session. The bounded `/workspace/input/candidate.json` input contains the Candidate identity, ordered Change Sets, changed-path metadata, and exact Workspace diff. The Brief uses changed-path anchors and Candidate, manifest, source, diff, and passing Check digests. It contains neither a Patch Artifact nor implementation or Review transcripts.

Only version-two passing Check records bound to the same Candidate, Workspace generation, volume, manifest, source, Git diff, and requested mount set may enter a Review. Each Focus independently resolves its Reviewer Role permission ceiling and selected Model Profile route. Pre-freeze action state denies Reviewer coordination even when the Role could coordinate after its result freezes.

A version-two Review intent and result bind the Candidate, read-only Workspace projection, Git diff, required Checks, Plan, Task, Role, permission ceiling, Brief, model route, policy, image, Agent and Session generation, Sandbox, OpenShell identity, observed mount table, request Message, Report, and timestamps. The host revalidates all mutable bindings and re-inspects the Candidate after the turn before publishing the result. Completed exact evidence is reusable; interrupted publication may adopt only the exact durable result associated with the pending intent.

A `rework` verdict moves the Task to rework. The same Candidate can only return its exact failed evidence; implementation must freeze a new Candidate, whose new identity and digests require fresh Check and Review evidence. A `blocked` verdict blocks the Task. Review-round limits apply once per Candidate review set, while infrastructure or invalid-output retries use fresh Session generations without consuming another round.

## Consequences

Checks and Reviews now inspect one frozen source identity without archives, derived source images, Patch export, or replay. Fresh Focus isolation, structured findings, immutable Reports, bounded retries, and transcript independence are preserved.

The legacy Review runner remains narrowly exported only for Phase 11 commit and summary test fixtures that still consume v0.2 evidence. It is not reachable from the public Review command and will be deleted with the remaining source-transfer pipeline.

This decision replaces the source-transfer mechanics of ADR 0015, completes the Review migration anticipated by ADR 0031, and supersedes the Review-specific migration note in ADR 0032.
