// Gate suite E: the world's edge, the shore and the road network (docs/qa/world-continuity-gate.md,
// section E), with the real stepCar and stepFoot on the world as the game boots it, walls on.

import { toLocal } from "../../../src/geo/project.ts";
import {
  CAR,
  DT,
  buildWalls,
  buildWorld,
  cellKey,
  circleBlocked,
  circleHitsWall,
  groundHeight,
  inCorridor,
  makeCar,
  makeFoot,
  onWater,
  segmentCrossesWall,
  stepCar,
  stepFoot,
  wallsNear,
  type CarState,
  type FootState,
  type TileCollider,
  type Walls,
  type World,
} from "../../../src/sim/index.ts";
import { bearing, distToRing, distToSegment, drivePath, ll, r2, resample, wrap, type GameWorld, type P2, districtOf } from "../world.ts";
import { Measured } from "./measured.ts";

const isBuilt = (world: World, x: number, z: number): boolean => world.tileGround?.has(cellKey(Math.floor(x / 500), Math.floor(z / 500))) ?? false;

/** How far (x, z) lies out on the water side of the shore, metres (0 on land). */
export function waterDepth(walls: Walls, x: number, z: number): number {
  if (!onWater(walls.shore, x, z)) return 0;
  const s = walls.shore.segs;
  let best = Infinity;
  for (let r = 1; r <= 64 && best === Infinity; r *= 2) {
    const c0x = Math.floor(x / 50);
    const c0z = Math.floor(z / 50);
    for (let cx = c0x - r; cx <= c0x + r; cx++) {
      for (let cz = c0z - r; cz <= c0z + r; cz++) {
        for (const k of walls.shore.cells.get(cellKey(cx, cz)) ?? []) {
          const o = k * 10;
          best = Math.min(best, distToSegment(x, z, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!));
        }
      }
    }
  }
  return best === Infinity ? 3200 : best;
}

/** Distance outside every road corridor over water (0 inside one). */
function corridorGap(walls: Walls, x: number, z: number): number {
  if (inCorridor(walls, x, z)) return 0;
  let best = Infinity;
  for (const c of walls.corridors) {
    if (x < c.minX - 50 || x > c.maxX + 50 || z < c.minZ - 50 || z > c.maxZ + 50) continue;
    const ring: P2[] = [];
    for (let i = 0; i < c.ring.length; i += 2) ring.push([c.ring[i]!, c.ring[i + 1]!]);
    best = Math.min(best, distToRing(x, z, ring));
  }
  return best;
}

/** A wall step: did the move from a to b cross a real wall from its land side, within its reach? */
function crossedFromLand(walls: Walls, ax: number, az: number, bx: number, bz: number): boolean {
  if (!segmentCrossesWall(walls, ax, az, bx, bz)) return false;
  for (const k of wallsNear(walls, (ax + bx) / 2, (az + bz) / 2, Math.hypot(bx - ax, bz - az) / 2 + 1)) {
    const w = walls.segments[k]!;
    const da = (ax - w.ax) * w.nx + (az - w.az) * w.nz;
    const db = (bx - w.ax) * w.nx + (bz - w.az) * w.nz;
    if (da >= 0 && db < 0) {
      const t = da / (da - db);
      const al = (ax + (bx - ax) * t - w.ax) * w.ux + (az + (bz - az) * t - w.az) * w.uz;
      if (al >= -w.reachA && al <= w.len + w.reachB) return true;
    }
  }
  return false;
}

/** Ram starts: every wall every `every` m along the wall list, 12 m on the land side, on dry, clear land. */
export function rammingStarts(gw: GameWorld, every = 100): Array<{ sx: number; sz: number; nx: number; nz: number; ux: number; uz: number; at: string }> {
  const W = gw.world.walls!;
  const out: Array<{ sx: number; sz: number; nx: number; nz: number; ux: number; uz: number; at: string }> = [];
  let acc = 0;
  for (const w of W.segments) {
    for (let s = acc % every; s < w.len; s += every) {
      const px = w.ax + w.ux * s;
      const pz = w.az + w.uz * s;
      const sx = px + w.nx * 12;
      const sz = pz + w.nz * 12;
      if (groundHeight(gw.world, sx, sz) <= 0.1) continue;
      if (circleBlocked(gw.world, sx, sz, 3) || circleHitsWall(W, sx, sz, 3)) continue;
      out.push({ sx, sz, nx: w.nx, nz: w.nz, ux: w.ux, uz: w.uz, at: ll(px, pz) });
    }
    acc += w.len;
  }
  return out;
}

/** Ram a wall from a start: a car at 30 m/s at 0/+-30/+-60 degrees and a sprinting walker at 0/+-45. Escapes = crossed a real wall or left the built tiles. */
export function ramWalls(gw: GameWorld, starts: ReturnType<typeof rammingStarts>, walkerTicks = 900): { tests: number; escapes: string[] } {
  const world = gw.world;
  const W = world.walls!;
  let tests = 0;
  const escapes: string[] = [];
  for (const s of starts) {
    for (const [car, deg] of [[true, 0], [true, 30], [true, -30], [true, 60], [true, -60], [false, 0], [false, 45], [false, -45]] as const) {
      const a = (deg * Math.PI) / 180;
      const dx = -s.nx * Math.cos(a) + s.ux * Math.sin(a);
      const dz = -s.nz * Math.cos(a) + s.uz * Math.sin(a);
      const h = bearing(dx, dz);
      let escaped = false;
      if (car) {
        let c: CarState = { ...makeCar(s.sx, s.sz, h, groundHeight(world, s.sx, s.sz)), speed: 30 };
        for (let t = 0; t < 240 && !escaped; t++) {
          const p = c;
          c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
          if (crossedFromLand(W, p.x, p.z, c.x, c.z)) escaped = true;
        }
        if (!isBuilt(world, c.x, c.z)) escaped = true;
      } else {
        let f: FootState = makeFoot(s.sx, groundHeight(world, s.sx, s.sz), s.sz, h);
        for (let t = 0; t < walkerTicks && !escaped; t++) {
          const p = f;
          f = stepFoot(world, f, { throttle: 1, steer: 0, brake: 1, actions: 0 }, [], []);
          if (crossedFromLand(W, p.x, p.z, f.x, f.z)) escaped = true;
        }
        if (!isBuilt(world, f.x, f.z)) escaped = true;
      }
      tests++;
      if (escaped) escapes.push(`${car ? "car" : "walker"} ${deg} deg at ${s.at}`);
    }
  }
  return { tests, escapes };
}

/**
 * Wall launch (W-06): a car on the water side of the shore, 2.5 m and 6 m out, driven at the wall
 * at 5, 15 and 30 m/s for 3 s. A launch rises over 1 m above the ground or moves more than
 * speed * DT + 0.5 m in one tick.
 */
export function wallLaunch(gw: GameWorld, every: number, maxStarts: number): { runs: number; launches: string[]; maxRiseM: number; maxExcessM: number } {
  const world = gw.world;
  const W = world.walls!;
  const shore = W.segments.filter((w) => w.kind === "shore");
  const starts: Array<{ x: number; z: number; nx: number; nz: number }> = [];
  let acc = 0;
  for (const w of shore) {
    for (let s = acc % every; s < w.len; s += every) starts.push({ x: w.ax + w.ux * s, z: w.az + w.uz * s, nx: w.nx, nz: w.nz });
    acc += w.len;
  }
  const step = Math.max(1, Math.ceil(starts.length / maxStarts));
  let runs = 0;
  let maxRise = 0;
  let maxExcess = 0;
  const launches: string[] = [];
  for (let i = 0; i < starts.length; i += step) {
    const s = starts[i]!;
    for (const d of [2.5, 6]) {
      const sx = s.x - s.nx * d;
      const sz = s.z - s.nz * d;
      if (!onWater(W.shore, sx, sz)) continue;
      for (const v of [5, 15, 30]) {
        let c: CarState = { ...makeCar(sx, sz, bearing(s.nx, s.nz), groundHeight(world, sx, sz)), speed: v };
        let rise = 0;
        let excess = 0;
        for (let t = 0; t < 180; t++) {
          const p = c;
          c = stepCar(world, c, { throttle: c.speed < v ? 1 : 0, steer: 0, brake: 0, actions: 0 });
          rise = Math.max(rise, c.y - groundHeight(world, c.x, c.z));
          excess = Math.max(excess, Math.hypot(c.x - p.x, c.z - p.z) - Math.max(Math.abs(p.speed), Math.abs(c.speed)) * DT);
        }
        runs++;
        maxRise = Math.max(maxRise, rise);
        maxExcess = Math.max(maxExcess, excess);
        if (rise > 1 || excess > 0.5) launches.push(`${ll(s.x, s.z)} ${d} m out at ${v} m/s: up ${r2(rise)} m, tick ${r2(excess)} m over`);
      }
    }
  }
  return { runs, launches, maxRiseM: maxRise, maxExcessM: maxExcess };
}

/** A synthetic world: one 500 m tile, ground from f(x, z) on a `cell` m lattice, and optional buildings. */
export function synthWorld(height: (x: number, z: number) => number, buildings: TileCollider["buildings"] = [], cell = 10): World {
  const n = 500 / cell + 1;
  const heights: number[] = [];
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) heights.push(height(i * cell, k * cell));
  return buildWorld([{ tileId: "t0_0", ground: { x0: 0, z0: 0, cellSizeM: cell, nx: n, nz: n, heights }, buildings }]);
}

/**
 * The push unit (W-06, W-23, W-51): a car pushed sideways out of a building onto a 3 m bank, a car
 * placed overlapping a footprint on a slope, and a car scraping along a wall on a cross slope. No
 * tick's upward speed may exceed |v| * (grade along its travel) + 1 m/s.
 */
export function pushLift(): { worst: number; cases: Record<string, number> } {
  const cases: Record<string, number> = {};
  // A 3 m bank rising east over 10 m between x = 250 and 260; flat elsewhere.
  const bank = (x: number): number => (x <= 250 ? 0 : x >= 260 ? 3 : (3 * (x - 250)) / 10);
  const wall: TileCollider["buildings"][number] = { id: "w", footprint: [[230, 100], [247.5, 100], [247.5, 400], [230, 400]], baseY: 0, topY: 20 };
  const run = (name: string, world: World, car: CarState, input = { throttle: 1, steer: 0, brake: 0, actions: 0 }, ticks = 120): void => {
    let c = car;
    let worst = 0;
    for (let t = 0; t < ticks; t++) {
      const p = c;
      c = stepCar(world, c, input);
      const vx = c.x - p.x;
      const vz = c.z - p.z;
      const along = Math.hypot(vx, vz);
      const rise = along > 1e-6 ? Math.max(0, (groundHeight(world, c.x, c.z) - groundHeight(world, p.x, p.z)) / along) : 0;
      const allowed = (along / DT) * rise + 1;
      worst = Math.max(worst, c.vy - allowed);
    }
    cases[name] = r2(Math.max(0, worst));
  };
  {
    // Placed half inside the building, at the bank's foot, facing north: the push is east, up the bank.
    const w = synthWorld((x) => bank(x), [wall]);
    run("pushed out of a building onto a bank", w, { ...makeCar(247.6, 250, 0, 0), speed: 10 });
    run("placed overlapping a building on a slope", w, { ...makeCar(246.5, 250, 0.3, 0), speed: 0 });
  }
  {
    // Steer into the building while driving north along it on the cross slope.
    const w = synthWorld((x) => bank(x), [wall]);
    run("scraping a wall on a cross slope", w, { ...makeCar(249.5, 380, Math.PI, 0), speed: 20 }, { throttle: 1, steer: 0.6, brake: 0, actions: 0 });
  }
  return { worst: Math.max(...Object.values(cases)), cases };
}

/** The longest chain of edges with this name, following a -> b (one-way freeway carriageways). */
export function chain(gw: GameWorld, name: RegExp): P2[] {
  const es = gw.roads.edges.filter((e) => name.test(e.name ?? ""));
  const byA = new Map<string, (typeof es)[number][]>();
  for (const e of es) {
    const l = byA.get(e.a) ?? [];
    l.push(e);
    byA.set(e.a, l);
  }
  const memo = new Map<string, { len: number; path: (typeof es)[number][] }>();
  const best = (node: string, seen: Set<string>): { len: number; path: (typeof es)[number][] } => {
    const hit = memo.get(node);
    if (hit) return hit;
    let out = { len: 0, path: [] as (typeof es)[number][] };
    for (const e of [...(byA.get(node) ?? [])].sort((p, q) => (p.id < q.id ? -1 : 1))) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const rest = best(e.b, seen);
      seen.delete(e.id);
      const L = resample(e.points, 5).length * 5 + rest.len;
      if (L > out.len) out = { len: L, path: [e, ...rest.path] };
    }
    memo.set(node, out);
    return out;
  };
  let top = { len: 0, path: [] as (typeof es)[number][] };
  for (const e of [...es].sort((p, q) => (p.id < q.id ? -1 : 1))) {
    const r = best(e.a, new Set());
    if (r.len > top.len) top = r;
  }
  const pts: P2[] = [];
  for (const e of top.path) for (const p of resample(e.points, 1)) if (!pts.length || Math.hypot(pts[pts.length - 1]![0] - p[0], pts[pts.length - 1]![1] - p[1]) > 0.5) pts.push(p);
  return pts;
}

export function measureEdge(gw: GameWorld): Measured {
  const m = new Measured("edge", "pr");
  const world = gw.world;
  const W = world.walls!;

  // ---- the world edge holds (W-08, fixed): a fixed sample of 100 wall starts
  {
    const all = rammingStarts(gw, 100);
    const step = Math.max(1, Math.ceil(all.length / 100));
    const sample = all.filter((_, i) => i % step === 0);
    const r = ramWalls(gw, sample, 600);
    m.metric({ id: "E.walls.sampleEscapes", target: 0, better: "lower", unit: "ram tests", defects: ["W-08"], desc: `ram tests (car at 30 m/s at 0/+-30/+-60 deg, sprinting walker at 0/+-45 deg) from a fixed sample of ${sample.length} wall starts that cross a real wall or leave the built tiles` }, r.escapes.length, r.escapes.slice(0, 10));
  }
  m.lap("walls");

  // ---- roads over water (W-21): cars turning off each corridor, walkers too
  {
    let runs = 0;
    let out = 0;
    let maxOut = 0;
    let walkerOut = 0;
    const worst: string[] = [];
    for (const c of W.corridors) {
      const e = gw.edges.get(c.edgeId);
      if (!e) continue;
      const pts = resample(e.points, 1);
      const inIdx = pts.findIndex(([x, z]) => inCorridor(W, x, z));
      if (inIdx < 0) continue;
      for (const dir of [1, -1] as const) {
        const path = dir > 0 ? pts : [...pts].reverse();
        const k = dir > 0 ? inIdx : path.findIndex(([x, z]) => inCorridor(W, x, z));
        const i0 = k - 25;
        if (i0 < 0 || waterDepth(W, path[i0]![0], path[i0]![1]) > 0) continue;
        const h0 = bearing(path[i0 + 3]![0] - path[i0]![0], path[i0 + 3]![1] - path[i0]![1]);
        for (const v of [10, 25]) {
          for (const turn of [30, 60, 90, -30, -60, -90]) {
            let car: CarState = { ...makeCar(path[i0]![0], path[i0]![1], h0, groundHeight(world, path[i0]![0], path[i0]![1])), speed: v };
            let phase = 0;
            let worstGap = 0;
            let target = 0;
            for (let t = 0; t < 60 * 12; t++) {
              let input;
              if (phase === 0) {
                let pi = 0;
                let pd = Infinity;
                for (let j = i0; j < Math.min(path.length, i0 + 80); j++) {
                  const d = (path[j]![0] - car.x) ** 2 + (path[j]![1] - car.z) ** 2;
                  if (d < pd) {
                    pd = d;
                    pi = j;
                  }
                }
                const a = path[pi]!;
                const b = path[Math.min(path.length - 1, pi + 2)]!;
                input = { throttle: car.speed < v ? 1 : 0, steer: Math.max(-1, Math.min(1, wrap(bearing(b[0] - a[0], b[1] - a[1]) - car.heading) / 0.3)), brake: 0, actions: 0 };
                if (pi >= k + 8 || pi >= path.length - 3) {
                  phase = 1;
                  target = car.heading + (turn * Math.PI) / 180;
                }
              } else {
                input = { throttle: 1, steer: Math.max(-1, Math.min(1, wrap(target - car.heading) / 0.3)), brake: 0, actions: 0 };
              }
              car = stepCar(world, car, input);
              if (waterDepth(W, car.x, car.z) > 3 || corridorGap(W, car.x, car.z) > 1) {
                if (waterDepth(W, car.x, car.z) > 0) worstGap = Math.max(worstGap, Math.min(waterDepth(W, car.x, car.z), corridorGap(W, car.x, car.z)));
              }
            }
            runs++;
            maxOut = Math.max(maxOut, worstGap);
            if (worstGap > 1) {
              out++;
              if (worst.length < 12) worst.push(`${e.id} ${e.name} dir ${dir} ${v} m/s turn ${turn}: ${r2(worstGap)} m out`);
            }
          }
        }
        // A sprinting walker along the road, turning 90 degrees each way on the corridor.
        for (const turn of [1, -1]) {
          let f: FootState = makeFoot(path[i0]![0], groundHeight(world, path[i0]![0], path[i0]![1]), path[i0]![1], h0);
          let worstGap = 0;
          for (let t = 0; t < 60 * 30; t++) {
            const along = Math.hypot(f.x - path[i0]![0], f.z - path[i0]![1]);
            const steer = along > 33 && t < 60 * 30 ? turn * 0.6 : 0;
            f = stepFoot(world, f, { throttle: 1, steer, brake: 1, actions: 0 }, [], []);
            const wd = waterDepth(W, f.x, f.z);
            if (wd > 0) worstGap = Math.max(worstGap, Math.min(wd, corridorGap(W, f.x, f.z)));
          }
          if (worstGap > 1) walkerOut++;
        }
      }
    }
    m.metric({ id: "E.gaps.carRunsOffCorridor", target: 0, better: "lower", unit: "runs", defects: ["W-21"], desc: "car runs (10 and 25 m/s, turning 30/60/90 deg either way on each road over water) that get more than 1 m outside the road's corridor on the water side" }, out, { runs, worst });
    m.metric({ id: "E.gaps.maxOutOnWaterM", target: 1, better: "lower", unit: "m", defects: ["W-21"], desc: "the farthest those cars get outside the corridor on the water side" }, r2(maxOut));
    m.metric({ id: "E.gaps.walkerRunsOffCorridor", target: 0, better: "lower", unit: "runs", defects: ["W-21"], desc: "sprinting walkers turning off a road over water who get more than 1 m outside its corridor on the water side" }, walkerOut);
  }
  m.lap("gaps");

  // ---- the water side of the shore never launches a car (W-06)
  {
    const r = wallLaunch(gw, 50, 200);
    m.metric({ id: "E.launch.sampleLaunches", target: 0, better: "lower", unit: "runs", defects: ["W-06"], desc: "of cars driven at the shore wall from 2.5 and 6 m out on the water at 5/15/30 m/s (a fixed sample of 200 shore points), runs that rise over 1 m or jump more than speed*DT + 0.5 m in a tick" }, r.launches.length, { runs: r.runs, first: r.launches.slice(0, 10) });
    m.metric({ id: "E.launch.maxRiseM", target: 1, better: "lower", unit: "m", defects: ["W-06"], desc: "the highest any of those cars rose above the ground" }, r2(r.maxRiseM));
  }
  m.lap("launch");
  {
    const r = pushLift();
    m.metric({ id: "E.push.excessLiftMps", target: 0, better: "lower", unit: "m/s", defects: ["W-06", "W-23", "W-51"], desc: "unit: the most a car pushed out of a building onto a 3 m bank, placed overlapping a footprint, or scraping a wall on a cross slope rises faster than |v| * grade + 1 m/s" }, r.worst, r.cases);
  }

  // ---- freeways at the shore (W-07)
  {
    const crossing: string[] = [];
    for (const e of gw.roads.edges) {
      if (!e.gradeSeparated) continue;
      // A freeway that runs out over open water (the Bay Bridge, more than 300 m of it) stays walled
      // until its deck exists; one that crosses a creek (I-280 over Mission and Islais Creeks) must not.
      if (resample(e.points, 5).filter(([x, z]) => onWater(W.shore, x, z)).length * 5 > 300) continue;
      const a = e.points[0]!;
      const b = e.points[e.points.length - 1]!;
      const land = (x: number, z: number): boolean => !onWater(W.shore, x, z) && groundHeight(world, x, z) > 0.1;
      if (!land(a[0]!, a[1]!) || !land(b[0]!, b[1]!)) continue;
      for (let i = 1; i < e.points.length; i++) {
        if (segmentCrossesWall(W, e.points[i - 1]![0]!, e.points[i - 1]![1]!, e.points[i]![0]!, e.points[i]![1]!)) {
          crossing.push(e.id);
          break;
        }
      }
    }
    m.metric({ id: "E.freeway.landEdgesCrossingWalls", target: 0, better: "lower", unit: "edges", defects: ["W-07"], desc: "freeway (gradeSeparated) edges with both ends on land, crossing no more than 300 m of water, whose centreline crosses a wall (I-280 at the creeks)" }, crossing.length, crossing);
    const stops: string[] = [];
    for (const [name, re] of [["I-280 Northbound", /^I-280 Northbound$/], ["I-280 Southbound", /^I-280 Southbound$/]] as const) {
      const path = chain(gw, re);
      const r = drivePath(world, path, { vmax: 25, startSpeed: 20 });
      if (!r.reached) stops.push(`${name}: stopped at ${r.stuckAt ? ll(r.stuckAt[0], r.stuckAt[1]) : "?"} after ${r.progressM} of ${r.lenM} m`);
    }
    m.metric({ id: "E.freeway.i280Stops", target: 0, better: "lower", unit: "drives", defects: ["W-07", "W-03"], desc: "of I-280 northbound and southbound driven end to end at 25 m/s, drives that stop before the end" }, stops.length, stops);
  }
  m.lap("freeway");

  // ---- the network (W-42, pass checks)
  {
    const edges = gw.roads.edges.filter((e) => !e.pedestrian && !e.gradeSeparated && e.kind !== "ramp");
    const nodes = new Map(gw.roads.nodes.map((n) => [n.id, n]));
    const mainland = (id: string): boolean => {
      const n = nodes.get(id)!;
      return districtOf(gw, n.x, n.z) !== "Treasure Island";
    };
    // Weak components of the mainland drivable graph.
    const adj = new Map<string, string[]>();
    const out = new Map<string, string[]>();
    for (const e of edges) {
      if (!mainland(e.a) || !mainland(e.b)) continue;
      for (const [p, q] of [[e.a, e.b], [e.b, e.a]] as const) {
        const l = adj.get(p) ?? [];
        l.push(q);
        adj.set(p, l);
      }
      const l = out.get(e.a) ?? [];
      l.push(e.b);
      out.set(e.a, l);
      if (!e.oneway) {
        const r = out.get(e.b) ?? [];
        r.push(e.a);
        out.set(e.b, r);
      }
    }
    const ids = [...adj.keys()].sort();
    const seen = new Set<string>();
    let largest = 0;
    for (const s of ids) {
      if (seen.has(s)) continue;
      let n = 0;
      const st = [s];
      seen.add(s);
      while (st.length) {
        const u = st.pop()!;
        n++;
        for (const v of adj.get(u) ?? []) if (!seen.has(v)) {
          seen.add(v);
          st.push(v);
        }
      }
      largest = Math.max(largest, n);
    }
    m.metric({ id: "E.net.mainlandLargestShare", target: 0.97, better: "higher", unit: "share of nodes", defects: [], desc: "share of the mainland's drivable street nodes (freeways, ramps and paths left out) in its largest connected piece" }, Math.floor((largest / Math.max(1, ids.length)) * 1000) / 1000);
    // Directed reach from the spawn, per district.
    const sp = gw.manifest.spawn;
    let start = ids[0]!;
    let bd = Infinity;
    for (const id of ids) {
      const n = nodes.get(id)!;
      const d = Math.hypot(n.x - sp.x, n.z - sp.z);
      if (d < bd) {
        bd = d;
        start = id;
      }
    }
    const reach = new Set([start]);
    const st = [start];
    while (st.length) for (const v of out.get(st.pop()!) ?? []) if (!reach.has(v)) {
      reach.add(v);
      st.push(v);
    }
    const per = new Map<string, [number, number]>();
    for (const id of ids) {
      const n = nodes.get(id)!;
      const d = districtOf(gw, n.x, n.z);
      const c = per.get(d) ?? [0, 0];
      c[0]++;
      if (reach.has(id)) c[1]++;
      per.set(d, c);
    }
    let minShare = 1;
    let minAt = "";
    for (const [d, [n, r]] of per) if (d !== "(none)" && n >= 20 && r / n < minShare) {
      minShare = r / n;
      minAt = d;
    }
    m.metric({ id: "E.net.districtMinReach", target: 0.95, better: "higher", unit: "share of nodes", defects: [], desc: "the lowest share, over mainland districts, of a district's street nodes a car can reach from the spawn (one-way streets obeyed)" }, Math.floor(minShare * 1000) / 1000, minAt);
    // Dead ends at tile seams.
    const deg = new Map<string, number>();
    for (const e of gw.roads.edges) for (const id of [e.a, e.b]) deg.set(id, (deg.get(id) ?? 0) + 1);
    let seamDeadEnds = 0;
    for (const [id, d] of deg) {
      if (d !== 1) continue;
      const n = nodes.get(id)!;
      const onSeam = (v: number): boolean => Math.abs(v - Math.round(v / 500) * 500) < 0.01;
      if ((onSeam(n.x) || onSeam(n.z)) && isBuilt(world, n.x + 1, n.z + 1) && isBuilt(world, n.x - 1, n.z - 1)) seamDeadEnds++;
    }
    m.metric({ id: "E.net.seamDeadEnds", target: 0, better: "lower", unit: "nodes", defects: [], desc: "road ends that stop exactly on a tile seam between two built tiles (a road cut by the tiling)" }, seamDeadEnds);
    // boundary.json covers the built outline exactly once.
    const B = buildWalls(gw.boundary, null);
    const outline: P2[] = [];
    for (const t of gw.tiles) {
      const g = t.ground;
      if (!g) continue;
      const ix = g.x0 / 500;
      const iz = g.z0 / 500;
      for (const [dx, dz, ax, az, bx, bz] of [[0, -1, 0, 0, 500, 0], [0, 1, 0, 500, 500, 500], [-1, 0, 0, 0, 0, 500], [1, 0, 500, 0, 500, 500]] as const) {
        if (world.tileGround?.has(cellKey(ix + dx, iz + dz))) continue;
        for (let s = 5; s < 500; s += 10) outline.push([g.x0 + ax + ((bx - ax) * s) / 500, g.z0 + az + ((bz - az) * s) / 500]);
      }
    }
    let badCover = 0;
    for (const [x, z] of outline) {
      let n = 0;
      for (const k of wallsNear(B, x, z, 1)) {
        const w = B.segments[k]!;
        if ((w.kind === "land" || w.kind === "water") && distToSegment(x, z, w.ax, w.az, w.bx, w.bz) < 0.5) n++;
      }
      if (n !== 1) badCover++;
    }
    m.metric({ id: "E.net.outlineCoverFails", target: 0, better: "lower", unit: "10 m pieces", defects: [], desc: "10 m pieces of the built tiles' outline that boundary.json's edge runs cover other than exactly once" }, badCover, { pieces: outline.length });
    // Buildings with no drivable street within 150 m (the Daly City strip), unless their tile is listed as scenery.
    const scenery = new Set(((gw.manifest as { sceneryOnly?: string[] }).sceneryOnly ?? []).map(String));
    const streetCells = new Set<number>();
    for (const e of gw.roads.edges) {
      if (e.pedestrian) continue;
      for (const [x, z] of resample(e.points, 20)) streetCells.add(cellKey(Math.floor(x / 50), Math.floor(z / 50)));
    }
    let far = 0;
    const byTile = new Map<string, number>();
    for (const t of gw.tiles) {
      if (scenery.has(t.tileId)) continue;
      for (const b of t.buildings) {
        if (b.id.endsWith("-tower")) continue;
        let [cx, cz] = [0, 0];
        for (const [x, z] of b.footprint) {
          cx += x / b.footprint.length;
          cz += z / b.footprint.length;
        }
        const gx = Math.floor(cx / 50);
        const gz = Math.floor(cz / 50);
        let near = false;
        for (let dx = -3; dx <= 3 && !near; dx++) for (let dz = -3; dz <= 3 && !near; dz++) if (streetCells.has(cellKey(gx + dx, gz + dz))) near = true;
        if (near) continue;
        far++;
        byTile.set(t.tileId, (byTile.get(t.tileId) ?? 0) + 1);
      }
    }
    m.metric({ id: "E.net.buildingsWithoutStreet", target: 0, better: "lower", unit: "buildings", defects: ["W-42"], desc: "buildings with no drivable street within about 150 m (the Daly City strip south of the county line), unless their tile is listed as scenery-only (manifest.sceneryOnly)" }, far, Object.fromEntries([...byTile].sort((a, b) => b[1] - a[1]).slice(0, 15)));
  }
  return m;
}

export { toLocal };
