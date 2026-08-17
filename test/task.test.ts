import { describe, expect, it } from "vitest";
import { canTransitionTask, transitionTask } from "../src/task.js";

describe("Task transitions", () => {
  it("allows the bounded implementation path", () => {
    expect(transitionTask("pending", "ready")).toBe("ready");
    expect(transitionTask("ready", "active")).toBe("active");
    expect(transitionTask("active", "checking")).toBe("checking");
    expect(transitionTask("checking", "reviewing")).toBe("reviewing");
    expect(transitionTask("reviewing", "accepted")).toBe("accepted");
  });

  it("keeps terminal states terminal", () => {
    expect(canTransitionTask("accepted", "ready")).toBe(false);
    expect(() => transitionTask("accepted", "ready")).toThrowError(
      /cannot transition/,
    );
  });
});
