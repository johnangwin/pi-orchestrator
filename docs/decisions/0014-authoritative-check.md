# ADR 0014: Run authoritative Checks in disposable no-inference Sandboxes

## Status

Superseded by [ADR 0028](0028-candidate-gates.md)

## Context

An Implementer may run commands for feedback, but those results come from an untrusted model-driven environment. A Check can satisfy a Gate only when the host selects the registered command, reconstructs the exact applied source, runs it without model access in a fresh isolation boundary, and binds the result to every input that can affect it.

Check execution also crosses several retriable boundaries. The host may stop after recording intent, during Sandbox creation, after the command, after Sandbox deletion, after publishing evidence, or before updating Run state. Recovery cannot rely on a live process or terminal output.

## Decision

The host reconstructs a complete Check source package from the Task input commit and its immutable verified Patch Artifact. The package contains no Git metadata and has a manifest binding the Task source digest, host diff digest, complete path/content/mode tree, archive bytes, and a separate domain-specific source digest. The host verifies the package after construction; a trusted helper in the Check image repeats archive, manifest, and complete-tree verification before any registered command runs.

A durable Check intent is published before Sandbox mutation. Its deterministic job and Sandbox names bind Run, Task, Check ID, Plan, input commit, Task and complete-source digests, diff, exact argv, relative working directory, timeout, Check image, and policy. A random durable token identifies Sandboxes created for that exact job. Host-set OpenShell labels carry the job ID and a 128-bit token fingerprint, while an in-Sandbox marker carries the complete identity. An unrelated name collision blocks.

The runner requires an exact matching OpenShell CLI/gateway version and requires the selected gateway/workspace to have no inference route. It accepts only an OCI digest reference or a canonical local image context whose complete tree digest is verified and copied into private staging. The validated policy bytes are staged the same way, preventing a path mutation from changing either input after its digest is recorded. It creates a fresh Sandbox under that exact `check` policy and a separate pinned image that contains no Pi runtime. Source enters by OpenShell upload. The registered argv executes directly in `/workspace/project` or its validated relative working directory, without a host shell.

The Sandbox must be deleted before command output can become authoritative evidence. The host then rechecks the Run worktree, current Plan bytes, registered Check definition, and approval. It atomically publishes immutable stdout, stderr, and a self-digested record bound to the intent, source, diff, Plan, image, policy, Sandbox, OpenShell versions, timestamps, and exit status. A zero exit records `pass`; any other observed command exit records `fail`.

The Task Gate first records the intent as `pending`. Published evidence atomically changes it to `pass` or `fail`. A failure moves the Task to `rework`; a pass leaves it `checking` until every required Check passes, then moves it to `reviewing`. Model prose cannot affect this transition.

## Recovery

An exact retry loads the immutable intent and result. A completed result is revalidated against its logs and intent, then can finish an interrupted Gate state update without launching OpenShell. Without a result, retry verifies and removes only an exact abandoned Sandbox and runs a new disposable job instance under the same durable intent. A Ready Sandbox must match both trusted control-plane labels and its internal marker. A Sandbox that failed before the marker could be written may be removed only when its labels match the durable job and token fingerprint.

Infrastructure failure, cleanup failure, source rejection, Plan drift, approval drift, or worktree drift publishes no result. The pending intent remains durable for diagnosis and retry. Unexpected host source is never reset, cleaned, stashed, or repaired.

## Consequences

The first deterministic Gate after implementation is now authoritative and resumable without a Pi transcript or live Sandbox. Check evidence is inspectable under the Run state directory and cannot be reused for another source, diff, Plan, command, image, policy, or timeout.

Project-specific Check images may extend the pinned baseline with required toolchains. Fresh independent Reviews and human commit remain later gates.
