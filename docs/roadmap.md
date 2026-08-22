# Implementation Roadmap

- **Target:** Pi Orchestrator v0.3
- **Status:** Active migration
- **Execution target:** Generic price-calculator Project
- **Stepout:** Deferred until the generic v0.3 flow is stable
- **Detailed plan:** [v0.3 Implementation Plan](v0.3-implementation-plan.md)

## Current position

Version 0.2 is a tested end-to-end host-command implementation. Version 0.3 replaces its control surface and source-transfer architecture rather than adding a second permanent mode.

Phases 0 through 10 are complete. The original host-bind design failed under hard Landlock and was replaced by plain Docker named volumes; the revised live proof passes on OpenShell 0.0.106 and Docker 29.5.2. Durable and live identity use Agent and Session generation throughout the runtime. Every Session carries an immutable least-authority permission ceiling and an exact policy-approved Model Profile route. Read-only Agents, leased Implementers, authoritative Checks, and independent Reviews now use digest-pinned static images against the persistent Run Workspace without source archives, derived source images, Patch export, or replay. Complete manifests, requested and observed mount evidence, Write Leases, Change Sets, frozen Candidates, and Candidate-bound Check and Review records bind the execution path. Human commit remains on the retained v0.2 Patch path until Phase 11 replaces it.

| Phase | Work                                              | Status   |
| ----: | ------------------------------------------------- | -------- |
|     0 | Freeze v0.3 contracts and replacement ADRs        | Complete |
|     1 | Prove shared OpenShell Workspace volumes          | Complete |
|     2 | Rename Seats and epochs to Agents and generations | Complete |
|     3 | Enforce explicit Role permissions                 | Complete |
|     4 | Add policy-bound Model Profiles                   | Complete |
|     5 | Add complete Workspace manifests                  | Complete |
|     6 | Add Write Leases, Change Sets, and Candidates     | Complete |
|     7 | Run read-only Agents from the shared Workspace    | Complete |
|     8 | Run Implementers under Write Leases               | Complete |
|     9 | Run authoritative Checks against Candidates       | Complete |
|    10 | Run fresh Reviews against Candidates              | Complete |
|    11 | Commit exact Candidates                           | Next     |
|    12 | Add the trusted background Supervisor             | Pending  |
|    13 | Publish Plans into Run Workspaces                 | Pending  |
|    14 | Add the Pi-first cmux control surface             | Pending  |
|    15 | Complete v0.3 recovery and metrics                | Pending  |
|    16 | Remove the v0.2 source-transfer pipeline          | Pending  |
|    17 | Update onboarding and prove the generic flow      | Pending  |

## Phase 0 outcome

- accepted the [v0.3 Design](v0.3-design.md) and resolved its open choices;
- defined schema-version-2 [Core Contracts](contracts.md), including exact digest domains;
- recorded Agent, Supervisor, permission, Model Profile, shared Workspace, Write Lease, Candidate, Gate, and Plan-publication decisions;
- marked conflicting v0.2 ADRs as superseded while retaining their history;
- preserved current runtime behavior for a buildable migration baseline.

## Phase 1 proof gate

The rejected host-bind result is retained in [OpenShell Direct-Mount Proof](proofs/openshell-direct-mounts.md). The accepted replacement is recorded in [OpenShell Workspace-Volume Proof](proofs/openshell-workspace-volume.md): all required assertions pass with hard Landlock active, and Phase 2 may proceed.

The shared-volume profile remains version-bound to a live canary proving all of the following on the exact installed OpenShell, Docker driver, image, and policy versions:

1. the Run Workspace root is read-only;
2. one approved nested write root is writable only for the Lease holder;
3. sibling and protected paths remain read-only;
4. restricted paths reveal no original content;
5. another read-only Agent sees an allowed write;
6. `.git` and real Git metadata are absent from the projected subtree;
7. host state, home, credentials, sibling repositories, Docker socket, and SSH agent are absent;
8. unapproved network and host-local services are denied;
9. removing the writer Sandbox removes its writable mounts;
10. Sandbox and disposable volume cleanup is complete.

If the OpenShell adapter cannot enforce and inspect that mount shape, implementation returns to design review. It does not silently retain source archives as a v0.3 fallback.

## Phase 2 outcome

- renamed the durable roster, Session identity, Messages, Reports, metrics, Mailboxes, recovery, and cmux bindings to Agent and generation terminology;
- renamed `seat.ts` and its tests to `agent.ts` and updated the public exports;
- advanced Run and planning state to schema version 2 and the Link and Pi client protocols to version 2;
- rejected unfinished version-one Run and planning state with explicit no-migration diagnostics;
- preserved contiguous Session history, stale-generation rejection, Handoffs, recovery, and existing scheduling and filesystem behavior.

## Phase 3 outcome

- replaced Role `access` and `sandbox` fields with closed source, Write Lease, Pi-tool, and Orchestrator-action permissions;
- intersected hard host limits, machine-local policy, Role permissions, and Task or Review assignment into one immutable Session ceiling;
- bound the ceiling digest to approvals, Brief freshness, durable Sessions, planning and consultation evidence, Reviews, Handoffs, and recovery;
- derived Pi tools from the effective ceiling and required an exact trusted Task grant before launching a writable Sandbox;
- enforced model-facing actions in both the Pi client and host Link handler, including pre-freeze Reviewer isolation and stale-Session rejection;
- kept Git, Sandbox, cmux, credential, Gate, and human authority outside the configurable permission registry;
- made the full Role permission policy visible during trusted Plan approval and covered the boundary with adversarial tests.

## Phase 4 outcome

- replaced the fixed model alias catalog with descriptive Project-defined Model Profiles;
- moved committed selection policy out of Role files into per-Role defaults, allowlists, Review Focus overrides, and remote-egress rules;
- resolved each Profile through version-two machine-local configuration to an exact gateway, model, API, locality, context limit, reasoning setting, and optional pricing metadata;
- stored the selected Profile on each Agent and a complete self-digested resolved route on each Session;
- made Profile changes allocate a new Session generation while preserving the prior permission ceiling, and kept ordinary Handoffs on the existing Profile;
- bound approvals, Runs, Briefs, Reports, Reviews, Handoffs, metrics, recovery, and Pi turn evidence to routing policy or exact route digests;
- rejected disallowed Profiles, missing routes, gateway drift, remote routes for local-only Roles, silent fallback, and unapproved local-to-remote changes.

## Phase 5 outcome

- advanced Task files and Plan digests to version two and required literal `write_paths` independently from semantic `scope` globs;
- added duplicate-safe committed restrictions and additive machine-local restrictions, with restricted changes rejected by the retained importer;
- added component-wise canonical mount-root resolution that rejects missing, linked, multiply linked, special, overlapping, and escaping roots;
- added bounded complete Workspace manifests covering directories, tracked, untracked, ignored, executable, binary, and symlink entries in raw UTF-8 order;
- rejected Git metadata, invalid paths, unsafe symlink targets, special files, unexpected hard links, changing reads, and entry or byte-limit violations;
- added separately scrubbed NUL-delimited Git status and the version-two `workspace-diff` digest domain;
- decoupled source-scope validation from Patch Artifact types and covered additions, deletions, modes, symlinks, binaries, protected paths, and restricted paths.

## Phase 6 outcome

- added immutable Write Lease, Change Set, and Candidate stores with digest-bound Run state;
- enforced one active writer, exact Task write roots, ordered mutation attribution, bounded revocation, and stable Candidate freeze;
- made unexplained, protected, restricted, out-of-scope, and post-freeze drift block the Run and stale Gate evidence;
- made interrupted publication and recovery idempotent from persisted provenance.

## Phase 7 outcome

- replaced source-derived images for planning Agents with one digest-pinned static Pi image and read-only named-volume projection;
- materialized exact Git objects through a pinned model-free helper with no archive, checkout metadata, filters, hooks, or model authority;
- masked restricted paths, inspected the actual native mount table, and uploaded only digest-bound Session inputs;
- migrated questionnaire planning, Architecture and Quant consultations, independent criticism, and Lead synthesis;
- made durable recovery re-inspect the named volume, rebuild policy masks, verify complete contents and gateway provenance, and reject mount drift.

## Phase 8 outcome

- replaced the active implementation path with direct mutation of the persistent Run volume under one Task-scoped Write Lease;
- persisted the requested mount set before Sandbox creation and bound activation to the actual Sandbox, gateway, and Linux mount table;
- kept the Project root read-only and reopened only validated literal Task roots, with protected and restricted overlays retained;
- revoked and deleted every writer before model-free manifest and Git inspection, including after host-process interruption;
- stored Reports, immutable Change Sets, monotonic Workspace generations, frozen Candidates, and idempotent `workspace_changed` Messages;
- retained failed and interrupted deltas for bounded fresh rework without a predecessor transcript;
- added non-owning read projections so active read Agents observe allowed shared-volume writes while their source-bound Briefs become stale.

## Phase 9 outcome

- replaced active Check source reconstruction and archive upload with the frozen Run volume mounted read-only;
- required all writers on the configured shared Workspace gateway, then added a dedicated pinned, no-inference Check gateway and static image boundary with no Pi, credentials, host Git, or general network;
- redirected common language homes, caches, temporary files, bytecode, and build output into digest-bound private Sandbox scratch;
- bound version-two Check intent and result evidence to the exact Candidate, Workspace generation and volume, complete source and Git digests, Plan, argv, policy, image, scratch, OpenShell identity, and observed mount table;
- deleted each Check Sandbox before revalidating the Candidate and publishing immutable evidence;
- retained deterministic intent/result adoption after interruption while making Workspace drift stale the Candidate and prior Gate evidence.

## Phase 10 outcome

- replaced active Review source reconstruction, derived images, and `review.patch` input with the frozen Run volume and digest-bound `candidate.json` evidence;
- required an exact current Candidate, passing version-two Check records, no live writer, and complete manifest and Git-diff equality before and after every model turn;
- launched every Review Focus through a fresh read-only Agent generation, Session, and Sandbox with restricted masks and verified requested and observed mounts;
- preserved independent Focuses, bounded rounds, structured findings, immutable Reports, exact recovery, and the exclusion of Implementer transcripts and prior Review findings;
- bound version-two Review intents and results to Candidate, Workspace, Checks, Role permission ceiling, Brief, policy, image, selected Model Profile route, Agent and Session generation, and OpenShell evidence;
- made Workspace mutation stale every Gate and made rework require a newly frozen Candidate and fresh replacement Checks and Reviews.

## Later proof gates

### Writer gate (passed)

The live implementation proof inspects a real generic-project Write Lease, actual mount table, complete before-and-after manifests, Change Set, and Candidate. Recovery from a terminated writer attributes changes without a transcript and without cleaning the Workspace.

### Authority gate

Before making Pi the primary UI, inspect the Supervisor's single-writer ownership, host-local API, Pi request validation, and transient trusted approval pane. Text entered into Pi must be unable to satisfy a human Gate.

### Removal gate

Before deleting v0.2 source transport, prove that no active path, durable evidence reader, recovery operation, test, example, or documentation dependency requires source archives, derived Session images, Patch export, replay, or import.

### Release gate

The generic price-calculator Run must complete entirely through the Pi-first flow with mixed policy-approved Model Profiles, one consultation, one Handoff, one terminated-Session recovery, deterministic Checks, fresh Reviews, trusted Plan publication, human commit, and a metrics report. Stepout remains untouched during this milestone.

## Retained v0.2 baseline

The following behavior is implemented and tested today and is retained until its named v0.3 replacement lands:

- atomic filesystem state and single-writer locking;
- Plan validation, approval digests, Task transitions, and durable Reports;
- OpenShell process, environment, credential, and network isolation;
- logical Mailboxes, authenticated Connections, deduplication, and stale-identity rejection;
- durable Session history, Handoffs, recovery, and cmux UUID projection;
- isolated Run branches and worktrees;
- human compare-and-swap commits;
- repository-aware planning, consultations, criticism, synthesis, metrics, and reporting;
- the standalone price-calculator example.

Source snapshots, derived images, implementation Patch Artifacts, retained reconstructed Check and Review fixtures, and phase-oriented onboarding are migration inputs, not v0.3 target behavior.
