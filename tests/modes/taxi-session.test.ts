/** Draft destination: tests/modes/taxi-session.test.ts. NOT EXECUTED while source is frozen. */
import { expect, it } from "vitest";
import { buildWorld } from "../../src/sim/world.ts";
import { allocateActorIds } from "../../src/sim/identity.ts";
import { createInitialState, step } from "../../src/sim/step.ts";
import { createGameSystems } from "../../src/sim/game-systems.ts";
import { canonicalJson } from "../../src/sim/serialize.ts";
import { createEconomy, createWallet } from "../../src/sim/economy/system.ts";
import { createProgression, createProgressionPlayer } from "../../src/sim/progression/system.ts";
import { gameplaySnapshot } from "../../src/sim/player/adapter.ts";
import { applyMatchSettlement, settledModeIds } from "../../src/sim/modes/settlement.ts";
import { acceptedTaxiPassenger, acceptedTaxiVehicle, advanceTaxiSession, createTaxiSession, encodeTaxiSession, settleTaxiSession } from "../../src/modes/taxi-session.ts";
import { taxiSettlement } from "../../src/sim/modes/taxi.ts";
import type { TaxiConfig } from "../../src/sim/modes/taxi.ts";
const config:TaxiConfig={version:1,id:"taxi-fixture",routes:[{id:"mission-soma",pickupLabel:"Mission",destinationLabel:"SoMa",pickupDistrict:"Mission",destinationDistrict:"SoMa",pickup:{x:0,y:0,z:0,radiusM:3},destination:{x:100,y:0,z:0,radiusM:3},roadDistanceM:120,timeLimitTicks:600,baseFareCents:1000,timeBonusCentsPerSecond:10,maxTimeBonusCents:100,xp:20}],shifts:[{id:"day",label:"Day",theme:"daylight",routeIds:["mission-soma"]}]};
const world=buildWorld([]),spawn={x:0,z:0,heading:0};
function create(){const city=createInitialState(world,9,["p1"],{x:50,z:70,heading:1});city.tick=900;city.players.p1!.car.hits=4;city.ext.economy={...createEconomy(city.tick),players:{p1:{...createWallet(),cashCents:12345}}};city.ext.progression={...createProgression(city.tick),players:{p1:{...createProgressionPlayer(),xp:321}}};return {city,session:createTaxiSession(world,city,config,{id:"taxi-1",playerId:"p1",seed:3},spawn)};}
it("keeps a detached exact campaign checkpoint and a fresh unprivileged instance",()=>{
  const {city,session}=create(),before=canonicalJson(city);
  expect(session.campaign).not.toBe(city);expect(session.campaign.players).not.toBe(city.players);
  expect(canonicalJson(session.campaign)).toBe(before);expect(session.instance.tick).toBe(0);expect(session.instance.ext.economy).toBeUndefined();expect(session.instance.ext.missions).toBeUndefined();
  city.players.p1!.car.x=999;session.instance.players.p1!.car.z=999;
  expect(session.campaign.players.p1!.car.x).toBe(50);expect(session.campaign.players.p1!.car.z).toBe(70);
});
it("settles an exited aggregate once and restores every other campaign field",()=>{
  let {session}=create();const cityBefore=canonicalJson(session.campaign),carBefore=canonicalJson(session.campaign.players),priorWallet=gameplaySnapshot({state:session.campaign}).economy.players.p1!.cashCents,priorXp=gameplaySnapshot({state:session.campaign}).progression.players.p1!.xp;
  expect(()=>settleTaxiSession(session)).toThrow("Exit");
  session={...session,taxi:{...session.taxi,phase:"exited",completedFares:1,paidFareIds:[session.taxi.trip.id],totalCashCents:1090,totalXp:20}};
  const restored=settleTaxiSession(session);expect(settleTaxiSession(restored)).toBe(restored);
  expect(canonicalJson(session.campaign)).toBe(cityBefore);expect(canonicalJson(restored.restored!.players)).toBe(carBefore);
  expect(canonicalJson({...restored.restored!,ext:{...restored.restored!.ext,economy:session.campaign.ext.economy,progression:session.campaign.ext.progression}})).toBe(cityBefore);
  expect(restored.restored!.tick).toBe(session.campaign.tick);expect(restored.restored!.rng).toEqual(session.campaign.rng);
  expect(gameplaySnapshot({state:restored.restored!}).economy.players.p1!.cashCents).toBe(priorWallet+1090);
  expect(gameplaySnapshot({state:restored.restored!}).progression.players.p1!.xp).toBe(priorXp+20);
  expect(settledModeIds(restored.restored!)).toEqual(["taxi-1:p1"]);
  expect(applyMatchSettlement(restored.restored!,taxiSettlement(session.taxi)!,"p1")).toBe(restored.restored);
  expect(canonicalJson(JSON.parse(encodeTaxiSession(restored)).session)).toBe(canonicalJson(restored));
});
it("requires contiguous accepted physics state and does not invent a missing passenger",()=>{
  const {session}=create();const next={...session.instance,tick:1};
  const advanced=advanceTaxiSession(session,world,next,{interact:true,route:{id:session.taxi.trip.routeId,status:"open"}});
  expect(advanced.taxi.phase).toBe("pickup");expect(advanced.taxi.reason).toBe("waiting-passenger-required");
  expect(()=>advanceTaxiSession(session,world,{...next,tick:2},{interact:false,route:{id:session.taxi.trip.routeId,status:"open"}})).toThrow("contiguous");
});
it("uses the actual driven body and excludes autonomous rides and on-foot players",()=>{
  const {session}=create(),state=session.instance;expect(acceptedTaxiVehicle(world,state,"p1")?.vehicleId).toBe("p1-car");
  const onFoot={...state,players:{...state.players,p1:{...state.players.p1!,mode:"foot" as const}}};expect(acceptedTaxiVehicle(world,onFoot,"p1")).toBeNull();
  const riding={...state,players:{...state.players,p1:{...state.players.p1!,ride:{agentId:99,x:0,y:0,z:0,heading:0,speed:0,goal:null,exitPending:false}}}};
  expect(acceptedTaxiVehicle(world,riding,"p1")).toBeNull();
});

it("keeps a care-dodged sidewalk passenger valid without accepting a distant or fabricated binding",()=>{
  const {session}=create(),id=session.taxi.trip.passengerId,anchor={x:4.5,y:0,z:0};
  const reserved=allocateActorIds(session.instance,[id]);
  const systems=createGameSystems({wave:3,agents:()=>({services:false,director:undefined,spawns:[{id,numericId:reserved.ids[id]!,model:"person",firmware:"none",...anchor,heading:0,radius:.35,height:1.7,protected:true,posted:true,significant:true,ownerId:"p1"}]}),modes:[]});
  const accepted=step(world,reserved.state,{p1:{throttle:0,steer:0,brake:1,actions:0}},[],systems);
  expect(acceptedTaxiPassenger(accepted,session.taxi,config,anchor)).toBe(id);
  // The human is outside the 3.8 m vehicle zone but still beside its authored sidewalk anchor.
  expect(acceptedTaxiPassenger(accepted,session.taxi,config,{x:0,y:0,z:0})).toBeNull();
  const bodies=accepted.ext.agents!;
  const shifted=(patch:Record<string,unknown>)=>({...accepted,ext:{...accepted.ext,agents:{...bodies,list:bodies.list.map(body=>body.runtimeId===id?{...body,...patch}:body)}}});
  expect(acceptedTaxiPassenger(shifted({x:20}),session.taxi,config,anchor)).toBeNull();
  expect(acceptedTaxiPassenger(shifted({y:3}),session.taxi,config,anchor)).toBeNull();
  expect(acceptedTaxiPassenger(shifted({runtimeId:"wrong-passenger"}),session.taxi,config,anchor)).toBeNull();
  expect(acceptedTaxiPassenger({...accepted,ext:{...accepted.ext,agents:{...bodies,list:[]}}},session.taxi,config,anchor)).toBeNull();
});
