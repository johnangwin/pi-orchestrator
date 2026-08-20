# ADR 0031: Run read-only Sessions from static images and Workspace volumes

## Status

Accepted

## Context

Version 0.2 built a source-derived image for every read-only Pi Session. ADR 0030 instead places source in a Docker named volume with no Git metadata. Planning, consultation, criticism, and synthesis must use that substrate without giving model processes a host bind mount or making source archives a silent fallback.

## Decision

Read-only Sessions start from one machine-configured Pi image pinned by registry digest. The host mounts the trusted Workspace volume's `project` subpath read-only at `/workspace/project` and overlays every restricted file or directory with a read-only opaque volume subpath. It then inspects the live Linux mount table before Pi starts. A non-native mount, unexpected target, wrong subpath, or writable Project root fails closed.

The host uploads only `session.json`, the compiled Brief, and explicitly registered small inputs into `/workspace/input`. The Sandbox receives no host bind mount, state directory, checkout, Git metadata, source archive, or source-derived image. The immutable configuration binds source generation, complete manifest, named-volume capability, requested and observed mounts, static image, permission ceiling, Role, model route, and Brief. The host verifies the Brief's raw content digest after upload independently from its semantic Brief digest.

Pre-Run planning materializes the exact clean Git commit into a scoped source volume through the pinned model-free Workspace helper. All read-only Sessions in one planning stage share that volume. The complete source manifest, not a transcript or the ephemeral volume identity, remains the durable planning dependency.

Session records retain the volume name and digest, Workspace generation and manifest digest, mount-set and observed mount-table digests, image digest, and projection digest. After a host restart, recovery re-inspects the named volume, recompiles restrictions from current policy, verifies every durable digest and the complete volume contents, verifies the selected local Docker gateway, and rechecks the live mount table before reconnecting. Process memory is not recovery evidence.

## Consequences

Lead planning, Architecture and Quant consultations, independent criticism, and Lead synthesis no longer construct source archives or derived images. Existing authenticated Links, Messages, Reports, model routing, permission ceilings, and bounded retry semantics remain unchanged.

The v0.2 source-transfer path remains temporarily available only to phases that have not yet migrated; ADRs 0032 and 0033 have since moved implementation and Checks, leaving Reviews on the retained path. It is not a fallback for a failed shared-Workspace launch. A real static-image Session proof remains opt-in and version-bound to the configured OpenShell gateway, Docker driver, image, and policy.
