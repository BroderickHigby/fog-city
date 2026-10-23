import type { InputFrame, SimEvent, SimState } from "./contract.ts";
import type { ExtensionKey } from "./extensions.ts";
import type { World } from "./world.ts";

/** Phase order follows dependencies. Existing ambient movement happens before these hooks. */
export const SYSTEM_ORDER: readonly ExtensionKey[] = Object.freeze([
  "clock", "fog", "vehicles", "agents", "robots", "combat", "player", "heat", "missions",
  "economy", "progression", "activities", "modes", "bots",
]);

export interface SimSystemContext {
  readonly world: World;
  /** Previous tick, including this tick's joins/leaves. Never mutate it. */
  readonly previous: Readonly<SimState>;
  /** Current tick after movement and earlier systems. Return a new state for changes. */
  readonly state: SimState;
  /** Sanitized inputs in sorted player order, with missing players made neutral. */
  readonly inputs: InputFrame;
  /** Recorded external facts. Derived gameplay events belong in the owning extension. */
  readonly events: readonly SimEvent[];
}

export interface SimSystem {
  readonly key: ExtensionKey;
  /** Pure reducer. Own one ext slot; coordinate body changes with the body-owning lane. */
  readonly step: (context: SimSystemContext) => SimState;
}
