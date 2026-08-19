# ADR 0030: Store each Run Workspace in a Docker named volume

## Status

Accepted

## Context

ADR 0026 placed one host Git worktree directly into every Run Sandbox. OpenShell 0.0.106 accepted the required Docker bind mounts, but hard Landlock could not read Docker Desktop's `fakeowner` host-bind filesystem. OpenShell also documents host bind mounts as an unsafe capability that can weaken workspace isolation.

OpenShell supports ordinary Docker named volumes without enabling host bind mounts. A live proof on the supported macOS environment showed that hard Landlock, a read-only Project root, nested read-write Task roots, protected descendants, restricted file and directory masks, and simultaneous reader visibility compose correctly on that substrate.

## Decision

Each Run owns one plain, labeled Docker named volume. The trusted Supervisor creates and inspects it, rejects driver options and label mismatches, and records its identity and digest. Model Sandboxes receive no Docker socket or volume-management authority.

The volume contains a `project` subtree and Supervisor-owned control material outside that subtree. Git materializes the exact approved commit into `project` once through a pinned, model-free helper. There is no tar archive, per-Agent checkout, patch replay, or repeated synchronization.

Every Agent mounts only the `project` subpath at `/workspace/project`. The root is read-only. The current writer additionally receives literal Task paths from the same volume as nested read-write mounts, with protected descendants reopened read-only. Restricted files and directories are covered by read-only opaque subpaths stored outside `project`.

Git metadata is absent from `project`. Only a trusted, model-free Git helper may combine the Run volume with host Git authority for checkout, diff, and an approved commit. No model-driven process receives the host checkout, host Git metadata, a host bind mount, or the Docker socket.

The Supervisor inspects the actual Sandbox mount table and fails closed on a writable root, unexpected mount, missing restriction, non-local or bind-backed volume, unsupported driver, remote gateway, or policy drift. The volume remains durable for the Run and is removed only through an explicit completed or discarded Run lifecycle.

## Consequences

All Run Agents observe allowed changes immediately through one shared filesystem. The macOS host checkout is no longer the live Run Workspace, so Workspace manifests and Git operations execute through trusted helpers rather than direct host filesystem reads.

There is one initial Git checkout into the Run volume. This is the only normal source materialization boundary; source is not copied for each Agent or phase.

The Docker named volume is local to the selected gateway host. Remote gateways and non-Docker drivers require a separate accepted Workspace backend rather than silently changing semantics.

This decision supersedes ADR 0026 and the Workspace mechanics in ADR 0011. ADR 0006 remains applicable to Reports, logs, and other non-source Artifacts.
