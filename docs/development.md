# Development

## Local verification

The default suite uses fakes for external process boundaries and does not require OpenShell, cmux, inference, or credentials.

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

## Live integration tests

Live tests are opt-in and use the machine-local `.pi/orchestrator.local.yaml`. Run only the boundary being evaluated:

```sh
# OpenShell lifecycle and Link
PI_ORCHESTRATOR_LIVE_OPENSHELL=1 npm test -- test/session.live.test.ts

# Shared named-volume substrate
PI_ORCHESTRATOR_LIVE_WORKSPACE_VOLUME=1 npm test -- test/proof.live.test.ts

# Static-image Pi Session over a read-only Workspace volume
PI_ORCHESTRATOR_LIVE_WORKSPACE_SESSION=1 npm test -- test/source.live.test.ts

# Disposable workspace and local fake model
PI_ORCHESTRATOR_LIVE_INFERENCE=1 npm test -- test/inference.live.test.ts

# Sandbox Artifact export and host import
PI_ORCHESTRATOR_LIVE_ARTIFACT=1 npm test -- test/artifact.live.test.ts

# Leased writable Session over the persistent Run volume
PI_ORCHESTRATOR_LIVE_IMPLEMENTATION=1 npm test -- test/implementation.live.test.ts

# Frozen Candidate in a fresh no-inference Check Sandbox
PI_ORCHESTRATOR_LIVE_CHECK=1 npm test -- test/check.live.test.ts

# Fresh Review Session over a frozen Candidate
PI_ORCHESTRATOR_LIVE_REVIEW=1 npm test -- test/review.live.test.ts

# cmux capability probe; run inside a cmux terminal
PI_ORCHESTRATOR_LIVE_CMUX=1 npm test -- test/cmux.live.test.ts
```

These tests may create disposable OpenShell Sandboxes, images, forwards, and Run worktrees. Each test owns cleanup, but interrupted runs should be followed by `orchestrator status`, OpenShell Sandbox inspection, and removal of resources whose labels identify the interrupted test.

## Release baseline

The pinned OpenShell, Pi, Node.js, cmux, image, client, and policy versions form one tested security baseline. After changing any member:

1. Run the default suite.
2. Run `orchestrator doctor`.
3. Run `orchestrator canary` for all profiles.
4. Run every affected live integration test.
5. Update the exact version or digest only after the boundary passes.
