# ADR 0007: Persist Seats and contiguous Session history in Run state

## Status

Superseded by [ADR 0024](0024-pi-first-supervisor.md)

## Context

The Link already binds traffic to a Run, Seat, Session, and epoch, but that live identity is not authoritative after the host or Pi process exits. Recovery, durable Message routing, and Session replacement require the host to know which identity is current without consulting a transcript, terminal pane, or Sandbox-local file.

Replacement is also a retriable process boundary. A repeated replacement request must not consume another epoch, while two competing requests against one current Session must not both succeed.

## Decision

Version-one Run state contains two registries:

- a Seat registry holding stable Role and model assignment plus its current Session ID and epoch;
- a Session registry holding complete identity, status, OpenShell Sandbox provenance, timestamps, termination information, and predecessor information.

A dormant Seat has no Session and epoch zero. Session epochs begin at one and form a contiguous history. Replacement atomically terminates a nonterminal predecessor, records the reason, creates the replacement in `starting`, advances the Seat by one epoch, and changes its current Session pointer.

The caller supplies each stable Session ID. Repeating the same start or replacement is idempotent. A competing replacement must present the exact prior identity and is rejected as stale after another request wins. The Project store serializes in-process mutations in addition to retaining its cross-process advisory lease.

## Consequences

Current identity and Session history survive process restart and can be validated without replaying `events.jsonl`. Corrupt pointers, gaps, duplicate epochs, nonterminal predecessors, model mismatches, and cross-Run records fail schema validation. Sandbox UUID, name, and workspace are bound once so later Artifact and recovery operations can verify provenance.

Run state grows by one bounded record per Session. Large output remains in separate Artifact files. A later database-backed store may map the same Seat and Session contracts to tables without changing their public meaning.
