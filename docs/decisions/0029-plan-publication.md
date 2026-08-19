# ADR 0029: Publish and approve Plans through a trusted host surface

## Status

Accepted

## Context

Planning Agents can produce a validated Plan draft, but model output cannot authorize repository mutation or Plan approval. Version 0.2 leaves the draft in host state for a human to copy into the Project and then requires separate CLI operations. A Pi-first workflow needs a deliberate path that stays in cmux without treating text entered into a Pi conversation as human authority.

Plan publication also establishes the branch and exact source commit from which the Run will proceed.

## Decision

The Supervisor keeps validated planning output as immutable host Artifacts. To publish a Plan, it:

1. revalidates the planning commit, source, Decisions, consultation and criticism Reports, Plan files, Task graph, Roles, permissions, Model Profile policy, Checks, and all digests;
2. creates or recovers the reserved Run branch and isolated worktree from the exact planning commit;
3. writes only the validated `plan.md` and `tasks.yaml` bytes into that worktree;
4. opens a transient trusted cmux pane displaying the complete Plan, exact repository diff, proposed one-line commit, and proposal digest;
5. accepts explicit human confirmation directly in that pane;
6. publishes an immutable approval intent before using hardened host Git to create the exact Plan commit;
7. records Plan approval bound to the resulting commit and Plan digest;
8. adopts the same worktree as the Run Workspace.

One confirmation may authorize both Plan publication and approval only when the displayed Plan bytes, staged Git bytes, proposal, resulting commit, and approval inputs are identical. Any drift requires another confirmation. A Plan already committed by the human may enter at approval when the same exact validation succeeds.

The Lead or another model may request publication and render status, but cannot supply the trusted confirmation. A typed approval word in Pi is ordinary untrusted Message content. Material Plan revision, write-root expansion, permission expansion, inference-egress expansion, Gate waiver, destructive discard, and implementation commit use the same separation between model request and trusted human authorization.

## Consequences

The user can complete planning without copying files or leaving the cmux cockpit, while the model still has no Git or approval authority. The primary checkout remains unchanged.

Publication and approval are retriable across host interruption because their intent, exact bytes, Git state, and approval result are durable. Unexpected branch or worktree content blocks; it is never cleaned or adopted implicitly.

This decision supersedes only the manual Plan-copy consequence of ADR 0019. Its repository-aware planning, independent criticism, synthesis, and transcript-isolation decisions remain accepted.
