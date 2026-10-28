import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {canonicalJson} from "../../../src/sim/serialize.ts";
import {createProgression,createProgressionPlayer,stepProgression} from "../../../src/sim/progression/system.ts";
import {createDoomClock} from "../../../src/sim/progression/doom-clock.ts";
import {createWallet,createEconomy} from "../../../src/sim/economy/system.ts";
import {applyValidatedMatchCarry} from "../../../src/sim/modes/carry.ts";
import {applyMatchSettlement} from "../../../src/sim/modes/settlement.ts";
import {modeProgressionFacts} from "../../../src/sim/modes/progression.ts";
import {createMatchState,stepMatch} from "../../../src/sim/modes/match.ts";
import {createMatchSession} from "../../../src/sim/modes/session.ts";
import {DEFAULT_CATALOG} from "../../../src/sim/player/catalog.ts";
import type {GameplayContext,ProgressionState} from "../../../src/sim/player/types.ts";
const world=buildWorld([]),initial=(id="p")=>createInitialState(world,7,[id],{x:0,z:0,heading:0});
function city(){const state=initial();state.ext.progression={...createProgression(),players:{p:{...createProgressionPlayer(),xp:5500,rank:55,nozzle:"wide",gadget:"sprinkler",gear:"boots",perks:["lean","marine-layer"],streaks:["confidence","tensor"],banked:{confidence:2,tensor:1},pendingStreak:{kind:"confidence",sequence:7},streakSequence:7,streakPoints:800,earnedStreaks:["confidence","tensor"]}}};state.ext.economy={...createEconomy(),players:{p:{...createWallet(),cashCents:98765,ownedItemIds:["wide-nozzle","trunk-tank"],ownedSiteIds:["fidi-desk"]}}};return state;}
const ctx=(patch:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,wave:4,mode:"botSweep",bodies:[{id:"p",x:0,y:0,z:0,mode:"foot",speed:0}],actors:[],observations:[],facts:[],commands:[],day:0,month:1,...patch});
describe("SIM24 isolated profile authority",()=>{
 it("carries only validated earned profile/equipment authority without copying or mutating campaign money/bodies/RNG",()=>{
  const source=city(),before=canonicalJson(source),instance=initial("seat"),rng=instance.rng,body=instance.players.seat!.car;
  const carried=applyValidatedMatchCarry(instance,{city:source,bindings:{seat:"p"}}),profile=carried.ext.progression!.players.seat!,wallet=carried.ext.economy!.players.seat!;
  expect(profile).toMatchObject({xp:5500,rank:12,nozzle:"wide",gadget:"sprinkler",gear:"boots",perks:["lean"],banked:{},streakPoints:0,earnedStreaks:[],streakSequence:0});expect(profile.banked).toEqual({});expect(applyValidatedMatchCarry(initial("seat"),{city:source,bindings:{seat:"p"}}).ext.progression!.players.seat!.banked).toEqual({});expect(profile.pendingStreak).toBeUndefined();expect(wallet.cashCents).toBe(0);expect(wallet.ownedSiteIds).toEqual([]);expect(wallet.ownedItemIds).toEqual(["wide-nozzle","trunk-tank"]);expect(carried.ext.missions).toBeUndefined();expect(carried.rng).toBe(rng);expect(carried.players.seat!.car).toBe(body);
  profile.banked.confidence=0;wallet.ownedItemIds.push("roof-cannon");expect(canonicalJson(source)).toBe(before);
 });
 it("never manufactures rank/unlocks from saved choice strings or a duplicate city binding",()=>{
  const source=city();source.ext.progression!.players.p!.xp=0;const carried=applyValidatedMatchCarry(initial("seat"),{city:source,bindings:{seat:"p"}});expect(carried.ext.progression!.players.seat).toMatchObject({rank:1,nozzle:"standard",gadget:"balloon",gear:"none",perks:[],streaks:[]});
  expect(()=>applyValidatedMatchCarry(createInitialState(world,7,["a","b"],{x:0,z:0,heading:0}),{city:source,bindings:{a:"p",b:"p"}})).toThrow("unique");
  const old={...initial(),version:20};expect(applyValidatedMatchCarry(old,{city:source,bindings:{p:"p"}})).toBe(old);
 });
 it("exposes the host city source only as the explicit entry argument and preserves it through a JSON checkpoint",()=>{
  const source=city(),instance=createMatchSession(world,{id:"carry",mode:"cleanStreets",seed:7,players:["seat"]},{x:0,z:0,heading:0},{},{city:source,bindings:{seat:"p"}});
  expect(instance.ext.progression!.players.seat!.rank).toBe(12);expect(JSON.parse(JSON.stringify(instance)).ext.progression.players.seat.banked).toEqual({});expect(instance.ext.progression!.doom).toBeUndefined();
 });
 it("settles a winning faction move and its boundary once with the existing payout transaction",()=>{
  const source=city();source.ext.progression!.doom={...createDoomClock(),months:47,factions:{p:{pauser:2,accelerator:0}}};const before=canonicalJson(source),payout={id:"winner:p",playerId:"p",cashCents:100,xp:25,achievements:[],factionClockMoves:1};
  const paid=applyMatchSettlement(source,payout,"p");expect(paid.ext.progression!.doom).toMatchObject({months:24,winters:1});expect(paid.ext.progression!.events.filter(e=>e.kind==="world.ai-winter")).toHaveLength(1);expect(canonicalJson(source)).toBe(before);expect(applyMatchSettlement(paid,payout,"p")).toBe(paid);
  const restored=JSON.parse(JSON.stringify(paid));expect(applyMatchSettlement(restored,payout,"p")).toBe(restored);expect(applyMatchSettlement(source,{...payout,factionClockMoves:2},"p")).toBe(source);
  const old={...source,version:20};expect(applyMatchSettlement(old,payout,"p").ext.progression!.doom).toEqual(source.ext.progression!.doom);
 });
 it("derives bank points from canonical match score once without economy/combat double counting or city Doom",()=>{
  let match=createMatchState({id:"earned",mode:"botSweep",seed:7,players:["p"],relayId:"relay",badRobotIds:["bad"]});
  match=stepMatch(match,{simVersion:24,tick:1,positions:{p:{x:0,y:0,z:0}},combatEvents:[{id:1,tick:1,kind:"robot.heap",sourceId:"p",targetId:"bad",amount:1,detail:"footman"}]});
  let state=initial();state.ext.modes={match} as unknown as NonNullable<typeof state.ext.modes>;const facts=modeProgressionFacts(state,2);expect(facts[0]?.detail).toBe("melt");
  let profile:ProgressionState={...createProgression(),players:{p:{...createProgressionPlayer(),xp:550,streakPoints:200,earnedStreaks:[]}}};
  profile=stepProgression(profile,ctx({facts}),2,{}, {},24);expect(profile.players.p!.streakPoints).toBe(300);expect(profile.players.p!.banked.confidence).toBe(1);expect(profile.doom?.resets).toBe(0);
  profile=stepProgression(JSON.parse(JSON.stringify(profile)),ctx({facts:modeProgressionFacts(state,3)}),3,{}, {},24);expect(profile.players.p!.streakPoints).toBe(300);expect(profile.players.p!.banked.confidence).toBe(1);
 });
});
