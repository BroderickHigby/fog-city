import { expect,it } from "vitest";
import { createDoomClock,doomEffects,factionFor,stepDoomClock } from "../../../src/sim/progression/doom-clock.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { createActivities,stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { Action } from "../../../src/sim/contract.ts";
import type { GameplayContext,GameplayFact } from "../../../src/sim/player/types.ts";

const context=(day:number,facts:GameplayFact[]=[]):GameplayContext=>({...DEFAULT_CATALOG,day,month:1,wave:4,bodies:[],observations:[],actors:[],commands:[],missions:[],facts});
it("advances one month per game day and resets AGI at midnight",()=>{
 const start=stepDoomClock(createDoomClock(),context(0),0).state;
 const crunch=stepDoomClock(start,context(13),1).state;expect(crunch.months).toBe(11);expect(doomEffects(crunch,13,1).bountyMultiplier).toBe(1.25);
 const midnight=stepDoomClock(crunch,context(24),2);expect(midnight.state.months).toBe(24);expect(midnight.state.resets).toBe(1);expect(midnight.events.map(e=>e.kind)).toContain("world.agi-achieved");expect(doomEffects(midnight.state,24,100).paused).toBe(true);
});
it("settles faction contracts once and applies a one-day AI Winter",()=>{
 let state=stepDoomClock(createDoomClock(),context(0),0).state;
 const facts:GameplayFact[]=Array.from({length:8},(_,i)=>({id:`faction:${i+1}`,source:"world",sequence:i+1,tick:1,playerId:"p",kind:"faction.pauser-completed"}));
 const winter=stepDoomClock(state,context(0,facts),1);state=winter.state;expect(state.months).toBe(24);expect(state.winters).toBe(1);expect(factionFor(state,"p")).toBe("pauser");expect(doomEffects(state,0,2).robotSpeedMultiplier).toBe(.9);
 const repeated=stepDoomClock(state,context(0,facts.map(f=>({...f,tick:2}))),2);expect(repeated.state.winters).toBe(1);expect(repeated.state.factions.p!.pauser).toBe(8);expect(doomEffects(state,1,2).robotSpeedMultiplier).toBe(1);
});
it("only completes a measured faction route within its speed rule",()=>{
 const activity={id:"faction-pauser",kind:"delivery",wave:4,x:0,y:0,z:0,radius:2,maxSpeedMps:5.36448,objective:{event:"faction.pauser-completed",count:1},checkpoints:[{id:"start",x:0,y:0,z:0,radius:2},{id:"finish",x:10,y:0,z:0,radius:2}]};
 const ctx:GameplayContext={...context(0),activities:[activity],bodies:[{id:"p",x:0,y:0,z:0,mode:"vehicle",speed:0}],commands:[{sequence:1,kind:"activity-start",playerId:"p",targetId:activity.id}]};
 const start=stepActivities(createActivities(),ctx,0,createMissions(),1);
 const fast=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10,speed:10}],actions:{p:Action.interact}},60,createMissions(),1);expect(fast.events.some(e=>e.kind==="faction.pauser-completed")).toBe(false);expect(fast.events.some(e=>e.kind==="activity.failed")).toBe(true);
 const valid=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}],actions:{p:Action.interact}},60,createMissions(),1);expect(valid.events.some(e=>e.kind==="faction.pauser-completed")).toBe(true);
});

it("requires the measured faction interaction even when a completion fact is supplied",()=>{
 const activity={id:"faction-pauser",kind:"delivery",wave:4,x:0,y:0,z:0,radius:2,objective:{event:"faction.pauser-completed",count:1},checkpoints:[{id:"start",x:0,y:0,z:0,radius:2},{id:"finish",x:10,y:0,z:0,radius:2}]};
 const ctx:GameplayContext={...context(0),activities:[activity],bodies:[{id:"p",x:0,y:0,z:0,mode:"vehicle",speed:0}],commands:[{sequence:1,kind:"activity-start",playerId:"p",targetId:activity.id}]};
 const start=stepActivities(createActivities(),ctx,0,createMissions(),1);
 const named=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}],facts:[{id:"forged:1",source:"combat",sequence:1,tick:60,playerId:"p",actorId:"another-route",kind:"faction.pauser-completed"}]},60,createMissions(),1);
 expect(named.players.p!.activeActivityId).toBe(activity.id);
 expect(named.events.some(e=>e.kind==="activity.cash"||e.kind==="faction.pauser-completed")).toBe(false);
 const accepted=stepActivities(named,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}],actions:{p:Action.interact}},61,createMissions(),1);
 expect(accepted.events.filter(e=>e.kind==="faction.pauser-completed")).toHaveLength(1);
});

it("requires a faction handoff at the endpoint before its deadline",()=>{
 const activity={id:"faction-pauser",kind:"delivery",wave:4,x:0,y:0,z:0,radius:2,timeLimitS:2,objective:{event:"faction.pauser-completed",count:1},checkpoints:[{id:"start",x:0,y:0,z:0,radius:2},{id:"finish",x:10,y:0,z:0,radius:2}]};
 const ctx:GameplayContext={...context(0),activities:[activity],bodies:[{id:"p",x:0,y:0,z:0,mode:"vehicle",speed:0}],commands:[{sequence:1,kind:"activity-start",playerId:"p",targetId:activity.id}]};
 const start=stepActivities(createActivities(),ctx,0,createMissions(),1);
 const passedFinish=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}]},60,createMissions(),1);
 const remoteHandoff=stepActivities(passedFinish,{...ctx,commands:[],actions:{p:Action.interact}},61,createMissions(),1);
 expect(remoteHandoff.events.some(e=>e.kind==="activity.finished")).toBe(false);
 const expired=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}],actions:{p:Action.interact}},121,createMissions(),1);
 expect(expired.events.some(e=>e.kind==="activity.finished")).toBe(false);
 expect(expired.events.some(e=>e.kind==="activity.failed")).toBe(true);
 const onTime=stepActivities(start,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}],actions:{p:Action.interact}},120,createMissions(),1);
 expect(onTime.events.filter(e=>e.kind==="activity.finished")).toHaveLength(1);
});
