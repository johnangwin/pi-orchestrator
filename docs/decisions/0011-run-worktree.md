# ADR 0011: Project approved Runs into isolated Git worktrees

## Status

Superseded by [ADR 0026](0026-direct-workspace-projection.md)

## Context

Implementation needs a host-owned source location where verified patches can accumulate without modifying the human's trusted checkout. That location must remain recoverable after interruption, and retry must not adopt an unrelated branch or directory merely because its name looks plausible.

Git mutation and filesystem state publication cannot be one atomic operation. The durable Run identity must therefore make every intermediate state distinguishable and safe to retry.

## Decision

An approved Run owns one reserved branch and one linked Git worktree:

```text
branch     <git.branch_prefix><run-id>
path       <worktrees.root>/<project-id>/<run-id>
base       exact approved commit
```

The consumer Project must currently be the Git top-level. Machine-local `worktrees.root` supports `~` expansion without invoking a shell. The canonical Run worktree must be outside the trusted Project checkout, and validation occurs before any target directory is created.

Start follows this order:

1. load and validate the current Plan;
2. require approval freshness against the current full commit ID;
3. validate the reserved branch and canonical worktree path;
4. observe Git for collisions without mutation;
5. atomically write the Run intent, then register its Project summary;
6. create or recover the linked worktree;
7. independently verify the repository, branch, `HEAD`, and clean status.

The Run file is written before its Project summary. A crash between those writes leaves an orphan Run file that the same request can register. The reverse state, a summary with no Run file, blocks because reconstructing lost workflow state would be unsafe.

The adapter reads `git worktree list --porcelain -z` and invokes Git with argument arrays. Project hooks are disabled for worktree creation. Retry accepts only:

- an exact registered worktree at the intended path, branch, base, and common Git directory; or
- the exact reserved branch at the intended base when worktree registration has not completed.

Dirty content, path collisions, branch collisions, detached state, missing registered paths, wrong commits, and repository mismatches block. The Orchestrator does not reset, clean, stash, delete, or otherwise repair those states automatically.

## Consequences

The trusted checkout remains unchanged while a Run gains an isolated host branch for accepted patches and human commits. Worktree creation can be retried after state publication, branch creation, registration, or lost command output without relying on terminal history.

The linked worktree is trusted host state and contains a `.git` link. It must never be supplied directly to a model-driven process. Later Task Sandboxes receive Git-free snapshots, and accepted patches return through the verified Artifact boundary.

Nested consumer Projects inside a larger Git worktree are not supported yet. Supporting them requires explicit repository-relative Project prefixes in snapshots, scope validation, and patch import rather than an implicit path adjustment.
