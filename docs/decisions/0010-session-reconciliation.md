# ADR 0010: Reconcile Sessions from durable identity

## Status

Accepted

## Context

A visible Pi Session spans five independently failing components: authoritative Seat and Session state, an OpenShell Sandbox, a host Link, a logical Mailbox, and a cmux projection. Process memory cannot prove which Sandbox or Pane belongs to the current epoch after a host restart. A missing pane also cannot prove that agent work completed.

Recovery and replacement must remain safe across failures between every external mutation. In particular, the host must not execute inside or delete a Sandbox merely because its name matches a prior record, and a replacement must not accept new Messages for an epoch that is already being retired.

## Decision

Run state durably stores cmux Workspace and Pane operations, creation intents, returned UUID bindings, and the exact Session identity for each Pane. The operation or intent is recorded before cmux mutation; the returned binding is recorded afterward. Reattachment requires observation that the old Pane or Surface is absent and a new stable operation UUID.

Every newly created read Session stores its source and policy digests in immutable Sandbox configuration. Same-Session recovery verifies:

- the current Run, Seat, Session, and epoch;
- the Sandbox UUID, name, workspace, and ready phase;
- the pinned OpenShell, Pi, and client versions;
- the current read-policy digest;
- the expected model route and Brief digest for a model-routed Session.

Only then does the host create a new loopback forward, authenticate a Link, attach it to the Mailbox, and redeliver pending Messages. Releasing a host Link does not delete its Sandbox.

The lifecycle reconciler reports a deterministic action from durable and observed state: `start`, `reconnect`, `reattach`, `replace`, `blocked`, or `none`. Inspection is read-only and cannot complete a Task or Session.

Session replacement follows this order:

1. validate the replacement identity, Session ID, reason, and Sandbox provenance;
2. detach the old Link;
3. mark the old Session terminal, closing it to new Message delivery;
4. delete the exact Sandbox, if it still exists;
5. safely remove its cmux Pane projection;
6. supersede pending Messages bound to the old exact identity;
7. create the replacement Session and increment the Seat epoch.

Each step is idempotent. The next epoch becomes current only after cleanup succeeds. Retrying the completed replacement with the same inputs returns the existing Session. A name collision with different Sandbox provenance blocks before any state change.

## Consequences

The host can recover a surviving Pi process or replace a failed one without a transcript, terminal scrollback, or in-memory token file. A crash during teardown leaves an old terminal Session and durable external bindings that the same replacement operation can finish.

Pending Messages never cross an epoch implicitly. Queued Messages remain historical delivery evidence. A missing entire cmux Workspace remains a blocked projection recovery decision, but stale Pane state can be retired without attempting to close an absent Workspace.
