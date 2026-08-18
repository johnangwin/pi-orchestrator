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
- Artifact download (typed transfer adapter complete; Artifact validation pending)
- read, write, and Check profiles (complete)
- security canaries (complete for base profiles; rerun after every relevant upgrade)
- pinned Pi image and minimal client extension (complete for read-only Sessions)
- Link handshake, framing, authentication, deduplication, stale-epoch rejection, and reconnection (complete)
- inference gateway composition and model execution (complete for read-only Sessions)

## Milestone 3: Visible Sessions

- durable Seats, Sessions, and epochs (schemas and live identity binding complete)
- cmux workspace and pane adapter
- durable Mailbox delivery and acknowledgements (wire protocol and client events complete)
- reconnection and replacement

## Milestone 4: One-Task vertical slice

- isolated Run worktree
- implementation snapshot and patch import
- scope and protected-path validation
- fresh deterministic Check
- fresh Review
- human commit

## Milestone 5: Stepout proving run

- repository-aware planning and questionnaire
- architecture and quantitative consultation
- all required Review Lenses
- Handoff and terminated-Session recovery
- metrics and retrospective
