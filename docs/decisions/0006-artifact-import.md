# ADR 0006: Import Artifacts through verified atomic staging

## Status

Accepted

## Context

The Link is intentionally limited to small structured records. Reports, patches, logs, manifests, and binary archives may exceed that limit and must cross the Sandbox boundary through OpenShell file transfer. A Sandbox and its output remain untrusted, so successful download alone cannot make content authoritative.

## Decision

A Session emits a strict Artifact descriptor through the Link. The descriptor identifies one canonical path derived from the Artifact ID and binds the content to its Run, optional Task, Seat, Session, and epoch.

The host selects a trusted content contract and performs these checks:

1. validate the descriptor and workflow binding;
2. verify the live Sandbox UUID, name, workspace, and ready state;
3. inspect the remote regular-file type, byte count, and SHA-256 digest;
4. download into a same-filesystem staging directory;
5. verify the Sandbox identity again;
6. independently verify the local file type, size, digest, and content schema;
7. write an authoritative provenance record and atomically publish both files.

Accepted payload and record files use mode `0400`. The Orchestrator stores them as data and never executes them.

## Consequences

Artifact import is idempotent only when content and provenance are identical. Reusing an ID with different data or provenance fails closed. Failed validation leaves no published Artifact. Content-specific modules provide contracts for formats such as Reports and, later, patches and Check logs without weakening the common import boundary.
