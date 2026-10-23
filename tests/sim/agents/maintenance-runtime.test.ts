import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createCombatSystem} from "../../../src/sim/combat/systems.ts";
import {contextFromState} from "../../../src/sim/combat/adapter.ts";
import {createAgentsSystem,agentsCombatOptions} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf,createAgentsRuntime,planAgentRuntime,observeAgentRuntime,runtimeCombatActors,type RuntimeSpawn} from "../../../src/sim/agents/runtime.ts";
import {createActivities} from "../../../src/sim/activities/system.ts";
import {planMaintenanceRuntime} from "../../../src/sim/agents/maintenance-runtime.ts";
import {createCombatState} from "../../../src/sim/combat/system.ts";
const world=buildWorld([],null,null,{version:1,world:"test",sourceSnapshot:"test",refills:[],tiles:[],territories:[],anchors:[{id:"k",kind:"repair-kiosk",x:6,y:0,z:0,roadNodeId:"r",districtId:"d"}]});
const spawns:RuntimeSpawn[]=[{id:"tidy:k",numericId:10,model:"tidy",firmware:"good",x:0,y:0,z:0,heading:0,radius:.45,height:1.8},{id:"heap",numericId:11,model:"footman",firmware:"bad",x:1.5,y:0,z:0,heading:0,radius:.4,height:1.8,posted:true}];
function initial(){return createInitialState(world,7,["p"],{x:100,z:100,heading:0});}
describe("physical Tidy maintenance",()=>{
 it("retains converted cargo through collection and completes restore only after body readmission",()=>{
  const agents=createAgentsSystem(()=>({wave:3,spawns,services:false}),allocateActorIds);
  const combat=createCombatSystem(ctx=>({context:contextFromState(world,ctx.state,{...agentsCombatOptions(ctx.state),wave:3})}));
  let sim=step(world,initial(),{},[],[agents,combat]);
  Object.assign(sim.ext.combat!.targets.heap!,{phase:"heap",rust:1,converted:true,heightScale:.08,movementScale:0});
  let collected=false,restored=false,accepted=false,checkedHandoff=false;
  for(let i=0;i<4300;i++){
   sim=step(world,sim,{},[],[agents,combat]);
   const runtime=agentsRuntimeOf(sim)!;
   if(sim.ext.combat!.events.some(e=>e.kind==="robot.heap-cleared"))collected=true;
   if(sim.ext.combat!.events.some(e=>e.kind==="robot.restored"))restored=true;
   if(collected&&!restored&&runtime.actors.heap!.carriedBy){expect(sim.ext.combat!.targets.heap!.converted).toBe(true);expect(runtimeCombatActors(sim).some(a=>a.id==="heap")).toBe(true);}
   if(collected&&!restored&&runtime.actors.heap!.carriedBy&&!checkedHandoff){
    checkedHandoff=true;sim.players.p!.car.x=2000;sim.players.p!.car.z=2000;sim=step(world,sim,{},[],[agents,combat]);
    expect(sim.ext.combat!.targets.heap!.converted).toBe(true);expect(runtimeCombatActors(sim).find(a=>a.id==="heap")!.inFidelity).toBe(false);
    sim.players.p!.car.x=100;sim.players.p!.car.z=100;
   }
   if(runtime.events.some(e=>e.kind==="actor.restored")){accepted=true;break;}
  }
  expect(collected).toBe(true);expect(restored).toBe(true);expect(accepted).toBe(true);
  const body=sim.ext.agents!.list.find(a=>a.runtimeId==="heap")!,actor=agentsRuntimeOf(sim)!.actors.heap!;
  expect(body).toBeDefined();expect(actor).toMatchObject({firmware:"good",retired:false,restorePending:false,brain:null,x:body.x,z:body.z});
  expect(sim.ext.combat!.targets.heap!.phase).toBe("active");
 });
 it("does not emit accepted restoration until an observed body exists",()=>{
  let sim=initial();sim.ext.robots=createAgentsRuntime(sim,{spawns});sim.ext.combat=createCombatState(7,contextFromState(world,sim,agentsCombatOptions(sim)));
  sim.ext.combat.tick=1;sim.ext.combat.events=[{id:1,tick:1,kind:"robot.restored",sourceId:"tidy:k",targetId:"heap",amount:3600,detail:"job"}];
  sim.ext.robots=planAgentRuntime(world,sim,{},{spawns,restorationPoints:{heap:{x:4,y:0,z:1}}});
  const waiting=observeAgentRuntime(sim);expect(waiting.actors.heap!.restorePending).toBe(true);expect(waiting.actors.heap!.retired).toBe(true);expect(waiting.events.some(e=>e.kind==="actor.restored")).toBe(false);
  sim.ext.robots=waiting;const accepted=observeAgentRuntime(sim,{observedBodies:[{id:"heap",x:4,y:0,z:1,heading:0,speed:0}]});expect(accepted.actors.heap!.restorePending).toBe(false);expect(accepted.events.some(e=>e.kind==="actor.restored")).toBe(true);
 });
 it("retains recorded escort attribution and rejects a request from a different owner",()=>{
  const sim=initial();sim.ext.robots=createAgentsRuntime(sim,{spawns:spawns.map(actor=>({...actor,firmware:"good" as const}))});sim.ext.combat=createCombatState(7,contextFromState(world,sim,agentsCombatOptions(sim)));Object.assign(sim.ext.combat.targets.heap!,{repair:true,sourceId:"p"});
  sim.ext.activities=createActivities();const request={id:"repair:p:1",requestTick:0,playerId:"p",actorId:"heap",kioskId:"k",kiosk:{x:6,z:0}};
  sim.ext.activities.events=[{id:1,tick:0,kind:"activity.repair-request",playerId:"p",targetId:"heap",amount:0,detail:JSON.stringify(request)}];
  expect(planMaintenanceRuntime(world,sim).state.jobs["tidy:k"]).toMatchObject({requestId:"repair:p:1",sourcePlayerId:"p",kioskId:"k"});
  sim.ext.combat.targets.heap!.sourceId="somebody-else";expect(planMaintenanceRuntime(world,sim).state.jobs["tidy:k"]!.sourcePlayerId).toBeUndefined();
 });
 it("blocks robot vision across a real microclimate zone",()=>{
  let sim=initial();sim.players.p!.car.x=0;sim.players.p!.car.z=-8;sim.ext.robots=createAgentsRuntime(sim,{spawns:[{...spawns[1]!,posted:false,x:0,z:0}]});sim.ext.combat=createCombatState(7,contextFromState(world,sim,agentsCombatOptions(sim)));
  sim.ext.combat.gadgets=[{id:1,kind:"microclimate",ownerId:"p",x:0,y:0,z:-4,radius:2,untilTick:1200,targetId:"",progress:0,boost:"salt"}];
  const runtime=planAgentRuntime(world,sim,{},{});expect(runtime.actors.heap!.brain!.knowledge).toEqual([]);
 });
});
