import {describe,it,expect} from "vitest";
import {buildWorld,createInitialState,step,prepareMotionBodies,applyMotionBodies,type AgentMotionProposal,type SimSystem} from "../../src/sim/index.ts";
const plain=buildWorld([]);
const fly=(change:Partial<AgentMotionProposal>={}):AgentMotionProposal=>({id:"drone:1",numericId:90,legacyId:null,kind:"flying",bodyKind:"robot",x:10,y:6,z:10,sourceX:10,sourceY:2,sourceZ:10,heading:0,speed:2,radius:.4,height:.6,...change});
const initial=()=>createInitialState(plain,17,["p"],{x:0,z:0,heading:0});
describe("accepted airborne bodies",()=>{
 it("bounds climb and supplies actual altitude to the observing system",()=>{
  let observed=0,state=initial();
  const system:SimSystem={key:"robots",prepare:ctx=>({state:ctx.state,motions:[fly()]}),step:ctx=>{const body=ctx.observedBodies![0]!;expect(body.y).toBeLessThanOrEqual(6);observed++;return ctx.state;}};
  for(let tick=0;tick<180;tick++){
   const oldY=state.ext.agents?.list[0]?.y??2;
   state=step(plain,state,{},[],[system]);
   expect(state.ext.agents!.list[0]!.y-oldY).toBeLessThanOrEqual(2/60+1e-9);
  }
  expect(state.ext.agents!.list[0]!.y).toBeCloseTo(6);expect(observed).toBe(180);
 });
 it("allows a player car to drive under a high drone without a planar obstacle",()=>{
  let state=initial();
  const system:SimSystem={key:"robots",prepare:ctx=>({state:ctx.state,motions:[fly({x:0,z:-4,sourceX:0,sourceZ:-4,sourceY:6})]}),step:ctx=>ctx.state};
  for(let tick=0;tick<160;tick++)state=step(plain,state,{p:{throttle:1,steer:0,brake:0,actions:0}},[],[system]);
  expect(state.players.p!.car.z).toBeLessThan(-10);expect(state.players.p!.car.hits).toBe(0);expect(state.players.p!.car.personBumps).toBe(0);
 });
 it("keeps a low drone out of occupied body bands and building roofs",()=>{
  const state=initial(),motion=fly({x:0,z:0,sourceX:0,sourceZ:0,sourceY:3,y:0});
  let current=prepareMotionBodies(plain,state,[motion]);
  for(let tick=0;tick<90;tick++)current=applyMotionBodies(plain,current,[motion]);
  expect(current.ext.agents!.list[0]!.y).toBeGreaterThanOrEqual(1.6);
  const blocked=buildWorld([{tileId:"block",ground:null,buildings:[{id:"b",baseY:0,topY:5,footprint:[[9,9],[11,9],[11,11],[9,11]]}]}]);
  expect(()=>prepareMotionBodies(blocked,state,[fly({sourceY:3})])).toThrow("spawn");
  expect(prepareMotionBodies(blocked,state,[fly({sourceY:6})]).ext.agents!.list[0]!.y).toBe(6);
 });
 it("rejects simultaneous closing flight paths while preserving vertical separation",()=>{
  const a=fly({sourceX:10,x:11,sourceY:6,y:6,speed:30});
  const b=fly({id:"drone:2",numericId:91,sourceX:11,x:10,sourceY:6,y:6,speed:30});
  const admitted=prepareMotionBodies(plain,initial(),[a,b]);
  const blocked=applyMotionBodies(plain,admitted,[a,b]);
  expect(blocked.ext.agents!.list.map(body=>body.x)).toEqual([10,11]);
  const high={...b,sourceY:8,y:8};
  const separate=applyMotionBodies(plain,prepareMotionBodies(plain,initial(),[a,high]),[a,high]);
  expect(separate.ext.agents!.list.map(body=>body.x)).toEqual([10.5,10.5]);
 });
});
