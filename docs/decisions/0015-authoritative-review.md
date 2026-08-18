# ADR 0015: Bind independent Reviews to frozen evidence

## Status

Accepted

## Context

A Review is model judgment, not deterministic verification. It may satisfy a Gate only when the host controls the evidence, runs the Reviewer in a fresh isolation boundary, validates a narrow output contract, and binds the result to every input that can make the conclusion stale. Reviewers must not inherit an Implementer transcript or another Reviewer's findings.

The Reviewer must inspect the exact patched source accepted by the host and evaluated by authoritative Checks. A base-commit snapshot alone is insufficient, and a writable host checkout would cross the authority boundary.

## Decision

The host reuses the verified complete-source package reconstructed from the Task input commit and immutable Patch Artifact. A read-only Pi Session may now start from that package as well as from a Git snapshot. The launcher verifies the package before and after copying it into the private image context, expands it only into `/workspace/project`, and records its semantic source digest in immutable Session configuration. A reconstructed package cannot initialize a write Session.

Each required Lens receives a stable Seat and a fresh Session epoch in a fresh OpenShell Sandbox. The host selects the Lens route, including the configured Quant override, and requires an exact version-matched gateway. The compiled Brief contains the approved Task and Plan, accepted Decisions supplied by the host, selected Reviewer Skills, a digest-bound pointer to the immutable current diff, changed-path anchors, exact passing Check records, and all relevant digests. The diff is staged read-only at `/workspace/input/review.patch` so a large patch does not consume the initial context budget. Dependency and implementation transcripts are absent, and one Review's result is never supplied to another Reviewer.

Before the model runs, the host publishes an immutable Review intent and a pending Gate. The intent binds Run, Task, Lens, Review round, Plan, input commit, Task source, reconstructed source, diff, passing Check records, Role, Brief, model route, Session and Sandbox identities, policy, Pi and client versions, and the durable request Message. The request is stored in the host Mailbox.

The Pi response must be one bounded structured object with a `pass`, `rework`, or `blocked` verdict. A passing response cannot contain blocking findings. Every non-passing response must identify each blocking finding's location, failure scenario, evidence, and required correction. The host rejects truncated, malformed, contradictory, Message-mismatched, or model-mismatched output.

After the response, the host revalidates approval, Project and Plan bytes, the exact Run worktree, every Check Gate and record, the Reviewer Role and policy, and the current Session epoch. Only then does it render and atomically publish an immutable Markdown Report plus a self-digested Review record. Stored intents, records, and Reports are revalidated on every read.

A `pass` records a passing Lens Gate and leaves the Task in `reviewing` until human commit. `rework` records a failed Gate and moves the Task to `rework`; `blocked` records a failed Gate and moves it to `blocked`. Review rounds increment once for a set of Lenses over one diff, not once per Lens or infrastructure retry.

## Recovery

Invalid output or infrastructure failure publishes no result, expires the Session-bound request, stops the fresh Sandbox, and marks the Session failed. Its immutable intent remains for audit. A retry uses a replacement Session and epoch in the same Lens Seat; it may replace only pending evidence and cannot overwrite a completed Gate.

If a result was published but Gate advancement was interrupted, an exact retry finds it through the pending intent digest, revalidates every current binding, removes any still-active Sandbox bound to that Review, records the Session stopped, and completes the Gate without another model call. A completed Gate similarly reuses only its exact immutable Review. Missing or tampered intent, record, Report, Check evidence, source, policy, Role, or model routing fails closed.

## Consequences

Fresh model judgment is now independent of implementation conversation and durable without a live Pi process. The same complete source evaluated by Checks is visible read-only to the Reviewer, while host Git metadata, state, credentials, prior findings, and transcripts remain absent.

Human commit remains the final Gate in the one-Task vertical slice.
