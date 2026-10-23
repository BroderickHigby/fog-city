import {describe,it,expect} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createMissions,createMissionProgress,missionPlace} from "../../../src/sim/missions/system.ts";
import {createAgentsSystem} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf,createAgentsRuntime,runtimeCombatActors} from "../../../src/sim/agents/runtime.ts";
import {buildSidewalkGraph} from "../../../src/sim/agents/navigation.ts";
import {pendingMissionStages} from "../../../src/sim/agents/mission-staging.ts";
import {planMissionActors} from "../../../src/sim/agents/mission-actors.ts";
import {MISSIONS} from "../../../src/content/catalog.ts";
import {dodgeExtOf} from "../../../src/sim/dodge.ts";
import type {SimState} from "../../../src/sim/contract.ts";
const world=buildWorld([]),graph=buildSidewalkGraph({nodes:[{id:"only",x:0,z:0}],edges:[]});
const system=createAgentsSystem(()=>({graph,services:false}),allocateActorIds);
function initial(actors=["a"]){
 const sim=createInitialState(world,7,["p"],{x:0,z:0,heading:0});
 sim.ext.missions={...createMissions(),players:{p:{...createMissionProgress(),missionId:"test",stepId:"wait",status:"active"}},events:[{id:1,tick:0,playerId:"p",targetId:"test",kind:"mission.stage",amount:0,detail:JSON.stringify({stepId:"stage",actors,definitions:{a:{kind:"goodRobot",posted:true},b:{kind:"goodRobot",posted:true}},place:{x:0,y:0,z:0},radius:2.9})}]};
 return sim;
}
function withoutEvent(sim:ReturnType<typeof initial>):SimState{return {...sim,ext:{...sim.ext,missions:{...sim.ext.missions!,events:[]}}};}
describe("durable mission actor admission",()=>{
 it("retries a transiently blocked one-shot stage without phantom actors or early ID allocation",()=>{
  let sim=step(world,initial(),{},[],[system]);
  expect(agentsRuntimeOf(sim)!.actors["mission:test:a"]).toBeUndefined();
  expect(runtimeCombatActors(sim)).toEqual([]);expect(sim.ext.identities).toBeUndefined();
  expect(Object.keys(agentsRuntimeOf(sim)!.missionStages!)).toHaveLength(1);
  sim=withoutEvent(sim);sim.players.p!.car.x=100;
  for(let tick=0;tick<31;tick++)sim=step(world,sim,{},[],[system]);
  const actor=agentsRuntimeOf(sim)!.actors["mission:test:a"]!;
  expect(actor).toBeDefined();expect(sim.ext.agents!.list.filter(body=>body.runtimeId===actor.id)).toHaveLength(1);
  expect(agentsRuntimeOf(sim)!.missionStages).toEqual({});expect(dodgeExtOf(sim).contacts).toBe(0);
  const id=actor.numericId;
  for(let tick=0;tick<35;tick++)sim=step(world,sim,{},[],[system]);
  expect(agentsRuntimeOf(sim)!.actors[actor.id]!.numericId).toBe(id);
  expect(sim.ext.agents!.list.filter(body=>body.runtimeId===actor.id)).toHaveLength(1);
 });
 it("retains accepted members while retrying only the missing part of a roster",()=>{
  const before=initial(["a","b"]);before.players.p!.car.x=100;
  let sim=withoutEvent(step(world,before,{},[],[system]));
  const first=agentsRuntimeOf(sim)!.actors["mission:test:a"]!;
  expect(first).toBeDefined();expect(agentsRuntimeOf(sim)!.actors["mission:test:b"]).toBeUndefined();
  sim.ext.agents!.list=sim.ext.agents!.list.map(body=>body.runtimeId===first.id?{...body,x:10}:body);
  for(let tick=0;tick<31;tick++)sim=step(world,sim,{},[],[system]);
  expect(agentsRuntimeOf(sim)!.actors[first.id]!.numericId).toBe(first.numericId);
  expect(agentsRuntimeOf(sim)!.actors["mission:test:b"]).toBeDefined();
  expect(sim.ext.agents!.list).toHaveLength(2);expect(agentsRuntimeOf(sim)!.missionStages).toEqual({});
 });
 it("cancels stale retries when a mission resets, disappears or changes objectives",()=>{
  const blocked=withoutEvent(step(world,initial(),{},[],[system]));
  for(const change of ["reset","missing","objective"]){
   const sim=structuredClone(blocked),progress=sim.ext.missions!.players.p!;
   if(change==="reset")progress.startedTick=20;
   if(change==="missing")delete sim.ext.missions!.players.p;
   if(change==="objective")progress.stepId="finished";
   expect(pendingMissionStages(sim,agentsRuntimeOf(sim)!.missionStages)).toEqual({});
  }
 });
 it("recovers a bound but absent actor from an unambiguous active authored stage",()=>{
  const mission=MISSIONS.find(m=>m.id==="hot-desk")!,stage=mission.steps.find(s=>s.type==="stage"&&s.actors.includes("squatter"))!;
  if(stage.type!=="stage")throw new Error("Missing authored stage");
  const at=missionPlace(stage.place),sim=createInitialState(world,1,["p"],{x:at.x+30,z:at.z,heading:0});
  sim.ext.missions={...createMissions(),players:{p:{...createMissionProgress(),missionId:mission.id,stepId:"cone",status:"active"}}};
  sim.ext.robots={...createAgentsRuntime(sim),missionBindings:{"hot-desk:squatter":"mission:hot-desk:squatter"}};
  const next=step(world,sim,{},[],[system]);
  const actor=agentsRuntimeOf(next)!.actors["mission:hot-desk:squatter"]!;
  expect(actor).toMatchObject({model:"robotaxi",firmware:"good",speed:0});
  expect(next.ext.agents!.list.some(body=>body.runtimeId===actor.id)).toBe(true);
  expect(Math.sqrt((actor.x-at.x)**2+(actor.z-at.z)**2)).toBeLessThanOrEqual(stage.place.radiusM);
  expect(dodgeExtOf(next).contacts).toBe(0);
 });
 it("ignores nonphysical abstract actors when testing new placement",()=>{
  const sim=createInitialState(world,1,["p"],{x:100,z:100,heading:0});
  sim.ext.robots=createAgentsRuntime(sim,{spawns:[{id:"old",numericId:100,model:"footman",firmware:"good",x:0,y:0,z:0,heading:0,radius:.4,height:1.8}]});
  sim.ext.robots.actors.old!.fidelity="abstract";
  const plan=planMissionActors(world,sim,{missionId:"new",stepId:"stage",actorIds:["a"],definitions:{a:{kind:"goodRobot"}},place:{x:0,y:0,z:0},radius:2.9},graph);
  expect(plan.actors).toHaveLength(1);expect(plan.actors[0]!.x).toBe(0);
 });
});
