# Core Contracts

This document records implementation details that the v0.2 draft left implicit. They are versioned contracts, not serialization conveniences.

## Project identity

`.agents/orchestrator.yaml` contains a stable committed Project ID:

```yaml
version: 1

project:
  id: stepout
```

Runtime state is stored under `$ORCHESTRATOR_HOME/projects/<project-id>/`. A runtime Project ID is bound to one canonical host checkout path. A conflicting checkout cannot silently take over its state.

## Plan identity

`tasks.yaml` carries the Plan ID and revision explicitly:

```yaml
version: 1

plan:
  id: strategy-boundary
  revision: 1

tasks: []
```

The Plan directory name MUST equal `plan.id`. A material revision increments `plan.revision`.

## Plan digest

The Plan digest is SHA-256 with domain separation and length framing over the raw bytes of:

1. `plan.md`
2. `tasks.yaml`

The domain is `pi-orchestrator/plan/v1`. Names and contents are each prefixed by an unsigned 64-bit big-endian byte length. Therefore any byte change to either file invalidates approval, including comments or formatting.

## Approval

An approval records:

- Plan ID
- Plan revision
- Plan digest
- base commit
- approving local user
- timestamp

Approval freshness is computed against current authoritative inputs. Missing or stale approval prevents writable work.

## Task provenance

Each runtime Task has fields for:

- `input_commit`
- `input_source_digest`
- `output_source_digest`
- `diff_digest`

The Run remains bound to its originally approved base commit. After a Task is committed, its commit becomes the input commit of the next writable Task. Checks and Reviews will bind to the individual Task transition rather than the accumulated Run diff.

## Atomic state

Authoritative JSON replacement uses this sequence:

1. create a same-directory temporary file with exclusive creation;
2. write complete JSON;
3. flush the file;
4. run any schema-specific validation before calling the writer;
5. rename over the destination;
6. flush the parent directory.

A per-Project advisory lease prevents concurrent host writers. A future long-running host service will hold this lease while CLI clients communicate through its local control socket.

## Messages

One immutable JSON file represents one Message. Its containing directory is its delivery state:

```text
pending
queued
answered
expired
superseded
```

Lifecycle changes use same-filesystem rename. Retrying the same Message ID and content is idempotent. Reusing an ID for different content is rejected.

## Briefs

Brief compilation is deterministic. Required constraints are never silently truncated. Supporting Skill content that cannot fit the initial budget is replaced by an explicit omission naming its source path. Brief freshness binds Plan, Role, Task, Decisions, source digests, Session identity, and Seat epoch.

## Link transport

The host core depends only on the `LinkTransport` interface. The selected OpenShell implementation uses a host-loopback TCP service forward to a sandbox-loopback Pi client endpoint. The underlying OpenShell 0.0.106 transport has passed execution, file-transfer, network-denial, and loopback-forwarding probes. The Link protocol is not complete until it passes reconnection, isolation, bounded-frame, duplicate-ID, and stale-epoch tests.
