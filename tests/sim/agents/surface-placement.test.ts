import { describe, expect, it } from "vitest";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { groundHeight, roadSurfaceHeight, type World } from "../../../src/sim/world.ts";
import { createAgentsRuntime, planAgentRuntime } from "../../../src/sim/agents/runtime.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { planMissionActors } from "../../../src/sim/agents/mission-actors.ts";
import { planSceneActors } from "../../../src/sim/agents/scene-actors.ts";
import { serviceBlockersOf, serviceEntryClear, serviceRoadPoint } from "../../../src/sim/agents/service-runtime.ts";
import { surfaceWorld } from "../fixtures.ts";

const emptyGraph = buildSidewalkGraph({ nodes: [], edges: [] });
function initial(world: World, x: number, y: number, z: number) {
  const state = createInitialState(world, 7, ["p"], { x: x + 20, z, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(x + 20, y, z, 0);
  state.players.p!.car.x = x + 40;
  state.ext.agents = { nextId: 100, list: [] };
  return state;
}

describe("runtime actors use the shared structural surfaces", () => {
  it("walks along a raised deck instead of proposing the terrain underneath", () => {
    const world = surfaceWorld();
    const state = initial(world, 30, 6, 130);
    const runtime = planAgentRuntime(world, state, {}, { graph: emptyGraph, spawns: [{ id: "deck-walker", numericId: 100, model: "footman", firmware: "good", x: 30, y: 6, z: 130, heading: 0, radius: .4, height: 1.8 }] });
    expect(groundHeight(world, 30, 130)).toBe(0);
    expect(runtime.proposals[0]!.y).toBe(6);
    expect(runtime.proposals[0]!.speed).toBeGreaterThan(0);
    expect(runtime.proposals[0]!.z).toBeLessThan(130);
  });

  it("walks through a tunnel under a building instead of climbing the hill or stopping", () => {
    const world = surfaceWorld();
    const state = initial(world, 0, 0, -100);
    const runtime = planAgentRuntime(world, state, {}, { graph: emptyGraph, spawns: [{ id: "bore-walker", numericId: 100, model: "footman", firmware: "good", x: 0, y: 0, z: -100, heading: 0, radius: .4, height: 1.8 }] });
    expect(groundHeight(world, 0, -100)).toBe(20);
    expect(runtime.proposals[0]!.y).toBe(0);
    expect(runtime.proposals[0]!.speed).toBeGreaterThan(0);
    expect(runtime.proposals[0]!.z).toBeLessThan(-100);
  });

  it("carries the selected road's deck height through service placement", () => {
    const world = surfaceWorld(true);
    const spot = serviceRoadPoint(world, { x: 30, z: 140 }, 0, 5, 0, []);
    expect(spot).not.toBeNull();
    expect(spot!.edgeId).toBe("deck-st");
    expect(spot!.y).toBe(6);
    expect(spot!.y).toBe(roadSurfaceHeight(world, spot!.edgeId!, spot!.x, spot!.z));
    expect(serviceEntryClear(world, spot!, [{ x: spot!.x, y: 0, z: spot!.z, radius: .4, height: 1.8 }])).toBe(true);
    expect(serviceEntryClear(world, spot!, [{ x: spot!.x, y: 6, z: spot!.z, radius: .4, height: 1.8 }])).toBe(false);
  });

  it("keeps authored stage actors on a deck and inside a bore", () => {
    const world = surfaceWorld();
    for (const place of [{ x: 30, y: 6, z: 130 }, { x: 0, y: 0, z: -100 }]) {
      const state = initial(world, place.x, place.y, place.z);
      const plan = planMissionActors(world, state, { missionId: "height-test", stepId: "stage", actorIds: ["worker"], definitions: { worker: { kind: "goodRobot" } }, place, radius: 10 });
      expect(plan.actors).toHaveLength(1);
      expect(plan.actors[0]!.y).toBe(place.y);
    }
  });

  it("keeps scene recipients at the authored structural height", () => {
    const world = surfaceWorld();
    const state = initial(world, 30, 6, 130);
    const plan = planSceneActors(world, state, { missionId: "delivery", anchor: { x: 30, y: 6, z: 130 }, actors: [{ id: "mission:delivery:recipient", role: "recipient", model: "person", firmware: "none", offset: { x: 0, z: 0 }, radius: .35, height: 1.8 }] });
    expect(plan.actors).toHaveLength(1);
    expect(plan.actors[0]!.y).toBe(6);
  });

  it("does not treat an unadmitted runtime record as a physical spawn blocker", () => {
    const world = surfaceWorld();
    const state = initial(world, 30, 6, 130);
    state.ext.robots = createAgentsRuntime(state, { spawns: [{ id: "pending", numericId: 100, model: "person", firmware: "none", x: 30, y: 6, z: 130, heading: 0, radius: .4, height: 1.8 }] });
    state.ext.robots.actors.pending!.fidelity = "abstract";
    state.ext.robots.actors.pending!.behavior = "pending-admission";
    expect(serviceBlockersOf(state)).toHaveLength(2); // the player's car and foot body
    const plan = planSceneActors(world, state, { missionId: "delivery", anchor: { x: 30, y: 6, z: 130 }, actors: [{ id: "mission:delivery:recipient", role: "recipient", model: "person", firmware: "none", offset: { x: 0, z: 0 }, radius: .35, height: 1.8 }] });
    expect(plan.actors[0]).toMatchObject({ x: 30, y: 6, z: 130 });
  });
});
