import { describe, expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { decodeMissionStage, planMissionActors, type MissionStage } from "../../../src/sim/agents/mission-actors.ts";
const world=buildWorld([]);
const state=createInitialState(world,1,["p"],{x:100,z:100,heading:0});
const stage:MissionStage={missionId:"first",stepId:"meet",actorIds:["bad","good"],definitions:{bad:{kind:"badRobot"},good:{kind:"goodRobot",archetype:"Trundle"}},place:{x:0,y:0,z:0},radius:20};
describe("mission actor placement",()=>{
  it("decodes authored stage events and rejects malformed positions and actor identities",()=>{
    const event={kind:"mission.stage",targetId:"first",detail:JSON.stringify({stepId:stage.stepId,actors:stage.actorIds,definitions:stage.definitions,place:stage.place,radius:20})};
    expect(decodeMissionStage(event)).toEqual(stage);
    expect(decodeMissionStage({...event,detail:"broken"})).toBeNull();
    expect(decodeMissionStage({...event,targetId:"__proto__"})).toBeNull();
    expect(decodeMissionStage({...event,detail:JSON.stringify({...JSON.parse(event.detail),radius:-1})})).toBeNull();
  });
  it("uses stable mission identities and collision-free independent placements",()=>{
    const result=planMissionActors(world,state,stage);
    expect(result.bindings).toEqual({bad:"mission:first:bad",good:"mission:first:good"});
    expect(result.actors).toHaveLength(2);
    expect(result.actors[0]).toMatchObject({id:"mission:first:bad",firmware:"bad"});
    expect(result.actors[1]).toMatchObject({model:"trundle",firmware:"good"});
    expect(Math.hypot(result.actors[0]!.x-result.actors[1]!.x,result.actors[0]!.z-result.actors[1]!.z)).toBeGreaterThan(1.3);
    expect(planMissionActors(world,state,{...stage,actorIds:[...stage.actorIds].reverse()})).toEqual(result);
  });
  it("expands crews once and reports cycles and unavailable road placement",()=>{
    const input={...stage,actorIds:["crew","car"],definitions:{...stage.definitions,crew:{kind:"crew" as const,members:["bad","good","bad"]},car:{kind:"rogueTaxi" as const}}};
    const result=planMissionActors(world,state,input);
    expect(result.actors).toHaveLength(2);
    expect(result.groups.crew).toEqual(["mission:first:bad","mission:first:good"]);
    expect(result.blocked).toEqual(["car"]);
    expect(planMissionActors(world,state,{...input,definitions:{...input.definitions,crew:{kind:"crew",members:["crew"]}}}).blocked).toContain("crew");
  });
});
