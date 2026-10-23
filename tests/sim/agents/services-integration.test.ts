import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {makeFoot} from "../../../src/sim/foot.ts";
import {dodgeExtOf} from "../../../src/sim/dodge.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createHeat} from "../../../src/sim/heat/system.ts";
import {createAgentsSystem} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf} from "../../../src/sim/agents/runtime.ts";
import type {TransitLayer} from "../../../src/sim/agents/transit-runtime.ts";
const world=buildWorld([],{version:1,nodes:[{id:"a",x:-500,z:0},{id:"b",x:500,z:0}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-500,0],[500,0]]}]});
// Isolate the service acceptance from random ambient population; road geometry is unchanged.
world.roads={...world.roads!,areas:[]};
function initial(){const sim=createInitialState(world,7,["p"],{x:0,z:8,heading:0});sim.players.p!.mode="foot";sim.players.p!.foot=makeFoot(0,0,8,0);sim.players.p!.car.z=30;return sim;}
describe("physical service acceptance",()=>{
 it("drives a threat van through core physics and delivers two units within twenty seconds",()=>{
  let sim=initial();const heat=createHeat();heat.events=[{id:1,tick:0,kind:"threat.spawn",playerId:"p",targetId:"",amount:2,detail:"",payload:{id:"heat:p:1",requestTick:0,playerId:"p",player:{x:0,z:8},kind:"van",threat:2,unitCount:2}}];sim.ext.heat=heat as unknown as NonNullable<typeof sim.ext.heat>;
  const agents=createAgentsSystem(()=>({}),allocateActorIds);let delivered=-1;let initialX=0;let furthest=0;
  for(let tick=0;tick<1200;tick++){
   sim=step(world,sim,{},[],[agents]);const runtime=agentsRuntimeOf(sim)!,van=runtime.actors["service:heat:p:1"];
   if(tick===0)initialX=van!.x;
   if(van)furthest=Math.max(furthest,Math.abs(van.x-initialX));
   const event=runtime.services?.events.find(e=>e.kind==="service.delivered");if(event){delivered=event.tick;break;}
   expect(dodgeExtOf(sim).contacts).toBe(0);
  }
  expect(furthest).toBeGreaterThan(80);expect(delivered).toBeGreaterThan(0);expect(delivered).toBeLessThanOrEqual(1200);
  expect(Object.keys(agentsRuntimeOf(sim)!.actors).filter(id=>id.startsWith("mission:reinforce-heat:p:1:"))).toHaveLength(2);
 });
 it("physically stops a wrapped bus at the actual Ferry stop",()=>{
  const data:TransitLayer={version:1,routes:[{id:"FBUS-in",line:"FBUS",mode:"bus",direction:"inbound",night:false,paths:[[[-500,0],[500,0]]]}],stops:[{id:"s4513",x:0,y:0,z:0,routes:["FBUS-in"]},{id:"s-next",x:350,y:0,z:0,routes:["FBUS-in"]}]};
  let sim=initial();const agents=createAgentsSystem(()=>({transit:data}),allocateActorIds);let passed=false;
  for(let tick=0;tick<1800;tick++){sim=step(world,sim,{},[],[agents]);const runtime=agentsRuntimeOf(sim)!;if(runtime.transit?.events.some(e=>e.kind==="transit.ferry-pass")){passed=true;const bus=Object.keys(runtime.actors).map(id=>runtime.actors[id]!).find(a=>a.model==="bus")!;expect(Math.abs(bus.speed)).toBeLessThan(.3);expect(bus.adWrapSlot?.surface).toBe("left-right-rear");break;}expect(dodgeExtOf(sim).contacts).toBe(0);}
  expect(passed).toBe(true);
 });
});
