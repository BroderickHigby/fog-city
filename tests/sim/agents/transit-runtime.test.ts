import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {makeFoot} from "../../../src/sim/foot.ts";
import {createAgentsRuntime} from "../../../src/sim/agents/runtime.ts";
import {planTransitRuntime,type TransitLayer} from "../../../src/sim/agents/transit-runtime.ts";
import type {SimState} from "../../../src/sim/contract.ts";
const world=buildWorld([],{version:1,nodes:[{id:"a",x:-500,z:0},{id:"b",x:500,z:0}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-500,0],[500,0]]}]});
const data:TransitLayer={version:1,routes:[{id:"FBUS-in",line:"FBUS",mode:"bus",direction:"inbound",night:false,paths:[[[-500,0],[500,0]]]}],stops:[{id:"s4513",x:0,y:0,z:0,routes:["FBUS-in"]},{id:"s-next",x:350,y:0,z:0,routes:["FBUS-in"]}]};
function initial(){const sim=createInitialState(world,7,["p"],{x:0,z:0,heading:0});sim.players.p!.mode="foot";sim.players.p!.foot=makeFoot(0,0,0,0);sim.players.p!.car.z=30;sim.ext.agents={nextId:1,list:[]};return sim;}
describe("observed Ferry bus service",()=>{
 it("starts wrapped road vehicles every ten game minutes without inventing a pass",()=>{const sim=initial(),first=planTransitRuntime(world,sim,data,undefined);expect(first.spawns).toHaveLength(1);expect(first.spawns[0]).toMatchObject({model:"bus",adWrapSlot:{surface:"left-right-rear",contentKey:null}});expect(first.state.events.map(e=>e.kind)).toEqual(["transit.departed"]);const next=planTransitRuntime(world,{...sim,tick:600},data,first.state);expect(Object.keys(next.state.runs)).toHaveLength(2);expect(next.state.events.some(e=>e.kind==="transit.ferry-pass")).toBe(false);});
 it("reports Ferry passage only from an actual stopped body at the stop, once",()=>{let sim=initial();const first=planTransitRuntime(world,sim,data,undefined),run=first.state.runs[first.spawns[0]!.id]!,stop=run.stops[0]!;const runtime=createAgentsRuntime(sim,{spawns:[{...first.spawns[0]!,numericId:100,x:stop.x,z:stop.z}]});run.follower={...run.follower,lastX:stop.x,lastZ:stop.z};sim={...sim,tick:300,ext:{...sim.ext,robots:runtime as unknown as NonNullable<SimState["ext"]["robots"]>}};const arrived=planTransitRuntime(world,sim,data,first.state);expect(arrived.state.events.filter(e=>e.kind==="transit.ferry-pass")).toHaveLength(1);expect(arrived.state.events.find(e=>e.kind==="transit.ferry-pass")!.stopId).toBe("s4513");expect(planTransitRuntime(world,{...sim,tick:301},data,arrived.state).state.events).toEqual([]);});
 it("does not spawn offscreen service or guess routes from missing data",()=>{const sim=initial();sim.players.p!.foot!.x=2000;expect(planTransitRuntime(world,sim,data,undefined).spawns).toEqual([]);expect(planTransitRuntime(world,initial(),undefined,undefined).spawns).toEqual([]);});
});
