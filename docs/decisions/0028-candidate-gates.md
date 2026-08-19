# ADR 0028: Bind Checks, Reviews, and commits to one Candidate

## Status

Accepted

## Context

Version 0.2 reconstructs source packages from a base snapshot and Patch Artifact for every authoritative Check and Review. Direct Workspace projection removes those transport objects, but deterministic verification, fresh independent judgment, stale-evidence rejection, and exact human commit remain required.

All three Gates must evaluate the same immutable source state, even though the Run Workspace is a live filesystem.

## Decision

The Supervisor freezes one Candidate only while the Workspace is stable, no Write Lease exists, and no writable Sandbox remains. It verifies the complete Workspace manifest and host diff before and after every operation that may satisfy a Gate. Any change makes all prior Candidate-bound evidence stale.

Each authoritative Check runs registered argv in a fresh OpenShell Check Sandbox with the Candidate mounted read-only and private writable build scratch. The Sandbox contains no Pi runtime, inference route, Project credentials, host Git metadata, or general network. The host records command, working directory, output, exit status, timing, image, policy, mount table, Plan, Task, Candidate, Workspace, and diff digests. Only a current passing record satisfies its Check Gate.

Each Review Focus runs in a fresh read-only Sandbox and fresh Pi Session. Its Brief contains the approved Plan and Task, applicable Decisions and Skills, current Candidate, changed-path anchors, and exact passing Check evidence. It excludes the Implementer transcript, hidden reasoning, and other Review findings until its own result is frozen. The host validates the structured `pass`, `rework`, or `blocked` result and binds its Report to the exact Candidate, Session route, permission ceiling, image, policy, and mount table.

After all required Checks and Reviews pass, the Supervisor creates an exact Commit proposal. A transient trusted host pane displays the Plan, Task, branch, Candidate and diff digests, changed paths, Check records, Review records, one-line subject, and Git identity. Human confirmation publishes an immutable intent before Git mutation.

The hardened host Git adapter stages only Candidate paths, verifies every staged blob and mode against the Candidate, creates a one-parent commit without hooks, signing, prompts, ambient configuration, filters, or shell evaluation, and advances the Run branch through compare-and-swap. A matching commit without a prior durable human intent is never adopted.

## Consequences

Check, Review, and commit evidence no longer depends on a source archive or Patch Artifact. Fresh Sandboxes still isolate Project execution and model judgment from the trusted host.

Rework invalidates the Candidate and its Gates, resumes Workspace mutation under a new Write Lease, and requires fresh evidence. Attempt and Review-round limits remain bounded.

This decision supersedes ADR 0014, ADR 0015, and ADR 0016. ADR 0020's required independent Review set remains in force.
