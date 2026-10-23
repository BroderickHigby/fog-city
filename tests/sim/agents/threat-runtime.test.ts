import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {makeFoot} from "../../../src/sim/foot.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createHeat} from "../../../src/sim/heat/system.ts";
import {createCombatState} from "../../../src/sim/combat/system.ts";
import {createCombatSystem} from "../../../src/sim/combat/systems.ts";
import {contextFromState} from "../../../src/sim/combat/adapter.ts";
import {createAgentsSystem,agentsCombatOptions} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf,createAgentsRuntime,planAgentRuntime,runtimeCombatActors} from "../../../src/sim/agents/runtime.ts";
import {planThreatRuntime} from "../../../src/sim/agents/threat-runtime.ts";
import {prepareMotionBodies} from "../../../src/sim/motion.ts";
import {agentsOf} from "../../../src/sim/agents.ts";
import {dodgeExtOf} from "../../../src/sim/dodge.ts";
import type {ThreatSpawnRequest} from "../../../src/sim/gameplay-contract.ts";
const empty=buildWorld([]);
function initial(world=empty){const sim=createInitialState(world,5,["p"],{x:0,z:0,heading:0});sim.players.p!.mode="foot";sim.players.p!.foot=makeFoot(0,0,0,0);sim.players.p!.car.z=100;return sim;}
function request(sim:ReturnType<typeof initial>,kind:"swarm"|"patrol"|"drone"|"taxi",count=3){sim.ext.heat=createHeat();sim.ext.heat.events=[{id:1,tick:0,kind:"threat.spawn",playerId:"p",targetId:"",amount:count,detail:"",payload:{id:`heat:p:${kind}`,requestTick:0,playerId:"p",player:{x:sim.players.p!.foot!.x,z:sim.players.p!.foot!.z},kind,threat:4,unitCount:count} satisfies ThreatSpawnRequest}];}
describe("special threat dispatch",()=>{
 it("admits a requested swarm once and attacks through shared combat with monotonic sequences",()=>{
  let sim=initial();request(sim,"swarm");const agents=createAgentsSystem(()=>({wave:3,services:false,maintenance:false}),allocateActorIds),combat=createCombatSystem(ctx=>({context:contextFromState(empty,ctx.state,{...agentsCombatOptions(ctx.state),wave:3})}));
  const sequences=new Map<string,number>();let attacked=false;
  for(let tick=0;tick<850;tick++){
   sim=step(empty,sim,{},[],[agents,combat]);
   for(const attack of agentsRuntimeOf(sim)!.attacks){expect(attack.sequence).toBeGreaterThan(sequences.get(attack.attackerId)??0);sequences.set(attack.attackerId,attack.sequence);}
   if(sim.ext.combat!.events.some(e=>e.kind==="attack.resolved"&&e.detail==="shove"))attacked=true;
   expect(dodgeExtOf(sim).contacts).toBe(0);
  }
  expect(Object.keys(agentsRuntimeOf(sim)!.threats!.units)).toHaveLength(3);expect(sim.ext.agents!.list.filter(a=>a.runtimeId?.startsWith("mission:response-")).length).toBe(3);expect(sequences.size).toBeGreaterThan(0);expect(attacked).toBe(true);
 });
 it("requires flight support before dispatching a drone and does not consume its request early",()=>{
  const sim=initial();request(sim,"drone",1);const waiting=planThreatRuntime(empty,sim,undefined,{});expect(waiting.spawns).toEqual([]);expect(waiting.state.receipts).toEqual([]);
  const ready=planThreatRuntime(empty,sim,waiting.state,{allowFlying:true});expect(ready.spawns).toHaveLength(1);expect(ready.spawns[0]).toMatchObject({model:"drone",y:6});
 });
 it("admits a real hovering drone and resolves its ad attack through combat",()=>{
  let sim=initial();request(sim,"drone",1);const agents=createAgentsSystem(()=>({wave:3,allowFlying:true,services:false,maintenance:false}),allocateActorIds),combat=createCombatSystem(ctx=>({context:contextFromState(empty,ctx.state,{...agentsCombatOptions(ctx.state),wave:3})}));let popup=false;
  for(let i=0;i<650;i++){sim=step(empty,sim,{},[],[agents,combat]);const actor=Object.keys(agentsRuntimeOf(sim)!.actors).map(id=>agentsRuntimeOf(sim)!.actors[id]!).find(a=>a.model==="drone")!;expect(actor.y).toBeCloseTo(6);expect(sim.ext.agents!.list.find(a=>a.runtimeId===actor.id)!.flying).toBe(true);if(sim.ext.combat!.events.some(e=>e.kind==="player.ad-popup"&&e.amount>0))popup=true;expect(dodgeExtOf(sim).contacts).toBe(0);}
  expect(popup).toBe(true);
 });
 it("places ground reinforcements on the player's side of a shoreline wall",()=>{
  const world=buildWorld([],null,{version:1,edges:[],shore:[{closed:false,points:[[-200,0],[200,0]]}]});const sim=initial(world);sim.players.p!.foot!.z=-10;request(sim,"swarm",3);
  const plan=planThreatRuntime(world,sim,undefined,{});expect(plan.spawns).toHaveLength(3);expect(plan.spawns.every(actor=>actor.z<-.4)).toBe(true);
 });
 it("does not refresh last-known coordinates from an unseen player's actual position",()=>{
  const sim=initial();request(sim,"patrol",1);const planned=planThreatRuntime(empty,sim,undefined,{});sim.ext.robots=createAgentsRuntime(sim,{spawns:planned.spawns.map((a,i)=>({...a,numericId:i+1}))});sim.tick=10;sim.players.p!.foot!.x=1000;
  const next=planThreatRuntime(empty,sim,planned.state,{});const unit=next.state.units[Object.keys(next.state.units)[0]!]!;expect(unit.lastKnown).toEqual({x:0,z:0});expect(unit.lastSeenTick).toBe(0);
 });
 it("lets a rusted dispatched robot flee instead of forcing pursuit",()=>{
  const sim=initial();request(sim,"patrol",1);const planned=planThreatRuntime(empty,sim,undefined,{}),spawn={...planned.spawns[0]!,numericId:1};sim.ext.robots=createAgentsRuntime(sim,{spawns:[spawn]});
  sim.ext.combat=createCombatState(5,contextFromState(empty,sim,agentsCombatOptions(sim)));sim.ext.combat.targets[spawn.id]!.rust=.8;sim.tick=1;
  const runtime=planAgentRuntime(empty,sim,{},{movementGoals:{[spawn.id]:{x:0,z:0,speed:1.8,stopDistance:1.1}}});expect(runtime.actors[spawn.id]!.intent!.movement.kind).toBe("flee");
  const move=runtime.proposals.find(p=>p.id===spawn.id)!;expect(Math.sqrt(move.x*move.x+move.z*move.z)).toBeGreaterThan(Math.sqrt(spawn.x*spawn.x+spawn.z*spawn.z));
 });
 it("keeps legacy taxi identity when braking a disabled traffic actor",()=>{
  let sim=initial();const physical=prepareMotionBodies(empty,sim,[{id:"temporary",numericId:100,legacyId:null,kind:"vehicle",bodyKind:"robot",x:20,y:0,z:20,sourceX:20,sourceY:0,sourceZ:20,heading:0,speed:0,radius:1.1,height:1.5}]);
  const {runtimeId:_,runtimeLegacy:__,...legacy}=physical.ext.agents!.list[0]!;sim.ext.agents={nextId:101,list:[legacy]};sim.ext.combat=createCombatState(5,contextFromState(empty,sim));sim.ext.combat.targets["agent:100"]!.phase="disabled";
  sim=step(empty,sim,{},[],[createAgentsSystem(()=>({wave:3,services:false,maintenance:false}),allocateActorIds)]);expect(agentsOf(sim)[0]!.id).toBe(100);expect(sim.ext.agents!.list[0]!.runtimeLegacy).toBe(true);
 });
 it("drives a rogue taxi with ordinary physics without contacting the player",()=>{
  const world=buildWorld([],{version:1,nodes:[{id:"a",x:-300,z:0},{id:"b",x:300,z:0}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-300,0],[300,0]]}]});world.roads={...world.roads!,areas:[]};
  let sim=initial(world);sim.players.p!.foot!.z=8;request(sim,"taxi",1);const acceptedTransfers:string[]=[];const agents=createAgentsSystem(()=>({wave:3,services:false,maintenance:false,retiredActorIds:acceptedTransfers}),allocateActorIds);let start=0,moved=0;
  for(let tick=0;tick<900;tick++){sim=step(world,sim,{},[],[agents]);const taxi=Object.keys(agentsRuntimeOf(sim)!.actors).map(id=>agentsRuntimeOf(sim)!.actors[id]!).find(a=>a.model==="robotaxi")!;if(tick===0)start=taxi.x;moved=Math.max(moved,Math.abs(taxi.x-start));expect(dodgeExtOf(sim).contacts).toBe(0);}
  expect(moved).toBeGreaterThan(20);expect(Object.keys(agentsRuntimeOf(sim)!.threats!.units)).toHaveLength(1);
  const id=Object.keys(agentsRuntimeOf(sim)!.threats!.units)[0]!;sim.ext.combat=createCombatState(5,contextFromState(world,sim,agentsCombatOptions(sim)),sim.tick);sim.ext.combat.targets[id]!.phase="disabled";
  for(let i=0;i<120;i++)sim=step(world,sim,{},[],[agents]);const stopped=agentsRuntimeOf(sim)!.actors[id]!;expect(Math.abs(stopped.speed)).toBeLessThan(.3);
  const at={x:stopped.x,z:stopped.z};for(let i=0;i<30;i++)sim=step(world,sim,{},[],[agents]);expect(agentsRuntimeOf(sim)!.actors[id]).toMatchObject(at);
  acceptedTransfers.push(id);sim=step(world,sim,{},[],[agents]);expect(agentsRuntimeOf(sim)!.actors[id]!.retired).toBe(true);expect(runtimeCombatActors(sim).some(a=>a.id===id)).toBe(false);expect(sim.ext.agents!.list.some(a=>a.runtimeId===id)).toBe(false);
 });
});
