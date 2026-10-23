import { expect,it } from "vitest";
import { createInitialState,step } from "../../../src/sim/step.ts";
import { createPlayerSystems } from "../../../src/sim/player/adapter.ts";
import { buildWorld } from "../../../src/sim/world.ts";

it("never applies free-roam missions, wallet or recovery to a match session",()=>{
 const world=buildWorld([]),initial=createInitialState(world,42,["p"],{x:0,z:0,heading:0});
 for(const phase of ["active","finished"]){
  const active={...initial,ext:{...initial.ext,modes:{match:{id:"royale",phase}}}};
  const systems=createPlayerSystems(()=>{throw new Error("A match cannot query the free-roam provider");});
  const next=step(world,active,{},[],systems);
  for(const key of ["player","heat","missions","economy","progression","activities"])expect(next.ext[key]).toBeUndefined();
 }
});
