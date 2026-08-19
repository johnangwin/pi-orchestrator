# ADR 0005: Route Pi inference through OpenShell

## Status

Superseded by [ADR 0025](0025-permissions-model-profiles.md)

## Context

Model-driven Pi Sessions need inference without receiving provider credentials or broad network access. OpenShell exposes one managed `inference.local` route per gateway and workspace, while Project configuration refers only to stable logical model aliases.

## Decision

Machine-local configuration binds each logical alias to an OpenShell gateway alias, exact model ID, Pi API shape, locality, context window, and output limit. Session startup verifies that the selected gateway's current user-facing route names that exact model.

The Pi extension registers one Session-local provider targeting `inference.local`. Its API key is the literal placeholder `unused`; OpenShell removes it and supplies the real credential outside the Sandbox. The child environment admits only a validated OpenShell proxy URL, the fixed OpenShell CA path, and Node's proxy switch.

A model-routed read Session receives one immutable compiled Brief. Pi completion or failure is returned as a bounded Link event tied to the initiating Message IDs. The event is operational evidence, not a Report or Gate result.

## Consequences

Different simultaneously active model routes require separate OpenShell gateways. A gateway route mismatch prevents Session creation. Because `inference.local` bypasses ordinary network-policy evaluation, a future authoritative Check runner must use a dedicated gateway and workspace with no configured inference route; the host must verify that absence before launch. The Check profile remains free of Pi and provider credentials. Durable event handling and Report Artifact import remain host-Orchestrator responsibilities in later milestones.
