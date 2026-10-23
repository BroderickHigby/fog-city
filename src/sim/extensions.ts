import type { AgentsExt } from "./agents.ts";
import type { CombatState } from "./combat-contract.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Names are reserved now; lane-owned state schemas replace JsonObject as they land. */
export interface ExtensionStateMap {
  clock: JsonObject;
  fog: JsonObject;
  vehicles: JsonObject;
  agents: AgentsExt;
  robots: JsonObject;
  combat: CombatState;
  player: JsonObject;
  heat: JsonObject;
  missions: JsonObject;
  economy: JsonObject;
  progression: JsonObject;
  activities: JsonObject;
  modes: JsonObject;
  bots: JsonObject;
}

/** Unknown legacy keys are preserved; absence means that system has not initialized. */
export type SimExtensions = Partial<ExtensionStateMap> & Record<string, unknown>;

export const ExtensionKey = {
  clock: "clock", fog: "fog", vehicles: "vehicles", agents: "agents", robots: "robots",
  combat: "combat", player: "player", heat: "heat", missions: "missions", economy: "economy",
  progression: "progression", activities: "activities", modes: "modes", bots: "bots",
} as const;

export type ExtensionKey = keyof ExtensionStateMap;
