import * as THREE from "three";
import {describe,it,expect} from "vitest";
import {createInitialState} from "../../src/sim/step.ts";
import {buildWorld} from "../../src/sim/world.ts";
import {createAgentsRuntime} from "../../src/sim/agents/runtime.ts";
import {createCombatState} from "../../src/sim/combat/system.ts";
import {initialTarget} from "../../src/sim/combat/shared.ts";
import {TACTICAL_LIMIT,CONFIDENCE_LIMIT,TacticalEffectsLayer,tacticalProjection} from "../../src/render/tactical-effects.ts";
function fixture(){
 const state=createInitialState(buildWorld([]),1,["p"],{x:0,z:0,heading:0});
 state.ext.combat=createCombatState(1,{actors:[],players:[{id:"p",x:0,y:0,z:0,heading:0,speed:0,tankTier:0,flowTier:0,scannerTier:1,mount:"vehicle"}],walls:[],refills:[]});
 const spawns=Array.from({length:40},(_,index)=>({id:`r:${index.toString().padStart(2,"0")}`,numericId:index+1,model:"footman" as const,firmware:index%2?"bad" as const:"good" as const,x:index,y:0,z:-15,heading:0,radius:.35,height:1.8}));
 state.ext.robots=createAgentsRuntime(state,{spawns});
 for(const spawn of spawns){state.ext.combat.targets[spawn.id]=initialTarget();state.ext.combat.players.p!.marks.push({targetId:spawn.id,untilTick:100,confidence:98,hallucination:spawn.firmware==="good"});}
 state.ext.combat.gadgets=Array.from({length:40},(_,index)=>({id:index+1,kind:"tensor" as const,ownerId:"p",x:index,y:0,z:5,untilTick:100,targetId:"",radius:3,progress:0,boost:"salt" as const}));
 return state;
}
describe("bounded tactical device presentation",()=>{
 it("projects only current devices and bounds nearest marks without turning AI estimates into hostile authority",()=>{
  const state=fixture(),before=JSON.stringify(state),projection=tacticalProjection(state,"p");
  expect(projection.devices).toHaveLength(TACTICAL_LIMIT);expect(projection.devices.map(row=>row.id)).toEqual(Array.from({length:TACTICAL_LIMIT},(_,index)=>index+1));
  expect(projection.marks).toHaveLength(CONFIDENCE_LIMIT);expect(projection.marks[0]).toMatchObject({id:"r:00",hallucination:true});expect(projection.marks[1]?.hallucination).toBe(false);
  expect(JSON.stringify(state)).toBe(before);
 });
 it("withdraws estimates on neutralization, protection, expiry and occupied taxis",()=>{
  const state=fixture(),actors=state.ext.robots!.actors;
  state.ext.combat!.targets['r:00']!.phase='heap';actors['r:01']!.protected=true;actors['r:02']!.retired=true;actors['r:03']!.model='robotaxi';
  state.players.p!.ride={agentId:actors['r:03']!.numericId,x:0,y:0,z:0,heading:0,speed:0,goal:null,exitPending:false};
  state.ext.combat!.players.p!.marks.find(mark=>mark.targetId==='r:04')!.untilTick=0;
  const ids=tacticalProjection(state,'p').marks.map(mark=>mark.id);for(const id of ['r:00','r:01','r:02','r:03','r:04'])expect(ids).not.toContain(id);
  state.tick=100;expect(tacticalProjection(state,'p')).toEqual({devices:[],marks:[]});
 });
 it("allocates no idle mesh, instances a bounded device batch, and clears it when state retires",()=>{
  const state=fixture(),scene=new THREE.Scene(),layer=new TacticalEffectsLayer(scene),camera=new THREE.PerspectiveCamera();
  layer.update(createInitialState(buildWorld([]),1,['p'],{x:0,z:0,heading:0}),'p',camera);expect(layer.root.children).toHaveLength(0);
  layer.update(state,'p',camera);expect(layer.info()).toMatchObject({devices:TACTICAL_LIMIT,drawCalls:1,textures:0});expect((layer.root.children[0] as THREE.InstancedMesh).count).toBe(TACTICAL_LIMIT);
  const geometry=(layer.root.children[0] as THREE.InstancedMesh).geometry;let disposed=0;geometry.addEventListener('dispose',()=>disposed++);
  state.tick=100;layer.update(state,'p',camera);expect(layer.info().drawCalls).toBe(0);layer.dispose();expect(disposed).toBe(1);layer.dispose();expect(disposed).toBe(1);
 });
 it("does not display modern effects in historical states",()=>{const state=fixture();state.version=20;expect(tacticalProjection(state,'p')).toEqual({devices:[],marks:[]});});
});
