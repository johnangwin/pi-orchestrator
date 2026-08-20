import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/registry.js";
import { RunStateSchema, ProjectStore, writeJsonAtomic } from "../src/state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-registry-test-"));
  roots.push(root);
  return root;
}

async function openStore(home: string): Promise<ProjectStore> {
  return ProjectStore.open({
    home,
    projectId: "fixture",
    projectRoot: "/project",
  });
}

async function writeEmptyRun(store: ProjectStore): Promise<void> {
  await store.writeRun({
    version: 2,
    id: "run-one",
    project_id: "fixture",
    plan_id: "fixture-plan",
    plan_revision: 1,
    plan_digest: "sha256:plan",
    base_commit: "0123456789abcdef",
    branch: "orchestrator/run-one",
    worktree: "/worktrees/run-one",
    status: "ready",
    tasks: {},
    created_at: "2026-08-17T12:00:00.000Z",
    updated_at: "2026-08-17T12:00:00.000Z",
  });
}

function clock(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 7, 17, 12, 0, seconds++));
}

async function activeRegistry(store: ProjectStore): Promise<{
  registry: AgentRegistry;
  identity: {
    run: string;
    agent: string;
    session: string;
    generation: number;
  };
}> {
  const registry = new AgentRegistry(store, "run-one", clock());
  await registry.register({ agent: "lead", role: "lead", model: "plan" });
  const session = await registry.start({
    agent: "lead",
    session: "session-one",
  });
  await registry.transition(session.identity, { status: "active" });
  return { registry, identity: session.identity };
}

describe("durable Agent and Session registry", () => {
  it("persists the Agent roster and survives host restart", async () => {
    const home = await temporaryHome();
    let store = await openStore(home);
    await writeEmptyRun(store);

    const initial = await store.readRun("run-one");
    expect(initial.agents).toEqual({});
    expect(initial.sessions).toEqual({});

    const registry = new AgentRegistry(store, "run-one", clock());
    await registry.register({
      agent: "implementer",
      role: "implementer",
      model: "code",
    });
    const started = await registry.start({
      agent: "implementer",
      session: "session-one",
    });
    expect(started.identity).toEqual({
      run: "run-one",
      agent: "implementer",
      session: "session-one",
      generation: 1,
    });
    await store.close();

    store = await openStore(home);
    try {
      const recovered = await new AgentRegistry(store, "run-one").get(
        "implementer",
      );
      expect(recovered.record).toMatchObject({
        role: "implementer",
        model: "code",
        session: "session-one",
        generation: 1,
      });
      expect(recovered.session).toEqual(started);
    } finally {
      await store.close();
    }
  });

  it("rejects unfinished version-one Run state without migrating it", async () => {
    const home = await temporaryHome();
    const store = await openStore(home);
    try {
      await writeEmptyRun(store);
      const current = await store.readRun("run-one");
      const { agents: _agents, ...legacy } = current;
      await writeJsonAtomic(
        path.join(store.runDirectory("run-one"), "state.json"),
        { ...legacy, version: 1, seats: {} },
      );

      await expect(store.readRun("run-one")).rejects.toMatchObject({
        code: "unsupported_state_version",
        message: expect.stringContaining("unfinished v0.2 Runs"),
      });
    } finally {
      await store.close();
    }
  });

  it("enforces lifecycle transitions and immutable Sandbox binding", async () => {
    const home = await temporaryHome();
    const store = await openStore(home);
    try {
      await writeEmptyRun(store);
      const registry = new AgentRegistry(store, "run-one", clock());
      await registry.register({ agent: "scout", role: "scout", model: "fast" });
      const started = await registry.start({
        agent: "scout",
        session: "session-one",
      });
      const sandbox = {
        id: "43502221-db6b-49f2-a316-673792b3faae",
        name: "pio-scout-one",
        workspace: "default",
      };

      await expect(
        registry.bindSandbox(started.identity, sandbox),
      ).resolves.toMatchObject({ sandbox });
      await expect(
        registry.bindSandbox(started.identity, sandbox),
      ).resolves.toMatchObject({ sandbox });
      await expect(
        registry.bindSandbox(started.identity, {
          ...sandbox,
          id: "53502221-db6b-49f2-a316-673792b3faae",
        }),
      ).rejects.toMatchObject({ code: "sandbox_conflict" });

      await expect(
        registry.transition(started.identity, { status: "waiting" }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await registry.transition(started.identity, { status: "active" });
      await registry.transition(started.identity, { status: "waiting" });
      await registry.transition(started.identity, {
        status: "disconnected",
      });
      await registry.transition(started.identity, { status: "active" });
      const stopped = await registry.transition(started.identity, {
        status: "stopped",
        reason: "Task completed",
      });
      expect(stopped).toMatchObject({
        status: "stopped",
        termination_reason: "Task completed",
      });
      expect(stopped.ended_at).not.toBeNull();
      await expect(
        registry.transition(started.identity, {
          status: "stopped",
          reason: "Task completed",
        }),
      ).resolves.toEqual(stopped);
      await expect(
        registry.transition(started.identity, {
          status: "stopped",
          reason: "Different reason",
        }),
      ).rejects.toMatchObject({ code: "session_transition_conflict" });
      await expect(
        registry.transition(started.identity, { status: "active" }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      await store.close();
    }
  });

  it("allocates one monotonic generation under concurrent replacement retries", async () => {
    const home = await temporaryHome();
    const store = await openStore(home);
    try {
      await writeEmptyRun(store);
      const { registry, identity } = await activeRegistry(store);
      const attempts = await Promise.allSettled([
        registry.replace({
          expected: identity,
          session: "session-two",
          reason: "Context handoff",
        }),
        registry.replace({
          expected: identity,
          session: "session-three",
          reason: "Competing replacement",
        }),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);

      const current = (await registry.get("lead")).session!;
      expect(current.identity.generation).toBe(2);
      expect(current.replaces).toMatchObject({ session: "session-one" });
      const reason = current.replaces!.reason;
      const beforeRetry = await store.readRun("run-one");
      const retryMarker = "2026-08-18T00:00:00.000Z";
      await store.writeRun({ ...beforeRetry, updated_at: retryMarker });
      await expect(
        registry.replace({
          expected: identity,
          session: current.identity.session,
          reason,
        }),
      ).resolves.toEqual(current);
      expect((await store.readRun("run-one")).updated_at).toBe(retryMarker);

      const state = await store.readRun("run-one");
      expect(Object.keys(state.sessions)).toHaveLength(2);
      expect(state.sessions["session-one"]).toMatchObject({
        status: "stopped",
      });
      await expect(registry.requireCurrent(identity)).rejects.toMatchObject({
        code: "stale_session",
      });
      await expect(
        registry.transition(identity, {
          status: "failed",
          reason: "Late event",
        }),
      ).rejects.toMatchObject({ code: "stale_session" });
      await expect(
        registry.replace({
          expected: { ...identity, run: "other-run" },
          session: current.identity.session,
          reason,
        }),
      ).rejects.toMatchObject({ code: "stale_session" });
    } finally {
      await store.close();
    }
  });

  it("fails closed on broken Session history", async () => {
    const home = await temporaryHome();
    const store = await openStore(home);
    try {
      await writeEmptyRun(store);
      const { registry, identity } = await activeRegistry(store);
      await registry.replace({
        expected: identity,
        session: "session-two",
        reason: "Context handoff",
      });
      const valid = await store.readRun("run-one");

      const nonterminalHistory = structuredClone(valid);
      nonterminalHistory.sessions["session-one"] = {
        ...nonterminalHistory.sessions["session-one"]!,
        status: "active",
        termination_reason: null,
        ended_at: null,
      };
      expect(RunStateSchema.safeParse(nonterminalHistory).success).toBe(false);

      const missingGeneration = structuredClone(valid);
      missingGeneration.agents.lead!.generation = 3;
      missingGeneration.sessions["session-two"]!.identity.generation = 3;
      expect(RunStateSchema.safeParse(missingGeneration).success).toBe(false);

      const danglingCurrent = structuredClone(valid);
      delete danglingCurrent.sessions["session-two"];
      await writeJsonAtomic(
        path.join(store.runDirectory("run-one"), "state.json"),
        danglingCurrent,
      );
      await expect(store.readRun("run-one")).rejects.toMatchObject({
        code: "invalid_state",
      });
    } finally {
      await store.close();
    }
  });
});
