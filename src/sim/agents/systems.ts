import type { SimSystem } from "../system-contract.ts";
import { completeAgentRuntimeSystem } from "./runtime-registration.ts";
import { runtimeCombatSystem } from "./runtime-combat.ts";

/** Each reducer checks the serialized runtime marker; legacy snapshots stay opt-in. */
export const systems: readonly SimSystem[] = Object.freeze([completeAgentRuntimeSystem, runtimeCombatSystem]);
