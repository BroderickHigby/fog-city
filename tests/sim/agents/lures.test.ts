import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {createAgentsRuntime,planAgentRuntime,type RuntimeSpawn} from "../../../src/sim/agents/runtime.ts";
import {runtimeDeviceLure,lureStepAllowed} from "../../../src/sim/agents/lures.ts";
import {createCombatState} from "../../../src/sim/combat/system.ts";
import {contextFromState} from "../../../src/sim/combat/adapter.ts";
import {stepDevices} from "../../../src/sim/combat/devices.ts";
import {initialTarget} from "../../../src/sim/combat/shared.ts";
import type {CombatContext} from "../../../src/sim/combat/types.ts";
const world=buildWorld([]);
function fixture(patch:Partial<RuntimeSpawn>={}){const state=createInitialState(world,7,["p"],{x:100,z:100,heading:0}),spawn={id:"bad",numericId:10,model:"footman" as const,firmware:"bad" as const,x:30,y:0,z:0,heading:0,radius:.4,height:1.8,...patch};state.ext.robots=createAgentsRuntime(state,{spawns:[spawn]});state.ext.combat=createCombatState(7,contextFromState(world,state));state.ext.combat.gadgets=[{id:1,kind:"parrots",ownerId:"p",x:0,y:0,z:0,untilTick:1200,targetId:"",radius:40,progress:0,boost:"salt"}];return {state,actor:state.ext.robots.actors.bad!};}
describe("SIM21 live gadget lure movement",()=>{
 it("plans a bounded ordinary step toward a15m stand-off without changing accepted source pose",()=>{
  const {state,actor}=fixture(),before=JSON.stringify(state),planned=planAgentRuntime(world,{...state,tick:1},{}),proposal=planned.proposals.find(p=>p.id==="bad")!;
  expect(proposal.x).toBeLessThan(actor.x);expect(actor.x-proposal.x).toBeLessThanOrEqual(1.6/60+1e-8);expect(proposal.x).toBeGreaterThan(15+actor.radius);expect(JSON.stringify(state)).toBe(before);
 });
 it("rejects a detour shortcut through the flock and permits only outward recovery from an already-near pose",()=>{
  const {state,actor}=fixture(),lure=runtimeDeviceLure(state,actor)!;expect(lureStepAllowed(lure,{x:30,z:0},{x:0,z:0})).toBe(false);expect(lureStepAllowed(lure,{x:5,z:0},{x:6,z:0})).toBe(true);expect(lureStepAllowed(lure,{x:5,z:0},{x:4,z:0})).toBe(false);
 });
 it("uses live ownership/expiry and stays deterministic through JSON; historical20 and protected bodies remain unaffected",()=>{
  const {state,actor}=fixture();expect(runtimeDeviceLure(JSON.parse(JSON.stringify(state)),JSON.parse(JSON.stringify(actor)))).toEqual(runtimeDeviceLure(state,actor));expect(runtimeDeviceLure({...state,version:20},actor)).toBeNull();
  expect(runtimeDeviceLure(state,{...actor,protected:true})).toBeNull();expect(runtimeDeviceLure(state,{...actor,child:true})).toBeNull();expect(runtimeDeviceLure(state,{...actor,model:"dog",firmware:"none"})).toBeNull();
  expect(runtimeDeviceLure(state,{...actor,y:20})).not.toBeNull();expect(runtimeDeviceLure(state,{...actor,y:50})).toBeNull();
  expect(runtimeDeviceLure({...state,tick:1200},actor)).toBeNull();expect(runtimeDeviceLure({...state,players:{}},actor)).toBeNull();
  expect(runtimeDeviceLure(state,{...actor,model:"associate",firmware:"none",protected:true})).not.toBeNull();
 });
 it("keeps accepted robot-to-good-robot sabotage/channel intent ahead of lure movement and distraction",()=>{
  const {state,actor}=fixture();actor.brain={...actor.brain!,update:{targetId:11,startedTick:0}};state.ext.combat!.attacks=[{id:"accepted",kind:"forced-update",attackerId:"bad",targetId:"good",startTick:0,resolveTick:360,endTick:360,presses:0,active:false}];expect(runtimeDeviceLure(state,actor)).toBeNull();
  const combat=state.ext.combat!;combat.tick=1;combat.targets.bad=initialTarget();combat.targets.good=initialTarget();combat.attacks=[{id:"channel",kind:"forced-update",attackerId:"bad",targetId:"good",startTick:0,resolveTick:360,endTick:360,presses:0,active:false}];combat.gadgets=[];
  const ctx:CombatContext={simVersion:21,wave:4,players:[{id:"p",x:0,y:0,z:0,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1}],actors:[{id:"bad",kind:"robot",firmware:"bad",model:"footman",x:30,y:0,z:0,heading:0,speed:0,radius:.4,height:1.8},{id:"good",kind:"robot",firmware:"good",x:31,y:0,z:0,heading:0,speed:0,radius:.4,height:1.8}],walls:[],refills:[],streaks:[{kind:"parrots",playerId:"p",sequence:1}]};
  stepDevices(combat,ctx,{p:{streak:"parrots",targetX:0,targetZ:0}});expect(combat.targets.bad!.distractedUntil).toBe(0);expect(combat.attacks[0]!.id).toBe("channel");expect(combat.gadgets[0]!.kind).toBe("parrots");
 });
});
