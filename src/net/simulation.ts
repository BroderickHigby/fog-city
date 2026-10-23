import { createInitialState, step } from "../sim/step.ts";
import type { InputFrame, SimEvent, SimState, Spawn } from "../sim/contract.ts";
import type { World } from "../sim/world.ts";
import { createGameSystems, type GameSystemsOptions } from "../sim/game-systems.ts";

/** The host must supply the same pure gameplay composition to both endpoints. */
export interface NetworkSimulation {
  create(world:World,seed:number,players:readonly string[],spawn:Spawn):SimState;
  step(world:World,state:Readonly<SimState>,inputs:InputFrame,events?:readonly SimEvent[]):SimState;
}
export const baseSimulation:NetworkSimulation={
  create:(world,seed,players,spawn)=>createInitialState(world,seed,[...players],spawn),
  step,
};

/** The same complete composition runs on the relay and in browser prediction. */
export function createGameplaySimulation(options:GameSystemsOptions={}):NetworkSimulation {
  const systems=createGameSystems(options);
  return {create:baseSimulation.create,step:(world,state,inputs,events=[])=>step(world,state,inputs,events,systems)};
}
export const gameplaySimulation=createGameplaySimulation();
