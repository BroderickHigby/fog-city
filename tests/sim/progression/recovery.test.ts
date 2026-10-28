import {describe,expect,it} from "vitest";
import {Action} from "../../../src/sim/contract.ts";
import {createProgression,createProgressionPlayer,stepProgression,rankForXp} from "../../../src/sim/progression/system.ts";
import {stepLegacyProgression} from "../../../src/sim/progression/legacy-system.ts";
import {createDoomClock,doomEffects,stepDoomClock} from "../../../src/sim/progression/doom-clock.ts";
import {createEconomy,createWallet,stepEconomy} from "../../../src/sim/economy/system.ts";
import {DEFAULT_CATALOG,LEGACY_CATALOG} from "../../../src/sim/player/catalog.ts";
import {createActivities,stepActivities} from "../../../src/sim/activities/system.ts";
import {createMissions} from "../../../src/sim/missions/system.ts";
import {createPlayer,createPlayerStatus,stepPlayer} from "../../../src/sim/player/system.ts";
import {createHeat} from "../../../src/sim/heat/system.ts";
import {prepareMissionBell,TURNTABLES} from "../../../src/sim/missions/mechanics/bell.ts";
import {createMissionProgress} from "../../../src/sim/missions/system.ts";
import {MISSIONS} from "../../../src/content/catalog.ts";
import {PROGRESSION} from "../../../src/content/gameplay.ts";
import type {GameplayContext,GameplayEvent,ProgressionState} from "../../../src/sim/player/types.ts";
const ctx=(patch:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,wave:4,bodies:[{id:"p",x:0,y:0,z:0,mode:"foot",speed:0}],actors:[],facts:[],commands:[],observations:[],day:0,month:1,gameDay:0,mode:"freeRoam",...patch});
const profile=(patch:Partial<ReturnType<typeof createProgressionPlayer>>={}):ProgressionState=>({...createProgression(),players:{p:{...createProgressionPlayer(),xp:1000,...patch}}});
const grant=(id:number,kind:string,patch:Partial<GameplayEvent>={}):GameplayEvent=>({id,tick:id,kind,playerId:"p",targetId:"",amount:0,detail:"",...patch});
const ack=(sequence:number,kind="streak.used",streak="confidence",tick=2)=>({id:`combat:${tick}`,source:"combat" as const,sequence:tick,tick,kind,playerId:"p",amount:sequence,detail:streak});

describe("SIM21 authored progression",()=>{
 it("delegates the omitted/20 version to the unchanged legacy reducer",()=>{
  const state=profile(),context=ctx({actions:{p:Action.streak}}),groups={economy:[grant(1,"bounty.paid")]};
  expect(stepProgression(state,context,1,groups)).toEqual(stepLegacyProgression(state,context,1,groups));
  expect(stepProgression(state,context,1,groups,{},20)).toEqual(stepLegacyProgression(state,context,1,groups));
  expect(rankForXp(900)).toBe(4);expect(rankForXp(900,20)).toBe(2);
 });
 it("adopts an old score once and persists its earned ledger across JSON reload/equip changes",()=>{
  let state=stepProgression(profile({streakPoints:700,banked:{}}),ctx(),1,{}, {},21);
  expect(state.players.p!.banked.confidence).toBe(1);expect(state.players.p!.earnedStreaks).toEqual(["confidence","parrots","tensor"]);
  state.players.p!.banked.confidence=0;state=stepProgression(JSON.parse(JSON.stringify(state)),ctx(),2,{}, {},21);
  expect(state.players.p!.banked.confidence).toBe(0);expect(state.players.p!.streakPoints).toBe(700);
 });
 it("reserves with one fresh X and spends only an exact used acknowledgment once",()=>{
  let state=profile({earnedStreaks:["confidence"],banked:{confidence:2},streakPoints:310});
  state=stepProgression(state,ctx({actions:{p:Action.streak}}),1,{}, {},21);
  expect(state.players.p!.pendingStreak).toEqual({kind:"confidence",sequence:1});expect(state.players.p!.banked.confidence).toBe(2);expect(state.events.filter(e=>e.kind==="streak.grant")).toHaveLength(1);
  state=stepProgression(state,ctx({actions:{p:Action.streak},facts:[ack(99)]}),2,{}, {},21);expect(state.players.p!.pendingStreak?.sequence).toBe(1);expect(state.events).toEqual([]);
  state=stepProgression(state,ctx({actions:{p:Action.streak},facts:[ack(1,"streak.used","confidence",3)]}),3,{}, {},21);
  expect(state.players.p!.banked.confidence).toBe(1);expect(state.players.p!.pendingStreak).toBeUndefined();expect(state.players.p!.streakPoints).toBe(310);expect(state.events.filter(e=>e.kind==="streak.spent")).toHaveLength(1);
  state=stepProgression(state,ctx({facts:[ack(1,"streak.used","confidence",4)]}),4,{}, {},21);expect(state.players.p!.banked.confidence).toBe(1);
 });
 it("retains a rejected reward and accepts a fresh UI retry without command sequence collision",()=>{
  let state=profile({earnedStreaks:["confidence"],banked:{confidence:1}});
  state=stepProgression(state,ctx({commands:[{kind:"streak-call",playerId:"p",sequence:50,itemId:"confidence"}]}),1,{}, {},21);
  state=stepProgression(state,ctx({facts:[ack(1,"streak.rejected")]}),2,{}, {},21);
  expect(state.players.p!.banked.confidence).toBe(1);expect(state.players.p!.pendingStreak).toBeUndefined();expect(state.events.some(e=>e.kind==="streak.blocked")).toBe(true);
  state=stepProgression(state,ctx({commands:[{kind:"streak-call",playerId:"p",sequence:51,itemId:"confidence"}]}),3,{}, {},21);expect(state.players.p!.pendingStreak?.sequence).toBe(2);expect(state.players.p!.commandSequence).toBe(51);
 });
 it("uses accepted first-attack bonus and prevents repeated grants from re-awarding XP or bank",()=>{
  const context=ctx({actors:[{id:"bot",firmware:"bad",beforeFirstAttack:true} as GameplayContext["actors"][number]]});
  let state=profile({earnedStreaks:[],streakPoints:200});state=stepProgression(state,context,1,{economy:[grant(1,"bounty.paid",{targetId:"bot"})]}, {},21);
  expect(state.players.p!.streakPoints).toBe(350);expect(state.players.p!.banked.confidence).toBe(1);const xp=state.players.p!.xp;
  state=stepProgression(state,context,2,{economy:[grant(1,"bounty.paid",{targetId:"bot"})]}, {},21);expect(state.players.p!.xp).toBe(xp);expect(state.players.p!.banked.confidence).toBe(1);
 });
 it("enforces authored rank/ownership and perk/streak slot limits before applying choices",()=>{
  const command=(sequence:number,itemId:string)=>({kind:"loadout" as const,playerId:"p",sequence,itemId});
  let state=profile({xp:2800});state=stepProgression(state,ctx({commands:[command(1,"wide"),command(2,"speaker"),command(3,"boots")]}),1,{}, {},21);
  expect(state.players.p).toMatchObject({nozzle:"standard",gadget:"balloon",gear:"boots"});
  state=stepProgression(state,ctx({commands:[command(4,"wide"),command(5,"marine-layer"),command(6,"lean")]}),2,{}, {p:["wide-nozzle"]},21);expect(state.players.p!.nozzle).toBe("wide");expect(state.players.p!.perks).toEqual(["marine-layer"]);
 });
 it("isolates match Doom and requires actual spent AGI to reset the city clock",()=>{
  const before={...createDoomClock(),months:1,lastDay:0};
  expect(stepDoomClock(before,ctx({mode:"cleanStreets",gameDay:5}),1,[grant(1,"streak.spent",{targetId:"agi"})]).state).toBe(before);
  const request=stepDoomClock(before,ctx(),1,[grant(1,"streak.grant",{targetId:"agi"})]);expect(request.state.resets).toBe(0);
  const used=stepDoomClock(request.state,ctx(),2,[grant(2,"streak.spent",{targetId:"agi"})]);expect(used.state.resets).toBe(1);expect(used.events[0]?.kind).toBe("world.agi-achieved");
  expect(stepDoomClock(used.state,ctx(),3,[grant(2,"streak.spent",{targetId:"agi"})]).state.resets).toBe(1);
  const natural=stepDoomClock(before,ctx({gameDay:1}),1);expect(natural.state.resets).toBe(1);expect(natural.state.pausedUntil).toBe(181);
 });
 it("applies measured faction boundaries and winter modifiers once",()=>{
  const clock={...createDoomClock(),months:47,lastDay:0},fact={id:"activities:1",source:"world" as const,sequence:1,tick:1,playerId:"p",kind:"faction.pauser-completed"};
  const one=stepDoomClock(clock,ctx({facts:[fact]}),1);expect(one.state.winters).toBe(1);expect(one.state.months).toBe(24);expect(doomEffects(one.state,0,2).robotSpeedMultiplier).toBe(.9);
  const two=stepDoomClock(one.state,ctx({facts:[{...fact,tick:2}]}),2);expect(two.state.factions.p!.pauser).toBe(1);
 });
 it("keeps modern catalog measured and old catalog free of wave4 upgrade/faction additions",()=>{
  expect(LEGACY_CATALOG.items.some(item=>item.id==="wide-nozzle")).toBe(false);expect(DEFAULT_CATALOG.items.find(item=>item.id==="wide-nozzle")?.rank).toBe(8);
  expect(DEFAULT_CATALOG.activities.some(activity=>activity.id==="faction-pauser")).toBe(true);expect(DEFAULT_CATALOG.activities.some(activity=>activity.id==="pitch-window")).toBe(false);
 });
 it("checks vendor rank before cash debit and grants only available free garages",()=>{
  const item={id:"wide-nozzle",kind:"nozzle",priceCents:150000,rank:8,wave:4,effect:{}},site={id:"vendor",kind:"vendor" as const,x:0,y:0,z:0,radius:10,wave:4,vendorItems:[item.id]};
  const context=ctx({items:[item],sites:[site,{id:"garage-now",kind:"garage",x:0,y:0,z:0,radius:10,wave:4},{id:"garage-later",kind:"garage",x:0,y:0,z:0,radius:10,wave:5}],commands:[{playerId:"p",kind:"buy",sequence:1,targetId:site.id,itemId:item.id}]});
  let state=stepEconomy(createEconomy(),context,1,[],undefined,[],[],{p:1},{},21);expect(state.players.p!.cashCents).toBe(200000);expect(state.players.p!.ownedSiteIds).toContain("garage-now");expect(state.players.p!.ownedSiteIds).not.toContain("garage-later");
  state=stepEconomy(state,{...context,commands:[{...context.commands[0]!,sequence:2}]},2,[],undefined,[],[],{p:8},{},21);expect(state.players.p!.cashCents).toBe(50000);expect(state.players.p!.ownedItemIds).toContain(item.id);
 });
});

it("derives faction completion from accepted route, stopped final Interact and never a remote completion fact",()=>{
 const activity=DEFAULT_CATALOG.activities.find(a=>a.id==="faction-pauser")!,start=activity.checkpoints![0]!,finish=activity.checkpoints![1]!;
 const body={...start,id:"p",mode:"foot" as const,speed:0},context=ctx({bodies:[body],commands:[{kind:"activity-start",sequence:1,playerId:"p",targetId:activity.id}],activities:[activity],directorCards:[]});
 let state=stepActivities(createActivities(),context,1,createMissions(),7,21);
 expect(state.players.p!.activeActivityId).toBe(activity.id);
 state=stepActivities(state,{...context,commands:[],facts:[{id:"world:1",source:"world",sequence:1,tick:61,kind:"faction.pauser-completed",playerId:"p",actorId:activity.id}]},61,createMissions(),7,21);
 expect(state.events.some(e=>e.kind==="activity.cash")).toBe(false);expect(state.players.p!.objectiveCount).toBe(0);
 state=stepActivities(state,{...context,commands:[],facts:[],bodies:[{...body,...finish,id:"p"}],actions:{p:Action.interact}},62,createMissions(),7,21);
 expect(state.events.filter(e=>e.kind==="faction.pauser-completed")).toHaveLength(1);expect(state.events.filter(e=>e.kind==="activity.cash")).toHaveLength(1);
 state=stepActivities(state,{...context,commands:[],bodies:[{...body,...finish,id:"p"}],actions:{p:Action.interact}},63,createMissions(),7,21);expect(state.events.some(e=>e.kind==="activity.cash")).toBe(false);
 let fast=stepActivities(createActivities(),context,1,createMissions(),7,21);fast=stepActivities(fast,{...context,commands:[],bodies:[{...body,speed:6}]},2,createMissions(),7,21);expect(fast.events.some(e=>e.kind==="activity.failed")).toBe(true);
});
it("adds Default Alive only to an actually rewarded bounty and replays neither cash nor runway",()=>{
 const wallet={...createWallet(),runwayMonths:10},before={...createEconomy(),players:{p:wallet}},facts=[{id:"combat:1",source:"combat" as const,sequence:1,tick:1,kind:"robot.heap",playerId:"p",actorId:"bot"}],context=ctx({actors:[{id:"bot",firmware:"bad"}],facts});
 let state=stepEconomy(before,context,1,[],undefined,[],[],{}, {p:["default-alive"]},21);expect(state.players.p!.runwayMonths).toBe(11);const cash=state.players.p!.cashCents;
 state=stepEconomy(state,{...context,facts:[{...facts[0]!,tick:2}]},2,[],undefined,[],[],{}, {p:["default-alive"]},21);expect(state.players.p!.runwayMonths).toBe(11);expect(state.players.p!.cashCents).toBe(cash);
});
it("bills a Microclimate subscription once per observed absolute week, retains same-week credit and stops after cancel",()=>{
 const context=ctx({gameWeek:4}),gear={p:"microclimate"};
 let state=stepEconomy(createEconomy(),context,1,[],undefined,[],[],{}, {},21,gear);
 expect(state.players.p!.cashCents).toBe(199100);expect(state.players.p!.microclimatePaidWeek).toBe(4);expect(state.players.p!.microclimateActive).toBe(true);expect(state.events.filter(e=>e.kind==="subscription.renewed")).toHaveLength(1);
 state=stepEconomy(JSON.parse(JSON.stringify(state)),context,2,[],undefined,[],[],{}, {},21,gear);expect(state.players.p!.cashCents).toBe(199100);expect(state.events).toEqual([]);
 state=stepEconomy(state,context,3,[],undefined,[],[],{}, {},21,{p:"none"});expect(state.players.p!.microclimateActive).toBe(false);
 state=stepEconomy(state,context,4,[],undefined,[],[],{}, {},21,gear);expect(state.players.p!.cashCents).toBe(199100);
 state=stepEconomy(state,{...context,gameWeek:5},5,[],undefined,[],[],{}, {},21,gear);expect(state.players.p!.cashCents).toBe(198200);
 state=stepEconomy(state,{...context,gameWeek:6},6,[],undefined,[],[],{}, {},21,{p:"none"});expect(state.players.p!.cashCents).toBe(198200);
});
it("never charges or enables an unpaid subscription, spams one notice, or bills a match/legacy context",()=>{
 const context=ctx({gameWeek:1}),before={...createEconomy(),players:{p:{...createWallet(),cashCents:899}}},gear={p:"microclimate"};
 let state=stepEconomy(before,context,1,[],undefined,[],[],{}, {},21,gear);expect(state.players.p!.cashCents).toBe(899);expect(state.players.p!.microclimateActive).toBe(false);expect(state.events.filter(e=>e.kind==="subscription.unpaid")).toHaveLength(1);
 state=stepEconomy(state,context,2,[],undefined,[],[],{}, {},21,gear);expect(state.events).toEqual([]);state.players.p!.cashCents=900;
 state=stepEconomy(state,context,3,[],undefined,[],[],{}, {},21,gear);expect(state.players.p!.cashCents).toBe(0);expect(state.players.p!.microclimateActive).toBe(true);
 const mode=stepEconomy(before,{...context,mode:"cleanStreets"},1,[],undefined,[],[],{}, {},21,gear);expect(mode.players.p!.cashCents).toBe(899);expect(mode.players.p!.microclimateActive).toBeUndefined();
 const legacy=stepEconomy(before,context,1,[],undefined,[],[],{}, {},20,gear);expect(legacy.players.p!.microclimateActive).toBeUndefined();
});

it("AI Winter blocks new bridge answers only in21 and a paid accepted bridge is not immediately reopened",()=>{
 const before={...createPlayer(),players:{p:{...createPlayerStatus(),status:"bridge" as const,bridgeUntil:1000}}},economy={...createEconomy(),players:{p:{...createWallet(),runwayMonths:0}}},context=ctx({simVersion:24,associatesAnswer:false,commands:[{kind:"bridge-accept",sequence:1,playerId:"p"}],observations:[{playerId:"p",seenByBad:false,seenByAssociate:true,associateWithin200:true,fog:0,protectedArea:false}]});
 expect(stepPlayer(before,context,1,economy,createHeat()).events.some(e=>e.kind==="player.bridge")).toBe(false);
 const accepted=stepPlayer(before,{...context,associatesAnswer:true},1,economy,createHeat());expect(accepted.players.p!.status).toBe("active");expect(accepted.events.filter(e=>e.kind==="player.bridge")).toHaveLength(1);expect(accepted.events.some(e=>e.kind==="player.bridge-offer")).toBe(false);
 expect(stepPlayer(before,{...context,simVersion:20},1,economy,createHeat()).events.some(e=>e.kind==="player.bridge")).toBe(true);
});
it("AI Winter blocks new21 Bell Duels but an already accepted round can complete",()=>{
 const mission=MISSIONS.find(m=>m.steps.some(s=>s.type==="objective"&&s.objective.kind==="event"&&s.objective.event==="bell.duelStarted"))!;
 const step=mission.steps.find(s=>s.type==="objective"&&s.objective.kind==="event"&&s.objective.event==="bell.duelStarted")!;
 const missions={...createMissions(),players:{p:{...createMissionProgress(),missionId:mission.id,stepId:step.id,status:"active" as const,startedTick:0,visits:1}}},body={...TURNTABLES[0]!,id:"p",y:0,mode:"foot" as const,speed:0};
 const context=ctx({simVersion:24,associatesAnswer:false,missions:[mission],bodies:[body],actions:{p:Action.interact}});
 expect(prepareMissionBell(undefined,missions,context,createHeat(),1,7).state.duels.p).toBeUndefined();
 expect(prepareMissionBell(undefined,missions,{...context,simVersion:20},createHeat(),1,7).state.duels.p).toBeDefined();
 let duel=prepareMissionBell(undefined,missions,{...context,associatesAnswer:true},createHeat(),1,7),won=false;const request=duel.state.duels.p!.requestId,responses=new Set(duel.state.duels.p!.responseTicks);
 for(let tick=2;tick<=1500&&!won;tick++){duel=prepareMissionBell(duel.state,missions,{...context,actions:{p:responses.has(tick)?Action.interact:0}},createHeat(),tick,7);won=duel.facts.some(f=>f.kind==="bell.roundWon");}
 expect(won).toBe(true);expect(duel.state.duels.p!.requestId).toBe(request);
});
