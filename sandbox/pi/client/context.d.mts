export interface ClientContextThresholds {
  readonly initial_fraction: number;
  readonly warn_fraction: number;
  readonly handoff_fraction: number;
  readonly stop_fraction: number;
}

export interface ClientContextUsage {
  readonly tokens: number;
  readonly contextWindow: number;
}

export interface ClientContextPressure {
  readonly tokens: number;
  readonly context_window: number;
  readonly fraction: number;
  readonly percent: number;
  readonly level: "normal" | "warning" | "handoff" | "stop";
  readonly mutating_phase_allowed: boolean;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ClientContextThresholds;
export function validContextThresholds(value: unknown): boolean;
export function contextPressureEvent(
  usage:
    | { readonly tokens: number | null; readonly contextWindow: number }
    | undefined,
  thresholds?: ClientContextThresholds,
): ClientContextPressure | null;
export function crossedHandoffThreshold(
  previousLevel: ClientContextPressure["level"],
  currentLevel: ClientContextPressure["level"],
): boolean;
