// Going round a stopped vehicle (v10, src/sim/overtake.ts and src/sim/agents/detour.ts): closed
// loops on the synthetic grid city. Robotaxis held behind a parked car wait briefly, check the
// road, pass and merge back; walkers whose route runs into it walk round its bumper. Nobody
// touches anybody, and nobody is left standing at the bumper.
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC,
  CAR,
  PASS_FOOT_WAIT_TICKS,
  PASS_WAIT_TICKS,
  ROBOTAXI_BODY,
  agentsOf,
  createGameSystems,
  createInitialState,
  dcos,
  dodgeExtOf,
  dsin,
  hashState,
  lanePath,
  makeFoot,
  pathPoint,
  step,
  type AgentState,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { LONG_RUN_MS, gridCity } from "./fixtures.ts";

interface Rect { x: number; z: number; heading: number; hl: number; hw: number }

/** Do two oriented rectangles overlap? (Separating axis test.) */
function overlap(a: Rect, b: Rect): boolean {
  const axes = (h: number): Array<[number, number]> => [[dsin(h), -dcos(h)], [dcos(h), dsin(h)]];
  const corners = (r: Rect): Array<[number, number]> => {
    const [f, s] = axes(r.heading) as [[number, number], [number, number]];
    const out: Array<[number, number]> = [];
    for (const i of [-1, 1]) for (const j of [-1, 1]) out.push([r.x + f[0] * r.hl * i + s[0] * r.hw * j, r.z + f[1] * r.hl * i + s[1] * r.hw * j]);
    return out;
  };
  const ca = corners(a), cb = corners(b);
  for (const [ax, az] of [...axes(a.heading), ...axes(b.heading)]) {
    const pa = ca.map(([x, z]) => x * ax + z * az), pb = cb.map(([x, z]) => x * ax + z * az);
    if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
  }
  return true;
}

const taxiRect = (a: AgentState): Rect => ({ x: a.x, z: a.z, heading: a.heading, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth });
const carRect = (s: SimState, id: string): Rect => { const c = s.players[id]!.car; return { x: c.x, z: c.z, heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth }; };

/** The eastbound lane of street z = 100 (edge h11, x 100 -> 200): its centre is 1.75 m south of the centreline. */
const LANE_Z = 101.75;
const PARKED = { x: 150, z: LANE_Z, heading: Math.PI / 2 };

/** A state on the grid city with player p1's car parked at PARKED and p1 on foot `away`. */
function parkedState(world: World, seed: number, away = { x: 60, z: 140 }): SimState {
  const s = createInitialState(world, seed, ["p1"], PARKED);
  return { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(away.x, 0, away.z, 0) } } };
}

/**
 * Every robotaxi body keeps off the parked cars, and every robotaxi going round them or near them
 * (30 m) keeps off every other robotaxi; nobody is touched. (Elsewhere on the grid the old
 * deadlock breaker, GHOST_TICKS, may still let two robotaxis squeeze past each other at a junction.)
 */
function checkBodies(s: SimState, players: readonly string[]): void {
  const taxis = agentsOf(s).filter((a) => a.kind === "robotaxi");
  const cars = players.map((p) => s.players[p]!.car);
  const involved = (a: AgentState) => a.pass !== undefined || cars.some((c) => Math.hypot(a.x - c.x, a.z - c.z) < 30);
  for (const t of taxis) for (const p of players) expect(overlap(taxiRect(t), carRect(s, p))).toBe(false);
  for (let i = 0; i < taxis.length; i++) {
    for (let j = i + 1; j < taxis.length; j++) {
      if (involved(taxis[i]!) || involved(taxis[j]!)) expect(overlap(taxiRect(taxis[i]!), taxiRect(taxis[j]!))).toBe(false);
    }
  }
  expect(dodgeExtOf(s).contacts).toBe(0);
}

/** A robotaxi placed on a lane of the grid (copied from `template`), standing still, going nowhere after it. */
function placeTaxi(world: World, template: AgentState, id: number, edge: string, dir: 1 | -1, s: number, speed = 0): AgentState {
  const g = world.roads!;
  const e = g.edges[g.edgeIndex.get(edge)!]!;
  const q = pathPoint(lanePath(e, dir, 0), s);
  return { ...template, id, x: q.x, z: q.z, heading: Math.atan2(q.tx, -q.tz), speed, edge, dir, lane: 0, s, next: "", ndir: dir, nlane: 0, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", dodge: null };
}

describe("robotaxis go round a stopped vehicle", () => {
  it("behind a car parked in its lane: waits briefly, passes on the clear oncoming lane, merges back; no contacts", () => {
    const world = gridCity();
    let passes = 0;
    let longest = 0;
    for (const seed of [7, 11, 23]) {
      let s = parkedState(world, seed);
      const behind = new Map<number, number>();
      const merged = new Set<number>();
      for (let t = 0; t < 3600; t++) {
        s = step(world, s, {});
        checkBodies(s, ["p1"]);
        for (const a of agentsOf(s)) {
          if (a.kind !== "robotaxi" || a.edge !== "h11" || a.dir !== 1) continue;
          // Standing behind it in its lane: how long, and does it get past?
          if (a.x < PARKED.x - 4 && Math.abs(a.z - LANE_Z) < 0.5 && a.speed < 0.05) behind.set(a.id, (behind.get(a.id) ?? 0) + 1);
          if (behind.has(a.id) && a.x > PARKED.x + 8 && Math.abs(a.z - LANE_Z) < 0.2 && !merged.has(a.id)) {
            merged.add(a.id);
            passes++;
          }
        }
      }
      for (const n of behind.values()) longest = Math.max(longest, n);
    }
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(longest).toBeGreaterThanOrEqual(PASS_WAIT_TICKS);
    // Nobody is held up behind it for long when the oncoming lane is free most of the time.
    expect(longest).toBeLessThan(8 * 60);
  }, LONG_RUN_MS);

  it("waits for an oncoming robotaxi to go by before pulling out, and never meets it", () => {
    const world = gridCity();
    let s = parkedState(world, 7, { x: 150, z: 160 });
    const list = agentsOf(s).filter((a) => !(a.kind === "robotaxi" && Math.abs(a.z - 100) < 8 && a.x > 60 && a.x < 240));
    const template = agentsOf(s).find((a) => a.kind === "robotaxi")!;
    const g = world.roads!;
    const lane = (edge: string, dir: 1 | -1) => lanePath(g.edges[g.edgeIndex.get(edge)!]!, dir, 0);
    const east = lane("h11", 1);
    const west = lane("h11", -1);
    // A behind the car, waiting; B oncoming from the east end of the block at cruise.
    const a = placeTaxi(world, template, 9001, "h11", 1, east.len / 2 - 11);
    const b = placeTaxi(world, template, 9002, "h11", -1, 4, 11);
    s = { ...s, ext: { ...s.ext, agents: { nextId: 9003, list: [...list, a, b].sort((p, q) => p.id - q.id) } } };
    let pulledOut = -1, bPassed = -1, closest = Infinity;
    for (let t = 0; t < 1500; t++) {
      s = step(world, s, {});
      checkBodies(s, ["p1"]);
      const ta = agentsOf(s).find((x) => x.id === 9001);
      const tb = agentsOf(s).find((x) => x.id === 9002);
      if (ta && Math.abs(ta.z - LANE_Z) > 0.5 && pulledOut < 0) pulledOut = t;
      if (tb && tb.edge === "h11" && tb.x < PARKED.x - 15 && bPassed < 0) bPassed = t;
      if (ta && tb && Math.abs(ta.z - LANE_Z) > 0.5) closest = Math.min(closest, Math.hypot(ta.x - tb.x, ta.z - tb.z));
    }
    expect(bPassed).toBeGreaterThan(0);
    expect(pulledOut).toBeGreaterThan(bPassed - 60);
    // While out of its lane it is never near the oncoming robotaxi.
    expect(closest).toBeGreaterThan(6);
    const done = agentsOf(s).find((x) => x.id === 9001);
    expect(done === undefined || done.x > PARKED.x + 8).toBe(true);
  }, LONG_RUN_MS);

  it("stopped right behind it (it parked just in front), backs up to make room, then goes round", () => {
    const world = gridCity();
    let s = parkedState(world, 7, { x: 150, z: 160 });
    const list = agentsOf(s).filter((a) => !(a.kind === "robotaxi" && Math.abs(a.z - 100) < 8 && a.x > 60 && a.x < 240));
    const template = agentsOf(s).find((a) => a.kind === "robotaxi")!;
    const east = lanePath(world.roads!.edges[world.roads!.edgeIndex.get("h11")!]!, 1, 0);
    // Bumper to bumper: 1.5 m from the parked car's rear.
    const a = placeTaxi(world, template, 9001, "h11", 1, east.len / 2 - CAR.halfLength - 1.5 - ROBOTAXI_BODY.halfLength);
    const startS = a.s;
    s = { ...s, ext: { ...s.ext, agents: { nextId: 9002, list: [...list, a].sort((p, q) => p.id - q.id) } } };
    let backed = 0, passed = false;
    for (let t = 0; t < 1500 && !passed; t++) {
      s = step(world, s, {});
      checkBodies(s, ["p1"]);
      const ta = agentsOf(s).find((x) => x.id === 9001);
      if (ta && ta.edge === "h11" && ta.pass === undefined) backed = Math.max(backed, startS - ta.s);
      passed = ta === undefined || ta.x > PARKED.x + 8 && Math.abs(ta.z - LANE_Z) < 0.2;
    }
    expect(backed).toBeGreaterThan(1);
    expect(passed).toBe(true);
  }, LONG_RUN_MS);

  it("someone standing still in its lane (a player on foot): after 3 s it goes round with the walker berth to spare", () => {
    const world = gridCity();
    let s = createInitialState(world, 7, ["p1", "p2"], { x: -20, z: 150, heading: 0 });
    // p2 stands in the eastbound lane of h11; p1 is off on the grid's west edge.
    s = { ...s, players: { ...s.players, p2: { ...s.players.p2!, car: { ...s.players.p2!.car, x: -20, z: 250 }, mode: "foot", foot: makeFoot(PARKED.x, 0, LANE_Z, 0) } } };
    const list = agentsOf(s).filter((a) => !(a.kind === "robotaxi" && Math.abs(a.z - 100) < 8 && a.x > 60 && a.x < 240));
    const template = agentsOf(s).find((a) => a.kind === "robotaxi")!;
    const east = lanePath(world.roads!.edges[world.roads!.edgeIndex.get("h11")!]!, 1, 0);
    const a = placeTaxi(world, template, 9001, "h11", 1, east.len / 2 - 25, 8);
    s = { ...s, ext: { ...s.ext, agents: { nextId: 9002, list: [...list, a].sort((p, q) => p.id - q.id) } } };
    let passed = false, closest = Infinity, waited = 0;
    for (let t = 0; t < 1500 && !passed; t++) {
      s = step(world, s, {});
      expect(dodgeExtOf(s).contacts).toBe(0);
      const ta = agentsOf(s).find((x) => x.id === 9001);
      if (!ta) break;
      if (ta.speed < 0.05 && ta.pass === undefined) waited++;
      const f = s.players.p2!.foot!;
      const fx = f.x - ta.x, fz = f.z - ta.z, hx = dsin(ta.heading), hz = -dcos(ta.heading);
      const along = Math.abs(fx * hx + fz * hz) - ROBOTAXI_BODY.halfLength, lat = Math.abs(-fx * hz + fz * hx) - ROBOTAXI_BODY.halfWidth;
      closest = Math.min(closest, Math.hypot(Math.max(0, along), Math.max(0, lat)) - 0.35);
      passed = ta.x > PARKED.x + 8 && Math.abs(ta.z - LANE_Z) < 0.2;
    }
    expect(passed).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(PASS_FOOT_WAIT_TICKS);
    expect(closest).toBeGreaterThan(0.75);
  }, LONG_RUN_MS);

  it("with no room to go round (two cars side by side across the street) it waits and honks, touching nothing", () => {
    const world = gridCity();
    let s = createInitialState(world, 5, ["p1", "p2"], { x: 150, z: LANE_Z, heading: Math.PI / 2 });
    s = {
      ...s,
      players: {
        p1: { ...s.players.p1!, car: { ...s.players.p1!.car, x: 150, z: LANE_Z, heading: Math.PI / 2 } },
        p2: { ...s.players.p2!, car: { ...s.players.p2!.car, x: 150, z: 100 - 1.75, heading: Math.PI / 2 } },
      },
    };
    const list = agentsOf(s).filter((a) => !(a.kind === "robotaxi" && Math.abs(a.z - 100) < 8 && a.x > 60 && a.x < 240));
    const template = agentsOf(s).find((a) => a.kind === "robotaxi")!;
    const east = lanePath(world.roads!.edges[world.roads!.edgeIndex.get("h11")!]!, 1, 0);
    const a = placeTaxi(world, template, 9001, "h11", 1, east.len / 2 - 20, 8);
    s = { ...s, ext: { ...s.ext, agents: { nextId: 9002, list: [...list, a].sort((p, q) => p.id - q.id) } } };
    for (let t = 0; t < 900; t++) {
      s = step(world, s, {});
      checkBodies(s, ["p1", "p2"]);
      expect(agentsOf(s).find((x) => x.id === 9001)?.pass).toBeUndefined();
    }
    const t = agentsOf(s).find((x) => x.id === 9001)!;
    expect(t.speed).toBe(0);
    expect(t.mode).toBe("honk");
  }, LONG_RUN_MS);

  it("is deterministic: the same seed gives the same state", () => {
    const world = gridCity();
    const run = () => {
      let s = parkedState(world, 11);
      for (let t = 0; t < 900; t++) s = step(world, s, {});
      return hashState(s);
    };
    expect(run()).toBe(run());
  }, LONG_RUN_MS);
});

describe("walkers go round a stopped vehicle (the game composition)", () => {
  it("a car parked across a crosswalk: people and robots walk round its bumper; nobody stands at it or touches it", () => {
    const world = gridCity();
    const systems = createGameSystems({ wave: 2, protectedArea: () => false });
    // Across the west crosswalk of the junction at (100, 100), the player gone off on foot.
    let s = createInitialState(world, 7, ["p1"], { x: 92, z: 100, heading: 0 });
    s = { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(60, 0, 140, 0) } } };
    const standing = new Map<number, number>();
    const near = new Set<number>();
    let longest = 0;
    for (let t = 0; t < 2400; t++) {
      s = step(world, s, {}, [], systems);
      const car = s.players.p1!.car;
      for (const a of agentsOf(s)) {
        if (AGENT_SPEC[a.kind].road) continue;
        if (Math.hypot(a.x - car.x, a.z - car.z) >= 4) { standing.delete(a.id); continue; }
        near.add(a.id);
        const n = a.speed < 0.05 ? (standing.get(a.id) ?? 0) + 1 : 0;
        standing.set(a.id, n);
        longest = Math.max(longest, n);
      }
    }
    expect(near.size).toBeGreaterThanOrEqual(3);
    expect(longest).toBeLessThan(120);
    expect(dodgeExtOf(s).contacts).toBe(0);
  }, LONG_RUN_MS);
});
