import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeatRegistry } from "../src/registry.js";
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
    version: 1,
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
  registry: SeatRegistry;
  identity: {
    run: string;
    seat: string;
    session: string;
    epoch: number;
  };
}> {
  const registry = new SeatRegistry(store, "run-one", clock());
  await registry.register({ seat: "lead", role: "lead", model: "plan" });
  const session = await registry.start({
    seat: "lead",
    session: "session-one",
  });
  await registry.transition(session.identity, { status: "active" });
  return { registry, identity: session.identity };
}

describe("durable Seat and Session registry", () => {
  it("upgrades an older Run state and survives host restart", async () => {
    const home = await temporaryHome();
    let store = await openStore(home);
    await writeEmptyRun(store);

    const initial = await store.readRun("run-one");
    expect(initial.seats).toEqual({});
    expect(initial.sessions).toEqual({});

    const registry = new SeatRegistry(store, "run-one", clock());
    await registry.register({
      seat: "implementer",
      role: "implementer",
      model: "code",
    });
    const started = await registry.start({
      seat: "implementer",
      session: "session-one",
    });
    expect(started.identity).toEqual({
      run: "run-one",
      seat: "implementer",
      session: "session-one",
      epoch: 1,
    });
    await store.close();

    store = await openStore(home);
    try {
      const recovered = await new SeatRegistry(store, "run-one").get(
        "implementer",
      );
      expect(recovered.record).toMatchObject({
        role: "implementer",
        model: "code",
        session: "session-one",
        epoch: 1,
      });
      expect(recovered.session).toEqual(started);
    } finally {
      await store.close();
    }
  });

  it("enforces lifecycle transitions and immutable Sandbox binding", async () => {
    const home = await temporaryHome();
    const store = await openStore(home);
    try {
      await writeEmptyRun(store);
      const registry = new SeatRegistry(store, "run-one", clock());
      await registry.register({ seat: "scout", role: "scout", model: "fast" });
      const started = await registry.start({
        seat: "scout",
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

  it("allocates one monotonic epoch under concurrent replacement retries", async () => {
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
      expect(current.identity.epoch).toBe(2);
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

      const missingEpoch = structuredClone(valid);
      missingEpoch.seats.lead!.epoch = 3;
      missingEpoch.sessions["session-two"]!.identity.epoch = 3;
      expect(RunStateSchema.safeParse(missingEpoch).success).toBe(false);

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
