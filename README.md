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
```

The host-side state and validation core is complete. The OpenShell adapter verifies an exact CLI version and authenticated, version-matched gateway, owns typed Sandbox lifecycle and transfer operations, and starts loopback-only service forwards. The committed `read`, `write`, and `check` profiles pass automated isolation canaries in fresh Sandboxes.

The first live Session path is also implemented. It creates an exact committed Git snapshot, builds a per-Session image from the pinned Pi 0.84.2 runtime, starts directly under the `read` policy, loads the sandbox client extension, and establishes an authenticated, epoch-bound Link that survives host reconnection. Logical model aliases resolve to exact OpenShell gateways and models; Pi calls only `inference.local`, and bounded completion events return through the Link.

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
orchestrator status
orchestrator doctor
orchestrator canary
```

Runtime state defaults to `~/.local/share/pi-orchestrator` and may be redirected with `ORCHESTRATOR_HOME` or the command-level `--home` option.

See [Core Contracts](docs/contracts.md) for the structured formats and digest rules introduced by the standalone implementation.
