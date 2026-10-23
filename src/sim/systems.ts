import { SYSTEM_ORDER, type SimSystem, type SimSystemContext } from "./system-contract.ts";
import type { AgentMotionProposal } from "./motion.ts";
import { systems as clockSystems } from "./clock/systems.ts";
import { systems as fogSystems } from "./fog/systems.ts";
import { systems as vehiclesSystems } from "./vehicles/systems.ts";
import { systems as agentsSystems } from "./agents/systems.ts";
import { systems as robotsSystems } from "./robots/systems.ts";
import { systems as combatSystems } from "./combat/systems.ts";
import { systems as playerSystems } from "./player/systems.ts";
import { systems as heatSystems } from "./heat/systems.ts";
import { systems as missionsSystems } from "./missions/systems.ts";
import { systems as economySystems } from "./economy/systems.ts";
import { systems as progressionSystems } from "./progression/systems.ts";
import { systems as activitiesSystems } from "./activities/systems.ts";
import { systems as modesSystems } from "./modes/systems.ts";
import { systems as botsSystems } from "./bots/systems.ts";

/** Area lists are composed here; registration never changes ambient global state. */
export const SYSTEMS: readonly SimSystem[] = Object.freeze([
  ...clockSystems,
  ...fogSystems,
  ...vehiclesSystems,
  ...agentsSystems,
  ...robotsSystems,
  ...combatSystems,
  ...playerSystems,
  ...heatSystems,
  ...missionsSystems,
  ...economySystems,
  ...progressionSystems,
  ...activitiesSystems,
  ...modesSystems,
  ...botsSystems
]);

/** Fixed area order, independent of registration order; one system owns each ext key. */
export function runSystems(context: SimSystemContext, systems: readonly SimSystem[] = SYSTEMS): import("./contract.ts").SimState {
  const seen = new Set<string>();
  for (const system of systems) {
    if (!SYSTEM_ORDER.includes(system.key) || seen.has(system.key)) throw new Error(`Invalid or duplicate sim system: ${system.key}`);
    seen.add(system.key);
  }
  const ordered = [...systems].sort((a, b) => SYSTEM_ORDER.indexOf(a.key) - SYSTEM_ORDER.indexOf(b.key));
  let state = context.state;
  for (const system of ordered) {
    state = system.step({ ...context, state });
    if (state.tick !== context.state.tick || state.version !== context.state.version) throw new Error(`Sim system ${system.key} changed tick or version`);
  }
  return state;
}

export function prepareSystems(context: SimSystemContext, systems: readonly SimSystem[] = SYSTEMS): { state: import("./contract.ts").SimState; motions: AgentMotionProposal[]; retirements: string[] } {
  const seen = new Set<string>();
  const motions: AgentMotionProposal[] = [], retirements: string[] = [];
  let state = context.state;
  for (const system of [...systems].sort((a,b)=>SYSTEM_ORDER.indexOf(a.key)-SYSTEM_ORDER.indexOf(b.key))) {
    if (!SYSTEM_ORDER.includes(system.key) || seen.has(system.key)) throw new Error(`Invalid or duplicate sim system: ${system.key}`);
    seen.add(system.key);
    if (!system.prepare) continue;
    const result=system.prepare({...context,state});
    if (result.state.tick!==context.state.tick || result.state.version!==context.state.version) throw new Error(`Sim system ${system.key} changed tick or version`);
    state=result.state;motions.push(...result.motions);retirements.push(...(result.retirements??[]));
  }
  return {state,motions,retirements};
}
