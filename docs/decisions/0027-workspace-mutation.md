# ADR 0027: Control Workspace mutation with Write Leases and Candidates

## Status

Accepted; Workspace storage amended by ADR 0030

## Context

A shared Workspace removes Patch transport but introduces concurrent visibility and attribution concerns. Files may be tracked, untracked, or ignored; a model may be interrupted during a write; and filesystem writes cannot be made atomic with durable host state. Task `scope` globs describe acceptable outcomes but are not precise enough to grant mount authority.

The host needs one retryable lifecycle that distinguishes authorized mutation, observed changes, and evidence frozen for Gates.

## Decision

Each implementation Task declares literal `write_paths` in addition to semantic `scope`. A path can be reopened read-write only when it is canonical, within the Workspace, outside protected and restricted paths, covered by Task scope, and free of unsafe symlink or hard-link behavior.

The Supervisor permits one active Write Lease per Run. Before creating a writable Sandbox it freezes a complete stable Workspace manifest, records the current Workspace generation and digest, and durably publishes a lease bound to the Plan, Task, Agent, Session generation, permission ceiling, route, policy, image, exact mount table, write roots, and baseline manifest.

The manifest walks the Workspace with `lstat` semantics and includes tracked, untracked, and ignored regular files, executable modes, symlink targets, entry types, sizes, and content digests. It excludes Git metadata only after independently validating the linked worktree. Enumeration is sorted and bounded. Special files, path escapes, unsafe links, multiply linked mutable files, or changing reads fail closed.

A Write Lease ends only after the Supervisor removes or proves the absence of the writable Sandbox and its mounts. It then observes a second complete manifest and records an immutable Change Set for the exact baseline and result. Every changed path must fit the literal write roots and semantic Task scope and must avoid protected and restricted paths. Unexpected changes block the Run; the Supervisor never resets, cleans, stashes, or discards them automatically.

An accepted Change Set advances the monotonic Workspace generation. Read-only Agents may inspect a mutating Workspace, but source-bound Reports, consultations, Checks, and Reviews must bind to a stable generation.

After the Task's implementation attempts are complete, the Supervisor freezes a Candidate containing the aggregate Task diff and exact Workspace manifest, generation, Plan, Task, input commit, host diff, Change Sets, permission and route evidence, and changed paths. Candidate freeze requires no writable Sandbox or active lease. The Workspace becomes read-only until that Candidate passes, enters rework, or is explicitly discarded by a human.

## Consequences

The committer does not need filesystem ownership to infer which model changed a file. Change attribution comes from the exclusive durable Write Lease and before-and-after manifests. A second model may later edit the same file under another Lease, producing another Change Set.

All boundary operations are idempotent and content-bound. Recovery removes or validates the writable Sandbox before treating source as stable. A dirty or unexplained Workspace blocks instead of being repaired automatically.

This decision supersedes ADR 0012 and ADR 0013.
