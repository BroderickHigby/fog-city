import { expect,it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { step } from "../../../src/sim/step.ts";
import { advancedModeOf,createRoyaleInstance,createVibesInstance } from "../../../src/sim/modes/advanced.ts";
import { createModesSystem } from "../../../src/sim/modes/systems.ts";
import { copyMatchLoadouts } from "../../../src/sim/modes/session.ts";

it("uses fresh instances and drops non-loadout fields and unrelated players",()=>{
  const item={nozzle:"standard",gadget:"speaker",gear:"boots",perks:[],streaks:[],cosmetics:[],cashCents:99999};
  const carry=copyMatchLoadouts(["a"],{a:item,other:item});
  expect(carry).toEqual({a:{nozzle:"standard",gadget:"speaker",gear:"boots",perks:[],streaks:[],cosmetics:[]}});
  const world=buildWorld([]),state=createRoyaleInstance(world,{id:"royale",seed:1,playerIds:["a"],solo:true,initialCircle:{x:0,z:0,radius:1000},finalLandmarks:[{id:"end",x:0,z:0,radius:100}]},{x:0,z:0,heading:0},{a:item});
  expect(Object.keys(state.players)).toHaveLength(8);expect(state.ext.player).toBeUndefined();
  const next=step(world,state,{},[],[createModesSystem()]);expect(advancedModeOf(next)?.state.elapsedTicks).toBe(1);
});
it("settles a recorded award once through the real modes system",()=>{
  const world=buildWorld([]),cast={a:{badId:"a-bad",goodIds:["a-1","a-2"] as const,investorIds:[]},b:{badId:"b-bad",goodIds:["b-1","b-2"] as const,investorIds:[]}};
  const state=createVibesInstance(world,1,"vibes",["a","b"],cast,{x:0,z:0,heading:0});
  const slot=advancedModeOf(state)!;if(slot.kind!=="vibes")throw new Error("wrong mode");
  slot.state.phase="award";slot.state.awardRequestId="award:vibes:1";
  const system=createModesSystem(undefined,{vibes:()=>({award:{id:"award:vibes:1",requestId:"award:vibes:1",matchId:"vibes",winnerId:"a",candidates:["a","b"]}})});
  const next=step(world,state,{},[],[system]);expect(advancedModeOf(next)?.payouts).toHaveLength(2);
  expect(advancedModeOf(next)?.settled).toBe(true);expect(advancedModeOf(state)?.settled).toBe(false);
  expect(advancedModeOf(step(world,next,{},[],[system]))?.payouts).toEqual([]);
});
