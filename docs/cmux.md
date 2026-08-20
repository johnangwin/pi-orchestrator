# cmux Integration

The current integration baseline is cmux 0.64.22. The adapter uses cmux's JSON scripting interface and stable UUID identifiers for Workspaces, Panes, and Surfaces.

## Local configuration

Configure the bundled CLI explicitly on macOS so launch behavior does not depend on `PATH`:

```yaml
cmux:
  command: /Applications/cmux.app/Contents/Resources/bin/cmux
  required_version: "0.64.22"
  workspace_prefix: orchestrator
```

After upgrading cmux, update `required_version` only after the adapter tests and live preflight pass against the new build. A version mismatch fails before any control-socket operation.

## Control authority

cmux injects its socket path, password, Workspace ID, and Surface ID into terminals that it creates. The Orchestrator inherits those values when it runs in the trusted control pane. It does not copy them into local configuration, logs, a Sandbox, a Brief, or a model-facing command.

Running a socket operation from an ordinary Terminal process fails with `cmux_access_denied`. Start the Orchestrator inside cmux instead of weakening socket authentication.

From a cmux-created terminal, run the non-mutating live probe with:

```sh
PI_ORCHESTRATOR_LIVE_CMUX=1 npm test -- test/cmux.live.test.ts
```

## Durable handles

The adapter uses these host-side records:

```text
Run Workspace  operation UUID + Workspace UUID + expected title
Agent Pane     operation UUID + Workspace UUID + Pane UUID + Surface UUID + expected title
Pane intent    operation UUID + Workspace UUID + expected title + prior Pane UUIDs
```

Workspace creation uses cmux's native operation UUID. A Pane intent must be written to authoritative state before `ensurePane` is allowed to create an unbound Pane. This lets a retry identify exactly one Pane created after the intent, including interruption between Pane creation and title assignment.

The Run state store owns those operations, intents, and returned bindings. Pane records also carry the exact Run, Agent, Session, and generation, so a stale Pane must be removed before Session replacement can advance the Agent generation.

An existing binding is authoritative. If its target is missing, the adapter reports drift and does not silently create a replacement. Reconciliation is read-only, and a missing pane never means that a Task finished.

The lifecycle layer may reattach a missing Pane only after that observation and with a new operation UUID. It may clear a stale Pane binding without a close when the entire bound Workspace is already absent. Title drift is repairable, but titles never substitute for UUID ownership.

## Process launch

Node invokes the cmux CLI with `execFile` argument arrays, so cmux parameters do not pass through a host shell. Commands intentionally launched inside a new terminal are accepted only as argument arrays and quoted as POSIX shell data before cmux supplies them to that terminal's shell. Launch arguments must not carry secrets.

The public contract follows the [official cmux CLI contract](https://github.com/manaflow-ai/cmux/blob/main/docs/cli-contract.md).
