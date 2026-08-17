import { z } from "zod";
import { OrchestratorError } from "./error.js";

export const RunStatusSchema = z.enum([
  "ready",
  "active",
  "paused",
  "blocked",
  "complete",
  "stopped",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "active",
  "checking",
  "reviewing",
  "rework",
  "blocked",
  "accepted",
  "skipped",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const GateStatusSchema = z.enum([
  "pending",
  "pass",
  "fail",
  "stale",
  "waived",
]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

const transitions: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending: new Set(["ready", "blocked", "skipped", "cancelled"]),
  ready: new Set(["active", "blocked", "skipped", "cancelled"]),
  active: new Set(["checking", "rework", "blocked", "cancelled"]),
  checking: new Set(["reviewing", "rework", "blocked", "cancelled"]),
  reviewing: new Set(["accepted", "rework", "blocked", "cancelled"]),
  rework: new Set(["active", "blocked", "cancelled"]),
  blocked: new Set(["ready", "skipped", "cancelled"]),
  accepted: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].has(to);
}

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to)) {
    throw new OrchestratorError(
      "invalid_transition",
      `Task cannot transition from '${from}' to '${to}'`,
    );
  }
  return to;
}
