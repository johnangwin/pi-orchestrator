# ADR 0022: Derive Run reports from validated evidence

## Status

Accepted

## Context

The proving run needs measurements for model usage, cost, elapsed time, context pressure, Handoffs, attempts, Reviews, human involvement, Sandbox startup, Link failures, and Message latency. Most workflow facts already exist in authoritative state or immutable evidence stores, while transient operational measurements do not. Treating an independently mutable metrics database as another workflow authority would create reconciliation and trust problems.

Cost also cannot be inferred safely from a model name. Local routes may have no marginal price, remote rates change, and provider usage fields differ. A report must distinguish missing pricing from a real zero-dollar estimate.

## Decision

The host stores small immutable metric observations only for measurements that are not otherwise durable: model turns, Sandbox startup, Link failures, Message delivery, context pressure, and explicit human interventions. Observations use content-derived identities and digests. Session-bound observations carry the complete Run, Seat, Session, and epoch identity; Message observations bind the durable Message and its original creation time.

Run metrics are derived snapshots. The collector validates all observations against current durable identities and combines them with canonical Run state and validated Check, Review, Handoff, Report, Commit, Message, and Plan-approval evidence. Existing Review records supply model usage when no equivalent model-turn observation exists. A sorted evidence-set digest and canonical Run-state digest bind every result.

Provider usage is normalized into stable token categories while retaining the raw usage digest. Optional machine-local model pricing supplies USD rates per million input, output, cache-read, and cache-write tokens. Missing rates produce an unpriced turn, never an assumed zero cost. Model locality is recorded from the exact resolved route used for the turn.

The CLI exposes a non-mutating current snapshot through `orchestrator metrics <run>`. `orchestrator report <run>` publishes immutable, deterministic JSON and Markdown representations beneath host Run state. Report identity derives from the metrics digest, so publishing an exact snapshot is idempotent. Reports are evidence views and cannot satisfy workflow Gates.

## Consequences

Metrics remain project-agnostic and can be implemented and tested without running Stepout. Reports survive process and Session loss, contain no transcript, expose incomplete pricing coverage, and detect tampered evidence. Their values remain reproducible for a fixed Run state, evidence set, and observation time.

The generated retrospective section intentionally contains no conclusion. Stepout-specific evaluation answers, qualitative findings, and the final retrospective remain pending until the proving run is deliberately executed.
