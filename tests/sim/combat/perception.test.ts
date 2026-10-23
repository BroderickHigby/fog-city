import { describe,expect,it } from "vitest";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { sightRange } from "../../../src/sim/combat/perception.ts";
import type { CombatActor,CombatContext,CombatPlayer } from "../../../src/sim/combat/types.ts";

const observer:CombatActor={id:"bot",kind:"robot",firmware:"bad",x:0,y:0,z:0,heading:0,speed:0,radius:.4,height:1.8};
const player:CombatPlayer={id:"p",x:0,y:0,z:0,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1};
const ctx:CombatContext={actors:[observer],players:[player],walls:[],refills:[],wave:3};
describe("combat perception handoff",()=>{
  it.each([[0,30],[.5,21],[1,12]])("fog density %s gives %s metres",(fog,metres)=>{
    expect(sightRange(createCombatState(1,ctx),{...ctx,fog},observer)).toBeCloseTo(metres,12);
  });
  it("applies Marine Layer and wave gating",()=>{
    const state=createCombatState(1,ctx);
    expect(sightRange(state,{...ctx,fog:1},observer,{...player,perks:["marine"]})).toBe(6);
    expect(sightRange(state,{...ctx,fog:1,wave:2},observer)).toBe(30);
    expect(sightRange(state,{...ctx,fog:NaN},observer)).toBe(30);
  });
  it("blinded and collapsed robots cannot see",()=>{
    const state=createCombatState(1,ctx);state.targets.bot!.blindUntil=10;
    expect(sightRange(state,ctx,observer)).toBe(0);
    state.tick=10;expect(sightRange(state,ctx,observer)).toBe(30);
    state.targets.bot!.phase="heap";expect(sightRange(state,ctx,observer)).toBe(0);
  });
});
