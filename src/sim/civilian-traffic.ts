import type { AgentState } from "./agents.ts";

/** The stable traffic mix uses existing IDs; no saved appearance or scheduler state. */
export function isCivilianTraffic(agent: Readonly<Pick<AgentState,"id"|"kind"|"runtimeId"|"vehicle">>): boolean {
  return agent.kind === "robotaxi" && agent.runtimeId === undefined && agent.vehicle === undefined && agent.id % 8 === 7;
}
export const CIVILIAN_PASS_INTERVAL_TICKS = 30 * 60;
