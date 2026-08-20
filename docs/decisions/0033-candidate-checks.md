# ADR 0033: Run authoritative Checks over frozen Candidates

## Status

Accepted

## Context

The v0.2 Check path reconstructed an applied implementation Patch in host staging, archived the resulting tree, uploaded it, and unpacked it into a writable Check Sandbox. Version 0.3 already keeps the complete implementation result in one persistent Run volume and freezes its exact manifest and Git diff as a Candidate. Reconstructing that source again would preserve copying, archive parsing, and a second source identity after they are no longer needed.

Build tools still need writable homes, caches, temporary files, and output directories. That requirement does not justify write access to Candidate source. Checks also require deterministic recovery if the host stops after intent or result publication.

## Decision

Every authoritative Check mounts the current frozen Candidate's Run volume read-only in one fresh, model-free Check Sandbox. Restricted paths retain their opaque read-only masks. All Implementers are required to use the configured shared Workspace gateway, which the Check runner scans for live Run writers before inspecting source. The host then inspects the complete Workspace manifest and raw Git diff before launch and again only after the Sandbox has been deleted. A live or unexplained writer blocks the Run; changed source stales the Candidate and every bound Gate.

Registered argv arrays execute directly without a host shell. A fixed private `/sandbox/check-scratch` tree supplies allowlisted environment locations for language homes, dependency caches, temporary files, bytecode, and build output. A Check that requires source mutation fails; the Orchestrator does not widen the mount.

The Check gateway is explicit, version-pinned, and must expose no inference route. The static Check image is pinned by OCI digest and contains no Pi runtime. The policy denies general network and credentials. The host validates the observed Linux mount table, deletes the Sandbox before publication, and binds immutable intent and result records to the Candidate, Workspace generation and volume, complete source and Git digests, Plan, argv, scratch, image, policy, OpenShell identity, and observed mounts.

Stable Candidate-bound intent IDs preserve exact result adoption after interruption. Any changed binding creates different evidence; stale prior evidence cannot satisfy a Gate.

## Consequences

Authoritative Checks no longer copy, archive, reconstruct, or write Project source. Build systems must honor the supplied scratch environment or be reconfigured through their registered command without changing source permissions.

The old Check source-package implementation remains temporarily as test support for unmigrated Review and commit fixtures. It is not reachable through the public Check command and will be removed with the remaining v0.2 source-transfer pipeline.

This decision supersedes ADR 0014 for active Check execution and the Check-specific migration note in ADR 0032.
