# ADR 0023: First-run project and explicit execution commands

## Status

Accepted

## Context

The host already implemented write Sessions, verified Patch import, authoritative Checks, Reviews, and human commits, but these primitives were not composed into a complete operator-visible CLI path. The README therefore jumped from Run creation directly to Review, and the only named proving Project was Stepout.

An onboarding Project must be small, deterministic, independent of Stepout, and meaningful enough to exercise Architecture and Quant reasoning. It must also run without dependency installation or network access inside a Check Sandbox.

## Decision

Expose two explicit host commands:

```text
orchestrator implement <task>
orchestrator check <task>
```

The implementation command owns one isolated model turn, structured implementation Report, Patch export and import, host application, and Session cleanup. The Check command runs the Task's registered Checks in Plan order and stops on the first failure. Existing `review` and `commit` commands retain their independent gates.

Ship `examples/price-calculator` and `orchestrator example [directory]`. The command copies the template into a new directory, generates standard Roles and Skills, registers `node --test`, installs a machine-local configuration template or an explicitly supplied configuration, initializes Git, and creates one baseline commit. It never modifies or runs the template in place.

The example's supplied Plan adds integer percentage discounts to an integer-cents calculation. This keeps the source small while making rounding order, safe arithmetic, boundary validation, and Quant Review material.

## Consequences

A new user can exercise the complete host workflow without Stepout. The README can describe one exact path rather than internal milestones or test harnesses. The sample requires only the Node.js runtime already present in the pinned Check image.

The explicit phase commands are intentionally narrow. A later long-running scheduler may advance ready Tasks automatically while preserving these commands as retriable operator boundaries.
