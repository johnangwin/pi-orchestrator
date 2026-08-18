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

Lifecycle changes use same-filesystem rename. Retrying the same Message ID and content is idempotent. Reusing an ID for different content is rejected. Reads fail closed if a filename disagrees with its Message ID or one ID appears in multiple lifecycle directories.

A caller may initially address a Message to a Seat. Before the first durable write, the host resolves that Seat through authoritative Run state and adds the current Session ID and epoch. A Message with only one of those identity fields is invalid. Once stored, that complete target is immutable; Session replacement does not silently retarget an old pending Message.

The host serializes Mailbox delivery for the current implementation. It writes the bound Message to `pending` before using a live Link, verifies that the Link identity is still current, and sends the exact stored content. A `queued` acknowledgement means the Pi client accepted the Message for injection. A `duplicate` acknowledgement means the same client already accepted the identical Message during an earlier attempt. Either acknowledgement atomically advances `pending` to `queued`; neither advances it to `answered`.

Transport failure removes the live Link, records the current Session as `disconnected`, and leaves the Message `pending`. Attaching a replacement transport for the same Session identity moves the Session back to `active` and redelivers its pending Messages in deterministic creation order. The Pi client deduplicates the stable IDs, so recovery after acknowledgement loss does not inject a Message twice. The host validates the current identity again after acknowledgement so an epoch change cannot satisfy delivery state for a stale Session.

Session replacement first makes the old epoch terminal, preventing any new Message from binding to it. Pending Messages already bound to that epoch move atomically to `superseded` before the replacement epoch becomes current. Queued Messages remain durable evidence that the old Pi client accepted delivery; they are not silently retargeted.

## Briefs

Brief compilation is deterministic. Required constraints are never silently truncated. Supporting Skill content that cannot fit the initial budget is replaced by an explicit omission naming its source path. Brief freshness binds Plan, Role, Task, Decisions, source digests, Session identity, and Seat epoch.

## Link transport

The host core depends only on the `LinkTransport` interface. The selected OpenShell implementation uses a host-loopback TCP service forward to a sandbox-loopback Pi client endpoint. The underlying OpenShell 0.0.106 transport has passed execution, file-transfer, network-denial, and loopback-forwarding probes.

Link records are strict LF-delimited JSON capped at 64 KiB. Every record carries the Run, Seat, Session, and epoch. A 256-bit per-Session token authenticates the initial handshake; it does not authorize workflow state changes. The client rejects stale identities and deduplicates stable Message IDs across host reconnections.

The initial protocol implements `hello`, `ready`, `ping`, `pong`, `deliver`, `ack`, `event`, and `error`. The host serializes exchanges until a later dispatcher provides correlation-safe concurrency.

## Source snapshots

A source snapshot is produced from an exact Git commit and literal relative paths. `git archive` excludes untracked files and `.git`; unsupported tree entries fail closed. Its manifest records the selected paths, tracked entries, archive byte count, archive SHA-256 digest, and a domain-separated source digest. The launcher revalidates the manifest and copied archive immediately before image construction.

Read-only Session inputs are added to a temporary derived-image build context. This is required because OpenShell upload honors the active Landlock policy and OpenShell 0.0.106 cannot revoke a writable path through a live policy update. The Sandbox starts directly with the final `read` profile, and the temporary context is deleted after creation.

An implementation Session uses the same mechanism under the final `write` profile. The verified archive is expanded into both a root-owned `/workspace/base` and Sandbox-user-owned `/workspace/project`; neither contains Git metadata. Startup must prove that base and input reject writes and that project accepts them. Immutable Session configuration binds the profile to the Sandbox policy and Pi tool set. A missing profile is interpreted only as `read` for recovery compatibility.

The image OCI working directory remains `/sandbox` because OpenShell file download is workspace-confined. The Pi daemon separately fixes the model process working directory at `/workspace/project`.

## Run worktrees

A Run starts only from a fresh approval whose Plan ID, revision, Plan digest, and base commit match the current Project. The default Run ID is `<plan-id>-r<revision>`. Its branch is the committed `git.branch_prefix` plus the Run ID, and its host worktree path is `<worktrees.root>/<project-id>/<run-id>` after machine-local home expansion and canonical path resolution. A relative configured root resolves from the consumer Project root; a relative command-line override resolves from the caller's working directory.

The consumer Project must currently be the Git top-level. The worktree root and resulting Run path must be isolated from that trusted checkout. Containment is checked against a symlink-aware prospective path before directory creation, then checked again after creation. Invalid configuration cannot create files in the trusted checkout.

Run creation records the exact Project, Plan, base commit, branch, and worktree path in `state.json` before invoking `git worktree add`. The Project Run index is updated after the Run file, so interruption before index publication is recoverable by retry. A registered index entry without its Run state fails closed.

The Git adapter uses NUL-delimited porcelain output and argument arrays. It disables Project hooks during worktree creation and verifies the repository common directory, canonical path, full branch ref, exact `HEAD`, and clean tracked and untracked status. A retry may adopt an already registered exact worktree or a reserved branch left at the exact base commit. A branch at another commit, a branch checked out elsewhere, an unregistered path, a missing registered path, another repository, detached `HEAD`, or any dirty content blocks.

The Orchestrator never resets, cleans, stashes, removes, or rehomes unexpected worktree content. A linked host worktree contains host Git metadata and is never mounted into a model-driven Sandbox; later implementation snapshots are exported without `.git`.

## Artifacts

Small Artifact descriptors travel through the Link; payload bytes do not. A descriptor binds an Artifact ID, kind, Run, optional Task, Seat, Session, epoch, canonical Sandbox path, normalized media type, versioned content schema, byte count, SHA-256 digest, and creation time.

The only accepted remote path is derived from the validated Artifact ID:

```text
/sandbox/output/artifacts/<artifact-id>
```

The host selects the content contract and size limit. Before transfer it verifies the current Sandbox UUID, name, workspace, and ready state, then uses trusted Sandbox `stat` and `sha256sum` binaries to reject a non-regular, oversized, truncated, or changed remote file. It downloads only to a same-filesystem staging directory, verifies the source Sandbox again, independently checks the local file type, size, digest, and schema, and then writes the authoritative provenance record.

The payload and record are changed to mode `0400`, flushed, and published together by atomic directory rename under the Run's `artifacts/` directory. Failed imports remove staging data. Retrying identical content and provenance is idempotent; reusing an Artifact ID with any different content or provenance is rejected. Stored content is revalidated on read and is never executed by the Orchestrator.

## Implementation patches

The pinned Sandbox exporter requires immutable `write`-profile Session configuration, compares `/workspace/base` and `/workspace/project`, and emits one binary-capable JSON Patch Artifact. It rejects `.git`, unsafe or non-UTF-8 paths, special files, changing files, more than 100,000 entries, a patch over 32 MiB, or a complete Artifact over 64 MiB. Git runs without system/global configuration, external diff commands, text conversion, or rename inference.

The Patch bundle binds the source snapshot digest, complete base and result tree digests, a sorted change manifest, raw patch digest, and domain-separated diff digest. Tree entries bind path, regular/executable/symlink mode, byte count, and SHA-256 content digest. Identical export retry is idempotent; an existing canonical path with other content or a non-regular file blocks.

Patch Artifact validation replays the patch against two fresh extractions of the host-verified source archive. The host independently recomputes the base tree, applies with unsafe paths disabled, confirms the base remained unchanged, and recomputes the result tree and change manifest before Artifact publication. Validation failure leaves no published Artifact.

An imported Patch Artifact does not by itself authorize source mutation. The application gate first revalidates the current Plan approval, Task input commit, Artifact provenance, current Session epoch, implementation attempt, and one-active-writer rule. It evaluates every changed path against bounded relative POSIX Task-scope and Project-protection globs; protected paths take precedence over scope.

Before Git mutation, Run state records a `prepared` application bound to the Artifact content, Session and Sandbox provenance, source commit and selected snapshot paths, source and result tree digests, Sandbox diff digest, and exact changed-path set. Host Git then verifies the repository common directory, canonical worktree, full branch ref, exact `HEAD`, and clean state before checking and applying the binary patch. The host independently reads the resulting NUL-delimited Git status, hashes actual regular-file or symlink results without following path symlinks, reconstructs the result tree, and records a distinct host diff digest before advancing the Task to `checking`.

Retry loads the immutable stored Artifact, recreates its exact source snapshot from the durable commit and path selection, and repeats Patch validation. A prepared worktree may be clean or exactly applied; an applied worktree must remain exact. Any other dirty state, conflicting Patch, changed branch or `HEAD`, missing Artifact, or digest mismatch blocks without reset, clean, stash, or repair.

## Authoritative Checks

Only registered Check definitions may satisfy a Gate. A definition is a bounded argument array plus an optional normalized relative POSIX working directory. The host invokes the array directly, never through a shell. The execution timeout is also an explicit Check input.

The host reconstructs a complete source tree from the Task input commit and its immutable applied Patch. This differs from the potentially scope-limited implementation snapshot: authoritative verification receives the full tracked Project at the base commit with the exact verified changes applied. Its manifest binds the input commit, Task source digest, host diff digest, complete path/content/mode tree, archive digest, and a separate Check-source digest. Neither the package nor the Sandbox contains `.git`. The host verifies a fresh extraction, and the Check image helper repeats archive and complete-tree verification after upload.

Before external mutation, the host atomically publishes an intent under `checks/<task>/<check>/<job>/intent.json`. The job ID and Sandbox name derive from a domain-separated binding of Run, Task, Check, Plan, input commit, source and diff digests, argv, working directory, timeout, image digest, and policy digest. The intent also contains a random durable ownership token. OpenShell labels bind the Sandbox record to the job and a 128-bit token fingerprint; an internal marker binds the full token. A Ready abandoned Sandbox requires both proofs before deletion. An Error Sandbox that never reached marker initialization may be removed only when its trusted control-plane labels match the durable intent.

Authoritative execution requires an exactly pinned, version-matched OpenShell client and gateway. The selected gateway/workspace must report no inference route. An image must be an OCI digest reference whose suffix equals its recorded digest or a canonical absolute local context whose complete tree matches its domain-separated digest. A local context is copied to private staging and verified again; validated policy bytes are also copied to private staging. OpenShell therefore consumes the bytes named by the intent rather than mutable caller paths. The fresh `check` Sandbox uses a separate pinned image with no Pi process, default-deny network, no credentials, no host state, and no host checkout. Project-specific images may add a required compiler or toolchain while preserving those properties.

The registered process runs only after source verification. Its Sandbox must be successfully deleted before evidence is accepted. The host then revalidates the exact Run worktree, current Plan files, registered Check definition, and approval. Any drift or cleanup failure leaves the intent pending and publishes no result.

A completed job atomically publishes immutable `stdout.log`, `stderr.log`, and `record.json`. The record binds command exit, time, exact inputs, Sandbox identity, OpenShell versions and gateway, log sizes and digests, intent digest, and its own domain-separated digest. Stored records and logs are revalidated on every read. An exact completed retry reuses that evidence and can finish an interrupted Gate update without another Sandbox.

The Task Gate records the intent digest as `pending`, then the record digest as `pass` or `fail`. Nonzero command exit is authoritative failed evidence and moves the Task to `rework`. Passing evidence leaves the Task `checking` until all required Check Gates pass, then moves it to `reviewing`. Infrastructure failure is not converted into a command verdict.

## Session identity

A Seat has one current Session identity: Run, Seat, Session, and monotonic epoch. The Pi client reads that identity from immutable Session input, binds every Link frame to it, and rejects old epochs. Reconnection replaces the transport connection without replacing the Seat or Session identity.

The Run state contains a stable Seat registry and immutable Session history. A newly registered Seat is dormant at epoch zero. Its first Session starts at epoch one; every replacement advances exactly one epoch, identifies its predecessor and replacement reason, and leaves the predecessor terminal. Session history must be contiguous, and only the current Session may be nonterminal.

Registry mutations are serialized by the single-writer Project store. Starting or replacing a Session requires a caller-selected stable Session ID, so retrying the same operation is idempotent while competing replacements against the same expected identity cannot both advance the epoch. Every mutating Session operation verifies the full current identity. A stale Run, Seat, Session, or epoch is rejected before state changes.

Session status transitions follow an explicit graph. `stopped` and `failed` are terminal and require an end time and reason. An OpenShell Sandbox binding records its UUID, name, and workspace once and cannot be replaced in place. Older version-one Run files without registry fields read as empty registries and acquire the fields on their next atomic mutation.

Lifecycle reconciliation observes the current Seat, Session, exact Sandbox provenance, live Link identity, and cmux projection before recommending `start`, `reconnect`, `reattach`, `replace`, or `blocked`. Observation alone does not change workflow state. A host restart may rebuild a Link for the same Session only after the immutable Sandbox configuration matches the current identity, pinned Pi and client versions, current profile and policy digest, and expected model and Brief route.

Replacement is an ordered retryable operation. The host validates the replacement input and exact Sandbox provenance before side effects, detaches the Link, marks the old Session terminal, removes its Sandbox and Pane, supersedes pending Messages for that exact epoch, and creates the next Session last. A failure leaves enough durable state to resume the same operation. A Sandbox with the expected name but a different UUID or workspace blocks replacement before any state changes.

## OpenShell lifecycle

The OpenShell adapter validates Sandbox names before launch, disables automatic credential providers, observes remote exit codes without treating expected denial as an infrastructure error, and parses `get` and `list` responses into versioned host types. Creation is followed by an authoritative `get`; JSON output is not requested from `sandbox create` because OpenShell 0.0.106 forbids combining it with an initial command.

Every programmatic `sandbox exec` closes the CLI child process's stdin immediately. OpenShell 0.0.106 buffers non-interactive stdin until EOF, so leaving the pipe open prevents the remote command from starting.

Deletion with `missingOk` verifies absence through `sandbox list`; it does not suppress a failure while a Sandbox with the requested name still exists.

Every new read Session records source and read-policy digests in immutable Sandbox input. Same-Session recovery first verifies the durable Sandbox UUID, name, workspace, and ready phase, then reads that input and validates the current identity, epoch, versions, policy, and, for a model-routed Session, the expected model route and Brief digest before opening a new loopback forward. Releasing a recovered host Link does not delete the Sandbox; each Link, forward, and Sandbox cleanup step remains independently retryable.

## cmux projection

cmux is a trusted host cockpit, not an authoritative state store. The adapter is pinned to cmux 0.64.22, verifies its required socket capabilities, requests JSON output with UUID identifiers, and invokes the CLI without a host shell. The cmux socket password remains inherited host-process state and is never persisted or forwarded to a Sandbox.

A Run Workspace binding contains its stable creation operation UUID, Workspace UUID, and expected title. A Seat Pane binding contains its stable creation operation UUID, Workspace UUID, Pane UUID, Surface UUID, and expected title. Titles are labels and bounded recovery evidence; UUID bindings remain authoritative.

Run state stores the Workspace operation before mutation and stores each Session-bound Pane operation and creation intent before mutation. Returned UUID bindings are written atomically. A host restart therefore resumes the same operation rather than inferring ownership from titles or creating an untracked duplicate.

Workspace creation uses cmux's native operation UUID. Before unbound Pane creation, the caller must persist a Pane intent containing the operation UUID and the complete prior Pane UUID set. A retry may adopt exactly one new single-Surface Pane; zero candidates permits creation and multiple candidates fail closed. Once a binding exists, a missing target is drift and cannot trigger implicit replacement.

Projection reconciliation only observes cmux state. It may report missing objects or title mismatches, but it cannot complete a Task, terminate a Session, or mutate Run state. Pane deletion refuses to close a Pane that has acquired any Surface beyond its bound one.

A missing Pane may be reattached only with a new durable operation ID and only after observation proves the old binding is absent. If the entire Workspace is absent, stale Pane state can be retired without issuing an unsafe close; recreating the Run Workspace remains an explicit blocked recovery decision.

## Sandbox profiles

Committed `read`, `write`, and `check` policies use hard Landlock enforcement and an empty base network map. All profiles make base and input material read-only. `read` also makes the Project copy read-only; `write` and `check` permit writes only to the Project copy, Session/output space, home, and temporary paths.

The current Docker baseline obtains UID/GID 10001 from the pinned image's OCI `USER`. Policy-level process overrides are rejected for OpenShell 0.0.106 because the live probe observed supplementary root-group membership when both override fields were set. A version upgrade must rerun the identity canary before changing this rule.

OpenShell 0.0.106 policy updates may expand access but cannot be used to revoke a `read_write` path. Session initialization therefore MUST NOT depend on tightening a live Sandbox policy.

Inference endpoints are not part of ordinary `network_policies`. A logical model alias resolves through machine-local configuration to one OpenShell gateway, exact routed model, Pi API shape, locality, and context limits. Before Sandbox creation, the host verifies that the selected gateway's current user-facing inference route names the expected model.

Inside a model-routed Session, Pi registers one synthetic `orchestrator` provider whose base URL is `https://inference.local` for Anthropic Messages or `https://inference.local/v1` for OpenAI-compatible APIs. Its `unused` API key is a protocol placeholder, not a credential. OpenShell strips it and injects the real provider credential outside the Sandbox. The Pi child receives only a validated OpenShell HTTP proxy address, the fixed OpenShell CA path, and `NODE_USE_ENV_PROXY=1`; it still receives no provider credential or general network permission. Because OpenShell handles `inference.local` before ordinary network-policy evaluation, authoritative Check Sandboxes MUST use a dedicated gateway and workspace whose absent inference route the host verifies before launch; they never launch Pi.

A model-routed Session includes an immutable compiled Brief. Its content is re-digested before image construction and its digest is recorded in Session configuration. Model completion and failure events bind the result to the initiating Message IDs, logical alias, requested model, stop reason, and bounded response data; the host rejects any event whose Message or route binding differs from the verified Session. These live events do not themselves satisfy a Gate or replace a durable Report.

## Security canary

`orchestrator canary` requires an exact OpenShell version pin and creates a fresh Sandbox for every selected profile. It verifies identity, source access, writable boundaries, OpenShell control-key isolation, host filesystem isolation, credential absence, Docker and SSH isolation, default network denial, host-gateway denial, and privilege denial. Each profile records its policy digest and cleanup result. Any failed assertion or cleanup makes the command fail.
