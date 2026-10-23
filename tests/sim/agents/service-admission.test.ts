import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {makeFoot} from "../../../src/sim/foot.ts";
import {prepareMotionBodies} from "../../../src/sim/motion.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createHeat} from "../../../src/sim/heat/system.ts";
import {createAgentsRuntime} from "../../../src/sim/agents/runtime.ts";
import {createAgentsSystem} from "../../../src/sim/agents/systems.ts";
import {planServiceRuntime,serviceEntryClear} from "../../../src/sim/agents/service-runtime.ts";
import {planTransitRuntime,type TransitLayer} from "../../../src/sim/agents/transit-runtime.ts";
const world=buildWorld([],{version:1,nodes:[{id:"a",x:-500,z:0},{id:"b",x:500,z:0}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-500,0],[500,0]]}]});
world.roads={...world.roads!,areas:[]};
const transit:TransitLayer={version:1,routes:[{id:"FBUS-in",line:"FBUS",mode:"bus",direction:"inbound",night:false,paths:[[[-500,0],[500,0]]]}],stops:[{id:"s4513",x:0,y:0,z:0,routes:["FBUS-in"]},{id:"s-next",x:350,y:0,z:0,routes:["FBUS-in"]}]};
function initial(){const sim=createInitialState(world,7,["p"],{x:0,z:8,heading:0});sim.players.p!.mode="foot";sim.players.p!.foot=makeFoot(0,0,8,0);sim.players.p!.car.z=30;sim.ext.agents={nextId:1,list:[]};return sim;}
function request(){const sim=initial();sim.ext.heat={...createHeat(),events:[{id:1,tick:0,playerId:"p",targetId:"",amount:2,detail:"",kind:"threat.spawn",payload:{id:"heat:p:1",requestTick:0,playerId:"p",player:{x:0,z:0},kind:"van",threat:2,unitCount:2}}]};return sim;}

describe("service bodies pass physical admission",()=>{
 it("rejects the exact long-bus overlap from the SF tick1201 replay",()=>{
  const next={x:86.11231637828408,z:161.66352548205964,heading:-.7059982851862002};
  const accepted={x:79.95023053306147,z:154.56539699783687,heading:-.7042356300165814,halfLength:6.6,halfWidth:1.35,radius:1.4};
  const distance=Math.sqrt((next.x-accepted.x)**2+(next.z-accepted.z)**2);
  expect(distance).toBeGreaterThan(6.6+accepted.radius+.5);
  expect(serviceEntryClear(world,next,[accepted],6.6,1.35,3.2)).toBe(false);
 });
 it("checks the whole parked car even when its small radius is far from the entry center",()=>{
  expect(serviceEntryClear(world,{x:0,z:0,heading:0},[{x:0,z:8,heading:0,halfLength:2.2,halfWidth:.95}],6.6,1.35,3.2)).toBe(false);
 });
 it("chooses a different fresh bus entry when a player is on foot at the preferred entry",()=>{
  const sim=initial(),preferred=planTransitRuntime(world,sim,transit,undefined).spawns[0]!;
  sim.players.p!.foot=makeFoot(preferred.x,0,preferred.z,0);
  const system=createAgentsSystem(()=>({transit}),allocateActorIds);
  const planned=system.prepare({world,previous:sim,state:sim,inputs:{},events:[]});
  expect(planned.motions.filter(m=>m.kind==="vehicle")).toHaveLength(1);
  expect(()=>prepareMotionBodies(world,planned.state,planned.motions)).not.toThrow();
 });
 it("defers a blocked bus retry until the same origin clears",()=>{
  const sim=initial(),first=planTransitRuntime(world,sim,transit,undefined),bus=first.spawns[0]!;
  sim.tick=1;sim.players.p!.foot=makeFoot(bus.x,0,bus.z,0);
  const blocked=planTransitRuntime(world,sim,transit,first.state);
  expect(blocked.spawns).toEqual([]);expect(blocked.state.runs[bus.id]).toBeDefined();
  sim.tick=2;sim.players.p!.foot=makeFoot(0,0,8,0);
  expect(planTransitRuntime(world,sim,transit,blocked.state).spawns.map(a=>a.id)).toEqual([bus.id]);
 });
 it("checks pending bodies when retrying a bus",()=>{
  const sim=initial(),first=planTransitRuntime(world,sim,transit,undefined);
  sim.tick=1;expect(planTransitRuntime(world,sim,transit,first.state,first.spawns).spawns).toEqual([]);
 });
 it("defers a blocked van retry without creating a runtime or combat actor",()=>{
  const sim=request(),first=planServiceRuntime(world,sim,undefined),van=first.spawns[0]!;
  sim.tick=1;sim.players.p!.foot=makeFoot(van.x,0,van.z,0);
  sim.ext.robots={...createAgentsRuntime(sim),services:first.state};
  const system=createAgentsSystem(()=>({}),allocateActorIds),planned=system.prepare({world,previous:sim,state:sim,inputs:{},events:[]});
  expect(planned.motions).toEqual([]);expect(planned.state.ext.robots!.actors[van.id]).toBeUndefined();
  sim.tick=2;sim.players.p!.foot=makeFoot(0,0,8,0);
  expect(planServiceRuntime(world,sim,first.state).spawns.map(a=>a.id)).toEqual([van.id]);
 });
 it("admits simultaneous van and bus departures without overlapping pending hulls",()=>{
  const sim=request(),system=createAgentsSystem(()=>({transit}),allocateActorIds);
  const planned=system.prepare({world,previous:sim,state:sim,inputs:{},events:[]});
  expect(planned.motions.filter(m=>m.kind==="vehicle")).toHaveLength(2);
  expect(()=>prepareMotionBodies(world,planned.state,planned.motions)).not.toThrow();
 });
});
