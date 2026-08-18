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

The host core depends only on the `LinkTransport` interface. The selected OpenShell implementation uses a host-loopback TCP service forward to a sandbox-loopback Pi client endpoint. The underlying OpenShell 0.0.106 transport has passed execution, file-transfer, network-denial, and loopback-forwarding probes.

Link records are strict LF-delimited JSON capped at 64 KiB. Every record carries the Run, Seat, Session, and epoch. A 256-bit per-Session token authenticates the initial handshake; it does not authorize workflow state changes. The client rejects stale identities and deduplicates stable Message IDs across host reconnections.

The initial protocol implements `hello`, `ready`, `ping`, `pong`, `deliver`, `ack`, `event`, and `error`. The host serializes exchanges until a later dispatcher provides correlation-safe concurrency.

## Source snapshots

A source snapshot is produced from an exact Git commit and literal relative paths. `git archive` excludes untracked files and `.git`; unsupported tree entries fail closed. Its manifest records the selected paths, tracked entries, archive byte count, archive SHA-256 digest, and a domain-separated source digest. The launcher revalidates the manifest and copied archive immediately before image construction.

Read-only Session inputs are added to a temporary derived-image build context. This is required because OpenShell upload honors the active Landlock policy and OpenShell 0.0.106 cannot revoke a writable path through a live policy update. The Sandbox starts directly with the final `read` profile, and the temporary context is deleted after creation.

## Session identity

A Seat has one current Session identity: Run, Seat, Session, and monotonic epoch. The Pi client reads that identity from immutable Session input, binds every Link frame to it, and rejects old epochs. Reconnection replaces the transport connection without replacing the Seat or Session identity.

## OpenShell lifecycle

The OpenShell adapter validates Sandbox names before launch, disables automatic credential providers, observes remote exit codes without treating expected denial as an infrastructure error, and parses `get` and `list` responses into versioned host types. Creation is followed by an authoritative `get`; JSON output is not requested from `sandbox create` because OpenShell 0.0.106 forbids combining it with an initial command.

Every programmatic `sandbox exec` closes the CLI child process's stdin immediately. OpenShell 0.0.106 buffers non-interactive stdin until EOF, so leaving the pipe open prevents the remote command from starting.

Deletion with `missingOk` verifies absence through `sandbox list`; it does not suppress a failure while a Sandbox with the requested name still exists.

## Sandbox profiles

Committed `read`, `write`, and `check` policies use hard Landlock enforcement and an empty base network map. All profiles make base and input material read-only. `read` also makes the Project copy read-only; `write` and `check` permit writes only to the Project copy, Session/output space, home, and temporary paths.

The current Docker baseline obtains UID/GID 10001 from the pinned image's OCI `USER`. Policy-level process overrides are rejected for OpenShell 0.0.106 because the live probe observed supplementary root-group membership when both override fields were set. A version upgrade must rerun the identity canary before changing this rule.

OpenShell 0.0.106 policy updates may expand access but cannot be used to revoke a `read_write` path. Session initialization therefore MUST NOT depend on tightening a live Sandbox policy.

Inference endpoints are not part of ordinary `network_policies`. A logical model alias resolves through machine-local configuration to one OpenShell gateway, exact routed model, Pi API shape, locality, and context limits. Before Sandbox creation, the host verifies that the selected gateway's current user-facing inference route names the expected model.

Inside a model-routed Session, Pi registers one synthetic `orchestrator` provider whose base URL is `https://inference.local` for Anthropic Messages or `https://inference.local/v1` for OpenAI-compatible APIs. Its `unused` API key is a protocol placeholder, not a credential. OpenShell strips it and injects the real provider credential outside the Sandbox. The Pi child receives only a validated OpenShell HTTP proxy address, the fixed OpenShell CA path, and `NODE_USE_ENV_PROXY=1`; it still receives no provider credential or general network permission. Because OpenShell handles `inference.local` before ordinary network-policy evaluation, authoritative Check Sandboxes MUST use a dedicated gateway and workspace whose absent inference route the host verifies before launch; they never launch Pi.

A model-routed Session includes an immutable compiled Brief. Its content is re-digested before image construction and its digest is recorded in Session configuration. Model completion and failure events bind the result to the initiating Message IDs, logical alias, requested model, stop reason, and bounded response data; the host rejects any event whose Message or route binding differs from the verified Session. These live events do not themselves satisfy a Gate or replace a durable Report.

## Security canary

`orchestrator canary` requires an exact OpenShell version pin and creates a fresh Sandbox for every selected profile. It verifies identity, source access, writable boundaries, OpenShell control-key isolation, host filesystem isolation, credential absence, Docker and SSH isolation, default network denial, host-gateway denial, and privilege denial. Each profile records its policy digest and cleanup result. Any failed assertion or cleanup makes the command fail.
