# ADR 0021: Replace context through durable Handoff evidence

## Status

Accepted

## Context

A Session is disposable, but replacing it safely spans durable state, a live Link, an OpenShell Sandbox, a cmux projection, and context that must survive without carrying the predecessor transcript. The existing reconciler can retire an epoch and allocate its successor, but it deliberately leaves the new Session unbound and `starting`. There was no durable proof of what the successor should receive, no context-pressure contract, and no retry path across the gap between epoch replacement and Sandbox launch.

A terminated Session adds another constraint: it may be unable to produce new prose. Recovery must therefore accept a checkpoint reconstructed from already durable Reports, source and patch state, and explicit operator knowledge, while preserving the original failure reason.

## Decision

The Project context thresholds are copied into immutable Pi Session configuration. After assistant turns, the client reports Pi's current context estimate and emits one Handoff request when usage crosses the configured Handoff boundary. It also accepts `/orchestrate handoff [reason]`. The host treats both as requests, validates their exact Session identity, and recomputes the pressure classification from the current Project policy.

A Handoff uses a structured checkpoint with completed work, current state, blockers, next action, source anchors, the exact source identity, and optional Task and patch identities. The host renders that checkpoint into a required-section Handoff Report. It compiles a fresh Brief for the successor from authoritative inputs plus the Report; the Brief binds the successor identity, incremented epoch, and a digest of the Handoff context. No API accepts a transcript as Handoff input.

Before teardown, the host atomically publishes an immutable intent and Brief in a deterministic Handoff operation directory. The intent binds both Session identities, trigger, reason, pressure, checkpoint, Report, Brief, launch profile, source, policy, model route, context thresholds, and Pi/client versions. It then invokes the existing ordered reconciler replacement and starts or recovers the exact successor. An immutable result is written only after the replacement Link is attached, the Sandbox is durably bound, and the Session is active.

Retry behavior is derived from durable state:

1. If the predecessor remains current, continue its ordered replacement.
2. If the successor is current and unbound, launch it with the frozen Brief.
3. If the successor has a durable Sandbox, verify immutable configuration and reconnect it.
4. If the exact result exists, reuse it.
5. If the successor was later lost, begin a new recovery Handoff from that epoch.

Already terminal predecessors skip the `stopped` transition. Their failure or stop reason remains historical truth; the successor's `replaces.reason` records why recovery advanced the Seat.

## Consequences

Host interruption after retiring an epoch no longer strands the Seat. A failed Pi process can be replaced from durable facts, and every replacement Brief is independently inspectable without terminal scrollback or predecessor conversation. Client pressure remains advisory: only the host can perform the Handoff or decide whether a mutating phase may begin.

This implements the Handoff and terminated-Session recovery substrate. Exercising it during the Stepout proving run, including a real context-heavy Session and an intentionally terminated process, remains required before the milestone is considered proven in production use.
