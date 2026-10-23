import {describe,it,expect} from "vitest";
import {buildWorld,createInitialState,prepareMotionBodies,applyMotionBodies,step,dodgeExtOf,type AgentMotionProposal,type SimSystem} from "../../src/sim/index.ts";
const world=buildWorld([]);
const proposal=(change:Partial<AgentMotionProposal>):AgentMotionProposal=>({id:"person",numericId:101,legacyId:null,kind:"walker",bodyKind:"person",x:1.28,y:0,z:0,sourceX:1.36,sourceY:0,sourceZ:0,heading:-Math.PI/2,speed:4.8,radius:.3,height:1.8,...change});
describe("runtime walker clearance against ambient vehicles",()=>{
 for(const approach of [{name:"side",sourceX:1.36,sourceZ:0,x:1.28,z:0},{name:"front",sourceX:0,sourceZ:2.86,x:0,z:2.78}])it(`prevents ${approach.name} movement into the drawn legacy taxi hull`,()=>{
  let state=createInitialState(world,1,["p"],{x:20,z:0,heading:0});
  const vehicle=prepareMotionBodies(world,state,[{...proposal({id:"taxi",numericId:100,kind:"vehicle",sourceX:0,x:0,sourceZ:0,z:0,heading:0,speed:0}),radius:1.05,height:1.6}]).ext.agents!.list[0]!;
  const {runtimeId:_id,runtimeLegacy:_legacy,...ambient}=vehicle;
  state={...state,ext:{agents:{nextId:102,list:[ambient]}}};
  const motion=proposal(approach);
  const system:SimSystem={key:"robots",prepare:context=>({state:context.state,motions:[motion]}),step:context=>context.state};
  const next=step(world,state,{},[],[system]);
  expect(dodgeExtOf(next).contacts).toBe(0);
 });
 it("respects long service hulls and parked player cars",()=>{
  let state=createInitialState(world,1,["p"],{x:20,z:0,heading:0});
  const bus={...proposal({id:"bus",numericId:100,kind:"vehicle",sourceX:0,x:0,sourceZ:0,z:0,heading:0,speed:0}),radius:1.4,height:3.2,halfLength:6.6,halfWidth:1.35};
  state=prepareMotionBodies(world,state,[bus]);
  const walk=proposal({sourceX:0,x:0,sourceZ:6.96,z:6.88});
  const next=step(world,state,{},[],[{key:"robots",prepare:context=>({state:context.state,motions:[walk]}),step:context=>context.state}]);
  expect(dodgeExtOf(next).contacts).toBe(0);
  const parked=proposal({sourceX:21.31,x:21.23,sourceZ:0,z:0});
  const ready=prepareMotionBodies(world,state,[parked]);
  expect(applyMotionBodies(world,ready,[parked]).ext.agents!.list.find(body=>body.id===101)!.x).toBe(21.31);
 });
 it("allows a previously overlapping walker to move away",()=>{
  const state=createInitialState(world,1,["p"],{x:20,z:0,heading:0});
  const walk=proposal({sourceX:22,x:22,sourceZ:0,z:0});
  const ready=prepareMotionBodies(world,state,[walk]);
  const trapped={...ready,ext:{...ready.ext,agents:{...ready.ext.agents!,list:ready.ext.agents!.list.map(body=>({...body,x:21}))}}};
  expect(applyMotionBodies(world,trapped,[{...walk,x:21.08}]).ext.agents!.list[0]!.x).toBeGreaterThan(21);
 });
});
