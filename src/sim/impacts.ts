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
//  - Robots (the owner's request: "you should be able to hit robots"; docs/design.md decision log
//    2026-10-23) are light bodies a car bowls over: a Footman (90 kg) or a Trundle (60 kg) takes
//    nearly all of a hit and the car loses a little speed. Hit hard enough (ROBOT.fallMinDv) it
//    tumbles: slides, topples (its pitch goes to ROBOT.fallen, which the renderer draws), lies
//    there, gets up and walks back onto its sidewalk (agents.ts rejoinAt). A harder hit, or one
//    dent too many, disables it for longer, its status light flashing (mode "honk"). Nothing is
//    destroyed and water stays the only way to melt one (combat is untouched); a robot that is
//    seizing, slumping or a heap is not knocked (it stays solid). A tumbling robot bowls over the
//    robots it meets and stops dead at anyone's clearance. Knocking over a good robot costs the
//    player (game-systems.ts turns the event into an economy penalty).
//  - Street props (props.ts: trees and lamp posts where the renderer draws them, hydrants, and
//    whatever World detail places): a hit slower than a prop's break speed meets it as an
//    immovable body (the car bounces and spins off a mature tree, which never breaks); faster, the
//    prop breaks and only its mass slows the car (a sapling snaps at any speed). A broken tree,
//    lamp post, sign or signal falls the way it was hit, unless anyone (a person, an animal, a
//    player on foot) is where it would land: then it only leans. A hydrant is knocked off its
//    base and gushes (the renderer's geyser) until the crews come. Broken props are no longer
//    obstacles and stay down (ext.impacts.props) until PROP_RESET_TICKS have passed with no player
//    within PROP_RESET_CLEAR_M, when the city puts them back.
//
// State: ext.impacts (ImpactsExt; absent until the first hit), AgentState.knock and .dents.

import { DT, sortedIds, type CarState, type PlayerId, type SimState } from "./contract.ts";
import { approach, clamp, datan2, dcos, dsin, wrapAngle } from "./dmath.ts";
import { CAR, bodyAfter, bodyHit, boxHit, carCircles, spinKick, type CarContact } from "./car.ts";
import { boxBlocked, boxCrossedWall, resolveBox, type Circle, type ImpactBody } from "./collide.ts";
import { FOOT } from "./foot.ts";
import { AGENTS_EXT_KEY, AGENT_SPEC, ROBOTAXI_BODY, SPAWN_MIN_PLAYER_M, TRUNDLE_FREE_VERSION, agentCircles, rejoinAt, type AgentState, type AgentsExt } from "./agents.ts";
import { agentDodgeClass } from "./dodge.ts";
import { connector, lanePath, pathPoint, projectOnPath } from "./roads.ts";
import { segmentCrossesWall } from "./boundary.ts";
import type { CombatState } from "./combat-contract.ts";
import { propIndex, propsNear, type PropKind } from "./props.ts";
import { ROOF_STEP_M, circleBlocked, meshGroundHeight, type World } from "./world.ts";
import { BOX_CONTACT_VERSION, VEHICLE_SKIN, boxContact, hullAt, hullBandsMeet, hullContact, sweepHulls, vehiclePairs, type VehicleHull, type VehicleMotion, type HullContact } from "./vehicle-contacts.ts";

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

export type ImpactKind = "car-car" | "car-taxi" | "taxi-car" | "taxi-taxi" | "car-robot" | "taxi-robot" | "robot-robot" | "car-prop";

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
  /** A robot hit: it was standing and this hit knocked it over (absent otherwise). */
  fell?: boolean;
  /** A robot hit: this hit disabled it (absent otherwise). */
  disabled?: boolean;
  /** A prop hit: it broke (absent otherwise; false: it held). */
  broke?: boolean;
}

/** A broken street prop (props.ts), by id in ImpactsExt.props. */
export interface PropKnock {
  pausedTicks?: number;
  kind: PropKind;
  /** The tick it broke. */
  tick: number;
  /** "fallen": down along `dir`; "leaning": someone was where it would land; "snapped": a sapling; "knocked": off its base (a hydrant, a bin). */
  state: "fallen" | "leaning" | "snapped" | "knocked";
  /** Compass bearing it fell (or leans) toward, radians. */
  dir: number;
}

/** state.ext.impacts */
export interface ImpactsExt {
  version: 1;
  /** The next event id (durable across ticks). */
  nextId: number;
  /** The most recent events, oldest first (at most MAX_EVENTS). */
  events: ImpactEvent[];
  cars: Record<PlayerId, CarDamage>;
  /** v13: broken street props by id (absent until the first). */
  props?: Record<string, PropKnock>;
}

/** A body knocked off its path (AgentState.knock). */
export interface KnockState {
  /**
   * "slide": moving on locked tyres (a robot: tumbling); "stopped": sitting with hazards on;
   * "realign": turning in place toward its lane; a robot: "down" (lying there), "getup".
   */
  phase: "slide" | "stopped" | "realign" | "down" | "getup";
  /** World velocity, m/s, and yaw rate, rad/s (+ = clockwise). */
  vx: number;
  vz: number;
  yaw: number;
  /** Ticks in this phase, and since the knock began. */
  t: number;
  age: number;
  /** A robot: the pitch it falls to (0: it was only pushed and stays on its feet). */
  fall?: number;
  /** A robot: ticks it lies down. */
  down?: number;
  /** A robot: disabled by the hit (lies down longer, status light flashing). */
  disabled?: boolean;
}

/** Robots hit by cars (all values tune). */
export const ROBOT = {
  /** Kilograms: a Footman and a Trundle. */
  footmanMass: 90,
  trundleMass: 60,
  /** The fastest a hit sends a robot off, m/s, and how far off the hitter's line it is flung, rad. */
  launchMax: 22,
  fling: 0.5,
  /** A hit that changes its velocity by this much knocks it over, m/s; this much disables it. */
  fallMinDv: 1.2,
  disableDv: 10,
  /** Dents (front + rear + left + right) at which a hit disables it. */
  disableDents: 1.2,
  /** Tumbling friction, m/s^2, and its spin damping, rad/s^2. */
  friction: 11,
  yawDamp: 6,
  /** Fallen pitch, rad, how fast it topples and gets up, rad/s. */
  fallen: 1.45,
  fallRate: 7,
  getupRate: 2.4,
  /** Ticks it lies down: knocked over, or disabled. */
  downTicks: 150,
  disabledTicks: 480,
  /** A robot it tumbles into takes this share of its velocity (and it keeps restShare). */
  passShare: 0.6,
  restShare: 0.3,
} as const;

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
/** A broken prop is put back once this long has passed with no player within PROP_RESET_CLEAR_M. */
export const PROP_RESET_TICKS = 3 * 60 * 60;
export const PROP_RESET_CLEAR_M = 80;
/** A falling prop only leans when anyone is within this of the line it would fall along, metres. */
export const FALL_CLEAR_M = 1.2;
/** A prop hit closing slower than this makes no event (a scrape). */
const PROP_EVENT_MPS = 2;
/**
 * v26 (TRUNDLE_FREE_VERSION): two ambient or runtime vehicles (no player's car) that touch closing
 * slower than this, m/s, only lean on each other: no knock, no impulse, no event. 0.3 m/s is where
 * the vehicle follower calls a body stopped (follower.ts `stopped`), and it is under knockMinDv
 * (0.4), so no hit this small ever knocked a plain robotaxi; it sits far above the sub-millimetre
 * touches of a car creeping into a stopped one (about 4e-5 m/s) and far below any driven bump
 * (1 m/s and more). Before v26 such a touch knocked a runtime vehicle (a bus, a van, a civilian
 * car) at any speed: it sat 100 ticks honking with its wait cleared, crept back into the same car,
 * and was knocked again, so neither its own blocked-then-reverse breaker nor the robotaxi's
 * deadlock breaker ever fired (a ferry bus wedged against a robotaxi on The Embarcadero, seed 1).
 * Now the solid-vehicle pass simply refuses the creep, the follower counts it as blocked, and
 * after 3 s it backs off and plans again.
 */
export const TOUCH_CONTACT_MPS = 0.3;

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
  if(a.manualCar && !a.knock) return carVelocity(a.manualCar);
  if (a.knock) return { vx: a.knock.vx, vz: a.knock.vz };
  return { vx: a.speed * dsin(a.heading), vz: -a.speed * dcos(a.heading) };
}

/** A player's car as a body others shove. */
export function carImpactBody(id: PlayerId, c: Readonly<CarState>): ImpactBody {
  const v = carVelocity(c);
  return { key: `p:${id}`, mass: CAR.mass, x: c.x, z: c.z, vx: v.vx, vz: v.vz, box: { heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth } };
}

/** A robot (not a person, animal or robotaxi). */
export function isRobot(a: Readonly<Pick<AgentState, "kind">>): boolean {
  return a.kind === "errandRobot" || a.kind === "sidewalkBot";
}

/** A robot's mass, kg. */
export function robotMass(a: Readonly<Pick<AgentState, "kind">>): number {
  return a.kind === "sidewalkBot" ? ROBOT.trundleMass : ROBOT.footmanMass;
}

/** Can this robot be knocked? Not while seizing, slumping or a heap (combat owns those; it stays solid). */
export function robotKnockable(a: Readonly<AgentState>, combat: Readonly<CombatState> | undefined): boolean {
  const phase = combat?.targets[a.runtimeId ?? `agent:${a.id}`]?.phase;
  return phase === undefined || phase === "active";
}

/**
 * An agent as a body others shove: a road agent (robotaxi, service vehicle), or a robot that can
 * be knocked (`combat`: the combat state, for the robot's phase); null for anything else (people
 * and animals are never bodies a car meets).
 */
export function agentImpactBody(a: Readonly<AgentState>, combat?: Readonly<CombatState>): ImpactBody | null {
  const v = agentVelocity(a);
  if (AGENT_SPEC[a.kind].road) {
    const d = dimsOf(a);
    return { key: `a:${a.id}`, mass: IMPACT.taxiMass, x: a.x, z: a.z, vx: v.vx, vz: v.vz, box: { heading: a.heading, hl: d.hl, hw: d.hw } };
  }
  if (isRobot(a) && robotKnockable(a, combat)) return { key: `a:${a.id}`, mass: robotMass(a), x: a.x, z: a.z, vx: v.vx, vz: v.vz };
  return null;
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
 * `holdSpin` (v25): a turn that is not taken keeps the body's spin for when it comes free.
 */
function slideBox(world: World, b: Readonly<Slider>, d: Readonly<SlideDims>, obstacles: readonly Circle[], contacts: CarContact[], holdSpin = false, holdOnPerson = false): Slider {
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
  // (A turn that would swing the body into something is not taken. v25: the spin is kept, dying
  // away as usual, so a car rear-ended off centre turns once the car that hit it falls back.)
  if (yaw !== 0 && boxBlocked(world, { x: b.x, z: b.z, heading, hl: d.hl, hw: d.hw }, b.y + ROOF_STEP_M, obstacles, b.y + d.height)
    && !boxBlocked(world, { x: b.x, z: b.z, heading: b.heading, hl: d.hl, hw: d.hw }, b.y + ROOF_STEP_M, obstacles, b.y + d.height)) {
    heading = b.heading;
    if (!holdSpin) yaw = 0;
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
      // Someone's clearance: stop dead, before anyone is touched. v27: where it was before this
      // step. The resolved pose can be nearer them, not further: a person's push spends the push
      // budget, then the wall settle sends the box back past where it started.
      if (holdOnPerson) {
        x = lastX;
        z = lastZ;
      }
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
  combat: Readonly<CombatState> | undefined;
  /** The state's SIM_VERSION. */
  version: number;
  /** v27: a slide that meets someone's clearance stays where it was (slideBox holdOnPerson). */
  holdOnPerson: boolean;
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
  // (A new object: w.ext may still be the previous state's.)
  w.ext = { ...w.ext, cars: { ...w.ext.cars, [id]: { ...dents, condition: Math.max(0, d.condition - loss), lastHitTick: w.tick } } };
}

function event(w: Work, kind: ImpactKind, a: string, b: string, k: Readonly<Pick<CarContact, "x" | "z" | "speed">>, y: number, dv: number, robot: { fell: boolean; disabled: boolean } | null = null, broke?: boolean): void {
  // (Two players' cars each report the same hit.)
  for (const e of w.ext.events) if (e.tick === w.tick && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
  const ev: ImpactEvent = { id: w.ext.nextId, tick: w.tick, kind, a, b, x: k.x, y, z: k.z, speed: k.speed, dv, ...(robot ? { fell: robot.fell, disabled: robot.disabled } : {}), ...(broke !== undefined ? { broke } : {}) };
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

function kindOf(w: Work, hitter: string, key: string): ImpactKind {
  const of = (k: string): string => {
    if (k.startsWith("p:")) return "car";
    if (k.startsWith("prop:")) return "prop";
    const i = w.index.get(Number(k.slice(2)));
    return i !== undefined && isRobot(w.agents[i]!) ? "robot" : "taxi";
  };
  return `${of(hitter)}-${of(key)}` as ImpactKind;
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
    // v25: a hitter's stepCar met this car where it stood at the start of the tick (k.bx, k.bz);
    // it has driven on since, so the lever arm and the dent are taken from that same point on it.
    const rx = k.x - (k.bx ?? p.car.x);
    const rz = k.z - (k.bz ?? p.car.z);
    const px = k.bx === undefined ? k.x : p.car.x + rx;
    const pz = k.bz === undefined ? k.z : p.car.z + rz;
    if (slid || p.mode === "foot" || p.ride) {
      const kick = spinKick(CAR.mass, CAR.yawK2, rx, rz, jx, jz);
      w.players = { ...w.players, [id]: { ...p, car: shoveCar(p.car, jx / CAR.mass, jz / CAR.mass, kick) } };
    }
    damageCar(w, id, p.car, px, pz, dv);
    event(w, kindOf(w, hitter, key), hitter, key, k, p.car.y, dv);
    return dv;
  }
  const id = Number(key.slice(2));
  const i = w.index.get(id);
  if (i === undefined) return 0;
  const a = w.agents[i]!;
  if (isRobot(a)) return knockRobot(w, i, jx, jz, k, hitter);
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
  event(w, kindOf(w, hitter, key), hitter, key, k, a.y, dv);
  return dv;
}

/**
 * Robot i takes impulse (jx, jz) from `hitter` at contact `k`: it tumbles off (no faster than
 * ROBOT.launchMax), knocked over when the hit is hard enough, disabled when harder still or
 * dented enough. Returns its change of velocity, m/s.
 */
function knockRobot(w: Work, i: number, jx: number, jz: number, k: Readonly<Pick<CarContact, "x" | "z" | "speed">>, hitter: string): number {
  const a = w.agents[i]!;
  const m = robotMass(a);
  const dvx = jx / m;
  const dvz = jz / m;
  const dv = Math.sqrt(dvx * dvx + dvz * dvz);
  const v0 = agentVelocity(a);
  let vx = v0.vx + dvx;
  let vz = v0.vz + dvz;
  // Flung aside, off the hitter's line: turned up to ROBOT.fling toward the side of the line the
  // contact was on (a dead-centre hit goes right), so a car bowls it out of its way.
  const along = (k.x - a.x) * dvz - (k.z - a.z) * dvx;
  const turn = along > 0 ? -ROBOT.fling : ROBOT.fling;
  const c = dcos(turn);
  const sn = dsin(turn);
  [vx, vz] = [vx * c - vz * sn, vz * c + vx * sn];
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (sp > ROBOT.launchMax) {
    vx *= ROBOT.launchMax / sp;
    vz *= ROBOT.launchMax / sp;
  }
  const spec = AGENT_SPEC[a.kind];
  const dents = addDents(a.dents ?? { front: 0, rear: 0, left: 0, right: 0 }, localOf(a.x, a.z, a.heading, k.x, k.z), spec.halfLength, dv);
  const total = dents.front + dents.rear + dents.left + dents.right;
  const was = a.knock;
  const fell = dv >= ROBOT.fallMinDv && !(was && was.fall);
  const disabled = (dv >= ROBOT.disableDv || (total >= ROBOT.disableDents && dv >= ROBOT.fallMinDv)) && !was?.disabled;
  // It falls the way it is pushed: forward (nose down) when shoved from behind.
  const ahead = dvx * dsin(a.heading) - dvz * dcos(a.heading);
  const fall = was?.fall ? was.fall : dv >= ROBOT.fallMinDv ? (ahead >= 0 ? -ROBOT.fallen : ROBOT.fallen) : 0;
  const kick = spinKick(m, 0.1, k.x - a.x, k.z - a.z, jx, jz);
  if (!was) w.fresh.add(a.id);
  const isDisabled = disabled || was?.disabled === true;
  w.agents[i] = {
    ...a,
    dents,
    knock: {
      phase: "slide",
      vx,
      vz,
      yaw: (was?.yaw ?? 0) + kick,
      t: 0,
      age: was?.age ?? 0,
      fall,
      down: isDisabled ? ROBOT.disabledTicks : ROBOT.downTicks,
      ...(isDisabled ? { disabled: true } : {}),
    },
    speed: 0,
    mode: isDisabled ? "honk" : "wait",
    dwell: 0,
  };
  event(w, kindOf(w, hitter, `a:${a.id}`), hitter, `a:${a.id}`, k, a.y, dv, { fell, disabled });
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
    const body = agentImpactBody(a, w.combat) ?? undefined;
    for (const c of agentCircles(a)) {
      if (person) out.push({ x: c.x, z: c.z, r: c.r + PERSON_CLEAR_M, person: true });
      else out.push(body ? { x: c.x, z: c.z, r: c.r, person: false, body } : { x: c.x, z: c.z, r: c.r, person: false });
    }
  }
  return out;
}

/** Is anyone (a person, an animal, a player on foot) within FALL_CLEAR_M of the line from (x, z) `len` m along `dir`? */
function anyoneUnder(w: Work, x: number, z: number, dir: number, len: number): boolean {
  const fx = dsin(dir);
  const fz = -dcos(dir);
  const near = (px: number, pz: number, r: number): boolean => {
    const ox = px - x;
    const oz = pz - z;
    const t = clamp(ox * fx + oz * fz, 0, len);
    const dx = ox - fx * t;
    const dz = oz - fz * t;
    return dx * dx + dz * dz < (FALL_CLEAR_M + r) * (FALL_CLEAR_M + r);
  };
  for (const id of sortedIds(w.players)) {
    const f = w.players[id]!.foot;
    if (w.players[id]!.mode === "foot" && f && near(f.x, f.z, FOOT.radius)) return true;
  }
  for (const a of w.agents) {
    const cls = agentDodgeClass(a);
    if (cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot" && near(a.x, a.z, a.radius ?? AGENT_SPEC[a.kind].radius)) return true;
  }
  return false;
}

/** A car's hit on a street prop: it breaks (fast enough) or holds; an event either way when it was a real hit. */
function hitProp(world: World, w: Work, k: Readonly<CarContact>, hitter: string, y: number): void {
  const id = k.key.slice(5);
  const prop = propIndex(world).byId.get(id);
  if (!prop || w.ext.props?.[id]) return;
  const broke = k.speed >= prop.breakSpeed;
  if (broke) {
    // It goes the way it was pushed (opposite to the impulse on the car).
    const dir = datan2(-k.nx, k.nz);
    const falls = prop.kind === "tree" || prop.kind === "lamp" || prop.kind === "sign" || prop.kind === "signal";
    const state: PropKnock["state"] = prop.size === "sapling" ? "snapped" : !falls ? "knocked" : anyoneUnder(w, prop.x, prop.z, dir, prop.height) ? "leaning" : "fallen";
    w.ext = { ...w.ext, props: { ...(w.ext.props ?? {}), [id]: { kind: prop.kind, tick: w.tick, state, dir } } };
  }
  if (broke || k.speed >= PROP_EVENT_MPS) event(w, "car-prop", hitter, k.key, k, y, Math.sqrt(k.j * k.j + k.jt * k.jt) / CAR.mass, null, broke);
}

/** Broken props come back once nobody has been near for a while. */
function resetProps(world: World, w: Work): void {
  const props = w.ext.props;
  if (!props) return;
  const keys = sortedIds(props);
  if (keys.length === 0) return;
  let out: Record<string, PropKnock> | null = null;
  const idx = propIndex(world);
  for (const id of keys) {
    const k = props[id]!;
    if (w.tick - k.tick - (k.pausedTicks ?? 0) < PROP_RESET_TICKS) continue;
    const p = idx.byId.get(id);
    if (p && !nobodyWithin(w, p.x, p.z, PROP_RESET_CLEAR_M)) continue;
    out ??= { ...props };
    delete out[id];
  }
  if (out) w.ext = { ...w.ext, props: out };
}

function nobodyWithin(w: Work, x: number, z: number, r: number): boolean {
  for (const id of sortedIds(w.players)) {
    const p = w.players[id]!;
    const bx = p.mode === "foot" && p.foot ? p.foot.x : p.car.x;
    const bz = p.mode === "foot" && p.foot ? p.foot.z : p.car.z;
    if ((bx - x) * (bx - x) + (bz - z) * (bz - z) < r * r) return false;
  }
  return true;
}

/** Is prop `id` broken? */
export function propBroken(state: Readonly<SimState>, id: string): boolean {
  return impactsOf(state)?.props?.[id] !== undefined;
}

/** How prop `id` lies once broken (read-only, for renderers posing it), else undefined. */
export function propKnock(state: Readonly<SimState>, id: string): Readonly<PropKnock> | undefined {
  return impactsOf(state)?.props?.[id];
}

/** What a sliding body hit takes the reaction. */
function slideContacts(w: Work, selfKey: string, contacts: readonly CarContact[]): void {
  for (const k of contacts) receive(w, k.key, k, selfKey, true);
}

/** Step one knocked agent (index i). Returns false when it is removed. */
function stepKnocked(world: World, w: Work, i: number): boolean {
  const a = w.agents[i]!;
  if (isRobot(a)) return stepKnockedRobot(world, w, i);
  const k = a.knock!;
  const key = `a:${a.id}`;
  const d = dimsOf(a);
  const age = k.age + 1;
  if (k.phase === "slide") {
    const reach = d.hl + d.hw + Math.sqrt(k.vx * k.vx + k.vz * k.vz) * DT + 1;
    const contacts: CarContact[] = [];
    const s = slideBox(world, { x: a.x, y: a.y, z: a.z, heading: a.heading, vx: k.vx, vz: k.vz, yaw: k.yaw }, d, slideObstacles(w, key, a.x, a.z, reach), contacts, w.version >= BOX_CONTACT_VERSION, w.holdOnPerson);
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
  if (age > IMPACT.giveUpTicks && nobodyNear(w, a.x, a.z)) return false;
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

function nobodyNear(w: Work, x: number, z: number): boolean {
  for (const id of sortedIds(w.players)) {
    const p = w.players[id]!;
    const bx = p.mode === "foot" && p.foot ? p.foot.x : p.car.x;
    const bz = p.mode === "foot" && p.foot ? p.foot.z : p.car.z;
    if ((bx - x) * (bx - x) + (bz - z) * (bz - z) < SPAWN_MIN_PLAYER_M * SPAWN_MIN_PLAYER_M) return false;
  }
  return true;
}

/** Step one knocked robot (index i): tumble, lie there, get up, walk on. Returns false when it is removed. */
function stepKnockedRobot(world: World, w: Work, i: number): boolean {
  const a = w.agents[i]!;
  const k = a.knock!;
  const age = k.age + 1;
  const fall = k.fall ?? 0;
  if (age > IMPACT.giveUpTicks && nobodyNear(w, a.x, a.z)) return false;
  if (k.phase === "slide") {
    const r = a.radius ?? AGENT_SPEC[a.kind].radius;
    let vx = k.vx;
    let vz = k.vz;
    const sp = Math.sqrt(vx * vx + vz * vz);
    const slower = Math.max(0, sp - ROBOT.friction * DT);
    if (sp > 0) {
      vx *= slower / sp;
      vz *= slower / sp;
    }
    const yaw = approach(k.yaw, 0, ROBOT.yawDamp * DT);
    let x = a.x;
    let z = a.z;
    const travel = slower * DT;
    const n = clamp(Math.ceil(travel / 0.1), 1, 4);
    const obstacles = slideObstacles(w, `a:${a.id}`, a.x, a.z, r + travel + 1);
    let hitRobot: number | null = null;
    for (let s = 0; s < n && (vx !== 0 || vz !== 0); s++) {
      const nx = x + (vx * DT) / n;
      const nz = z + (vz * DT) / n;
      let stop = circleBlocked(world, nx, nz, r) || segmentCrossesWall(world.walls, x, z, nx, nz);
      for (const c of obstacles) {
        if (stop) break;
        const dx = nx - c.x;
        const dz = nz - c.z;
        if (dx * dx + dz * dz >= (r + c.r) * (r + c.r)) continue;
        // (Only what it moves toward stops it.)
        if (dx * vx + dz * vz > 0) continue;
        const other = c.body && c.body.key.startsWith("a:") ? w.index.get(Number(c.body.key.slice(2))) : undefined;
        if (!c.person && other !== undefined && isRobot(w.agents[other]!)) hitRobot = other;
        stop = true;
      }
      if (stop) break;
      x = nx;
      z = nz;
    }
    const speed0 = Math.sqrt(vx * vx + vz * vz);
    if (hitRobot !== null && speed0 > 0) {
      // Bowled into another robot: it takes most of the tumble.
      const o = w.agents[hitRobot]!;
      const m = robotMass(o);
      const share = ROBOT.passShare;
      knockRobot(w, hitRobot, vx * share * m, vz * share * m, { x: (x + o.x) / 2, z: (z + o.z) / 2, speed: speed0 }, `a:${a.id}`);
      vx *= ROBOT.restShare;
      vz *= ROBOT.restShare;
    } else if (x === a.x && z === a.z && speed0 > 0) {
      // Against a wall, a vehicle or someone's clearance: it stops there.
      vx = 0;
      vz = 0;
    }
    const pitch = approach(a.pitch, fall, ROBOT.fallRate * DT);
    const done = vx * vx + vz * vz < IMPACT.stopSpeed * IMPACT.stopSpeed;
    const cur = w.agents[i]!;
    w.agents[i] = {
      ...cur,
      x,
      y: meshGroundHeight(world, x, z),
      z,
      heading: wrapAngle(cur.heading + yaw * DT),
      pitch,
      speed: 0,
      knock: done ? { ...k, phase: fall !== 0 ? "down" : "getup", vx: 0, vz: 0, yaw: 0, t: 0, age } : { ...k, vx, vz, yaw, t: k.t + 1, age },
    };
    return true;
  }
  if (k.phase === "down") {
    const pitch = approach(a.pitch, fall, ROBOT.fallRate * DT);
    w.agents[i] = { ...a, pitch, knock: k.t + 1 >= (k.down ?? ROBOT.downTicks) ? { ...k, phase: "getup", t: 0, age } : { ...k, t: k.t + 1, age } };
    return true;
  }
  // Getting up, then back to its errand.
  const pitch = approach(a.pitch, 0, ROBOT.getupRate * DT);
  if (pitch !== 0) {
    w.agents[i] = { ...a, pitch, mode: "wait", knock: { ...k, phase: "getup", t: k.t + 1, age } };
    return true;
  }
  const { knock: _k, ...rest } = a;
  void _k;
  const back = a.runtimeId === undefined ? rejoinAt(world, a, a.x, a.z) : null;
  w.agents[i] = { ...rest, pitch: 0, speed: 0, wait: 0, mode: "go", ...(back ?? {}) };
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
  const s = slideBox(world, { x: c.x, y: c.y, z: c.z, heading: c.heading, vx: v.vx, vz: v.vz, yaw: c.yawRate }, CAR_DIMS, slideObstacles(w, key, c.x, c.z, reach), contacts, w.version >= BOX_CONTACT_VERSION, w.holdOnPerson);
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
export function stepImpacts(world: World, state: SimState, contacts: ReadonlyMap<PlayerId, readonly CarContact[]>, agentContacts: ReadonlyMap<number, readonly CarContact[]> = new Map()): SimState {
  const combat = state.ext.combat as CombatState | undefined;
  const agentsExt = state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined;
  const prior = impactsOf(state);
  const list = agentsExt ? agentsExt.list : [];
  let anyContact = false;
  for (const id of sortedIds(state.players)) if ((contacts.get(id)?.length ?? 0) > 0) anyContact = true;
  if ([...agentContacts.values()].some(hits=>hits.length>0)) anyContact=true;
  const anyKnocked = list.some((a) => a.knock !== undefined);
  let anyParked = false;
  for (const id of sortedIds(state.players)) {
    const p = state.players[id]!;
    if ((p.mode === "foot" || p.ride) && (p.car.speed !== 0 || p.car.lateral !== 0 || p.car.yawRate !== 0)) anyParked = true;
  }
  const repairing = prior !== undefined && sortedIds(prior.cars).some((id) => prior.cars[id]!.condition < 100);
  const broken = prior?.props !== undefined && sortedIds(prior.props).length > 0;
  if (!anyContact && !anyKnocked && !anyParked && !repairing && !broken) return state;

  const w: Work = {
    tick: state.tick,
    players: state.players,
    agents: list.slice(),
    index: new Map(list.map((a, i) => [a.id, i])),
    ext: prior ?? { version: 1, nextId: 1, events: [], cars: {} },
    fresh: new Set(),
    combat,
    version: state.version,
    holdOnPerson: state.version >= 27,
  };

  // 1. The players' cars' hits: the other body takes its share. v25: a driving player's car that
  // did not meet the hitter in its own stepCar this tick (it moved on, or the hitter came from
  // behind or beside it) takes its share here, so a side-swipe turns both cars.
  const unmet = (key: string, hitter: string): boolean => state.version >= BOX_CONTACT_VERSION && key.startsWith("p:") && !(contacts.get(key.slice(2)) ?? []).some((c) => c.key === hitter);
  for (const id of sortedIds(state.players)) {
    for (const k of contacts.get(id) ?? []) {
      if (k.key.startsWith("prop:")) hitProp(world, w, k, `p:${id}`, w.players[id]!.car.y);
      else receive(w, k.key, k, `p:${id}`, unmet(k.key, `p:${id}`));
      damageCar(w, id, w.players[id]!.car, k.x, k.z, Math.sqrt(k.j * k.j + k.jt * k.jt) / CAR.mass);
    }
  }

  // A manually driven taxi hits as its own ambient body, never as the rider's parked car.
  for(const id of [...agentContacts.keys()].sort((a,b)=>a-b)) {
    const index=w.index.get(id);if(index===undefined) continue;
    for(const hit of agentContacts.get(id)??[]) {
      const a=w.agents[index]!;
      if(hit.key.startsWith("prop:")) hitProp(world,w,hit,`a:${id}`,a.y);
      else receive(w,hit.key,hit,`a:${id}`,unmet(hit.key,`a:${id}`));
      const dv=Math.sqrt(hit.j*hit.j+hit.jt*hit.jt)/CAR.mass;
      const current=w.agents[index]!;
      w.agents[index]={...current,dents:addDents(current.dents??{front:0,rear:0,left:0,right:0},localOf(a.x,a.z,a.heading,hit.x,hit.z),a.halfLength??ROBOTAXI_BODY.halfLength,dv)};
    }
  }

  // 2. Knocked agents slide, sit, turn back and rejoin; parked cars slide.
  const removed = new Set<number>();
  for (let i = 0; i < w.agents.length; i++) {
    const a = w.agents[i]!;
    if (!a.knock || a.manualCar || w.fresh.has(a.id)) continue;
    if (!stepKnocked(world, w, i)) removed.add(a.id);
  }
  for (const id of sortedIds(w.players)) {
    const p = w.players[id]!;
    if (p.mode === "foot" || p.ride) stepParked(world, w, id);
  }

  resetProps(world, w);

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

interface SolidVehicle {
  key: string;
  player: PlayerId|null;
  agent: number|null;
  oldAgent: Readonly<AgentState>|null;
  motion: VehicleMotion;
  pose: VehicleHull;
  refused: boolean;
  recovered: boolean;
}

/**
 * v18's final physical vehicle seam. Individual movers still protect the static world and
 * people; this pass closes simultaneous movement and the rounded-corner gaps between them.
 * It shortens already proposed travel, never pushes a normally separated car sideways.
 */
export function resolveVehicleContacts(world: World, before: Readonly<SimState>, state: SimState): SimState {
  if(state.version<18)return state;
  const list=state.ext.agents?.list??[],oldAgents=new Map((before.ext.agents?.list??[]).map(a=>[a.id,a]));
  const bodies:SolidVehicle[]=[];
  const hull=(key:string,c:Readonly<{x:number;y:number;z:number;heading:number}>,hl:number,hw:number,height:number):VehicleHull=>({key,x:c.x,y:c.y,z:c.z,heading:c.heading,hl,hw,height});
  for(const id of sortedIds(state.players)){
    const car=state.players[id]!.car,old=before.players[id]?.car??car,key=`p:${id}`;
    const after=hull(key,car,CAR.halfLength,CAR.halfWidth,CAR.bodyHeight);
    bodies.push({key,player:id,agent:null,oldAgent:null,motion:{before:hull(key,old,CAR.halfLength,CAR.halfWidth,CAR.bodyHeight),after},pose:after,refused:false,recovered:false});
  }
  for(const a of list)if(AGENT_SPEC[a.kind].road){
    const old=oldAgents.get(a.id)??a,key=`a:${a.id}`,d=dimsOf(a),after=hull(key,a,d.hl,d.hw,d.height);
    bodies.push({key,player:null,agent:a.id,oldAgent:old,motion:{before:hull(key,old,d.hl,d.hw,d.height),after},pose:after,refused:false,recovered:false});
  }
  if(bodies.length<2)return state;
  bodies.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const pairs=vehiclePairs(bodies.map(b=>b.motion));
  if(!pairs.length)return state;
  const neighbours:number[][]=bodies.map(()=>[]);
  for(const [i,j] of pairs){neighbours[i]!.push(j);neighbours[j]!.push(i);}
  const w:Work={tick:state.tick,players:state.players,agents:list.slice(),index:new Map(list.map((a,i)=>[a.id,i])),
    ext:impactsOf(state)??{version:1,nextId:1,events:[],cars:{}},fresh:new Set(),combat:state.ext.combat,version:state.version,holdOnPerson:state.version>=27};
  const missed=new Map<number,{i:number;j:number;contact:HullContact}>();
  const poseChanged=(a:Readonly<VehicleHull>,b:Readonly<VehicleHull>)=>a.x!==b.x||a.y!==b.y||a.z!==b.z||a.heading!==b.heading;
  const trajectory=(b:SolidVehicle):VehicleMotion=>({before:b.motion.before,after:b.pose});
  const safe=(b:SolidVehicle,p:VehicleHull):boolean=>{
    const obstacles=slideObstacles(w,b.key,p.x,p.z,p.hl+p.hw+1).filter(c=>c.person);
    // A shortened turn or inherited-overlap recovery must keep the same solid street
    // props as ordinary driving. Broken props and vertically separate bodies stay clear.
    for(const prop of propsNear(world,p.x,p.z,p.hl+p.hw+1)){
      if(w.ext.props?.[prop.id])continue;
      const base=meshGroundHeight(world,prop.x,prop.z);
      if(p.y>=base+prop.height||p.y+p.height<=base)continue;
      obstacles.push({x:prop.x,z:prop.z,r:prop.r,person:false});
    }
    return !boxBlocked(world,p,p.y+ROOF_STEP_M,obstacles,p.y+p.height)&&!boxCrossedWall(world,p,b.motion.before);
  };
  const cut=(i:number,t:number):boolean=>{
    const b=bodies[i]!,a=b.agent===null?null:w.agents[w.index.get(b.agent)!];
    // An ambient follower's coordinates and complete path cursor are one pose. Refusing its
    // whole small step is safer than interpolating x/z while retaining a consumed connector.
    if(a&&!a.knock&&!a.manualCar&&!a.vehicle)t=0;
    let p=hullAt(trajectory(b),Math.max(0,t));
    if(!safe(b,p))p=b.motion.before;
    const changed=poseChanged(b.pose,p);
    if(changed){b.pose=p;b.refused=true;}
    return changed;
  };
  let changed=false;
  for(let pass=0;pass<4;pass++){
    let shortened=false;
    for(const [i,j] of pairs){
      const a=bodies[i]!,b=bodies[j]!,start=hullContact(a.motion.before,b.motion.before);
      // A legacy/save overlap is handled separately, with bounded validated recovery.
      if(hullBandsMeet(a.motion.before,b.motion.before)&&start.gap< -1e-8){
        const end=hullContact(a.pose,b.pose);
        if(hullBandsMeet(a.pose,b.pose)&&end.gap<start.gap-1e-8){shortened=cut(i,0)||shortened;shortened=cut(j,0)||shortened;}
        if(hullBandsMeet(a.pose,b.pose)&&end.gap<VEHICLE_SKIN)missed.set(i*bodies.length+j,{i,j,contact:end});
        continue;
      }
      const hit=sweepHulls(trajectory(a),trajectory(b),state.version>=27?128:32);
      if(!hit||hit.t>1)continue;
      missed.set(i*bodies.length+j,{i,j,contact:hit});
      // Tiny safety retreat also keeps a numerical touching pair free to move apart next tick.
      const t=Math.max(0,hit.t-1e-6);
      shortened=cut(i,t)||shortened;shortened=cut(j,t)||shortened;
    }
    changed=changed||shortened;
    if(!shortened)break;
  }
  // Dense chains can need more pair iterations than the normal budget. Roll back the whole
  // connected broad-phase component, so one rollback cannot introduce another chain contact.
  const roots=bodies.map((_,i)=>i),root=(i:number):number=>{while(roots[i]!==i){roots[i]=roots[roots[i]!]!;i=roots[i]!;}return i;};
  for(const [i,j] of pairs){const a=root(i),b=root(j);if(a!==b)roots[b]=a;}
  const blocked=new Set<number>();
  for(const [i,j] of pairs){
    const a=bodies[i]!,b=bodies[j]!;
    if(hullBandsMeet(a.motion.before,b.motion.before)&&hullContact(a.motion.before,b.motion.before).gap< -1e-8)continue;
    const hit=sweepHulls(trajectory(a),trajectory(b),state.version>=27?128:32);
    // A skin contact at the endpoint is expected; only an earlier intersection needs rollback.
    if(hit&&hit.t<1-1e-5)blocked.add(root(i));
  }
  for(let i=0;i<bodies.length;i++)if(blocked.has(root(i)))changed=cut(i,0)||changed;

  // Older saves can begin with intersecting hulls. Recover at most maxPush per body, only
  // along a validated free direction, and never worsen another vehicle's overlap.
  const recoveryUsed=bodies.map(()=>0);
  for(let pass=0;pass<2;pass++)for(const [i,j] of pairs){
    const a=bodies[i]!,b=bodies[j]!;
    if(!hullBandsMeet(a.pose,b.pose))continue;
    const contact=hullContact(a.pose,b.pose);if(contact.gap>=-1e-8)continue;
    for(const [index,sign] of [[i,1],[j,-1]] as const){
      const body=bodies[index]!,distance=Math.min(CAR.maxPush-recoveryUsed[index]!,CAR.maxPush/2,(-contact.gap+VEHICLE_SKIN)/2);
      if(distance<=1e-10)continue;
      const p={...body.pose,x:body.pose.x+contact.nx*distance*sign,z:body.pose.z+contact.nz*distance*sign};
      if(!safe(body,p))continue;
      let clear=true;
      for(const other of neighbours[index]!){
        if(other===(index===i?j:i))continue;
        const o=bodies[other]!.pose;if(!hullBandsMeet(p,o))continue;
        if(hullContact(p,o).gap<Math.min(0,hullContact(body.pose,o).gap)-1e-8){clear=false;break;}
      }
      if(clear){body.pose=p;body.recovered=true;recoveryUsed[index]=recoveryUsed[index]!+distance;changed=true;}
    }
  }

  const repose=(c:CarState,p:VehicleHull):CarState=>{
    const v=carVelocity(c),fx=dsin(p.heading),fz=-dcos(p.heading);
    return {...c,x:p.x,y:p.y,z:p.z,heading:p.heading,speed:(v.vx*fx+v.vz*fz)+0,lateral:(v.vx*-fz+v.vz*fx)+0};
  };
  for(const body of bodies){
    if(!poseChanged(body.motion.after,body.pose))continue;
    const p=body.pose;
    if(body.player!==null){
      const player=w.players[body.player]!;
      w.players={...w.players,[body.player]:{...player,car:repose(player.car,p)}};
    }else{
      const index=w.index.get(body.agent!)!,a=w.agents[index]!;
      let next:AgentState={...a,x:p.x,y:p.y,z:p.z,heading:p.heading};
      if(body.refused&&!a.knock&&!a.manualCar&&!a.vehicle&&body.oldAgent){
        const old=body.oldAgent;
        next={...next,edge:old.edge,dir:old.dir,lane:old.lane,s:old.s,next:old.next,ndir:old.ndir,nlane:old.nlane,
          conn:old.conn,node:old.node,resume:old.resume,lat:old.lat,wait:old.wait+1,mode:"yield"};
        // v27: a refused whole route step has no travelled velocity. Keeping the attempted
        // speed made a stationary holder look mobile forever to following traffic.
        if(state.version>=27)next.speed=0;
        if(old.pass)next.pass=old.pass;else delete next.pass;
        if(old.trafficRoute)next.trafficRoute=old.trafficRoute;else delete next.trafficRoute;
      }
      if(body.recovered&&!next.knock&&!next.manualCar&&!next.vehicle)next={...next,knock:{phase:"stopped",vx:0,vz:0,yaw:0,t:0,age:0},speed:0,mode:"honk",node:""};
      if(next.vehicle){const car=repose(next.vehicle,p);next={...next,vehicle:car,speed:car.speed};}
      if(next.manualCar){const car=repose(next.manualCar,p);next={...next,manualCar:car,speed:car.speed};}
      w.agents[index]=next;
    }
  }
  let impulsed=false;
  const velocity=(b:SolidVehicle):{vx:number;vz:number}=>{
    if(b.player!==null)return carVelocity(w.players[b.player]!.car);
    const a=w.agents[w.index.get(b.agent!)!]!;
    return !a.knock&&a.vehicle&&!a.manualCar?carVelocity(a.vehicle):agentVelocity(a);
  };
  const markHit=(body:SolidVehicle,speed:number):void=>{
    const mark=(c:CarState):CarState=>({...c,speed:c.speed+0,lateral:c.lateral+0,yawRate:c.yawRate+0,sinceContact:0,
      ...(speed>=CAR.hitMinSpeed&&c.sinceContact>=CAR.hitCooldown?{hits:c.hits+1,impactSpeed:speed}:{})});
    if(body.player!==null){const p=w.players[body.player]!;w.players={...w.players,[body.player]:{...p,car:mark(p.car)}};}
    else{const index=w.index.get(body.agent!)!,a=w.agents[index]!;
      w.agents[index]={...a,...(a.vehicle?{vehicle:mark(a.vehicle)}:{}),...(a.manualCar?{manualCar:mark(a.manualCar)}:{})};}
  };
  for(const {i,j} of missed.values()){
    const a=bodies[i]!,b=bodies[j]!;
    // A later pair can shorten this body's motion before an earlier recorded contact. Only
    // a contact still reached by the final hulls can exchange momentum or emit a crunch.
    if(!hullBandsMeet(a.pose,b.pose))continue;
    const contact=hullContact(a.pose,b.pose);
    if(contact.gap>VEHICLE_SKIN+.0001)continue;
    if(w.ext.events.some(e=>e.tick===state.tick&&(e.a===a.key&&e.b===b.key||e.a===b.key&&e.b===a.key)))continue;
    const av=velocity(a),bv=velocity(b),ad=a.player!==null?CAR_DIMS:dimsOf(w.agents[w.index.get(a.agent!)!]!),bd=b.player!==null?CAR_DIMS:dimsOf(w.agents[w.index.get(b.agent!)!]!);
    // v25: the two boxes (grown by the contact skin, so the touching pair overlaps) give the
    // clipped contact point and face normal (car.ts boxHit).
    const grown=VEHICLE_SKIN*2;
    const box=state.version>=BOX_CONTACT_VERSION?boxContact({x:a.pose.x,z:a.pose.z,heading:a.pose.heading,hl:a.pose.hl+grown,hw:a.pose.hw+grown},{x:b.pose.x,z:b.pose.z,heading:b.pose.heading,hl:b.pose.hl+grown,hw:b.pose.hw+grown}):null;
    const hit=box?boxHit({mass:ad.mass,k2:ad.k2,x:a.pose.x,z:a.pose.z,...av},
      {key:b.key,mass:bd.mass,x:b.pose.x,z:b.pose.z,...bv},box,CAR.bodyRestitution,CAR.boxFriction)
      :bodyHit({mass:ad.mass,k2:ad.k2,x:a.pose.x,z:a.pose.z,...av},
      {key:b.key,mass:bd.mass,x:b.pose.x,z:b.pose.z,...bv},
      {x:contact.x,z:contact.z,r:0,person:false},contact.nx,contact.nz,CAR.bodyRestitution);
    if(!hit)continue;
    // v26: a creeping touch between two vehicles nobody drives is a lean, not a hit (TOUCH_CONTACT_MPS).
    // A taxi a player has taken (manualCar) is driven, though its body carries no player id.
    const driven=(body:SolidVehicle):boolean=>body.player!==null||(body.agent!==null&&!!w.agents[w.index.get(body.agent)!]?.manualCar);
    if(state.version>=TRUNDLE_FREE_VERSION&&!driven(a)&&!driven(b)&&hit.contact.speed<TOUCH_CONTACT_MPS)continue;
    // receive understands knock velocity. Runtime physical controls also carry lateral speed.
    for(const body of [a,b])if(body.agent!==null){const index=w.index.get(body.agent)!,actor=w.agents[index]!;
      if(actor.vehicle&&!actor.manualCar&&!actor.knock){const v=carVelocity(actor.vehicle);w.agents[index]={...actor,knock:{phase:"slide",...v,yaw:actor.vehicle.yawRate,t:0,age:0}};}}
    const k=hit.contact;
    receive(w,a.key,{...k,nx:-k.nx,nz:-k.nz,tx:-k.tx,tz:-k.tz},b.key,true);
    receive(w,b.key,k,a.key,true);
    markHit(a,k.speed);markHit(b,k.speed);impulsed=true;
  }
  if(!changed&&!impulsed)return state;
  // Both controller memories must follow the authoritative outer body, including a new knock.
  w.agents=w.agents.map(a=>{
    if(!a.vehicle&&!a.manualCar)return a;
    const sync=(c:CarState):CarState=>{
      const v=a.knock??carVelocity(c),fx=dsin(a.heading),fz=-dcos(a.heading);
      return {...c,x:a.x,y:a.y,z:a.z,heading:a.heading,speed:(v.vx*fx+v.vz*fz)+0,lateral:(v.vx*-fz+v.vz*fx)+0,yawRate:(a.knock?.yaw??c.yawRate)+0};
    };
    return {...a,...(a.vehicle?{vehicle:sync(a.vehicle)}:{}),...(a.manualCar?{manualCar:sync(a.manualCar)}:{})};
  });
  return {...state,players:w.players,ext:{...state.ext,...(state.ext.agents?{agents:{...state.ext.agents,list:w.agents}}:{}),...(impulsed?{impacts:w.ext}:{})}};
}
