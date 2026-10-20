import { describe, expect, it } from "vitest";
import { buildWorld, circleTouchesPolygon, closestOnBoundary, createInitialState, pointInPolygon, segmentBlocked, step } from "../../src/sim/index.ts";
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

describe("building queries", () => {
  // An L-shaped (concave) footprint and a thin slab.
  const L: Array<[number, number]> = [[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]];
  const slab: Array<[number, number]> = [[30, -10], [30.3, -10], [30.3, 10], [30, 10]];
  const w = buildWorld([
    {
      tileId: "q",
      buildings: [
        { id: "L", footprint: L, baseY: 0, topY: 12 },
        { id: "slab", footprint: slab, baseY: 0, topY: 12 },
        { id: "flat", footprint: [[-30, -30], [-20, -30], [-20, -20], [-30, -20]], baseY: 0, topY: 0 },
      ],
      ground: null,
    },
  ]);

  it("circleTouchesPolygon gives exactly pointInPolygon || closestOnBoundary within r", () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 20000; i++) {
      const x = rnd() * 50 - 15;
      const z = rnd() * 40 - 12;
      const r = rnd() * 3;
      for (const poly of [L, slab]) {
        const ref = pointInPolygon(x, z, poly) || closestOnBoundary(x, z, poly).d2 < r * r;
        expect(circleTouchesPolygon(x, z, r * r, poly)).toBe(ref);
      }
    }
  });

  it("segmentBlocked sees any building between two points, including thin ones and concave notches", () => {
    expect(segmentBlocked(w, 29, 0, 31.5, 0)).toBe(true); // across the 0.3 m slab
    expect(segmentBlocked(w, 29, 0, 29.9, 0)).toBe(false); // stops short of it
    expect(segmentBlocked(w, 29, 11, 31.5, 11)).toBe(false); // past its end
    expect(segmentBlocked(w, 10, 10, 15, 15)).toBe(false); // inside the L's notch
    expect(segmentBlocked(w, 10, 10, 3, 10)).toBe(true); // into the L's upright
    expect(segmentBlocked(w, 2, 2, 3, 3)).toBe(true); // wholly inside
    expect(segmentBlocked(w, -25, -40, -25, -10)).toBe(false); // a zero-height footprint is no wall
  });
});
