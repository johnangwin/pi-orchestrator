import { describe, expect, it } from "vitest";
import { MAX_TURN_TEXT_BYTES, turnEvent } from "../sandbox/pi/client/turn.mjs";

const model = {
  alias: "fast" as const,
  pi_model: "local-small",
  api: "openai-completions" as const,
  context_window: 32768,
  max_tokens: 4096,
  reasoning: false,
};

describe("Pi turn events", () => {
  it("returns bounded assistant text and usage bound to Message IDs", () => {
    expect(
      turnEvent(["msg-one"], model, {
        role: "assistant",
        model: "local-small",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 10, output: 2 },
      }),
    ).toEqual({
      event: "turn-completed",
      data: {
        message_ids: ["msg-one"],
        model_alias: "fast",
        requested_model: "local-small",
        response_model: "local-small",
        stop_reason: "stop",
        text: "done",
        truncated: false,
        usage: { input: 10, output: 2 },
      },
    });
  });

  it("reports provider failures and truncates oversized output safely", () => {
    expect(
      turnEvent(["msg-one"], model, {
        role: "assistant",
        model: "local-small",
        content: [],
        stopReason: "error",
        errorMessage: "route unavailable",
      }),
    ).toMatchObject({
      event: "turn-failed",
      data: { error: "route unavailable" },
    });

    const completed = turnEvent(["msg-two"], model, {
      role: "assistant",
      model: "local-small",
      content: [{ type: "text", text: "x".repeat(MAX_TURN_TEXT_BYTES + 1) }],
      stopReason: "stop",
      usage: {},
    });
    expect(completed.data.truncated).toBe(true);
    expect(Buffer.byteLength(completed.data.text as string)).toBe(
      MAX_TURN_TEXT_BYTES,
    );
  });
});
