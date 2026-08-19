# ADR 0013: Apply verified patches through a durable scope gate

## Status

Superseded by [ADR 0027](0027-workspace-mutation.md)

## Context

A verified Patch Artifact is evidence that one Sandbox result can be replayed against its assigned source. It is not authorization to change the host Run worktree. Before mutation, the host must still prove that every changed path is allowed by the approved Task, no protected path is affected, the Artifact came from the current implementation Session, and the worktree is the exact clean Task input.

Patch application crosses durable state and Git. A crash may occur before Git, after Git, or before the resulting state write. Recovery must distinguish those cases without resetting or repairing unexpected host content.

## Decision

Task scope and Project protection use bounded POSIX glob patterns. Patterns are relative, case-sensitive, include dotfiles, and reject negation, brace expansion, extglobs, backslashes, empty segments, and traversal. A pattern ending in `/**` also protects or scopes the subtree root itself. Protected patterns are evaluated before Task scope, so Task scope cannot authorize a protected path.

The host accepts a Patch for application only when:

- the current Plan digest and human approval still match the Run;
- the Task is active and has an available implementation attempt;
- the source snapshot commit equals the Task input commit;
- the Artifact Run, Task, Seat, Session, epoch, Role, and Sandbox match durable state;
- every changed path is in Task scope and no changed path is protected;
- no other implementation Task is active;
- the linked worktree belongs to the Project repository, uses the recorded branch and exact input `HEAD`, and is clean.

The host records a `prepared` Patch application before invoking Git. This record binds Artifact content and provenance, source commit and selected snapshot paths, source and result digests, the Sandbox diff digest, the exact changed paths, and the consumed implementation attempt.

Git then checks and applies the already verified binary-capable patch to the isolated Run worktree. Host Git runs without system or global configuration. The host reads NUL-delimited status, requires the exact declared path set, hashes actual file or symlink results without following path symlinks, reconstructs the result tree digest, and records a separate domain-separated host diff digest. Only then does the Task become `checking` and the application become `applied`.

## Recovery

An exact `prepared` operation is retryable. Its source commit and selected paths recreate the source snapshot, and the immutable stored Artifact is revalidated before reuse. The worktree may be either clean or already equal to the verified result. An exact existing result completes the state write without incrementing the attempt again.

An application recorded as `applied` must still match the current worktree on inspection. Any additional path, missing result, content or mode difference, branch change, `HEAD` change, repository mismatch, or conflicting Patch blocks. The Orchestrator never resets, cleans, stashes, or otherwise repairs the worktree.

## Consequences

The trusted checkout remains unchanged. The Run worktree contains the first authoritative uncommitted Task result, bound to both Sandbox and independently observed host digests. A host restart can recover the operation from Run state, Git state, and the stored Artifact without a Session transcript or live Sandbox.

This decision permits one complete Patch per Task attempt. Correction attempts, authoritative Check Sandboxes, Reviews, and human commit remain later gates.
