import {describe,expect,it} from "vitest";
import {buildWorld,circleBlocked} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createMissions} from "../../../src/sim/missions/system.ts";
import {createAgentsSystem} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf,planAgentRuntime} from "../../../src/sim/agents/runtime.ts";
import {decodeMissionScene,planSceneActors,type MissionScene} from "../../../src/sim/agents/scene-actors.ts";
import {ROBOTAXI_BODY} from "../../../src/sim/agents.ts";
import {boxDistance} from "../../../src/sim/dodge.ts";
const world=buildWorld([],{version:1,nodes:[{id:"a",x:-100,z:0},{id:"b",x:100,z:0}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-100,0],[100,0]]}]});
const scene:MissionScene={missionId:"teleop",anchor:{x:30,y:0,z:8},actors:[{id:"mission:teleop:van",role:"van",model:"van",firmware:"good",offset:{x:0,z:0},radius:1.4,height:2.4},{id:"mission:teleop:unit",role:"unit",model:"footman",firmware:"good",offset:{x:4,z:0},radius:.4,height:1.8},{id:"mission:teleop:recipient",role:"recipient",model:"person",firmware:"none",offset:{x:10,z:0},radius:.4,height:1.8}]};
function initial(){return createInitialState(world,12,["p"],{x:0,z:8,heading:0});}
describe("mission scene actors",()=>{
 it("validates supported scene models and rejects invalid geometry and prototype IDs",()=>{
  const event={kind:"mission.scene-request",detail:JSON.stringify(scene)};expect(decodeMissionScene(event)).toEqual(scene);
  for(const actor of [{...scene.actors[0],radius:500},{...scene.actors[0],id:"__proto__"},{...scene.actors[0],model:"walker",height:500}])expect(decodeMissionScene({...event,detail:JSON.stringify({...scene,actors:[actor]})})).toBeNull();
 });
 it("places a parked road van and separate protected recipient bodies using shared allocation",()=>{
  let sim=initial();const plan=planSceneActors(world,sim,scene);expect(plan.blocked).toEqual([]);expect(plan.actors).toHaveLength(3);expect(plan.actors.find(a=>a.model==="person")!.protected).toBe(true);
  const missions=createMissions();missions.events=[{id:1,tick:0,kind:"mission.scene-request",targetId:"teleop",playerId:"p",amount:0,detail:JSON.stringify(scene)}];sim.ext.missions=missions;
  const system=createAgentsSystem(()=>({services:false}),allocateActorIds);sim=step(world,sim,{},[],[system]);
  const actors=agentsRuntimeOf(sim)!.actors;expect(Object.keys(actors).filter(id=>id.startsWith("mission:teleop:"))).toHaveLength(3);for(const id of Object.keys(actors).filter(id=>id.startsWith("mission:teleop:")))expect(circleBlocked(world,actors[id]!.x,actors[id]!.z,actors[id]!.radius)).toBe(false);
  const recipient=actors["mission:teleop:recipient"]!;const at={x:recipient.x,z:recipient.z};sim=step(world,sim,{},[],[system]);expect(agentsRuntimeOf(sim)!.actors[recipient.id]).toMatchObject(at);
 });
 it("keeps scene bodies outside a parked legacy robotaxi's box, not a 0.5 m circle",()=>{
  const sim=initial(),taxi={id:9001,kind:"robotaxi" as const,x:30,y:0,z:9.5,heading:0,pitch:0,speed:0,vmax:0,edge:"road",dir:1 as const,lane:0,s:0,next:"",ndir:1 as const,nlane:0,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go" as const,rng:1,dodge:null};
  sim.ext.agents={nextId:9002,list:[...(sim.ext.agents?.list??[]).filter(a=>Math.abs(a.x-30)>20||Math.abs(a.z-8)>20),taxi]};
  const person:MissionScene={missionId:"teleop",anchor:{x:30,y:0,z:8},actors:[{id:"mission:teleop:recipient",role:"recipient",model:"person",firmware:"none",offset:{x:0,z:0},radius:.4,height:1.8}]};
  const plan=planSceneActors(world,sim,person);expect(plan.actors).toHaveLength(1);
  const placed=plan.actors[0]!;
  // (The anchor is 1.5 m from the taxi's centre, inside its 2.5 m half length.)
  expect(boxDistance(placed.x,placed.z,taxi.x,taxi.z,0,-1,ROBOTAXI_BODY.halfLength,ROBOTAXI_BODY.halfWidth)).toBeGreaterThan(.4+.5);
 });
 it("retains controlled bodies while autonomous proposals and attacks stop",()=>{
  const sim=initial(),spawn={id:"controlled",numericId:10,model:"footman" as const,firmware:"bad" as const,x:30,y:0,z:8,heading:0,radius:.4,height:1.8};
  const planned=planAgentRuntime(world,sim,{},{spawns:[spawn],controlledActorIds:[spawn.id]});expect(planned.actors.controlled!.behavior).toBe("controlled");expect(planned.proposals.some(p=>p.id===spawn.id)).toBe(false);expect(planned.attacks).toEqual([]);
 });
 it("samples authoritative fog at the actor position",()=>{
  const sim=initial(),samples:{x:number;z:number}[]=[];planAgentRuntime(world,sim,{},{spawns:[{id:"fogged",numericId:10,model:"footman",firmware:"bad",x:30,y:0,z:8,heading:0,radius:.4,height:1.8}],fogAt:(x,z)=>{samples.push({x,z});return 1;}});expect(samples).toContainEqual({x:30,z:8});
 });
});
