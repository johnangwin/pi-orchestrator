# ADR 0012: Import implementation patches through independent replay

## Status

Accepted

## Context

An Implementer needs a writable source tree without receiving the host Run worktree or its Git metadata. Its output is untrusted even when a trusted executable creates the transport format. Successful Artifact download, a plausible patch, or model prose cannot establish that the output came from the assigned source or produces the claimed result.

The next source-mutation gate, scope and protected-path validation, is not implemented yet. This increment therefore must validate and persist output without applying it to the authoritative Run worktree.

## Decision

A write-profile Session receives one already verified Git archive expanded twice while its derived image is built:

```text
/workspace/base       root-owned source under the read-only policy
/workspace/project    Sandbox-user source under the writable policy
/workspace/input      immutable Session, Brief, and snapshot identity
```

Both trees start from the exact same archive and contain no `.git`. The Sandbox starts directly under the final `write` policy. Its startup probe proves that base and input reject writes while project accepts and removes a write probe. Immutable Session configuration selects the Pi tool set: read Sessions receive only read-oriented tools; write Sessions additionally receive `write`, `edit`, and `bash`. A missing profile remains `read` so existing read Session recovery remains compatible.

The derived image keeps `/sandbox` as its OCI working directory because OpenShell 0.0.106 restricts file download to that tree. The Pi daemon explicitly starts its child in `/workspace/project`, so model tool paths and Artifact transfer do not depend on the same process working directory.

The pinned image installs `orchestrator-export-patch`. It requires immutable `write`-profile Session configuration, walks base and project without following symlinks, rejects Git metadata, non-UTF-8 paths, special files, unstable reads, excessive tree entries, and oversized patches, then invokes `git diff --no-index --binary --full-index --no-renames` with system and global Git configuration disabled. The resulting JSON Patch Artifact contains:

- the source snapshot digest;
- deterministic base and result tree digests;
- a sorted added, modified, and deleted file manifest;
- modes, sizes, and SHA-256 content digests for affected entries;
- a base64 binary-capable Git patch and its byte digest;
- a domain-separated diff digest binding all of the above.

The exporter writes only the canonical Artifact path and publishes through a same-directory temporary file plus hard link. Retrying an identical export returns the existing regular file; different content under the same ID fails.

The host imports the payload through the existing Artifact boundary. Its Patch contract then independently:

1. revalidates the host-created source archive and exact source digest;
2. extracts fresh base and project trees in disposable host staging;
3. recomputes the base tree digest;
4. checks and applies the patch without unsafe paths;
5. verifies that base remained unchanged;
6. recomputes the result tree, change manifest, and all digests;
7. publishes the Artifact only when every claim matches.

## Consequences

A Session cannot substitute a patch from another source, omit a changed file from its manifest, forge the claimed result, inject Git metadata, or rely on host Git configuration. Text, deletion, executable-mode, symlink, and binary changes use one bounded contract.

The imported Patch Artifact is evidence, not authorization. This increment does not apply it to the Run worktree or update Task output state. The next gate must validate every changed path against the approved Task scope and protected patterns before a trusted host importer may mutate the isolated Run worktree and independently record its resulting diff digest.
