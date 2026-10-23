import { describe, expect, it } from "vitest";
import { Action, createInitialState, step } from "../../../src/sim/index.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { createMissions, createMissionProgress } from "../../../src/sim/missions/system.ts";
import { buildMissionParkingWorld, missionParkingDestination } from "../../../src/sim/missions/parking-world.ts";
import { makeCar } from "../../../src/sim/car.ts";
import { uiProjection } from "../../../src/ui/projection.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { buildLoadedWorld } from "../../../src/io/world-load.ts";
import { loadWorldFiles } from "../../helpers.ts";

describe("production mission parking wiring", () => {
  it("uses loaded SF rules and normal controls to finish parking without an injected provider", () => {
    const files = loadWorldFiles("sf"), world = buildLoadedWorld(files);
    let state = createInitialState(buildWorld([]), 812, ["p"], { x: 0, z: 0, heading: 0 });
    state.ext.missions = { ...createMissions(), players: { p: { ...createMissionProgress(), missionId: "demoed-correctly", stepId: "park", status: "active", startedTick: 1, stepStartedTick: 1, deadlineTick: 100000, visits: 4 } } };
    const target = missionParkingDestination(world, state, "p");
    expect(target).toBeDefined();
    const parking = buildMissionParkingWorld({ world, state, previous: state, inputs: {}, events: [] }, world.parking!.rules, world.streetCleaning!.rules);
    const bay = parking.bays.find(value => value.x === target!.x && value.z === target!.z)!;
    state.players.p = { ...state.players.p!, car: makeCar(bay.x, bay.z, bay.heading, bay.y) };
    const view = uiProjection(state, "p", null, undefined, 3, target);
    expect(view.map?.waypoint).toEqual(target);
    const custom = { x: target!.x + 20, z: target!.z + 20 };
    expect(uiProjection(state, "p", null, custom, 3, target).map?.waypoint).toEqual(custom);
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    for (let i = 0; i < 122; i++) state = step(world, state, { p: { throttle: 0, steer: 0, brake: 1, actions: i === 121 ? Action.interact : 0 } }, [], systems);
    expect(state.ext.missions!.parking!.players.p!.completed).toBe(true);
    expect(state.ext.missions!.players.p!.stepId).toBe("pitch-philosopher");
  }, 60000);
});

