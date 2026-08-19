# ADR 0008: Treat cmux as a recoverable host projection

## Status

Superseded by [ADR 0024](0024-pi-first-supervisor.md)

## Context

cmux provides the visible cockpit for a Run, but it does not own workflow state. Workspace indexes and human-readable titles are convenient for interaction but are not durable identities. A missing pane must not imply that a Task completed, and retrying a partially observed creation must not silently create duplicate agent processes.

The cmux control socket is deliberately available only to processes started inside cmux. Its socket password is host runtime authority and must not enter Project configuration, logs, Sandboxes, or model context.

## Decision

The host adapter uses the pinned cmux 0.64.22 CLI with JSON output and UUID-only identifiers. Preflight verifies the exact CLI version and every control method the adapter relies on.

A Run Workspace binding records:

- the stable creation operation UUID;
- the cmux Workspace UUID;
- the expected title.

A Seat Pane binding records:

- the stable creation operation UUID;
- the Workspace, Pane, and Surface UUIDs;
- the expected title.

Workspace creation passes the stable operation UUID to `workspace.create`, which gives retries cmux-native idempotency. Pane creation has no equivalent native operation key. Before the first Pane mutation, the caller must durably record a creation intent containing the operation UUID and the prior Pane UUIDs. A retry adopts exactly one Pane added after that intent, validates that it has one Surface, and applies the expected title. Multiple candidates fail as ambiguous.

Once a durable binding exists, a missing Workspace, Pane, or Surface is reported as drift. The adapter does not create a replacement implicitly. Closing a Pane is allowed only while it still contains exactly its bound Surface.

Reconciliation is read-only. It reports presence, title drift, missing Panes, missing Surfaces, and missing Workspaces; it never changes Run or Task state.

All CLI calls use argument arrays rather than a host shell. A trusted command intended for a new terminal is separately quoted as POSIX shell data because cmux itself supplies that text to the terminal shell.

## Consequences

The Orchestrator must start from a cmux-created control terminal so the inherited socket capability is valid. The Run lifecycle persists creation operations, intents, and returned bindings in authoritative state before relying on retry behavior. Pane records are bound to the exact Session epoch and must be retired before replacement advances that epoch.

cmux panes can be recreated or reattached without changing the Session authority model. Terminal scrollback, pane presence, and titles remain operational signals rather than workflow facts.
