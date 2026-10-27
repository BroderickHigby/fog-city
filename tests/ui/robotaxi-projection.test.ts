import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { HINT_TAXI_EXIT } from "../../src/render/hud.ts";
import { uiProjection } from "../../src/ui/projection.ts";
import { isCivilianTraffic } from "../../src/sim/civilian-traffic.ts";
import { gridCity } from "../sim/fixtures.ts";

describe("occupied robotaxi UI", () => {
  it("describes the taxi exit as braking without offering an unsupported cancel action",()=>{
    expect(HINT_TAXI_EXIT).toBe("Braking to let you out");
  });
  it("places the minimap and speed at the occupied taxi while the player's own car stays parked", () => {
    const state = createInitialState(buildWorld([]), 9, ["p"], { x: -500, z: 700, heading: 0 });
    const player = state.players.p!;
    player.ride = { agentId: 8, x: 20, y: 3, z: 40, heading: 1, speed: 12, goal: null, exitPending: false };
    expect(uiProjection(state, "p", null)).toMatchObject({ x: 20, z: 40, heading: 1, speedMps: 12, vehicleControl: "robotaxi-passenger" });
    player.ride = { ...player.ride, manual: true };
    expect(uiProjection(state, "p", null)).toMatchObject({ x: 20, z: 40, speedMps: 12, vehicleControl: "robotaxi-driver" });
    expect(player.car).toMatchObject({ x: -500, z: 700 });
    player.ride = null;
    expect(uiProjection(state, "p", null)).toMatchObject({ x: -500, z: 700 });
    expect(uiProjection(state, "p", null).vehicleControl).toBeUndefined();
  });
  it("labels a stolen civilian car as the player's own drive, not a robotaxi", () => {
    const state = createInitialState(gridCity(), 5, ["p"], { x: 150, z: 0, heading: Math.PI / 2 });
    const template = state.ext.agents!.list.find((a) => a.kind === "robotaxi" && a.runtimeId === undefined && a.vehicle === undefined)!;
    const civilian = { ...template, id: 7 }, taxi = { ...template, id: 8 };
    state.ext.agents = { ...state.ext.agents!, list: [civilian, taxi] };
    expect(isCivilianTraffic(civilian)).toBe(true);
    state.players.p!.mode = "vehicle";
    state.players.p!.ride = { agentId: 7, manual: true, x: 20, y: 3, z: 40, heading: 1, speed: 12, goal: null, exitPending: false };
    const stolen = uiProjection(state, "p", null);
    expect(stolen).toMatchObject({ x: 20, z: 40, speedMps: 12, travelMode: "vehicle" });
    expect(stolen.vehicleControl).toBeUndefined();
    state.players.p!.ride = { ...state.players.p!.ride, agentId: 8 };
    expect(uiProjection(state, "p", null).vehicleControl).toBe("robotaxi-driver");
  });
});
