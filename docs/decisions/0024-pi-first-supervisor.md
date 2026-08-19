# ADR 0024: Operate Runs through Pi and a trusted Supervisor

## Status

Accepted

## Context

Version 0.2 exposes orchestration as a sequence of host CLI phase commands and calls a durable team position a Seat. That interface is useful for testing individual authority boundaries, but it makes the user leave Pi to direct the work and gives the terminal layout too much conceptual weight.

The normal workflow should remain inside Pi and cmux without making either Pi, a model, or a pane authoritative. Session replacement must still preserve a stable address and reject stale process events.

## Decision

The host runs one trusted Supervisor as the sole writer of Project and Run state. Invoking `orchestrator` from a cmux-created terminal starts or reconnects that Supervisor, creates or reconciles the cmux workspace, starts or resumes the Lead Agent inside OpenShell, and focuses the Lead pane. The Supervisor has no permanent pane.

Version 0.3 uses these identities:

- an Agent is a stable address in one Run with a Role, selected Model Profile, Mailbox, and current Session;
- a Session is one disposable Pi conversation and Sandbox generation belonging to an Agent;
- a Team is the human-facing projection of the Run's Agent roster, not another authority object.

Session generations begin at one and remain contiguous. Every Message, event, Report, Handoff, Sandbox binding, and cmux binding carries the complete Run, Agent, Session, and generation identity. A replacement advances exactly one generation and makes its predecessor terminal before the successor can act. Old-generation input is rejected.

The Lead Pi extension exposes the `/orchestrator` namespace for normal status, planning, Agent, Task, Message, Handoff, Review, approval, and commit requests. These are typed requests to the Supervisor. Model-facing tools remain smaller and cannot approve, commit, mutate host state, create Sandboxes, or control cmux.

The default cmux layout places the Lead on the left and active Agent panes in a right-hand stack. Pane bindings use cmux UUIDs; titles are labels only. Closing or losing a pane never changes Task state. Human approval uses a transient trusted host pane whose input is not routed through Pi.

Low-level CLI commands remain retriable diagnostic, automation, and test boundaries. They are not the primary getting-started workflow.

## Consequences

Run state schema version 2 replaces Seat with Agent and epoch with generation. Unfinished version-one Runs are rejected with an explicit diagnostic rather than migrated implicitly.

The Supervisor can rebuild the visible Team from durable state after every Pi Session and pane is terminated. No transcript or terminal scrollback becomes a recovery dependency.

This decision supersedes ADR 0007 and ADR 0008. It preserves ADR 0010's reconciliation rules, ADR 0009's durable Mailbox, ADR 0021's transcript-free Handoff, and ADR 0022's metrics principles under the new terminology.
