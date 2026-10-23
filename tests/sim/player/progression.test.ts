import { it,expect } from "vitest";
import { applyModeSettlements } from "../../../src/sim/player/settlements.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createActivities,stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions,stepMissions } from "../../../src/sim/missions/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createProgression,stepProgression,rankForXp } from "../../../src/sim/progression/system.ts";
import { createEconomy,stepEconomy } from "../../../src/sim/economy/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext,GameplayFact } from "../../../src/sim/player/types.ts";
import type { Mission } from "../../../src/content/missions.ts";

function context(overrides:Partial<GameplayContext>={}):GameplayContext{return {...DEFAULT_CATALOG,wave:4,bodies:[{id:"p",x:0,y:0,z:0,mode:"foot",speed:0}],actors:[],facts:[],commands:[],observations:[],missions:[],day:1,month:1,...overrides};}

it("settles mode cash, XP and achievements exactly once into a preserved free-roam profile",()=>{
 const freeRoam=createInitialState(buildWorld([]),7,["p"],{x:0,z:0,heading:0});const encoded=JSON.stringify(freeRoam);
 const payouts=[{id:"match-7:p",playerId:"p",xp:550,cashCents:15000,achievements:["first-win"],factionClockMoves:0 as const}];
 const first=applyModeSettlements(freeRoam,payouts),again=applyModeSettlements(first,payouts);
 expect(JSON.stringify(freeRoam)).toBe(encoded);expect(first.players).toEqual(freeRoam.players);expect(again.ext).toEqual(first.ext);
 const wallet=again.ext.economy as unknown as ReturnType<typeof createEconomy>,progression=again.ext.progression as unknown as ReturnType<typeof createProgression>;
 expect(wallet.players.p!.cashCents).toBe(215000);expect(progression.players.p!.xp).toBe(550);expect(progression.players.p!.rank).toBe(3);expect(progression.players.p!.achievements).toEqual(["first-win"]);
});

it("uses authored XP once and makes the scanner-tier-2 mission unlock effective",()=>{
 const mission:Mission={id:"unlock",version:1,wave:3,title:"Unlock",cast:{},meters:{},outcomes:{done:{label:"Done",kind:"success"}},start:"award",steps:[{id:"award",type:"reward",outcome:"done",grants:[{kind:"stat",stat:"xp",delta:700},{kind:"unlock",unlock:"app:scanner-tier-2"}]}]};
 const ctx=context({missions:[mission],commands:[{sequence:1,kind:"mission-start",playerId:"p",targetId:"unlock"}]});
 const state=stepMissions(createMissions(),ctx,1,createHeat(),createPlayer());expect(state.events.filter(e=>e.kind==="mission.xp").map(e=>e.amount)).toEqual([700]);
 const progression=stepProgression(createProgression(),ctx,1,{missions:state.events});expect(progression.players.p!.xp).toBe(700);expect(progression.players.p!.scannerTier).toBe(2);expect(rankForXp(550)).toBe(3);
});

it("requires every route checkpoint and enforces repeat cooldowns",()=>{
 const route={id:"trial",kind:"timeTrial",wave:3,x:0,y:0,z:0,radius:2,rewardCents:100,rewardXp:100,objective:{event:"race.finished",count:1},checkpoints:[{id:"a",x:0,y:0,z:0,radius:2},{id:"b",x:10,y:0,z:0,radius:2}],repeatable:true,cooldownS:60};
 const ctx=context({activities:[route],commands:[{sequence:1,kind:"activity-start",playerId:"p",targetId:"trial"}]});let state=stepActivities(createActivities(),ctx,1,createMissions(),1);
 state=stepActivities(state,{...ctx,commands:[]},61,createMissions(),1);expect(state.events.some(e=>e.kind==="activity.cash")).toBe(false);
 state=stepActivities(state,{...ctx,commands:[],bodies:[{...ctx.bodies[0]!,x:10}]},62,createMissions(),1);expect(state.events.find(e=>e.kind==="activity.cash")?.amount).toBe(100);
 state=stepActivities(state,{...ctx,commands:[{sequence:2,kind:"activity-start",playerId:"p",targetId:"trial"}]},63,createMissions(),1);expect(state.players.p!.activeActivityId).toBe("");
});

it("rejects duplicate purchase sequences and non-finite external amounts",()=>{
 const site=DEFAULT_CATALOG.sites.find(s=>s.kind==="vendor")!,commands=[{sequence:1,kind:"buy" as const,playerId:"p",itemId:"burrito",targetId:site.id}];
 const facts:GameplayFact[]=[{id:"combat:1",source:"combat",sequence:1,tick:1,kind:"player.runway",playerId:"p",amount:NaN}];
 const ctx=context({bodies:[{...site,id:"p",mode:"foot",speed:0}],commands:[...commands,...commands],facts});const state=stepEconomy(createEconomy(),ctx,1);
 expect(state.players.p!.cashCents).toBe(200000);expect(state.players.p!.runwayMonths).toBe(18);
});

it("keeps equal sequences from separate authoritative world producers",()=>{
 const facts:GameplayFact[]=[{id:"world-parking:1",source:"world",sequence:1,tick:1,kind:"player.runway",playerId:"p",amount:-1},{id:"world-delivery:1",source:"world",sequence:1,tick:1,kind:"player.runway",playerId:"p",amount:-2}];
 const state=stepEconomy(createEconomy(),context({facts}),1);expect(state.players.p!.runwayMonths).toBe(15);
 const replay=stepEconomy(state,context({facts:facts.map(f=>({...f,tick:2}))}),2);expect(replay.players.p!.runwayMonths).toBe(15);
});
