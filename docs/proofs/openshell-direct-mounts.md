# OpenShell Direct-Mount Proof

- **Date:** 2026-08-19
- **Status:** Rejected and superseded
- **Environment:** macOS, Docker Desktop
- **OpenShell CLI and gateway:** 0.0.106
- **Docker driver:** 29.5.2
- **Evidence digest:** `sha256:ce8a4dca57139c2f6a1bdf4caa06edc360709b44a533dbd660cf16e01aec8a8b`

## Implemented proof surface

The host now has a typed, immutable mount capability that:

- accepts canonical sources only beneath configured Workspace roots;
- fixes all destinations beneath `/workspace/project`;
- mounts the Workspace root read-only and only approved Task roots read-write;
- masks `.git`, restricted files, and restricted directories with Orchestrator-owned sentinels;
- rejects symlink traversal, overlapping write and mask roots, duplicate targets, remote gateways, and unexpected driver versions;
- inspects `/proc/self/mountinfo` before evaluating Sandbox behavior;
- uses two fresh Sandboxes over the same host Workspace and verifies cleanup;
- remains unavailable to ordinary Sessions.

## Live result

The writer and reader mount tables contained exactly their compiled targets and access modes:

| Evidence              | Digest                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Probe image context   | `sha256:e5fead777d46cacaef529a001d221a2686d370ff1d1886df4a6c689d8a546be8` |
| Resolved OCI image    | `sha256:db5bb575cc779ffd0f9fa95d665191e78e502b588f76a827e7ebc156a85d0867` |
| Read policy           | `sha256:a7a0d820cfc55fd78e9c484b18227c07aa228328ee69892c148ef3d408dd4604` |
| Write policy          | `sha256:9c49d607249673d2f0ac6837f5402bbbfdfe29d9d8f3d6273449bca1dc92d5b6` |
| Writer mount set      | `sha256:f7cea1a349952bb12151014cb552205bf37f0fc9cefccc1ee7146b18ab14cbe7` |
| Reader mount set      | `sha256:16fc1ab83dd78d50bcb4e701e5bcb2896ff6d10a1936b154f4eee28373ba4103` |
| Observed writer table | `sha256:85f5450232148f374c5a6a0726711344181a8cedd8b03d41beccb5aef93c7cc5` |
| Observed reader table | `sha256:e0546763e7a9f61a5cc6994d548758d5575b47ef7dbc5508eed196d9247746fe` |

Thirty of 42 assertions passed. Process identity, mount modes, sibling and protected write denial, host isolation, credential isolation, network denial, privileged-mount denial, writer removal, and final Sandbox cleanup all passed.

The Workspace, nested write root, and opaque sentinels were inaccessible to the restricted child. Consequently, source reads, allowed writes, mask readability, and cross-Sandbox visibility failed.

## Diagnosis

Docker Desktop exposes macOS bind mounts inside the Linux VM as the `fakeowner` filesystem. OpenShell's hard Landlock policy accepts the mount target rule but denies child access to content on these mounts. Explicit rules for the root, nested directories, and individual files produced the same result.

This matches the pinned OpenShell source: its bind-mount E2E test deliberately validates driver wiring without Landlock over Docker Desktop `fakeowner` mounts. See the [v0.0.106 test](https://github.com/NVIDIA/OpenShell/blob/v0.0.106/e2e/rust/tests/driver_config_volume.rs#L267-L269) and [Docker driver contract](https://github.com/NVIDIA/OpenShell/blob/v0.0.106/crates/openshell-driver-docker/README.md#driver-config-mounts).

Disabling Landlock makes Docker's read-only and nested read-write mounts usable, but that weakens an accepted isolation rule and is not an implementation fix.

## Gate decision

The host-bind design does not pass and remains disabled. It was replaced by ADR 0030 and the passing [OpenShell Workspace-Volume Proof](openshell-workspace-volume.md).

Hard Landlock remains required. Host bind mounts are not part of the accepted v0.3 Workspace path.
