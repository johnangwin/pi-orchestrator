# ADR 0009: Bind durable Messages before live delivery

## Status

Accepted

## Context

The filesystem Mailbox and Link acknowledgement protocol exist, but neither alone makes delivery authoritative. A host crash or Link failure can happen before send, after client injection, after acknowledgement, or during the lifecycle rename. Session replacement can also make a previously resolved target stale.

Recovery must distinguish durable workflow state from the Pi client's transient delivery memory. A Link acknowledgement means only that the current client accepted a Message for injection; it does not mean the requested work completed.

## Decision

The host owns one serialized Mailbox router per Run. A caller may address a new Message to a Seat, but the router resolves and records the exact current Session and epoch before writing the immutable Message to `pending`. A partially specified Session target is invalid.

Delivery follows this order:

1. validate the Run and current Seat identity;
2. persist the exact bound Message as `pending`;
3. verify that the attached Link has the same current identity;
4. deliver the stored Message;
5. accept only `queued` or `duplicate` for the same Message through the typed Link;
6. revalidate the authoritative current identity;
7. atomically move the Message from `pending` to `queued`.

Both acknowledgement values satisfy the queued transition. `duplicate` recovers the case where the client accepted a prior attempt but its acknowledgement did not reach the host. Neither value moves a Message to `answered`.

When delivery fails, the router removes the in-memory Link, marks the still-current Session `disconnected`, and leaves the Message `pending`. Attaching a Link for that same Session and epoch restores it to `active` and replays its pending Messages in deterministic order. Host operations are serialized because the current Link implementation permits one outstanding exchange.

A pending Message bound to an older epoch is not delivered to a replacement Session. Replacement orchestration explicitly supersedes pending Messages for the old exact identity before advancing the epoch; continuing the request requires a new Message with a new stable ID.

## Consequences

Host restart and acknowledgement loss are recoverable from Message files and Run state without a transcript or terminal buffer. A stale Link cannot advance a lifecycle file, and an old Message cannot leak into a new Session's context.

Attached Links remain process memory. The lifecycle reconciler reconstructs a same-Session Link from immutable Sandbox input after a host restart and explicitly supersedes old pending Messages during replacement.
