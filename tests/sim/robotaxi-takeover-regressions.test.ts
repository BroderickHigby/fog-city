import { describe,expect,it } from "vitest";
import { DT,canonicalJson,createInitialState,dodgeExtOf,makeCar,makeFoot,runSystems,step,type SimState,type AgentState } from "../../src/sim/index.ts";
import { commandeerTaxi } from "../../src/sim/manual-taxi.ts";
import { commandeerFacts,createPlayerSystems,defaultGameplayProvider } from "../../src/sim/player/adapter.ts";
import { facts } from "../../src/sim/player/common.ts";
import { IMPACT,impactsOf } from "../../src/sim/impacts.ts";
import { deepFreeze } from "../helpers.ts";
import { emptyWorld,gridCity } from "./fixtures.ts";

const idle={throttle:0,steer:0,brake:0,actions:0},grid=gridCity(),open=emptyWorld();
const physicalWorld={...open,roads:{...grid.roads!,areas:[],areaIndex:new Map()}};
const template=createInitialState(grid,5,["p"],{x:150,z:0,heading:Math.PI/2}).ext.agents!.list.find(a=>a.kind==="robotaxi"&&a.id%8!==7)!;
function driving(speed=0,lateral=0):SimState {
 const state=createInitialState(physicalWorld,5,["p"],{x:-100,z:-100,heading:0});
 const heading=Math.PI/2,z=40;
 const taxi:AgentState={...commandeerTaxi(template),x:0,y:0,z,heading,pitch:0,speed,edge:"h00",dir:1,lane:0,s:20,next:"",node:"",manualCar:{...makeCar(0,z,heading),speed,lateral}};
 state.ext={agents:{nextId:2000,list:[taxi]}};
 state.players.p!.ride={agentId:taxi.id,manual:true,x:0,y:0,z,heading,speed,goal:null,exitPending:false};
 return state;
}

describe("manual taxi review regressions",()=>{
 it("predicts forward, reverse and sideways manual travel off the old lane before a last-moment override",()=>{
  for(const direction of ["forward","reverse","sideways"] as const) for(const protectedPerson of [false,true]) {
   const speed=direction==="forward"?8:direction==="reverse"?-8:0,lateral=direction==="sideways"?8:0;
   let state=driving(speed,lateral);
   const person:AgentState={...template,id:1001,kind:"person",runtimeId:"stationary-person",protected:protectedPerson,child:protectedPerson,x:direction==="sideways"?0:speed<0?-10:10,y:0,z:direction==="sideways"?46:40,heading:0,pitch:0,speed:0,dodge:null};
   state.ext.agents!.list.push(person);
   state=step(physicalWorld,state,{p:idle},[],[]);
   expect(dodgeExtOf(state).dives,`${direction}, protected=${protectedPerson}`).toBeGreaterThan(0);
   expect(dodgeExtOf(state).overrides).toBe(0);
   for(let i=1;i<90;i++) state=step(physicalWorld,state,{p:idle},[],[]);
   expect(dodgeExtOf(state).contacts).toBe(0);expect(dodgeExtOf(state).failures).toBe(0);
  }
 });

 it("moves an impulsed personal car only once while its owner drives the taxi",()=>{
  let state=driving();state.players.p!.car={...makeCar(-100,0,Math.PI/2),speed:10};
  const frozen=deepFreeze(state),snapshot=canonicalJson(state);
  const after=step(physicalWorld,frozen,{p:idle},[],[]);
  const expectedSpeed=10-IMPACT.slideBrake*DT;
  expect(after.players.p!.car.x).toBeCloseTo(-100+expectedSpeed*DT,10);
  expect(after.players.p!.car.speed).toBeCloseTo(expectedSpeed,8);
  expect(after.players.p!.car.x-state.players.p!.car.x).toBeLessThan(10*DT);
  expect(canonicalJson(state)).toBe(snapshot);
  const continued=step(physicalWorld,after,{p:idle},[],[]);
  const restored=step(physicalWorld,JSON.parse(canonicalJson(after)) as SimState,{p:idle},[],[]);
  expect(canonicalJson(restored)).toBe(canonicalJson(continued));
 });

 it("settles the parked personal car's collision while the taxi keeps its own body",()=>{
  let state=driving();state.players.p!.car={...makeCar(-100,0,Math.PI/2),speed:10};
  const parked={...template,id:3,x:-94.8,y:0,z:0,heading:Math.PI/2,speed:0,manualCar:makeCar(-94.8,0,Math.PI/2)};
  state.ext.agents!.list.push(parked);
  for(let i=0;i<8;i++) state=step(physicalWorld,state,{p:idle},[],[]);
  expect(impactsOf(state)?.events.some(event=>[event.a,event.b].sort().join("|")===["p:p","a:3"].sort().join("|"))).toBe(true);
  expect(state.ext.agents!.list.find(a=>a.id===3)!.x).toBeGreaterThan(-94.8);
  expect(state.players.p!.ride).toMatchObject({x:0,z:40});
  expect(dodgeExtOf(state).contacts).toBe(0);
 });

 it("admits bounded, distinct takeover facts for UUID, colon and maximum-length player IDs",()=>{
  const ids=["01234567-89ab-cdef-0123-456789abcdef","colon:player", "colon-player","p".repeat(128)];
  const previous=createInitialState(open,5,ids,{x:0,z:0,heading:0});
  for(const tick of [1,Number.MAX_SAFE_INTEGER]) {
   const state={...previous,tick,players:{...previous.players}};
   ids.forEach((id,index)=>{state.players[id]={...previous.players[id]!,ride:{agentId:index+1,manual:true,x:0,y:0,z:0,heading:0,speed:0,goal:null,exitPending:false}};});
   const inputs=Object.fromEntries(ids.map(id=>[id,idle]));
   const context={world:open,previous,state,inputs,events:[]};
   const provider=defaultGameplayProvider(context);
   const emitted=commandeerFacts({previous,state});
   expect(emitted).toHaveLength(ids.length);expect(new Set(emitted.map(f=>f.id)).size).toBe(ids.length);
   expect(emitted.every(f=>f.id.length<=128&&Number.isSafeInteger(f.sequence))).toBe(true);
   const cursors:Record<string,number>={};
   expect(facts({...provider,facts:emitted},tick,cursors)).toHaveLength(ids.length);
   expect(facts({...provider,facts:JSON.parse(JSON.stringify(emitted))},tick,JSON.parse(JSON.stringify(cursors)))).toHaveLength(0);
   const charged=runSystems({world:open,previous,state,inputs,events:[]},createPlayerSystems());
   for(const id of ids) {
    expect(charged.ext.heat!.players[id]!.vcQuarters).toBe(4);
    expect(charged.ext.economy!.players[id]!.reputation).toBe(49);
   }
   const restored=JSON.parse(canonicalJson(charged)) as SimState;
   const again=runSystems({world:open,previous:restored,state:restored,inputs,events:[]},createPlayerSystems());
   for(const id of ids) {
    expect(again.ext.heat!.players[id]!.vcQuarters).toBe(4);
    expect(again.ext.economy!.players[id]!.reputation).toBe(49);
   }
  }
 });
});
