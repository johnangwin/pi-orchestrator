# ADR 0016: Bind human Task commits to exact reviewed evidence

## Status

Accepted

## Context

A Git commit is the final authoritative mutation in the one-Task vertical slice. Passing Checks and Reviews are insufficient unless the human sees the exact evidence being authorized, that authorization survives a host interruption, and Git cannot execute untrusted Project hooks or silently include unrelated content.

The operation must also be retryable across the dangerous boundary where Git has created a commit but the host has not yet published result evidence or advanced Run state.

## Decision

The host compiles a self-digested Commit proposal from the current approved Plan, Task transition, immutable Patch Artifact, host diff, required passing Check and Review records, branch, subject, and Git identity. It revalidates current Review model routing, Role, policy, runtime versions, Session epochs, scope, protected paths, and the exact Run worktree before presenting that proposal. A human confirms through the host TTY or explicit `--yes`; the model-facing surface cannot authorize it.

Before Git mutation, the host publishes an immutable intent containing the complete proposal, local approving user, confirmation time, and a domain-separated digest. The Task's `commit` Gate records that intent digest as pending. Any later source, evidence, subject, identity, or policy drift makes the authorization stale.

The Git adapter runs argument arrays under a scrubbed environment with system and global Git configuration, filesystem monitors, hooks, signing, prompts, rename inference, and shell evaluation disabled. It rejects clean filters across the exact source before archive, status, or staging can execute them. It verifies the canonical repository and linked Run worktree, current trusted-checkout HEAD, exact branch and parent, independently verified Patch result and host diff, stages only the approved paths, and checks every staged blob and mode against the Patch. It creates the object with `commit-tree` and advances the branch through compare-and-swap `update-ref` against the approved parent. The resulting one-parent commit must reproduce the approved tree, path/content/mode result, subject, author, and committer identity with a clean worktree.

The host then publishes an immutable self-digested Commit record and changes the Gate to pass. The Task becomes accepted, its commit becomes the next writable Task's input commit, satisfied dependencies become ready, and an all-terminal Run becomes complete. Project Run-summary status follows the authoritative Run file.

## Recovery

If intent publication succeeds before its pending Gate update, retry finds the unique exact proposal authorization and repairs the Gate without a second human confirmation. If an intent exists and Git already contains the exact approved commit, retry validates and adopts it. If the Commit record exists but Gate advancement was interrupted, retry validates the intent, record, Git state, and all current evidence before finishing state advancement. A commit without a preceding durable intent is never adopted, even if its content happens to match.

Unexpected branch, parent, identity, subject, tree, status, scope, evidence, or stored content blocks. The Orchestrator does not reset, clean, stash, amend, or repair the Run worktree.

## Consequences

The one-Task vertical slice now ends in a human-authorized, evidence-bound Git commit and remains resumable without any Pi Session or transcript. No model process receives host Git authority, and Project hooks cannot execute as part of the trusted commit operation.

Planning, correction Briefs, multi-Task execution policy, and the full Stepout proving Run remain later work.
