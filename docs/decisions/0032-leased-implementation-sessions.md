# ADR 0032: Run Implementers through leased Workspace projections

## Status

Accepted

## Context

The v0.2 implementation path copied source into a derived Sandbox image, accepted a Patch Artifact, replayed it in host staging, and applied it to a Run worktree. The shared named-volume design removes those transfer boundaries, but direct mutation is safe only when write authority, observed changes, and recovery are bound to durable evidence in the correct causal order.

The requested mount set is known before Sandbox creation. The actual Sandbox UUID and Linux mount table are not. A persisted writer may also outlive its host process, so recovery must not inspect mutable source while that writer still exists.

## Decision

Each Run uses one persistent labeled Docker volume. Read-only Agents receive non-owning read projections of its `project` subtree. An Implementer receives the same subtree read-only plus only the Task's validated literal `write_paths` as nested read-write mounts. Protected descendants and restricted masks remain read-only. Git metadata, host state, credentials, the Docker socket, and host checkouts remain absent.

Before OpenShell creates the writer Sandbox, the host:

1. verifies Task readiness, approval, permission ceiling, model route, gateway, policy, image, stable Workspace generation, and complete baseline manifest;
2. validates semantic scope and literal write roots;
3. compiles the exact volume mount set;
4. persists a `preparing` Write Lease bound to the requested mount-set digest and deterministic Sandbox identity.

After Sandbox creation, the host binds its UUID, workspace, projection, gateway, and observed mount-table digest to the Session and activates the lease. The immutable Pi configuration names the preparing lease, exact Workspace generation, volume, write roots, mount set, image, gateway, Role permissions, route, and Brief.

A model completion is only a request. The host begins lease revocation, terminates and deletes the writer Sandbox, and proves that no Run writer remains before reading source. It then uses pinned model-free helpers to compute a complete Workspace manifest and raw Git status without executing Project source, filters, hooks, builds, or tests. The host stores the implementation Report, releases the lease into an immutable Change Set, advances the Workspace generation once, freezes a Candidate, and emits an idempotent `workspace_changed` Message to current Agents.

Run-volume recovery validates only the durable volume capability before writer revocation. If a Write Lease remains, recovery deletes or proves the absence of its Sandbox before scanning content. A matching durable Report may complete release and Candidate freeze. Without one, the attributable delta is retained as a Change Set, the Session fails, and a fresh bounded attempt receives the Task and durable Reports rather than the predecessor transcript. Stable Task-and-attempt IDs make each boundary retryable.

## Consequences

Allowed writes become immediately visible to read-only Agents through the shared volume, while source-bound conclusions remain stale until the next stable generation. Filesystem ownership is not used for attribution; the exclusive lease and complete before-and-after manifests are authoritative.

The implementation command now returns a frozen Candidate and Change Set instead of a host-applied Patch. Checks, Reviews, and commits still use their retained v0.2 paths until their named migration phases replace them. The old implementation Patch code remains temporarily unreachable migration material and is removed with the rest of the v0.2 source-transfer pipeline in Phase 16.

This decision supersedes ADR 0012 and ADR 0013 for new implementation execution. Their records remain historical inputs for unfinished v0.2 cleanup.
