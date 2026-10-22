// The multi-vehicle optimiser (the adversarial review's, round 3, 2026-10-22): two or three
// player cars, a stopped car or a standing robotaxi, people (agents) and players on foot walking
// about, in places the single-car optimiser (tests/sim/dodge-optimiser.ts) does not reach: two
// cars converging, head-on down a 3.4 m alley, cars round a stopped car near a wall with people
// between, a car at a standing robotaxi with people beside it, over a crest, people ringed round a
// parked car. A genome is each car's start (8-53 m away, at 5-38 m/s, sliding, yawing), how much
// it chases a target and its controls every 0.1 s for 4 s; where the people and players on foot
// stand, and the players' controls. It is scored by contacts (an independent count of a body
// inside a vehicle's body after each tick, the sim's own, personBumps and the override's
// failures), then by how close a moving vehicle came to where someone stood the tick before; a
// (1+1) evolution with restarts minimises the score. Its recorded hits (people landing on players
// on foot and shoving them into a stopped car) replay in tests/sim/dodge-review-r3.test.ts; the
// nightly (tests/sim/dodge-soak.nightly.ts) searches every family and must find no contact.

import {
  AGENT_SPEC,
  CAR,
  FOOT,
  ROBOTAXI_BODY,
  agentsOf,
  boxBlocked,
  buildWorld,
  circleBlocked,
  createInitialState,
  dodgeExtOf,
  makeCar,
  makeFoot,
  meshGroundHeight,
  step,
  type AgentKind,
  type AgentState,
  type BuildingCollider,
  type InputFrame,
  type SimState,
  type World,
} from "../../src/sim/index.ts";

export type MultiFamily = "shove" | "corner3" | "flat3" | "alley2" | "taxi" | "crest" | "walkers" | "ring";
export const MULTI_FAMILIES: readonly MultiFamily[] = ["shove", "corner3", "flat3", "alley2", "taxi", "crest", "walkers", "ring"];

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 12): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

function flatWorld(buildings: BuildingCollider[] = []): World {
  return buildWorld([{ tileId: "t", buildings, ground: null }]);
}

function crestWorld(): World {
  // A ridge along z = 0: the ground rises 0.35 per metre from z = 30 to z = 4, flat-topped to z = -4, then drops 0.6 per metre.
  const r = 120;
  const cell = 1;
  const n = Math.round((2 * r) / cell) + 1;
  const heights: number[] = [];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const z = -r + iz * cell;
      let h = 0;
      if (z <= 30 && z > 4) h = (30 - z) * 0.35;
      else if (z <= 4 && z >= -4) h = 26 * 0.35;
      else if (z < -4) h = Math.max(0, 26 * 0.35 - (-4 - z) * 0.6);
      heights.push(h);
    }
  }
  return buildWorld([{ tileId: "crest", buildings: [], ground: { x0: -r, z0: -r, cellSizeM: cell, nx: n, nz: n, heights } }]);
}

let worlds: Record<MultiFamily, World> | null = null;
function worldOf(fam: MultiFamily): World {
  worlds ??= {
    shove: flatWorld([rect("wall", 0, -300, 30, 300)]),
    corner3: flatWorld([rect("east", 0, -60, 30, 60), rect("north", -60, -30, 0, 0)]),
    flat3: flatWorld(),
    alley2: flatWorld([rect("w", -40, -200, -1.7, 200), rect("e", 1.7, -200, 40, 200)]),
    taxi: flatWorld([rect("wall", 0, -300, 30, 300)]),
    crest: crestWorld(),
    walkers: flatWorld([rect("wall", 0, -300, 30, 300), rect("blk", -30, -40, -12, -20)]),
    ring: flatWorld(),
  };
  return worlds[fam];
}

function agent(world: World, id: number, kind: AgentKind, x: number, z: number, heading = 0, speed = 0): AgentState {
  return {
    id,
    kind,
    x,
    y: meshGroundHeight(world, x, z),
    z,
    heading,
    pitch: 0,
    speed,
    vmax: kind === "robotaxi" ? 12 : 1.3,
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

/** Distance from (px, pz) to a box (centre, compass heading, half extents), negative inside. */
function boxDist(px: number, pz: number, x: number, z: number, heading: number, hl: number, hw: number): number {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const ox = px - x;
  const oz = pz - z;
  const along = ox * fx + oz * fz;
  const lat = -ox * fz + oz * fx;
  const dl = Math.abs(lat) - hw;
  const df = Math.abs(along) - hl;
  if (dl <= 0 && df <= 0) return Math.max(dl, df);
  return Math.hypot(Math.max(dl, 0), Math.max(df, 0));
}

const SEG = 6;
const NSEG = 40;
const NCAR = 3;
const NPEOPLE = 4;
const NWALK = 2;
const CAR_GENES = 8 + NSEG * 3;
const PEOPLE_GENES = NPEOPLE * 2;
const WALK_GENES = NWALK * 2 + NSEG * 3;
export const MULTI_DIM = 4 + NCAR * CAR_GENES + PEOPLE_GENES + WALK_GENES;

interface CarG {
  dist: number;
  bearing: number;
  speed: number;
  lateral: number;
  yaw: number;
  offset: number;
  chase: number;
  target: number;
  ctl: Array<[number, number, number]>;
}

interface Decoded {
  ncar: number;
  stoppedGap: number;
  stoppedZ: number;
  nwalk: number;
  cars: CarG[];
  people: Array<[number, number]>;
  walkers: Array<[number, number]>;
  wctl: Array<[number, number, number]>;
}

function decode(fam: MultiFamily, p: readonly number[]): Decoded {
  let i = 0;
  const g = (): number => Math.min(1, Math.max(0, p[i++] ?? 0));
  const ncar = fam === "alley2" ? 2 : 2 + Math.floor(g() * 1.999);
  const stoppedGap = 0.7 + g() * 1.0;
  const stoppedZ = (g() - 0.5) * 6;
  const nwalkG = g();
  const nwalk = fam === "walkers" ? 2 : Math.floor(nwalkG * 2.999);
  const cars: CarG[] = [];
  for (let c = 0; c < NCAR; c++) {
    const dist = 8 + g() * 45;
    let bearing = g() * Math.PI * 2;
    if (fam === "shove" || fam === "taxi" || fam === "walkers") bearing = Math.PI / 2 + (bearing / (Math.PI * 2) - 0.5) * 2.8;
    if (fam === "corner3") bearing = Math.PI * 0.25 + (bearing / (Math.PI * 2) - 0.5) * 1.6;
    if (fam === "alley2") bearing = c === 0 ? 0 : Math.PI;
    if (fam === "crest") bearing = (bearing / (Math.PI * 2) - 0.5) * 0.8; // from the south, up and over the crest
    const speed = 5 + g() * 33;
    const lateral = (g() - 0.5) * 12;
    const yaw = (g() - 0.5) * 3;
    const offset = (g() - 0.5) * 6;
    const chase = g();
    const target = g();
    const ctl: Array<[number, number, number]> = [];
    for (let k = 0; k < NSEG; k++) ctl.push([g() * 2 - 1, g() > 0.75 ? 1 : 0, g() > 0.15 ? 1 : g() > 0.5 ? 0 : -1]);
    cars.push({ dist: fam === "crest" ? 40 + dist : dist, bearing, speed, lateral, yaw, offset, chase, target, ctl });
  }
  const people: Array<[number, number]> = [];
  for (let k = 0; k < NPEOPLE; k++) {
    let x = (g() - 0.5) * 8;
    let z = (g() - 0.5) * 8;
    if (fam === "shove" || fam === "taxi") {
      // Between the stopped vehicle and the wall, or just beside it.
      x = k < 2 ? -0.31 - Math.abs(x / 4) * (stoppedGap - 0.62) : -(stoppedGap + 0.95 * 2) - 0.31 - Math.abs(x) * 0.3;
      z = stoppedZ + z * 0.8;
    }
    if (fam === "ring") {
      // Around the stopped car (centre (sx, stoppedZ), heading 0, 1.9 x 4.4 m), 0.04-0.5 m off its body.
      const sxr = -(stoppedGap + 0.95);
      const ang = (x / 8 + 0.5) * Math.PI * 2;
      const off = 0.04 + Math.abs(z) / 8;
      const ex = Math.sin(ang);
      const ez = -Math.cos(ang);
      const tb = Math.min(Math.abs(ex) > 1e-6 ? 0.95 / Math.abs(ex) : 99, Math.abs(ez) > 1e-6 ? 2.2 / Math.abs(ez) : 99);
      x = sxr + ex * (tb + off + 0.3);
      z = stoppedZ + ez * (tb + off + 0.3);
    }
    if (fam === "corner3") {
      x = -0.31 - Math.abs(x) * 0.4;
      z = 0.31 + Math.abs(z) * 0.4;
    }
    if (fam === "alley2") x = Math.max(-1.35, Math.min(1.35, x * 0.35));
    if (fam === "crest") z = -6 - Math.abs(z) * 1.5; // just over the crest, on the far slope
    if (fam === "walkers") x = -0.31 - Math.abs(x) * 0.6;
    people.push([x, z]);
  }
  const walkers: Array<[number, number]> = [];
  for (let k = 0; k < NWALK; k++) {
    let x = (g() - 0.5) * 10;
    const z = (g() - 0.5) * 10;
    if (fam === "shove" || fam === "taxi" || fam === "walkers") x = -0.4 - Math.abs(x) * 0.5;
    if (fam === "alley2") x = Math.max(-1.3, Math.min(1.3, x * 0.25));
    walkers.push([x, z]);
  }
  const wctl: Array<[number, number, number]> = [];
  for (let k = 0; k < NSEG; k++) wctl.push([g() * 2 - 1, g() * 2 - 0.6, g()]);
  return { ncar, stoppedGap, stoppedZ, nwalk, cars, people, walkers, wctl };
}

function build(fam: MultiFamily, d: Decoded): { s: SimState; targets: string[] } | null {
  const world = worldOf(fam);
  const ids: string[] = [];
  for (let c = 0; c < d.ncar; c++) ids.push(`c${c}`);
  if (fam === "shove" || fam === "ring") ids.push("s");
  for (let w = 0; w < d.nwalk; w++) ids.push(`w${w}`);
  let s = createInitialState(world, 1, ids, { x: 0, z: 9000, heading: 0 });
  const players = { ...s.players };
  const list: AgentState[] = [];
  const taken: Array<[number, number, number]> = [];
  const free = (x: number, z: number, r: number): boolean => !circleBlocked(world, x, z, r + 0.01) && taken.every(([tx, tz, tr]) => Math.hypot(tx - x, tz - z) > tr + r + 0.1);
  // The stopped vehicle (a player's car, the player in it; or a robotaxi standing).
  const sx = -(d.stoppedGap + 0.95);
  if (fam === "shove" || fam === "ring") {
    players.s = { ...players.s!, car: makeCar(sx, d.stoppedZ, 0) };
    taken.push([sx, d.stoppedZ - 1.25, 0.95], [sx, d.stoppedZ, 0.95], [sx, d.stoppedZ + 1.25, 0.95]);
  }
  if (fam === "taxi") {
    const tx = -(d.stoppedGap + 1.0);
    list.push(agent(world, 50, "robotaxi", tx, d.stoppedZ, 0, 0));
    taken.push([tx, d.stoppedZ - 1.4, 1.05], [tx, d.stoppedZ, 1.05], [tx, d.stoppedZ + 1.4, 1.05]);
  }
  const targets: string[] = [];
  const inStopped = (x: number, z: number, r: number): boolean => {
    if (fam === "shove" || fam === "ring") return boxDist(x, z, sx, d.stoppedZ, 0, CAR.halfLength, CAR.halfWidth) < r + 0.035;
    if (fam === "taxi") return boxDist(x, z, -(d.stoppedGap + 1.0), d.stoppedZ, 0, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth) < r + 0.12;
    return false;
  };
  d.people.forEach(([x, z], k) => {
    const y = meshGroundHeight(world, x, z);
    if (!free(x, z, 0.3) || inStopped(x, z, 0.3)) return;
    taken.push([x, z, 0.3]);
    const a = agent(world, 9000 + k, "person", x, z);
    list.push({ ...a, y });
    targets.push(`a${9000 + k}`);
  });
  for (let w = 0; w < d.nwalk; w++) {
    const [x, z] = d.walkers[w]!;
    const id = `w${w}`;
    if (!free(x, z, FOOT.radius) || inStopped(x, z, FOOT.radius)) {
      players[id] = { ...players[id]!, car: makeCar(6000 + 10 * w, 6000, 0) };
      continue;
    }
    taken.push([x, z, FOOT.radius]);
    players[id] = { ...players[id]!, mode: "foot", car: makeCar(6000 + 10 * w, 6000, 0), foot: makeFoot(x, meshGroundHeight(world, x, z), z, 0) };
    targets.push(`p${id}`);
  }
  if (targets.length === 0) return null;
  for (let c = 0; c < d.ncar; c++) {
    const cg = d.cars[c]!;
    const fx = Math.sin(cg.bearing);
    const fz = -Math.cos(cg.bearing);
    const k = fam === "alley2" ? 0.1 : 1;
    const ox = fam === "shove" || fam === "taxi" || fam === "ring" ? sx : 0;
    const oz = fam === "shove" || fam === "taxi" || fam === "ring" ? d.stoppedZ : 0;
    const cx = ox - fx * cg.dist - fz * cg.offset * k;
    const cz = oz - fz * cg.dist + fx * cg.offset * k;
    if (boxBlocked(world, { x: cx, z: cz, heading: cg.bearing, hl: CAR.halfLength, hw: CAR.halfWidth }, meshGroundHeight(world, cx, cz))) return null;
    for (const [tx, tz] of taken) if (Math.hypot(tx - cx, tz - cz) < 4) return null;
    for (let o = 0; o < c; o++) {
      const oc = players[`c${o}`]!.car;
      if (Math.hypot(oc.x - cx, oc.z - cz) < 5) return null;
    }
    players[`c${c}`] = { ...players[`c${c}`]!, car: { ...makeCar(cx, cz, cg.bearing, meshGroundHeight(world, cx, cz)), speed: cg.speed, lateral: cg.lateral, yawRate: cg.yaw } };
  }
  list.sort((a, b) => a.id - b.id);
  s = { ...s, players, ext: { ...s.ext, agents: { nextId: 1_000_000, list } } };
  return { s, targets };
}

function posOf(s: SimState, key: string): { x: number; z: number } | null {
  if (key.startsWith("p")) {
    const p = s.players[key.slice(1)];
    return p && p.mode === "foot" && p.foot ? { x: p.foot.x, z: p.foot.z } : null;
  }
  const id = Number(key.slice(1));
  const a = agentsOf(s).find((g) => g.id === id);
  return a ? { x: a.x, z: a.z } : null;
}

function protectedBodies(s: SimState): Array<{ key: string; owner: string | null; x: number; z: number; r: number }> {
  const out: Array<{ key: string; owner: string | null; x: number; z: number; r: number }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const p = s.players[id]!;
    if (p.mode === "foot" && p.foot) out.push({ key: `p${id}`, owner: id, x: p.foot.x, z: p.foot.z, r: FOOT.radius });
  }
  for (const a of agentsOf(s)) if (a.kind === "person") out.push({ key: `a${a.id}`, owner: null, x: a.x, z: a.z, r: AGENT_SPEC.person.radius });
  return out;
}

function vehicleBoxes(s: SimState): Array<{ key: string; owner: string | null; x: number; z: number; h: number; hl: number; hw: number }> {
  const out: Array<{ key: string; owner: string | null; x: number; z: number; h: number; hl: number; hw: number }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const c = s.players[id]!.car;
    out.push({ key: `car${id}`, owner: id, x: c.x, z: c.z, h: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth });
  }
  for (const a of agentsOf(s)) if (a.kind === "robotaxi") out.push({ key: `taxi${a.id}`, owner: null, x: a.x, z: a.z, h: a.heading, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth });
  return out;
}

export interface MultiOutcome {
  /** Bodies inside a vehicle's body after a tick (an independent count), the sim's own count, personBumps, override failures. */
  contacts: number;
  simContacts: number;
  bumps: number;
  failures: number;
  overrides: number;
  /** Least clearance from a vehicle that moved this tick to where someone stood the tick before. */
  reach: number;
  ticks: number;
}

/** Run one genome (an empty outcome when the scene cannot be built: a car in a wall, nobody to aim at). */
export function evaluateMulti(fam: MultiFamily, p: readonly number[]): MultiOutcome {
  const out: MultiOutcome = { contacts: 0, simContacts: 0, bumps: 0, failures: 0, overrides: 0, reach: 99, ticks: 0 };
  const d = decode(fam, p);
  const b = build(fam, d);
  if (!b) return out;
  const world = worldOf(fam);
  let s = b.s;
  let prevBodies = new Map(protectedBodies(s).map((q) => [q.key, q]));
  for (let t = 0; t < SEG * NSEG; t++) {
    const seg = Math.floor(t / SEG);
    const inputs: InputFrame = {};
    for (let c = 0; c < d.ncar; c++) {
      const cg = d.cars[c]!;
      const car = s.players[`c${c}`]!.car;
      const tgt = fam === "ring" && cg.target < 0.6 ? { x: s.players.s!.car.x + (cg.target - 0.3) * 6, z: s.players.s!.car.z + cg.offset } : posOf(s, b.targets[Math.min(b.targets.length - 1, Math.floor(cg.target * b.targets.length))]!);
      let aim = 0;
      if (tgt) {
        let err = Math.atan2(tgt.x - car.x, -(tgt.z - car.z)) - car.heading;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        aim = Math.max(-1, Math.min(1, err * 3));
      }
      const [st, br, th] = cg.ctl[seg]!;
      inputs[`c${c}`] = { throttle: th, steer: Math.max(-1, Math.min(1, cg.chase * aim + (1 - cg.chase) * st)), brake: br, actions: 0 };
    }
    for (let w = 0; w < d.nwalk; w++) {
      const [st, th, sp] = d.wctl[seg]!;
      inputs[`w${w}`] = { throttle: Math.max(-1, Math.min(1, th)), steer: st, brake: sp > 0.5 ? 1 : 0, actions: 0 };
    }
    const before = s;
    s = step(world, s, inputs);
    out.ticks++;
    const vs = vehicleBoxes(s);
    const vsBefore = new Map(vehicleBoxes(before).map((v) => [v.key, v]));
    const moved = (v: { key: string; x: number; z: number; h: number }): boolean => {
      const w = vsBefore.get(v.key);
      return !!w && (Math.hypot(v.x - w.x, v.z - w.z) > 0.005 || Math.abs(v.h - w.h) > 0.002);
    };
    const now = protectedBodies(s);
    for (const q of now) {
      for (const v of vs) {
        if (v.owner !== null && v.owner === q.owner) continue;
        if (Math.abs(q.x - v.x) > 8 || Math.abs(q.z - v.z) > 8) continue;
        if (boxDist(q.x, q.z, v.x, v.z, v.h, v.hl, v.hw) - q.r < 0) out.contacts++;
        const was = prevBodies.get(q.key);
        if (was && moved(v)) out.reach = Math.min(out.reach, boxDist(was.x, was.z, v.x, v.z, v.h, v.hl, v.hw) - q.r);
      }
    }
    prevBodies = new Map(now.map((q) => [q.key, q]));
  }
  const e = dodgeExtOf(s);
  out.simContacts = e.contacts;
  out.failures = e.failures;
  out.overrides = e.overrides;
  for (const id of Object.keys(s.players)) out.bumps += s.players[id]!.car.personBumps;
  return out;
}

/** A recorded genome, replayed (tests/sim/dodge-review-r3-hits.json). */
export function replayMultiHit(fam: MultiFamily, genes: readonly number[]): MultiOutcome {
  return evaluateMulti(fam, genes);
}

function score(o: MultiOutcome): number {
  return -1000 * (o.contacts + o.simContacts + o.failures + o.bumps) + o.reach * 3;
}

export interface MultiSearch {
  family: MultiFamily;
  evals: number;
  /** Genomes that built a scene. */
  valid: number;
  /** Genomes with any contact, personBump or override failure, and the first few of them. */
  found: number;
  hits: number[][];
  overrides: number;
  best: MultiOutcome;
}

/** A seeded (1+1) evolution with restarts, `evals` genomes in all. */
export function searchMulti(fam: MultiFamily, seed: number, evals: number, restart = 150): MultiSearch {
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
  const out: MultiSearch = { family: fam, evals: 0, valid: 0, found: 0, hits: [], overrides: 0, best: { contacts: 0, simContacts: 0, bumps: 0, failures: 0, overrides: 0, reach: 99, ticks: 0 } };
  let bestScore = Infinity;
  const note = (p: number[], o: MultiOutcome): number => {
    out.evals++;
    if (o.ticks > 0) out.valid++;
    out.overrides += o.overrides;
    if (o.contacts + o.simContacts + o.failures + o.bumps > 0) {
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
    let cur = Array.from({ length: MULTI_DIM }, () => rnd());
    let cs = note(cur, evaluateMulti(fam, cur));
    let sigma = 0.15;
    for (let it = 0; it < restart && out.evals < evals; it++) {
      const cand = cur.map((v) => (rnd() < 0.2 ? Math.min(1, Math.max(0, v + gauss() * sigma)) : v));
      const sc = note(cand, evaluateMulti(fam, cand));
      if (sc <= cs) {
        cur = cand;
        cs = sc;
        sigma = Math.min(0.4, sigma * 1.1);
      } else sigma = Math.max(0.01, sigma * 0.97);
    }
  }
  return out;
}
