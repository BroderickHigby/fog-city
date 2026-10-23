// The walker's vertical state (W-52) and buildings on foot (W-05, W-01): it stands on the ground
// or a roof within a step of its feet, falls under gravity off a drop instead of snapping to the
// ground below, cannot walk up a bank steeper than 1:1 that is taller than a metre (a short
// steep step it climbs), is blocked by a building only between its underside and its roof, and
// is pushed out of a building at most FOOT.maxPush a tick. (The buried-roof sites of the real
// city are walked in buried-buildings.test.ts.)
import { describe, expect, it } from "vitest";
import {
  FOOT,
  ROOF_STEP_M,
  buildWorld,
  makeFoot,
  pointInPolygon,
  stepFoot,
  surfaceHeight,
  type BuildingCollider,
  type FootState,
  type SimInput,
  type TileCollider,
  type World,
} from "../../../src/sim/index.ts";

const DT = 1 / 60;
const WALK: SimInput = { throttle: 1, steer: 0, brake: 0, actions: 0 };
const SPRINT: SimInput = { throttle: 1, steer: 0, brake: 1, actions: 0 };

function rect(id: string, x0: number, z0: number, x1: number, z1: number, baseY: number, topY: number, underY?: number): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY, topY, ...(underY === undefined ? {} : { underY }) };
}

/** A lattice of `cell` m over [-r, r] from h(x, z), plus buildings. */
function world(h: (x: number, z: number) => number, buildings: BuildingCollider[] = [], r = 60, cell = 0.5): World {
  const n = Math.round((2 * r) / cell) + 1;
  const heights: number[] = [];
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights.push(h(-r + ix * cell, -r + iz * cell));
  const tile: TileCollider = { tileId: "t", buildings, ground: { x0: -r, z0: -r, cellSizeM: cell, nx: n, nz: n, heights } };
  return buildWorld([tile]);
}

function walk(w: World, f0: FootState, input: SimInput, ticks: number): FootState[] {
  const out: FootState[] = [];
  let f = f0;
  for (let t = 0; t < ticks; t++) {
    f = stepFoot(w, f, input, [], []);
    out.push(f);
  }
  return out;
}

/** Ticks from the first airborne tick to landing. */
function fallTicks(trace: readonly FootState[]): number {
  const t0 = trace.findIndex((f) => !f.grounded);
  if (t0 < 0) return 0;
  const t1 = trace.findIndex((f, i) => i > t0 && f.grounded);
  return (t1 < 0 ? trace.length : t1) - t0;
}

describe("the walker falls", () => {
  it("walking off a 3 m roof edge takes at least 0.7 s to land, under gravity, and lands on the ground", () => {
    // A 3 m flat roof east of x = 0; the walker on it walks east... then off its far edge at x = 20.
    const w = world(() => 0, [rect("roof", 0, -10, 20, 10, 0, 3)]);
    const f0 = makeFoot(15, 3, 0, Math.PI / 2);
    expect(surfaceHeight(w, 15, 0, 3)).toBe(3);
    const trace = walk(w, f0, WALK, 300);
    const air = fallTicks(trace);
    expect(air * DT).toBeGreaterThanOrEqual(0.7);
    expect(air * DT).toBeLessThan(0.9);
    let prevY = 3;
    for (const f of trace) {
      // Never more than a tick of free fall at a time: no teleport to the ground.
      expect(prevY - f.y).toBeLessThan(FOOT.gravity * DT * 0.85 + 0.01);
      prevY = f.y;
    }
    const end = trace[trace.length - 1]!;
    expect(end.grounded).toBe(true);
    expect(end.y).toBe(0);
    expect(end.x).toBeGreaterThan(20.3);
  });

  it("walking off a 3 m bluff (a 1:3 face on the lattice) is a fall too, not a run down the cliff", () => {
    const w = world((x) => (x <= 0 ? 3 : x >= 1 ? 0 : 3 - 3 * x));
    const trace = walk(w, makeFoot(-3, 3, 0, Math.PI / 2), SPRINT, 300);
    expect(fallTicks(trace) * DT).toBeGreaterThanOrEqual(0.7);
    expect(trace[trace.length - 1]!.y).toBe(0);
  });

  it("follows a 1:1 slope down on its feet", () => {
    const w = world((x) => Math.max(0, 10 - x));
    for (const input of [WALK, SPRINT]) {
      const trace = walk(w, makeFoot(-2, 10, 0, Math.PI / 2), input, 600);
      for (const f of trace) expect(f.grounded).toBe(true);
      expect(trace[trace.length - 1]!.y).toBe(0);
    }
  });

  it("a v3 walker in the air carries its speed and heading, with no control", () => {
    const w = world(() => 0);
    const f0: FootState = { ...makeFoot(0, 10, 0, 0), speed: 3, grounded: false };
    const trace = walk(w, f0, { throttle: -1, steer: 1, brake: 0, actions: 0 }, 30);
    for (const f of trace.filter((q) => !q.grounded)) {
      expect(f.heading).toBe(0);
      expect(f.speed).toBeCloseTo(3, 6);
    }
  });
});

describe("the walker climbs", () => {
  /** Ground rising east from x = 0 at `grade` for `height` metres. */
  const bank = (grade: number, height: number) => (x: number) => Math.min(height, Math.max(0, grade * x));

  it("cannot walk up a slope steeper than 1:1 that is taller than a metre", () => {
    for (const grade of [1.2, 1.5, 3]) {
      const w = world(bank(grade, 3));
      for (const input of [WALK, SPRINT]) {
        const trace = walk(w, makeFoot(-3, 0, 0, Math.PI / 2), input, 600);
        for (const f of trace) expect(f.y, `grade ${grade}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("walks up a 1:1 slope, and up a steep bank shorter than a metre (a step)", () => {
    const one = walk(world(bank(1, 3)), makeFoot(-3, 0, 0, Math.PI / 2), WALK, 900);
    expect(one[one.length - 1]!.y).toBe(3);
    const step = walk(world(bank(2, 0.8)), makeFoot(-3, 0, 0, Math.PI / 2), WALK, 600);
    expect(step[step.length - 1]!.y).toBe(0.8);
  });

  it("slides along a bank it cannot climb instead of stopping dead", () => {
    // Walking north-east at a bank that rises east: the northward part of the step goes on.
    const w = world(bank(2, 3));
    const trace = walk(w, makeFoot(-0.6, 0, 0, Math.PI / 4), WALK, 600);
    const end = trace[trace.length - 1]!;
    // Still making way north along the foot of the bank (slowly, pressing into it), not stuck.
    expect(end.z).toBeLessThan(-1.5);
    expect(trace[trace.length - 61]!.z - end.z).toBeGreaterThan(0.1);
    expect(end.y).toBeLessThanOrEqual(1);
  });
});

describe("buildings on foot: a building blocks only between its underside and its roof", () => {
  it("steps onto a roof within a step of its feet; a higher one is a wall", () => {
    const low = world(() => 0, [rect("low", 2, -10, 20, 10, 0, ROOF_STEP_M - 0.1)]);
    const up = walk(low, makeFoot(0, 0, 0, Math.PI / 2), WALK, 300);
    expect(up[up.length - 1]!.x).toBeGreaterThan(5);
    expect(up[up.length - 1]!.y).toBeCloseTo(ROOF_STEP_M - 0.1, 9);
    const high = world(() => 0, [rect("high", 2, -10, 20, 10, 0, ROOF_STEP_M + 0.1)]);
    for (const f of walk(high, makeFoot(0, 0, 0, Math.PI / 2), SPRINT, 300)) expect(f.x).toBeLessThan(2 - FOOT.radius + 1e-6);
  });

  it("from a hillside above a buried roof, walks onto the roof and off its downhill edge: no invisible wall", () => {
    // 25% ground falling east; the roof (topY 0) is under the hill west of x = 0 and stands
    // up to 5 m above the ground to the east.
    const w = world((x) => -0.25 * x, [rect("house", -12, -6, 20, 6, -5, 0)]);
    const trace = walk(w, makeFoot(-20, 5, 0, Math.PI / 2), WALK, 60 * 40);
    const end = trace[trace.length - 1]!;
    expect(end.x).toBeGreaterThan(20);
    for (const f of trace) if (pointInPolygon(f.x, f.z, [[-12, -6], [20, -6], [20, 6], [-12, 6]])) expect(f.y).toBeGreaterThanOrEqual(0 - 1e-9);
    expect(fallTicks(trace)).toBeGreaterThan(0); // off the 5 m edge at x = 20
  });

  it("walks under a structure whose underside clears its head, not under a lower one", () => {
    const high = world(() => 0, [rect("deck", 2, -10, 6, 10, 0, 9, FOOT.height + 0.2)]);
    expect(walk(high, makeFoot(0, 0, 0, Math.PI / 2), WALK, 400).pop()!.x).toBeGreaterThan(8);
    const low = world(() => 0, [rect("deck", 2, -10, 6, 10, 0, 9, FOOT.height - 0.2)]);
    for (const f of walk(low, makeFoot(0, 0, 0, Math.PI / 2), WALK, 400)) expect(f.x).toBeLessThan(2);
  });

  it("a walker inside a footprint is eased out, at most FOOT.maxPush a tick", () => {
    const w = world(() => 0, [rect("block", -10, -10, 10, 10, 0, 8)]);
    const trace = walk(w, makeFoot(0, 0, 0, 0), { throttle: 0, steer: 0, brake: 0, actions: 0 }, 60);
    let prev = makeFoot(0, 0, 0, 0);
    for (const f of trace) {
      expect(Math.hypot(f.x - prev.x, f.z - prev.z)).toBeLessThanOrEqual(FOOT.maxPush + 1e-6);
      prev = f;
    }
    expect(pointInPolygon(prev.x, prev.z, [[-10, -10], [10, -10], [10, 10], [-10, 10]])).toBe(false);
  });
});
