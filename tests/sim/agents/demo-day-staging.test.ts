import {describe,expect,it} from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import {createInitialState,createGameSystems,step,makeFoot,datan2,dodgeExtOf} from "../../../src/sim/index.ts";
import {planMissionActors} from "../../../src/sim/agents/mission-actors.ts";
import {planAgentRuntime,agentsRuntimeOf} from "../../../src/sim/agents/runtime.ts";
import {segmentBlocked} from "../../../src/sim/world.ts";
import {buildSidewalkGraph} from "../../../src/sim/agents/navigation.ts";
import {missionPlace} from "../../../src/sim/missions/system.ts";
import {loadWorld,worldExists} from "../../helpers.ts";

describe.skipIf(!worldExists("sf"))("Demo Day authored update scene",()=>{
 it("retries a partially admitted stage using only its own waiting guest",()=>{
  const {world}=loadWorld("sf",{roads:true});
  const mission=MISSIONS.find(m=>m.id==="demo-day")!;
  const authored=mission.steps.find(s=>s.type==="stage")!;
  if(authored.type!=="stage")throw new Error("missing stage");
  const place=missionPlace(authored.place);
  let state=createInitialState(world,1,["p1"],{x:place.x+80,z:place.z+80,heading:0});
  const stage={missionId:mission.id,attemptId:"retry-1",stepId:authored.id,actorIds:authored.actors,definitions:mission.actors!,place:{...place,y:0},radius:authored.place.radiusM??25};
  const clean=planMissionActors(world,state,stage,world.sidewalks);
  const initialGuest=clean.actors.find(a=>a.id.endsWith(":guest"))!;
  const partial=planMissionActors(world,state,stage,world.sidewalks,()=>true,
   Array.from({length:16},(_,index)=>{
    const angle=index*2*Math.PI/16;
    return {x:initialGuest.x+Math.sin(angle)*2.7,z:initialGuest.z+Math.cos(angle)*2.7,radius:.4};
   }));
  expect(partial.blocked).toContain("pusher");
  const guest=partial.actors.find(a=>a.id.endsWith(":guest"))!;
  expect(guest).toBeDefined();
  const runtime=planAgentRuntime(world,state,{}, {graph:buildSidewalkGraph({nodes:[],edges:[]}),spawns:[{...guest,numericId:1000}]});
  state={...state,ext:{...state.ext,robots:runtime}};
  const retry=planMissionActors(world,state,stage,world.sidewalks);
  expect(retry.blocked).toEqual([]);
  expect(planMissionActors(world,state,stage,world.sidewalks)).toEqual(retry);
  expect(planMissionActors(world,state,stage,world.sidewalks,()=>false).blocked).toContain("pusher");
  expect(retry.actors.filter(a=>a.id===guest.id)).toHaveLength(0);
  const pusher=retry.actors.find(a=>a.id.endsWith(":pusher"))!;
  expect(Math.hypot(pusher.x-guest.x,pusher.z-guest.z)).toBeCloseTo(2.7,5);
  expect(segmentBlocked(world,pusher.x,pusher.z,guest.x,guest.z)).toBe(false);
  expect(pusher.heading).toBeCloseTo(datan2(guest.x-pusher.x,-(guest.z-pusher.z)),5);
  const unrelated={...runtime.actors[guest.id]!,id:"unrelated-good"};
  state={...state,ext:{...state.ext,robots:{...runtime,actors:{[unrelated.id]:unrelated}}}};
  const noGuest=planMissionActors(world,state,{...stage,actorIds:["pusher"]},world.sidewalks);
  expect(noGuest.blocked).toContain("pusher");
 },60_000);
 it("keeps its waiting guest and pusher in the staged scene until the real update channel begins",()=>{
  const {world}=loadWorld("sf",{roads:true});
  const mission=MISSIONS.find(m=>m.id==="demo-day")!;
  const authored=mission.steps.find(s=>s.type==="stage")!;
  if(authored.type!=="stage")throw new Error("missing stage");
  const place=missionPlace(authored.place);
  let state=createInitialState(world,1,["p1"],{x:place.x+80,z:place.z+80,heading:0});
  const plan=planMissionActors(world,state,{missionId:mission.id,stepId:authored.id,actorIds:authored.actors,definitions:mission.actors!,place:{...place,y:0},radius:authored.place.radiusM??25},world.sidewalks);
  expect(plan.blocked).toEqual([]);
  const pusher=plan.actors.find(a=>a.id.endsWith(":pusher"))!,guest=plan.actors.find(a=>a.id.endsWith(":guest"))!;
  expect(Math.hypot(pusher.x-guest.x,pusher.z-guest.z)).toBeGreaterThan(2.4);
  expect(Math.hypot(pusher.x-guest.x,pusher.z-guest.z)).toBeLessThan(3);
  state={...state,players:{p1:{...state.players.p1!,mode:"foot",foot:makeFoot(pusher.x+14,pusher.y,pusher.z,Math.PI/2)}}};
  const spawns=plan.actors.map((actor,index)=>({...actor,numericId:1000+index}));
  const systems=createGameSystems({wave:4,agents:()=>({spawns,services:false})});
  let started=false;
  for(let i=0;i<600&&!started;i++){
   const foot=state.players.p1!.foot!;
   const angle=datan2(foot.x-pusher.x,-(foot.z-pusher.z));
   // Facing away is the actual opportunity for disguised bad firmware to sabotage.
   const delta=Math.atan2(Math.sin(angle-foot.heading),Math.cos(angle-foot.heading));
   state=step(world,state,{p1:{throttle:0,steer:Math.max(-1,Math.min(1,delta/(3/60))),brake:0,actions:0}},[],systems);
   started=(state.ext.combat?.attacks??[]).some(a=>a.kind==="forced-update"&&a.attackerId===pusher.id&&a.targetId===guest.id);
  }
  expect(started).toBe(true);
  const runtime=agentsRuntimeOf(state)!;
  expect(runtime.actors[pusher.id]!.x).toBe(pusher.x);
  expect(runtime.actors[guest.id]!.x).toBe(guest.x);
  expect(dodgeExtOf(state)).toMatchObject({contacts:0,failures:0});
 },60_000);
});
