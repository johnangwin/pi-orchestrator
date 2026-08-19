# Implementation Roadmap

- **Target:** Pi Orchestrator v0.3
- **Status:** Active migration
- **Execution target:** Generic price-calculator Project
- **Stepout:** Deferred until the generic v0.3 flow is stable
- **Detailed plan:** [v0.3 Implementation Plan](v0.3-implementation-plan.md)

## Current position

Version 0.2 is a tested end-to-end host-command implementation. Version 0.3 replaces its control surface and source-transfer architecture rather than adding a second permanent mode.

Phase 0 is complete. Phase 1, the direct OpenShell mount proof, is next and is a hard release gate. Runtime behavior remains v0.2 until a later phase deliberately replaces each path.

| Phase | Work                                              | Status   |
| ----: | ------------------------------------------------- | -------- |
|     0 | Freeze v0.3 contracts and replacement ADRs        | Complete |
|     1 | Prove direct OpenShell Workspace projection       | Next     |
|     2 | Rename Seats and epochs to Agents and generations | Pending  |
|     3 | Enforce explicit Role permissions                 | Pending  |
|     4 | Add policy-bound Model Profiles                   | Pending  |
|     5 | Add complete Workspace manifests                  | Pending  |
|     6 | Add Write Leases, Change Sets, and Candidates     | Pending  |
|     7 | Run read-only Agents from the shared Workspace    | Pending  |
|     8 | Run Implementers under Write Leases               | Pending  |
|     9 | Run authoritative Checks against Candidates       | Pending  |
|    10 | Run fresh Reviews against Candidates              | Pending  |
|    11 | Commit exact Candidates                           | Pending  |
|    12 | Add the trusted background Supervisor             | Pending  |
|    13 | Publish Plans into Run Workspaces                 | Pending  |
|    14 | Add the Pi-first cmux control surface             | Pending  |
|    15 | Complete v0.3 recovery and metrics                | Pending  |
|    16 | Remove the v0.2 source-transfer pipeline          | Pending  |
|    17 | Update onboarding and prove the generic flow      | Pending  |

## Phase 0 outcome

- accepted the [v0.3 Design](v0.3-design.md) and resolved its open choices;
- defined schema-version-2 [Core Contracts](contracts.md), including exact digest domains;
- recorded Agent, Supervisor, permission, Model Profile, direct Workspace, Write Lease, Candidate, Gate, and Plan-publication decisions;
- marked conflicting v0.2 ADRs as superseded while retaining their history;
- preserved current runtime behavior for a buildable migration baseline.

## Phase 1 proof gate

The direct-mount profile cannot be enabled until a live canary proves all of the following on the exact installed OpenShell, Docker driver, image, and policy versions:

1. the Run Workspace root is read-only;
2. one approved nested write root is writable only for the Lease holder;
3. sibling and protected paths remain read-only;
4. restricted paths reveal no original content;
5. another read-only Agent sees an allowed write;
6. `.git` is opaque and the real common Git directory is absent;
7. host state, home, credentials, sibling repositories, Docker socket, and SSH agent are absent;
8. unapproved network and host-local services are denied;
9. removing the writer Sandbox removes its writable mounts;
10. a frozen Candidate remains unchanged through read-only Check and Review mounts.

If the OpenShell adapter cannot enforce and inspect that mount shape, implementation returns to design review. It does not silently retain source archives as a v0.3 fallback.

## Later proof gates

### Writer gate

Before adapting Checks or Reviews, inspect one real generic-project Write Lease, actual mount table, complete before-and-after manifests, Change Set, and Candidate. Recovery from a terminated writer must attribute changes without a transcript and without cleaning the Workspace.

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
- deterministic Checks, independent Reviews, and human compare-and-swap commits;
- repository-aware planning, consultations, criticism, synthesis, metrics, and reporting;
- the standalone price-calculator example.

Source snapshots, derived images, implementation Patch Artifacts, reconstructed Check packages, and phase-oriented onboarding are migration inputs, not v0.3 target behavior.
