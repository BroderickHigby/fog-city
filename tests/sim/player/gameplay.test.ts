import { describe,it,expect } from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { createEconomy,createWallet,stepEconomy } from "../../../src/sim/economy/system.ts";
import { createHeat,createHeatStatus,stepHeat } from "../../../src/sim/heat/system.ts";
import { createMissions,missionPlace,stepMissions } from "../../../src/sim/missions/system.ts";
import { createPlayer,stepPlayer } from "../../../src/sim/player/system.ts";
import { createActivities,stepActivities } from "../../../src/sim/activities/system.ts";
import { createProgression,stepProgression } from "../../../src/sim/progression/system.ts";
import { createPlayerSystems,gameplaySnapshot } from "../../../src/sim/player/adapter.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { createInitialState,step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { GameplayContext,GameplayFact } from "../../../src/sim/player/types.ts";
import type { Mission } from "../../../src/content/missions.ts";

const body={id:"p",x:0,y:0,z:0,speed:0,mode:"foot" as const};
function context(overrides:Partial<GameplayContext>={}):GameplayContext{return {...DEFAULT_CATALOG,wave:2,bodies:[{...body}],actors:[],facts:[],commands:[],observations:[],missions:[],day:1,month:1,...overrides};}
function fact(sequence:number,tick:number,kind:string,actorId="bad"):GameplayFact{return {id:`combat:${sequence}`,source:"combat",sequence,tick,kind,playerId:"p",actorId};}
function freeze<T>(value:T):T {if(value&&typeof value==="object"){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}

describe("wallet, heat and recovery",()=>{
 it("buys the actual tank upgrade and food, rejects a replay and distant purchase",()=>{
  let economy=createEconomy();const site=DEFAULT_CATALOG.sites.find(s=>s.kind==="vendor")!;
  const ctx=context({bodies:[{...body,...site,id:"p"}],commands:[{sequence:1,playerId:"p",kind:"buy",targetId:site.id,itemId:"tank-1"}]});
  economy=stepEconomy(economy,ctx,1);expect(economy.players.p!.cashCents).toBe(140000);expect(economy.players.p!.ownedItemIds).toContain("tank-1");
  const progression=stepProgression(createProgression(),ctx,1,{economy:economy.events});expect(progression.players.p!.tankTier).toBe(1);
  const replay=stepEconomy(freeze(economy),ctx,2);expect(replay.players.p!.cashCents).toBe(140000);
  const damaged={...replay,players:{p:{...replay.players.p!,runwayMonths:15}}};
  const food=stepEconomy(damaged,{...ctx,commands:[{sequence:2,playerId:"p",kind:"buy",targetId:site.id,itemId:"burrito"}]},3);expect(food.players.p!.runwayMonths).toBe(17);expect(food.players.p!.cashCents).toBe(138800);
  const distant=stepEconomy(food,{...ctx,bodies:[{...body,x:100000}],commands:[{sequence:3,playerId:"p",kind:"buy",targetId:site.id,itemId:"flow-1"}]},4);expect(distant.players.p!.cashCents).toBe(138800);
 });
 it("deduplicates bounties and never pays a good robot or unknown actor",()=>{
  const ctx=context({actors:[{id:"bad",firmware:"bad",subtlety:3,caughtInAct:true},{id:"good",firmware:"good"}],facts:[fact(1,1,"robot.heap"),fact(2,1,"robot.heap","good"),fact(3,1,"robot.heap","missing")]});
  const first=stepEconomy(createEconomy(),ctx,1);expect(first.players.p!.cashCents).toBe(233750);expect(first.players.p!.reputation).toBe(52);
  const second=stepEconomy(freeze(first),{...ctx,facts:[fact(4,2,"robot.heap")]},2);expect(second.players.p!.cashCents).toBe(233750);
 });
 it("escalates to a stable van request, then decays faster inside fog",()=>{
  const ctx=context({actors:[{id:"bad",firmware:"bad",witnessedByBad:true}],facts:[fact(1,1,"robot.heap")],observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:false,fog:1}]});
  const heat=stepHeat(createHeat(),ctx,1);expect(heat.players.p!.threat).toBe(2);expect(heat.events.find(e=>e.kind==="threat.spawn")!.payload).toEqual({id:"heat:p:1",kind:"van",unitCount:2,requestTick:1,playerId:"p",player:{x:0,z:0},threat:2});
  const decayed=stepHeat(freeze(heat),{...ctx,facts:[]},901);expect(decayed.players.p!.threat).toBe(1);expect(decayed.events.some(e=>e.kind==="threat.spawn")).toBe(false);
 });
 it("applies DOWN ROUND once and requires an actual associate for a bridge",()=>{
  let economy=createEconomy();economy.players.p={...createWallet(),runwayMonths:0};let heat=createHeat();heat.players.p=createHeatStatus(0);
  const down=stepPlayer(createPlayer(),context(),1,economy,heat);expect(down.players.p!.downRounds).toBe(1);
  economy=stepEconomy(economy,context(),1,[],heat,down.events);expect(economy.players.p!.cashCents).toBe(160000);expect(economy.players.p!.runwayMonths).toBe(9);
  heat=stepHeat(heat,context(),1,down.events);expect(heat.players.p!.vcQuarters).toBe(4);
  const next=stepPlayer(down,context(),2,economy,heat);expect(next.events.some(e=>e.kind==="player.down")).toBe(false);
  economy.players.p!.runwayMonths=0;const offer=stepPlayer(createPlayer(),context({wave:3}),3,economy,heat);expect(offer.players.p!.status).toBe("bridge");
  const declined=stepPlayer(offer,context({wave:3,commands:[{sequence:1,kind:"bridge-accept",playerId:"p"}]}),4,economy,heat);expect(declined.events.some(e=>e.kind==="player.bridge")).toBe(false);
 });
});

function driveMission(mission:Mission){
 let state=createMissions(),tick=1,sequence=1;let heat=createHeat();heat.players.p=createHeatStatus(0);const player=createPlayer();const grants=[];
 let ctx=context({missions:[mission],commands:[{sequence:sequence++,kind:"mission-start",playerId:"p",targetId:mission.id}]});
 for(let n=0;n<80;n++){
  const progress=state.players.p;const current=mission.steps.find(s=>s.id===(progress?.stepId??mission.start??mission.steps[0]!.id));
  ctx={...ctx,facts:[],commands:n===0?ctx.commands:[],observations:[]};
  if(current?.type==="trigger")ctx={...ctx,bodies:[{...body,...missionPlace(current.event.place)}],commands:[{sequence:sequence++,kind:n===0?"mission-start":"mission-ack",targetId:mission.id,playerId:"p"}]};
  if(current?.type==="goto")ctx={...ctx,bodies:[{...body,...missionPlace(current.target),mode:current.travel==="vehicle"?"vehicle":"foot"}]};
  if(current?.type==="timer")tick=Math.max(tick,(progress?.stepStartedTick??tick)+current.durationS*60);
  if(current?.type==="objective"){
   const objective=current.objective;const actorId=`mission:${mission.id}:${objective.actor}`;
   if(objective.kind==="watch")ctx={...ctx,observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:false,fog:0,watchingActorId:actorId,watchedTicks:(objective.seconds??3)*60}]};
   else if(objective.kind==="threatAtLeast")heat.players.p!.threat=objective.level??1;
   else if(objective.kind==="threatAtMost")heat.players.p!.threat=objective.level??0;
   else {const kinds={melt:"robot.heap",scan:"scan.result",cone:"cone.placed",interruptUpdate:"update.interrupted",refill:"water.refilled",enterVehicle:"vehicle.entered"};ctx={...ctx,facts:[fact(sequence++,tick,kinds[objective.kind as keyof typeof kinds],actorId)]};}
  }
  if(current?.type==="form")ctx={...ctx,commands:[{sequence:sequence++,kind:"startup-define",playerId:"p",kitId:ctx.validKitIds[0]}]};
  if(current?.type==="dialogue"){const question=current.questions[progress?.questionIndex??0]!;ctx={...ctx,commands:[{sequence:sequence++,kind:"mission-answer",playerId:"p",questionId:question.id,choiceId:question.answers[0]!.id}]};}
  state=stepMissions(state,ctx,tick,heat,player);grants.push(...state.events);
  if(state.players.p?.status==="complete")return {state,grants,ctx,heat,player,tick};tick++;
 }
 throw new Error(`Mission ${mission.id} stalled at ${state.players.p?.stepId} (${state.players.p?.status})`);
}
describe("authored mission runtime",()=>{
 for(const id of ["hot-desk","spill"])it(`completes ${id} through measured objectives and cannot pay twice`,()=>{
  const result=driveMission(MISSIONS.find(m=>m.id===id)!);expect(result.state.players.p!.status).toBe("complete");expect(result.grants.filter(e=>e.kind==="mission.cash")).toHaveLength(1);
  const replay=stepMissions(freeze(result.state),{...result.ctx,commands:[{sequence:999,kind:"mission-start",playerId:"p",targetId:id}]},result.tick+1,result.heat,result.player);expect(replay.events.some(e=>e.kind==="mission.cash")).toBe(false);
 });
 it("never lets an arbitrary completion command satisfy a combat objective",()=>{
  const mission=MISSIONS.find(m=>m.id==="spill")!;const state=createMissions();const result=driveMission(mission);state.players.p={...result.state.players.p!,status:"active",stepId:"melt",objectiveCount:0,objectiveIds:[],completedIds:[],commandSequence:0};
  const next=stepMissions(state,context({missions:[mission],commands:[{sequence:1,kind:"activity-complete",playerId:"p",targetId:"posted"}]}),5,result.heat,result.player);expect(next.events.some(e=>e.kind==="mission.cash")).toBe(false);
 });
});

describe("director and registered simulation",()=>{
 it("stages an encounter within 150m by 60 seconds for 20 seeds",()=>{
  const ctx=context({directorCards:[{id:"encounter",fromWave:2,radiusM:150,cooldownS:60,protectedAreas:false}]});
  for(let seed=1;seed<=20;seed++){
   const first=stepActivities(createActivities(),ctx,0,createMissions(),seed);const next=stepActivities(freeze(first),ctx,2700,createMissions(),seed);const staged=next.events.find(e=>e.kind==="director.stage")!;expect(staged).toBeDefined();expect(staged.amount).toBeLessThanOrEqual(150);expect(JSON.parse(staged.detail).x).toBeLessThanOrEqual(150);
  }
 });
 it("requires authoritative activity facts and registers every owned extension deterministically",()=>{
  const world=buildWorld([]);const start=freeze(createInitialState(world,123,["p"],{x:0,z:0,heading:0}));const ctx=context();const systems=createPlayerSystems(()=>ctx);
  const first=step(world,start,{},[],systems);const second=step(world,start,{},[],systems);expect(first).toEqual(second);expect(Object.keys(gameplaySnapshot({state:first}))).toHaveLength(6);expect(()=>JSON.stringify(first)).not.toThrow();
 });
});
