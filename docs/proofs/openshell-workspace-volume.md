# OpenShell Workspace-Volume Proof

- **Date:** 2026-08-19
- **Status:** Passed
- **Environment:** macOS, Docker Desktop
- **OpenShell CLI and gateway:** 0.0.106
- **Docker driver:** 29.5.2
- **Evidence digest:** `sha256:7eed6ad72df1c6f7cd8e7db9e3f36ece9c793b4277e5ddffd6f79b3cadc1f656`

## Proven surface

The trusted controller created and inspected one plain labeled Docker named volume, seeded Supervisor-only and Project subpaths, and projected the same `project` subtree into one writer and one reader through OpenShell.

The writer received:

```text
/workspace/project                 read-only
/workspace/project/task            read-write
/workspace/project/task/protected  read-only
restricted file mask               read-only
restricted directory mask          read-only
```

The reader received the same root, protected path, and masks read-only. Both mount tables used native `ext4`, not Docker Desktop `fakeowner`.

## Evidence

| Evidence              | Digest                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Probe image context   | `sha256:4e80c1d14bef855b34497cfc7c27c7e100da06174586c68429a0dfba1aeb409d` |
| Read policy           | `sha256:a7a0d820cfc55fd78e9c484b18227c07aa228328ee69892c148ef3d408dd4604` |
| Write policy          | `sha256:9c49d607249673d2f0ac6837f5402bbbfdfe29d9d8f3d6273449bca1dc92d5b6` |
| Writer mount set      | `sha256:b22b3fadbaee21b8123413482198ceec21e013af6474529427c592959a0b6cfb` |
| Reader mount set      | `sha256:8be8c837dd38ff924b6dd31fccaf960ce40db91b6718a8d49e00104b938fdfa2` |
| Observed writer table | `sha256:fdedf273dfc0c17c708a7b89dfdf6e023f3fa405ae5b64223c3fdf234390062f` |
| Observed reader table | `sha256:8a3c1e0ea4965364675935a08ebf325cb8821146cb33349d41fa690d92fe574a` |

All 44 assertions passed. They cover process identity, exact mount modes, narrow create/replace/rename/delete access, sibling and protected write denial, restricted masks, Git absence, shared visibility before and after writer removal, host and credential isolation, network denial, privileged-mount denial, trusted-controller visibility, Sandbox cleanup, and volume cleanup.

## Gate decision

Phase 1 passes. The shared named-volume substrate may be used by later v0.3 phases without host bind mounts or weakened Landlock policy. The canary remains version-bound and must be rerun after relevant OpenShell, Docker, image, or policy changes.
