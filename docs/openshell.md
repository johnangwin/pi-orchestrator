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

The probe image includes a real `iproute2` implementation and declares a non-root OCI user. Both are required by the Docker supervisor in the current baseline.

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

OpenShell Sandbox names are limited to 19 characters in this release. Generated names must reserve room for stable Run/Seat identity without exceeding that limit.

## Link consequence

Non-interactive `sandbox exec` buffers stdin until the input producer closes. A delayed-input test delivered all records to the remote command only after EOF, so it cannot carry an indefinitely open duplex `seatctl stream`.

The Link adapter will therefore use `openshell forward service`:

```text
host Orchestrator
      <-> 127.0.0.1:<ephemeral host port>
OpenShell gRPC service forward
      <-> 127.0.0.1:<sandbox port>
Pi client extension
```

The forward proves transport availability only. Reconnection, bounded frames, duplicate IDs, stale epochs, and Link authorization remain protocol-level requirements.
