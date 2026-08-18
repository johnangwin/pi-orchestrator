# ADR 0003: Use the pinned image OCI identity

## Status

Accepted

## Context

OpenShell can obtain a Docker Sandbox identity from either policy `process` fields or the image's OCI `USER`. During the 0.0.106 integration run, setting both policy fields to UID/GID 10001 produced a child process with supplementary group `0`. Omitting the fields and using `USER 10001:10001` in the same image produced only group 10001.

Supplementary root-group membership is unnecessary and weakens the least-privilege boundary even when Landlock remains active.

## Decision

The current `read`, `write`, and `check` profiles omit `process`. Their pinned images MUST declare a numeric, non-root OCI user and group. The policy loader rejects process overrides for the 0.0.106 baseline.

The security canary MUST assert:

- UID 10001;
- primary group 10001;
- no supplementary group 0.

This decision must be reevaluated from a fresh canary result when OpenShell is upgraded. It is not a general claim that policy identity fields are permanently unusable.
