# Pi Orchestrator

Pi Orchestrator is a host control plane for approved, isolated Pi software-development runs. The host owns workflow state, Git, Sandboxes, Checks, Reviews, and human gates; model-driven Sessions are disposable workers without host credentials or Git metadata.

Version 0.3 is under active migration. Push, merge, deployment, release, and production access are intentionally unavailable.

## Install

Requirements:

- Node.js 22.19 or newer
- OpenShell 0.0.106 for the current integration baseline
- cmux 0.64.22 for visible Session support
- Docker Desktop or another OpenShell-supported compute driver

Install the CLI from this repository:

```sh
git clone https://github.com/johnangwin/pi-orchestrator.git
cd pi-orchestrator
npm ci
npm run build
npm link
orchestrator --version
```

Install or update OpenShell on macOS:

```sh
brew update
brew install nvidia/openshell/openshell
brew upgrade nvidia/openshell/openshell
brew services restart openshell
```

Pi Orchestrator deliberately pins the OpenShell version used by a Project. A newer installation must be tested and then recorded as `openshell.required_version`; the configured value must never be `latest`.

## First Run

Create the standalone price-calculator Project. It is copied outside this repository, initialized with Git, and includes a valid one-Task Plan and zero-dependency tests.

```sh
orchestrator example ~/pi-orchestrator-first-run
cd ~/pi-orchestrator-first-run
node --test
```

Edit `.pi/orchestrator.local.yaml` so its gateway names and model routes match your OpenShell installation. You can instead copy an existing valid configuration while creating the Project:

```sh
orchestrator example ~/pi-orchestrator-first-run \
  --config /path/to/orchestrator.local.yaml
```

Verify the host and Sandbox boundary:

```sh
orchestrator doctor
orchestrator canary
```

Run the supplied `percentage-discount` Plan:

```sh
orchestrator validate percentage-discount
orchestrator approve percentage-discount
orchestrator start percentage-discount

orchestrator implement add-discount
orchestrator check add-discount
orchestrator review add-discount
orchestrator commit add-discount

orchestrator metrics percentage-discount-r1
orchestrator report percentage-discount-r1
orchestrator status
```

`approve` and `commit` require explicit human confirmation. Authoritative Checks run in fresh no-inference Sandboxes, every Review Lens receives a fresh read-only Session, and the commit is created only in the isolated Run worktree.

Runtime state defaults to `~/.local/share/pi-orchestrator`. Set `ORCHESTRATOR_HOME` or use `--home` to choose another location.

Project and machine-local configuration now use schema version 2. Version-one configuration and unfinished runtime state are intentionally rejected rather than migrated implicitly.

## Existing Project

Initialize committed Project configuration in an existing clean Git repository:

```sh
orchestrator init . --project-id my-project
cp .pi/orchestrator.local.yaml.example .pi/orchestrator.local.yaml
```

Then:

1. Document repository constraints in `AGENTS.md`.
2. Register deterministic Check argv arrays in `.agents/orchestrator.yaml`.
3. Configure Role routing policy in `.agents/orchestrator.yaml` and matching machine-local Model Profiles in `.pi/orchestrator.local.yaml`.
4. Add or generate a version-two Plan under `docs/plans/<plan-id>/`; every Task declares literal `write_paths` separately from semantic `scope` globs.
5. Run the same validate, approve, start, implement, check, review, and commit sequence used by the example.

For repository-aware Plan generation:

```sh
orchestrator plan "Describe the intended change" --id change-planning
orchestrator answer change-planning
orchestrator consult change-planning
orchestrator draft change-planning
```

The generated draft remains outside the Project until a human reviews and places it under `docs/plans/`. Drafting does not approve a Plan or create a Run.

## Security Model

- No Session transcript is a required dependency of another Session.
- Only the host Orchestrator performs authoritative state transitions.
- Every Agent Session receives a digest-bound Role permission ceiling; omitted and unknown authority is denied.
- Every Agent selects a policy-approved Model Profile, and every Session freezes the exact resolved route and locality under a digest.
- No model-driven Pi process runs with host-user authority.
- Sandboxes receive allowlisted source and environment data, never host state or ambient credentials.
- Complete Workspace manifests cover tracked, untracked, and ignored entries; scrubbed Git status separately identifies committable changes.
- Checks and Reviews are bound to exact Plan, source, and diff digests.
- Human approval is required for Plans, protected scope changes, Gate waivers, and commits.

OpenShell policies fail closed. Run `orchestrator canary` after relevant OpenShell, image, runtime, or policy upgrades.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

See [Development](docs/development.md) for opt-in live integration tests, [OpenShell Integration](docs/openshell.md) for gateway setup and troubleshooting, [Core Contracts](docs/contracts.md) for durable formats, and [Roadmap](docs/roadmap.md) for implementation status.
