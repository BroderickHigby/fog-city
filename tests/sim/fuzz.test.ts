// Random play: several players mash the controls (drive, slide, reverse, get out, walk, get
// back in) through the grid city with traffic on a hill. Nothing may crash, go non-finite,
// or end up inside a building, and the run must replay identically.
import { describe, expect, it } from "vitest";
import { Action, createInitialState, hashState, pointInPolygon, step, type InputFrame, type SimInput, type SimState } from "../../src/sim/index.ts";
import { gridCity } from "./fixtures.ts";

const world = gridCity(true);
const buildings = world.tiles.flatMap((t) => t.buildings);
const IDS = ["a", "b", "c"];

/** A tiny LCG for test inputs only (the sim has its own RNG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function play(seed: number, ticks: number, check: (s: SimState) => void): SimState {
  const rnd = lcg(seed);
  const held: Record<string, SimInput & { until: number }> = {};
  let s = createInitialState(world, seed, IDS, { x: 50, z: 0, heading: Math.PI / 2 });
  for (let t = 0; t < ticks; t++) {
    const frame: Record<string, SimInput> = {};
    for (const id of IDS) {
      let h = held[id];
      if (!h || t >= h.until) {
        h = held[id] = {
          throttle: Math.min(1, rnd() * 2.4 - 0.7),
          steer: rnd() * 2 - 1,
          brake: rnd() < 0.25 ? 1 : 0,
          actions: 0,
          until: t + 20 + Math.floor(rnd() * 200),
        };
      }
      frame[id] = { throttle: h.throttle, steer: h.steer, brake: h.brake, actions: rnd() < 0.003 ? Action.enterExit : 0 };
    }
    s = step(world, s, frame as InputFrame);
    check(s);
  }
  return s;
}

describe("random play", () => {
  for (const seed of [1, 2]) {
    it(`seed ${seed}: 4000 ticks, three players, no crash, nothing non-finite, nobody inside a building`, () => {
      const problems: string[] = [];
      let footTicks = 0;
      const end = play(seed, 4000, (s) => {
        for (const id of IDS) {
          const p = s.players[id]!;
          const c = p.car;
          for (const v of [c.x, c.y, c.z, c.speed, c.lateral, c.heading, c.vy, c.yawRate, c.grip]) if (!Number.isFinite(v)) problems.push(`t${s.tick} ${id} non-finite`);
          for (const b of buildings) if (c.y + 0.5 < b.topY && pointInPolygon(c.x, c.z, b.footprint)) problems.push(`t${s.tick} ${id} car inside ${b.id}`);
          if (p.foot) {
            footTicks++;
            for (const b of buildings) if (pointInPolygon(p.foot.x, p.foot.z, b.footprint)) problems.push(`t${s.tick} ${id} walker inside ${b.id}`);
          }
        }
      });
      expect(problems.slice(0, 5)).toEqual([]);
      expect(footTicks).toBeGreaterThan(100); // the players really did get out and walk
      expect(hashState(end)).toBe(hashState(play(seed, 4000, () => {})));
    });
  }
});
