# Pi Orchestrator

Pi Orchestrator is a standalone host control plane for approved, isolated Pi software-development runs.

The host owns authoritative state, Git integration, sandbox lifecycle, checks, reviews, and human gates. Model-driven Pi processes are disposable workers and never receive host state, host Git metadata, or ambient credentials.

## Invariants

- No Session transcript is a required dependency of another Session.
- Only the host Orchestrator may perform authoritative state transitions.
- No model-driven Pi process runs with host-user authority.
- Checks and Reviews are bound to exact Plan, source, and diff digests.

## Repository ownership

This repository contains the reusable host, Pi client extension, adapters, schemas, and sandbox assets. Consumer repositories such as Stepout contain their own `AGENTS.md`, `.agents/` configuration, Skills, Roles, Plans, Decisions, and registered Checks.

## Development

Requirements:

- Node.js 22.19 or newer
- OpenShell 0.0.106 for the current integration baseline
- cmux 0.64.22 for the current visible-Session baseline
- Docker Desktop or another OpenShell-supported compute driver
- Rust for native sandbox helpers added in later milestones

```sh
npm install
npm run typecheck
npm test
npm run build

# Opt-in integration test against the configured local OpenShell gateway
PI_ORCHESTRATOR_LIVE_OPENSHELL=1 npm test -- test/session.live.test.ts

# Disposable workspace plus local fake model; no remote inference or API key
PI_ORCHESTRATOR_LIVE_INFERENCE=1 npm test -- test/inference.live.test.ts

# Real Sandbox file export and host-side Artifact import
PI_ORCHESTRATOR_LIVE_ARTIFACT=1 npm test -- test/artifact.live.test.ts

# Read-only cmux version and capability probe; run from a cmux terminal
PI_ORCHESTRATOR_LIVE_CMUX=1 npm test -- test/cmux.live.test.ts
```

The host-side state and validation core is complete. The OpenShell adapter verifies an exact CLI version and authenticated, version-matched gateway, owns typed Sandbox lifecycle and transfer operations, and starts loopback-only service forwards. Downloaded Artifacts are bound to exact Session and Sandbox provenance, independently verified, schema-checked, and atomically stored as non-executable files. The committed `read`, `write`, and `check` profiles pass automated isolation canaries in fresh Sandboxes.

The first live Session path is also implemented. It creates an exact committed Git snapshot, builds a per-Session image from the pinned Pi 0.84.2 runtime, starts directly under the `read` policy, loads the sandbox client extension, and establishes an authenticated, epoch-bound Link that survives host reconnection. Logical model aliases resolve to exact OpenShell gateways and models; Pi calls only `inference.local`, and bounded completion events return through the Link.

Run state now includes a durable Seat and Session registry. It serializes lifecycle mutations, retains contiguous Session history, atomically allocates monotonic replacement epochs, rejects stale identities, and preserves immutable OpenShell Sandbox provenance across host restarts.

The cmux host adapter now verifies an exact CLI and capability set, creates retriable Run Workspaces and Seat Panes from durable operation identities, launches trusted command arrays without a host shell, and reports UI drift through read-only reconciliation. Missing panes remain operational failures, never evidence that workflow work completed.

Host Mailbox routing now resolves Seat-addressed Messages to the authoritative current Session and epoch before persistence, advances them only after a valid Link acknowledgement, and redelivers pending work after same-Session reconnection. Delivery failures leave Messages durable and mark the Session disconnected; replacement epochs never inherit old pending Messages implicitly.

Visible Session lifecycle is now recoverable across host restarts. Run state durably binds cmux creation operations, Pane intents, and UUID handles to the exact Session epoch. The reconciler compares Seat, Session, OpenShell Sandbox, Link, and cmux state; it can rebuild a Link from immutable Sandbox input, reattach a missing Pane with a new operation ID, or perform ordered Session replacement. Replacement verifies Sandbox provenance before side effects, closes the old epoch to new delivery, removes external resources, supersedes its pending Messages, and advances the epoch last.

An approved Plan can now start a durable Run with an isolated host Git worktree. The host records the exact base commit, reserved branch, and canonical worktree path before Git mutation, then verifies repository identity, branch ownership, `HEAD`, and cleanliness on every retry. It never resets, cleans, stashes, or deletes unexpected worktree content.

## OpenShell

Install or update the macOS Homebrew package, restart the matching gateway, and run the repository preflight:

```sh
brew update
brew upgrade nvidia/openshell/openshell
brew services restart openshell
orchestrator doctor
orchestrator canary
```

`orchestrator doctor` fails closed when the CLI differs from `openshell.required_version`, the gateway is unavailable or unauthenticated, or the gateway and CLI versions differ. `orchestrator canary` then verifies the actual Sandbox profiles and removes every disposable Sandbox. Update `.pi/orchestrator.local.yaml` deliberately after a new OpenShell version passes both commands; do not use `latest` as the configured version.

On macOS with the Docker driver, sandbox containers must be able to call the host gateway over IPv4. The proven loopback-only gateway setting is:

```toml
[openshell]
version = 1

[openshell.gateway]
bind_address = "127.0.0.1:17670"
```

After changing `/opt/homebrew/var/openshell/gateway.toml`, restart the service and rerun `orchestrator doctor`. See [OpenShell Integration](docs/openshell.md) for the probe and troubleshooting details.

## Initial CLI

```sh
# In a consumer repository
orchestrator init . --project-id stepout

# After defining registered Checks and a Plan
orchestrator validate strategy-boundary
orchestrator approve strategy-boundary
orchestrator start strategy-boundary
orchestrator status
orchestrator doctor
orchestrator canary
```

Runtime state defaults to `~/.local/share/pi-orchestrator` and may be redirected with `ORCHESTRATOR_HOME` or the command-level `--home` option.

`orchestrator start` uses `worktrees.root` from `.pi/orchestrator.local.yaml`, falling back to `<orchestrator-home>/worktrees` when that file is absent. The default Run ID is `<plan-id>-r<revision>`; pass `--run <id>` when a different stable identity is required.

See [Core Contracts](docs/contracts.md) for the structured formats and digest rules introduced by the standalone implementation.
See [cmux Integration](docs/cmux.md) for the control-socket and recovery contract.
