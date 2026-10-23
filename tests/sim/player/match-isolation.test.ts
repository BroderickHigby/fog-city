import { expect,it } from "vitest";
import type { JsonObject } from "../../../src/sim/extensions.ts";
import { createInitialState,step } from "../../../src/sim/step.ts";
import { createPlayerSystems } from "../../../src/sim/player/adapter.ts";
import { applyModeSettlements } from "../../../src/sim/player/settlements.ts";
import { buildWorld } from "../../../src/sim/world.ts";

it("never applies free-roam missions, wallet or recovery to a match session",()=>{
 const world=buildWorld([]),initial=createInitialState(world,42,["p"],{x:0,z:0,heading:0});
 for(const phase of ["active","finished"]){
  const active={...initial,ext:{...initial.ext,modes:{match:{id:"royale",phase}}}};
  const systems=createPlayerSystems(()=>{throw new Error("A match cannot query the free-roam provider");});
  const next=step(world,active,{},[],systems);
  for(const key of ["player","heat","missions","economy","progression","activities"])expect(next.ext[key]).toBeUndefined();
 }
 for(const kind of ["crowd","royale","vibes"]){
  for(const modes of [{version:1,kind,state:{}},{[kind]:{}}]){
   const next=step(world,{...initial,ext:{modes}}, {},[],createPlayerSystems(()=>{throw new Error("Standalone mode reached free roam");}));
   expect(next.ext.economy).toBeUndefined();
  }
 }
});


it("refuses payouts into active or finished match worlds",()=>{
 const base=createInitialState(buildWorld([]),42,["p"],{x:0,z:0,heading:0});
 const payouts=[{id:"test:p",playerId:"p",xp:500,cashCents:2500,achievements:["first-win"],factionClockMoves:1 as const}];
 for(const modes of [{match:{phase:"active"}},{match:{phase:"finished"}},{kind:"crowd"},{kind:"royale"},{kind:"vibes"}] as JsonObject[]){
  const state={...base,ext:{modes}};
  expect(applyModeSettlements(state,payouts)).toBe(state);
 }
});
