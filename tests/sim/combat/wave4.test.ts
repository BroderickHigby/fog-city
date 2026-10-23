import { describe,expect,it } from "vitest";
import { createCombatState,stepCombat } from "../../../src/sim/combat/system.ts";
import type { CombatActor,CombatContext,CombatPlayer } from "../../../src/sim/combat/types.ts";

const player:CombatPlayer={id:"p1",x:0,y:0,z:0,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1,gadget:"balloon"};
const bot:CombatActor={id:"bot",x:1,y:0,z:-2,heading:0,speed:0,radius:.4,height:1.8,kind:"robot",firmware:"bad"};
const ctx:CombatContext={wave:4,actors:[bot],players:[player],refills:[],walls:[{id:"wall",minX:-3,maxX:3,minY:0,maxY:4,minZ:-3,maxZ:-2.9}]};
describe("wave-four reducer integration",()=>{
  it("launches an equipped balloon and splashes from the wall's exposed side",()=>{
    let state=createCombatState(1,ctx);
    for(let n=0;n<40;n++) state=stepCombat(state,ctx,{p1:{gadget:"balloon"}});
    expect(state.players.p1!.balloons).toBe(1);
    expect(state.targets.bot!.rust).toBeCloseTo(.2,8);
    expect(state.projectiles).toHaveLength(0);
  });

  it("blocks a balloon on a protected subject before it can splash",()=>{
    const child:CombatActor={...bot,id:"child",x:0,z:-.3,radius:.1,kind:"person",firmware:"none",child:true};
    const context={...ctx,actors:[child,bot]};let state=createCombatState(1,context);
    for(let n=0;n<40;n++) state=stepCombat(state,context,{p1:{gadget:"balloon"}});
    expect(state.targets.bot!.rust).toBe(0);expect(state.targets.child!.wetUntil).toBe(0);
  });

  it("holds projectiles, effects and ammo for all 180 AGI ticks then resumes",()=>{
    const context={...ctx,walls:[],streaks:[{playerId:"p1",kind:"agi" as const,sequence:1}]};
    let state=createCombatState(1,context);
    state.projectiles.push({id:100,ownerId:"p1",kind:"water",x:0,y:5,z:5,vx:0,vy:0,vz:-13,distance:0,range:12,bornTick:0,volume:.08,salt:false,vehicle:false,rustRate:.025});
    state.players.p1!.gear="boots";state.players.p1!.gearUntil=100;
    state=stepCombat(state,context,{p1:{streak:"agi",fire:true}});
    expect(state.targets.bot!.rust).toBe(.6);expect(state.pauseUntil).toBe(181);
    const water=state.players.p1!.water;
    for(let n=0;n<180;n++)state=stepCombat(state,context,{p1:{fire:true}});
    expect(state.tick).toBe(181);expect(state.players.p1!.water).toBe(water);
    expect(state.projectiles[0]).toMatchObject({x:0,y:5,z:5,distance:0,bornTick:180});
    expect(state.players.p1!.gearUntil).toBe(280);
    state=stepCombat(state,context,{p1:{fire:true}});
    expect(state.players.p1!.water).toBeLessThan(water);
    expect(state.projectiles[0]!.z).toBeLessThan(5);
  });

  it("draws the roof cannon from fresh trunk reserve without consuming the handheld tank",()=>{
    const roof={...player,mount:"roof" as const,trunk:true,roofCannon:true,speed:25};
    const context={...ctx,players:[roof],actors:[],walls:[]};let state=createCombatState(1,context);
    state.players.p1!.salt=true;
    state=stepCombat(state,context,{p1:{fire:true,aimYaw:Math.PI,aimPitch:0}});
    expect(state.players.p1!.water).toBe(8);expect(state.players.p1!.reserve).toBeCloseTo(19.92,8);
    expect(state.projectiles[0]).toMatchObject({range:15,rustRate:.0125,salt:false,vehicle:true});
    expect(state.projectiles[0]!.vz).toBeLessThan(0);
  });

  it("fans wide boost into three pellets with conserved water and rust budgets",()=>{
    const context={...ctx,actors:[],walls:[]};let state=createCombatState(1,context);
    state.players.p1!.boost="wide";state.players.p1!.boostUntil=100;
    state=stepCombat(state,context,{p1:{fire:true,aimPitch:0}});
    expect(state.projectiles).toHaveLength(3);
    expect(state.projectiles.reduce((sum,p)=>sum+p.volume,0)).toBeCloseTo(.08,12);
    expect(state.projectiles.reduce((sum,p)=>sum+p.rustRate,0)).toBeCloseTo(.025,12);
    expect(state.players.p1!.water).toBeCloseTo(7.92,10);
  });
});
