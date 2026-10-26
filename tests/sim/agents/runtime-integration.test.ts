import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState,step} from "../../../src/sim/step.ts";
import {dodgeExtOf} from "../../../src/sim/dodge.ts";
import {makeFoot} from "../../../src/sim/foot.ts";
import {allocateActorIds} from "../../../src/sim/identity.ts";
import {createAgentsSystem,agentsCombatOptions} from "../../../src/sim/agents/systems.ts";
import {agentsRuntimeOf,createAgentsRuntime,observeAgentRuntime,type RuntimeSpawn} from "../../../src/sim/agents/runtime.ts";
import {createCombatSystem} from "../../../src/sim/combat/systems.ts";
import {contextFromState} from "../../../src/sim/combat/adapter.ts";
const world=buildWorld([]);
function initial(){const state=createInitialState(world,7,["p"],{x:100,z:100,heading:0});state.players.p!.mode="foot";state.players.p!.foot=makeFoot(100,0,100,0);return state;}
function bot(id:string,numericId:number,firmware:RuntimeSpawn["firmware"],z:number):RuntimeSpawn{return {id,numericId,firmware,model:"footman",x:0,y:0,z,heading:0,radius:.4,height:1.8};}
function systems(spawns:RuntimeSpawn[]){return [createAgentsSystem(()=>({spawns,services:false}),allocateActorIds),createCombatSystem(ctx=>({context:contextFromState(ctx.world,ctx.state,agentsCombatOptions(ctx.state))}))];}
describe("registered agent and combat integration",()=>{
 it("adapts signed recoil velocity at the runtime boundary without changing the physical body",()=>{
  const after=step(world,initial(),{},[],systems([bot("good",10,"good",0)]));
  const physical=after.ext.agents!.list[0]!;
  const body={...physical,runtimeId:undefined,speed:-0.36805346072290823};
  const sim={...after,ext:{...after.ext,agents:{...after.ext.agents!,list:[body]},robots:undefined}};
  const before=JSON.stringify(sim);
  const runtime=createAgentsRuntime(sim);
  const actor=runtime.actors[`agent:${body.id}`]!;
  expect(actor.speed).toBe(Math.abs(body.speed));
  expect(JSON.stringify(sim)).toBe(before);
  const withRuntime={...sim,ext:{...sim.ext,robots:runtime}};
  const observed=observeAgentRuntime(withRuntime,{observedBodies:[{id:actor.id,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:-0.5}]});
  expect(observed.actors[actor.id]!.speed).toBe(0.5);
  expect(body.speed).toBe(-0.36805346072290823);
 });
 it("moves a physical extra once and feeds accepted poses back into combat",()=>{const list=systems([bot("good",10,"good",0)]);const after=step(world,initial(),{},[],list),runtime=agentsRuntimeOf(after)!;const body=after.ext.agents!.list.find(actor=>actor.runtimeId==="good")!;expect(body).toBeDefined();expect(runtime.actors.good!.x).toBe(body.x);expect(runtime.actors.good!.z).toBe(body.z);expect(Math.abs(body.z)).toBeCloseTo(1.6/60,5);expect(after.ext.combat!.targets.good).toBeDefined();expect(dodgeExtOf(after).contacts).toBe(0);});
 it("finishes one unopposed six-second update using the combat reducer and persists new firmware",()=>{let state=initial();const list=systems([bot("bad",10,"bad",0),bot("helper",11,"good",-2)]);let converted=0,convertedAt=-1;for(let tick=0;tick<365;tick++){state=step(world,state,{},[],list);for(const event of state.ext.combat?.events??[])if(event.kind==="robot.converted"){converted++;convertedAt=event.tick;}}expect(converted).toBe(1);expect(convertedAt).toBe(361);expect(agentsRuntimeOf(state)!.actors.helper!.firmware).toBe("bad");expect(dodgeExtOf(state).contacts).toBe(0);});
});
