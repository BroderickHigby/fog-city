// Decks, tunnel bores and stairways as the sim sees them (world QA W-02, W-03, W-12, W-14 sim
// half, W-33 sim half; docs/design.md "Decks, tunnels and water"). surfaceAt picks the highest
// surface at or below a body among the ground, the decks and the roofs, or a bore's floor for a
// body in the bore; a body on a deck is held by its rails and one in a bore by its walls and
// ceiling; agents ride their edge's deck or bore floor; cars meet a barrier round every
// stairway, walkers do not. On the synthetic world of fixtures.ts surfaceWorld.
import { describe, expect, it } from "vitest";
import {
  CAR,
  FOOT,
  circleBlocked,
  contradictoryDecks,
  makeCar,
  makeFoot,
  railPush,
  roadSurfaceHeight,
  stepCar,
  stepFoot,
  supported,
  surfaceAt,
  surfaceHeight,
  type CarState,
  type FootState,
  type SimInput,
} from "../../src/sim/index.ts";
import { divergeWorld, overpassY, portalDeckWorld, surfaceWorld, twinDeckWorld, twinDeckY } from "./fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });
/** Compass headings: north is -z. */
const NORTH = 0;
const SOUTH = Math.PI;
const EAST = Math.PI / 2;

function drive(c0: CarState, input: SimInput | ((t: number, c: CarState) => SimInput), ticks: number, w = surfaceWorld()): CarState[] {
  const out: CarState[] = [];
  let c = c0;
  for (let t = 0; t < ticks; t++) {
    c = stepCar(w, c, typeof input === "function" ? input(t, c) : input);
    out.push(c);
  }
  return out;
}

function walk(f0: FootState, input: SimInput, ticks: number, w = surfaceWorld()): FootState[] {
  const out: FootState[] = [];
  let f = f0;
  for (let t = 0; t < ticks; t++) {
    f = stepFoot(w, f, input, [], []);
    out.push(f);
  }
  return out;
}


describe("surfaceAt: the ground, decks, tunnel bores", () => {
  const w = surfaceWorld();

  it("on a deck a body stands on the deck; under it, on the ground; between the two, the ground", () => {
    expect(surfaceAt(w, 30, 130, 6)).toEqual({ y: 6, kind: "deck", ceiling: Infinity });
    expect(surfaceAt(w, 30, 130, 0)).toEqual({ y: 0, kind: "ground", ceiling: Infinity });
    expect(surfaceAt(w, 30, 130, 4).kind).toBe("ground");
    // Beside the deck (more than its 6 m half width off the centreline): the ground.
    expect(surfaceAt(w, 37, 130, 6)).toEqual({ y: 0, kind: "ground", ceiling: Infinity });
    // On the ramp: the deck's height interpolated between its vertices (every 4 m), never a
    // level shelf from the segment before: at a vertex its height, between two the blend.
    expect(surfaceHeight(w, 30, 52, 3)).toBeCloseTo(overpassY(52), 9);
    expect(surfaceHeight(w, 30, 53, 3)).toBeCloseTo((3 * overpassY(52) + overpassY(56)) / 4, 9);
    expect(surfaceHeight(w, 30, 201, 3.8)).toBeCloseTo((3 * overpassY(200) + overpassY(204)) / 4, 9);
  });

  it("in a bore a body stands on its floor under the ceiling; on the hill above, on the hill", () => {
    expect(surfaceAt(w, 0, -100, 0)).toEqual({ y: 0, kind: "tunnel", ceiling: 5 });
    expect(surfaceAt(w, 2, -120, 0.3)).toEqual({ y: 0, kind: "tunnel", ceiling: 5 });
    const top = surfaceAt(w, 0, -100, 20);
    expect(top.kind).toBe("ground");
    expect(top.y).toBeCloseTo(20, 6);
    // At the portal the hill is barely above the floor: a body at the floor is in the bore.
    expect(surfaceAt(w, 0, -60, 0).kind).toBe("tunnel");
    // Outside the bore's width the hill is the surface even at floor level (the bore's wall).
    expect(surfaceAt(w, 6, -100, 0).kind).toBe("ground");
  });

  it("supported: within RAIL_DROP_M below the feet and ROOF_STEP_M above; railPush points back onto the ribbon", () => {
    expect(supported(w, 30, 130, 6)).toBe(true);
    expect(supported(w, 37, 130, 6)).toBe(false); // off the deck's edge: a 6 m drop
    expect(supported(w, 5, -100, 0)).toBe(false); // into the bore's wall
    const p = railPush(w, 37, 130, 6)!;
    expect(p.dz).toBeCloseTo(0, 9);
    expect(p.dx).toBeLessThan(0);
    expect(37 + p.dx).toBeLessThanOrEqual(36);
    expect(railPush(w, 30, 130, 6)).toBeNull();
  });
});

describe("cars on decks and in bores", () => {
  it("drives up the overpass, along it and down: on the deck all the way, never airborne for more than a moment", () => {
    const w = surfaceWorld();
    const trace = drive({ ...makeCar(30, -10, SOUTH, 0), speed: 20 }, I(0.6), 900, w);
    let air = 0;
    let maxAir = 0;
    for (const c of trace) {
      // (The deck's vertices are 4 m apart: within a few centimetres of the profile they sample.)
      if (c.z > 0 && c.z < 255) expect(c.y, `z ${c.z.toFixed(1)}`).toBeGreaterThan(overpassY(c.z) - 0.1);
      air = c.grounded ? 0 : air + 1;
      maxAir = Math.max(maxAir, air);
    }
    expect(Math.max(...trace.map((c) => c.y))).toBeGreaterThan(5.9);
    expect(trace[trace.length - 1]!.z).toBeGreaterThan(270);
    expect(maxAir).toBeLessThanOrEqual(3);
    expect(trace[trace.length - 1]!.hits).toBe(0);
  });

  it("the deck's rail holds a car steered hard off its side at 20 m/s: it stays on the deck", () => {
    const w = surfaceWorld();
    for (const steer of [1, -1]) {
      const trace = drive({ ...makeCar(30, 120, SOUTH, 6), speed: 20 }, I(1, steer), 180, w);
      for (const c of trace) {
        if (c.z < 160) {
          expect(c.y, `steer ${steer}`).toBeGreaterThan(5.9);
          expect(Math.abs(c.x - 30), `steer ${steer}`).toBeLessThan(6);
        }
      }
      expect(trace.some((c) => c.sinceContact === 0), "the rail was met").toBe(true);
    }
  });

  it("a car on the street under the deck drives under it on the ground", () => {
    const trace = drive({ ...makeCar(-20, 130, EAST, 0), speed: 15 }, I(0.5), 300);
    for (const c of trace) expect(c.y).toBeLessThan(0.05);
    expect(trace[trace.length - 1]!.x).toBeGreaterThan(60);
    expect(trace[trace.length - 1]!.hits).toBe(0);
  });

  it("drives through the bore at 25 m/s on its floor, under the house on the hill, out of the far portal", () => {
    const w = surfaceWorld();
    const trace = drive({ ...makeCar(0, -20, NORTH, 0), speed: 25 }, I(1), 480, w);
    for (const c of trace) {
      expect(c.y).toBeLessThan(0.05);
      expect(c.grounded).toBe(true);
    }
    expect(trace[trace.length - 1]!.z).toBeLessThan(-175);
    expect(trace[trace.length - 1]!.hits).toBe(0);
  });

  it("the bore's walls hold a car steered hard into them: it stays in the bore, on the floor", () => {
    const w = surfaceWorld();
    for (const steer of [1, -1]) {
      const trace = drive({ ...makeCar(0, -60, NORTH, 0), speed: 20 }, I(1, steer), 150, w);
      for (const c of trace) {
        if (c.z < -60 && c.z > -140) {
          expect(c.y, `steer ${steer}`).toBeLessThan(0.05);
          expect(Math.abs(c.x), `steer ${steer}`).toBeLessThan(4);
        }
      }
    }
  });

  it("the ceiling holds a car in the bore down; on the hill over the bore a car drives on the hill", () => {
    const w = surfaceWorld();
    const c = stepCar(w, { ...makeCar(0, -100, NORTH, 4.5), grounded: false, vy: 3 }, I(0));
    expect(c.y + CAR.bodyHeight).toBeLessThanOrEqual(5 + 1e-9);
    expect(c.vy).toBeLessThanOrEqual(0);
    const top = drive({ ...makeCar(-30, -100, EAST, surfaceHeight(w, -30, -100, 20)), speed: 12 }, I(0.4), 300, w);
    for (const t of top) expect(t.y).toBeGreaterThan(19);
  });
});

describe("overlapping decks (I-80 near 1st St) and decks that contradict their bore (Broadway)", () => {
  it("a car on its own deck keeps to it where another deck overlaps it and climbs away over it, over a crest, to its end on the ground", () => {
    const w = twinDeckWorld();
    // The eastbound deck stands 0.3 m over the westbound one at the crest, inside the step.
    expect(surfaceAt(w, 0, 60, twinDeckY(60).wb).y).toBeCloseTo(twinDeckY(60).wb, 9);
    // A body 0.4 m over its own deck at the crest (airborne off it) is still over its own deck.
    expect(surfaceAt(w, 0, 62, twinDeckY(62).wb + 0.4).y).toBeCloseTo(twinDeckY(62).wb, 9);
    // On the eastbound centreline, the eastbound deck.
    expect(surfaceAt(w, 2.5, 80, twinDeckY(80).eb).y).toBeCloseTo(twinDeckY(80).eb, 9);
    for (const v of [20, 25, 30]) {
      const trace = drive({ ...makeCar(0, -20, SOUTH, 0), speed: v }, I(0.8), 900, w);
      for (const c of trace) {
        const label = `${v} m/s at z ${c.z.toFixed(1)}`;
        // Never on the eastbound deck: on the ground over the westbound one, and never more
        // than the crest's hop over it in the air.
        if (c.z > 0 && c.z < 120) {
          expect(c.y - twinDeckY(c.z).wb, label).toBeLessThan(c.grounded ? 0.2 : 1.5);
          expect(surfaceAt(w, c.x, c.z, c.y).y, label).toBeCloseTo(twinDeckY(c.z).wb, 1);
        }
        // Past the westbound deck's end, on the ground under the eastbound one.
        if (c.z > 130) expect(c.y, label).toBeLessThan(0.1);
      }
      const end = trace[trace.length - 1]!;
      expect(end.z, `${v} m/s`).toBeGreaterThan(260);
      expect(end.hits, `${v} m/s`).toBe(0);
    }
  });

  it("a car going straight on past an off-ramp keeps all four wheels on the freeway as the ramp falls away beside it", () => {
    const w = divergeWorld();
    const trace = drive({ ...makeCar(0, 20, SOUTH, 10), speed: 25 }, I(0.8), 720, w);
    for (const c of trace) {
      if (c.z < 30 || c.z > 290) continue;
      const fy = 10 + 0.04 * Math.max(0, c.z - 100);
      expect(Math.abs(c.y - fy), `z ${c.z.toFixed(1)}`).toBeLessThan(0.05);
      expect(Math.abs(c.x), `z ${c.z.toFixed(1)}`).toBeLessThan(0.5);
    }
    expect(trace[trace.length - 1]!.z).toBeGreaterThan(290);
    expect(trace[trace.length - 1]!.hits).toBe(0);
  });

  it("a deck of a bore's own edge over its portal is left out; another edge's deck over the bore stays", () => {
    const w = portalDeckWorld();
    expect([...contradictoryDecks(w.tiles)]).toEqual(["bad"]);
    // On the approach a car on the road stands on the ground, and it drives into the bore.
    expect(surfaceAt(w, 0, -40, 0).kind).toBe("ground");
    expect(surfaceAt(w, 0, -60, 0)).toEqual({ y: 0, kind: "tunnel", ceiling: 5 });
    expect(surfaceAt(w, 0, -100, 8).kind).toBe("deck");
    const trace = drive({ ...makeCar(0, 10, NORTH, 0), speed: 20 }, I(0.6), 480, w);
    for (const c of trace) if (c.z < -55 && c.z > -145) expect(c.y, `z ${c.z.toFixed(1)}`).toBeLessThan(0.05);
    expect(trace[trace.length - 1]!.z).toBeLessThan(-150);
    expect(trace[trace.length - 1]!.hits).toBe(0);
  });
});

describe("walkers on decks and in bores", () => {
  it("a walker walks into the deck's rail and stays on the deck; walks through the bore on its floor", () => {
    const w = surfaceWorld();
    const off = walk(makeFoot(30, 6, 130, EAST), I(1, 0, 1), 300, w);
    for (const f of off) {
      expect(f.y).toBeGreaterThan(5.9);
      expect(f.x).toBeLessThan(36);
      expect(f.grounded).toBe(true);
    }
    const through = walk(makeFoot(0, 0, -45, NORTH), I(1, 0, 1), 60 * 30, w);
    for (const f of through) expect(f.y).toBeLessThan(0.05);
    expect(through[through.length - 1]!.z).toBeLessThan(-150);
  });
});

describe("stairways are walked, never driven", () => {
  const w = surfaceWorld(true);

  it("no stairway edge carries traffic, and its barrier ring stops at the street's kerb", () => {
    expect(w.roads!.edges.find((e) => e.id === "stairs")!.drivable).toBe(false);
    expect(w.barriers!.segments.length).toBeGreaterThan(3);
    for (const s of w.barriers!.segments) {
      expect(s.kind).toBe("stairs");
      expect(Math.min(s.az, s.bz)).toBeGreaterThanOrEqual(205.5 - 1e-9);
    }
  });

  it("a car driven at the foot of the stairs stops at the barrier; along the street it passes", () => {
    const at = drive({ ...makeCar(-100, 190, SOUTH, 0), speed: 12 }, I(1), 240, w);
    for (const c of at) expect(c.z + CAR.halfLength).toBeLessThan(205.5 + 0.05);
    expect(at.some((c) => c.hits > 0)).toBe(true);
    const along = drive({ ...makeCar(-180, 200, EAST, 0), speed: 15 }, I(0.5), 600, w);
    expect(along[along.length - 1]!.x).toBeGreaterThan(-20);
    expect(along[along.length - 1]!.hits).toBe(0);
  });

  it("a walker climbs the stairs from the street to the top", () => {
    const trace = walk(makeFoot(-100, 0, 198, SOUTH), I(1, 0, 1), 60 * 30, w);
    const end = trace[trace.length - 1]!;
    expect(end.z).toBeGreaterThan(255);
    expect(end.y).toBeGreaterThan(25);
    expect(FOOT.maxGrade).toBeGreaterThanOrEqual(0.5);
  });
});

describe("agents and the road graph on decks and in bores", () => {
  const w = surfaceWorld(true);

  it("an edge's road surface is its deck or bore floor beside its ribbon, else the ground", () => {
    expect(roadSurfaceHeight(w, "deck-st", 30, 130)).toBe(6);
    // A sidewalk beside the deck's carriageway rides the deck too.
    expect(roadSurfaceHeight(w, "deck-st", 38, 130)).toBe(6);
    expect(roadSurfaceHeight(w, "under-st", 30, 130)).toBe(0);
    expect(roadSurfaceHeight(w, "bore-st", 0, -100)).toBe(0);
    expect(roadSurfaceHeight(w, "walk-st-a", -150, 200)).toBe(0);
  });

  it("the bore's lanes pass under the house on the hill: clear for traffic, blocked at the ground's height", () => {
    expect(circleBlocked(w, 0, -100, 1.2, roadSurfaceHeight(w, "bore-st", 0, -100))).toBe(false);
    expect(circleBlocked(w, 0, -100, 1.2)).toBe(true);
    const bore = w.roads!.edges.find((e) => e.id === "bore-st")!;
    expect(bore.drivable).toBe(true);
    expect(bore.laneClear[0].some(Boolean) && bore.laneClear[1].some(Boolean)).toBe(true);
  });
});
