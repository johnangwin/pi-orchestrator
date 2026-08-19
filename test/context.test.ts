import { describe, expect, it } from "vitest";
import {
  classifyContextPressure,
  parseContextPressureEvent,
  parseHandoffRequestEvent,
} from "../src/handoff.js";
import type { LinkEventFrame } from "../src/link.js";
import {
  contextPressureEvent,
  crossedHandoffThreshold,
  DEFAULT_CONTEXT_THRESHOLDS,
} from "../sandbox/pi/client/context.mjs";

const thresholds = {
  initial_fraction: 0.25,
  warn_fraction: 0.6,
  handoff_fraction: 0.75,
  stop_fraction: 0.85,
};

function frame(
  event: "context-pressure" | "handoff-requested",
  data: Record<string, unknown>,
): LinkEventFrame {
  return {
    version: 1,
    id: "event-one",
    identity: {
      run: "run-one",
      seat: "implementer",
      session: "session-one",
      epoch: 1,
    },
    type: "event",
    payload: { event, data },
  };
}

describe("context pressure", () => {
  it("uses the configured warning, Handoff, and stop boundaries", () => {
    expect(
      classifyContextPressure({ tokens: 59, contextWindow: 100 }, thresholds),
    ).toMatchObject({ level: "normal", mutating_phase_allowed: true });
    expect(
      classifyContextPressure({ tokens: 60, contextWindow: 100 }, thresholds),
    ).toMatchObject({ level: "warning", mutating_phase_allowed: true });
    expect(
      classifyContextPressure({ tokens: 75, contextWindow: 100 }, thresholds),
    ).toMatchObject({ level: "handoff", mutating_phase_allowed: true });
    expect(
      classifyContextPressure({ tokens: 85, contextWindow: 100 }, thresholds),
    ).toMatchObject({ level: "stop", mutating_phase_allowed: false });
  });

  it("matches the sandbox client calculation and ignores unknown usage", () => {
    expect(
      contextPressureEvent(
        { tokens: 75_000, contextWindow: 100_000 },
        DEFAULT_CONTEXT_THRESHOLDS,
      ),
    ).toEqual(
      classifyContextPressure(
        { tokens: 75_000, contextWindow: 100_000 },
        thresholds,
      ),
    );
    expect(
      contextPressureEvent(
        { tokens: null, contextWindow: 100_000 },
        DEFAULT_CONTEXT_THRESHOLDS,
      ),
    ).toBeNull();
  });

  it("recomputes untrusted client events under the host policy", () => {
    const pressure = classifyContextPressure(
      { tokens: 75, contextWindow: 100 },
      thresholds,
    );
    expect(
      parseContextPressureEvent(
        frame("context-pressure", pressure),
        thresholds,
        100,
      ),
    ).toMatchObject({ pressure: { level: "handoff" } });
    expect(
      parseHandoffRequestEvent(
        frame("handoff-requested", {
          source: "context-pressure",
          reason: "Context threshold crossed.",
          pressure,
        }),
        thresholds,
        100,
      ),
    ).toMatchObject({ request: { source: "context-pressure" } });

    expect(() =>
      parseContextPressureEvent(
        frame("context-pressure", { ...pressure, level: "normal" }),
        thresholds,
        100,
      ),
    ).toThrow("does not match the host model and policy");

    expect(crossedHandoffThreshold("warning", "handoff")).toBe(true);
    expect(crossedHandoffThreshold("handoff", "stop")).toBe(false);
    expect(crossedHandoffThreshold("normal", "normal")).toBe(false);
  });
});
