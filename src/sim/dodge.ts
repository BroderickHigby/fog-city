// The dodge: nobody is ever run over (the owner's Crazy Taxi rule, 2026-10-21; docs/design.md,
// "Vehicles never hurt people"). Pure and deterministic; step.ts runs it once a tick, after the
// players' cars and the agents have moved.
//
// For every person, animal and robot agent, and every player on foot (against cars that are not
// their own):
//  1. Watch. Every vehicle moving at DODGE_MIN_SPEED or more (player cars, robotaxis) predicts
//     its swept footprint for the next T seconds (horizonS: 0.6 s plus 0.025 s per m/s, at most
//     1.5 s): its body along the arc its velocity and yaw rate draw and, while it turns, along
//     the straight line it would slide on too, so a drifting or handbraking car counts. A
//     robotaxi that is already braking is predicted to keep braking (it stops for people by
//     itself); a player's car never is (the brake can be let go). A body within its margin of
//     that footprint (DODGE_PROFILE: 0.75 m; 1.25 m for children and anyone seated, lying or
//     using a mobility aid) dives.
//  2. Dive, Crazy Taxi style. The landing spot is the cheapest clear spot on a fan of lines:
//     square to the vehicle's path on the side the body is on, then angled, then the other side.
//     A line ends at a building, a wall (the world's edge, the shore, a kerb rail over water) or
//     a step of more than 1.5 m; a spot must be clear of every predicted footprint (with the
//     margin), of parked vehicles, and of other bodies and other divers' landing spots ("never
//     into another path"), and the line to it must stay clear of the vehicle on the way (a
//     space-time check). The body leaps at its dive speed (7-9 m/s; pigeons flutter up, the dog
//     bounds, robots skid and hop) with a hop, lands and recovers (about a second: gets up,
//     brushes off); an agent then carries on along its path from where it landed. Threatened
//     again while diving or recovering, it dives again from where it is.
//  3. The hard guarantee, which no tuning removes: then any person, animal or player on foot
//     within its override clearance (0.3 m; 0.6 m for the vulnerable) of a moving vehicle's
//     body, or inside any vehicle's body, is put at the nearest free spot outside every vehicle
//     (a superhuman leap, drawn as a big hop). Cars never collide with people at all (step.ts
//     gives them no person or animal obstacles): a car is never stopped, slowed or deflected by
//     one, and its personBumps stays 0.
//
// Robots dodge by the same rules but are not under the override: they stay solid to cars (a car
// that reaches one stops against it), and water is the only way to beat one.
//
// Counters (ext.dodge, DodgeExt): contacts (a protected body found inside a vehicle's body
// before the override moved it: must stay 0; a player's car counts its own in personBumps),
// overrides, dives and near misses (also on the player's car, CarState.nearMisses, for scoring
// and barks). Order: players in sortedIds order, then agents by ascending id; each body's
// decision sees the spots the bodies before it chose.

import { DT, sortedIds, type CarState, type DodgeState, type FootState, type PlayerId, type PlayerState, type SimState } from "./contract.ts";
import { clamp, dcos, dsin, wrapAngle } from "./dmath.ts";
import { hash32 } from "./rng.ts";
import { CAR } from "./car.ts";
import { FOOT } from "./foot.ts";
import {
  AGENTS_EXT_KEY,
  AGENT_SPEC,
  LOD_STRIDE,
  NEAR_RANGE_M,
  agentCircles,
  agentRoute,
  personIsChild,
  playerBodies,
  rejoinAt,
  type AgentKind,
  type AgentState,
  type AgentsExt,
} from "./agents.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { cellKey, circleBlocked, meshGroundHeight, segmentBlocked, surfaceHeight, type World } from "./world.ts";

// ---------------------------------------------------------------- tuning (the guarantee is not tunable)

/** Vehicles slower than this threaten nobody (the override still keeps bodies out of them). */
export const DODGE_MIN_SPEED = 2;
/** A vehicle at or below this speed is parked for the override: only its body counts, no clearance. */
export const PARKED_SPEED = 0.3;
/** How far a body watches vehicles, metres; more for a vehicle whose predicted footprint reaches further. */
export const WATCH_M = 40;
/** Spacing of the predicted footprint's samples, seconds. */
export const SAMPLE_S = 0.05;
/**
 * A player's car can steer anywhere, so its predicted footprint widens with time by this much,
 * m/s (a chase at the body: it dives earlier and further). Robotaxis keep to their lanes: 0.
 */
export const PLAYER_SPREAD_MPS = 1;
/** A landing spot keeps this much more than the margin from every predicted footprint, metres. */
export const LANDING_EXTRA_M = 0.35;
/**
 * Robotaxis brake for anyone in their path by themselves (agents.ts: people have right of way),
 * at up to 9 m/s^2 from the tick after they see them, so their predicted footprint ends where
 * braking this hard from there stops them: the dodge comes in only when they cannot stop in time.
 */
export const ROBOTAXI_BRAKE_MPS2 = 6;
export const ROBOTAXI_REACT_S = 2 * DT;
/** Leaps by the override last this long, ticks. */
export const LEAP_TICKS = 24;
/** Bodies keep at least this much room between each other when they land, metres. */
export const LANDING_GAP_M = 0.1;
/** A dive's line keeps at least this clear of a stopped vehicle's body, metres. */
export const STOPPED_GAP_M = 0.05;
/**
 * The line to a landing spot keeps at least this clear of the vehicle on the way, metres (a line
 * keeping the body's whole margin is taken first when there is one).
 */
export const PASSING_M = 0.2;
/**
 * A body the vehicle reaches within this many seconds (it saw it late: a car that swerved, or
 * was flung off a wall) scrambles: it dives EMERGENCY_BOOST times as fast.
 */
export const EMERGENCY_S = 0.45;
export const EMERGENCY_BOOST = 1.5;
/** The most a dive climbs or drops, metres; the override's leap, OVERRIDE_STEP_M. */
export const DIVE_STEP_M = 1.5;
export const OVERRIDE_STEP_M = 3;
/** The override looks this far for a free spot, metres (then CLEAR_FAR_M, coarser). */
export const CLEAR_NEAR_M = 12;
export const CLEAR_FAR_M = 30;

/** A vehicle whose velocity is more than this off its nose is sliding (cos 0.15 rad): it may straighten out along its nose. */
export const SLIP_RAD = 0.15;
const SLIP_COS = dcos(SLIP_RAD);

/** Seconds of a vehicle's path that are predicted at `speed` m/s: 0.6 s, plus 0.025 s per m/s, at most 1.5 s. */
export function horizonS(speed: number): number {
  return clamp(0.6 + 0.025 * speed, 0.6, 1.5);
}

/** Who dodges how. */
export type DodgeClass = "person" | "care" | "player" | "errandRobot" | "sidewalkBot";

export interface DodgeProfile {
  /** Dives when within this of a vehicle's predicted footprint, metres. */
  margin: number;
  /** The override: placed outside a moving vehicle closer than this, metres; null: not under it (robots). */
  override: number | null;
  /** Dive speed, m/s; the longest dive, metres; the shortest, ticks. */
  speed: number;
  maxDive: number;
  minTicks: number;
  /** Peak hop of a dive, and of the override's leap, metres. */
  peak: number;
  leapPeak: number;
  /** Getting up after landing, ticks. */
  recover: number;
}

export const DODGE_PROFILE: Readonly<Record<DodgeClass, DodgeProfile>> = {
  person: { margin: 0.75, override: 0.3, speed: 9, maxDive: 5.5, minTicks: 12, peak: 0.45, leapPeak: 2.0, recover: 60 },
  // Children, and anyone seated, lying down or using a mobility aid: a wider berth both ways.
  care: { margin: 1.25, override: 0.6, speed: 8, maxDive: 5.5, minTicks: 12, peak: 0.35, leapPeak: 2.0, recover: 60 },
  // A player on foot gets control back sooner.
  player: { margin: 0.75, override: 0.3, speed: 9, maxDive: 5.5, minTicks: 12, peak: 0.45, leapPeak: 2.0, recover: 30 },
  // The Footman hops aside; the Trundle skids with a little hop.
  errandRobot: { margin: 0.75, override: null, speed: 7, maxDive: 5, minTicks: 12, peak: 0.3, leapPeak: 0, recover: 30 },
  sidewalkBot: { margin: 0.75, override: null, speed: 7, maxDive: 5, minTicks: 12, peak: 0.12, leapPeak: 0, recover: 24 },
};

/** The dodge class of an ambient agent, or null for vehicles (robotaxis). */
export function agentDodgeClass(a: Readonly<Pick<AgentState, "id" | "kind">>): DodgeClass | null {
  const kind: AgentKind = a.kind;
  if (kind === "robotaxi") return null;
  if (kind === "person") return personIsChild(a.id) ? "care" : "person";
  return kind;
}

/** state.ext.dodge */
export interface DodgeExt {
  /** Protected bodies found inside a vehicle's body before the override moved them: must stay 0. */
  contacts: number;
  /** Times the override put someone outside a vehicle (the dive had not cleared them). */
  overrides: number;
  /** Dives started. */
  dives: number;
  /** Dives and leaps caused by a vehicle (any vehicle; a player's own also on CarState.nearMisses). */
  nearMisses: number;
}

export const DODGE_EXT_KEY = "dodge";

export function dodgeExtOf(state: Readonly<SimState>): DodgeExt {
  return (state.ext[DODGE_EXT_KEY] as DodgeExt | undefined) ?? { contacts: 0, overrides: 0, dives: 0, nearMisses: 0 };
}

// ---------------------------------------------------------------- vehicles and their predicted footprint

/** One predicted pose: time, body centre, body forward (unit), direction of travel (unit). */
export interface Sample {
  t: number;
  x: number;
  z: number;
  fx: number;
  fz: number;
  ux: number;
  uz: number;
}

/** A point on a route ahead: position, unit tangent, distance along it. */
export interface RoutePoint {
  x: number;
  z: number;
  tx: number;
  tz: number;
  d: number;
}

export interface Vehicle {
  /** "p:<player id>" or "a:<agent id>". */
  key: string;
  /** The player whose car this is, else null. */
  player: PlayerId | null;
  x: number;
  z: number;
  /** Body forward (unit) and half extents. */
  fx: number;
  fz: number;
  hl: number;
  hw: number;
  /** Body as circles instead of the box (robotaxis: the circles the sim moves them by), else null. */
  circles: Array<{ x: number; z: number; r: number }> | null;
  /** World velocity, m/s, and its size. */
  vx: number;
  vz: number;
  speed: number;
  /** rad/s, + = clockwise. */
  yawRate: number;
  /** Braking the prediction counts on, m/s^2, from `react` seconds on. */
  decel: number;
  react: number;
  /** How fast the predicted footprint widens with time, m/s (PLAYER_SPREAD_MPS for a player's car). */
  spread: number;
  /** The route it will drive (a robotaxi's lane and connectors, agents.ts agentRoute), else null: predicted from its yaw rate. */
  route: RoutePoint[] | null;
  /** Predicted paths (empty below DODGE_MIN_SPEED), and their bounds widened by the body's reach (and spread). */
  paths: Sample[][];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Rotate a compass-frame direction (x east, z south) clockwise by the angle whose cos and sin are (c, s). */
function rot(x: number, z: number, c: number, s: number): [number, number] {
  return [x * c - z * s, z * c + x * s];
}

/** What else a vehicle may have (Vehicle's fields of the same names); predict false: no paths (nobody is near enough to need them). */
export interface VehicleOptions {
  circles?: Array<{ x: number; z: number; r: number }> | null;
  spread?: number;
  react?: number;
  route?: RoutePoint[] | null;
  predict?: boolean;
}

/**
 * A vehicle and its predicted footprint. Heading as a compass bearing; (vx, vz) the world
 * velocity; decel the braking to count on (0 for a player's car).
 */
export function makeVehicle(
  key: string,
  player: PlayerId | null,
  x: number,
  z: number,
  heading: number,
  hl: number,
  hw: number,
  vx: number,
  vz: number,
  yawRate: number,
  decel: number,
  opts: VehicleOptions = {},
): Vehicle {
  const circles = opts.circles ?? null;
  const spread = opts.spread ?? 0;
  const react = opts.react ?? 0;
  const route = opts.route ?? null;
  const speed = Math.sqrt(vx * vx + vz * vz);
  const v: Vehicle = {
    key,
    player,
    x,
    z,
    fx: dsin(heading),
    fz: -dcos(heading),
    hl,
    hw,
    circles,
    vx,
    vz,
    speed,
    yawRate,
    decel,
    react,
    spread,
    route,
    paths: [],
    minX: x,
    minZ: z,
    maxX: x,
    maxZ: z,
  };
  v.paths = opts.predict === false ? [] : predictPaths(v);
  const reach = hl + hw + spread * horizonS(speed);
  for (const p of v.paths) {
    for (const s of p) {
      if (s.x < v.minX) v.minX = s.x;
      if (s.x > v.maxX) v.maxX = s.x;
      if (s.z < v.minZ) v.minZ = s.z;
      if (s.z > v.maxZ) v.maxZ = s.z;
    }
  }
  v.minX -= reach;
  v.minZ -= reach;
  v.maxX += reach;
  v.maxZ += reach;
  return v;
}

/** A player's car as a vehicle: velocity from speed and slide, yaw rate from the car, its footprint widening PLAYER_SPREAD_MPS. */
export function vehicleOfCar(id: PlayerId, c: Readonly<CarState>): Vehicle {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const spread = PLAYER_SPREAD_MPS;
  // Right of forward is (-fz, fx).
  return makeVehicle(`p:${id}`, id, c.x, c.z, c.heading, CAR.halfLength, CAR.halfWidth, c.speed * fx - c.lateral * fz, c.speed * fz + c.lateral * fx, c.yawRate, 0, { spread });
}

/**
 * A robotaxi as a vehicle: along its route (agentRoute, when the world has roads), braking for
 * whoever is in its path (at least ROBOTAXI_BRAKE_MPS2, more when it is already braking harder,
 * after ROBOTAXI_REACT_S), and its body as the two circles it moves by. Its yaw rate and braking
 * come from its previous pose (`prev`, stepped `dt` seconds ago).
 */
export function vehicleOfAgent(a: Readonly<AgentState>, prev: Readonly<AgentState> | null, dt: number, world: World | null = null, predict = true): Vehicle {
  const spec = AGENT_SPEC[a.kind];
  let yaw = 0;
  let decel = ROBOTAXI_BRAKE_MPS2;
  if (prev && prev !== a && dt > 0) {
    yaw = clamp(wrapAngle(a.heading - prev.heading) / dt, -2, 2);
    decel = clamp((prev.speed - a.speed) / dt, ROBOTAXI_BRAKE_MPS2, 9);
  }
  const fx = dsin(a.heading);
  const fz = -dcos(a.heading);
  const route = predict && world && a.speed >= DODGE_MIN_SPEED ? agentRoute(world, a, a.speed * horizonS(a.speed) + 1, 0.5) : null;
  return makeVehicle(`a:${a.id}`, null, a.x, a.z, a.heading, spec.halfLength, spec.halfWidth, a.speed * fx, a.speed * fz, yaw, decel, {
    circles: agentCircles(a),
    react: ROBOTAXI_REACT_S,
    route: route && route.length >= 2 ? route : null,
    predict,
  });
}

/**
 * The predicted paths of a vehicle: samples every SAMPLE_S over horizonS(speed). Along its
 * route when it has one (a robotaxi). Otherwise, turning (a yaw rate that turns it more than
 * 0.05 rad over the horizon): the arc its velocity draws as it turns; the straight line it would
 * slide along with its body still yawing (a drift or a handbrake turn); and, for a vehicle that
 * can be steered anywhere (spread > 0, a player's car), the arc of the hardest turn its tyres
 * allow that way (CAR.gripAccel / speed, so a car chasing someone round a bend is not
 * underestimated). Not turning: one straight path. Sliding (its velocity more than
 * SLIP_RAD off its nose): also the path it takes if its tyres bite again, setting off along its
 * nose (a drift caught straightens out toward wherever the nose points, faster than any turn).
 * Braking (decel, after react) shortens them;
 * a stopped vehicle's last sample is where it stops. Walls and buildings are not in it: the
 * footprint never pretends a wall stops a car short of someone (and when a car bounces off one
 * at someone, they see it late and scramble, EMERGENCY_BOOST).
 */
export function predictPaths(
  v: Readonly<Pick<Vehicle, "x" | "z" | "fx" | "fz" | "vx" | "vz" | "speed" | "yawRate" | "decel" | "react"> & { route?: RoutePoint[] | null; spread?: number }>,
): Sample[][] {
  if (v.speed < DODGE_MIN_SPEED) return [];
  const T = horizonS(v.speed);
  const n = Math.ceil(T / SAMPLE_S - 1e-9);
  if (v.route) return [alongRoute(v, v.route, n)];
  const yaw = v.yawRate;
  const turning = (yaw < 0 ? -yaw : yaw) * T > 0.05;
  // [yaw rate of the path, yaw rate of the body, sets off along the nose]
  const kinds: Array<[number, number, boolean]> = turning ? [[yaw, yaw, false], [0, yaw, false]] : [[0, yaw, false]];
  if (turning && (v.spread ?? 0) > 0) {
    const hard = Math.min(CAR.gripAccel / v.speed, 1.2);
    if (hard > (yaw < 0 ? -yaw : yaw)) kinds.push([yaw < 0 ? -hard : hard, yaw < 0 ? -hard : hard, false]);
  }
  // (cos of the angle between the velocity and the nose)
  if ((v.vx * v.fx + v.vz * v.fz) / v.speed < SLIP_COS) kinds.push([yaw, yaw, true]);
  const out: Sample[][] = [];
  for (const [pathYaw, bodyYaw, nose] of kinds) {
    const dA = pathYaw * SAMPLE_S;
    const c = dcos(dA);
    const s = dsin(dA);
    const ch = dcos(dA / 2);
    const sh = dsin(dA / 2);
    const bA = bodyYaw * SAMPLE_S;
    const bc = dcos(bA);
    const bs = dsin(bA);
    const path: Sample[] = [];
    let x = v.x;
    let z = v.z;
    let fx = v.fx;
    let fz = v.fz;
    let ux = nose ? v.fx : v.vx / v.speed;
    let uz = nose ? v.fz : v.vz / v.speed;
    path.push({ t: 0, x, z, fx, fz, ux, uz });
    for (let k = 1; k <= n; k++) {
      const { d, stopped } = stepDistance(v, k);
      if (pathYaw !== 0) {
        const [mx, mz] = rot(ux, uz, ch, sh);
        x += mx * d;
        z += mz * d;
        [ux, uz] = rot(ux, uz, c, s);
      } else {
        x += ux * d;
        z += uz * d;
      }
      [fx, fz] = rot(fx, fz, bc, bs);
      path.push({ t: k * SAMPLE_S, x, z, fx, fz, ux, uz });
      if (stopped) break;
    }
    out.push(path);
  }
  return out;
}

/** How far a vehicle goes in sample k's step: constant speed until `react`, then braking at `decel` (to a stop). */
function stepDistance(v: Readonly<Pick<Vehicle, "speed" | "decel" | "react">>, k: number): { d: number; stopped: boolean } {
  const cruise = Math.min(SAMPLE_S, Math.max(0, v.react - (k - 1) * SAMPLE_S));
  const braking = SAMPLE_S - cruise;
  const s0 = Math.max(0, v.speed - v.decel * Math.max(0, (k - 1) * SAMPLE_S - v.react));
  const s1 = Math.max(0, s0 - v.decel * braking);
  const d = cruise * v.speed + (s1 === 0 && v.decel > 0 ? (s0 * s0) / (2 * v.decel) : ((s0 + s1) / 2) * braking);
  return { d, stopped: s1 === 0 };
}

/** The predicted poses of a vehicle that keeps to a route: its body centred on it, facing along it. */
function alongRoute(v: Readonly<Pick<Vehicle, "x" | "z" | "fx" | "fz" | "speed" | "decel" | "react">>, route: readonly RoutePoint[], n: number): Sample[] {
  const out: Sample[] = [{ t: 0, x: v.x, z: v.z, fx: v.fx, fz: v.fz, ux: v.fx, uz: v.fz }];
  let dist = 0;
  let i = 0;
  for (let k = 1; k <= n; k++) {
    const st = stepDistance(v, k);
    dist += st.d;
    while (i + 2 < route.length && route[i + 1]!.d <= dist) i++;
    const a = route[i]!;
    const b = route[i + 1]!;
    const f = b.d > a.d ? clamp((dist - a.d) / (b.d - a.d), 0, 1) : 0;
    const tx = a.tx + (b.tx - a.tx) * f;
    const tz = a.tz + (b.tz - a.tz) * f;
    const tl = Math.sqrt(tx * tx + tz * tz);
    const ux = tl > 1e-9 ? tx / tl : v.fx;
    const uz = tl > 1e-9 ? tz / tl : v.fz;
    out.push({ t: k * SAMPLE_S, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, fx: ux, fz: uz, ux, uz });
    if (st.stopped) break;
  }
  return out;
}

/** Signed distance from (px, pz) to a box (centre, unit forward, half extents): negative inside. */
export function boxDistance(px: number, pz: number, x: number, z: number, fx: number, fz: number, hl: number, hw: number): number {
  const ox = px - x;
  const oz = pz - z;
  const along = ox * fx + oz * fz;
  const lat = -ox * fz + oz * fx;
  const dl = (lat < 0 ? -lat : lat) - hw;
  const df = (along < 0 ? -along : along) - hl;
  if (dl <= 0 && df <= 0) return dl > df ? dl : df;
  const el = dl > 0 ? dl : 0;
  const ef = df > 0 ? df : 0;
  return Math.sqrt(el * el + ef * ef);
}

/** Signed distance from (px, pz) to a vehicle's body as it is now (its circles for a robotaxi). */
export function bodyDistance(v: Readonly<Vehicle>, px: number, pz: number): number {
  if (v.circles) {
    let best = Infinity;
    for (const c of v.circles) {
      const d = Math.sqrt((px - c.x) * (px - c.x) + (pz - c.z) * (pz - c.z)) - c.r;
      if (d < best) best = d;
    }
    return best;
  }
  return boxDistance(px, pz, v.x, v.z, v.fx, v.fz, v.hl, v.hw);
}

export interface Hit {
  /** Seconds until the vehicle's body comes within reach. */
  t: number;
  /** The predicted pose then. */
  sample: Sample;
}

/** The first predicted moment a vehicle's body comes within `reach` (plus its spread by then) of (px, pz), or null. */
export function sweepHit(v: Readonly<Vehicle>, px: number, pz: number, reach: number): Hit | null {
  if (px < v.minX - reach || px > v.maxX + reach || pz < v.minZ - reach || pz > v.maxZ + reach) return null;
  let best: Hit | null = null;
  for (const path of v.paths) {
    for (const s of path) {
      if (best && s.t >= best.t) break;
      if (boxDistance(px, pz, s.x, s.z, s.fx, s.fz, v.hl, v.hw) < reach + v.spread * s.t) {
        best = { t: s.t, sample: s };
        break;
      }
    }
  }
  return best;
}

/**
 * The least distance from (px, pz) to a vehicle's predicted footprint, less its spread at each
 * moment unless `spread` is false (its body now when it has none).
 */
export function sweepClearance(v: Readonly<Vehicle>, px: number, pz: number, spread = true): number {
  if (v.paths.length === 0) return bodyDistance(v, px, pz);
  const k = spread ? v.spread : 0;
  let best = Infinity;
  for (const path of v.paths) {
    for (const s of path) {
      const d = boxDistance(px, pz, s.x, s.z, s.fx, s.fz, v.hl, v.hw) - k * s.t;
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- choosing where to dive

/** A body that may dodge. */
export interface Body {
  x: number;
  z: number;
  /** Ground height under it (no hop). */
  y: number;
  r: number;
  cls: DodgeClass;
  /** Tie-break for a body square on a vehicle's line: which side it favours. */
  id: number;
}

/** A spot taken by a body or a diver's landing. */
export interface Spot {
  x: number;
  z: number;
  r: number;
}

/** The static world a dive checks. */
export interface Ground {
  world: World;
  /** Ground height at (x, z) for this body (feet at `feet`). */
  height(x: number, z: number, feet: number): number;
}

/**
 * Is the spot clear of every vehicle's predicted footprint (plus margin, and its spread unless
 * `spread` is false) and every parked or slow vehicle's body (plus 0.3 m)?
 */
function clearOfVehicles(vehicles: readonly Vehicle[], x: number, z: number, r: number, margin: number, spread = true): boolean {
  for (const v of vehicles) {
    if (v.paths.length > 0) {
      if (x < v.minX - r - margin || x > v.maxX + r + margin || z < v.minZ - r - margin || z > v.maxZ + r + margin) continue;
      if (sweepClearance(v, x, z, spread) < r + margin) return false;
    } else if (bodyDistance(v, x, z) < r + 0.3) {
      return false;
    }
  }
  return true;
}

/** Is (x, z) at least r (plus a hair) from the body of every vehicle not moving fast enough to have a footprint (parked, waiting, creeping)? A dive's line never goes through one. */
function clearOfStopped(stopped: readonly Vehicle[], x: number, z: number, r: number): boolean {
  for (const v of stopped) if (bodyDistance(v, x, z) < r + STOPPED_GAP_M) return false;
  return true;
}

/** Does the line from (px, pz) to (x, z) keep clear of every stopped vehicle's body (clearOfStopped every MARCH_M)? */
function lineClearOfStopped(stopped: readonly Vehicle[], px: number, pz: number, x: number, z: number, r: number): boolean {
  if (stopped.length === 0) return true;
  const len = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
  const n = Math.max(1, Math.ceil(len / MARCH_M));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    if (!clearOfStopped(stopped, px + (x - px) * f, pz + (z - pz) * f, r)) return false;
  }
  return true;
}

/** The least clearance of the spot from every vehicle's footprint (for a best effort). */
function vehicleClearance(vehicles: readonly Vehicle[], x: number, z: number): number {
  let best = Infinity;
  for (const v of vehicles) {
    const d = sweepClearance(v, x, z);
    if (d < best) best = d;
  }
  return best;
}

function spotFree(spots: readonly Spot[], x: number, z: number, r: number): boolean {
  for (const s of spots) {
    const lim = r + s.r + LANDING_GAP_M;
    if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < lim * lim) return false;
  }
  return true;
}

/**
 * Does a body leaving (px, pz) along (wx, wz) at `speed` for `len` metres stay `passing` (plus
 * the spread) clear of every moving vehicle's predicted body on the way? It has moved one tick
 * when the samples' clock starts (they are the vehicles after this tick's move).
 */
function passesClear(vehicles: readonly Vehicle[], px: number, pz: number, wx: number, wz: number, len: number, speed: number, r: number, passing = PASSING_M): boolean {
  for (const v of vehicles) {
    for (const path of v.paths) {
      for (const s of path) {
        const along = Math.min(len, speed * (s.t + DT));
        const x = px + wx * along;
        const z = pz + wz * along;
        if (boxDistance(x, z, s.x, s.z, s.fx, s.fz, v.hl, v.hw) < r + passing + v.spread * s.t) return false;
      }
    }
  }
  return true;
}

/**
 * Angles (radians) away from square to the path that a dive tries, and what each costs (metres):
 * + turns the dive back against the travel (toward where the vehicle is), which costs more, since
 * a car steering after the body closes that way first.
 */
const FAN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-0.35, 0.3],
  [0.35, 0.45],
  [-0.75, 0.7],
  [0.75, 1.1],
  [-1.15, 1.2],
  [1.15, 1.8],
];
/** Extra cost of diving to the other side of the vehicle's path, metres. */
const OTHER_SIDE_COST = 1.2;
/** A dive across a vehicle's path keeps this much more clear of it on the way, metres. */
const CROSSING_EXTRA_M = 1;
/** Extra cost of landing on another body or another diver's landing spot, metres. */
const CROWDED_COST = 2;
/** Extra cost of turning a dive under way straight back, metres (less for a smaller turn). */
const REVERSE_COST = 3;
const MARCH_M = 0.25;

/**
 * Where a body dives: the cheapest landing spot (cost = its distance plus the FAN and
 * OTHER_SIDE_COST penalties). `threat` is the earliest hit (its pose sets "square to the path"
 * and the side the body is on); `vehicles` every vehicle near enough to matter; `spots` bodies
 * and landing spots to keep clear of. A spot must be clear of every vehicle with the body's
 * margin, its line must be clear of buildings, walls and big steps, of every stopped vehicle's
 * body, and of the moving vehicles on the way (by the body's margin when any line is, else by
 * PASSING_M). When nothing qualifies with the spots, again without them; when still nothing, the spot
 * on the lines with the most clearance from the vehicles (a best effort the override backs
 * up), or null when no line leads anywhere. `prefer` (a unit direction: a dive already under
 * way) keeps a body from changing its mind: its side is the side that direction is on, and a
 * line turning back against it costs up to REVERSE_COST more.
 */
export function chooseDive(
  g: Ground,
  b: Readonly<Body>,
  threat: Readonly<Hit>,
  vehicles: readonly Vehicle[],
  spots: readonly Spot[],
  prefer: { x: number; z: number } | null = null,
  speed = DODGE_PROFILE[b.cls].speed,
): { x: number; z: number } | null {
  const prof = DODGE_PROFILE[b.cls];
  const s = threat.sample;
  // Right of the direction of travel.
  const nx = -s.uz;
  const nz = s.ux;
  const lat = (b.x - s.x) * nx + (b.z - s.z) * nz;
  const along = prefer ? prefer.x * nx + prefer.z * nz : 0;
  const side =
    prefer && (along > 0.2 || along < -0.2)
      ? along > 0
        ? 1
        : -1
      : lat > 0.05
        ? 1
        : lat < -0.05
          ? -1
          : hash32(b.id, 0x51de) % 2 === 0
            ? 1
            : -1;
  const moving = vehicles.filter((v) => v.paths.length > 0);
  const stopped = vehicles.filter((v) => v.paths.length === 0);
  // First a line that keeps the body's whole margin from every predicted footprint on the way
  // (one that only stays PASSING_M clear can cut in front of a turning car's arc); then, when
  // there is none, any line that stays PASSING_M clear.
  for (const passing of [prof.margin, PASSING_M]) {
    let best: { x: number; z: number; cost: number } | null = null;
    for (const sideSign of [side, -side]) {
      for (const [ang, angCost] of FAN) {
        // Square to the path on this side, turned by ang (+ = back against the travel).
        const px = nx * sideSign;
        const pz = nz * sideSign;
        const c = dcos(ang);
        const sn = dsin(ang);
        const wx = px * c - s.ux * sn;
        const wz = pz * c - s.uz * sn;
        const back = prefer ? -(wx * prefer.x + wz * prefer.z) : 0;
        const base = angCost + (sideSign === side ? 0 : OTHER_SIDE_COST) + (back > 0 ? REVERSE_COST * back : 0);
        if (best && base + MARCH_M >= best.cost) continue;
        for (let len = MARCH_M; len <= prof.maxDive + 1e-9; len += MARCH_M) {
          if (best && base + len >= best.cost) break;
          const x = b.x + wx * len;
          const z = b.z + wz * len;
          if (!lineOpen(g, b, x, z, DIVE_STEP_M) || !clearOfStopped(stopped, x, z, b.r)) break;
          if (!clearOfVehicles(vehicles, x, z, b.r, prof.margin + LANDING_EXTRA_M)) continue;
          // (Across the vehicle's path: with a wider berth, since that line goes in front of it.)
          if (!passesClear(moving, b.x, b.z, wx, wz, len, speed, b.r + (sideSign === side ? 0 : CROSSING_EXTRA_M), passing)) break;
          // Onto another body or landing: allowed, but dearer (a little further on is usually free).
          if (!spotFree(spots, x, z, b.r)) {
            if (!best || base + len + CROWDED_COST < best.cost) best = { x, z, cost: base + len + CROWDED_COST };
            continue;
          }
          if (!best || base + len < best.cost) best = { x, z, cost: base + len };
          break;
        }
      }
    }
    if (best) return { x: best.x, z: best.z };
  }
  // Best effort: the spot on the lines that keeps furthest from the vehicles.
  let far: { x: number; z: number; d: number } | null = null;
  const here = vehicleClearance(vehicles, b.x, b.z);
  for (const sideSign of [side, -side]) {
    for (const [ang] of FAN) {
      const c = dcos(ang);
      const sn = dsin(ang);
      const wx = nx * sideSign * c - s.ux * sn;
      const wz = nz * sideSign * c - s.uz * sn;
      for (let len = MARCH_M; len <= prof.maxDive + 1e-9; len += MARCH_M) {
        const x = b.x + wx * len;
        const z = b.z + wz * len;
        if (!lineOpen(g, b, x, z, DIVE_STEP_M) || !clearOfStopped(stopped, x, z, b.r)) break;
        const d = vehicleClearance(vehicles, x, z);
        if (d > here && (!far || d > far.d)) far = { x, z, d };
      }
    }
  }
  return far ? { x: far.x, z: far.z } : null;
}

/** Can the body get from where it is to (x, z): no building or wall in between, not into a building, no step bigger than `step`? */
function lineOpen(g: Ground, b: Readonly<Body>, x: number, z: number, step: number): boolean {
  const w = g.world;
  if (segmentCrossesWall(w.walls, b.x, b.z, x, z)) return false;
  if (circleBlocked(w, x, z, b.r)) return false;
  if (segmentBlocked(w, b.x, b.z, x, z)) return false;
  const h = g.height(x, z, b.y);
  return (h > b.y ? h - b.y : b.y - h) <= step;
}

/**
 * The override's spot: the nearest point outside every vehicle (each moving one's body plus the
 * body's override clearance, each parked one's body) that the body can leap to: not into a
 * building, never across a wall or a building, no step over OVERRIDE_STEP_M. It may leap over
 * the vehicle. A spot in a moving vehicle's path (its predicted footprint plus the clearance)
 * costs 100 m more, so nobody is put down in front of the car to be leapt again; one on another
 * body costs 0.5 m more. Lines every 15 degrees and along the vehicles' sides, out to
 * CLEAR_NEAR_M every 0.1 m, then CLEAR_FAR_M every 0.5 m; null if there is nowhere at all.
 */
export function overrideSpot(g: Ground, b: Readonly<Body>, vehicles: readonly Vehicle[], spots: readonly Spot[], clearance: number): { x: number; z: number } | null {
  const moving = vehicles.filter((v) => v.paths.length > 0);
  const dirs: Array<[number, number]> = [];
  for (let k = 0; k < 24; k++) {
    const a = (k * Math.PI) / 12;
    dirs.push([dsin(a), -dcos(a)]);
  }
  for (const v of vehicles) {
    dirs.push([-v.fz, v.fx], [v.fz, -v.fx], [v.fx, v.fz], [-v.fx, -v.fz]);
  }
  const outside = (x: number, z: number): boolean => {
    for (const v of vehicles) {
      const need = b.r + (v.speed > PARKED_SPEED ? clearance : 0) + 0.02;
      if (bodyDistance(v, x, z) < need) return false;
    }
    return true;
  };
  for (const [reachM, stepM] of [
    [CLEAR_NEAR_M, 0.1],
    [CLEAR_FAR_M, 0.5],
  ] as const) {
    let best: { x: number; z: number; cost: number } | null = null;
    for (const [wx, wz] of dirs) {
      for (let len = stepM; len <= reachM + 1e-9; len += stepM) {
        if (best && len >= best.cost) break;
        const x = b.x + wx * len;
        const z = b.z + wz * len;
        if (segmentCrossesWall(g.world.walls, b.x, b.z, x, z)) break;
        if (segmentBlocked(g.world, b.x, b.z, x, z)) break;
        const h = g.height(x, z, b.y);
        if ((h > b.y ? h - b.y : b.y - h) > OVERRIDE_STEP_M) break;
        if (circleBlocked(g.world, x, z, b.r)) continue;
        if (!outside(x, z)) continue;
        let cost = len;
        if (!clearOfVehicles(moving, x, z, b.r, clearance, false)) cost += 100;
        if (!spotFree(spots, x, z, b.r)) cost += 0.5;
        if (!best || cost < best.cost) best = { x, z, cost };
        if (cost === len) break;
      }
    }
    if (best) return { x: best.x, z: best.z };
  }
  return null;
}

// ---------------------------------------------------------------- the dive itself

function startDive(prof: DodgeProfile, sx: number, sz: number, tx: number, tz: number, speed = prof.speed): DodgeState {
  const len = Math.sqrt((tx - sx) * (tx - sx) + (tz - sz) * (tz - sz));
  const dur = Math.max(Math.round(prof.minTicks * (prof.speed / speed)), Math.ceil(len / speed / DT - 1e-9));
  return { phase: "dive", sx, sz, tx, tz, t: 0, dur, peak: prof.peak, hop: 0, leap: false };
}

/**
 * A dive under way, turned toward a new landing (tx, tz) from where the body is (px, pz): it
 * keeps the ticks it has been in the air (t) and covers what is left at `speed`, so its progress
 * (t / dur, which the renderer draws the dive by) carries on from about where it was instead of
 * starting over, and the dive still takes at least the profile's shortest dive in all. (sx, sz)
 * is put back along the new line so the body is exactly where it is now.
 */
export function redirectDive(prof: DodgeProfile, d: Readonly<DodgeState>, px: number, pz: number, tx: number, tz: number, speed = prof.speed): DodgeState {
  const len = Math.sqrt((tx - px) * (tx - px) + (tz - pz) * (tz - pz));
  const t = d.t;
  const rest = Math.max(1, Math.ceil(len / speed / DT - 1e-9), Math.round(prof.minTicks * (prof.speed / speed)) - t);
  const dur = t + rest;
  const k = t / rest;
  return { phase: "dive", sx: px + (px - tx) * k, sz: pz + (pz - tz) * k, tx, tz, t, dur, peak: d.peak, hop: d.hop, leap: false };
}

/** One tick of a dodge: the new state (null when over) and where the body is. */
export function advanceDodge(d: Readonly<DodgeState>, prof: Readonly<DodgeProfile>): { dodge: DodgeState | null; x: number; z: number } {
  if (d.phase === "recover") {
    const t = d.t + 1;
    if (t >= d.dur) return { dodge: null, x: d.tx, z: d.tz };
    return { dodge: { ...d, t, hop: 0 }, x: d.tx, z: d.tz };
  }
  const t = d.t + 1;
  if (t >= d.dur) return { dodge: { ...d, phase: "recover", t: 0, dur: prof.recover, hop: 0 }, x: d.tx, z: d.tz };
  const u = t / d.dur;
  const hop = 4 * d.peak * u * (1 - u);
  if (d.leap) return { dodge: { ...d, t, hop }, x: d.tx, z: d.tz };
  return { dodge: { ...d, t, hop }, x: d.sx + (d.tx - d.sx) * u, z: d.sz + (d.tz - d.sz) * u };
}

// ---------------------------------------------------------------- the tick

interface Rec {
  /** A player on foot (id) or an agent (index into the agents list). */
  player: PlayerId | null;
  index: number;
  x: number;
  z: number;
  y: number;
  r: number;
  cls: DodgeClass;
  id: number;
  dodge: DodgeState | null;
  /** Under the override (people, animals, players on foot). */
  guarded: boolean;
  /** May start a dive (a player falling cannot). */
  canDive: boolean;
  /** Vehicles whose predicted footprint reaches it this tick, earliest first. */
  threats: Array<{ v: number; hit: Hit }>;
  changed: boolean;
}

const HASH_M = 16;

/**
 * The dodge for one tick. `before` is the state the tick started from, `after` the state with
 * this tick's players and agents moved (step.ts). Returns `after` with the dodgers moved,
 * leapt and counted (the same object when nothing changed).
 */
export function stepDodge(world: World, before: Readonly<SimState>, after: SimState): SimState {
  const ids = sortedIds(after.players);
  if (ids.length === 0) return after; // no players: the world is frozen
  const agentsExt = after.ext[AGENTS_EXT_KEY] as AgentsExt | undefined;
  const agents = agentsExt ? agentsExt.list : [];

  // Dodgers: players on foot, then agents by id.
  const recs: Rec[] = [];
  for (const id of ids) {
    const p = after.players[id]!;
    if (p.mode !== "foot" || !p.foot) continue;
    const f = p.foot;
    const hop = f.dodge ? f.dodge.hop : 0;
    recs.push({
      player: id,
      index: -1,
      x: f.x,
      z: f.z,
      y: f.y - hop,
      r: FOOT.radius,
      cls: "player",
      id: hash32(...[...id].map((ch) => ch.charCodeAt(0))),
      dodge: f.dodge,
      guarded: true,
      canDive: f.grounded,
      threats: [],
      changed: false,
    });
  }
  agents.forEach((a, index) => {
    const cls = agentDodgeClass(a);
    if (!cls) return;
    const hop = a.dodge ? a.dodge.hop : 0;
    recs.push({
      player: null,
      index,
      x: a.x,
      z: a.z,
      y: a.y - hop,
      r: AGENT_SPEC[a.kind].radius,
      cls,
      id: a.id,
      dodge: a.dodge,
      guarded: DODGE_PROFILE[cls].override !== null,
      canDive: true,
      threats: [],
      changed: false,
    });
  });
  if (recs.length === 0) return after;

  // Where the dodgers are (cells of HASH_M).
  const hash = new Map<number, number[]>();
  recs.forEach((r, i) => {
    const k = cellKey(Math.floor(r.x / HASH_M), Math.floor(r.z / HASH_M));
    let l = hash.get(k);
    if (!l) hash.set(k, (l = []));
    l.push(i);
  });
  const near = (x0: number, z0: number, x1: number, z1: number, out: number[]): void => {
    out.length = 0;
    for (let cx = Math.floor(x0 / HASH_M); cx <= Math.floor(x1 / HASH_M); cx++) {
      for (let cz = Math.floor(z0 / HASH_M); cz <= Math.floor(z1 / HASH_M); cz++) {
        const l = hash.get(cellKey(cx, cz));
        if (l) for (const i of l) out.push(i);
      }
    }
  };
  const scratch: number[] = [];
  const maxReach = 0.5 + DODGE_PROFILE.care.margin;

  // Vehicles: every player's car, every robotaxi. A moving robotaxi predicts its path (a route
  // walk) only when a dodger is near enough to be in it; one that might matter only for where
  // someone lands is predicted when a dive needs it (ensurePaths; the same paths either way).
  const vehicles: Vehicle[] = [];
  for (const id of ids) vehicles.push(vehicleOfCar(id, after.players[id]!.car));
  const prevAgents = new Map<number, AgentState>();
  for (const a of (before.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? []) prevAgents.set(a.id, a);
  const bodies = playerBodies(before);
  /** Vehicle index -> the robotaxi (and its step) whose paths are not predicted yet. */
  const pending = new Map<number, { a: AgentState; dt: number }>();
  for (const a of agents) {
    if (!AGENT_SPEC[a.kind].road) continue;
    const spec = AGENT_SPEC[a.kind];
    let predict = false;
    if (a.speed >= DODGE_MIN_SPEED) {
      const reach = a.speed * horizonS(a.speed) + spec.halfLength + spec.halfWidth + maxReach + 1;
      near(a.x - reach, a.z - reach, a.x + reach, a.z + reach, scratch);
      for (const i of scratch) {
        const r = recs[i]!;
        if ((r.x - a.x) * (r.x - a.x) + (r.z - a.z) * (r.z - a.z) <= reach * reach) {
          predict = true;
          break;
        }
      }
    }
    const close = bodies.some((p) => (p.x - a.x) * (p.x - a.x) + (p.z - a.z) * (p.z - a.z) <= NEAR_RANGE_M * NEAR_RANGE_M);
    const dt = close ? DT : DT * LOD_STRIDE;
    if (!predict && a.speed >= DODGE_MIN_SPEED) pending.set(vehicles.length, { a, dt });
    vehicles.push(vehicleOfAgent(a, prevAgents.get(a.id) ?? null, dt, world, predict));
  }
  /** Predict every pending robotaxi that could reach within `reach` of (x, z). */
  const ensurePaths = (x: number, z: number, reach: number): void => {
    for (const [vi, p] of pending) {
      const a = p.a;
      const spec = AGENT_SPEC[a.kind];
      const lim = reach + a.speed * horizonS(a.speed) + spec.halfLength + spec.halfWidth;
      if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) > lim * lim) continue;
      vehicles[vi] = vehicleOfAgent(a, prevAgents.get(a.id) ?? null, p.dt, world, true);
      pending.delete(vi);
    }
  };

  // Who is in whose predicted footprint.
  vehicles.forEach((v, vi) => {
    if (v.paths.length === 0) return;
    near(v.minX - maxReach, v.minZ - maxReach, v.maxX + maxReach, v.maxZ + maxReach, scratch);
    for (const i of scratch) {
      const r = recs[i]!;
      if (v.player !== null && v.player === r.player) continue; // a player's own car
      const hit = sweepHit(v, r.x, r.z, r.r + DODGE_PROFILE[r.cls].margin);
      if (hit) r.threats.push({ v: vi, hit });
    }
  });

  // Spots taken: every body where it is, every diver's landing (owner: index into recs). Built
  // when the first body needs them (most ticks nobody dives).
  let spots: Array<Spot & { owner: number }> | null = null;
  const takeSpots = (): Array<Spot & { owner: number }> => {
    if (spots) return spots;
    spots = [];
    recs.forEach((r, i) => {
      spots!.push({ x: r.x, z: r.z, r: r.r, owner: i });
      if (r.dodge && r.dodge.phase === "dive") spots!.push({ x: r.dodge.tx, z: r.dodge.tz, r: r.r, owner: i });
    });
    return spots;
  };
  const spotsNear = (self: number, reach: number): Spot[] => {
    const me = recs[self]!;
    const out: Spot[] = [];
    for (const s of takeSpots()) {
      if (s.owner === self) continue;
      if ((s.x - me.x) * (s.x - me.x) + (s.z - me.z) * (s.z - me.z) <= reach * reach) out.push(s);
    }
    return out;
  };

  const ext0 = dodgeExtOf(after);
  let contacts = ext0.contacts;
  let overrides = ext0.overrides;
  let dives = ext0.dives;
  let nearMisses = ext0.nearMisses;
  const credit = new Map<PlayerId, { near: number; bumps: number }>();
  const creditTo = (v: Vehicle, near: number, bumps: number): void => {
    if (v.player === null) return;
    const c = credit.get(v.player) ?? { near: 0, bumps: 0 };
    c.near += near;
    c.bumps += bumps;
    credit.set(v.player, c);
  };

  const heightFor = (r: Rec): Ground => ({
    world,
    height: r.player !== null ? (x, z, feet) => surfaceHeight(world, x, z, feet) : (x, z) => meshGroundHeight(world, x, z),
  });
  const vehiclesNear = (r: Rec, reach: number): Vehicle[] => {
    ensurePaths(r.x, r.z, reach);
    return vehicles.filter((v) => r.x >= v.minX - reach && r.x <= v.maxX + reach && r.z >= v.minZ - reach && r.z <= v.maxZ + reach);
  };

  // 1-2. Watch and dive.
  for (let ri = 0; ri < recs.length; ri++) {
    const r = recs[ri]!;
    const prof = DODGE_PROFILE[r.cls];
    r.threats.sort((a, b) => a.hit.t - b.hit.t || a.v - b.v);
    const threatened = r.threats.length > 0 && r.canDive;
    let d = r.dodge;
    if (threatened) {
      const reach = prof.maxDive + r.r + prof.margin + 1;
      const nearV = vehiclesNear(r, reach).filter((v) => v.player === null || v.player !== r.player);
      const body: Body = { x: r.x, z: r.z, y: r.y, r: r.r, cls: r.cls, id: r.id };
      // Keep a dive whose landing and line stay clear (the line by the body's whole margin);
      // otherwise choose again from here.
      let keep = false;
      if (d && d.phase === "dive" && !d.leap) {
        const len = Math.sqrt((d.tx - r.x) * (d.tx - r.x) + (d.tz - r.z) * (d.tz - r.z));
        const wx = len > 1e-9 ? (d.tx - r.x) / len : 0;
        const wz = len > 1e-9 ? (d.tz - r.z) / len : 0;
        keep =
          clearOfVehicles(nearV, d.tx, d.tz, r.r, prof.margin) &&
          passesClear(nearV.filter((v) => v.paths.length > 0), r.x, r.z, wx, wz, len, prof.speed, r.r, prof.margin) &&
          lineClearOfStopped(nearV.filter((v) => v.paths.length === 0), r.x, r.z, d.tx, d.tz, r.r);
      }
      if (!keep) {
        // A dive under way keeps its direction if it can (no dithering as a car steers about).
        let prefer: { x: number; z: number } | null = null;
        if (d && d.phase === "dive" && !d.leap) {
          const len = Math.sqrt((d.tx - d.sx) * (d.tx - d.sx) + (d.tz - d.sz) * (d.tz - d.sz));
          if (len > 1e-9) prefer = { x: (d.tx - d.sx) / len, z: (d.tz - d.sz) / len };
        }
        // Seen late: scramble.
        const speed = r.threats[0]!.hit.t <= EMERGENCY_S ? prof.speed * EMERGENCY_BOOST : prof.speed;
        const to = chooseDive(heightFor(r), body, r.threats[0]!.hit, nearV, spotsNear(ri, prof.maxDive + 2), prefer, speed);
        if (to) {
          const fresh = !d || d.phase !== "dive" || d.leap;
          d = fresh ? startDive(prof, r.x, r.z, to.x, to.z, speed) : redirectDive(prof, d!, r.x, r.z, to.x, to.z, speed);
          takeSpots().push({ x: to.x, z: to.z, r: r.r, owner: ri });
          if (fresh) {
            dives++;
            nearMisses++;
            creditTo(vehicles[r.threats[0]!.v]!, 1, 0);
          }
        }
      }
    }
    if (d) {
      const n = advanceDodge(d, prof);
      r.x = n.x;
      r.z = n.z;
      r.dodge = n.dodge;
      r.changed = true;
    }
  }

  // 3. The hard guarantee. Candidates: the dodgers near each vehicle's body (with slack for
  // this tick's dives, which move a body under 0.3 m; a leap below is checked where it lands).
  const cand = new Map<number, number[]>();
  vehicles.forEach((v, vi) => {
    const reach = v.hl + v.hw + DODGE_PROFILE.care.override! + 1;
    near(v.x - reach, v.z - reach, v.x + reach, v.z + reach, scratch);
    for (const i of scratch) {
      let l = cand.get(i);
      if (!l) cand.set(i, (l = []));
      l.push(vi);
    }
  });
  for (let ri = 0; ri < recs.length; ri++) {
    const r = recs[ri]!;
    if (!r.guarded) continue;
    const mine = cand.get(ri);
    if (!mine) continue;
    const prof = DODGE_PROFILE[r.cls];
    const clearance = prof.override!;
    let inside = false;
    let worst: Vehicle | null = null;
    let worstD = Infinity;
    for (const vi of mine) {
      const v = vehicles[vi]!;
      if (v.player !== null && v.player === r.player) continue;
      const d = bodyDistance(v, r.x, r.z);
      if (d < r.r) inside = true;
      const need = r.r + (v.speed > PARKED_SPEED ? clearance : 0);
      if (d < need && d - need < worstD) {
        worstD = d - need;
        worst = v;
      }
    }
    if (!worst) continue;
    if (inside) {
      contacts++;
      creditTo(worst, 0, 1);
    }
    const nearV = vehiclesNear(r, CLEAR_FAR_M).filter((v) => v.player === null || v.player !== r.player);
    const body: Body = { x: r.x, z: r.z, y: r.y, r: r.r, cls: r.cls, id: r.id };
    const to = overrideSpot(heightFor(r), body, nearV, spotsNear(ri, CLEAR_NEAR_M + 2), clearance);
    if (!to) continue;
    overrides++;
    nearMisses++;
    creditTo(worst, 1, 0);
    r.dodge = { phase: "dive", sx: r.x, sz: r.z, tx: to.x, tz: to.z, t: 0, dur: LEAP_TICKS, peak: prof.leapPeak, hop: 0, leap: true };
    r.x = to.x;
    r.z = to.z;
    r.changed = true;
    takeSpots().push({ x: to.x, z: to.z, r: r.r, owner: ri });
  }

  // Write back.
  const changed = recs.some((r) => r.changed) || credit.size > 0 || contacts !== ext0.contacts || overrides !== ext0.overrides || dives !== ext0.dives || nearMisses !== ext0.nearMisses;
  if (!changed) return after;
  const players: Record<PlayerId, PlayerState> = { ...after.players };
  for (const r of recs) {
    if (!r.changed || r.player === null) continue;
    const p = players[r.player]!;
    const f = p.foot!;
    const ground = surfaceHeight(world, r.x, r.z, r.y);
    const hop = r.dodge ? r.dodge.hop : 0;
    const foot: FootState = { ...f, x: r.x, y: ground + hop, z: r.z, speed: 0, sprint: false, vy: 0, grounded: true, dodge: r.dodge };
    players[r.player] = { ...p, foot };
  }
  for (const id of sortedIds(players)) {
    const c = credit.get(id);
    if (!c) continue;
    const p = players[id]!;
    players[id] = { ...p, car: { ...p.car, nearMisses: p.car.nearMisses + c.near, personBumps: p.car.personBumps + c.bumps } };
  }
  let ext = after.ext;
  if (agentsExt && recs.some((r) => r.changed && r.player === null)) {
    const list = agents.slice();
    for (const r of recs) {
      if (!r.changed || r.player !== null) continue;
      list[r.index] = placeAgent(world, list[r.index]!, r.x, r.z, r.dodge);
    }
    ext = { ...ext, [AGENTS_EXT_KEY]: { ...agentsExt, list } };
  }
  const counters: DodgeExt = { contacts, overrides, dives, nearMisses };
  ext = { ...ext, [DODGE_EXT_KEY]: counters };
  return { ...after, players, ext };
}

/**
 * An agent at (x, z) in its dodge (or done with it, dodge null): stood on the ground plus its
 * hop, mode "dive" or "recover", not walking. Recovering, it faces the way it will walk on (so
 * it turns that way as it gets up). Done: it walks on from right here (agents.ts rejoinAt: on
 * its path, or along a connector back onto its sidewalk), never jumping back to its line.
 */
function placeAgent(world: World, a: Readonly<AgentState>, x: number, z: number, dodge: DodgeState | null): AgentState {
  const y = meshGroundHeight(world, x, z);
  if (dodge && dodge.phase === "dive") return { ...a, x, y: y + dodge.hop, z, speed: 0, mode: dodge.phase, dodge };
  const at = rejoinAt(world, a, x, z);
  if (dodge) return { ...a, x, y: y + dodge.hop, z, speed: 0, mode: dodge.phase, dodge, heading: at ? at.heading : a.heading };
  return { ...a, ...(at ?? {}), x, y, z, speed: 0, mode: "go", wait: 0, dodge: null };
}
