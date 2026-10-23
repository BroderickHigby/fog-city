// Impacts: cars that hit each other shove, spin and dent (the owner's request, 2026-10-23: "you
// should be able to hit cars as well"). Pure and deterministic; step.ts runs it once a tick,
// after the players' cars and the agents have moved and before the dodge.
//
//  - A player's car meets other cars and robotaxis as bodies it can shove (step.ts gives their
//    circles a `body`): car.ts exchanges momentum with them along the contact normal and reports
//    each hit (CarContact). Here the other body takes the opposite impulse: another player's car
//    that is driving takes its own share in its own stepCar (both see the same start-of-tick
//    velocities), a parked one (its player on foot) and a robotaxi take it here.
//  - A robotaxi that takes an impulse is knocked off its lane (AgentState.knock): it slides and
//    spins on locked tyres (slideBox), shoving whatever it slides into (another robotaxi is
//    knocked in turn, a player's car takes the reaction), stops, sits a moment with its hazards
//    on and its horn going (mode "honk"), turns in place toward its lane if it has to, and then
//    rejoins its lane on a connector from where it stands (heading unchanged, so it never jumps).
//    While knocked, stepAgents and the motion bodies leave it alone (step.ts passes it as
//    controlled). One that cannot get back for KNOCK_GIVE_UP_TICKS while nobody is near goes out
//    of service and is removed, as a stuck robotaxi is.
//  - A parked player's car that takes an impulse slides the same way until it stops.
//  - People are never touched: a sliding body meets every person, animal and player on foot as a
//    circle grown by PERSON_CLEAR_M and stops dead against it (the design's "contact is a gentle
//    push that stops the car dead", before any contact). The dodge, run after this, still guards
//    everyone as usual.
//  - Damage: every body's change of velocity in a hit dents the side that was hit (Dents, 0..1)
//    and wears a player's car's condition (0..100, design "Car-to-car contact dents cars"). At 0
//    the car limps (no throttle above WRECK_LIMP_MPS). Until garage repair lands, condition comes
//    back by itself (REPAIR_PER_S after REPAIR_AFTER_TICKS without a hit).
//  - Events: each hit is recorded in ext.impacts.events (the last MAX_EVENTS, with a durable id)
//    for sparks, crunches and barks in the renderer and the audio mixer.
//
// State: ext.impacts (ImpactsExt; absent until the first hit), AgentState.knock and .dents.

import { DT, sortedIds, type CarState, type PlayerId, type SimState } from "./contract.ts";
import { approach, clamp, datan2, dcos, dsin, wrapAngle } from "./dmath.ts";
import { CAR, bodyAfter, bodyHit, carCircles, spinKick, type CarContact } from "./car.ts";
import { boxBlocked, boxCrossedWall, resolveBox, type Circle, type ImpactBody } from "./collide.ts";
import { FOOT } from "./foot.ts";
import { AGENTS_EXT_KEY, AGENT_SPEC, ROBOTAXI_BODY, SPAWN_MIN_PLAYER_M, agentCircles, type AgentState, type AgentsExt } from "./agents.ts";
import { agentDodgeClass } from "./dodge.ts";
import { connector, lanePath, pathPoint, projectOnPath } from "./roads.ts";
import { ROOF_STEP_M, meshGroundHeight, type World } from "./world.ts";

export const IMPACTS_EXT_KEY = "impacts";

/** How dented each side of a body is, 0 (clean) .. 1 (crumpled). */
export interface Dents {
  front: number;
  rear: number;
  left: number;
  right: number;
}

/** A player's car's damage. */
export interface CarDamage extends Dents {
  /** 100 = fresh, 0 = wrecked (limps). */
  condition: number;
  /** The tick of its last hit. */
  lastHitTick: number;
}

export type ImpactKind = "car-car" | "car-taxi" | "taxi-car" | "taxi-taxi";

/** One hit, for sparks, crunches and barks. `a` hit `b` ("p:<player>" or "a:<agent id>"). */
export interface ImpactEvent {
  id: number;
  tick: number;
  kind: ImpactKind;
  a: string;
  b: string;
  x: number;
  y: number;
  z: number;
  /** Closing speed, m/s. */
  speed: number;
  /** The larger change of velocity of the two bodies, m/s (how hard it felt). */
  dv: number;
}

/** state.ext.impacts */
export interface ImpactsExt {
  version: 1;
  /** The next event id (durable across ticks). */
  nextId: number;
  /** The most recent events, oldest first (at most MAX_EVENTS). */
  events: ImpactEvent[];
  cars: Record<PlayerId, CarDamage>;
}

/** A body knocked off its path (AgentState.knock). */
export interface KnockState {
  /** "slide": moving on locked tyres; "stopped": sitting with hazards on; "realign": turning in place toward its lane. */
  phase: "slide" | "stopped" | "realign";
  /** World velocity, m/s, and yaw rate, rad/s (+ = clockwise). */
  vx: number;
  vz: number;
  yaw: number;
  /** Ticks in this phase, and since the knock began. */
  t: number;
  age: number;
}

export const IMPACT = {
  /** Robotaxi mass, kg, and yaw inertia per unit mass, m^2 (its ROBOTAXI_BODY box). */
  taxiMass: 1800,
  taxiK2: 2.42,
  /** A robotaxi whose velocity changes less than this in a hit is only nudged (not knocked off its lane), m/s. */
  knockMinDv: 0.4,
  /** Sliding: braking along the body and tyre scrub across it, m/s^2, and spin damping, rad/s^2. */
  slideBrake: 6.5,
  slideScrub: 10,
  slideYawDamp: 3,
  /** A slide ends below these. */
  stopSpeed: 0.15,
  stopYaw: 0.05,
  /** Restitution off buildings and walls, and the wall friction while sliding. */
  wallRestitution: 0.15,
  wallFriction: 0.25,
  /** Ticks a knocked robotaxi sits (hazards, horn) before it heads back to its lane. */
  stoppedTicks: 100,
  /** Turning in place toward its lane, rad/s; it sets off once within rejoinAngle. */
  realignRate: 0.7,
  rejoinAngle: 0.35,
  /** It rejoins its lane at least this far ahead of where it stands, metres (and twice its distance off). */
  rejoinAheadM: 6,
  /** A knocked robotaxi still off its lane after this long, with no player within SPAWN_MIN_PLAYER_M, is removed. */
  giveUpTicks: 30 * 60,
} as const;

/** People, animals and players on foot are this much bigger to a sliding body, metres (more than the dodge's widest override clearance). */
export const PERSON_CLEAR_M = 0.8;
/** A car's condition: lost per m/s of velocity change above DAMAGE_FREE_DV, and the most one hit takes. */
export const DAMAGE_PER_DV = 4.5;
export const DAMAGE_FREE_DV = 1.5;
export const DAMAGE_MAX_HIT = 45;
/** Dent added to the side hit per m/s of velocity change. */
export const DENT_PER_DV = 1 / 12;
/** A wrecked car (condition 0) gets no throttle above this speed, m/s. */
export const WRECK_LIMP_MPS = 9;
/** Condition comes back REPAIR_PER_S a second once the car has gone REPAIR_AFTER_TICKS without a hit. */
export const REPAIR_AFTER_TICKS = 20 * 60;
export const REPAIR_PER_S = 1;
export const MAX_EVENTS = 24;

// ---------------------------------------------------------------- read helpers

export function impactsOf(state: Readonly<SimState>): ImpactsExt | undefined {
  return state.ext[IMPACTS_EXT_KEY] as ImpactsExt | undefined;
}

/** A player's car's damage (fresh when it has never been hit). */
export function carDamage(state: Readonly<SimState>, id: PlayerId): CarDamage {
  return impactsOf(state)?.cars[id] ?? freshDamage();
}

function freshDamage(): CarDamage {
  return { condition: 100, front: 0, rear: 0, left: 0, right: 0, lastHitTick: 0 };
}

/** The ids of agents knocked off their path (step.ts passes them to stepAgents as controlled). */
export function knockedIds(state: Readonly<SimState>): number[] {
  const out: number[] = [];
  for (const a of (state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? []) if (a.knock) out.push(a.id);
  return out;
}

/** A car's world velocity from its speed and slide. */
export function carVelocity(c: Readonly<Pick<CarState, "heading" | "speed" | "lateral">>): { vx: number; vz: number } {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  return { vx: c.speed * fx - c.lateral * fz, vz: c.speed * fz + c.lateral * fx };
}

/** An agent's world velocity: its knock, else its speed along its heading. */
export function agentVelocity(a: Readonly<AgentState>): { vx: number; vz: number } {
  if (a.knock) return { vx: a.knock.vx, vz: a.knock.vz };
  return { vx: a.speed * dsin(a.heading), vz: -a.speed * dcos(a.heading) };
}

/** A player's car as a body others shove. */
export function carImpactBody(id: PlayerId, c: Readonly<CarState>): ImpactBody {
  const v = carVelocity(c);
  return { key: `p:${id}`, mass: CAR.mass, x: c.x, z: c.z, vx: v.vx, vz: v.vz };
}

/** A road agent (robotaxi, service vehicle) as a body others shove; null for anything else. */
export function agentImpactBody(a: Readonly<AgentState>): ImpactBody | null {
  if (!AGENT_SPEC[a.kind].road) return null;
  const v = agentVelocity(a);
  return { key: `a:${a.id}`, mass: IMPACT.taxiMass, x: a.x, z: a.z, vx: v.vx, vz: v.vz };
}

/** Throttle for a wrecked car: none above WRECK_LIMP_MPS. */
export function limpThrottle(state: Readonly<SimState>, id: PlayerId, c: Readonly<CarState>, throttle: number): number {
  const d = impactsOf(state)?.cars[id];
  if (!d || d.condition > 0 || throttle <= 0) return throttle;
  return c.speed >= WRECK_LIMP_MPS ? 0 : throttle;
}

// ---------------------------------------------------------------- sliding

interface Slider {
  x: number;
  y: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  yaw: number;
}

interface SlideDims {
  hl: number;
  hw: number;
  height: number;
  mass: number;
  k2: number;
}

const TAXI_DIMS: SlideDims = { hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth, height: ROBOTAXI_BODY.height, mass: IMPACT.taxiMass, k2: IMPACT.taxiK2 };
const CAR_DIMS: SlideDims = { hl: CAR.halfLength, hw: CAR.halfWidth, height: CAR.bodyHeight, mass: CAR.mass, k2: CAR.yawK2 };

function dimsOf(a: Readonly<AgentState>): SlideDims {
  return { ...TAXI_DIMS, hl: a.halfLength ?? TAXI_DIMS.hl, hw: a.halfWidth ?? TAXI_DIMS.hw, height: a.height ?? TAXI_DIMS.height };
}

/**
 * One tick of a body sliding on locked tyres: braking along it, scrubbing across it, its spin
 * dying away; held out of buildings, walls and `obstacles` like a car (car.ts). A body it can
 * shove takes a hit (reported in `contacts`, once per body); a person (a circle marked person,
 * already grown by PERSON_CLEAR_M) stops it dead.
 */
function slideBox(world: World, b: Readonly<Slider>, d: Readonly<SlideDims>, obstacles: readonly Circle[], contacts: CarContact[]): Slider {
  let heading = b.heading;
  let fx = dsin(heading);
  let fz = -dcos(heading);
  let vf = b.vx * fx + b.vz * fz;
  let vl = b.vx * -fz + b.vz * fx;
  vf = approach(vf, 0, IMPACT.slideBrake * DT);
  vl = approach(vl, 0, IMPACT.slideScrub * DT);
  let yaw = approach(b.yaw, 0, IMPACT.slideYawDamp * DT);
  let vx = vf * fx - vl * fz;
  let vz = vf * fz + vl * fx;
  heading = wrapAngle(heading + yaw * DT);
  // (A turn that would swing the body into something is not taken.)
  if (yaw !== 0 && boxBlocked(world, { x: b.x, z: b.z, heading, hl: d.hl, hw: d.hw }, b.y + ROOF_STEP_M, obstacles, b.y + d.height)
    && !boxBlocked(world, { x: b.x, z: b.z, heading: b.heading, hl: d.hl, hw: d.hw }, b.y + ROOF_STEP_M, obstacles, b.y + d.height)) {
    heading = b.heading;
    yaw = 0;
  }
  fx = dsin(heading);
  fz = -dcos(heading);
  const ref = { x: b.x, z: b.z, heading: b.heading };
  const travel = Math.sqrt(vx * vx + vz * vz) * DT;
  const n = clamp(Math.ceil(travel / 0.3), 1, 6);
  let x = b.x;
  let z = b.z;
  let pushLeft: number = CAR.maxPush;
  for (let i = 0; i < n; i++) {
    const lastX = x;
    const lastZ = z;
    x += (vx * DT) / n;
    z += (vz * DT) / n;
    const box = { x, z, heading, hl: d.hl, hw: d.hw };
    const res = resolveBox(world, box, b.y + ROOF_STEP_M, obstacles, ref, pushLeft, b.y + d.height);
    pushLeft -= res.pushed;
    if (!res.hit) continue;
    x = res.x;
    z = res.z;
    if (boxCrossedWall(world, { ...box, x, z }, ref)) {
      x = lastX;
      z = lastZ;
      vx = 0;
      vz = 0;
      yaw = 0;
      break;
    }
    if (res.person) {
      // Someone's clearance: stop dead, before anyone is touched.
      vx = 0;
      vz = 0;
      yaw = 0;
      break;
    }
    const body = res.circle?.body;
    if (body) {
      const hit = contacts.find((k) => k.key === body.key);
      if (hit) {
        const bv = bodyAfter(body, hit);
        const vn = (vx - bv.vx) * res.nx + (vz - bv.vz) * res.nz;
        if (vn < 0) {
          vx -= vn * res.nx;
          vz -= vn * res.nz;
        }
        continue;
      }
      const h = bodyHit({ mass: d.mass, k2: d.k2, x, z, vx, vz }, body, res.circle!, res.nx, res.nz, CAR.bodyRestitution);
      if (h) {
        vx = h.vx;
        vz = h.vz;
        yaw += h.kick;
        contacts.push(h.contact);
      }
      continue;
    }
    const vn = vx * res.nx + vz * res.nz;
    if (vn < 0) {
      const e = -vn > 4 ? IMPACT.wallRestitution : 0;
      const tx = vx - vn * res.nx;
      const tz = vz - vn * res.nz;
      const tmag = Math.sqrt(tx * tx + tz * tz);
      const fr = tmag > 1e-9 ? Math.max(0, 1 - (IMPACT.wallFriction * -vn) / tmag) : 0;
      vx = tx * fr - e * vn * res.nx;
      vz = tz * fr - e * vn * res.nz;
      yaw *= 0.7;
    }
  }
  return { x, y: meshGroundHeight(world, x, z), z, heading, vx, vz, yaw };
}

// ---------------------------------------------------------------- the tick

interface Work {
  tick: number;
  players: SimState["players"];
  agents: AgentState[];
  /** Agent index by id. */
  index: Map<number, number>;
  ext: ImpactsExt;
  /** Agents knocked this tick (they start sliding next tick: stepAgents already moved them). */
  fresh: Set<number>;
}

function addDents(d: Readonly<Dents>, local: { f: number; r: number }, hl: number, dv: number): Dents {
  const amount = dv * DENT_PER_DV;
  const out = { front: d.front, rear: d.rear, left: d.left, right: d.right };
  // The side the contact point is on, in the body's frame.
  if (local.f > hl * 0.5) out.front = Math.min(1, out.front + amount);
  else if (local.f < -hl * 0.5) out.rear = Math.min(1, out.rear + amount);
  else if (local.r > 0) out.right = Math.min(1, out.right + amount);
  else out.left = Math.min(1, out.left + amount);
  return out;
}

function localOf(x: number, z: number, heading: number, px: number, pz: number): { f: number; r: number } {
  const fx = dsin(heading);
  const fz = -dcos(heading);
  const ox = px - x;
  const oz = pz - z;
  return { f: ox * fx + oz * fz, r: ox * -fz + oz * fx };
}

function damageCar(w: Work, id: PlayerId, c: Readonly<CarState>, px: number, pz: number, dv: number): void {
  const d = w.ext.cars[id] ?? freshDamage();
  const dents = addDents(d, localOf(c.x, c.z, c.heading, px, pz), CAR.halfLength, dv);
  const loss = Math.min(DAMAGE_MAX_HIT, Math.max(0, dv - DAMAGE_FREE_DV) * DAMAGE_PER_DV);
  w.ext.cars = { ...w.ext.cars, [id]: { ...dents, condition: Math.max(0, d.condition - loss), lastHitTick: w.tick } };
}

function event(w: Work, kind: ImpactKind, a: string, b: string, k: Readonly<CarContact>, y: number, dv: number): void {
  // (Two players' cars each report the same hit.)
  for (const e of w.ext.events) if (e.tick === w.tick && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
  const ev: ImpactEvent = { id: w.ext.nextId, tick: w.tick, kind, a, b, x: k.x, y, z: k.z, speed: k.speed, dv };
  const events = [...w.ext.events, ev];
  w.ext = { ...w.ext, nextId: w.ext.nextId + 1, events: events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events };
}

/** Add a velocity change and spin to a player's car (in its own frame). */
function shoveCar(c: Readonly<CarState>, dvx: number, dvz: number, kick: number): CarState {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const v = carVelocity(c);
  const vx = v.vx + dvx;
  const vz = v.vz + dvz;
  return { ...c, speed: vx * fx + vz * fz, lateral: vx * -fz + vz * fx, yawRate: c.yawRate + kick };
}

function kindOf(hitter: string, key: string): ImpactKind {
  const a = hitter.startsWith("p:") ? "car" : "taxi";
  const b = key.startsWith("p:") ? "car" : "taxi";
  return `${a}-${b}` as ImpactKind;
}

/**
 * The body `key` takes the impulse opposite to `k` (the impulse on `hitter`). `slid`: the hitter
 * is a sliding body, so no stepCar saw this hit and a driving player's car takes its share here
 * too (a car hit by a car took its share in its own stepCar). Returns the body's change of
 * velocity, m/s (0 when it is gone).
 */
function receive(w: Work, key: string, k: Readonly<CarContact>, hitter: string, slid: boolean): number {
  const jx = -(k.j * k.nx + k.jt * k.tx);
  const jz = -(k.j * k.nz + k.jt * k.tz);
  if (key.startsWith("p:")) {
    const id = key.slice(2);
    const p = w.players[id];
    if (!p) return 0;
    const dv = Math.sqrt(jx * jx + jz * jz) / CAR.mass;
    if (slid || p.mode === "foot") {
      const kick = spinKick(CAR.mass, CAR.yawK2, k.x - p.car.x, k.z - p.car.z, jx, jz);
      w.players = { ...w.players, [id]: { ...p, car: shoveCar(p.car, jx / CAR.mass, jz / CAR.mass, kick) } };
    }
    damageCar(w, id, p.car, k.x, k.z, dv);
    event(w, kindOf(hitter, key), hitter, key, k, p.car.y, dv);
    return dv;
  }
  const id = Number(key.slice(2));
  const i = w.index.get(id);
  if (i === undefined) return 0;
  const a = w.agents[i]!;
  const d = dimsOf(a);
  const dvx = jx / d.mass;
  const dvz = jz / d.mass;
  const dv = Math.sqrt(dvx * dvx + dvz * dvz);
  const kick = spinKick(d.mass, d.k2, k.x - a.x, k.z - a.z, jx, jz);
  const dents = addDents(a.dents ?? { front: 0, rear: 0, left: 0, right: 0 }, localOf(a.x, a.z, a.heading, k.x, k.z), d.hl, dv);
  let next: AgentState = { ...a, dents };
  if (a.knock || dv >= IMPACT.knockMinDv) {
    const v = agentVelocity(a);
    const vx = v.vx + dvx;
    const vz = v.vz + dvz;
    if (!a.knock) w.fresh.add(id);
    next = {
      ...next,
      knock: { phase: "slide", vx, vz, yaw: (a.knock?.yaw ?? 0) + kick, t: 0, age: a.knock?.age ?? 0 },
      speed: vx * dsin(a.heading) - vz * dcos(a.heading),
      mode: "honk",
      node: "",
      wait: 0,
    };
  }
  w.agents[i] = next;
  event(w, kindOf(hitter, key), hitter, key, k, a.y, dv);
  return dv;
}

/** Circles a body sliding at (x, z) can meet: player cars and road agents as bodies, robots as solid, people grown. */
function slideObstacles(w: Work, selfKey: string, x: number, z: number, reach: number): Circle[] {
  const out: Circle[] = [];
  const near = (cx: number, cz: number, r: number): boolean => (cx - x) * (cx - x) + (cz - z) * (cz - z) <= (reach + r) * (reach + r);
  for (const id of sortedIds(w.players)) {
    const p = w.players[id]!;
    if (`p:${id}` !== selfKey && near(p.car.x, p.car.z, CAR.halfLength)) {
      const body = carImpactBody(id, p.car);
      for (const c of carCircles(p.car)) out.push({ ...c, body });
    }
    if (p.mode === "foot" && p.foot && near(p.foot.x, p.foot.z, FOOT.radius)) out.push({ x: p.foot.x, z: p.foot.z, r: FOOT.radius + PERSON_CLEAR_M, person: true });
  }
  for (const a of w.agents) {
    if (`a:${a.id}` === selfKey || !near(a.x, a.z, AGENT_SPEC.robotaxi.halfLength + 1)) continue;
    const cls = agentDodgeClass(a);
    const person = cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot";
    const body = agentImpactBody(a) ?? undefined;
    for (const c of agentCircles(a)) {
      if (person) out.push({ x: c.x, z: c.z, r: c.r + PERSON_CLEAR_M, person: true });
      else out.push(body ? { x: c.x, z: c.z, r: c.r, person: false, body } : { x: c.x, z: c.z, r: c.r, person: false });
    }
  }
  return out;
}

/** What a sliding body hit takes the reaction. */
function slideContacts(w: Work, selfKey: string, contacts: readonly CarContact[]): void {
  for (const k of contacts) receive(w, k.key, k, selfKey, true);
}

/** Step one knocked agent (index i). Returns false when it is removed. */
function stepKnocked(world: World, w: Work, i: number): boolean {
  const a = w.agents[i]!;
  const k = a.knock!;
  const key = `a:${a.id}`;
  const d = dimsOf(a);
  const age = k.age + 1;
  if (k.phase === "slide") {
    const reach = d.hl + d.hw + Math.sqrt(k.vx * k.vx + k.vz * k.vz) * DT + 1;
    const contacts: CarContact[] = [];
    const s = slideBox(world, { x: a.x, y: a.y, z: a.z, heading: a.heading, vx: k.vx, vz: k.vz, yaw: k.yaw }, d, slideObstacles(w, key, a.x, a.z, reach), contacts);
    const stopped = s.vx * s.vx + s.vz * s.vz < IMPACT.stopSpeed * IMPACT.stopSpeed && (s.yaw < 0 ? -s.yaw : s.yaw) < IMPACT.stopYaw;
    const speed = s.vx * dsin(s.heading) - s.vz * dcos(s.heading);
    // (Read back: what it hit may have changed it, and so may the dents just taken.)
    w.agents[i] = {
      ...w.agents[i]!,
      x: s.x,
      y: s.y,
      z: s.z,
      heading: s.heading,
      speed: stopped ? 0 : speed,
      knock: stopped ? { phase: "stopped", vx: 0, vz: 0, yaw: 0, t: 0, age } : { ...k, vx: s.vx, vz: s.vz, yaw: s.yaw, t: k.t + 1, age },
      mode: "honk",
    };
    for (const c of contacts) {
      // Its own dents, from the reaction.
      const own = Math.sqrt(c.j * c.j + c.jt * c.jt) / d.mass;
      const cur: AgentState = w.agents[i]!;
      w.agents[i] = { ...cur, dents: addDents(cur.dents ?? { front: 0, rear: 0, left: 0, right: 0 }, localOf(cur.x, cur.z, cur.heading, c.x, c.z), d.hl, own) };
    }
    slideContacts(w, key, contacts);
    return true;
  }
  // Stopped or turning back toward its lane.
  if (age > IMPACT.giveUpTicks) {
    let near = false;
    for (const id of sortedIds(w.players)) {
      const p = w.players[id]!;
      const bx = p.mode === "foot" && p.foot ? p.foot.x : p.car.x;
      const bz = p.mode === "foot" && p.foot ? p.foot.z : p.car.z;
      if ((bx - a.x) * (bx - a.x) + (bz - a.z) * (bz - a.z) < SPAWN_MIN_PLAYER_M * SPAWN_MIN_PLAYER_M) near = true;
    }
    if (!near) return false;
  }
  if (k.phase === "stopped" && k.t < IMPACT.stoppedTicks) {
    w.agents[i] = { ...a, knock: { ...k, t: k.t + 1, age }, mode: "honk", speed: 0 };
    return true;
  }
  // A body a system moves (a service vehicle, a mission car): its controller takes over again.
  if (a.runtimeId !== undefined) {
    const { knock: _k, ...rest } = a;
    void _k;
    w.agents[i] = { ...rest, speed: 0, mode: "go", ...(a.vehicle ? { vehicle: { ...a.vehicle, x: a.x, y: a.y, z: a.z, heading: a.heading, speed: 0, lateral: 0, yawRate: 0 } } : {}) };
    return true;
  }
  const g = world.roads;
  const ei = g ? g.edgeIndex.get(a.edge) : undefined;
  if (!g || ei === undefined) {
    w.agents[i] = { ...a, knock: { ...k, phase: "stopped", t: k.t + 1, age }, mode: "honk", speed: 0 };
    return true;
  }
  const lane = lanePath(g.edges[ei]!, a.dir, a.lane);
  const pl = projectOnPath(lane, a.x, a.z);
  const s1 = clamp(pl.s + Math.max(IMPACT.rejoinAheadM, 2 * pl.dist), 0, lane.len);
  const t = pathPoint(lane, s1);
  const dx = t.x - a.x;
  const dz = t.z - a.z;
  const l = Math.sqrt(dx * dx + dz * dz);
  const want = l > 1e-6 ? datan2(dx, -dz) : datan2(t.tx, -t.tz);
  const off = wrapAngle(want - a.heading);
  if ((off < 0 ? -off : off) <= IMPACT.rejoinAngle) {
    // Back onto its lane from where it stands, along its own heading (no jump).
    const fx = dsin(a.heading);
    const fz = -dcos(a.heading);
    const { knock: _k, ...rest } = a;
    void _k;
    w.agents[i] = { ...rest, conn: connector(a.x, a.z, fx, fz, t.x, t.z, t.tx, t.tz, 0.56), s: 0, resume: s1, lat: 0, speed: 0, wait: 0, ghost: 0, node: "", mode: "go" };
    return true;
  }
  // Turn in place toward it (hazards on), when the turn is clear.
  const turn = clamp(off, -IMPACT.realignRate * DT, IMPACT.realignRate * DT);
  const heading = wrapAngle(a.heading + turn);
  const obstacles = slideObstacles(w, `a:${a.id}`, a.x, a.z, d.hl + d.hw + 1);
  const clear = !boxBlocked(world, { x: a.x, z: a.z, heading, hl: d.hl, hw: d.hw }, a.y + ROOF_STEP_M, obstacles, a.y + d.height);
  w.agents[i] = { ...a, heading: clear ? heading : a.heading, knock: { ...k, phase: "realign", t: k.phase === "realign" ? k.t + 1 : 0, age }, mode: "honk", speed: 0 };
  return true;
}

/** A parked player's car (its player on foot) that is moving slides until it stops. */
function stepParked(world: World, w: Work, id: PlayerId): void {
  const p = w.players[id]!;
  const c = p.car;
  const v = carVelocity(c);
  if (v.vx * v.vx + v.vz * v.vz < IMPACT.stopSpeed * IMPACT.stopSpeed && (c.yawRate < 0 ? -c.yawRate : c.yawRate) < IMPACT.stopYaw) {
    if (c.speed !== 0 || c.lateral !== 0 || c.yawRate !== 0) w.players = { ...w.players, [id]: { ...p, car: { ...c, speed: 0, lateral: 0, yawRate: 0, vy: 0 } } };
    return;
  }
  const key = `p:${id}`;
  const reach = CAR.halfLength + CAR.halfWidth + Math.sqrt(v.vx * v.vx + v.vz * v.vz) * DT + 1;
  const contacts: CarContact[] = [];
  const s = slideBox(world, { x: c.x, y: c.y, z: c.z, heading: c.heading, vx: v.vx, vz: v.vz, yaw: c.yawRate }, CAR_DIMS, slideObstacles(w, key, c.x, c.z, reach), contacts);
  const fx = dsin(s.heading);
  const fz = -dcos(s.heading);
  const car: CarState = { ...c, x: s.x, y: s.y, z: s.z, heading: s.heading, speed: s.vx * fx + s.vz * fz, lateral: s.vx * -fz + s.vz * fx, yawRate: s.yaw, vy: 0 };
  w.players = { ...w.players, [id]: { ...p, car } };
  slideContacts(w, key, contacts);
}

/**
 * Apply this tick's hits and move what was knocked. `contacts`: each player's car's hits from
 * its stepCar this tick (by player id). Returns the new state (ext.impacts only once anything has
 * ever been hit).
 */
export function stepImpacts(world: World, state: SimState, contacts: ReadonlyMap<PlayerId, readonly CarContact[]>): SimState {
  const agentsExt = state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined;
  const prior = impactsOf(state);
  const list = agentsExt ? agentsExt.list : [];
  let anyContact = false;
  for (const id of sortedIds(state.players)) if ((contacts.get(id)?.length ?? 0) > 0) anyContact = true;
  const anyKnocked = list.some((a) => a.knock !== undefined);
  let anyParked = false;
  for (const id of sortedIds(state.players)) {
    const p = state.players[id]!;
    if (p.mode === "foot" && (p.car.speed !== 0 || p.car.lateral !== 0 || p.car.yawRate !== 0)) anyParked = true;
  }
  const repairing = prior !== undefined && sortedIds(prior.cars).some((id) => prior.cars[id]!.condition < 100);
  if (!anyContact && !anyKnocked && !anyParked && !repairing) return state;

  const w: Work = {
    tick: state.tick,
    players: state.players,
    agents: list.slice(),
    index: new Map(list.map((a, i) => [a.id, i])),
    ext: prior ?? { version: 1, nextId: 1, events: [], cars: {} },
    fresh: new Set(),
  };

  // 1. The players' cars' hits: the other body takes its share.
  for (const id of sortedIds(state.players)) {
    for (const k of contacts.get(id) ?? []) {
      receive(w, k.key, k, `p:${id}`, false);
      damageCar(w, id, w.players[id]!.car, k.x, k.z, Math.sqrt(k.j * k.j + k.jt * k.jt) / CAR.mass);
    }
  }

  // 2. Knocked agents slide, sit, turn back and rejoin; parked cars slide.
  const removed = new Set<number>();
  for (let i = 0; i < w.agents.length; i++) {
    const a = w.agents[i]!;
    if (!a.knock || w.fresh.has(a.id)) continue;
    if (!stepKnocked(world, w, i)) removed.add(a.id);
  }
  for (const id of sortedIds(w.players)) {
    const p = w.players[id]!;
    if (p.mode === "foot") stepParked(world, w, id);
  }

  // 3. Condition comes back by itself after a while without a hit.
  const cars: Record<PlayerId, CarDamage> = {};
  for (const id of sortedIds(w.ext.cars)) {
    const d = w.ext.cars[id]!;
    if (!w.players[id]) continue;
    const back = d.condition < 100 && w.tick - d.lastHitTick >= REPAIR_AFTER_TICKS && (w.tick - d.lastHitTick) % 60 === 0;
    cars[id] = back ? { ...d, condition: Math.min(100, d.condition + REPAIR_PER_S) } : d;
  }
  w.ext = { ...w.ext, cars };

  const agents = removed.size > 0 ? w.agents.filter((a) => !removed.has(a.id)) : w.agents;
  const ext = { ...state.ext, [IMPACTS_EXT_KEY]: w.ext };
  if (agentsExt) ext[AGENTS_EXT_KEY] = { ...agentsExt, list: agents };
  return { ...state, players: w.players, ext };
}
