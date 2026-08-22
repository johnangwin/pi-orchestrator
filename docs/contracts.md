# Core Contracts

- **Contract version:** 2
- **Architecture:** Pi Orchestrator v0.3
- **Implementation status:** Migration in progress; see [Roadmap](roadmap.md)

These are the authoritative public contracts for v0.3. They describe durable concepts and authority boundaries, not a promise that every internal record is stored as one JSON object. The filesystem remains the version-zero State Store implementation.

## 1. Compatibility and authority

The v0.3 runtime reads and writes schema version 2. An unfinished version-one Run or planning operation is rejected with an explicit unsupported-state diagnostic. It is not migrated, resumed, or mutated automatically.

Only the trusted host Supervisor may:

- mutate authoritative Project, planning, Run, Task, Agent, Session, Gate, or Mailbox state;
- create, bind, or delete OpenShell Sandboxes;
- create or mutate cmux projections;
- grant a Write Lease;
- publish a Plan;
- operate host Git;
- accept Check or Review evidence;
- record human approval, a waiver, discard, or commit.

A Pi extension or model may make a typed request. Its output is untrusted input until the Supervisor validates it against current durable state. A transcript, pane, Sandbox-local file, or model assertion is never authoritative.

The defining continuity invariant remains:

> No Session transcript is a required dependency of another Session.

## 2. Identifiers and encoding

Identifiers are lowercase ASCII strings matching:

```text
^[a-z0-9][a-z0-9-]{0,62}$
```

Project, Plan, Run, Task, Agent, Session, Message, Report, Check job, Review, Handoff, Change Set, Candidate, and Artifact IDs are stable within their owning namespace. A Session generation is a positive integer. Reusing an ID for different content or provenance is rejected.

Timestamps are UTC RFC 3339 strings with second or finer precision. Git object IDs are full lowercase hexadecimal IDs returned by the repository's object format. Content digests use:

```text
sha256:<64 lowercase hexadecimal characters>
```

Structured digest input uses canonical UTF-8 JSON:

- object keys are lexicographically sorted;
- arrays retain semantic order;
- numbers are finite JSON numbers;
- absent optional fields are omitted rather than encoded as `undefined`;
- no insignificant whitespace is emitted.

`digestParts(domain, parts)` hashes a length-framed byte stream. The domain, each part name, and each part value are independently prefixed by an unsigned 64-bit big-endian byte length. Unless a section states otherwise, a self-digested record hashes canonical JSON of every field except its own digest under one `record` part.

## 3. Project configuration

Committed `.agents/orchestrator.yaml` uses version 2:

```yaml
version: 2

project:
  id: price-calculator

roles:
  - lead
  - researcher
  - planner
  - implementer
  - reviewer

routing:
  roles:
    lead:
      default: frontier-lead
      allowed:
        - frontier-lead
        - local-reasoning
      remote: allowed

    implementer:
      default: local-code
      allowed:
        - local-code
      remote: denied

    reviewer:
      default: independent-review
      allowed:
        - independent-review
        - quant-reasoner
      focuses:
        quant: quant-reasoner
      remote: allowed

context:
  initial_fraction: 0.25
  warn_fraction: 0.60
  handoff_fraction: 0.75
  stop_fraction: 0.85

attempts:
  implementation: 3
  review: 2
  consultation_hops: 2

git:
  branch_prefix: orchestrator/
  commit: human
  push: disabled
  merge: disabled

network:
  default: none

protected:
  - AGENTS.md
  - .agents/**
  - .pi/**
  - .github/**
  - docs/plans/**
  - "**/.env*"
  - "**/*secret*"

restricted_paths:
  - .env
  - secrets/**

checks:
  test:
    argv:
      - node
      - --test
```

The Project file contains policy and logical Model Profile names. It contains no provider credential, host path, gateway address, or concrete machine identity.

`protected` prevents an implementation result. `restricted_paths` prevents Sandbox visibility and mutation. Machine-local restrictions are additive and cannot remove committed restrictions. Task scope never overrides either list.

Unknown fields fail validation. Duplicate Role, Model Profile, Check, or path-policy entries fail validation. Fractions are finite, ordered, and within zero and one. Attempt counts and hop limits are bounded positive integers.

## 4. Machine-local configuration

Ignored `.pi/orchestrator.local.yaml` uses version 2:

```yaml
version: 2

openshell:
  gateways:
    frontier: openshell-frontier
    local: openshell-local
    review: openshell-review
    check: openshell-check

  images:
    pi: pi-orchestrator-pi@sha256:<digest>
    check: pi-orchestrator-check@sha256:<digest>

  policies:
    read: sandbox/policies/read.yaml
    write: sandbox/policies/write.yaml
    check: sandbox/policies/check.yaml

  shared_workspace:
    enabled: true
    gateway: openshell-local
    driver: docker
    driver_version: "29.5.2"
    docker_command: docker

models:
  frontier-lead:
    gateway: frontier
    pi_model: gpt-5.6-sol
    api: openai-responses
    locality: remote
    context_window: 200000
    max_tokens: 32000

  local-code:
    gateway: local
    pi_model: qwen-local-code
    api: openai-completions
    locality: local
    context_window: 131072
    max_tokens: 16384

cmux:
  command: cmux
  workspace_prefix: orchestrator

workspace:
  volume_prefix: pi-orchestrator
  restricted_paths:
    - local-private/**
```

Machine-local `workspace.restricted_paths` are added to committed Project restrictions. They cannot remove or weaken committed restrictions.

Model Profile names are Project-defined identifiers, not a fixed enum. Every referenced profile resolves to one exact gateway, concrete model, API shape, locality, context window, and output limit. Optional reasoning and token-pricing metadata becomes part of the resolved route when present.

The selected gateway's observed OpenShell identity and active inference route must match the resolved route before Session creation. A missing profile, route mismatch, policy mismatch, remote profile for a local-only Role, or unapproved local-to-remote change fails closed. There is no implicit provider, gateway, model, or locality fallback.

The file may contain operator paths and non-secret routing metadata. Production secrets are forbidden. Provider credentials remain in the OpenShell gateway.

## 5. Role contract

One `.agents/roles/<role>.md` defines one Role. Its YAML frontmatter uses:

```yaml
---
version: 2
name: implementer
description: Implement one approved Task.
skills:
  - development
lifetime: task
needs:
  - task
  - plan
  - decisions
  - dependencies
  - scope
  - checks

permissions:
  source: read
  write_lease: task
  pi_tools:
    - read
    - grep
    - find
    - ls
    - bash
    - write
    - edit
  actions:
    - message
    - consult
    - report
    - handoff
    - block
    - finish
---
```

Allowed lifetimes are `run`, `design`, `task`, `review`, and `query`. Source permission is `none` or `read`. Write Lease permission is `never` or `task`. Pi tools and actions come from closed registries; unknown values fail validation. Omitted authority is denied.

Role files do not contain `model`, `access`, or `sandbox`. Skills and the Markdown body guide behavior but cannot grant authority.

The permission ceiling is the intersection of:

```text
hard host ceiling
machine-local policy
Role permissions
Task or Review assignment
current Run state
```

The static intersection excluding current Run state is frozen as `permission_ceiling_digest`. Dynamic state is re-evaluated for every request. A permission expansion requires trusted human approval and a new Session generation.

## 6. Plan and Task contract

Plans remain committed Project knowledge:

```text
docs/plans/<plan-id>/plan.md
docs/plans/<plan-id>/tasks.yaml
```

`plan.md` contains:

```text
Context
Goal
Non-goals
Current structure
Proposed direction
Architecture
Quantitative implications
Risks
Open questions
```

`tasks.yaml` uses version 2:

```yaml
version: 2

plan:
  id: discount-support
  revision: 1

tasks:
  - id: discount-calculation
    title: Add integer percentage discounts
    role: implementer
    depends: []
    goal: Apply a validated percentage discount to integer-cent prices.
    write_paths:
      - src
      - test
    scope:
      - src/**
      - test/**
    non_goals:
      - Add floating-point currency calculations.
    acceptance:
      - Existing price calculations remain unchanged without a discount.
    checks:
      - test
    reviews:
      - spec
      - architecture
      - quality
      - quant
```

Plan IDs equal their directory name. Task IDs are stable and descriptive. Dependencies form an acyclic graph. Roles, Skills, Checks, Review Focuses, and Model Profile policy must resolve. Every Task requires Spec, Architecture, and Quality Reviews; Quant is required when accepted planning evidence declares material quantitative impact.

`write_paths` are canonical literal repository-relative paths. They must be covered by semantic `scope`, must not overlap protected or restricted paths, and must not contain traversal, glob syntax, empty segments, or absolute paths. `scope` is the post-work outcome boundary, not mount authority.

The Plan digest uses domain `pi-orchestrator/plan/v2` and ordered raw-byte parts:

```text
plan.md       exact plan.md bytes
tasks.yaml    exact tasks.yaml bytes
```

Any byte change invalidates approval.

## 7. Planning and Plan publication

Planning starts from a clean exact commit materialized once in a temporary Workspace volume. Planning Agents receive the same `project` subtree read-only with Git metadata absent and restricted paths masked. Planning output remains an immutable host Artifact until publication.

Questionnaires, Decisions, independent Architecture and Quant consultations, criticism, and Lead synthesis retain the v0.2 evidence and transcript-isolation rules. Every result binds the exact planning commit, Workspace manifest, Role, permission ceiling, Model Profile, resolved route, policy, image, Brief, Session identity, and upstream durable records.

Publication creates or recovers the reserved Run branch and volume from the planning commit, writes only validated Plan files through a trusted helper, and presents the exact Plan, Git diff, one-line subject, and proposal digest in a transient trusted cmux pane. One human confirmation may authorize both the Plan commit and approval only when both bind to identical bytes.

Approval records:

```text
Plan ID and revision
Plan digest
planning commit
published Plan commit
publication proposal and intent digests
approving local user
confirmation timestamp
permission-policy digest
routing-policy digest
```

An already committed human Plan may omit publication evidence but must satisfy every other validation and approval binding. A material Plan, permission, routing-egress, Task-scope, or write-root change pauses affected work and requires fresh approval.

## 8. State Store and atomicity

Runtime state remains outside the Project and is never mounted into a Sandbox:

```text
$ORCHESTRATOR_HOME/projects/<project-id>/
  project.json
  planning/<planning-id>/
  runs/<run-id>/
    state.json
    events.jsonl
    messages/<lifecycle>/
    briefs/
    reports/
    checks/
    reviews/
    decisions/
    handoffs/
    changes/
    candidates/
    commits/
    metrics/
    artifacts/
```

One Supervisor owns a per-Project advisory lock and host-local control socket. CLI clients never edit state files directly.

Authoritative JSON replacement uses:

1. same-directory temporary file with exclusive creation;
2. complete write;
3. file flush;
4. schema and invariant validation;
5. atomic rename over the target;
6. parent-directory flush.

Immutable records publish through same-filesystem staging and atomic rename. Lifecycle movement uses atomic rename between sibling directories. `events.jsonl` is append-only audit data and is not required to reconstruct current state.

## 9. Run, Workspace, and Task state

Run states are:

```text
ready
active
paused
blocked
complete
stopped
```

Task states are:

```text
pending
ready
active
checking
reviewing
rework
blocked
accepted
skipped
cancelled
```

Gate states are:

```text
pending
pass
fail
stale
waived
```

A Run owns one branch and one plain Docker named volume. The Workspace record contains:

```text
volume name, labels, and inspected identity digest
full branch ref
repository identity
approved base commit
current HEAD
phase: stable | mutating | candidate
monotonic generation
current manifest digest
current Git-diff digest
active Write Lease ID, if any
current Candidate ID, if any
```

The Supervisor rejects bind-backed volumes, driver options, unexpected labels, remote gateways, and volume reuse across Runs. It never resets, cleans, removes, rehomes, or adopts unexpected Workspace content.

Task runtime state contains its input commit and Workspace generation, implementation and Review attempts, assigned Agent, Change Set IDs, Candidate ID, required Gate records, output commit, and blocker. A Task may enter `checking` only with a frozen Candidate and may become `accepted` only through a passing human Commit Gate.

## 10. Workspace manifests and volume projection

A stable Workspace manifest includes every bounded entry below the Run volume's `project` subtree, including tracked, untracked, and ignored entries. A pinned model-free helper uses `lstat`, does not traverse symlinks, and sorts paths by raw UTF-8 byte order.

Each entry records:

```text
relative path
type: directory | regular | executable | symlink
byte count
content SHA-256 for regular and executable files
link-target bytes and SHA-256 for symlinks
```

Special files, invalid UTF-8 paths, traversal, unsafe symlinks, unexpected multiple hard links, changing reads, excessive entries, or excessive bytes fail closed. Git status is collected separately through a scrubbed trusted helper. Git metadata is absent from `project` and never included in source digests.

Every model Sandbox mount table must prove:

```text
Run volume `project` subpath  /workspace/project     read-only
current Task write roots      same nested paths      read-write only for Lease holder
Git metadata                  absent                 not projected
restricted-path masks         nested paths           opaque and read-only or absent
Session home and output       private paths          read-write
```

The root mount is never writable. Nested write mounts exist only for one current Write Lease. Read-only Agents may observe a mutating Workspace, but no source-bound durable conclusion is accepted until the next stable generation.

Workspace volumes require an explicitly configured local Docker gateway, a plain inspected named volume, and a passing canary for the exact OpenShell, Docker, image, and policy versions. Missing enforcement prevents Session launch.

## 11. Agents, Sessions, and Sandboxes

Agent states are:

```text
dormant
active
waiting
blocked
stopped
```

Session states are:

```text
starting
active
disconnected
waiting
stopped
failed
```

An Agent record contains:

```text
Agent ID
Role
selected Model Profile
status
assigned Task or Review
current Session ID and generation
Mailbox counts
cmux pane binding, if any
```

A Session record contains:

```text
Run, Agent, Session, and generation
predecessor and replacement reason, when applicable
status, timestamps, and terminal reason
permission-ceiling digest
selected Model Profile
resolved-route digest and exact route metadata
Brief digest
source Workspace generation and digest
policy, image, Pi, client, OpenShell, and mount-table digests
Sandbox UUID, name, workspace, and gateway identity
Connection and cmux bindings, when active
```

A dormant Agent has generation zero and no Session. Its first Session is generation one. Session history is contiguous, only the current Session may be nonterminal, and Sandbox provenance binds once. Starting or replacing a Session requires a caller-selected stable Session ID so an identical retry is idempotent and a competing stale request fails.

Every child process receives an allowlisted environment. Host home, state, Git metadata, OpenShell control authority, Docker socket, SSH agent, cloud or production credentials, and unrelated API keys are absent. Inference uses only the selected gateway's `inference.local` route and proxy configuration without exposing provider credentials.

## 12. Write Lease, Change Set, and Candidate

Only one Write Lease may exist in a Run. Its immutable record contains:

```text
Run, Plan, and Task identity
Agent, Session, and generation
Workspace generation and baseline manifest digest
literal write roots
semantic scope and protected/restricted policy digests
permission-ceiling and resolved-route digests
policy, image, gateway, requested mount-set, Sandbox, and observed mount-table digests
creation and expiry timestamps
status: preparing | active | releasing | released | blocked
```

The lease is durable before any writable Sandbox exists, so its preparing version binds the requested mount set while Sandbox and mount-table fields remain empty. It becomes active only after the Supervisor verifies and records Sandbox provenance and the actual mount table. It cannot release until the writable Sandbox and mounts are absent.

A Change Set compares two stable complete manifests and contains:

```text
Run, Task, Agent, Session, and generation
Write Lease ID and digest
baseline and result Workspace generations and manifest digests
sorted additions, modifications, deletions, mode changes, and symlink changes
Git-diff digest
scope and path-policy results
creation timestamp
```

Every changed path must be within both a literal write root and semantic Task scope and outside protected and restricted paths. The Change Set, not filesystem ownership or model prose, attributes writes to an Agent. An exact accepted Change Set advances the Workspace generation once.

A Candidate freezes the aggregate Task result and contains:

```text
Run, Plan, Task, and approval digests
Task input commit and Workspace generation
complete Workspace manifest and Git-diff digests
ordered Change Set IDs and digests
sorted changed paths and resulting modes and content digests
permission, routing, image, policy, and mount provenance
freeze timestamp
status: frozen | stale | accepted | discarded
```

Candidate freeze requires a stable Workspace, no active Write Lease, no write-capable Sandbox, exact current approval, and a revalidated manifest and diff. Any source, Plan, policy, route, or relevant configuration change marks it and its Gates stale.

## 13. Briefs, Decisions, Reports, and Handoffs

A Brief is compiled from authoritative Project instructions, Role, permission ceiling, selected Skills, Task or Review assignment, relevant Plan sections, accepted Decisions, dependency Reports, source anchors, Workspace and Candidate identity, output contract, Model Profile, route, and Session identity.

It excludes transcripts, hidden reasoning, unrelated Task output, abandoned alternatives, stale evidence, and other Review findings. Required constraints are never silently truncated. Supporting material beyond the context budget is replaced by explicit omissions and source anchors.

A Brief becomes stale when any bound Plan, Decision, Role, permission, route, Session generation, Workspace generation, source digest, Candidate, dependency Report, policy, image, or output contract changes.

A Decision is immutable accepted structured input scoped to Project, Run, or Task. A Report is immutable structured output with conclusions, evidence, source anchors, risks, and downstream requirements. Reports do not summarize transcripts and cannot satisfy Gates by prose alone.

A Handoff contains completed work, current state, blockers, next action, source anchors, Task, Workspace generation, relevant Change Sets or Candidate, Report references, and exact digests. It is stored before replacement. The successor receives a fresh Brief plus the Handoff, never the predecessor transcript. An ordinary Handoff retains the Agent's Model Profile; an approved profile change requires a new route binding and Session generation.

## 14. Messages and Connections

One immutable file represents one Message. Its directory is authoritative delivery state:

```text
pending
queued
answered
expired
superseded
```

A Message contains:

```text
version and stable ID
Run
sender Agent or host identity
target Agent, Session, and generation
type and priority
optional reply-to ID
small structured body
Artifact and source references
creation timestamp
```

Before the first write, the Supervisor resolves an Agent or Role target to the exact current Session and generation. A partially bound Session target is invalid. Replacement never silently retargets an already stored Message.

The host records `pending` before delivery. `queued` means the current Pi client acknowledged acceptance for injection; it does not mean the requested work completed. Link loss leaves pending Messages durable. Duplicate IDs with identical content are acknowledged without reinjection; different content is rejected. Pending Messages for a retired generation become `superseded`.

A live Connection is transport, not state. Every frame carries complete identity and a per-Session handshake token. The Supervisor validates every event against current durable state before mutation. Direct Agent-to-Agent sockets, shared mailbox volumes, and peer Sandbox discovery are forbidden.

## 15. Checks and Reviews

Plans reference trusted Check IDs, never arbitrary shell strings. Each authoritative Check:

- uses one fresh Check Sandbox;
- mounts the frozen Candidate read-only;
- uses private writable build and cache scratch;
- contains no Pi, inference route, credentials, Git metadata, or general network;
- executes the registered argv directly without a host shell;
- is deleted before its result becomes authoritative.

A Check record binds Check ID, argv, working directory, timeout, timestamps, exit code, stdout and stderr Artifacts, Plan, Task, Candidate, Workspace and diff digests, image, policy, OpenShell identity, mount table, and cleanup result. Zero exit is `pass`; another observed command exit is `fail`. Infrastructure or cleanup failure produces no verdict.

Each Review uses a fresh Agent with a Review assignment, Session, and read-only Sandbox over the frozen Run volume. The Reviewer receives changed-path anchors, exact Git diff and Candidate metadata through `candidate.json`, and passing Check evidence, but no Patch Artifact, Implementer transcript, or prior Review finding. Allowed Review Focuses are `spec`, `architecture`, `quality`, and `quant`.

A Review record binds Focus, round, verdict, blocking findings, Report, Plan, Task, Candidate, Workspace generation and volume, manifest, source, Git diff, mount set, required Check records, Agent and Session identity, permission ceiling, Model Profile and route, Brief, image, policy, OpenShell identity, observed mount table, and timestamps. Verdicts are `pass`, `rework`, and `blocked`. Every blocking finding includes location, failure scenario, evidence, and required correction.

The host freezes each independent Review before exposing it to later synthesis. A diff or Candidate change makes all Check and Review evidence stale. Attempt and Review-round limits prevent unbounded repair loops.

## 16. Human commit

Commit requires a current Candidate and every required Check and Review Gate passing against that exact Candidate. The proposal displayed in a transient trusted pane binds:

```text
Plan and approval
Run branch and parent commit
Task and Candidate
Workspace manifest and Git diff
ordered Change Sets
changed paths, modes, and content digests
Check and Review records
one-line subject
Git author and committer identity
```

Human confirmation publishes an immutable intent before Git mutation. The hardened Git adapter strips ambient `GIT_*` variables, disables system and global configuration, filesystem monitors, hooks, filters, signing, prompts, rename inference, and shell evaluation. It stages only Candidate paths, verifies every staged blob and mode, creates one exact parent commit, and advances the Run branch with compare-and-swap.

The resulting Commit record and passing Gate are immutable. A retry may adopt only the exact commit authorized by a preceding durable intent. An unauthorized matching commit or any branch, parent, tree, source, evidence, identity, or Workspace drift blocks.

The passing Commit Gate marks the Task accepted, advances the clean Workspace baseline, and unblocks dependencies. Push, merge, deploy, and release remain unavailable.

## 17. cmux and Pi control

The default cmux workspace contains a persistent Lead Pi pane on the left and a right-hand stack of active Agent panes. A Run cmux binding stores its stable operation ID, Workspace UUID, and title. An Agent pane binding stores its operation ID, Workspace, Pane and Surface UUIDs, expected title, and exact Session generation.

UUIDs are authoritative; titles and layout are recoverable presentation. Missing panes do not alter workflow state. Pane creation, adoption, reattachment, and removal retain the v0.2 durable-intent and ambiguity-rejection rules under Agent terminology.

The Pi extension exposes the `/orchestrator` user namespace and a closed model-facing tool surface. Both call the Supervisor over a host-local authenticated control path. Pi renders state but does not own it. Human approvals never traverse the Pi conversation or model-facing protocol.

The primary `orchestrator` command bootstraps or resumes this surface from a cmux-created terminal. `doctor`, `canary`, `status`, `reconcile`, and `stop` remain host diagnostics. Phase commands remain a low-level API until the Pi surface reaches parity and may remain for automation afterward.

## 18. Artifact contract

Large non-source payloads cross OpenShell through verified Artifact transfer. The Link carries only a descriptor. The Supervisor derives the one permitted Sandbox output path from the Artifact ID, verifies exact Sandbox provenance, remote regular-file type, size and SHA-256, downloads into same-filesystem staging, verifies provenance again, validates local type, size, digest and schema, and atomically publishes immutable content plus a provenance record.

Artifacts remain appropriate for Reports, logs, manifests, and binary results. They are not used for normal source snapshots, per-Agent Project copies, implementation patches, or Candidate reconstruction. No Sandbox Artifact is executed on the host.

## 19. Recovery and staleness

On restart the Supervisor acquires single-writer ownership and reconciles:

```text
Project, planning, and Run state
Plan publication and approval
Run branch and linked Workspace
Workspace phase, generation, manifest, and diff
Write Lease and writable Sandbox absence or provenance
Candidate and Gate evidence
Agent, Session, Sandbox, Connection, and cmux bindings
Messages, Decisions, Reports, Handoffs, Change Sets, and Artifacts
```

Recovery never requires `events.jsonl`, a transcript, terminal scrollback, or model memory. It reconnects an exact current Session, reattaches a missing pane, resumes an idempotent operation, replaces a Session from durable context, or blocks. It does not infer completion from process absence.

Any digest-bound evidence becomes stale when an input in its contract changes. Stale evidence cannot satisfy a Gate. A human may waive a Gate only through a trusted confirmation bound to exact current evidence and a recorded rationale; a waiver never repairs or hides source drift.

## 20. Digest registry

The following domains are reserved for schema version 2. `record` means canonical JSON of all required fields named in the corresponding section, excluding the digest field itself.

| Object                     | Domain                                  | Ordered parts                                |
| -------------------------- | --------------------------------------- | -------------------------------------------- |
| Plan                       | `pi-orchestrator/plan/v2`               | `plan.md`, `tasks.yaml` raw bytes            |
| Permission ceiling         | `pi-orchestrator/permission-ceiling/v2` | `record`                                     |
| Routing policy             | `pi-orchestrator/routing-policy/v2`     | `record`                                     |
| Resolved model route       | `pi-orchestrator/model-route/v2`        | `record`                                     |
| Workspace manifest         | `pi-orchestrator/workspace-manifest/v2` | `record`                                     |
| Host diff                  | `pi-orchestrator/workspace-diff/v2`     | `input-commit`, `manifest-digest`, `changes` |
| Plan publication proposal  | `pi-orchestrator/plan-publication/v2`   | `record`                                     |
| Human approval             | `pi-orchestrator/approval/v2`           | `record`                                     |
| Brief                      | `pi-orchestrator/brief/v2`              | `content`, `binding`                         |
| Decision                   | `pi-orchestrator/decision/v2`           | `record`                                     |
| Message                    | `pi-orchestrator/message/v2`            | `record`                                     |
| Report                     | `pi-orchestrator/report/v2`             | `content`, `binding`                         |
| Write Lease                | `pi-orchestrator/write-lease/v2`        | `record`                                     |
| Change Set                 | `pi-orchestrator/change-set/v2`         | `record`                                     |
| Candidate                  | `pi-orchestrator/candidate/v2`          | `record`                                     |
| Check intent               | `pi-orchestrator/check-intent/v2`       | `record`                                     |
| Check result               | `pi-orchestrator/check-record/v2`       | `record`                                     |
| Review intent              | `pi-orchestrator/review-intent/v2`      | `record`                                     |
| Review result              | `pi-orchestrator/review-record/v2`      | `record`                                     |
| Handoff                    | `pi-orchestrator/handoff/v2`            | `content`, `binding`                         |
| Commit proposal and intent | `pi-orchestrator/commit-intent/v2`      | `record`                                     |
| Commit result              | `pi-orchestrator/commit-record/v2`      | `record`                                     |
| Artifact provenance        | `pi-orchestrator/artifact/v2`           | `content-digest`, `binding`                  |
| Canonical Run state        | `pi-orchestrator/run-state/v2`          | `record`                                     |
| Metrics evidence set       | `pi-orchestrator/metrics-evidence/v2`   | `sorted-record-digests`, `run-state-digest`  |

For `content` plus `binding`, content is the exact stored UTF-8 or binary bytes and binding is canonical JSON of all provenance fields. For `changes`, entries are canonical JSON sorted by relative path. For `sorted-record-digests`, digests are byte-sorted before canonical JSON encoding.

Changing a domain, part name, part order, canonicalization rule, required field, or semantic meaning requires a new digest-domain version. Validation always recomputes digests from authoritative bytes; a stored digest is never trusted by itself.

## 21. Resource and retry limits

Cross-process and Sandbox operations use stable IDs and are safe to retry. Default limits remain:

```text
implementation attempts    3
Review rounds              2
consultation hops          2
initial Brief fraction     0.25
context warning            0.60
Handoff recommended        0.75
new mutating phase denied  0.85
Link record                64 KiB
```

Artifact, Workspace-entry, total-byte, command-output, model-output, and timeout limits are finite machine-local or host constants and are recorded with the operation that used them. Exceeding a limit fails closed and does not create successful evidence.
