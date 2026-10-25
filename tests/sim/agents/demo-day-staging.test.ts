import {describe,expect,it} from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import {createInitialState,createGameSystems,step,makeFoot,datan2,dodgeExtOf} from "../../../src/sim/index.ts";
import {planMissionActors} from "../../../src/sim/agents/mission-actors.ts";
import {agentsRuntimeOf} from "../../../src/sim/agents/runtime.ts";
import {missionPlace} from "../../../src/sim/missions/system.ts";
import {loadWorld,worldExists} from "../../helpers.ts";

describe.skipIf(!worldExists("sf"))("Demo Day authored update scene",()=>{
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
