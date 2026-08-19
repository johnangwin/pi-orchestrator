# ADR 0026: Project one shared Run Workspace directly into Sandboxes

## Status

Accepted

## Context

Version 0.2 copies a Git snapshot into every model Sandbox and returns implementation changes as a verified Patch Artifact. This isolates host Git, but it adds archive construction, extraction, replay, and copy-back boundaries. It also prevents one Agent from immediately observing another Agent's allowed changes.

The host already creates an isolated linked worktree for a Run. OpenShell can project that worktree directly when its local Docker driver is explicitly permitted to use constrained bind mounts.

## Decision

An approved Run owns one host branch and one linked Git worktree outside the primary checkout. That worktree is the Run Workspace and the single source tree shared by all Run Agents. Git materializes it once; the Orchestrator does not create per-Agent source copies or a normal archive, upload, extraction, patch export, replay, or import path.

Every model Sandbox receives the complete Workspace at `/workspace/project` as a read-only mount. The Supervisor may reopen only literal Task `write_paths` as nested read-write mounts for the one Agent holding the current Write Lease. Read-only Agents retain read-only projections and may observe allowed changes immediately.

Every projection masks the linked-worktree `.git` entry and the real common Git directory with opaque read-only mounts. Committed and machine-local restricted paths receive equivalent masks or are absent. The model cannot use Git metadata even when it can execute a Git binary. Host state, primary checkout, home, credentials, unrelated repositories, Docker socket, SSH agent, and unapproved network endpoints remain absent.

Direct host mounts are an opt-in operator capability on a dedicated local OpenShell gateway or driver. The Supervisor validates canonical source and destination roots, requests only the permitted mount shape, inspects the resulting mount table, and fails closed on a writable root, missing mask, unexpected mount, unsupported driver, remote gateway, or policy drift. The Pi image receives no OpenShell control credential.

Planning uses a separate clean detached worktree at the exact planning commit, projected read-only under the same masks. Planning Agents never inspect the human's primary checkout or its untracked content.

The Orchestrator enables this profile only after a live canary proves root read-only behavior, narrow nested writes, shared visibility, `.git` opacity, restricted-path masking, isolation, and cleanup on the exact pinned OpenShell, driver, image, and policy versions.

## Consequences

The Run Workspace contains untrusted content while a writer is active and an unaccepted Candidate afterward. The host may inspect, hash, stage, and commit it through hardened adapters, but it never executes Project code outside OpenShell.

OpenShell direct projection is a release proof gate. If the installed substrate cannot enforce the required mount shape, v0.3 implementation stops for design review; source archives are not retained as a silent runtime fallback.

This decision supersedes ADR 0004 and ADR 0011. ADR 0006 remains applicable to Reports, logs, and other non-source Artifacts.
