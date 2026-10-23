// A seeded optimiser that hunts for a driver who can touch someone (the adversarial review's
// method, 2026-10-21: fixed drivers did not find the holes it found). A genome is a car's start
// (12-82 m away, from any bearing, at 6-38 m/s, sliding up to 8 m/s sideways and yawing up to
// 1.5 rad/s), where 2-4 people stand (backed against a wall, in a corner, in an alley 3.4 m wide,
// on a low deck the car can drive onto, or in the open) and the controls (steer, brake, throttle
// every 0.1 s for 3 s). It is scored by contacts first (a person inside the car's body, by an
// independent count and the sim's own), then by the least "reach" (the clearance from the car's
// body after its move to where each person stood the tick before: how close a car came to
// catching someone standing still), then the least clearance; a (1+1) evolution with restarts
// minimises the score. tests/sim/dodge-soak.nightly.ts runs it (pnpm soak:nightly); it must find
// no contact at all, and the override must never give up.

import {
  AGENT_SPEC,
  CAR,
  boxBlocked,
  boxDistance,
  buildWorld,
  circleBlocked,
  createInitialState,
  dodgeExtOf,
  makeCar,
  makeFoot,
  meshGroundHeight,
  step,
  type AgentState,
  type BuildingCollider,
  type SimState,
  type World,
} from "../../src/sim/index.ts";

export type Family = "flat" | "wall" | "corner" | "alley" | "deck";

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 12): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

const DECK_Y = 0.4;
const WORLDS: Record<Family, World> = {
  flat: buildWorld([{ tileId: "e", buildings: [], ground: null }]),
  wall: buildWorld([{ tileId: "w", buildings: [rect("wall", 0, -300, 30, 300)], ground: null }]),
  corner: buildWorld([{ tileId: "c", buildings: [rect("east", 0, -60, 30, 60), rect("north", -60, -30, 0, 0)], ground: null }]),
  alley: buildWorld([{ tileId: "a", buildings: [rect("w", -40, -200, -1.7, 200), rect("e", 1.7, -200, 40, 200)], ground: null }]),
  deck: buildWorld([{ tileId: "d", buildings: [rect("deck", -40, -40, 40, 40, DECK_Y)], ground: null }]),
};

const SEG = 6;
const NSEG = 30;

export interface Outcome {
  /** People inside the car's body (independent count over the run), the sim's own count, and override failures. */
  contacts: number;
  simContacts: number;
  failures: number;
  overrides: number;
  /** Least clearance of where someone stood a tick before from the car's body after its move (a moving car). */
  reach: number;
  /** Least clearance from the moving car. */
  minClear: number;
}

interface Decoded {
  dist: number;
  bearing: number;
  speed: number;
  lateral: number;
  yawRate: number;
  offset: number;
  people: Array<[number, number]>;
  ctl: Array<[number, number, number]>;
}

function decode(family: Family, p: readonly number[], np: number): Decoded {
  let i = 0;
  const g = (): number => Math.min(1, Math.max(0, p[i++] ?? 0));
  const dist = 12 + g() * 70;
  let bearing = g() * Math.PI * 2;
  const speed = 6 + g() * 32;
  const lateral = (g() - 0.5) * 16;
  const yawRate = (g() - 0.5) * 3;
  const offset = (g() - 0.5) * 6;
  const people: Array<[number, number]> = [];
  for (let k = 0; k < np; k++) {
    let x = (g() - 0.5) * 8;
    let z = (g() - 0.5) * 8;
    if (family === "wall") x = -0.31 - Math.abs(x) * 0.5;
    if (family === "corner") {
      x = -0.31 - Math.abs(x) * 0.4;
      z = 0.31 + Math.abs(z) * 0.4;
    }
    if (family === "alley") x = Math.max(-1.35, Math.min(1.35, x * 0.35));
    people.push([x, z]);
  }
  // Down the alley, one way or the other.
  if (family === "alley") bearing = bearing < Math.PI ? 0 : Math.PI;
  const ctl: Array<[number, number, number]> = [];
  for (let k = 0; k < NSEG; k++) ctl.push([g() * 2 - 1, g() > 0.75 ? 1 : 0, g() > 0.15 ? 1 : g() > 0.5 ? 0 : -1]);
  return { dist, bearing, speed, lateral, yawRate, offset, people, ctl };
}

function agentAt(world: World, id: number, x: number, z: number): AgentState {
  return {
    id, kind: "person", x, y: meshGroundHeight(world, x, z), z, heading: 0, pitch: 0, speed: 0, vmax: 1.3,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id, dodge: null,
  };
}

/** The scene a genome describes, or null when it puts the car in a building or nobody anywhere. */
function build(family: Family, d: Decoded): SimState | null {
  const world = WORLDS[family];
  const fx = Math.sin(d.bearing);
  const fz = -Math.cos(d.bearing);
  const k = family === "alley" ? 0.1 : 1;
  const sx = -fx * d.dist - fz * d.offset * k;
  const sz = -fz * d.dist + fx * d.offset * k;
  if (boxBlocked(world, { x: sx, z: sz, heading: d.bearing, hl: CAR.halfLength, hw: CAR.halfWidth }, 0)) return null;
  const ids = family === "deck" ? ["c", ...d.people.map((_, i) => `w${i}`)] : ["c"];
  let s = createInitialState(world, 1, ids, { x: 0, z: 9000, heading: 0 });
  const players = { ...s.players };
  players.c = { ...players.c!, car: { ...makeCar(sx, sz, d.bearing, meshGroundHeight(world, sx, sz)), speed: d.speed, lateral: d.lateral, yawRate: d.yawRate } };
  const list: AgentState[] = [];
  let placed = 0;
  d.people.forEach(([x, z], i) => {
    const taken: Array<[number, number]> = list.map((a) => [a.x, a.z]);
    for (const id of Object.keys(players)) {
      const f = players[id]!.foot;
      if (players[id]!.mode === "foot" && f) taken.push([f.x, f.z]);
    }
    if (taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 0.75)) return;
    if (family === "deck") {
      // Players on foot on the deck (people the car drives up onto).
      players[`w${i}`] = { ...players[`w${i}`]!, mode: "foot", car: makeCar(5000 + 10 * i, 5000, 0), foot: makeFoot(x, DECK_Y, z, 0) };
      placed++;
      return;
    }
    if (circleBlocked(world, x, z, 0.32)) return;
    list.push(agentAt(world, 9000 + i, x, z));
    placed++;
  });
  if (family === "deck") for (const id of Object.keys(players)) if (id.startsWith("w") && players[id]!.mode !== "foot") delete players[id];
  if (placed === 0) return null;
  s = { ...s, players, ext: { ...s.ext, agents: { nextId: 1_000_000, list } } };
  return s;
}

/** The people (agents, and players on foot) as bodies: key, position, radius. */
function people(s: SimState): Array<{ key: string; x: number; z: number; r: number }> {
  const out: Array<{ key: string; x: number; z: number; r: number }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const f = s.players[id]!.foot;
    if (s.players[id]!.mode === "foot" && f) out.push({ key: id, x: f.x, z: f.z, r: 0.35 });
  }
  const list = ((s.ext.agents as { list?: AgentState[] } | undefined)?.list ?? []) as AgentState[];
  for (const a of list) if (a.kind === "person") out.push({ key: `a${a.id}`, x: a.x, z: a.z, r: AGENT_SPEC.person.radius });
  return out;
}

/** Run one genome and measure it. */
export function evaluate(family: Family, p: readonly number[], np: number): Outcome {
  const d = decode(family, p, np);
  const s0 = build(family, d);
  const none: Outcome = { contacts: 0, simContacts: 0, failures: 0, overrides: 0, reach: 99, minClear: 99 };
  if (!s0) return none;
  const world = WORLDS[family];
  let s = s0;
  let prev = new Map(people(s).map((b) => [b.key, b]));
  const out = { ...none };
  for (let t = 0; t < SEG * NSEG; t++) {
    const [steer, brake, throttle] = d.ctl[Math.floor(t / SEG)]!;
    s = step(world, s, { c: { throttle, steer, brake, actions: 0 } });
    const c = s.players.c!.car;
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    const moving = Math.hypot(c.speed, c.lateral) > 1;
    const now = people(s);
    for (const b of now) {
      const clear = boxDistance(b.x, b.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - b.r;
      if (clear < 0) out.contacts++;
      if (!moving) continue;
      if (clear < out.minClear) out.minClear = clear;
      const was = prev.get(b.key);
      if (was) {
        const reach = boxDistance(was.x, was.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - b.r;
        if (reach < out.reach) out.reach = reach;
      }
    }
    prev = new Map(now.map((b) => [b.key, b]));
  }
  const e = dodgeExtOf(s);
  out.simContacts = e.contacts;
  out.failures = e.failures;
  out.overrides = e.overrides;
  return out;
}

/** Lower is better: contacts dominate, then how close a car came to catching someone standing still. */
function score(o: Outcome): number {
  return -1000 * (o.contacts + o.simContacts + o.failures) + o.reach * 3 + o.minClear;
}

export interface Search {
  family: Family;
  evals: number;
  /** Runs with a contact (any count) or an override failure: must be 0. */
  found: number;
  /** The first few such genomes (to replay). */
  hits: number[][];
  best: Outcome;
  overrides: number;
}

/** A seeded (1+1) search with restarts every `restart` evaluations. Deterministic for a seed. */
export function search(family: Family, seed: number, evals: number, np = 3, restart = 120): Search {
  let rs = (seed * 2654435761) >>> 0 || 1;
  const rnd = (): number => {
    rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
    return rs / 4294967296;
  };
  const gauss = (): number => {
    let u = 0;
    for (let i = 0; i < 6; i++) u += rnd();
    return u - 3;
  };
  const dim = 6 + np * 2 + NSEG * 3;
  const out: Search = { family, evals: 0, found: 0, hits: [], best: { contacts: 0, simContacts: 0, failures: 0, overrides: 0, reach: 99, minClear: 99 }, overrides: 0 };
  let bestScore = Infinity;
  const note = (p: number[], o: Outcome): number => {
    out.evals++;
    out.overrides += o.overrides;
    if (o.contacts + o.simContacts + o.failures > 0) {
      out.found++;
      if (out.hits.length < 5) out.hits.push(p);
    }
    const sc = score(o);
    if (sc < bestScore) {
      bestScore = sc;
      out.best = o;
    }
    return sc;
  };
  while (out.evals < evals) {
    let cur = Array.from({ length: dim }, () => rnd());
    let cs = note(cur, evaluate(family, cur, np));
    let sigma = 0.15;
    for (let it = 0; it < restart && out.evals < evals; it++) {
      const cand = cur.map((v) => (rnd() < 0.3 ? Math.min(1, Math.max(0, v + gauss() * sigma)) : v));
      const sc = note(cand, evaluate(family, cand, np));
      if (sc <= cs) {
        cur = cand;
        cs = sc;
        sigma = Math.min(0.4, sigma * 1.1);
      } else sigma = Math.max(0.01, sigma * 0.97);
    }
  }
  return out;
}
