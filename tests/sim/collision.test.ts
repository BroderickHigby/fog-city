import { describe, expect, it } from "vitest";
import { createInitialState, pointInPolygon, step } from "../../src/sim/index.ts";
import { loadWorld } from "../helpers.ts";

const { world, manifest } = loadWorld("dev");
const wall: Array<[number, number]> = [[-40, -70], [40, -70], [40, -60], [-40, -60]];

describe("car vs buildings", () => {
  it("full throttle north into the dev wall never ends up inside it", () => {
    let s = createInitialState(world, 1, ["p1"], manifest.spawn);
    for (let t = 0; t < 60 * 10; t++) {
      s = step(world, s, { p1: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
      const c = s.players.p1!.car;
      expect(pointInPolygon(c.x, c.z, wall)).toBe(false);
    }
    const car = s.players.p1!.car;
    expect(car.hits).toBeGreaterThan(0);
    expect(car.z).toBeGreaterThan(-60);
  });

  it("drives forward (north = -z) when throttled", () => {
    let s = createInitialState(world, 1, ["p1"], manifest.spawn);
    for (let t = 0; t < 60; t++) s = step(world, s, { p1: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
    expect(s.players.p1!.car.z).toBeLessThan(-2);
    expect(Math.abs(s.players.p1!.car.x)).toBeLessThan(1e-9);
  });
});
