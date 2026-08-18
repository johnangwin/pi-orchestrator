# ADR 0004: Stage Session snapshots in derived images

## Status

Accepted

## Context

OpenShell file upload executes under the active Sandbox filesystem policy. It therefore cannot populate `/workspace/input` or `/workspace/project` after a Sandbox starts with the `read` profile.

A temporary writable bootstrap policy is not a safe workaround. OpenShell 0.0.106 rejects a live policy update that removes a `read_write` path, so a Sandbox cannot be tightened from bootstrap access to the final read-only boundary.

Mounting or copying from the host checkout would violate the source and Git authority boundary.

## Decision

The host creates a deterministic archive from selected files at an exact Git commit. Untracked files and host Git metadata never enter the archive. The manifest binds the commit, selected paths, tree entries, archive digest, and source digest.

For each Session, the host creates a temporary Docker build context containing only:

- the pinned Pi image definition and client files;
- the source archive;
- the source manifest;
- the Session identity and Link configuration.

The derived image expands the archive into `/workspace/project` and copies inputs into `/workspace/input`. OpenShell then creates the Sandbox directly under the final `read` policy. No model-driven process runs before that policy is active.

The temporary build context is deleted after Sandbox creation. Docker image layers are trusted host runtime data and remain outside every Sandbox. The Link token is routing protection, not authority; the host still validates every event and state transition.

## Consequences

Image construction adds startup work, although the pinned runtime layers are cacheable and only the Session input layers vary.

The same mechanism can initialize future write and Check Sandboxes without granting a model access to host files. A future OpenShell primitive that atomically loads files before applying the final policy may replace derived images without changing Snapshot or Session contracts.
