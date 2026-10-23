import { createInitialState, step } from "../sim/step.ts";
import type { InputFrame, SimEvent, SimState, Spawn } from "../sim/contract.ts";
import type { World } from "../sim/world.ts";

/** The host must supply the same pure gameplay composition to both endpoints. */
export interface NetworkSimulation {
  create(world:World,seed:number,players:readonly string[],spawn:Spawn):SimState;
  step(world:World,state:Readonly<SimState>,inputs:InputFrame,events?:readonly SimEvent[]):SimState;
}
export const baseSimulation:NetworkSimulation={
  create:(world,seed,players,spawn)=>createInitialState(world,seed,[...players],spawn),
  step,
};
