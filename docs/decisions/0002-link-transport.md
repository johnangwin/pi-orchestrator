# ADR 0002: Prove the Link over OpenShell service forwarding

## Status

Accepted

## Context

The v0.2 draft places `seatctl stream` behind `openshell sandbox exec`. OpenShell 0.0.106 non-interactive execution buffers stdin before starting the sandbox command, so it cannot carry an indefinitely open duplex stream. A delayed-input probe delivered both records only after the producer closed.

OpenShell provides a bidirectional TCP service-forward primitive from a host loopback listener to a sandbox-local TCP endpoint.

## Decision

The host core exposes a transport interface and does not assume an execution mechanism. The OpenShell adapter uses this design:

1. The Pi client extension listens on a sandbox-loopback TCP port.
2. The host opens an OpenShell service forward bound only to host loopback.
3. The Link carries versioned, bounded JSON messages over the forwarded connection.
4. Run, Seat, Session, epoch, and stable message IDs are validated at both ends.

`seatctl` is deferred until the Pi client protocol determines whether a separate diagnostic client remains useful.

## Spike result

The OpenShell 0.0.106 Docker spike passed:

- an explicit non-root Sandbox image reached `Ready`;
- command execution and file transfer succeeded;
- downloaded bytes matched the uploaded SHA-256 digest;
- unapproved outbound HTTP was denied;
- a Sandbox-loopback HTTP service was reachable through `forward service`;
- the host listener was bound only to `127.0.0.1`.

The macOS Homebrew gateway required an IPv4 loopback listener because Docker Desktop supplied an IPv4 `host.openshell.internal` callback. A gateway listening only on `[::1]` was healthy from the host but unreachable from the Sandbox supervisor.

The Link implementation must still prove bounded framing, reconnection, duplicate delivery, and stale-epoch rejection. Those are protocol tests, not reasons to leave the transport mechanism undecided.

## Security constraints

The Link never authorizes a state transition by itself. The host validates every request against current authoritative state. The forward must not expose a wildcard host listener or permit sandbox-initiated access to unrelated host services.
