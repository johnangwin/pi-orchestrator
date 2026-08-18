import type { ClientConfig } from "./link.mjs";

export function registerModelRoute(
  pi: {
    registerProvider(name: string, config: unknown): void;
  },
  config: ClientConfig,
): void;

export function modelArguments(config: ClientConfig): string[];
