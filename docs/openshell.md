# OpenShell Integration

## Version contract

The machine-local file `.pi/orchestrator.local.yaml` pins the OpenShell release used by a Project:

```yaml
version: 1

openshell:
  command: /opt/homebrew/bin/openshell
  required_version: "0.0.106"
  workspace: default
```

Run `orchestrator doctor` before creating any Sandbox. The preflight requires:

- the configured executable to report the exact pinned semantic version;
- a connected and authenticated gateway;
- identical CLI and gateway versions.

An upgrade is a deliberate compatibility change: update OpenShell, restart its gateway, run the disposable probe, and only then update the Project pin.

Run the full isolation suite after preflight:

```sh
orchestrator canary
```

The command fails unless the version is pinned, all selected profiles pass, and every disposable Sandbox is removed. Use `--profile read` (or `write`/`check`) for a focused diagnostic run; the default is all three.

## macOS Docker callback

The Docker Sandbox supervisor calls the host gateway through `host.openshell.internal`. On the tested macOS/Homebrew installation, that name resolves to an IPv4 Docker Desktop host address, while the package initially listened only on IPv6 loopback. The result was a Sandbox stuck in provisioning because its supervisor could not fetch policy.

Configure `/opt/homebrew/var/openshell/gateway.toml` with an IPv4 loopback listener:

```toml
[openshell]
version = 1

[openshell.gateway]
bind_address = "127.0.0.1:17670"
```

Then run:

```sh
brew services restart openshell
orchestrator doctor
```

Do not bind the gateway to a wildcard address. Do not add undocumented configuration keys; OpenShell rejects unknown keys and the gateway must fail closed.

## Disposable probe

The probe image pins its Debian base by digest, includes a real `iproute2` implementation, declares a numeric non-root OCI user, and contains the trusted canary script. These properties are required by the Docker supervisor and isolation checks in the current baseline.

```sh
openshell sandbox create \
  --name pio-smoke \
  --from ./sandbox/probe \
  --no-tty \
  -- sh -lc 'id && printf smoke-ok'

openshell sandbox get pio-smoke --output json
openshell sandbox delete pio-smoke
```

Do not use a bare Alpine image for this probe. It has no non-root OCI `USER`, and BusyBox `ip` does not implement the network-namespace operations the supervisor needs.

The 0.0.106 spike verified:

- a Sandbox reaches `Ready` and executes as UID/GID 10001;
- `sandbox exec` streams output and preserves the remote exit status;
- upload/download preserves file bytes and SHA-256 digests;
- unapproved outbound HTTP is denied;
- `forward service` exposes a sandbox-loopback service only on an explicitly selected host-loopback listener.

The pinned Pi image uses Node 22.19.0 and `@earendil-works/pi-coding-agent` 0.84.2. It runs as UID/GID 10001, disables Pi telemetry and startup network operations, loads only the Orchestrator extension explicitly, and enables only Pi's read-oriented built-in tools for the initial Session slice. The daemon reconstructs an allowlisted child environment instead of passing the Sandbox environment through to Pi. For model-routed Sessions, that allowlist admits only OpenShell's validated HTTP proxy, fixed CA path, and Node proxy switch; provider credentials remain absent.

## Policy profiles

The base policies under `sandbox/policies/` share these rules:

- Landlock is a hard requirement;
- `/workspace/base` and `/workspace/input` are read-only;
- `/sandbox`, `/home/sandbox`, `/tmp`, and terminal device paths are writable;
- OpenShell token and client-key contents remain unreadable to the child process;
- the network policy map is empty.
- model-driven profiles may read OpenShell's public CA material under `/etc/openshell-tls`.

The `read` profile makes `/workspace/project` read-only. The `write` and `check` profiles make it writable. `inference.local` is handled by OpenShell before ordinary network-policy evaluation, so model traffic does not require an outbound endpoint entry. A network policy therefore cannot make an inference-routed gateway safe for authoritative Checks. The Check runner must use a dedicated gateway and workspace with no inference route, verify that absence before launch, and never launch Pi.

## Model routing

Machine-local configuration maps each stable logical alias to a gateway alias, exact model, Pi API shape, locality, and context limits. A configured OpenShell gateway exposes one active user-facing inference route, so aliases that must use different models concurrently must resolve to different gateways. The host verifies the route's model before creating a Sandbox and fails closed on an absent or mismatched route.

Pi registers a Session-local provider that targets only `inference.local`. OpenShell rewrites the requested model and injects its provider credential at the gateway. The compiled Brief is copied into `/workspace/input/brief.md`, made read-only before launch, and appended to Pi's system prompt.

The live test creates and deletes a disposable OpenShell workspace, provider, and inference route backed by a local fake OpenAI-compatible server. It proves real proxy/CA handling, model rewriting, Pi execution, completion events, and cleanup without using an external model:

```sh
PI_ORCHESTRATOR_LIVE_INFERENCE=1 npm test -- test/inference.live.test.ts
```

The profiles intentionally rely on the image's `USER 10001:10001`. OpenShell 0.0.106 retained supplementary group 0 when the equivalent identity was set through policy fields during the integration probe, so the loader rejects those overrides and the canary checks the complete group list.

Do not populate source under a writable policy and attempt to switch to `read`. OpenShell 0.0.106 rejects removal of live `read_write` paths. The host instead assembles a temporary derived-image context from the exact Git snapshot and starts the Sandbox under its final policy. See [ADR 0004](decisions/0004-session-snapshot.md).

The canary validates 23 lifecycle and isolation assertions per profile, including cleanup. Its JSON result binds each run to the CLI/gateway version and exact policy digest.

OpenShell Sandbox names are limited to 19 characters in this release. Generated names must reserve room for stable Run/Seat identity without exceeding that limit.

## Link consequence

Non-interactive `sandbox exec` buffers stdin until the input producer closes. A delayed-input test delivered all records to the remote command only after EOF, so it cannot carry an indefinitely open duplex `seatctl stream`. The host adapter explicitly closes stdin for ordinary one-shot commands to avoid deadlock.

The Link adapter will therefore use `openshell forward service`:

```text
host Orchestrator
      <-> 127.0.0.1:<ephemeral host port>
OpenShell gRPC service forward
      <-> 127.0.0.1:<sandbox port>
Pi client extension
```

The Link protocol uses authenticated, identity-bound, 64 KiB JSONL frames. Unit coverage verifies bounded framing, duplicate Message suppression, authentication, and stale-epoch rejection. The live Session test verifies a real Pi extension handshake and host reconnection through OpenShell forwarding:

```sh
PI_ORCHESTRATOR_LIVE_OPENSHELL=1 npm test -- test/session.live.test.ts
```

Durable Mailbox integration remains part of the visible-Session milestone. The Link now carries bounded unsolicited Session and model-turn events, but those events are not authoritative state.
