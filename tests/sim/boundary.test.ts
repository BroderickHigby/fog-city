// The world's edge and shore walls (src/sim/boundary.ts): cars and walkers stop at them, from
// either approach, at any speed; roads that cross the shore get a gap; the outline never does.
// On the real city: the land edge at the southern city limit and the Ocean Beach shoreline stop
// a car driven straight at them, the spawn and the surface streets are clear of every wall,
// and the 3rd St bridge over Mission Creek can still be driven.
import { beforeAll, describe, expect, it } from "vitest";
import {
  Action,
  WALL_DEPTH_M,
  boxBlocked,
  buildWalls,
  buildWorld,
  carBox,
  circleHitsWall,
  createInitialState,
  dcos,
  dsin,
  groundHeight,
  makeCar,
  pathPoint,
  segmentCrossesWall,
  step,
  stepCar,
  wallSide,
  type BoundaryFile,
  type CarState,
  type RoadsFile,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { loadWorldFiles, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const FULL = { throttle: 1, steer: 0, brake: 0, actions: 0 };

/** Drive one car with constant input; the trace of every tick. */
function drive(world: World, c0: CarState, ticks: number, input = FULL): CarState[] {
  const out: CarState[] = [];
  let c = c0;
  for (let t = 0; t < ticks; t++) {
    c = stepCar(world, c, input);
    out.push(c);
  }
  return out;
}

/** The deepest any corner of the car's body reaches past the wall (+ = beyond it, on the water side). */
function overshoot(world: World, c: CarState): number {
  let worst = -Infinity;
  const b = carBox(c);
  const fx = dsin(b.heading);
  const fz = -dcos(b.heading);
  for (const [l, f] of [
    [b.hw, b.hl],
    [-b.hw, b.hl],
    [b.hw, -b.hl],
    [-b.hw, -b.hl],
  ] as const) {
    const x = b.x - fz * l + fx * f;
    const z = b.z + fx * l + fz * f;
    for (const w of world.walls!.segments) {
      const d = wallSide(w, x, z);
      if (d !== null && d > -WALL_DEPTH_M) worst = Math.max(worst, -d);
    }
  }
  return worst;
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

  it("builds one-sided segments whose normal points at the land", () => {
    expect(world.walls!.segments).toHaveLength(1);
    const w = world.walls!.segments[0]!;
    expect([w.nx, w.nz]).toEqual([0, -1]);
    expect(wallSide(w, 0, -5)).toBe(5);
    expect(wallSide(w, 0, 2)).toBe(-2);
    expect(wallSide(w, 300, -5)).toBeNull();
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
    const behind = makeCar(0, 2 + WALL_DEPTH_M + 3, 0);
    expect(boxBlocked(world, carBox(behind), 0)).toBe(false);
  });

  it("opens a gap where a surface road crosses the shore, never for a freeway, never in the outline", () => {
    const road = (id: string, x: number, gradeSeparated: boolean): RoadsFile["edges"][number] => ({
      id,
      a: `${id}a`,
      b: `${id}b`,
      kind: gradeSeparated ? "freeway" : "arterial",
      lanes: 4,
      oneway: false,
      widthM: 18,
      gradeSeparated,
      points: [
        [x, -60],
        [x, 60],
      ],
    });
    const roads: RoadsFile = {
      version: 1,
      nodes: ["s", "f"].flatMap((id, i) => [
        { id: `${id}a`, x: i * 100, z: -60 },
        { id: `${id}b`, x: i * 100, z: 60 },
      ]),
      edges: [road("s", 0, false), road("f", 100, true)],
    };
    const walls = buildWalls({ ...boundary, edges: [{ kind: "land", closed: false, points: [[-200, 10], [200, 10]] }] }, roads);
    expect(walls.gaps).toBe(1);
    // The shore is cut 9 m + the margin either side of x = 0; the freeway at x = 100 and the outline stay walled.
    const shore = walls.segments.filter((w) => w.kind === "shore");
    expect(shore).toHaveLength(2);
    expect(shore[0]!.bx).toBeCloseTo(-10.5, 9);
    expect(shore[1]!.ax).toBeCloseTo(10.5, 9);
    expect(walls.segments.filter((w) => w.kind === "land")).toHaveLength(1);
    // Driving south down the street goes through the shore gap (and stops at the outline).
    const gapWorld = buildWorld([flat], roads, { ...boundary, edges: [] });
    const trace = drive(gapWorld, makeCar(0, -40, Math.PI), 300);
    expect(trace[trace.length - 1]!.z).toBeGreaterThan(20);
    for (const c of trace) expect(c.hits).toBe(0);
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

  it("walls the land edge and the shore, with gaps only for surface roads", () => {
    const w = world.walls!;
    expect(w.segments.filter((s) => s.kind === "land").length).toBeGreaterThan(5);
    expect(w.segments.filter((s) => s.kind === "shore").length).toBeGreaterThan(1000);
    expect(w.gaps).toBeGreaterThanOrEqual(10);
    expect(w.gaps).toBeLessThan(60);
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
    // The land run along z = 10000 (the last built row): find a stretch with no building in the way.
    const edge = world.walls!.segments.filter((s) => s.kind === "land" && s.az === 10000 && s.bz === 10000 && s.len >= 200);
    expect(edge.length).toBeGreaterThan(0);
    let tried = 0;
    for (const w of edge) {
      for (let t = 20; t < w.len - 20; t += 10) {
        const x = w.ax + w.ux * t;
        const start = makeCar(x, 9950, Math.PI, groundHeight(world, x, 9950));
        // Free run in the world without walls: the car would leave the tiles.
        let free = start;
        let clear = true;
        for (let i = 0; i < 300 && clear; i++) {
          free = stepCar(noWalls, free, FULL);
          if (free.hits > 0) clear = false;
        }
        if (!clear || free.z < 10010) continue;
        tried++;
        const trace = drive(world, start, 600);
        for (const c of trace) {
          expect(overshoot(world, c), `x ${x.toFixed(0)}`).toBeLessThan(0.02);
          expect(c.y, "the car stays on the ground of the last built row").toBeGreaterThan(groundHeight(world, c.x, 9990) - 3);
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

  it("the 3rd St bridge over Mission Creek is still drivable: the shore wall has a gap for it", () => {
    const g = world.roads!;
    const bridge = g.edges.find((e) => e.name === "3rd St" && files.roads!.edges.find((r) => r.id === e.id && (r as { bridge?: boolean }).bridge));
    expect(bridge, "3rd St has a bridge edge").toBeDefined();
    const p = bridge!.lanePaths[0][0] ?? bridge!.lanePaths[1][0]!;
    // Follow the lane from 40 m before the bridge edge's start to its end with a pure-pursuit driver.
    const q0 = pathPoint(p, 0);
    let c = makeCar(q0.x - q0.tx * 40, q0.z - q0.tz * 40, Math.atan2(q0.tx, -q0.tz), groundHeight(world, q0.x, q0.z));
    for (let t = 0; t < 1200; t++) {
      const s = Math.min(p.len, Math.max(0, (c.x - q0.x) * q0.tx + (c.z - q0.z) * q0.tz) + 12);
      const aim = pathPoint(p, s);
      const want = Math.atan2(aim.x - c.x, -(aim.z - c.z));
      let d = want - c.heading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      c = stepCar(world, c, { throttle: 0.5, steer: Math.max(-1, Math.min(1, d * 3)), brake: 0, actions: 0 });
      const end = pathPoint(p, p.len);
      if ((c.x - end.x) * (c.x - end.x) + (c.z - end.z) * (c.z - end.z) < 25) break;
    }
    const end = pathPoint(p, p.len);
    expect(Math.hypot(c.x - end.x, c.z - end.z), "the car reached the far end of the bridge").toBeLessThan(5);
    expect(c.hits).toBe(0);
  }, SF_RUN_MS);
});
