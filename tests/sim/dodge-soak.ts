// The clearance soak (docs/design.md, "Vehicles never hurt people": "Tested: seeded chase, jump
// and no-brake drivers ... zero vehicle-person contacts and a minimum clearance of 0.75 m") on
// the real city, in Node. Closed-loop drivers, never open-loop logs:
//  - chase: full throttle at the nearest person ahead within 60 m, never braking; backs out
//    when it gets stuck against a building. weave: the same, swinging either side of them.
//  - no-brake: full throttle along a route through the street graph (a seeded walk, pure
//    pursuit), swerving at anyone within 25 m ahead, never braking.
//  - jump: full throttle over a crest (the steepest crests in the city's street grid, found
//    from the drawn ground) with no robotaxi on the road ahead at the start, at whoever is on
//    the road near the landing (within ON_ROUTE_M of its route); airborne it cannot steer.
//  - rival: two players; the second stands on foot by the road 50 m ahead and the first drives
//    straight at them flat out, then chases them, never braking.
// Every tick it measures, for every person, child and player on foot: contact with any vehicle
// (a player's car; a robotaxi by its drawn body, ROBOTAXI_BODY; the sim's own count, the car's
// personBumps and an independent one here) and clearance from every moving vehicle's body; a
// close pass under CLEARANCE_M that no counted override episode explains is a failure. It also
// counts the overrides robotaxis set off (anyone leapt more than 8 m from the player's car) and
// the override's failures. And every walker's step back from a dodge
// (getting up, and REJOIN_TICKS after): one that jumps more than JUMP_M in a tick (put back on
// its path instead of walking back to it) is a failure too. tests/sim/dodge-soak.test.ts runs a short
// soak on every PR; tests/sim/dodge-soak.nightly.ts the long one (pnpm soak:nightly).

import {
  AGENTS_EXT_KEY,
  AGENT_SPEC,
  CAR,
  FOOT,
  DODGE_MIN_SPEED,
  DODGE_PROFILE,
  ROBOTAXI_BODY,
  agentDodgeClass,
  agentsOf,
  boxDistance,
  circleBlocked,
  createInitialState,
  dodgeExtOf,
  makeFoot,
  meshGroundHeight,
  segmentCrossesWall,
  step,
  type AgentsExt,
  type RoadGraph,
  type SimInput,
  type SimState,
  type World,
} from "../../src/sim/index.ts";

export const CLEARANCE_M = 0.75;
/**
 * Clearance counts from a player's car moving faster than MOVING m/s, and from a robotaxi moving
 * at DODGE_MIN_SPEED or more toward the person (closing at more than CLOSING_MPS): one creeping
 * up to a crossing at walking pace, or pulling away from someone walking beside it, is no
 * threat. The override and the contact count still hold every vehicle at every speed.
 */
const CLOSING_MPS = 0.5;
const MOVING = 1;
const EPISODE_BEFORE = 30;
const EPISODE_AFTER = 120;
/** A walker moving further than this in one tick outside a dive has jumped, metres (walking is under 0.05). */
const JUMP_M = 0.3;
/** How long after its dodge ends a walker's steps are watched for a jump, ticks. */
const REJOIN_TICKS = 30;
/** The jump driver goes for people this close to its route ahead, metres; robotaxis this close to its first 300 m are taken off at the start. */
const ON_ROUTE_M = 6;
const CLEAR_RUN_M = 8;

export type SoakDriver = "chase" | "weave" | "nobrake" | "jump" | "rival";

export interface SoakStart {
  name: string;
  x: number;
  z: number;
  heading: number;
  /** For the no-brake and jump drivers: the polyline to follow. */
  route: Array<[number, number]>;
  /** The car's speed at the start, m/s (a jump is approached flat out). */
  speed?: number;
}

export interface SoakResult {
  name: string;
  ticks: number;
  dives: number;
  overrides: number;
  contacts: number;
  /** Overrides set off by a robotaxi (the rest by the player's car), and times the override gave up (must be 0). */
  taxiOverrides: number;
  failures: number;
  /** Close passes (under CLEARANCE_M) no override episode explains. */
  unexplained: string[];
  /** Walkers that jumped (moved more than JUMP_M in a tick) getting up from a dodge or rejoining their path. */
  jumps: string[];
  /** Least clearance from a moving player's car, and from a moving robotaxi. */
  minCar: number;
  minTaxi: number;
  /** People within 10 m of the moving car at some tick (how much the run tested). */
  peopleNear: number;
  /** Longest time airborne, seconds. */
  maxAirS: number;
  /** Distance driven, metres. */
  driven: number;
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const bearing = (dx: number, dz: number): number => Math.atan2(dx, -dz);

/**
 * A route through the drivable street graph from the edge nearest (x, z): at each node the
 * continuation closest to straight on (ties and near-ties broken by a seeded coin), out to
 * `lengthM`. Polyline every metre or so, starting at the nearest point of that first edge.
 */
export function routeFrom(g: RoadGraph, x: number, z: number, heading: number, lengthM: number, seed: number): Array<[number, number]> {
  let rnd = seed >>> 0 || 1;
  const coin = (): number => {
    rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0;
    return rnd / 4294967296;
  };
  // The nearest drivable edge, travelled the way that best matches the heading.
  let best = { e: -1, i: 0, d: Infinity };
  g.edges.forEach((e, ei) => {
    if (!e.drivable) return;
    const c = e.center;
    for (let i = 0; i < c.xs.length; i++) {
      const d = (c.xs[i]! - x) ** 2 + (c.zs[i]! - z) ** 2;
      if (d < best.d) best = { e: ei, i, d };
    }
  });
  const out: Array<[number, number]> = [];
  if (best.e < 0) return out;
  let e = g.edges[best.e]!;
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const c0 = e.center;
  const i0 = Math.min(best.i, c0.xs.length - 2);
  let dir: 1 | -1 = (c0.xs[i0 + 1]! - c0.xs[i0]!) * fx + (c0.zs[i0 + 1]! - c0.zs[i0]!) * fz >= 0 ? 1 : -1;
  if (e.oneway && dir === -1) dir = 1;
  let from = best.i;
  let total = 0;
  for (let hop = 0; hop < 200 && total < lengthM; hop++) {
    const c = e.center;
    const n = c.xs.length;
    const idx = dir === 1 ? [...Array(n - from).keys()].map((k) => from + k) : [...Array(from + 1).keys()].map((k) => from - k);
    for (const i of idx) {
      const p: [number, number] = [c.xs[i]!, c.zs[i]!];
      const last = out[out.length - 1];
      if (last) total += Math.hypot(p[0] - last[0], p[1] - last[1]);
      out.push(p);
    }
    // Continue from the end node: the straightest drivable way on.
    const node = g.nodes[dir === 1 ? e.b : e.a]!;
    const tail = out.length >= 2 ? bearing(out[out.length - 1]![0] - out[out.length - 2]![0], out[out.length - 1]![1] - out[out.length - 2]![1]) : heading;
    let pick: { ei: number; dir: 1 | -1; turn: number } | null = null;
    for (const o of node.out) {
      const ne = g.edges[o.edge]!;
      if (!ne.drivable || ne.index === e.index) continue;
      const nc = ne.center;
      const k = o.dir === 1 ? 0 : nc.xs.length - 1;
      const k2 = o.dir === 1 ? 1 : nc.xs.length - 2;
      const turn = Math.abs(wrap(bearing(nc.xs[k2]! - nc.xs[k]!, nc.zs[k2]! - nc.zs[k]!) - tail)) + coin() * 0.6;
      if (!pick || turn < pick.turn) pick = { ei: o.edge, dir: o.dir, turn };
    }
    if (!pick) break;
    e = g.edges[pick.ei]!;
    dir = pick.dir;
    from = dir === 1 ? 0 : e.center.xs.length - 1;
  }
  return densify(out);
}

/**
 * Crests in the street grid: on straight-on routes up the city's steep streets (an edge rising
 * more than 6 m end to end, within `near` of the origin, followed uphill and on over the top,
 * routeFrom), points where the drawn ground rises at least `grade` over the 12 m before and
 * falls at least as much over the 12 m after, at least 60 m along (a run-up), with the road clear
 * of buildings and walls for 60 m either side. Sharpest first,
 * at most `n`, at least 200 m apart; each with the route from 70 m before it.
 */
export function findCrests(world: World, n: number, grade = 0.1, near = 4000): Array<{ x: number; z: number; score: number; route: Array<[number, number]> }> {
  const g = world.roads!;
  const found: Array<{ x: number; z: number; score: number; route: Array<[number, number]> }> = [];
  g.edges.forEach((e, ei) => {
    if (!e.drivable || e.kind === "motorway" || e.kind === "trunk" || e.kind.endsWith("_link")) return;
    const a = g.nodes[e.a]!;
    const b = g.nodes[e.b]!;
    if (Math.hypot(a.x, a.z) > near) return;
    const ha = meshGroundHeight(world, a.x, a.z);
    const hb = meshGroundHeight(world, b.x, b.z);
    if (Math.abs(hb - ha) < 6) return;
    // Uphill: from the low end toward the high one, and on over the top.
    const [lo, hi] = ha < hb ? [a, b] : [b, a];
    if (e.oneway && lo !== a) return;
    const route = routeFrom(g, lo.x, lo.z, bearing(hi.x - lo.x, hi.z - lo.z), 600, ei + 1);
    if (route.length < 100) return;
    const h = route.map(([x, z]) => meshGroundHeight(world, x, z));
    let best: { i: number; score: number } | null = null;
    for (let i = 60; i + 12 < Math.min(route.length, 320); i++) {
      const up = (h[i]! - h[i - 12]!) / 12;
      const down = (h[i]! - h[i + 12]!) / 12;
      if (up >= grade && down >= grade && (!best || up + down > best.score)) best = { i, score: up + down };
    }
    if (!best) return;
    // A clear run over it: no building on the road from 60 m before to 60 m after (a stairway or
    // a terrace at the top is no place to jump), nor a wall.
    for (let i = Math.max(0, best.i - 60); i < Math.min(route.length - 1, best.i + 60); i++) {
      const [x, z] = route[i]!;
      if (circleBlocked(world, x, z, 1.6)) return;
      if (segmentCrossesWall(world.walls, x, z, route[i + 1]![0], route[i + 1]![1])) return;
    }
    const [x, z] = route[best.i]!;
    found.push({ x, z, score: best.score, route: route.slice(Math.max(0, best.i - 70)) });
  });
  found.sort((p, q) => q.score - p.score || p.x - q.x || p.z - q.z);
  const out: typeof found = [];
  for (const f of found) {
    if (out.length >= n) break;
    if (out.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < 200)) continue;
    out.push(f);
  }
  return out;
}

/** A polyline with a point at least every `step` metres. */
export function densify(points: ReadonlyArray<readonly [number, number]>, step = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    const b = points[i]!;
    const a = out[out.length - 1];
    if (a) {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
      for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      if (n === 0) continue;
    }
    out.push([b[0], b[1]]);
  }
  return out;
}

/**
 * Narrow places the review found (2026-10-21): Chinatown's alleys, where a car fills the street
 * from wall to wall, and Lombard's crooked block.
 */
export const NARROW_PLACES: ReadonlyArray<readonly [string, number, number]> = [
  ["Ross Alley", 37.79465, -122.40725],
  ["Spofford Alley", 37.7951, -122.4079],
  ["Waverly Place", 37.79345, -122.40685],
  ["Lombard's crooked block", 37.80205, -122.41875],
];

/** A start on the drivable street nearest (x, z) (local metres), along it, with a route on from there. */
export function startNear(world: World, name: string, x: number, z: number, seed = 11): SoakStart {
  const route = routeFrom(world.roads!, x, z, 0, 3000, seed);
  const [x0, z0] = route[0]!;
  const [x1, z1] = route[Math.min(3, route.length - 1)]!;
  return { name, x: x0, z: z0, heading: bearing(x1 - x0, z1 - z0), route };
}

/** A start 70 m before a crest at 26 m/s (flat out), with the route on over it. */
export function crestStart(crest: { route: Array<[number, number]> }, name: string): SoakStart {
  const route = crest.route;
  const [x, z] = route[0]!;
  const [x1, z1] = route[Math.min(3, route.length - 1)]!;
  return { name, x, z, heading: bearing(x1 - x, z1 - z), route, speed: 26 };
}

/**
 * The nearest person ahead of the car within `range` metres (and a little to the side), or null;
 * with `near`, only someone within ON_ROUTE_M of one of those points (on the road ahead).
 */
function personAhead(s: SimState, range: number, near: ReadonlyArray<readonly [number, number]> | null = null): { x: number; z: number } | null {
  const c = s.players.p1!.car;
  const fx = Math.sin(c.heading);
  const fz = -Math.cos(c.heading);
  let best: { x: number; z: number; d: number } | null = null;
  for (const a of agentsOf(s)) {
    if (a.kind !== "person" || a.dodge) continue;
    const dx = a.x - c.x;
    const dz = a.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 2) continue;
    if ((dx * fx + dz * fz) / d < 0.4) continue;
    if (near && !near.some(([x, z]) => (x - a.x) * (x - a.x) + (z - a.z) * (z - a.z) <= ON_ROUTE_M * ON_ROUTE_M)) continue;
    if (!best || d < best.d) best = { x: a.x, z: a.z, d };
  }
  return best;
}

interface DriverState {
  idx: number;
  stuck: number;
  reverse: number;
}

function aim(c: { x: number; z: number; heading: number }, x: number, z: number, gain = 3): number {
  return Math.max(-1, Math.min(1, wrap(bearing(x - c.x, z - c.z) - c.heading) * gain));
}

/** The driver's input this tick (closed loop on the state). */
function drive(kind: SoakDriver, start: SoakStart, s: SimState, ds: DriverState): SimInput {
  const c = s.players.p1!.car;
  if (Math.abs(c.speed) < 1 && c.grounded) ds.stuck++;
  else ds.stuck = 0;
  if (ds.stuck > 60) {
    ds.reverse = 50;
    ds.stuck = 0;
  }
  if (ds.reverse > 0) {
    ds.reverse--;
    return { throttle: -1, steer: ds.reverse % 100 < 50 ? 1 : -1, brake: 0, actions: 0 };
  }
  if (kind === "rival") {
    const f = s.players.p2!.foot!;
    return { throttle: 1, steer: aim(c, f.x, f.z), brake: 0, actions: 0 };
  }
  if (kind === "chase" || kind === "weave") {
    const p = personAhead(s, 60);
    // No one ahead: a slow arc until someone is. Weaving: swinging either side of them as it goes.
    const steer = p ? aim(c, p.x, p.z) : 0.25;
    return { throttle: 1, steer: kind === "weave" ? Math.max(-1, Math.min(1, steer + Math.sin(s.tick / 7) * 0.7)) : steer, brake: 0, actions: 0 };
  }
  // Route followers (no-brake, jump): pure pursuit on the route, at people close ahead.
  const r = start.route;
  let bi = ds.idx;
  let bd = Infinity;
  for (let j = ds.idx; j < Math.min(r.length, ds.idx + 60); j++) {
    const d = (r[j]![0] - c.x) ** 2 + (r[j]![1] - c.z) ** 2;
    if (d < bd) {
      bd = d;
      bi = j;
    }
  }
  ds.idx = bi;
  const look = r[Math.min(r.length - 1, bi + 12)]!;
  // (The jump driver keeps to its line over the crest: it goes for people on the road ahead,
  // where it lands, not anyone off beside a building.)
  const p = kind === "jump" ? personAhead(s, 40, r.slice(bi, bi + 60)) : personAhead(s, 25);
  const steer = p ? aim(c, p.x, p.z) : aim(c, look[0], look[1], 2);
  return { throttle: 1, steer, brake: 0, actions: 0 };
}

/** One soak run: a player at `start` with `driver` for `ticks` ticks on `world`, seed `seed`. */
export function soak(world: World, start: SoakStart, driver: SoakDriver, ticks: number, seed: number): SoakResult {
  let s: SimState = createInitialState(world, seed, driver === "rival" ? ["p1", "p2"] : ["p1"], { x: start.x, z: start.z, heading: start.heading });
  if (start.speed) s = { ...s, players: { ...s.players, p1: { ...s.players.p1!, car: { ...s.players.p1!.car, speed: start.speed } } } };
  if (driver === "rival") {
    // The rival on foot beside the route 50 m on (the first clear spot 2-6 m to its side), their car parked out of the way.
    const [rx, rz] = start.route[Math.min(start.route.length - 1, 50)]!;
    const [qx, qz] = start.route[Math.min(start.route.length - 1, 51)]!;
    const l = Math.hypot(qx - rx, qz - rz) || 1;
    let at: [number, number] = [rx, rz];
    for (const k of [2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
      const x = rx + (-(qz - rz) / l) * k;
      const z = rz + ((qx - rx) / l) * k;
      if (!circleBlocked(world, x, z, 0.6)) {
        at = [x, z];
        break;
      }
    }
    const p2 = s.players.p2!;
    s = { ...s, players: { ...s.players, p2: { ...p2, mode: "foot", car: { ...p2.car, x: p2.car.x + 3000, z: p2.car.z + 3000 }, foot: makeFoot(at[0], meshGroundHeight(world, at[0], at[1]), at[1], 0) } } };
  }
  if (driver === "jump") {
    // A clear run at the crest: no robotaxi on the road ahead (one waiting in the lane would stop
    // the car short of it; the run is about who is near the landing).
    const ahead = start.route.slice(0, 300);
    const ext = s.ext[AGENTS_EXT_KEY] as AgentsExt;
    const list = ext.list.filter((a) => !AGENT_SPEC[a.kind].road || !ahead.some(([x, z]) => (x - a.x) * (x - a.x) + (z - a.z) * (z - a.z) < CLEAR_RUN_M * CLEAR_RUN_M));
    s = { ...s, ext: { ...s.ext, [AGENTS_EXT_KEY]: { ...ext, list } } };
  }
  const ds: DriverState = { idx: 0, stuck: 0, reverse: 0 };
  const close: Array<{ key: string; tick: number; clear: number; by: string }> = [];
  const leapt = new Map<string, number[]>();
  const nearSeen = new Set<number>();
  let contacts = 0;
  let minCar = Infinity;
  let minTaxi = Infinity;
  let air = 0;
  let maxAir = 0;
  let driven = 0;
  const jumps: string[] = [];
  let was = new Map<number, { x: number; z: number; dodging: boolean }>();
  /** Walker id -> the tick its dodge ended. */
  const ended = new Map<number, number>();
  let taxiOverrides = 0;
  for (let t = 0; t < ticks; t++) {
    const before = s.players.p1!.car;
    const o0 = dodgeExtOf(s).overrides;
    s = step(world, s, { p1: drive(driver, start, s, ds) });
    if (dodgeExtOf(s).overrides !== o0) {
      // Whose: any body leapt this tick farther than 8 m from the player's car was a robotaxi's doing.
      const c1 = s.players.p1!.car;
      for (const a of agentsOf(s)) if (a.dodge?.leap && a.dodge.t === 0 && Math.hypot(a.x - c1.x, a.z - c1.z) > 8) taxiOverrides++;
    }
    const c = s.players.p1!.car;
    driven += Math.hypot(c.x - before.x, c.z - before.z);
    air = c.grounded ? 0 : air + 1;
    maxAir = Math.max(maxAir, air);
    const carMoving = Math.hypot(c.speed, c.lateral) > MOVING;
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    const list = agentsOf(s);
    const taxis = list.filter((a) => a.kind === "robotaxi");
    const now = new Map<number, { x: number; z: number; dodging: boolean }>();
    for (const a of list) {
      if (AGENT_SPEC[a.kind].road) continue;
      now.set(a.id, { x: a.x, z: a.z, dodging: a.dodge !== null });
      const p = was.get(a.id);
      if (!p) continue;
      if (p.dodging && !a.dodge) ended.set(a.id, s.tick);
      const back = a.dodge?.phase === "recover" || s.tick - (ended.get(a.id) ?? -Infinity) <= REJOIN_TICKS;
      const m = Math.hypot(a.x - p.x, a.z - p.z);
      if (back && m > JUMP_M) jumps.push(`${start.name} ${driver}: a${a.id} (${a.kind}, ${a.mode}) jumped ${m.toFixed(2)} m at tick ${s.tick}`);
    }
    was = now;
    const rival = s.players.p2;
    if (rival?.foot) {
      const f = rival.foot;
      if (f.dodge?.leap && f.dodge.t === 0) leapt.set("p2", [...(leapt.get("p2") ?? []), s.tick]);
      const clear = boxDistance(f.x, f.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - FOOT.radius;
      if (clear < 0) contacts++;
      if (carMoving) {
        minCar = Math.min(minCar, clear);
        if (clear < CLEARANCE_M) close.push({ key: "p2", tick: s.tick, clear, by: "car" });
        if (clear < 10) nearSeen.add(-2);
      }
    }
    for (const a of list) {
      const cls = agentDodgeClass(a);
      if (!cls || DODGE_PROFILE[cls].override === null) continue;
      const key = `a${a.id}`;
      if (a.dodge?.leap && a.dodge.t === 0) leapt.set(key, [...(leapt.get(key) ?? []), s.tick]);
      const r = AGENT_SPEC[a.kind].radius;
      if (Math.abs(a.x - c.x) < 12 && Math.abs(a.z - c.z) < 12) {
        const clear = boxDistance(a.x, a.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - r;
        if (clear < 0) contacts++;
        if (carMoving) {
          if (clear < 10) nearSeen.add(a.id);
          minCar = Math.min(minCar, clear);
          if (clear < CLEARANCE_M) close.push({ key, tick: s.tick, clear, by: "car" });
        }
      }
      for (const T of taxis) {
        if (Math.abs(a.x - T.x) > 8 || Math.abs(a.z - T.z) > 8) continue;
        // Contact and clearance against its drawn body (ROBOTAXI_BODY, a box the size of the Meander model).
        const spec = ROBOTAXI_BODY;
        const hx = Math.sin(T.heading);
        const hz = -Math.cos(T.heading);
        const clear = boxDistance(a.x, a.z, T.x, T.z, hx, hz, spec.halfLength, spec.halfWidth) - r;
        if (clear < 0) contacts++;
        if (T.speed < DODGE_MIN_SPEED) continue;
        // Closing: its velocity toward the person, from the nearest point of its body.
        const ox = a.x - T.x;
        const oz = a.z - T.z;
        const along = Math.max(-spec.halfLength, Math.min(spec.halfLength, ox * hx + oz * hz));
        const side = Math.max(-spec.halfWidth, Math.min(spec.halfWidth, ox * -hz + oz * hx));
        const nx = ox - (hx * along - hz * side);
        const nz = oz - (hz * along + hx * side);
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-9 && ((hx * nx + hz * nz) / nl) * T.speed <= CLOSING_MPS) continue;
        minTaxi = Math.min(minTaxi, clear);
        if (clear < CLEARANCE_M) close.push({ key, tick: s.tick, clear, by: `robotaxi #${T.id} at ${T.speed.toFixed(1)} m/s` });
      }
    }
  }
  const d = dodgeExtOf(s);
  contacts += d.contacts + s.players.p1!.car.personBumps;
  const unexplained = close
    .filter((e) => !(leapt.get(e.key) ?? []).some((o) => e.tick >= o - EPISODE_BEFORE && e.tick <= o + EPISODE_AFTER))
    .map((e) => `${start.name} ${driver}: ${e.key} at tick ${e.tick} only ${e.clear.toFixed(3)} m from the ${e.by}`);
  return { name: `${start.name} ${driver}`, ticks, dives: d.dives, overrides: d.overrides, taxiOverrides, failures: d.failures, contacts, unexplained, jumps, minCar, minTaxi, peopleNear: nearSeen.size, maxAirS: maxAir / 60, driven };
}
