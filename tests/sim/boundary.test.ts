// The world's edge and shore walls (src/sim/boundary.ts): cars and walkers stop at them from
// either side, at any speed, and a body stays on the side it started on (a car that is somehow
// on the water is never thrown onto the bank). Roads over water get a corridor through the
// shore, walled along its sides over the water; the outline is never cut. On the real city:
// the land edge at the southern city limit and the Ocean Beach shoreline stop a car driven
// straight at them, the spawn and the surface streets are clear of every wall, the 3rd St
// bridge over Mission Creek can be driven across but not driven off, a car on the creek stays
// on it, and seeded random drives along the creek's banks never reach open water or fly.
import { beforeAll, describe, expect, it } from "vitest";
import {
  Action,
  CAR,
  boxBlocked,
  buildWalls,
  buildWorld,
  carBox,
  circleHitsWall,
  createInitialState,
  dcos,
  dsin,
  groundHeight,
  inCorridor,
  makeCar,
  onWater,
  pathPoint,
  segmentCrossesWall,
  step,
  stepCar,
  wallSide,
  type BoundaryFile,
  type CarState,
  type Path,
  type RoadsFile,
  type SimInput,
  type SimState,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";
import { loadWorldFiles, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const FULL: SimInput = { throttle: 1, steer: 0, brake: 0, actions: 0 };

/** Drive one car with constant input (or input by tick); the trace of every tick. */
function drive(world: World, c0: CarState, ticks: number, input: SimInput | ((t: number, c: CarState) => SimInput) = FULL): CarState[] {
  const out: CarState[] = [];
  let c = c0;
  for (let t = 0; t < ticks; t++) {
    c = stepCar(world, c, typeof input === "function" ? input(t, c) : input);
    out.push(c);
  }
  return out;
}

/** World positions of the four corners of the car's body. */
function corners(c: CarState): Array<[number, number]> {
  const b = carBox(c);
  const fx = dsin(b.heading);
  const fz = -dcos(b.heading);
  return ([
    [b.hw, b.hl],
    [-b.hw, b.hl],
    [b.hw, -b.hl],
    [-b.hw, -b.hl],
  ] as const).map(([l, f]) => [b.x - fz * l + fx * f, b.z + fx * l + fz * f]);
}

/** Only walls this close count for overshoot (a wall's far side may be land again, across a creek). */
const NEAR_M = 3;

/** The deepest any corner of the car's body reaches past a wall onto its water side (+ = beyond it). */
function overshoot(world: World, c: CarState): number {
  let worst = -Infinity;
  for (const [x, z] of corners(c)) {
    for (const w of world.walls!.segments) {
      const d = wallSide(w, x, z);
      if (d !== null && d > -NEAR_M) worst = Math.max(worst, -d);
    }
  }
  return worst;
}

/** Flat ground of a given height over a box, as one tile. */
function ground(tileId: string, x0: number, z0: number, x1: number, z1: number, h: (x: number, z: number) => number): TileCollider {
  const nx = Math.round((x1 - x0) / 10) + 1;
  const nz = Math.round((z1 - z0) / 10) + 1;
  const heights: number[] = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) heights.push(h(x0 + i * 10, z0 + k * 10));
  return { tileId, buildings: [], ground: { x0, z0, cellSizeM: 10, nx, nz, heights } };
}

/** How far the body reaches across from its centre toward a wall it is turned `turn` radians toward from parallel. */
function reach(turn: number): number {
  return CAR.halfLength * Math.abs(Math.sin(turn)) + CAR.halfWidth * Math.cos(turn);
}

/** The wrap of an angle difference into [-pi, pi]. */
function wrap(d: number): number {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

describe("boundary walls: a synthetic shore", () => {
  // Land north of z = 0 (left of travel along +x), a 400 m wall; open ground beyond it.
  const boundary: BoundaryFile = {
    version: 1,
    seaLevelY: 0,
    edges: [],
    shore: [{ closed: false, points: [[-200, 0], [200, 0]] }],
  };
  const flat = { tileId: "flat", buildings: [], ground: null };
  const world = buildWorld([flat], null, boundary);

  it("builds segments whose normal points at the land, reaching a little past free ends and outward corners only", () => {
    expect(world.walls!.segments).toHaveLength(1);
    const w = world.walls!.segments[0]!;
    expect([w.nx, w.nz]).toEqual([0, -1]);
    expect(wallSide(w, 0, -5)).toBe(5);
    expect(wallSide(w, 0, 2)).toBe(-2);
    expect(wallSide(w, 300, -5)).toBeNull();
    expect([w.reachA, w.reachB]).toEqual([0.5, 0.5]);
    // East then north: the land (north and west of the corner) has an outward corner, the
    // walls reach past it; the same line run backwards wraps the land round an inward corner,
    // where each only meets the other.
    const out = buildWalls({ ...boundary, shore: [{ closed: false, points: [[-100, 0], [0, 0], [0, -100]] }] }, null).segments;
    expect(out.map((s) => [s.reachA, s.reachB])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    const inward = buildWalls({ ...boundary, shore: [{ closed: false, points: [[0, -100], [0, 0], [-100, 0]] }] }, null).segments;
    expect(inward.map((s) => [s.reachA, s.reachB])).toEqual([
      [0.5, 0.05],
      [0.05, 0.5],
    ]);
  });

  it("a car at full throttle into the wall stops at it, whatever its angle, and the impact counts", () => {
    for (const heading of [Math.PI, Math.PI * 0.8, Math.PI * 1.3]) {
      const trace = drive(world, makeCar(0, -40, heading), 600);
      for (const c of trace) expect(overshoot(world, c), `heading ${heading}`).toBeLessThan(0.02);
      const last = trace[trace.length - 1]!;
      expect(last.z).toBeLessThan(0);
      expect(last.hits).toBeGreaterThan(0);
    }
  });

  it("a car at 50 m/s never tunnels through it", () => {
    const fast: CarState = { ...makeCar(0, -30, Math.PI), speed: 50 };
    for (const c of drive(world, fast, 120)) expect(overshoot(world, c)).toBeLessThan(0.02);
  });

  it("a walker stops at it, and nobody gets out of a car onto its water side", () => {
    // Parked facing west 10 m from the wall: the driver's door (left of west) faces the wall.
    let s: SimState = createInitialState(world, 1, ["p1"], { x: 0, z: -10, heading: Math.PI * 1.5 });
    s = step(world, s, { p1: { ...FULL, throttle: 0, actions: Action.enterExit } });
    expect(s.players.p1!.mode).toBe("foot");
    expect(s.players.p1!.foot!.z).toBeGreaterThan(-10);
    // Turn to face south (the wall) and sprint at it for 10 s.
    for (let t = 0; t < 600; t++) s = step(world, s, { p1: { throttle: 1, steer: t < 43 ? -1 : 0, brake: 1, actions: 0 } });
    const f = s.players.p1!.foot!;
    expect(f.z, "the walker stands at the wall").toBeGreaterThan(-1.2);
    expect(f.z, "and not past it").toBeLessThan(-0.3);
    expect(circleHitsWall(world.walls, 0, 0.2, 0.35)).toBe(true);
    expect(segmentCrossesWall(world.walls, 0, -2, 0, 2)).toBe(true);
    expect(segmentCrossesWall(world.walls, 0, -2, 5, -1)).toBe(false);
  });

  it("does not reach across to a point well behind it (the far side of a pier)", () => {
    const behind = makeCar(0, 8, 0);
    expect(boxBlocked(world, carBox(behind), 0)).toBe(false);
  });

  it("holds a car on the water side too: one on the water a few metres from the wall is never thrown onto the bank", () => {
    // Land at 3 m north of z = -10, sloping to the water at z = 0; the water (z > 0) at sea level.
    const bank = buildWorld([ground("bank", -200, -100, 200, 100, (_x, z) => (z <= -10 ? 3 : z >= 0 ? 0 : (-z / 10) * 3))], null, boundary);
    for (const clear of [0.03, 1, 2]) {
      for (const turn of [0, -0.4, -0.9]) {
        // Heading east along the wall at 15 m/s, or turned north into it, the nearest corner
        // `clear` metres off the wall; then full throttle.
        const back = clear + reach(turn);
        const c0: CarState = { ...makeCar(0, back, Math.PI / 2 + turn), speed: 15 };
        const trace = drive(bank, c0, 600, (t) => ({ ...FULL, steer: t < 60 ? -0.5 : 0 }));
        for (const c of trace) {
          for (const [, z] of corners(c)) expect(z, `clear ${clear} turn ${turn}`).toBeGreaterThan(-0.02);
          expect(c.y, "no launch off the bank").toBeLessThan(0.6);
          expect(c.vy).toBeLessThan(1);
        }
      }
    }
  });

  it("a car pressed into a pier's corner at any angle never ends a tick across either wall", () => {
    // A pier 20 m wide (-10 < x < 10) reaching north to z = 0, water all round it.
    const pier = buildWorld([flat], null, { ...boundary, shore: [{ closed: false, points: [[10, 100], [10, 0], [-10, 0], [-10, 100]] }] });
    for (const heading of [0, 0.3, -0.3, 0.6, -0.6, Math.PI / 4, -Math.PI / 4]) {
      for (const x0 of [-6, 0, 6]) {
        const trace = drive(pier, makeCar(x0, 30, heading), 600, (t) => ({ ...FULL, steer: Math.sin(t / 25) * 0.8 }));
        for (const c of trace) {
          for (const [x, z] of corners(c)) {
            expect(x, `heading ${heading} from x ${x0}`).toBeGreaterThan(-10.02);
            expect(x).toBeLessThan(10.02);
            expect(z).toBeGreaterThan(-0.02);
          }
        }
      }
    }
  });
});

describe("boundary walls: roads over water", () => {
  // A creek 40 m wide: land at 3 m north of z = 0 and south of z = 40, water between.
  const creek: BoundaryFile = {
    version: 1,
    seaLevelY: 0,
    edges: [],
    shore: [
      { closed: false, points: [[-200, 0], [200, 0]] },
      { closed: false, points: [[200, 40], [-200, 40]] },
    ],
  };
  const tile = ground("creek", -200, -100, 200, 140, (_x, z) => (z <= -10 || z >= 50 ? 3 : z >= 0 && z <= 40 ? 0 : z < 0 ? (-z / 10) * 3 : ((z - 40) / 10) * 3));
  const edge = (id: string, x: number, z0: number, z1: number, extra: Partial<RoadsFile["edges"][number]> = {}): RoadsFile["edges"][number] => ({
    id,
    a: `${id}a`,
    b: `${id}b`,
    kind: "arterial",
    lanes: 2,
    oneway: false,
    widthM: 12,
    points: [
      [x, z0],
      [x, z1],
    ],
    ...extra,
  });
  const roadsOf = (...edges: Array<RoadsFile["edges"][number]>): RoadsFile => ({
    version: 1,
    nodes: edges.flatMap((e) => [
      { id: e.a, x: e.points[0]![0]!, z: e.points[0]![1]! },
      { id: e.b, x: e.points[e.points.length - 1]![0]!, z: e.points[e.points.length - 1]![1]! },
    ]),
    edges,
  });
  const bridgeRoads = roadsOf(edge("bridge", 0, -60, 100));
  const world = buildWorld([tile], bridgeRoads, creek);
  // Road half width 6 plus the corridor's margin of 3.
  const HALF = 9;

  it("cuts the shore only inside the road's corridor and walls the corridor's sides over the water", () => {
    const w = world.walls!;
    expect(w.corridors).toHaveLength(1);
    expect(w.gaps).toBe(2);
    for (const s of w.segments.filter((q) => q.kind === "shore")) {
      expect(Math.min(Math.abs(s.ax), Math.abs(s.bx)), "shore cut at the corridor's sides").toBeGreaterThanOrEqual(HALF - 1e-9);
    }
    const kerbs = w.segments.filter((q) => q.kind === "kerb");
    expect(kerbs.length).toBeGreaterThanOrEqual(2);
    for (const k of kerbs) {
      expect(Math.abs(k.ax)).toBeCloseTo(HALF, 9);
      expect(Math.abs(k.bx)).toBeCloseTo(HALF, 9);
      // Over the water, carrying on just onto each bank.
      for (const z of [k.az, k.bz]) {
        expect(z).toBeGreaterThanOrEqual(-0.5 - 1e-9);
        expect(z).toBeLessThanOrEqual(40.5 + 1e-9);
      }
    }
    expect(onWater(w.shore, 0, 20)).toBe(true);
    expect(onWater(w.shore, 0, -20)).toBe(false);
    expect(inCorridor(w, 0, 20)).toBe(true);
    expect(inCorridor(w, 30, 20)).toBe(false);
  });

  it("a car drives straight across the bridge, untouched", () => {
    const trace = drive(world, makeCar(0, -40, Math.PI, 3), 480);
    expect(trace[trace.length - 1]!.z).toBeGreaterThan(60);
    for (const c of trace) expect(c.hits).toBe(0);
  });

  it("a car steered off the bridge stays on it: never on the water outside the corridor", () => {
    for (const steer of [1, -1]) {
      const c0: CarState = { ...makeCar(0, 8, Math.PI, 0), speed: 15 };
      const trace = drive(world, c0, 300, (t) => ({ ...FULL, steer: t < 120 ? steer : -steer }));
      for (const c of trace) {
        expect(onWater(world.walls!.shore, c.x, c.z) && !inCorridor(world.walls!, c.x, c.z), `(${c.x.toFixed(2)}, ${c.z.toFixed(2)})`).toBe(false);
        for (const [x, z] of corners(c)) if (z > 0.5 && z < 39.5) expect(Math.abs(x)).toBeLessThan(HALF + 0.02);
      }
      expect(trace[trace.length - 1]!.hits, "it hit the kerb").toBeGreaterThan(0);
    }
  });

  it("a freeway over the same creek gets no corridor: its deck is not modelled, so the shore stays walled", () => {
    const fw = buildWorld([tile], roadsOf(edge("fw", 0, -60, 100, { kind: "freeway", gradeSeparated: true })), creek);
    expect(fw.walls!.corridors).toHaveLength(0);
    expect(fw.walls!.gaps).toBe(0);
    const last = drive(fw, makeCar(0, -40, Math.PI, 3), 300).pop()!;
    expect(last.z).toBeLessThan(0);
  });

  it("overlapping corridors are one: the two halves of a divided road keep only their outer kerbs", () => {
    // Two one-way roads 12 m apart, 10 m wide: corridors [-14, 2] and [-2, 14].
    const divided = buildWorld(
      [tile],
      roadsOf(edge("south", -6, -60, 100, { oneway: true, widthM: 10 }), edge("north", 6, 100, -60, { oneway: true, widthM: 10 })),
      creek,
    );
    const kerbs = divided.walls!.segments.filter((q) => q.kind === "kerb");
    expect(kerbs.length).toBeGreaterThanOrEqual(2);
    for (const k of kerbs) expect(Math.abs(k.ax)).toBeCloseTo(14, 9);
    // So a car can change from one carriageway to the other over the water.
    const trace = drive(divided, { ...makeCar(-6, 4, Math.PI, 0), speed: 10 }, 150, (t) => ({ ...FULL, throttle: 0.4, steer: t < 60 ? -0.8 : t < 120 ? 0.8 : 0 }));
    expect(trace[trace.length - 1]!.x, "out of the southbound road's corridor").toBeGreaterThan(3);
    expect(trace[trace.length - 1]!.z, "still over the water").toBeLessThan(40);
    for (const c of trace) expect(c.hits).toBe(0);
  });

  it("a pier road that ends over the water is capped past its end", () => {
    // Only the north shore: the road runs out 30 m over open water and stops.
    const pier = buildWorld([tile], roadsOf(edge("pier", 0, -60, 30)), { ...creek, shore: [creek.shore[0]!] });
    const w = pier.walls!;
    expect(w.corridors).toHaveLength(1);
    const cap = w.segments.filter((q) => q.kind === "kerb" && Math.abs(q.az - q.bz) < 1e-9);
    expect(cap).toHaveLength(1);
    expect(cap[0]!.az).toBeCloseTo(30 + HALF, 9);
    const trace = drive(pier, makeCar(0, -40, Math.PI, 3), 600);
    for (const c of trace) for (const [, z] of corners(c)) expect(z).toBeLessThan(30 + HALF + 0.02);
    expect(trace[trace.length - 1]!.hits).toBeGreaterThan(0);
  });
});

const SF = worldExists("sf");

describe.skipIf(!SF)("boundary walls on the real city", () => {
  let world: World;
  let noWalls: World;
  let files: ReturnType<typeof loadWorldFiles>;
  beforeAll(() => {
    files = loadWorldFiles("sf");
    world = buildWorld(files.tiles, files.roads as RoadsFile, files.boundary);
    noWalls = { ...world, walls: null };
  }, SF_RUN_MS);

  /** On open water, outside every road corridor. */
  const adrift = (x: number, z: number): boolean => onWater(world.walls!.shore, x, z) && !inCorridor(world.walls!, x, z);

  it("walls the land edge and the shore, with corridors only for streets traffic or people may use", () => {
    const w = world.walls!;
    // The land walls: stubs beside the Ocean Beach strip and Yerba Buena Island, the last built
    // row's south edge, and the county line itself inside that row, where the Daly City strip
    // beyond it is scenery (W-42): more than 9.5 km in all.
    const land = w.segments.filter((s) => s.kind === "land");
    expect(land.length).toBeGreaterThanOrEqual(3);
    expect(land.reduce((sum, s) => sum + Math.hypot(s.bx - s.ax, s.bz - s.az), 0)).toBeGreaterThan(9500);
    expect(w.segments.filter((s) => s.kind === "shore").length).toBeGreaterThan(1000);
    expect(w.segments.filter((s) => s.kind === "kerb").length).toBeGreaterThan(20);
    expect(w.gaps).toBeGreaterThanOrEqual(10);
    expect(w.gaps).toBeLessThan(60);
    const g = world.roads!;
    const ids = new Set(w.corridors.map((c) => c.edgeId));
    for (const id of ids) {
      const e = g.edges[g.edgeIndex.get(id)!]!;
      expect(e.drivable || e.walkable, `${id} ${e.name}`).toBe(true);
    }
    // The 3rd St and 4th St bridges over Mission Creek, the 3rd St bridge over Islais Creek;
    // never the I-280 ramps that cross Mission Creek on their viaduct.
    for (const name of ["3rd St", "4th St"]) expect([...ids].some((id) => g.edges[g.edgeIndex.get(id)!]!.name === name), name).toBe(true);
    expect([...ids].some((id) => g.edges[g.edgeIndex.get(id)!]!.name.includes("I-280"))).toBe(false);
  });

  it("the spawn and the surface streets are clear of every wall", () => {
    const sp = files.manifest.spawn;
    expect(boxBlocked(world, carBox(makeCar(sp.x, sp.z, sp.heading)), 1e9)).toBe(false);
    // Every 8 m of every usable lane: a car body there touches no wall (a handful of pier stubs may).
    const g = world.roads!;
    const empty: World = { ...world, cells: new Map(), cellBoxes: new Map() };
    let n = 0;
    let blocked = 0;
    for (const e of g.edges) {
      if (!e.drivable) continue;
      e.lanePaths.forEach((dirs, di) =>
        dirs.forEach((p, k) => {
          if (!e.laneClear[di]![k]) return;
          for (let s = 0; s <= p.len; s += 8) {
            const q = pathPoint(p, s);
            n++;
            if (boxBlocked(empty, { x: q.x, z: q.z, heading: Math.atan2(q.tx, -q.tz), hl: 2.3, hw: 1 }, 1e9)) blocked++;
          }
        }),
      );
    }
    expect(n).toBeGreaterThan(300_000);
    expect(blocked / n).toBeLessThan(1e-4);
  }, SF_RUN_MS);

  it("a car driven at the land edge at the southern city limit stops there instead of dropping off the world", () => {
    // The land runs of the southern city limit, east-west (the county line inside the last built
    // row, W-42, or that row's south edge): find a stretch with no building in the way, 50 m north of it.
    const edge = world.walls!.segments.filter((s) => s.kind === "land" && s.az === s.bz && s.az > 9600 && s.len >= 100);
    expect(edge.length).toBeGreaterThan(0);
    let tried = 0;
    for (const w of edge) {
      const z0 = w.az - 50;
      for (let t = 20; t < w.len - 20; t += 10) {
        const x = w.ax + w.ux * t;
        const start = makeCar(x, z0, Math.PI, groundHeight(world, x, z0));
        // Free run in the world without walls: the car would leave the tiles.
        let free = start;
        let clear = true;
        for (let i = 0; i < 300 && clear; i++) {
          free = stepCar(noWalls, free, FULL);
          if (free.hits > 0) clear = false;
        }
        if (!clear || free.z < w.az + 10) continue;
        tried++;
        const trace = drive(world, start, 600);
        for (const c of trace) {
          expect(overshoot(world, c), `x ${x.toFixed(0)}`).toBeLessThan(0.02);
          expect(c.z, "the car stays north of the city limit").toBeLessThan(w.az);
          expect(c.y, "the car stays on the ground of the last built row").toBeGreaterThan(groundHeight(world, c.x, w.az - 10) - 3);
        }
        const last = trace[trace.length - 1]!;
        expect(last.hits).toBeGreaterThan(0);
        expect(Math.abs(last.speed)).toBeLessThan(3);
        return;
      }
    }
    expect(tried, "no clear approach to the southern land edge found").toBeGreaterThan(0);
  }, SF_RUN_MS);

  it("a car driven at the Ocean Beach shoreline stops on the land side, above the sea", () => {
    // The long shore line on the Pacific side (x < -10000): back off 25 m inland along its normal and drive at it.
    const shore = world.walls!.segments.filter((s) => s.kind === "shore" && s.ax < -10200 && s.az > 4000 && s.az < 8000 && s.len > 3);
    expect(shore.length).toBeGreaterThan(20);
    let done = 0;
    for (const w of shore) {
      if (done >= 3) break;
      const mx = (w.ax + w.bx) / 2 + w.nx * 25;
      const mz = (w.az + w.bz) / 2 + w.nz * 25;
      const heading = Math.atan2(-w.nx, w.nz);
      const start = makeCar(mx, mz, heading, groundHeight(world, mx, mz));
      if (boxBlocked(world, carBox(start), start.y + 0.5)) continue;
      const free = drive(noWalls, start, 240);
      if (free.some((c) => c.hits > 0)) continue;
      done++;
      const trace = drive(world, start, 600);
      for (const c of trace) expect(overshoot(world, c)).toBeLessThan(0.05);
      const last = trace[trace.length - 1]!;
      expect(last.hits).toBeGreaterThan(0);
      // Without the wall the same run ends out on the water at sea level.
      expect(free[free.length - 1]!.y).toBeLessThan(0.5);
      expect(last.y).toBeGreaterThan(free[free.length - 1]!.y);
    }
    expect(done).toBeGreaterThan(0);
  }, SF_RUN_MS);

  /** A lane of the 3rd St bridge edge over Mission Creek. */
  function thirdStBridge(): Path {
    const g = world.roads!;
    const bridge = g.edges.find((e) => e.name === "3rd St" && files.roads!.edges.find((r) => r.id === e.id && (r as { bridge?: boolean }).bridge) && e.center.zs[0]! < 2200);
    expect(bridge, "3rd St has a bridge edge over Mission Creek").toBeDefined();
    return bridge!.lanePaths[0][0] ?? bridge!.lanePaths[1][0]!;
  }

  it("the 3rd St bridge over Mission Creek is still drivable: the shore wall has a gap for it", () => {
    const p = thirdStBridge();
    // Follow the lane from 40 m before the bridge edge's start to its end with a pure-pursuit driver.
    const q0 = pathPoint(p, 0);
    let c = makeCar(q0.x - q0.tx * 40, q0.z - q0.tz * 40, Math.atan2(q0.tx, -q0.tz), groundHeight(world, q0.x, q0.z));
    for (let t = 0; t < 1200; t++) {
      const s = Math.min(p.len, Math.max(0, (c.x - q0.x) * q0.tx + (c.z - q0.z) * q0.tz) + 12);
      const aim = pathPoint(p, s);
      const d = wrap(Math.atan2(aim.x - c.x, -(aim.z - c.z)) - c.heading);
      c = stepCar(world, c, { throttle: 0.5, steer: Math.max(-1, Math.min(1, d * 3)), brake: 0, actions: 0 });
      expect(adrift(c.x, c.z)).toBe(false);
      const end = pathPoint(p, p.len);
      if ((c.x - end.x) * (c.x - end.x) + (c.z - end.z) * (c.z - end.z) < 25) break;
    }
    const end = pathPoint(p, p.len);
    expect(Math.hypot(c.x - end.x, c.z - end.z), "the car reached the far end of the bridge").toBeLessThan(5);
    expect(c.hits).toBe(0);
  }, SF_RUN_MS);

  it("and cannot be driven off: a car steered hard off the deck stays on the road over the creek", () => {
    const p = thirdStBridge();
    // Start on the lane over the water, heading along it at 12 m/s.
    let wetS = -1;
    for (let s = 0; s <= p.len; s += 1) {
      const q = pathPoint(p, s);
      if (onWater(world.walls!.shore, q.x, q.z)) {
        wetS = s;
        break;
      }
    }
    expect(wetS, "the lane runs over the water").toBeGreaterThanOrEqual(0);
    const q = pathPoint(p, wetS + 4);
    for (const steer of [1, -1]) {
      const c0: CarState = { ...makeCar(q.x, q.z, Math.atan2(q.tx, -q.tz), 0), speed: 12 };
      const trace = drive(world, c0, 360, (t) => ({ ...FULL, throttle: 0.7, steer: t < 150 ? steer : -steer }));
      for (const c of trace) {
        expect(adrift(c.x, c.z), `(${c.x.toFixed(1)}, ${c.z.toFixed(1)})`).toBe(false);
        for (const [x, z] of corners(c)) expect(adrift(x, z), `corner (${x.toFixed(1)}, ${z.toFixed(1)})`).toBe(false);
      }
      expect(trace[trace.length - 1]!.hits, "it hit the kerb").toBeGreaterThan(0);
    }
  }, SF_RUN_MS);

  it("a car that is somehow on Mission Creek stays on it: the bank's wall never throws it ashore", () => {
    // The shore wall beside the creek at (345, 2015), land to the north.
    let best = world.walls!.segments[0]!;
    let bd = Infinity;
    for (const w of world.walls!.segments) {
      if (w.kind !== "shore" || w.len < 4) continue;
      const d = Math.hypot((w.ax + w.bx) / 2 - 342, (w.az + w.bz) / 2 - 2018);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    expect(bd).toBeLessThan(20);
    const mx = (best.ax + best.bx) / 2;
    const mz = (best.az + best.bz) / 2;
    const along = Math.atan2(best.ux, -best.uz);
    for (const clear of [0.05, 1, 2]) {
      for (const turn of [0, -0.5]) {
        // The nearest corner `clear` metres off the wall, on the water side.
        const back = clear + reach(turn);
        const px = mx - best.nx * back;
        const pz = mz - best.nz * back;
        expect(onWater(world.walls!.shore, px, pz)).toBe(true);
        const c0: CarState = { ...makeCar(px, pz, along + turn, groundHeight(world, px, pz)), speed: 15 };
        const trace = drive(world, c0, 900, (t) => ({ ...FULL, brake: t > 300 ? 1 : 0 }));
        for (const c of trace) {
          expect(onWater(world.walls!.shore, c.x, c.z), `clear ${clear} turn ${turn}: (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`).toBe(true);
          expect(c.y - groundHeight(world, c.x, c.z)).toBeLessThan(2);
          expect(c.vy).toBeLessThan(3);
        }
      }
    }
  }, SF_RUN_MS);

  it("seeded random drives along Mission Creek's banks never reach open water and never fly", () => {
    // Start 8 to 48 m inland of a shore wall beside the creek, aimed roughly at it, and wander for 20 s.
    const banks = world.walls!.segments.filter((w) => w.kind === "shore" && w.len > 2 && (w.ax + w.bx) / 2 > -300 && (w.ax + w.bx) / 2 < 700 && (w.az + w.bz) / 2 > 1900 && (w.az + w.bz) / 2 < 2500);
    expect(banks.length).toBeGreaterThan(50);
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    let drives = 0;
    let crossedOnBridge = 0;
    for (let n = 0; n < 400 && drives < 60; n++) {
      const w = banks[Math.floor(rnd() * banks.length)]!;
      const back = 8 + rnd() * 40;
      const sx = (w.ax + w.bx) / 2 + w.nx * back;
      const sz = (w.az + w.bz) / 2 + w.nz * back;
      const heading = Math.atan2(-w.nx, w.nz) + (rnd() - 0.5) * 2.4;
      const steer = (rnd() - 0.5) * 0.6;
      if (onWater(world.walls!.shore, sx, sz)) continue;
      const c0 = makeCar(sx, sz, heading, groundHeight(world, sx, sz));
      if (boxBlocked(world, carBox(c0), c0.y + 0.5)) continue;
      drives++;
      let c = c0;
      let wet = false;
      for (let t = 0; t < 1200; t++) {
        c = stepCar(world, c, { ...FULL, steer: t > 200 ? steer + Math.sin(t / 70) * 0.3 : 0 });
        expect(adrift(c.x, c.z), `drive from (${sx.toFixed(0)}, ${sz.toFixed(0)}) tick ${t}: (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`).toBe(false);
        expect(c.y - groundHeight(world, c.x, c.z), `drive from (${sx.toFixed(0)}, ${sz.toFixed(0)}) tick ${t}`).toBeLessThan(10);
        if (onWater(world.walls!.shore, c.x, c.z)) wet = true;
      }
      if (wet) crossedOnBridge++;
    }
    expect(drives).toBe(60);
    // Some of them found a bridge (or a pier road) and drove out over the water on it.
    expect(crossedOnBridge).toBeGreaterThan(0);
  }, SF_RUN_MS);
});
