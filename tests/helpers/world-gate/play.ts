// Gate suite F: play continuity, by car and on foot (docs/qa/world-continuity-gate.md, section F).
// Every drive and walk uses the real stepCar, stepFoot or step() on the world as the game boots it,
// walls on.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal } from "../../../src/geo/project.ts";
import {
  CAR,
  DT,
  agentsOf,
  boxBlocked,
  buildWorld,
  createInitialState,
  groundHeight,
  hashState,
  makeCar,
  makeFoot,
  nearbyBuildings,
  pointInPolygon,
  sampleGround,
  step,
  stepCar,
  stepFoot,
  type CarState,
  type FootState,
  type SimState,
  type World,
} from "../../../src/sim/index.ts";
import { ROOT } from "../../helpers.ts";
import {
  DriveTrack,
  advanceIndex,
  bearing,
  centroid,
  clearStart,
  drivePath,
  followInput,
  ll,
  r2,
  r3,
  resample,
  surfaceAt,
  walkPath,
  type GameWorld,
  type P2,
  type RoadEdge,
} from "../world.ts";
import { CREEK_BRIDGES, STAIRWAYS, TUNNELS, bridgePath, stairEdges, tunnelEdges } from "./streets.ts";
import { blockPath } from "./terrain.ts";
import { synthWorld } from "./edge.ts";
import { Measured } from "./suite.ts";

const FIX = join(ROOT, "tests/helpers/world-gate/fixtures");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;
const isFwy = (e: RoadEdge): boolean => e.gradeSeparated === true || e.kind === "freeway" || e.kind === "ramp";

/** The critic's named street list (W-01, W-02, W-43, W-12, W-14): edges whose outcome the gate pins. */
export const NAMED_EDGES: readonly string[] = [
  "c105000", "c7038000", "c7752000", "c7759000", "c7751000", "c8776102", "c8776203", "c2757000", "c5152000", "c5153000",
  "c7026000", "c4495000", "c4496000", "c19523000", "c19524000", "c13686101", "c13686201", "c15354000", "c3186101", "c3186201",
  "c12225000", "c19939000", "c8448000", "c8449000", "c182000", "c183000", "c270002", "c271000", "c197101", "c197201",
  "c15166000", "c11011002", "c12770000", "c5491000", "c13216002",
];

/** Drive one edge in one direction the way the critic's c2 harness does: posted speed up to 20 m/s, a clear start up to 20 m in. */
export function driveEdge(world: World, e: RoadEdge, dir: 1 | -1): { key: string; ok: boolean; startBlocked: boolean; r: ReturnType<typeof drivePath> | null } {
  const key = `${e.id}:${dir > 0 ? "+" : "-"}`;
  const pts = resample(e.points, 1);
  if (pts.length < 12) return { key, ok: true, startBlocked: false, r: null };
  const path = clearStart(world, dir > 0 ? pts : [...pts].reverse());
  if (!path) return { key, ok: false, startBlocked: true, r: null };
  const vmax = Math.min(20, e.speedLimitMps ?? 11.2);
  const r = drivePath(world, path, { vmax, startSpeed: Math.min(vmax, 8) });
  return { key, ok: r.reached, startBlocked: false, r };
}

/** The critic's seeded 300-edge sample of the surface streets (every k-th edge by id). */
export function sampleEdges(gw: GameWorld, n = 300): RoadEdge[] {
  const es = (gw.roads.edges as RoadEdge[]).filter((e) => !e.pedestrian && !isFwy(e)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const k = Math.ceil(es.length / n);
  return es.filter((_, i) => i % k === 0);
}

/** Shortest drivable route (surface streets, either direction) through the waypoints, as 1 m samples. */
export function route(gw: GameWorld, waypoints: ReadonlyArray<readonly [number, number]>): P2[] {
  const edges = (gw.roads.edges as RoadEdge[]).filter((e) => !e.pedestrian && !isFwy(e));
  const adj = new Map<string, Array<{ to: string; e: RoadEdge; fwd: boolean; len: number }>>();
  for (const e of edges) {
    let len = 0;
    for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i]![0]! - e.points[i - 1]![0]!, e.points[i]![1]! - e.points[i - 1]![1]!);
    for (const [a, b, fwd] of [[e.a, e.b, true], [e.b, e.a, false]] as const) {
      const l = adj.get(a) ?? [];
      l.push({ to: b, e, fwd, len });
      adj.set(a, l);
    }
  }
  const nodes = new Map(gw.roads.nodes.map((n) => [n.id, n]));
  // Waypoints snap to the largest connected piece of the street graph (never to an island).
  const comp = new Map<string, number>();
  let biggest = -1;
  let biggestN = 0;
  for (const s0 of [...adj.keys()].sort()) {
    if (comp.has(s0)) continue;
    const c = comp.size;
    let n = 0;
    const st = [s0];
    comp.set(s0, c);
    while (st.length) {
      const u = st.pop()!;
      n++;
      for (const q of adj.get(u) ?? []) if (!comp.has(q.to)) {
        comp.set(q.to, c);
        st.push(q.to);
      }
    }
    if (n > biggestN) {
      biggestN = n;
      biggest = c;
    }
  }
  const nearest = (lat: number, lon: number): string => {
    const p = toLocal(lat, lon);
    let best = "";
    let bd = Infinity;
    for (const id of [...adj.keys()].sort()) {
      if (comp.get(id) !== biggest) continue;
      const n = nodes.get(id)!;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };
  const pts: P2[] = [];
  const ids = waypoints.map(([la, lo]) => nearest(la, lo));
  for (let w = 1; w < ids.length; w++) {
    const from = ids[w - 1]!;
    const to = ids[w]!;
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { node: string; e: RoadEdge; fwd: boolean }>();
    const done = new Set<string>();
    const open = [from];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]!)! < dist.get(open[bi]!)! || (dist.get(open[i]!) === dist.get(open[bi]!) && open[i]! < open[bi]!)) bi = i;
      const u = open.splice(bi, 1)[0]!;
      if (done.has(u)) continue;
      done.add(u);
      if (u === to) break;
      for (const s of adj.get(u) ?? []) {
        const d = dist.get(u)! + s.len;
        if (d < (dist.get(s.to) ?? Infinity)) {
          dist.set(s.to, d);
          prev.set(s.to, { node: u, e: s.e, fwd: s.fwd });
          open.push(s.to);
        }
      }
    }
    const legs: Array<{ e: RoadEdge; fwd: boolean }> = [];
    for (let n = to; n !== from; ) {
      const p = prev.get(n);
      if (!p) throw new Error(`no route from ${from} to ${to}`);
      legs.unshift({ e: p.e, fwd: p.fwd });
      n = p.node;
    }
    for (const leg of legs) {
      const r = resample(leg.e.points, 1);
      for (const q of leg.fwd ? r : r.reverse()) if (!pts.length || Math.hypot(pts[pts.length - 1]![0] - q[0], pts[pts.length - 1]![1] - q[1]) > 0.5) pts.push(q);
    }
  }
  return pts;
}

/** The gate's closed-loop hill routes (waypoints, lat/lon). */
export const HILL_ROUTES: ReadonlyArray<{ name: string; via: Array<[number, number]> }> = [
  { name: "Ferry Building, Filbert up, Lombard down", via: [[37.7955, -122.3937], [37.80015, -122.41745], [37.80033, -122.41908], [37.80213, -122.41878], [37.80196, -122.4172]] },
  { name: "California St over Nob Hill", via: [[37.7926, -122.40425], [37.7915, -122.411], [37.7905, -122.42]] },
  { name: "Market St, Castro, Twin Peaks summit", via: [[37.7625, -122.4351], [37.7544, -122.4477]] },
  { name: "22nd St up from Church", via: [[37.7552, -122.428], [37.7546, -122.4347]] },
  { name: "Fillmore down to the Marina", via: [[37.7952, -122.434], [37.7996, -122.4355], [37.805, -122.4365]] },
  { name: "Potrero Hill via Vermont St", via: [[37.7598, -122.4041], [37.7553, -122.4036]] },
  { name: "Great Highway", via: [[37.765, -122.51], [37.735, -122.506]] },
  { name: "19th Ave", via: [[37.765, -122.477], [37.7345, -122.475]] },
  { name: "JFK Dr through Golden Gate Park", via: [[37.771, -122.4545], [37.7695, -122.51]] },
  { name: "3rd St to Dogpatch", via: [[37.7785, -122.3895], [37.7605, -122.388]] },
  { name: "Diagonal: Lake Merced to the Embarcadero", via: [[37.725, -122.485], [37.7955, -122.3937]] },
];

/**
 * Drive a path with the full step() (player logic, collisions, walls), player p1 following it like
 * a careful driver: it slows for an agent ahead (a simple following distance), and when an agent
 * has it boxed in (stopped against it for a second) it backs off and tries again. A stop counts
 * against the world only when the car is held by a building or a wall.
 *
 * The gate drives its routes without ambient traffic (`traffic: false`, the default: the world's
 * road graph withheld from step(), so no agents spawn). With traffic on, this follower deadlocks
 * against robotaxis waiting at junctions on every route (measured at 544f67c); the traffic-aware
 * closed-loop drivers of the roadmap (tests/helpers/drivers/) will replace it. Traffic itself is
 * exercised by the determinism suite (60 s of step() with agents) and tests/sim/agent-budget.
 */
export function routeDrive(world: World, path: readonly P2[], vmax = 14, traffic = false): { reached: boolean; stuckAt: P2 | null; why: string; ticks: number; track: DriveTrack; seamStep: number; hashes: string[] } {
  if (!traffic) world = { ...world, roads: null };
  const k = Math.min(3, path.length - 1);
  const h0 = bearing(path[k]![0] - path[0]![0], path[k]![1] - path[0]![1]);
  let s: SimState = createInitialState(world, 7, ["p1"], { x: path[0]![0], z: path[0]![1], heading: h0 });
  const len = path.length - 1;
  const limit = Math.ceil((len / Math.max(3, vmax * 0.5)) * 60) + 1800;
  const track = new DriveTrack(world);
  let idx = 0;
  let lastIdx = 0;
  let lastMove = 0;
  let held = 0;
  let boxed = 0;
  let backing = 0;
  let stuckAt: P2 | null = null;
  let why = "";
  let reached = false;
  let seamStep = 0;
  let lastDy = 0;
  const hashes: string[] = [];
  let t = 0;
  for (t = 0; t < limit; t++) {
    const c = s.players.p1!.car;
    idx = advanceIndex(path, idx, c.x, c.z).idx;
    if (idx >= len - 2) {
      reached = true;
      break;
    }
    if (idx > lastIdx + 2) {
      lastIdx = idx;
      lastMove = t;
    } else if (t - lastMove > 1800) {
      // No progress for 30 s: name what holds the car, or give up on traffic.
      const touch = contactsAt(world, c.x, c.z, c.heading, c.y);
      if (touch.buildings.length || touch.walls) {
        stuckAt = [c.x, c.z];
        why = touch.buildings.length ? `building ${touch.buildings[0]}` : "wall";
      } else why = `no progress for 30 s at ${ll(c.x, c.z)} (traffic)`;
      break;
    }
    // The nearest agent in a cone ahead (within 2.5 m of the car's line).
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    let ahead = Infinity;
    for (const a of agentsOf(s)) {
      const ox = a.x - c.x;
      const oz = a.z - c.z;
      const along = ox * fx + oz * fz;
      const side = Math.abs(ox * -fz + oz * fx);
      if (along > 0 && along < 40 && side < 2.5) ahead = Math.min(ahead, along);
    }
    let input = followInput(c, path, idx, Math.min(vmax, Math.max(0, (ahead - 7) / 1.2)));
    if (backing > 0) {
      backing--;
      input = { throttle: -0.6, steer: 0, brake: 0, actions: 0 };
    }
    s = step(world, s, { p1: input });
    const n = s.players.p1!.car;
    track.tick(c, n);
    const dy = n.y - c.y;
    // A seam crossing: the change of y that tick against the tick before.
    if (t > 2 && (Math.floor(c.x / 500) !== Math.floor(n.x / 500) || Math.floor(c.z / 500) !== Math.floor(n.z / 500))) seamStep = Math.max(seamStep, Math.abs(dy - lastDy));
    lastDy = dy;
    if (t % 600 === 0) hashes.push(hashState(s));
    const pushing = input.throttle > 0.5 && Math.abs(n.speed) < 0.5;
    if (pushing && ahead < 8) {
      if (++boxed >= 60) {
        boxed = 0;
        backing = 60;
      }
    } else boxed = 0;
    if (pushing && ahead >= 8) {
      if (++held >= 240) {
        const touch = contactsAt(world, n.x, n.z, n.heading, n.y);
        if (touch.buildings.length || touch.walls) {
          stuckAt = [n.x, n.z];
          why = touch.buildings.length ? `building ${touch.buildings[0]}` : "wall";
          break;
        }
        held = 0;
      }
    } else held = 0;
  }
  if (!reached && !stuckAt && !why) why = "time limit";
  return { reached, stuckAt, why, ticks: t, track, seamStep, hashes };
}

/** What holds a car box at (x, z, heading), grown 0.3 m: the buildings under its y it overlaps, and whether it overlaps a wall. */
export function contactsAt(world: World, x: number, z: number, heading: number, y: number): { buildings: string[]; walls: boolean } {
  const grown = { x, z, heading, hl: CAR.halfLength + 0.3, hw: CAR.halfWidth + 0.3 };
  const buildings: string[] = [];
  if (boxBlocked({ ...world, walls: null }, grown, y + 0.5, [])) {
    for (const b of nearbyBuildings(world, x, z, 8)) {
      const one = buildWorld([{ tileId: "x", ground: null, buildings: [b] }]);
      if (boxBlocked(one, grown, y + 0.5, [])) buildings.push(b.id);
    }
  }
  const walls = world.walls ? boxBlocked({ ...world, cells: new Map(), cellBoxes: new Map() }, grown, y + 0.5, []) : false;
  return { buildings, walls };
}

export function measureDrive(gw: GameWorld): Measured {
  const m = new Measured("drive", "pr");
  const world = gw.world;

  // ---- the named streets and the seeded sample (W-01, W-02, W-43, W-12, W-14)
  {
    const named: Record<string, boolean> = {};
    const stopped: string[] = [];
    for (const id of NAMED_EDGES) {
      const e = gw.edges.get(id);
      if (!e) {
        named[`${id}:+`] = false;
        stopped.push(`${id} missing from roads.json`);
        continue;
      }
      for (const dir of e.oneway ? ([1] as const) : ([1, -1] as const)) {
        const r = driveEdge(world, e, dir);
        named[r.key] = r.ok;
        if (!r.ok) stopped.push(`${r.key} ${e.name}: ${r.startBlocked ? "start blocked" : `stopped at ${r.r?.stuckAt ? ll(r.r.stuckAt[0], r.r.stuckAt[1]) : "?"} after ${r.r?.progressM}/${r.r?.lenM} m`}`);
      }
    }
    m.runSet("drive/named", named);
    m.metric({ id: "F.named.runsStopped", target: 0, better: "lower", unit: "runs", defects: ["W-01", "W-02", "W-12", "W-14", "W-43"], desc: "runs over the named streets (1st St, Howard, Kearny, Upper Market, Battery, Elk, Houston, Crescent, Mason, Winston, Walnut, the Broadway, Stockton and Toll Plaza tunnels, Lombard, the creek bridges, Richland, Twin Peaks Blvd, Filbert, Vermont), each allowed direction at the posted speed, that do not reach the end" }, stopped.length, stopped);
    const sample: Record<string, boolean> = {};
    const sampleStopped: string[] = [];
    for (const e of sampleEdges(gw)) {
      for (const dir of e.oneway ? ([1] as const) : ([1, -1] as const)) {
        const r = driveEdge(world, e, dir);
        if (r.r === null && !r.startBlocked) continue;
        sample[r.key] = r.ok;
        if (!r.ok) sampleStopped.push(`${r.key} ${e.name}`);
      }
    }
    m.runSet("drive/sample", sample);
    m.metric({ id: "F.sample.runsStopped", target: 0, better: "lower", unit: "runs", defects: ["W-01"], desc: "runs over the critic's seeded 300-edge sample of surface streets (every k-th edge by id, each allowed direction) that do not reach the end" }, sampleStopped.length, sampleStopped);
  }
  m.lap("streets");

  // ---- tunnels (W-02)
  {
    const fails: string[] = [];
    let runs = 0;
    for (const t of TUNNELS.filter((q) => q.ids)) {
      for (const e of tunnelEdges(gw, t)) {
        for (const dir of e.oneway ? ([1] as const) : ([1, -1] as const)) {
          const pts = resample(e.points, 1);
          const path = dir > 0 ? pts : [...pts].reverse();
          const n = path.length - 1;
          const y0 = surfaceAt(world, path[0]![0], path[0]![1]);
          const y1 = surfaceAt(world, path[n]![0], path[n]![1]);
          let car: CarState = { ...makeCar(path[0]![0], path[0]![1], bearing(path[3]![0] - path[0]![0], path[3]![1] - path[0]![1]), y0), speed: 20 };
          let idx = 0;
          let off = 0;
          let air = 0;
          const hits0 = car.hits;
          let ok = false;
          for (let tk = 0; tk < 60 * 120; tk++) {
            idx = advanceIndex(path, idx, car.x, car.z).idx;
            if (idx >= n - 2) {
              ok = true;
              break;
            }
            car = stepCar(world, car, followInput(car, path, idx, 25));
            if (!car.grounded) air++;
            off = Math.max(off, Math.abs(car.y - (y0 + ((y1 - y0) * idx) / n)));
            if (Math.abs(car.speed) < 0.3 && tk > 120) break;
          }
          runs++;
          if (!ok || car.hits > hits0 || air > 0 || off > 1) fails.push(`${t.name} ${e.id} dir ${dir}: ${ok ? "reached" : "stopped"}, hits ${car.hits - hits0}, airborne ticks ${air}, ${r2(off)} m off the portal line`);
        }
      }
    }
    m.metric({ id: "F.tunnels.failingRuns", target: 0, better: "lower", unit: "runs", defects: ["W-02"], desc: "drives through the Broadway, Stockton and Toll Plaza tunnels at 25 m/s that hit something, leave the ground or stray more than 1 m from the straight portal-to-portal line" }, fails.length, { runs, fails });
  }

  // ---- creek bridges (W-12)
  {
    const fails: string[] = [];
    for (const b of CREEK_BRIDGES) {
      const bp = bridgePath(gw, b.ids);
      if (!bp) {
        fails.push(`${b.name}: missing`);
        continue;
      }
      const floor = bp.floor;
      for (const dir of [1, -1]) {
        const path = dir > 0 ? bp.path : [...bp.path].reverse();
        for (const v of [15, 25]) {
          let car: CarState = { ...makeCar(path[0]![0], path[0]![1], bearing(path[3]![0] - path[0]![0], path[3]![1] - path[0]![1]), surfaceAt(world, path[0]![0], path[0]![1])), speed: v };
          let idx = 0;
          let low = Infinity;
          let air = 0;
          let reached = false;
          for (let t = 0; t < 60 * 60; t++) {
            idx = advanceIndex(path, idx, car.x, car.z).idx;
            if (idx >= path.length - 3) {
              reached = true;
              break;
            }
            car = stepCar(world, car, followInput(car, path, idx, v));
            low = Math.min(low, car.y);
            if (!car.grounded) air++;
            if (Math.abs(car.speed) < 0.3 && t > 120) break;
          }
          if (!reached || low < floor || air > 0) fails.push(`${b.name} dir ${dir} ${v} m/s: low ${r2(low)} (floor ${r2(floor)}), airborne ticks ${air}${reached ? "" : ", stopped"}`);
        }
      }
    }
    m.metric({ id: "F.bridges.failingRuns", target: 0, better: "lower", unit: "runs", defects: ["W-12"], desc: "drives over the 3rd St, 4th St, 3rd St (Islais) and Illinois St bridges, both ways at 15 and 25 m/s, that dip below the lower abutment - 0.2 m, leave the ground or stop" }, fails.length, fails);
  }
  m.lap("structures");

  // ---- street-over-freeway crossings and Richland Ave (W-14)
  {
    const crossings = fixture<{ crossings: Array<{ edge: string; at: [number, number]; dx: number; dz: number }> }>("grade-crossings.json").crossings;
    let launched = 0;
    let runs = 0;
    let worst = { airS: 0, at: "" };
    for (const c of crossings) {
      const p = toLocal(c.at[0], c.at[1]);
      const sx = p.x - c.dx * 70;
      const sz = p.z - c.dz * 70;
      const h = bearing(c.dx, c.dz);
      if (boxBlocked(world, { x: sx, z: sz, heading: h, hl: CAR.halfLength, hw: CAR.halfWidth }, groundHeight(world, sx, sz) + 0.5)) continue;
      const path: P2[] = [];
      for (let s = 0; s <= 140; s++) path.push([sx + c.dx * s, sz + c.dz * s]);
      const r = drivePath(world, path, { vmax: 15, startSpeed: 15, maxTicks: 60 * 20 });
      runs++;
      if (r.maxAirS > 0.2) launched++;
      if (r.maxAirS > worst.airS) worst = { airS: r2(r.maxAirS), at: ll(p.x, p.z) };
    }
    m.metric({ id: "F.crossings.airborneRuns", target: 0, better: "lower", unit: "runs", defects: ["W-14"], desc: "street-over-freeway crossings, each driven straight at 15 m/s, that leave the car airborne for more than 0.2 s (trenches and humps)" }, launched, { runs, worst });
    const e = gw.edges.get("c11011002");
    let rich = 0;
    if (e) {
      const pts = resample(e.points, 1);
      for (const dir of [1, -1]) {
        const path = dir > 0 ? pts : [...pts].reverse();
        for (const v of [16, 20]) rich = Math.max(rich, drivePath(world, path, { vmax: v, startSpeed: v, maxTicks: 60 * 30 }).maxAirS);
      }
    }
    m.metric({ id: "F.crossings.richlandAirS", target: 0.2, better: "lower", unit: "s", defects: ["W-14"], desc: "Richland Ave over I-280 (c11011002) at 16 and 20 m/s both ways: the longest airborne interval" }, r2(rich));
  }
  m.lap("crossings");

  // ---- ramming buildings on hills (W-23): the same seeded 360 rams as the QA
  {
    const areas: Array<[string, number, number]> = [["russian-hill", -5, -2], ["twin-peaks-west", -10, 8], ["bernal", -4, 13]];
    let seed = 99;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let rams = 0;
    let launched = 0;
    let worst = { peak: 0, b: "" };
    for (const [, cx, cz] of areas) {
      const tile = gw.tiles.find((t) => t.tileId === `t${cx}_${cz}`);
      if (!tile) continue;
      const bs = tile.buildings.filter((b) => b.topY - b.baseY > 4);
      let n = 0;
      let tries = 0;
      while (n < 120 && tries < 5000) {
        tries++;
        const b = bs[Math.floor(rnd() * bs.length)]!;
        const [bx, bz] = centroid(b.footprint);
        const H = (x: number, z: number): number => groundHeight(world, x, z);
        const slope = Math.hypot(H(bx + 5, bz) - H(bx - 5, bz), H(bx, bz + 5) - H(bx, bz - 5)) / 10;
        if (slope < 0.15) continue;
        const a = rnd() * 2 * Math.PI;
        const sx = bx + Math.sin(a) * 30;
        const sz = bz - Math.cos(a) * 30;
        const hd = Math.atan2(bx - sx, -(bz - sz));
        if (boxBlocked(world, { x: sx, z: sz, heading: hd, hl: CAR.halfLength, hw: CAR.halfWidth }, H(sx, sz) + 0.5)) continue;
        n++;
        let c: CarState = { ...makeCar(sx, sz, hd, sampleGround(world, sx, sz, hd).h), speed: 25 };
        let contact = -1;
        let air = 0;
        let maxAir = 0;
        let peak = 0;
        for (let t = 0; t < 240; t++) {
          c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
          if (contact < 0 && c.sinceContact === 0) contact = t;
          if (contact >= 0 && t - contact <= 180) {
            if (!c.grounded) {
              air++;
              maxAir = Math.max(maxAir, air);
              peak = Math.max(peak, c.y - H(c.x, c.z));
            } else air = 0;
          }
        }
        if (contact < 0) continue;
        rams++;
        if (maxAir / 60 > 0.3 || peak > 0.5) launched++;
        if (peak > worst.peak) worst = { peak: r2(peak), b: b.id };
      }
    }
    m.metric({ id: "F.ram.launches", target: 0, better: "lower", unit: "rams", defects: ["W-23"], desc: "of 360 seeded rams at 25 m/s into buildings on 15%+ ground (Russian Hill, west of Twin Peaks, Bernal), those that leave the car airborne over 0.3 s or lift it over 0.5 m" }, launched, { rams, worst });
  }
  m.lap("rams");

  // ---- placement (W-51): a car placed overlapping a footprint, and the multiplayer spawn slots
  {
    let maxRise = 0;
    let maxExcess = 0;
    const worst: string[] = [];
    const starts = fixture<{ starts: Array<[string, number]> }>("start-blocked.json").starts;
    const placed: Array<{ x: number; z: number; h: number; label: string }> = [];
    for (const [id, dir] of starts) {
      const e = gw.edges.get(id);
      if (!e) continue;
      const pts = resample(e.points, 1);
      const path = dir > 0 ? pts : [...pts].reverse();
      if (path.length < 4) continue;
      placed.push({ x: path[0]![0], z: path[0]![1], h: bearing(path[3]![0] - path[0]![0], path[3]![1] - path[0]![1]), label: `${id}:${dir}` });
    }
    const spawn = createInitialState(world, 1, ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], gw.manifest.spawn);
    for (const id of Object.keys(spawn.players).sort()) {
      const c = spawn.players[id]!.car;
      placed.push({ x: c.x, z: c.z, h: c.heading, label: `spawn ${id}` });
    }
    for (const p of placed) {
      let c: CarState = { ...makeCar(p.x, p.z, p.h, sampleGround(world, p.x, p.z, p.h).h), speed: 0 };
      const y0 = c.y;
      let rise = 0;
      let excess = 0;
      for (let t = 0; t < 300; t++) {
        const prev = c;
        c = stepCar(world, c, { throttle: c.speed < 15 ? 1 : 0, steer: 0, brake: 0, actions: 0 });
        rise = Math.max(rise, c.y - groundHeight(world, c.x, c.z), t < 30 ? c.y - y0 - Math.abs(groundHeight(world, c.x, c.z) - y0) : 0);
        excess = Math.max(excess, Math.hypot(c.x - prev.x, c.z - prev.z) - Math.max(Math.abs(prev.speed), Math.abs(c.speed)) * DT);
      }
      if (rise > 0.5 || excess > 0.5) worst.push(`${p.label} ${ll(p.x, p.z)}: up ${r2(rise)} m, jump ${r2(excess)} m`);
      maxRise = Math.max(maxRise, rise);
      maxExcess = Math.max(maxExcess, excess);
    }
    m.metric({ id: "F.placement.maxRiseM", target: 0.5, better: "lower", unit: "m", defects: ["W-51"], desc: "a car placed at each of the 58 start-blocked street starts and at the 8 multiplayer spawn slots, then driven off: the most it rises above the ground" }, r2(maxRise), worst.slice(0, 10));
    m.metric({ id: "F.placement.maxJumpM", target: 0.5, better: "lower", unit: "m", defects: ["W-51"], desc: "the same placements: the most one tick moves the car beyond speed * DT (pushed out of a footprint in one tick)" }, r2(maxExcess));
  }
  m.lap("placement");

  // ---- buried hillside buildings (W-05)
  {
    const sites = fixture<{ sites: Array<{ id: string; worst: { at: [number, number]; nx: number; nz: number } }> }>("buried-sites.json").sites;
    let carJump = 0;
    let lowWallStops = 0;
    const where: string[] = [];
    for (const s of sites) {
      const b = gw.byId.get(s.id);
      if (!b) continue;
      const p = toLocal(s.worst.at[0], s.worst.at[1]);
      const heading = Math.atan2(-s.worst.nx, s.worst.nz);
      for (const thr of [0.4, 0.8]) {
        const sx = p.x + s.worst.nx * 15;
        const sz = p.z + s.worst.nz * 15;
        let c: CarState = makeCar(sx, sz, heading, sampleGround(world, sx, sz, heading).h);
        for (let t = 0; t < 400; t++) {
          const prev = c;
          c = stepCar(world, c, { throttle: thr, steer: 0, brake: 0, actions: 0 });
          const j = Math.hypot(c.x - prev.x, c.z - prev.z) - Math.max(Math.abs(prev.speed), Math.abs(c.speed)) * DT;
          if (j > carJump) carJump = j;
        }
      }
      // A walker at the wall from 8 m out: it may cross (the roof is at its feet) or stop at a wall
      // at least 2.5 m tall; stopping at a lower one is an invisible wall.
      const wx = p.x + s.worst.nx * 8;
      const wz = p.z + s.worst.nz * 8;
      let f: FootState = makeFoot(wx, groundHeight(world, wx, wz), wz, heading);
      let low = false;
      for (let t = 0; t < 600; t++) {
        f = stepFoot(world, f, { throttle: 1, steer: 0, brake: 0, actions: 0 }, [], []);
        if (t > 120 && Math.abs(f.speed) < 0.2 && !pointInPolygon(f.x, f.z, b.footprint) && b.topY - f.y < 2.5) low = true;
      }
      if (low) {
        lowWallStops++;
        where.push(s.id);
      }
    }
    m.metric({ id: "F.buried.carMaxJumpM", target: 0.5, better: "lower", unit: "m", defects: ["W-05"], desc: "cars driven at the 31 buried-roof sites: the most one tick moves a car beyond speed * DT (teleported out of a buried footprint)" }, r2(carJump));
    m.metric({ id: "F.buried.walkerLowWallStops", target: 0, better: "lower", unit: "sites", defects: ["W-05"], desc: "buried-roof sites where a walker is stopped by a wall less than 2.5 m tall (an invisible wall at roof level)" }, lowWallStops, where);
  }
  m.lap("buried");

  // ---- Lake Merced is not a drivable floor (W-11)
  {
    const runs: Array<[number, number]> = [];
    let best = { x: 0, z0: 0, z1: 0, n: 0 };
    const cols = new Map<number, number[]>();
    const c0 = toLocal(37.7235, -122.495);
    for (const t of gw.tiles) {
      const g = t.ground;
      if (!g || g.x0 > c0.x + 1100 || g.x0 + 500 < c0.x - 1100 || g.z0 > c0.z + 1100 || g.z0 + 500 < c0.z - 1100) continue;
      for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        if (Math.abs(g.heights[k * g.nx + i]! - 5.25) > 0.07) continue;
        const x = g.x0 + i * 10;
        const l = cols.get(x) ?? [];
        l.push(g.z0 + k * 10);
        cols.set(x, l);
      }
    }
    for (const x of [...cols.keys()].sort((a, b) => a - b)) {
      const zs = [...new Set(cols.get(x))].sort((a, b) => a - b);
      let s = zs[0]!;
      let run = 1;
      for (let i = 1; i < zs.length; i++) {
        if (zs[i]! - zs[i - 1]! === 10) {
          run++;
          if (run > best.n) best = { x, z0: s, z1: zs[i]!, n: run };
        } else {
          s = zs[i]!;
          run = 1;
        }
      }
    }
    runs.push([best.x, best.z0]);
    let car: CarState = makeCar(best.x, best.z0 + 5, Math.PI, groundHeight(world, best.x, best.z0 + 5));
    let onLake = 0;
    for (let t = 0; t < 120 * 60; t++) {
      const prev = car;
      car = stepCar(world, car, { throttle: 0.7, steer: 0, brake: 0, actions: 0 });
      if (car.z > best.z1 - 5) break;
      if (Math.abs(car.y - 5.25) < 0.3) onLake += Math.hypot(car.x - prev.x, car.z - prev.z);
    }
    m.metric({ id: "F.lake.mercedDrivenM", target: 10, better: "lower", unit: "m", defects: ["W-11"], desc: "metres a car drives across South Lake Merced's flattened surface (it should be stopped or towed at the water's edge)" }, Math.round(onLake), { run: [ll(best.x, best.z0), ll(best.x, best.z1)] });
  }
  return m;
}

export function measureRoutes(gw: GameWorld): Measured {
  const m = new Measured("routes", "pr");
  const world = gw.world;
  const outcomes: Record<string, boolean> = {};
  const fails: string[] = [];
  let seam = 0;
  let below = 0;
  let jump = 0;
  let air = 0;
  let airAt = "";
  for (const r of HILL_ROUTES) {
    const path = route(gw, r.via);
    const d = routeDrive(world, path);
    outcomes[r.name] = d.reached;
    if (!d.reached) fails.push(`${r.name}: ${d.stuckAt ? `held by a ${d.why} at ${ll(d.stuckAt[0], d.stuckAt[1])}` : d.why}`);
    seam = Math.max(seam, d.seamStep);
    below = Math.max(below, d.track.maxBelow);
    jump = Math.max(jump, d.track.maxExcess);
    if (d.track.maxAir / 60 > air) {
      air = d.track.maxAir / 60;
      airAt = r.name;
    }
    m.lap(r.name);
  }
  m.runSet("routes/hills", outcomes);
  m.metric({ id: "F.routes.stopped", target: 0, better: "lower", unit: "routes", defects: ["W-01", "W-14"], desc: "of the 11 closed-loop routes (Filbert up and Lombard down, California over Nob Hill, Market to Twin Peaks, 22nd St, Fillmore, Vermont, Great Hwy, 19th Ave, JFK Dr, 3rd St, a diagonal across the city), driven with the full step() (no ambient traffic), those held by a building or a wall before the end" }, fails.length, fails);
  m.metric({ id: "F.routes.seamStepM", target: 0.1, better: "lower", unit: "m", defects: [], desc: "on those routes: the largest jump in the car's height change at a tile seam" }, r3(seam));
  m.metric({ id: "F.routes.belowSurfaceM", target: 0.1, better: "lower", unit: "m", defects: ["W-22"], desc: "on those routes: the deepest the car goes below the surface under it" }, r3(below));
  m.metric({ id: "F.routes.maxJumpM", target: 0.5, better: "lower", unit: "m", defects: [], desc: "on those routes: the most one tick moves the car beyond speed * DT" }, r3(jump));
  m.metric({ id: "F.routes.maxAirborneS", target: 0.8, better: "lower", unit: "s", defects: ["W-14"], desc: "on those routes: the longest airborne interval (real crests like Filbert allow up to 0.8 s at 25 m/s)" }, r2(air), airAt);
  // The same route twice gives the same state hashes.
  const path = route(gw, HILL_ROUTES[3]!.via);
  const a = routeDrive(world, path).hashes;
  const b = routeDrive(world, path).hashes;
  m.metric({ id: "F.routes.rerunHashMismatches", target: 0, better: "lower", unit: "checkpoints", defects: [], desc: "a route driven twice with step(): state hashes that differ at the 600-tick checkpoints" }, a.filter((h, i) => h !== b[i]).length + Math.abs(a.length - b.length));
  return m;
}

/** The walk routes (W-39) and the walker's vertical behaviour (W-52). */
export function measureFoot(gw: GameWorld): Measured {
  const m = new Measured("foot", "pr");
  const world = gw.world;
  const outcomes: Record<string, boolean> = {};
  const fails: string[] = [];
  const walk = (name: string, pts: P2[] | null, check: (r: ReturnType<typeof walkPath>) => boolean, sprint = false): void => {
    if (!pts || pts.length < 6) {
      outcomes[name] = false;
      fails.push(`${name}: no path`);
      return;
    }
    const r = walkPath(world, pts, { sprint });
    const ok = r.reached && check(r);
    outcomes[name] = ok;
    if (!ok) fails.push(`${name}: ${r.reached ? "reached" : `stuck at ${r.stuckAt ? ll(r.stuckAt[0], r.stuckAt[1]) : "?"} after ${r2(r.progressM)}/${r2(r.lenM)} m`}, mean ${r2(r.meanSpeed)} m/s`);
  };
  const edgePts = (id: string, rev = false): P2[] | null => {
    const e = gw.edges.get(id);
    if (!e) return null;
    const p = resample(e.points, 0.5);
    return rev ? p.reverse() : p;
  };
  // The famous blocks walked uphill along the street (Filbert at 31.5%: at 1.0 m/s or better).
  const uphill = (street: RegExp, at: [number, number]): P2[] | null => {
    const pts = blockPath(gw, street, at[0], at[1]);
    if (!pts || pts.length < 6) return null;
    const half = resample(pts, 0.5);
    return groundHeight(world, half[0]![0], half[0]![1]) <= groundHeight(world, half[half.length - 1]![0], half[half.length - 1]![1]) ? half : half.reverse();
  };
  walk("Filbert St up, Leavenworth to Hyde", uphill(/^Filbert St$/, [37.80024, -122.41842]), (r) => r.meanSpeed >= 1.0);
  for (const s of STAIRWAYS.filter((q) => /Lyon|Filbert Steps/.test(q.name))) {
    const es = stairEdges(gw, s);
    es.forEach((e, i) => {
      walk(`${s.name} ${e.id} up`, resample(e.points, 0.5), () => true);
      walk(`${s.name} ${e.id} down`, resample(e.points, 0.5).reverse(), () => true);
      if (i > 2) return;
    });
  }
  walk("22nd St up, Church to Vicksburg", uphill(/^22nd St$/, [37.75486, -122.42828]), () => true);
  // A seam on a slope: along the first residential street (by id) that crosses a tile border on a
  // 15% grade or steeper, 30 m either side of the border: the walker's height never steps there.
  {
    let pts: P2[] = [];
    for (const e of [...(gw.roads.edges as RoadEdge[])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (e.kind !== "residential" || e.pedestrian) continue;
      const p = resample(e.points, 0.5);
      for (let i = 60; i < p.length - 60 && !pts.length; i++) {
        const [ax, az] = p[i - 1]!;
        const [bx, bz] = p[i]!;
        if (Math.floor(ax / 500) === Math.floor(bx / 500) && Math.floor(az / 500) === Math.floor(bz / 500)) continue;
        const g = Math.abs(groundHeight(world, p[i + 20]![0], p[i + 20]![1]) - groundHeight(world, p[i - 20]![0], p[i - 20]![1])) / 20;
        if (g >= 0.15) pts = p.slice(i - 60, i + 60);
      }
      if (pts.length) break;
    }
    const r = walkPath(world, pts);
    outcomes["seam on a slope"] = r.reached && r.maxRiseM <= 0.05 && r.maxDropM <= 0.05;
    if (!outcomes["seam on a slope"]) fails.push(`seam on a slope: rise ${r3(r.maxRiseM)}, drop ${r3(r.maxDropM)} m per tick`);
  }
  for (const [name, id] of [["Pemberton Pl", "c10324000"], ["Pemberton Pl (upper)", "c10325000"], ["Cottage Row", "c4461000"]] as const) {
    walk(`${name} ${id}`, edgePts(id), () => true);
    walk(`${name} ${id} back`, edgePts(id, true), () => true);
  }
  m.runSet("foot/routes", outcomes);
  m.metric({ id: "F.walk.routesFailing", target: 0, better: "lower", unit: "walks", defects: ["W-39"], desc: "walks that fail: Filbert St up at 1.0 m/s or better, the Lyon St and Filbert steps both ways, 22nd St up, a seam on a slope, Pemberton Pl and Cottage Row both ways" }, fails.length, fails);

  // The walker falls and cannot climb a cliff (W-52), on a synthetic tile.
  {
    let failing = 0;
    const why: string[] = [];
    // A 3 m drop: flat at 3 m up to x = 250, then 0 from 250.5 (a 0.5 m lattice, so the drop is a cliff).
    const drop = synthWorld((x) => (x <= 250 ? 3 : 0), [], 0.5);
    let f = makeFoot(245, 3, 250, Math.PI / 2);
    let leftAt = -1;
    let landed = -1;
    for (let t = 0; t < 240; t++) {
      f = stepFoot(drop, f, { throttle: 1, steer: 0, brake: 0, actions: 0 }, [], []);
      if (leftAt < 0 && f.x > 250) leftAt = t;
      if (leftAt >= 0 && landed < 0 && f.y <= 0.01) landed = t;
    }
    if (leftAt < 0 || landed < 0 || (landed - leftAt) / 60 < 0.7) {
      failing++;
      why.push(`a 3 m drop takes ${leftAt < 0 || landed < 0 ? "?" : r2((landed - leftAt) / 60)} s to land (at least 0.7 s)`);
    }
    // A 150% slope 2 m tall: 0 below x = 250, 2 m above x = 251.33.
    const cliff = synthWorld((x) => (x <= 250 ? 0 : x >= 250 + 2 / 1.5 ? 2 : (x - 250) * 1.5), [], 0.5);
    let g = makeFoot(240, 0, 250, Math.PI / 2);
    for (let t = 0; t < 600; t++) g = stepFoot(cliff, g, { throttle: 1, steer: 0, brake: 0, actions: 0 }, [], []);
    if (g.y >= 1.9) {
      failing++;
      why.push("a walker climbs a 150% slope 2 m tall");
    }
    m.metric({ id: "F.walker.verticalFails", target: 0, better: "lower", unit: "checks", defects: ["W-52"], desc: "unit: walking off a 3 m drop takes at least 0.7 s to land; a walker cannot climb a slope steeper than 100% taller than 1 m" }, failing, why);
  }
  return m;
}
