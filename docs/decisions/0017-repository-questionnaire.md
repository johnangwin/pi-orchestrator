# ADR 0017: Bind planning questionnaires to exact repository evidence

## Status

Accepted

## Context

Planning happens before a Plan can be approved, while an implementation Run exists only for an approved Plan revision. Reusing `RunState` for planning would either permit an unapproved Run or make Plan approval circular. At the same time, a questionnaire is useful only when the planning model has inspected the actual repository and asks about material choices the repository cannot resolve.

The planning boundary must therefore preserve exact source, Role, model, policy, Session, questionnaire, and human-answer provenance without treating a model transcript as durable context.

## Decision

`orchestrator plan <goal>` requires a clean tracked and untracked host checkout and resolves its exact `HEAD`. The host creates a deterministic Git archive of all tracked files at that commit; untracked files and Git metadata are absent. A fresh Lead Session receives that archive under the final OpenShell `read` profile, a goal-specific Brief, the Project instructions, selected Skills, and a strict structured output contract. The model must inspect `/workspace/project` before returning.

Pre-approval evidence lives under `$ORCHESTRATOR_HOME/projects/<project>/planning/<planning-id>/`, outside the Project and outside every Sandbox. This is host implementation state, not a new public workflow concept and not an implementation Run. The current Link identity schema requires a `run` correlation field, so a planning ID occupies that field for the disposable planning turn only; no `RunState`, branch, worktree, Task, or approval is created.

The accepted questionnaire contains a repository summary, current-structure observations, exact tracked-file source anchors, explicit assumptions, and zero to five questions. Each question has a stable descriptive ID, Project or eventual-Run scope, two to four materially different options, the main tradeoff for each, one recommendation, and mandatory free-form support. Unknown source anchors, extra prose, invalid JSON, truncation, wrong model identity, or more than five questions fail closed.

The host stores an immutable planning request and Brief before model execution. The questionnaire record binds the goal, base commit, source digest, Role, model route, read policy, Brief, Session identity, Sandbox provenance, final model response, and turn metadata through domain-separated digests. Only the structured final response is retained; the Pi transcript is not planning memory. An exact completed questionnaire is idempotently reused instead of launching another model turn.

`orchestrator answer <planning-id>` accepts every answer through a host TTY or an explicit JSON object. An answer may select an option or contain free-form text. Each response becomes an immutable Decision record binding the exact questionnaire and question digests, local accepting user, answer form, statement, rationale, scope, and timestamp. The planning state changes to `answered` only after every required Decision file exists and revalidates. Retrying an interrupted publication adopts only identical answers; a changed answer conflicts.

Repository, questionnaire, and Decision records are atomically replaced or immutably created while the Project's single-writer lease is held. A changed or dirty checkout makes prior planning evidence stale and requires a new planning ID rather than silently updating the source binding.

## Consequences

Planning can now ask concise repository-aware human questions without creating or approving a Plan, exposing the host checkout, or preserving a transcript. Later architecture, Quant, critic, and synthesis Sessions can consume the exact source anchors and accepted Decisions as durable inputs.

This increment does not yet produce `plan.md` or `tasks.yaml`, launch independent design alternatives, perform architecture or Quant consultation, project planning Sessions into cmux, or recover an abruptly orphaned planning Sandbox. Those remain later Milestone 5 work.
