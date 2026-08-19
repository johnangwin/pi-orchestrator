export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({
  initial_fraction: 0.25,
  warn_fraction: 0.6,
  handoff_fraction: 0.75,
  stop_fraction: 0.85,
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validContextThresholds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "initial_fraction",
          "warn_fraction",
          "handoff_fraction",
          "stop_fraction",
        ].includes(key),
    )
  ) {
    return false;
  }
  const values = [
    value.initial_fraction,
    value.warn_fraction,
    value.handoff_fraction,
    value.stop_fraction,
  ];
  return values.every(
    (fraction, index) =>
      finiteNumber(fraction) &&
      fraction > 0 &&
      fraction <= 1 &&
      (index === 0 || fraction > values[index - 1]),
  );
}

export function contextPressureEvent(
  usage,
  thresholds = DEFAULT_CONTEXT_THRESHOLDS,
) {
  if (!validContextThresholds(thresholds)) {
    throw new Error("Invalid context-pressure thresholds");
  }
  if (
    !usage ||
    !Number.isSafeInteger(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isSafeInteger(usage.contextWindow) ||
    usage.contextWindow < 1
  ) {
    return null;
  }

  const fraction = usage.tokens / usage.contextWindow;
  const level =
    fraction >= thresholds.stop_fraction
      ? "stop"
      : fraction >= thresholds.handoff_fraction
        ? "handoff"
        : fraction >= thresholds.warn_fraction
          ? "warning"
          : "normal";
  return {
    tokens: usage.tokens,
    context_window: usage.contextWindow,
    fraction,
    percent: fraction * 100,
    level,
    mutating_phase_allowed: level !== "stop",
  };
}

const pressureRank = Object.freeze({
  normal: 0,
  warning: 1,
  handoff: 2,
  stop: 3,
});

export function crossedHandoffThreshold(previousLevel, currentLevel) {
  if (!(previousLevel in pressureRank) || !(currentLevel in pressureRank)) {
    throw new Error("Invalid context-pressure level");
  }
  return (
    pressureRank[currentLevel] >= pressureRank.handoff &&
    pressureRank[previousLevel] < pressureRank.handoff
  );
}
