import { describe, expect, it } from "vitest";
import { buildWorld, createFollowerState, makeCar, stepCar, stepVehicleFollower, type FollowerGoal } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";

describe("closed-loop vehicle follower", () => {
  it("drives to a stationary target using normal physics and measured progress", () => {
    const world = buildWorld([]);
    let body = makeCar(0, 0, 0), state = createFollowerState(body);
    const goal: FollowerGoal = { kind: "pursue", target: { x: 10, z: -80 }, maxSpeed: 8, stopDistance: 3 };
    for (let tick = 0; tick < 1800; tick++) {
      const result = stepVehicleFollower(world, body, state, goal);
      body = stepCar(world, body, result.input);
      state = result.state;
    }
    expect(Math.hypot(body.x - 10, body.z + 80)).toBeLessThan(4);
    expect(Math.abs(body.speed)).toBeLessThan(0.3);
    expect(state.distanceM).toBeGreaterThan(75);
    expect(state.reversals).toBe(0);
  });
  it("starts reverse recovery before a ten-second stall without moving the supplied body", () => {
    const world = buildWorld([]), body = deepFreeze(makeCar(0, 0, 0));
    let state = createFollowerState(body), reversed = false;
    for (let tick = 0; tick < 600; tick++) {
      const result = stepVehicleFollower(world, body, state, { kind: "intercept", target: { x: 0, z: -100, speed: 2, heading: 0 } });
      state = result.state;
      if (result.input.throttle < 0) reversed = true;
    }
    expect(reversed).toBe(true);
    expect(state.reversals).toBeGreaterThan(0);
    expect(state.distanceM).toBe(0);
    expect(body.z).toBe(0);
  });
  it("does not count an arrived parked vehicle as stuck", () => {
    const world = buildWorld([]), body = makeCar(0, 0, 0);
    let state = createFollowerState(body);
    for (let tick = 0; tick < 700; tick++) state = stepVehicleFollower(world, body, state, { kind: "park-across-lane", target: { x: 0, z: 0 } }).state;
    expect(state.reversals).toBe(0);
    expect(state.blockedTicks).toBe(0);
  });
});
