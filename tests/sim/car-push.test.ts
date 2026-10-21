// Collision pushes never launch a car (W-06, W-23, W-51, W-05): the car's vertical speed on
// the ground is the slope under its wheels along its velocity, never the height a push (out of
// a building, back from a wall) or a placement put it on; a push moves it at most CAR.maxPush a
// tick beyond its own travel; a car is placed only where it is clear; a building blocks a car
// only between its wheels plus a step and the top of its body, and a roof the wheels reach is
// driven on, never through.
import { describe, expect, it } from "vitest";
import {
  CAR,
  ROOF_STEP_M,
  UNDER_CLEARANCE_M,
  boxBlocked,
  buildWorld,
  carBox,
  circleBlocked,
  clearCarSpot,
  createInitialState,
  groundHeight,
  makeCar,
  pointInPolygon,
  sampleGround,
  segmentBlocked,
  step,
  stepCar,
  type BuildingCollider,
  type CarState,
  type SimInput,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";

const DT = 1 / 60;
const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });

function rect(id: string, x0: number, z0: number, x1: number, z1: number, baseY: number, topY: number, underY?: number): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY, topY, ...(underY === undefined ? {} : { underY }) };
}

/** A 1 m lattice over [-r, r] from h(x, z), plus buildings. */
function world(h: (x: number, z: number) => number, buildings: BuildingCollider[] = [], r = 120): World {
  const n = 2 * r + 1;
  const heights: number[] = [];
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights.push(h(-r + ix, -r + iz));
  const tile: TileCollider = { tileId: "t", buildings, ground: { x0: -r, z0: -r, cellSizeM: 1, nx: n, nz: n, heights } };
  return buildWorld([tile]);
}

interface Trace {
  cars: CarState[];
  /** Largest per-tick move beyond speed * DT + 0.5 m (<= 0: within the bound). */
  excess: number;
  /** Largest upward vy beyond |v| * (the ground's slope along the travel) + 1 m/s. */
  lift: number;
  /** Highest the car got above the surface under it. */
  above: number;
}

function drive(w: World, c0: CarState, input: SimInput | ((t: number) => SimInput), ticks: number): Trace {
  const cars: CarState[] = [];
  let c = c0;
  let excess = -Infinity;
  let lift = -Infinity;
  let above = 0;
  for (let t = 0; t < ticks; t++) {
    const p = c;
    c = stepCar(w, c, typeof input === "function" ? input(t) : input);
    cars.push(c);
    const v = Math.hypot(c.x - p.x, c.z - p.z) / DT;
    excess = Math.max(excess, Math.hypot(c.x - p.x, c.z - p.z) - (Math.max(Math.abs(p.speed), Math.hypot(c.speed, c.lateral)) * DT + 0.5));
    // The ground's own slope along the travel, measured on a 1 m baseline.
    const ux = v > 1e-9 ? (c.x - p.x) / (v * DT) : 0;
    const uz = v > 1e-9 ? (c.z - p.z) / (v * DT) : 0;
    const slope = (groundHeight(w, c.x + ux * 0.5, c.z + uz * 0.5) - groundHeight(w, c.x - ux * 0.5, c.z - uz * 0.5)) / 1;
    const vh = Math.hypot(c.speed, c.lateral);
    lift = Math.max(lift, c.vy - (vh * Math.max(0, slope) + 1));
    // The gap under the wheels: 0 on the ground, the height while flying.
    above = Math.max(above, c.y - sampleGround(w, c.x, c.z, c.heading, p.y).h);
  }
  return { cars, excess, lift, above };
}

describe("a push is not a climb", () => {
  // A 3 m bank: flat ground at 0 west of x = 0, 3 m from x = 1 eastward (a 300% face).
  const bankH = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 3 : 3 * x);

  it("a car shoved sideways onto a 3 m bank by a building gains no lift and never leaves the ground", () => {
    // A building west of the car overlaps its left side; the push out of it is east, up the bank.
    for (const speed of [0, 10, 25]) {
      const w = world(bankH, [rect("block", -40, -100, -0.4, 100, 0, 12)]);
      const c0: CarState = { ...makeCar(-0.2, 40, 0, 0), speed };
      const tr = drive(w, c0, I(speed > 0 ? 1 : 0), 120);
      expect(tr.lift, `speed ${speed}: vy beyond |v| x slope + 1`).toBeLessThanOrEqual(0);
      expect(tr.above, `speed ${speed}: rose above the ground`).toBeLessThanOrEqual(CAR.suspension + 1e-9);
      expect(tr.excess, `speed ${speed}: one tick moved too far`).toBeLessThanOrEqual(1e-9);
      for (const c of tr.cars) expect(c.grounded).toBe(true);
    }
  });

  it("ramming a building on a steep hill at full speed never launches the car", () => {
    // 30% ground rising east; a 10 m block on it. Rams from every side at 25 m/s.
    const hill = (x: number): number => 0.3 * x;
    const w = world(hill, [rect("house", -6, -6, 6, 6, hill(0), hill(0) + 10)]);
    for (let k = 0; k < 16; k++) {
      const a = (2 * Math.PI * k) / 16;
      const sx = Math.sin(a) * 30;
      const sz = -Math.cos(a) * 30;
      const heading = Math.atan2(-sx, sz);
      // Already driving: on the ground, rising or falling with the slope.
      const g0 = sampleGround(w, sx, sz, heading);
      const c0: CarState = { ...makeCar(sx, sz, heading, g0.h), speed: 25, vy: 25 * g0.slopeF };
      const tr = drive(w, c0, I(1), 240);
      const hit = tr.cars.findIndex((c) => c.sinceContact === 0);
      let air = 0;
      let maxAir = 0;
      for (const c of tr.cars.slice(Math.max(0, hit))) {
        air = c.grounded ? 0 : air + 1;
        maxAir = Math.max(maxAir, air);
      }
      expect(tr.cars.some((c) => c.sinceContact === 0), `ram ${k} hit`).toBe(true);
      expect(maxAir / 60, `ram ${k} airborne`).toBeLessThanOrEqual(0.3);
      expect(tr.above, `ram ${k} rose`).toBeLessThanOrEqual(0.5);
      expect(tr.lift, `ram ${k} lift`).toBeLessThanOrEqual(0);
      expect(tr.excess, `ram ${k} move`).toBeLessThanOrEqual(1e-9);
    }
  });
});

describe("a car placed overlapping a footprint", () => {
  const slope = (x: number, z: number): number => 0.25 * x - 0.1 * z;
  const block = rect("block", -10, -10, 10, 10, 0, 15);

  it("eases out over several ticks, never more than speed x DT + 0.5 m a tick, and never rises", () => {
    for (const [x, z, heading, speed] of [
      [0, 0, 0, 0],
      [8, 2, Math.PI / 2, 15],
      [-9.5, 3, 0, 8],
      [3, -9, Math.PI, 15],
    ] as const) {
      const w = world(slope, [block]);
      const c0: CarState = { ...makeCar(x, z, heading, groundHeight(w, x, z)), speed };
      // Two seconds: out of the block, and well short of the test world's edge.
      const tr = drive(w, c0, I(speed > 0 ? 1 : 0), 120);
      expect(tr.excess, `(${x}, ${z})`).toBeLessThanOrEqual(1e-9);
      expect(tr.lift, `(${x}, ${z})`).toBeLessThanOrEqual(0);
      expect(tr.above, `(${x}, ${z})`).toBeLessThan(0.5);
      const end = tr.cars[tr.cars.length - 1]!;
      expect(boxBlocked(w, carBox(end), end.y + ROOF_STEP_M), `(${x}, ${z}) still inside`).toBe(false);
    }
  });

  it("a spawn or a join asked inside a footprint goes to the nearest clear spot instead", () => {
    const w = world(() => 0, [block]);
    const p = clearCarSpot(w, 0, 0, 0);
    expect(boxBlocked(w, { ...carBox({ x: p.x, z: p.z, heading: 0 }) }, ROOF_STEP_M)).toBe(false);
    // The nearest: just outside the block's 10 m half width, not across the world.
    expect(Math.hypot(p.x, p.z)).toBeLessThan(13);
    const s0 = createInitialState(w, 1, ["a", "b"], { x: 0, z: 0, heading: 0 });
    const s = step(w, s0, {}, [{ tick: 1, kind: "player.join", playerId: "c", payload: { x: 1, z: 1, heading: 0 } }]);
    for (const id of ["a", "b", "c"]) {
      const c = s.players[id]!.car;
      expect(pointInPolygon(c.x, c.z, block.footprint), id).toBe(false);
      expect(boxBlocked(w, carBox(c), c.y + ROOF_STEP_M), id).toBe(false);
    }
    // ...and never on top of each other.
    const [a, b, c] = ["a", "b", "c"].map((id) => s.players[id]!.car);
    for (const [p1, p2] of [[a!, b!], [a!, c!], [b!, c!]] as const) expect(Math.hypot(p1.x - p2.x, p1.z - p2.z)).toBeGreaterThan(1.9);
  });

  it("a clear spawn is left exactly where it was asked", () => {
    const w = world(() => 0, [block]);
    expect(clearCarSpot(w, 30, 30, 1)).toEqual({ x: 30, z: 30 });
  });
});

describe("roofs and undersides (a building blocks only between its underside and its roof)", () => {
  it("a roof flush with a hillside is driven onto and off, never through and never with a jump out of it", () => {
    // 20% ground falling to the east; a house whose roof (topY 2) is buried on the uphill (west)
    // side and stands 6 m above the ground on the downhill side.
    const hill = (x: number): number => -0.2 * x;
    const house = rect("house", -10, -6, 20, 6, -2, 2);
    const w = world(hill, [house]);
    const c0: CarState = { ...makeCar(-30, 0, Math.PI / 2, hill(-30)), speed: 8 };
    const tr = drive(w, c0, I(0.4), 600);
    expect(tr.excess).toBeLessThanOrEqual(1e-9);
    let onRoof = 0;
    for (const c of tr.cars) {
      // Inside the footprint the car is on the roof or above it, never inside the walls.
      if (pointInPolygon(c.x, c.z, house.footprint)) {
        expect(c.y).toBeGreaterThanOrEqual(house.topY - ROOF_STEP_M);
        if (c.grounded) onRoof++;
      }
    }
    expect(onRoof).toBeGreaterThan(30);
    // It carried on past the house, dropping off the roof's downhill edge.
    const end = tr.cars[tr.cars.length - 1]!;
    expect(end.x).toBeGreaterThan(25);
    expect(end.y).toBeCloseTo(groundHeight(w, end.x, end.z), 1);
  });

  it("a roof more than a step above the wheels is a wall", () => {
    const w = world(() => 0, [rect("kerb", -5, -32, 5, -28, 0, ROOF_STEP_M + 0.1)]);
    const tr = drive(w, { ...makeCar(0, 0, 0, 0), speed: 10 }, I(0.5), 240);
    for (const c of tr.cars) expect(c.z - CAR.halfLength).toBeGreaterThan(-28.01);
  });

  it("a car drives under a structure whose underside clears its roof, and is stopped by one that does not", () => {
    const high = world(() => 0, [rect("deck", -20, -32, 20, -28, 0, 9, CAR.bodyHeight + 0.5)]);
    const under = drive(high, { ...makeCar(0, 0, 0, 0), speed: 10 }, I(0.5), 240);
    expect(under.cars[under.cars.length - 1]!.z).toBeLessThan(-40);
    for (const c of under.cars) expect(c.hits).toBe(0);
    const low = world(() => 0, [rect("deck", -20, -32, 20, -28, 0, 9, CAR.bodyHeight - 0.3)]);
    const stopped = drive(low, { ...makeCar(0, 0, 0, 0), speed: 10 }, I(0.5), 240);
    for (const c of stopped.cars) expect(c.z - CAR.halfLength).toBeGreaterThan(-28.01);
  });
});

describe("undersides for agents and sight lines (W-01, sim half)", () => {
  // A deck spanning a street: underside 5.5 m above the flat ground, roof at 9 m.
  const deck = (underY?: number): World => world(() => 0, [rect("deck", -20, -4, 20, 4, 0, 9, underY)]);

  it("the road graph's clearance and agents pass under a structure at least UNDER_CLEARANCE_M up, not under a lower one", () => {
    expect(circleBlocked(deck(5.5), 0, 0, 1)).toBe(false);
    expect(circleBlocked(deck(UNDER_CLEARANCE_M - 0.5), 0, 0, 1)).toBe(true);
    expect(circleBlocked(deck(), 0, 0, 1)).toBe(true);
  });

  it("a sight line under a high deck is open, through a solid block it is not", () => {
    expect(segmentBlocked(deck(5.5), 0, -10, 0, 10)).toBe(false);
    expect(segmentBlocked(deck(), 0, -10, 0, 10)).toBe(true);
  });
});
