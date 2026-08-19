# Implementation Roadmap

## Milestone 1: Host core

- Project, configuration, Role, Skill, Plan, and Task validation
- Plan and approval digests
- Task transition rules
- Atomic filesystem state and single-writer ownership
- Message lifecycle directories
- immutable Reports
- deterministic Brief compilation
- initial host CLI

## Milestone 2: OpenShell substrate

- pinned versions and capability checks (complete)
- deterministic Git source snapshots and read-only Session initialization (complete)
- Artifact download and fail-closed host validation (complete)
- read, write, and Check profiles (complete)
- security canaries (complete for base profiles; rerun after every relevant upgrade)
- pinned Pi image and minimal client extension (complete for read-only Sessions)
- Link handshake, framing, authentication, deduplication, stale-epoch rejection, and reconnection (complete)
- inference gateway composition and model execution (complete for read-only Sessions)

## Milestone 3: Visible Sessions

- durable Seats, Sessions, and epochs (complete)
- cmux workspace and pane adapter (complete)
- durable Mailbox delivery and acknowledgements (complete)
- reconnection and replacement (complete)

## Milestone 4: One-Task vertical slice

- isolated Run worktree (complete)
- implementation snapshot and patch import (complete)
- scope, protected-path validation, and durable host patch application (complete)
- fresh deterministic Check (complete)
- fresh Review (complete)
- human commit (complete)

## Milestone 5: First-run onboarding

- operator-facing implementation command (complete)
- required-Checks command (complete)
- standalone price-calculator example generator (complete)
- install-first README and focused development guide (complete)
- live first-run exercise against configured models (pending)

## Milestone 6: Stepout proving run

- repository-aware planning and questionnaire (implementation complete; Stepout exercise pending)
- architecture and quantitative consultation (implementation complete; Stepout exercise pending)
- independent criticism and Lead Plan synthesis (implementation complete; Stepout exercise pending)
- all required Review Lenses (implementation complete; Stepout exercise pending)
- Handoff and terminated-Session recovery (implementation complete; Stepout exercise pending)
- project-agnostic Run metrics and reporting (implementation complete; Stepout exercise pending)
- Stepout proving-run retrospective (pending)
