export const MAX_TURN_TEXT_BYTES = 32 * 1024;

function textContent(message) {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  )
    return "";
  return message.content
    .filter(
      (item) => item && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function boundedText(value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= MAX_TURN_TEXT_BYTES) {
    return { text: value, truncated: false };
  }
  let end = MAX_TURN_TEXT_BYTES;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

export function turnEvent(messageIds, model, message) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error("A completed turn must bind at least one Message");
  }
  const common = {
    message_ids: [...messageIds],
    model_profile: model.profile,
    requested_model: model.pi_model,
    ...(typeof message?.responseModel === "string"
      ? { response_model: message.responseModel }
      : typeof message?.model === "string"
        ? { response_model: message.model }
        : {}),
    stop_reason:
      typeof message?.stopReason === "string" ? message.stopReason : "error",
  };
  if (!message || message.role !== "assistant") {
    return {
      event: "turn-failed",
      data: { ...common, error: "Pi settled without an assistant response" },
    };
  }
  if (["error", "aborted"].includes(message.stopReason)) {
    return {
      event: "turn-failed",
      data: {
        ...common,
        error: message.errorMessage || `Pi stopped with ${message.stopReason}`,
      },
    };
  }
  return {
    event: "turn-completed",
    data: {
      ...common,
      ...boundedText(textContent(message)),
      usage:
        message.usage && typeof message.usage === "object"
          ? { ...message.usage }
          : {},
    },
  };
}
