import type { AgentsExt } from "./agents.ts";
import type { CombatState } from "./combat-contract.ts";
import type { FogState } from "./fog/index.ts";
import type { ClockState } from "./clock/calendar.ts";
import type { ActorIdentities } from "./identity.ts";
import type { AgentsRuntimeState } from "./agents/runtime.ts";
import type { PlayerGameplayState, HeatState, MissionState, EconomyState, ProgressionState, ActivitiesState } from "./player/types.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Names are reserved now; lane-owned state schemas replace JsonObject as they land. */
export interface ExtensionStateMap {
  identities: ActorIdentities;
  clock: ClockState;
  fog: FogState;
  vehicles: JsonObject;
  agents: AgentsExt;
  robots: AgentsRuntimeState;
  combat: CombatState;
  player: PlayerGameplayState;
  heat: HeatState;
  missions: MissionState;
  economy: EconomyState;
  progression: ProgressionState;
  activities: ActivitiesState;
  modes: JsonObject;
  bots: JsonObject;
}

/** Unknown legacy keys are preserved; absence means that system has not initialized. */
export type SimExtensions = Partial<ExtensionStateMap> & Record<string, unknown>;

export const ExtensionKey = {
  identities: "identities",
  clock: "clock", fog: "fog", vehicles: "vehicles", agents: "agents", robots: "robots",
  combat: "combat", player: "player", heat: "heat", missions: "missions", economy: "economy",
  progression: "progression", activities: "activities", modes: "modes", bots: "bots",
} as const;

export type ExtensionKey = keyof ExtensionStateMap;
