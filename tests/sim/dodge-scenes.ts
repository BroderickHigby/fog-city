// The no-touch fuzz's scenes (docs/design.md, "Vehicles never hurt people"; the owner's Crazy Taxi rule):
// seeded scenes in which cars at up to 38 m/s are aimed at people, and the people must get out
// of the way every time. Scenes: a single person, a group of 20 (with children and robots in
// it), players on foot, people backed against a wall or into a corner, people on hills (cars
// coming down and up them), players on foot standing on a low deck the car drives up onto; and
// the drivers: straight at them, chasing them (steering at the nearest), weaving, drifting
// (brake and steer into a slide toward them), handbrake turns, banking (coming up beside them
// and, 8-16 m short, slamming into a drift or a hard turn at them: into a corner, off a wall)
// and a seeded random driver (steer, brake and throttle changed every 0.1 s: the kind of driver
// that found the review's holes, 2026-10-21).
// Every tick of every scene: zero contacts (no person inside a car's body, ever: the sim's own
// count and an independent one here), and every person, child and player on foot at least
// 0.75 m from every moving car's body, except in an episode the clearance override handled
// (counted, and reported). Deterministic: a scene replays to the same state.
//
// The people are agents in a roadless world (they stand until they dive; tests/sim/dodge.test
// .ts covers agents on paths) and players on foot.
//
// This module builds and runs the scenes; tests/sim/dodge-fuzz.test.ts asserts on them.
import {
  AGENT_SPEC,
  CAR,
  DODGE_PROFILE,
  FOOT,
  agentDodgeClass,
  agentsOf,
  boxDistance,
  buildWorld,
  createInitialState,
  dodgeExtOf,
  hashState,
  makeCar,
  makeFoot,
  meshGroundHeight,
  personIsChild,
  step,
  type AgentKind,
  type AgentState,
  type AgentsExt,
  type BuildingCollider,
  type InputFrame,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { emptyWorld, terrainWorld } from "./fixtures.ts";

/** The clearance every person keeps from a moving car, metres (docs/design.md *(tune)*). */
export const CLEARANCE_M = 0.75;
/** A car counts as moving above this speed, m/s. */
export const MOVING = 1;
/** Close ticks this long before, or this long after, an override on the same body belong to its episode. */
const EPISODE_BEFORE = 30;
const EPISODE_AFTER = 120;

/** A tiny LCG for the scenes only (the sim has its own RNG). */
function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 12): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

export type Place = "open" | "wall" | "corner" | "hill" | "deck";
export type Crowd = "single" | "group" | "players";
export type Driver = "straight" | "chase" | "weave" | "drift" | "handbrake" | "bank" | "random";

export interface Scene {
  name: string;
  world: World;
  state: SimState;
  driver: Driver;
  /** Where the driver aims (the target body's id: "a<id>" an agent, "p<id>" a player). */
  target: string;
  ticks: number;
  /** The banking driver's trigger distance (m) and turn (-1..1, + toward the target's side); the random driver's controls, one [steer, brake, throttle] per 6 ticks. */
  at: number;
  lock: number;
  ctl: Array<[number, number, number]>;
}

const FLAT = emptyWorld();
// A long building whose west face is x = 0 (people stand against it).
const WALL = buildWorld([{ tileId: "wall", buildings: [rect("wall", 0, -60, 30, 60)], ground: null }]);
// An inside corner at the origin: buildings east (x >= 0) and north (z <= 0) of it.
const CORNER = buildWorld([{ tileId: "corner", buildings: [rect("east", 0, -60, 30, 60), rect("north", -60, -30, 0, 0)], ground: null }]);
const HILLS = [0.12, 0.2, 0.28].map((g) => terrainWorld((x, z) => g * (0.6 * x - 0.8 * z), 300));
// A 0.4 m deck north of z = 0 (within the step a car and a walker climb): players stand on it.
const DECK_Y = 0.4;
const DECK = buildWorld([{ tileId: "deck", buildings: [rect("deck", -40, -80, 40, 0, DECK_Y)], ground: null }]);

const AGENT_ID0 = 100;
/** Ids of children and of adults (personIsChild), for groups that hold both. */
const CHILD_IDS = [...Array(4000).keys()].filter((i) => i >= AGENT_ID0 && personIsChild(i));

function agent(world: World, id: number, kind: AgentKind, x: number, z: number): AgentState {
  return {
    id,
    kind,
    x,
    y: meshGroundHeight(world, x, z),
    z,
    heading: 0,
    pitch: 0,
    speed: 0,
    vmax: 1.3,
    edge: "",
    dir: 1,
    lane: 1,
    s: 0,
    next: "",
    ndir: 1,
    nlane: 1,
    conn: null,
    node: "",
    resume: 0,
    lat: 0,
    wait: 0,
    dwell: 0,
    ghost: 0,
    mode: "go",
    rng: id,
    dodge: null,
  };
}

/** Is (x, z) clear for a body of radius r: off every building, apart from the others? */
function free(world: World, taken: Array<[number, number, number]>, x: number, z: number, r: number): boolean {
  for (const t of world.tiles) {
    for (const b of t.buildings) {
      const xs = b.footprint.map((p) => p[0]);
      const zs = b.footprint.map((p) => p[1]);
      if (x > Math.min(...xs) - r && x < Math.max(...xs) + r && z > Math.min(...zs) - r && z < Math.max(...zs) + r) return false;
    }
  }
  return apart(taken, x, z, r);
}

function apart(taken: Array<[number, number, number]>, x: number, z: number, r: number): boolean {
  for (const [tx, tz, tr] of taken) if (Math.hypot(tx - x, tz - z) < tr + r + 0.25) return false;
  return true;
}

/** Is (x, z) on the deck, a body's radius in from its edges? */
function onDeck(x: number, z: number, r: number): boolean {
  return x > -40 + r && x < 40 - r && z > -80 + r && z < -r;
}

export function makeScene(seed: number): Scene {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const place: Place = pick(["open", "open", "wall", "corner", "hill", "deck"] as const);
  const crowd: Crowd = place === "deck" ? "players" : pick(["single", "single", "group", "players"] as const);
  const driver: Driver = pick(["straight", "chase", "chase", "weave", "drift", "handbrake", "bank", "bank", "random"] as const);
  const world = place === "wall" ? WALL : place === "corner" ? CORNER : place === "hill" ? pick(HILLS) : place === "deck" ? DECK : FLAT;
  const at = 8 + rnd() * 8;
  const lock = (rnd() < 0.5 ? 0.6 : 1) * (rnd() < 0.8 ? 1 : -1);
  const ctl: Array<[number, number, number]> = [];
  for (let k = 0; k < 60; k++) ctl.push([rnd() * 2 - 1, rnd() > 0.75 ? 1 : 0, rnd() > 0.15 ? 1 : rnd() > 0.5 ? 0 : -1]);

  // Where the people are.
  let cx = 0;
  let cz = 0;
  if (place === "wall") {
    cx = -0.35 - rnd() * 0.8; // backed against the west face
    cz = (rnd() - 0.5) * 30;
  } else if (place === "corner") {
    cx = -0.4 - rnd() * 0.6;
    cz = 0.4 + rnd() * 0.6;
  } else if (place === "deck") {
    cx = (rnd() - 0.5) * 20; // on the deck, 8-20 m in from its edge
    cz = -8 - rnd() * 12;
  }
  const taken: Array<[number, number, number]> = [];
  const list: AgentState[] = [];
  const walkers: Array<[number, number]> = [];
  const n = crowd === "single" ? 1 : crowd === "group" ? 20 : 1 + Math.floor(rnd() * 3);
  let childAt = Math.floor(rnd() * CHILD_IDS.length);
  for (let i = 0; i < n; i++) {
    let x = cx;
    let z = cz;
    const kind: AgentKind = crowd === "group" && i % 7 === 6 ? (i % 2 ? "errandRobot" : "sidewalkBot") : "person";
    const r = crowd === "players" ? FOOT.radius : AGENT_SPEC[kind].radius;
    for (let k = 0; k < 200; k++) {
      if (i > 0 || k > 0) {
        const spread = crowd === "group" ? 4.5 : 3;
        x = cx + (rnd() - 0.5) * 2 * spread;
        z = cz + (rnd() - 0.5) * 2 * spread;
      }
      if ((place === "deck" ? onDeck(x, z, r) : free(world, taken, x, z, r)) && apart(taken, x, z, r)) break;
    }
    taken.push([x, z, r]);
    if (crowd === "players") walkers.push([x, z]);
    else {
      // Every third person in a group is a child (an id personIsChild says is one).
      const child = kind === "person" && crowd === "group" && i % 3 === 0;
      const id = child ? CHILD_IDS[childAt++ % CHILD_IDS.length]! : AGENT_ID0 + 4000 + seed * 64 + i;
      list.push(agent(world, id, kind, x, z));
    }
  }
  list.sort((a, b) => a.id - b.id);
  // Unique ids (a child id may repeat across a group of many).
  const seen = new Set<number>();
  const agents = list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));

  // The car: aimed at the crowd from 25-90 m, at 8-38 m/s, from a direction the place allows.
  const dist = 25 + rnd() * 65;
  let bearing: number;
  if (place === "wall") bearing = Math.PI / 2 + (rnd() - 0.5) * 2.6; // from the west half-plane, toward the wall or along it
  else if (place === "corner") bearing = Math.PI * 0.75 + (rnd() - 0.5) * 1.2; // from the south-west, into the corner
  else if (place === "deck") bearing = (rnd() - 0.5) * 1.2; // from the south, up onto the deck
  else bearing = rnd() * Math.PI * 2;
  const speed = 8 + rnd() * 30;
  const offset = (rnd() - 0.5) * 3;
  const fx = Math.sin(bearing);
  const fz = -Math.cos(bearing);
  const sx = cx - fx * dist + -fz * offset;
  const sz = cz - fz * dist + fx * offset;
  const ids = ["car", ...walkers.map((_, i) => `w${i}`)];
  let s = createInitialState(world, seed, ids, { x: 0, z: 5000, heading: 0 });
  const players = { ...s.players };
  players.car = { ...players.car!, car: { ...makeCar(sx, sz, bearing, meshGroundHeight(world, sx, sz)), speed } };
  walkers.forEach(([x, z], i) => {
    const y = place === "deck" ? DECK_Y : meshGroundHeight(world, x, z);
    players[`w${i}`] = { ...players[`w${i}`]!, mode: "foot", car: makeCar(3000 + 10 * i, 3000, 0), foot: makeFoot(x, y, z, rnd() * 6.28) };
  });
  const ext: AgentsExt = { nextId: 100000, list: agents };
  s = { ...s, players, ext: { ...s.ext, agents: ext } };
  const target = walkers.length > 0 ? "pw0" : `a${agents[Math.floor(rnd() * agents.length)]!.id}`;
  return { name: `#${seed} ${place} ${crowd} ${driver} ${speed.toFixed(0)} m/s from ${dist.toFixed(0)} m`, world, state: s, driver, target, ticks: 330, at, lock, ctl };
}

/** Where the driver's target is now. */
export function targetOf(s: SimState, target: string): { x: number; z: number } {
  if (target.startsWith("p")) {
    const f = s.players[target.slice(1)]!.foot!;
    return { x: f.x, z: f.z };
  }
  const id = Number(target.slice(1));
  const a = agentsOf(s).find((g) => g.id === id)!;
  return { x: a.x, z: a.z };
}

export function drive(sc: Scene, t: number, s: SimState): InputFrame {
  const c = s.players.car!.car;
  const tg = targetOf(s, sc.target);
  const want = Math.atan2(tg.x - c.x, -(tg.z - c.z));
  let err = want - c.heading;
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  const d = Math.hypot(tg.x - c.x, tg.z - c.z);
  const aim = Math.max(-1, Math.min(1, err * 3));
  let steer = 0;
  let brake = 0;
  switch (sc.driver) {
    case "straight":
      steer = 0;
      break;
    case "chase":
      steer = aim;
      break;
    case "weave":
      steer = Math.max(-1, Math.min(1, aim + Math.sin(t / 9) * 0.6));
      break;
    case "drift":
      // Brake and steer hard toward them from 30 m: a slide.
      steer = d < 30 ? (err >= 0 ? 1 : -1) : aim;
      brake = d < 30 && d > 6 ? 1 : 0;
      break;
    case "handbrake":
      // A handbrake turn close by: full lock and the brake.
      steer = d < 18 ? 1 : aim;
      brake = d < 18 ? 1 : 0;
      break;
    case "bank": {
      // Up beside them (aimed 3 m off them), then at `at` m short a slide (full lock and the
      // brake) or a hard turn (0.6 lock) toward them; `lock` < 0 the other way.
      const side = err >= 0 ? 1 : -1;
      if (d > sc.at) {
        // (The car's right is (cos h, sin h): aim 3 m to the other side of them.)
        const ax = tg.x - Math.cos(c.heading) * 3 * side;
        const az = tg.z - Math.sin(c.heading) * 3 * side;
        let e2 = Math.atan2(ax - c.x, -(az - c.z)) - c.heading;
        while (e2 > Math.PI) e2 -= 2 * Math.PI;
        while (e2 < -Math.PI) e2 += 2 * Math.PI;
        steer = Math.max(-1, Math.min(1, e2 * 3));
      } else {
        steer = side * sc.lock;
        brake = Math.abs(sc.lock) > 0.9 ? 1 : 0;
      }
      break;
    }
    case "random": {
      const [st, br, th] = sc.ctl[Math.floor(t / 6) % sc.ctl.length]!;
      return { car: { throttle: th, steer: st, brake: br, actions: 0 } };
    }
  }
  return { car: { throttle: 1, steer, brake, actions: 0 } };
}

export interface Body {
  key: string;
  x: number;
  z: number;
  r: number;
  guarded: boolean;
  child: boolean;
  leapt: boolean;
}

export function bodies(s: SimState): Body[] {
  const out: Body[] = [];
  for (const id of Object.keys(s.players).sort()) {
    const p = s.players[id]!;
    if (p.mode === "foot" && p.foot) out.push({ key: `p${id}`, x: p.foot.x, z: p.foot.z, r: FOOT.radius, guarded: true, child: false, leapt: p.foot.dodge?.leap === true && p.foot.dodge.t === 0 });
  }
  for (const a of agentsOf(s)) {
    const cls = agentDodgeClass(a);
    if (!cls) continue;
    out.push({ key: `a${a.id}`, x: a.x, z: a.z, r: AGENT_SPEC[a.kind].radius, guarded: DODGE_PROFILE[cls].override !== null, child: cls === "care", leapt: a.dodge?.leap === true && a.dodge.t === 0 });
  }
  return out;
}

export interface Result {
  hash: string;
  /** Contacts: counted here (a body inside the car's box), by the sim (ext.dodge) and on the car (personBumps). */
  contacts: number;
  overrides: number;
  dives: number;
  /** Close ticks (clearance under CLEARANCE_M) no override episode explains: must be none. */
  unexplained: string[];
  minClear: number;
  minChild: number;
  robotHits: number;
}

export function run(sc: Scene): Result {
  let s = sc.state;
  const close: Array<{ key: string; tick: number; clear: number }> = [];
  const overridden = new Map<string, number[]>();
  let contacts = 0;
  let bumps = 0;
  let minClear = Infinity;
  let minChild = Infinity;
  for (let t = 0; t < sc.ticks; t++) {
    s = step(sc.world, s, drive(sc, t, s));
    const c = s.players.car!.car;
    bumps = Math.max(bumps, c.personBumps);
    const moving = Math.hypot(c.speed, c.lateral) > MOVING;
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    for (const b of bodies(s)) {
      if (b.leapt) overridden.set(b.key, [...(overridden.get(b.key) ?? []), s.tick]);
      if (!b.guarded) continue;
      const clear = boxDistance(b.x, b.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - b.r;
      if (clear < 0) contacts++;
      if (!moving) continue;
      minClear = Math.min(minClear, clear);
      if (b.child) minChild = Math.min(minChild, clear);
      if (clear < CLEARANCE_M) close.push({ key: b.key, tick: s.tick, clear });
    }
  }
  const unexplained = close
    .filter((e) => !(overridden.get(e.key) ?? []).some((o) => e.tick >= o - EPISODE_BEFORE && e.tick <= o + EPISODE_AFTER))
    .map((e) => `${sc.name}: ${e.key} at tick ${e.tick} only ${e.clear.toFixed(3)} m`);
  const d = dodgeExtOf(s);
  return { hash: hashState(s), contacts: contacts + d.contacts + bumps, overrides: d.overrides, dives: d.dives, unexplained, minClear, minChild, robotHits: s.players.car!.car.hits };
}

