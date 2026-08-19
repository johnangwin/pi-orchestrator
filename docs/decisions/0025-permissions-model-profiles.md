# ADR 0025: Separate Role permissions from Model Profiles

## Status

Accepted

## Context

Version 0.2 combines broad `access` and `sandbox` labels with a model alias embedded in each Role. Those fields do not express the difference between source visibility, eligibility to write, Pi tools, and workflow actions. A fixed alias catalog also prevents one Project from naming several useful routes for the same Role.

Model capability must be selectable independently from authority. A frontier Lead, local Implementer, and independent Reviewer should be able to work concurrently without a stronger model receiving broader filesystem or workflow permissions.

## Decision

A Role declares Skills, lifetime, Brief needs, output contract, and explicit permissions for:

- source visibility;
- Write Lease eligibility;
- exposed Pi tools;
- typed Orchestrator actions.

Effective permission is the intersection of a hard-coded host ceiling, machine-local policy, Role permissions, Task or Review assignment, and current Run state. Unknown and omitted permissions are denied. The Supervisor validates every model-facing action even when the Pi client also hides or rejects it. No Role may receive Git, Sandbox lifecycle, cmux, credential, Gate, or human-approval authority.

Committed Project configuration defines descriptive logical Model Profiles and per-Role routing policy: one default, an allowed set, optional Review Focus overrides, and whether remote inference is allowed. Machine-local configuration resolves each profile to one exact OpenShell gateway, concrete Pi model, API shape, locality, context and output limits, and optional reasoning and accounting metadata.

An Agent stores its selected allowed Model Profile. Each Session freezes the exact resolved route and its digest. A human may select an allowed override. A Lead may request an allowed profile for a new Agent or bounded consultation, but a model cannot change its own profile.

A continuing Agent changes profiles only through explicit reconfiguration, a new Session generation, and a fresh Brief. Ordinary Handoffs retain the profile. Escalation normally creates a separate bounded consultation Agent. No fallback may silently change model, provider, gateway, API, or locality. Expanding inference egress from local to remote requires trusted human approval.

Provider credentials remain at the OpenShell gateway and never enter a Sandbox. Concurrent profiles use separate gateways when the installed OpenShell routing implementation permits only one managed model route per gateway.

## Consequences

Role files no longer contain `model`, `access`, or `sandbox`. Permission-ceiling and resolved-route digests become Session, Brief, Report, Review, Handoff, metrics, and recovery evidence.

Selecting a different or more capable model never expands source, tool, workflow, credential, Git, or human authority. A missing, disallowed, drifting, or locality-violating route fails closed before Session launch.

This decision supersedes ADR 0005.
