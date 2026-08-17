# ADR 0001: Implement the Orchestrator as a standalone repository

## Status

Accepted

## Context

The v0.2 design originally described an Orchestrator embedded under `tools/orchestrator/` in the first consumer repository and extracted after the Stepout proving run. This repository already exists specifically to own the reusable Orchestrator.

## Decision

The host Orchestrator, Pi client extension, schemas, adapters, sandbox policies, and native helpers live in this repository from the first implementation.

Consumer repositories own only project knowledge and configuration:

- `AGENTS.md`
- `.agents/orchestrator.yaml`
- `.agents/roles/`
- `.agents/skills/`
- `docs/plans/`
- `docs/decisions/`
- `.pi/orchestrator.local.yaml`

Runtime state remains outside both repositories.

## Consequences

Stepout can exercise the actual reusable package instead of a later extraction. Consumer-specific assumptions must not enter the host core. Integration tests use fixture projects until the Stepout checkout is available.
