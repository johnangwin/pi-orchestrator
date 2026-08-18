import type { ClientConfig } from "./link.mjs";

export const MAX_TURN_TEXT_BYTES: number;

export function turnEvent(
  messageIds: readonly string[],
  model: NonNullable<ClientConfig["model"]>,
  message: unknown,
): {
  readonly event: "turn-completed" | "turn-failed";
  readonly data: Readonly<Record<string, unknown>>;
};
