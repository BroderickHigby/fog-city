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
//     using a mobility aid; for a robotaxi, which keeps to its route and holds still while
//     anyone is within its berth, the berth: 0.5 m, a child's 0.9 m) dives.
//  2. Dive, Crazy Taxi style. The landing spot is the cheapest clear spot on a fan of lines:
//     square to the vehicle's path on the side the body is on, then angled, then the other side.
//     A line is walked the way the body would go (Ground): it ends at a building (height-aware
//     for a player, who may stand on a roof and dive along it or off its edge), a wall (the
//     world's edge, the shore, a kerb rail over water) or a step of more than 1.5 m; a spot must
//     be clear of every predicted footprint (with the margin), of stopped vehicles, and of other
//     bodies and other divers' landing spots ("never into another path"; a player on foot's spot
//     or landing is never landed on at all, since a walker is pushed by a body overlapping it), and
//     the line to it must stay clear of the vehicle on the way (a space-time check) and of every
//     stopped vehicle, a player's own parked car included (never a threat to them, but solid). The
//     body leaps at its dive speed (7-9 m/s; pigeons flutter up, the dog bounds, robots skid and
//     hop) with a hop, lands and recovers (about a second: gets up, brushes off); an agent then
//     carries on along its path from where it landed. A dive under way is checked again every
//     tick (its landing, and its line against the moving vehicles' footprints and the stopped
//     ones' bodies) and re-aimed or cut short when it no longer holds; threatened again while
//     diving or recovering, the body dives again from where it is.
//  3. The reach of a vehicle: where its body can be by the end of its next step. A player's car:
//     its body at the middle of that step grown by half its travel (every point it can slide
//     to, along a wall or off another car, lies in the disc whose diameter is its velocity's
//     step), its speed change and its turn, any overlap that can shove it (another car, a
//     building it was placed in), and, when it can touch something on that step, the turn its
//     nose makes toward its slide as it scrapes (carVehicle, vehicleOfCar). A robotaxi (worked
//     out once someone is near it): its exact poses along its route over the step (routeReach; a
//     connector's vertices turn it at once). (Vehicle.mx..zone, zoneDistance.) A body's own dive step never ends
//     deeper in a vehicle's reach than its clearance (it stops short and is re-aimed next tick),
//     so a dive never carries anyone into a vehicle.
//  4. The hard guarantee, which no tuning removes: then any person, animal or player on foot
//     within its override clearance (0.3 m; 0.6 m for the vulnerable) of a moving vehicle's reach
//     (STOPPED_CLEAR_M of a stopped one's), or inside any vehicle's body, is put at the nearest
//     free spot outside every vehicle's reach (a superhuman leap, drawn as a big hop, or as a
//     stumble when it is a short one). Since every vehicle stays within its reach over its next
//     step, nobody can then be inside one after it: the contact count stays 0. The spot is found
//     on lines walked as a dive's are, then with any drop, then over buildings, and as a last
//     resort anywhere outside the vehicles (counted in `failures`, which must stay 0): there is
//     always a spot. The leap stands the body on the surface its line reached (a step it climbed, a
//     street it dropped to). Cars never collide with people at all (step.ts gives them no person or
//     animal obstacles): a car is never stopped, slowed or deflected by one, and its personBumps
//     stays 0.
//  5. Heights. A vehicle is not in the way of someone who cannot be at its height: a player on a
//     roof over the street, a person under a deck a car drives across. The threat is skipped at a
//     predicted pose the vehicle cannot be at their height at (sweepHitBand: it follows the drawn
//     ground there, climbs one deck, falls from a deck or a jump), and the override and the contact
//     count at a vehicle whose band over its next step cannot meet theirs (bandMeetsNext,
//     vehicleBandNext: the ground under its reach bounds it); a contact needs the bands to overlap.
//
// Everything that puts a body somewhere keeps it out of the vehicles too (step.ts, foot.ts,
// agents.ts): getting out of a car (never into a vehicle's body or reach, nor in front of a moving
// one: the player waits in the car until it has gone), a player's walker (vehicle bodies are hard
// limits: no shove takes it into one), a player joining (the car is placed clear of everyone on
// foot), the population refill (never within SPAWN_VEHICLE_CLEAR_M of a vehicle's body).
//
// Robots dodge by the same rules but are not under the override: they stay solid to cars (a car
// that reaches one stops against it), and water is the only way to beat one.
//
// Robotaxis are measured by their drawn body (ROBOTAXI_BODY, a box), player cars by their body box.
// Robotaxis keep a berth from people (agents.ts berthLimit) that makes both the dive and the
// override unneeded in normal traffic.
//
// Cost: a vehicle is built (its prediction, its reach) only when a dodger is near it; a robotaxi
// is predicted only when someone is near the stretch of route it can cover before braking stops
// it; one route walk per robotaxi a tick serves its prediction and its reach.
//
// Counters (ext.dodge, DodgeExt): contacts (a protected body found inside a vehicle's body
// before the override moved it: must stay 0; a player's car counts its own in personBumps),
// overrides, dives, near misses (also on the player's car, CarState.nearMisses, for scoring and
// barks) and failures. Order: players in sortedIds order, then agents by ascending id; each
// body's decision sees the spots the bodies before it chose.

import { DT, sortedIds, type CarState, type DodgeState, type FootState, type PlayerId, type PlayerState, type SimState } from "./contract.ts";
import { clamp, dcos, dsin, wrapAngle } from "./dmath.ts";
import { hash32 } from "./rng.ts";
import { CAR, carCircles } from "./car.ts";
import { boxBlocked, type Circle } from "./collide.ts";
import { FOOT } from "./foot.ts";
import {
  AGENTS_EXT_KEY,
  AGENT_SPEC,
  LOD_STRIDE,
  NEAR_RANGE_M,
  ROBOTAXI_BODY,
  ROBOTAXI_SLOW_BERTH_CHILD_M,
  ROBOTAXI_SLOW_BERTH_M,
  agentCircles,
  agentRouteAt,
  agentRouteSegs,
  personIsChild,
  playerBodies,
  rejoinAt,
  type AgentKind,
  type AgentState,
  type AgentsExt,
  type Route,
} from "./agents.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { ROOF_STEP_M, cellKey, circleBlocked, circleBlockedBand, meshGroundHeight, meshGroundRange, surfaceHeight, type World } from "./world.ts";

// ---------------------------------------------------------------- tuning (the guarantee is not tunable)

/** Vehicles slower than this threaten nobody (the override still keeps bodies out of their reach). */
export const DODGE_MIN_SPEED = 1;
/**
 * A vehicle no point of whose body moves faster than this (by its velocity and yaw rate, or as
 * it moved over its last step) is stopped for the override: only its reach and STOPPED_CLEAR_M count.
 */
export const PARKED_SPEED = 0.3;
/** The override keeps a body at least this far from a stopped vehicle's reach, metres. */
export const STOPPED_CLEAR_M = 0.02;
/** Robots (not under the override) never dive closer than this to a vehicle's reach, metres. */
export const ROBOT_GAP_M = 0.05;
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
/** The override's longest leap lasts this long, ticks (a short one is quicker: leapShape). */
export const LEAP_TICKS = 24;
/** Bodies keep at least this much room between each other when they land, metres. */
export const LANDING_GAP_M = 0.1;
/** A dive's line keeps at least this much more than its clearance from a stopped vehicle, metres. */
export const STOPPED_GAP_M = 0.05;
/**
 * The line to a landing spot keeps at least this clear of the vehicle on the way, metres, and
 * never less than the body's clearance from it plus 0.05 m (a line keeping the body's whole
 * margin is taken first when there is one).
 */
export const PASSING_M = 0.2;
/**
 * A body the vehicle reaches within this many seconds (it saw it late: a car that swerved, or
 * was flung off a wall) scrambles: it dives EMERGENCY_BOOST times as fast.
 */
export const EMERGENCY_S = 0.45;
export const EMERGENCY_BOOST = 1.5;
/** The most a dive climbs or drops, metres; the override's leap, OVERRIDE_STEP_M (then any drop). */
export const DIVE_STEP_M = 1.5;
export const OVERRIDE_STEP_M = 3;
/** The override looks this far for a free spot every 0.1 m, then to CLEAR_NEAR_M every 0.25 m, then to CLEAR_FAR_M every 0.5 m, metres. */
export const CLEAR_FINE_M = 3;
export const CLEAR_NEAR_M = 12;
export const CLEAR_FAR_M = 30;
/** The override's last resort looks this far, metres. */
export const CLEAR_LAST_M = 60;

/** A vehicle whose velocity is more than this off its nose is sliding (cos 0.15 rad): it may straighten out along its nose. */
export const SLIP_RAD = 0.15;
const SLIP_COS = dcos(SLIP_RAD);

/**
 * The most a player's car's velocity changes over a tick in any direction, m/s: the engine, full
 * tyre grip sideways and gravity on the steepest street (its reach allows for it).
 */
export const CAR_DV = (CAR.accel + CAR.gripAccel * 1.5 + CAR.gravity) * DT;
/** A dive step is checked against the vehicles' reach every this many metres. */
const STEP_CHECK_M = 0.04;

/** Seconds of a vehicle's path that are predicted at `speed` m/s: 0.6 s, plus 0.025 s per m/s, at most 1.5 s. */
export function horizonS(speed: number): number {
  return clamp(0.6 + 0.025 * speed, 0.6, 1.5);
}

/** Who dodges how. */
export type DodgeClass = "person" | "care" | "player" | "errandRobot" | "sidewalkBot";

export interface DodgeProfile {
  /** Dives when within this of a vehicle's predicted footprint, metres. */
  margin: number;
  /** The override: placed outside a moving vehicle's reach closer than this, metres; null: not under it (robots). */
  override: number | null;
  /** Dive speed, m/s; the longest dive, metres; the shortest, ticks. */
  speed: number;
  maxDive: number;
  minTicks: number;
  /** Peak hop of a dive, and of the override's longest leap, metres. */
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

/** The berth a robotaxi keeps from a body of this class (agents.ts): a child's is wider. */
export function robotaxiBerth(cls: DodgeClass): number {
  return cls === "care" ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M;
}

/** The dodge class of an ambient agent, or null for vehicles (robotaxis). */
export function agentDodgeClass(a: Readonly<Pick<AgentState, "id" | "kind" | "runtimeId" | "flying" | "protected" | "child" | "mobilityAid" | "posture">>): DodgeClass | null {
  if (a.flying) return null;
  const kind: AgentKind = a.kind;
  if (kind === "robotaxi") return null;
  if (kind === "person") return (a.runtimeId !== undefined ? a.protected || a.child || a.mobilityAid || a.posture === "seated" || a.posture === "lying" : personIsChild(a.id)) ? "care" : "person";
  return kind;
}

/** state.ext.dodge */
export interface DodgeExt {
  /** Protected bodies found inside a vehicle's body before the override moved them: must stay 0. */
  contacts: number;
  /** Times the override put someone outside a vehicle's reach (the dive had not cleared them). */
  overrides: number;
  /** Dives started. */
  dives: number;
  /** Dives and leaps caused by a vehicle (any vehicle; a player's own also on CarState.nearMisses). */
  nearMisses: number;
  /**
   * Times the override found no spot it could reach along a line (walls, buildings and steps
   * all in the way) and put the body over a building or anywhere outside the vehicles: must stay 0.
   */
  failures: number;
}

export const DODGE_EXT_KEY = "dodge";

export function dodgeExtOf(state: Readonly<SimState>): DodgeExt {
  const e = state.ext[DODGE_EXT_KEY] as Partial<DodgeExt> | undefined;
  return { contacts: e?.contacts ?? 0, overrides: e?.overrides ?? 0, dives: e?.dives ?? 0, nearMisses: e?.nearMisses ?? 0, failures: e?.failures ?? 0 };
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
  /** Body forward (unit) and half extents (a robotaxi: ROBOTAXI_BODY, its drawn size). */
  fx: number;
  fz: number;
  hl: number;
  hw: number;
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
  /** A point of its body moves faster than PARKED_SPEED (by its velocity and yaw rate, or as it moved over its last step). */
  moving: boolean;
  /**
   * Its reach over its next step (zoneDistance): its body at the middle of that step (centre mx,
   * mz, forward mfx, mfz) grown by `inflate` (half its travel, its speed change, its turn, a
   * shove out of whatever overlaps it, and its nose turning as it scrapes along something).
   */
  mx: number;
  mz: number;
  mfx: number;
  mfz: number;
  inflate: number;
  /**
   * A robotaxi near anyone: its reach as its exact poses along its route over the next step
   * (routeReach), each grown by `inflate`; null: the middle pose above. `span` is how far any of
   * them is from (mx, mz).
   */
  zone: Array<{ x: number; z: number; fx: number; fz: number }> | null;
  span: number;
  /**
   * Height: its wheels (y), its body's height above them (top), its vertical speed (vy), and how
   * far its wheels are above the drawn ground under it now (elev: on a deck, or in the air).
   * A body above or below its band (on a roof over the street, under a deck it drives on) is
   * not in its way (bandMeetsNext, sweepHitBand).
   */
  y: number;
  top: number;
  vy: number;
  elev: number;
  /** Its band over its next step (vehicleBandNext), once worked out. */
  band: { bottom: number; top: number } | null;
}

/** Rotate a compass-frame direction (x east, z south) clockwise by the angle whose cos and sin are (c, s). */
function rot(x: number, z: number, c: number, s: number): [number, number] {
  return [x * c - z * s, z * c + x * s];
}

/** What else a vehicle may have (Vehicle's fields of the same names); predict false: no paths (nobody is near enough to need them). */
export interface VehicleOptions {
  spread?: number;
  react?: number;
  route?: RoutePoint[] | null;
  predict?: boolean;
  /** Its next step, seconds (DT; a far robotaxi steps LOD_STRIDE ticks at once). */
  dt?: number;
  /** The most its velocity can change over its next step, m/s, in any direction. */
  dv?: number;
  /** How fast the fastest point of its body moved over its last step, m/s. */
  observed?: number;
  /** Vehicle.y, top, vy and elev (default: on flat ground, a car's body height). */
  y?: number;
  top?: number;
  vy?: number;
  elev?: number;
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
  const spread = opts.spread ?? 0;
  const react = opts.react ?? 0;
  const route = opts.route ?? null;
  const dt = opts.dt ?? DT;
  const speed = Math.sqrt(vx * vx + vz * vz);
  const fx = dsin(heading);
  const fz = -dcos(heading);
  const yawAbs = yawRate < 0 ? -yawRate : yawRate;
  const halfDiag = Math.sqrt(hl * hl + hw * hw);
  // The middle of its next step: half the travel along its velocity, half the turn.
  const half = (yawRate * dt) / 2;
  const [mfx, mfz] = rot(fx, fz, dcos(half), dsin(half));
  const v: Vehicle = {
    key,
    player,
    x,
    z,
    fx,
    fz,
    hl,
    hw,
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
    moving: Math.max(speed + yawAbs * halfDiag, opts.observed ?? 0) > PARKED_SPEED,
    mx: x + (vx * dt) / 2,
    mz: z + (vz * dt) / 2,
    mfx,
    mfz,
    inflate: (speed * dt) / 2 + (opts.dv ?? 0) * dt + (yawAbs * dt * halfDiag) / 2,
    zone: null,
    span: 0,
    y: opts.y ?? 0,
    top: opts.top ?? CAR.bodyHeight,
    vy: opts.vy ?? 0,
    elev: opts.elev ?? 0,
    band: null,
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

/**
 * A player's car as a vehicle: velocity from speed and slide, yaw rate from the car, its
 * footprint widening PLAYER_SPREAD_MPS. `prev` is the car a tick before (how fast it moved).
 *
 * Given the world and the circles it collides with (other players' cars, robots, robotaxis, as
 * step.ts hands them to car.ts), its reach also holds what a collision can do to it over its
 * next step: overlapping a building it is eased out by up to CAR.maxPush (a car placed in one),
 * overlapping a body it is shoved out by the overlap (at most CAR.maxPush), and able to touch
 * any of them (a building, a wall, a body within its step) while it can be moving faster than
 * 1 m/s, it turns its nose toward its slide by up to CAR.wallAlign * DT beyond its yaw rate.
 */
export function vehicleOfCar(
  id: PlayerId,
  c: Readonly<CarState>,
  prev: Readonly<CarState> | null = null,
  world: World | null = null,
  circles: readonly Circle[] = [],
): Vehicle {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const halfDiag = Math.sqrt(CAR.halfLength * CAR.halfLength + CAR.halfWidth * CAR.halfWidth);
  let observed = 0;
  if (prev && prev !== c) {
    const turn = wrapAngle(c.heading - prev.heading);
    observed = (Math.sqrt((c.x - prev.x) * (c.x - prev.x) + (c.z - prev.z) * (c.z - prev.z)) + (turn < 0 ? -turn : turn) * halfDiag) / DT;
  }
  // Right of forward is (-fz, fx).
  const v = makeVehicle(`p:${id}`, id, c.x, c.z, c.heading, CAR.halfLength, CAR.halfWidth, c.speed * fx - c.lateral * fz, c.speed * fz + c.lateral * fx, c.yawRate, 0, {
    spread: PLAYER_SPREAD_MPS,
    dv: CAR_DV,
    observed,
    y: c.y,
    top: CAR.bodyHeight,
    vy: c.vy,
    elev: world ? Math.max(0, c.y - meshGroundHeight(world, c.x, c.z)) : 0,
  });
  if (!world) return v;
  const box = { x: c.x, z: c.z, heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth };
  // Its collision band (car.ts): from its wheels plus the step it climbs to the top of its body.
  const y = c.y + ROOF_STEP_M;
  const top = c.y + CAR.bodyHeight;
  let shove = boxBlocked(world, box, y, [], top) ? CAR.maxPush : 0;
  // The furthest its body can get over the step (twice the reach's growth about its middle pose).
  const e = 2 * v.inflate + 0.05;
  let touch = shove > 0;
  for (const k of circles) {
    const d = boxDistance(k.x, k.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth);
    if (k.r - d > shove) shove = k.r - d;
    if (d < k.r + e) touch = true;
  }
  if (!touch) touch = boxBlocked(world, { ...box, hl: box.hl + e, hw: box.hw + e }, y, [], top);
  v.inflate += Math.min(CAR.maxPush, shove);
  if (touch && v.speed + CAR_DV > 1) v.inflate += CAR.wallAlign * DT * halfDiag;
  return v;
}

/**
 * A player's car as the dodge sees it at the end of a tick (`after`, stepped from `before`):
 * vehicleOfCar with what it collides with on its next step (step.ts obstaclesOf: the other
 * players' cars, and robots and robotaxis by their circles; people never).
 */
export function carVehicle(world: World, before: Readonly<SimState>, after: Readonly<SimState>, id: PlayerId): Vehicle {
  const c = after.players[id]!.car;
  const lim = CAR.halfLength + CAR.halfWidth + 6;
  const circles: Circle[] = [];
  const add = (k: { x: number; z: number; r: number }): void => {
    if ((k.x - c.x) * (k.x - c.x) + (k.z - c.z) * (k.z - c.z) <= lim * lim) circles.push({ x: k.x, z: k.z, r: k.r, person: false });
  };
  for (const other of sortedIds(after.players)) if (other !== id) for (const k of carCircles(after.players[other]!.car)) add(k);
  // (An agent's circles lie within its half length of it.)
  const lim2 = lim + AGENT_SPEC.robotaxi.halfLength;
  for (const a of (after.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? []) {
    // Flying bodies do not shorten a ground vehicle's predicted reach.
    if (a.flying) continue;
    if ((a.x - c.x) * (a.x - c.x) + (a.z - c.z) * (a.z - c.z) > lim2 * lim2) continue;
    const cls = agentDodgeClass(a);
    if (cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot") continue;
    for (const k of agentCircles(a)) add(k);
  }
  return vehicleOfCar(id, c, before.players[id]?.car ?? null, world, circles);
}

/**
 * A robotaxi as a vehicle: along its route (agentRoute, when the world has roads), braking for
 * whoever is in its path (at least ROBOTAXI_BRAKE_MPS2, more when it is already braking harder,
 * after ROBOTAXI_REACT_S), its body ROBOTAXI_BODY (its drawn size). Its yaw rate and braking come
 * from its previous pose (`prev`, stepped `dt` seconds ago); its next step is `dt` too.
 */
export function vehicleOfAgent(a: Readonly<AgentState>, prev: Readonly<AgentState> | null, dt: number, world: World | null = null, predict = true, segs: Route | null = null): Vehicle {
  const spec = AGENT_SPEC[a.kind];
  const hl = a.halfLength ?? (spec.road ? ROBOTAXI_BODY.halfLength : spec.halfLength);
  const hw = a.halfWidth ?? (spec.road ? ROBOTAXI_BODY.halfWidth : spec.halfWidth);
  let yaw = 0;
  let decel = ROBOTAXI_BRAKE_MPS2;
  let observed = 0;
  if (prev && prev !== a && dt > 0) {
    const turn = wrapAngle(a.heading - prev.heading);
    yaw = clamp(turn / dt, -2, 2);
    decel = clamp((prev.speed - a.speed) / dt, ROBOTAXI_BRAKE_MPS2, 9);
    // (Over its own step: a far robotaxi moves LOD_STRIDE ticks' worth at once.)
    observed = (Math.sqrt((a.x - prev.x) * (a.x - prev.x) + (a.z - prev.z) * (a.z - prev.z)) + (turn < 0 ? -turn : turn) * Math.sqrt(hl * hl + hw * hw)) / dt;
  }
  const fx = dsin(a.heading);
  const fz = -dcos(a.heading);
  // Its route: its exact pose at each predicted sample's distance (as stepAgent will put it).
  let route: RoutePoint[] | null = null;
  if (predict && world && a.runtimeId === undefined && a.speed >= DODGE_MIN_SPEED) {
    const ds = [0];
    const n = Math.ceil(horizonS(a.speed) / SAMPLE_S - 1e-9);
    let dist = 0;
    for (let k = 1; k <= n; k++) {
      const st = stepDistance({ speed: a.speed, decel, react: ROBOTAXI_REACT_S }, k);
      dist += st.d;
      ds.push(dist);
      if (st.stopped) break;
    }
    route = agentRouteAt(world, a, ds, segs);
  }
  // Over its next step it speeds up by at most its acceleration (braking only shortens its
  // step, inside its reach), and its velocity turns with its path (at up to 1 rad/s more than
  // it turns now: a connector starting).
  const yawAbs = yaw < 0 ? -yaw : yaw;
  const dv = (spec.accel + a.speed * (yawAbs + 1)) * dt;
  return makeVehicle(`a:${a.id}`, null, a.x, a.z, a.heading, hl, hw, a.speed * fx, a.speed * fz, yaw, decel, {
    react: ROBOTAXI_REACT_S,
    route: route && route.length >= 2 ? route : null,
    predict,
    dt,
    dv,
    observed,
    y: a.y,
    top: a.height ?? (spec.road ? ROBOTAXI_BODY.height : CAR.bodyHeight),
  });
}

/** Whether a robotaxi needs its footprint predicted is looked at along its route this often, metres. */
const CORRIDOR_STEP_M = 2;

/** A robotaxi's reach (routeReach) is sampled this often along its route, metres. */
const ZONE_STEP_M = 0.04;

/**
 * A robotaxi's reach over its next step from its route (it follows its lane and connectors
 * exactly, and on a connector's polyline its heading turns at each vertex at once, which no yaw
 * rate foresees): its body at its exact poses along the route from where it is to where its next
 * step can take it (at most its speed plus its acceleration over the step), every ZONE_STEP_M,
 * each grown by half that spacing (between two poses it only slides, or turns at a vertex into
 * the later pose's heading). Leaves the vehicle as it is where the route is unknown.
 */
export function routeReach(v: Vehicle, a: Readonly<AgentState>, dt: number, world: World, segs: Route | null = null): void {
  if (a.runtimeId !== undefined) return;
  const spec = AGENT_SPEC[a.kind];
  const travel = (a.speed + spec.accel * dt) * dt;
  const n = Math.max(1, Math.ceil(travel / ZONE_STEP_M - 1e-9));
  const ds: number[] = [];
  for (let k = 1; k <= n; k++) ds.push((travel * k) / n);
  const pts = agentRouteAt(world, a, ds, segs);
  if (pts.length < n) return;
  const zone: Array<{ x: number; z: number; fx: number; fz: number }> = [{ x: v.x, z: v.z, fx: v.fx, fz: v.fz }];
  for (const q of pts) {
    const l = Math.sqrt(q.tx * q.tx + q.tz * q.tz);
    if (l <= 1e-9) return;
    zone.push({ x: q.x, z: q.z, fx: q.tx / l, fz: q.tz / l });
  }
  const mid = zone[Math.floor(zone.length / 2)]!;
  let span = 0;
  for (const p of zone) span = Math.max(span, Math.sqrt((p.x - mid.x) * (p.x - mid.x) + (p.z - mid.z) * (p.z - mid.z)));
  v.mx = mid.x;
  v.mz = mid.z;
  v.mfx = mid.fx;
  v.mfz = mid.fz;
  v.zone = zone;
  v.span = span;
  v.inflate = travel / n / 2 + 0.005;
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

/**
 * How far a robotaxi's predicted footprint reaches at `speed` m/s: at that speed for
 * ROBOTAXI_REACT_S, then braking at ROBOTAXI_BRAKE_MPS2 (it brakes at least that hard, the dodge
 * counts on no less), over horizonS(speed), plus a sample's rounding.
 */
export function brakingReach(speed: number): number {
  const T = Math.ceil(horizonS(speed) / SAMPLE_S - 1e-9) * SAMPLE_S;
  const t = Math.max(0, T - ROBOTAXI_REACT_S);
  const stop = speed / ROBOTAXI_BRAKE_MPS2;
  const brake = t >= stop ? (speed * speed) / (2 * ROBOTAXI_BRAKE_MPS2) : speed * t - 0.5 * ROBOTAXI_BRAKE_MPS2 * t * t;
  return speed * Math.min(T, ROBOTAXI_REACT_S) + brake + 0.01;
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

/** Signed distance from (px, pz) to a vehicle's body as it is now. */
export function bodyDistance(v: Readonly<Vehicle>, px: number, pz: number): number {
  return boxDistance(px, pz, v.x, v.z, v.fx, v.fz, v.hl, v.hw);
}

/**
 * Signed distance from (px, pz) to a vehicle's reach over its next step: every place its body
 * can be until then (its body now included). A body this far away cannot be touched by it
 * before the next tick's dodge.
 */
export function zoneDistance(v: Readonly<Vehicle>, px: number, pz: number): number {
  if (v.zone) {
    let best = Infinity;
    for (const p of v.zone) {
      const d = boxDistance(px, pz, p.x, p.z, p.fx, p.fz, v.hl, v.hw);
      if (d < best) best = d;
    }
    return best - v.inflate;
  }
  return boxDistance(px, pz, v.mx, v.mz, v.mfx, v.mfz, v.hl, v.hw) - v.inflate;
}

// ---------------------------------------------------------------- heights

/** How tall a body is above its feet, for the height bands (a grown person's). */
export const BODY_HEIGHT_M = FOOT.height;
/** Gravity, m/s^2 (a vehicle in the air, a body walking off an edge). */
const G = 9.81;

/**
 * The band a vehicle's body can be in by the end of its next step: from its wheels' lowest to its
 * roof's highest. A robotaxi stands on the drawn ground at its pose, which meshGroundRange bounds
 * over its reach. A player's car (car.ts) ends on the surface under its wheels (the drawn ground
 * under its reach, or a roof within ROOF_STEP_M of them), or in the air where its vertical speed
 * and gravity take it; it follows the surface down by no more than its travel and push (at its
 * steepest grade) before it is in the air. Worked out once per vehicle.
 */
export function vehicleBandNext(world: World, v: Vehicle): { bottom: number; top: number } {
  if (v.band) return v.band;
  let minX: number;
  let maxX: number;
  let minZ: number;
  let maxZ: number;
  const e = v.hl + v.hw + v.inflate;
  if (v.zone) {
    minX = Infinity;
    maxX = -Infinity;
    minZ = Infinity;
    maxZ = -Infinity;
    for (const p of v.zone) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  } else {
    minX = maxX = v.mx;
    minZ = maxZ = v.mz;
  }
  const g = meshGroundRange(world, minX - e, minZ - e, maxX + e, maxZ + e);
  let up: number;
  let down: number;
  if (v.player === null) {
    up = g.max;
    down = g.min;
  } else {
    up = Math.max(g.max, v.y + ROOF_STEP_M, v.y + (v.vy > 0 ? v.vy * DT : 0));
    const air = v.y + ((v.vy < 0 ? v.vy : 0) - G * DT) * DT;
    const follow = v.y - ((v.speed + CAR_DV) * DT + CAR.maxPush) * CAR.maxClimbGrade;
    down = Math.min(air, follow);
  }
  v.band = { bottom: down - 0.05, top: up + v.top + 0.05 };
  return v.band;
}

/**
 * Can the vehicle's body meet a body with its feet at `feet` (falling at `vy` when below 0) by the
 * end of their next steps? The body may step onto a deck (ROOF_STEP_M up) and drop as far as a
 * dive steps down (DIVE_STEP_M) or as it falls. Bodies at about the vehicle's height always can
 * (no ground lookup).
 */
export function bandMeetsNext(world: World, v: Vehicle, feet: number, vy = 0): boolean {
  const lo = v.y - 1.2;
  if (feet > lo && feet < v.y + v.top + 0.5) return true;
  const b = vehicleBandNext(world, v);
  const fall = (vy < 0 ? -vy : 0) * DT + G * DT * DT;
  const bodyBottom = feet - Math.max(DIVE_STEP_M, fall) - 0.1;
  const bodyTop = feet + BODY_HEIGHT_M + ROOF_STEP_M;
  return bodyBottom < b.top && b.bottom < bodyTop;
}

/** Is a body with its feet at `feet` inside the vehicle's height band as it is now? (A contact needs this as well as the overlap on the ground.) */
export function bandOverlapsNow(v: Readonly<Vehicle>, feet: number): boolean {
  return feet < v.y + v.top && v.y < feet + BODY_HEIGHT_M;
}

/**
 * Could the vehicle be at the height of a body with its feet at `feet` when it reaches predicted
 * pose s? On the ground now, it follows the drawn ground there (up or down a hill), and may climb
 * one ROOF_STEP_M onto a deck. On a deck or in the air now (more than 0.3 m above the drawn
 * ground): still over a surface near its height there (its deck goes on), on it; otherwise
 * falling from where it is (its vertical speed and gravity), never below the ground.
 */
function bandAtSample(world: World, v: Readonly<Vehicle>, s: Readonly<Sample>, feet: number): boolean {
  const gm = meshGroundHeight(world, s.x, s.z);
  const gs = surfaceHeight(world, s.x, s.z, v.y);
  const climb = v.y + (v.vy > 0 ? v.vy * s.t : 0);
  const top = Math.max(gs, climb) + ROOF_STEP_M + v.top + 0.25;
  let bottom: number;
  if (v.elev <= 0.3) bottom = gm;
  else if (gs > gm + 0.3) bottom = gs;
  else bottom = Math.max(gm, v.y + (v.vy < 0 ? v.vy : 0) * s.t - 0.5 * G * s.t * s.t);
  return feet < top && bottom - 0.3 < feet + BODY_HEIGHT_M;
}

/**
 * sweepHit for a body whose feet are at `feet`, well above or below the vehicle (a player on a
 * roof over the street, or under a deck a car drives on): poses at which the vehicle cannot be
 * at their height (bandAtSample) do not count. At about the vehicle's height: sweepHit.
 */
export function sweepHitBand(world: World, v: Readonly<Vehicle>, px: number, pz: number, reach: number, feet: number): Hit | null {
  if (feet > v.y - 1.2 && feet < v.y + v.top + 0.5) return sweepHit(v, px, pz, reach);
  if (px < v.minX - reach || px > v.maxX + reach || pz < v.minZ - reach || pz > v.maxZ + reach) return null;
  let best: Hit | null = null;
  for (const path of v.paths) {
    for (const s of path) {
      if (best && s.t >= best.t) break;
      if (boxDistance(px, pz, s.x, s.z, s.fx, s.fz, v.hl, v.hw) < reach + v.spread * s.t && bandAtSample(world, v, s, feet)) {
        best = { t: s.t, sample: s };
        break;
      }
    }
  }
  return best;
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
 * moment unless `spread` is false (its reach when it has none).
 */
export function sweepClearance(v: Readonly<Vehicle>, px: number, pz: number, spread = true): number {
  if (v.paths.length === 0) return zoneDistance(v, px, pz);
  const k = spread ? v.spread : 0;
  const half = Math.sqrt(v.hl * v.hl + v.hw * v.hw);
  let best = Infinity;
  for (const path of v.paths) {
    for (const s of path) {
      // (No closer than its centre's distance less its half-diagonal: skip a pose that cannot beat the best.)
      const lo = best + half + k * s.t;
      const dx = px - s.x;
      const dz = pz - s.z;
      if (lo >= 0 && dx * dx + dz * dz >= lo * lo) continue;
      const d = boxDistance(px, pz, s.x, s.z, s.fx, s.fz, v.hl, v.hw) - k * s.t;
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the ground a body moves over

/** A body that may dodge. */
export interface Body {
  x: number;
  z: number;
  /** Height of its feet (no hop). */
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
  /**
   * A player on foot (or their landing): nobody lands on it, ever (a walker is pushed by a body
   * overlapping it, so one landing on them would shove them about). Others' spots only cost more.
   */
  walker?: boolean;
}

/** The static world a dive and a leap walk over. */
export interface Ground {
  world: World;
  /** The surface a body with its feet at `feet` stands on at (x, z). */
  height(x: number, z: number, feet: number): number;
  /**
   * Is a body of radius r standing at (x, z) with its feet at `feet` in a building? Absent: any
   * building footprint blocks it (circleBlocked), for bodies that are always on the ground.
   */
  blocked?(x: number, z: number, r: number, feet: number): boolean;
}

/**
 * The ground for a body: a player on foot stands on roofs within ROOF_STEP_M of their feet and is
 * blocked by a building only between their feet plus that step and the top of their head (as
 * stepFoot moves them), so on a roof they dive along it and off its edge; an agent walks the
 * drawn ground and every footprint blocks it.
 */
export function groundFor(world: World, onRoofs: boolean): Ground {
  if (!onRoofs) return { world, height: (x, z) => meshGroundHeight(world, x, z), blocked: (x, z, r) => circleBlocked(world, x, z, r) };
  return {
    world,
    height: (x, z, feet) => surfaceHeight(world, x, z, feet),
    blocked: (x, z, r, feet) => circleBlockedBand(world, x, z, r, feet + ROOF_STEP_M, feet + FOOT.height),
  };
}

function blockedAt(g: Ground, x: number, z: number, r: number, feet: number): boolean {
  return g.blocked ? g.blocked(x, z, r, feet) : circleBlocked(g.world, x, z, r);
}

/** A line being walked out from a body: where it has got to, and its feet there. */
interface Walk {
  x: number;
  z: number;
  feet: number;
}

/**
 * Walk a line on to (x, z) (the next point, at most a body's diameter on): false, and the line
 * ends, at a wall crossed, a building the body would be in (at the surface there), or a surface
 * more than `step` above or below the body's own feet `y0`.
 */
function walkTo(g: Ground, w: Walk, x: number, z: number, r: number, y0: number, step: number): boolean {
  if (segmentCrossesWall(g.world.walls, w.x, w.z, x, z)) return false;
  const h = g.height(x, z, w.feet);
  if ((h > y0 ? h - y0 : y0 - h) > step) return false;
  if (blockedAt(g, x, z, r, h)) return false;
  w.x = x;
  w.z = z;
  w.feet = h;
  return true;
}

// ---------------------------------------------------------------- choosing where to dive

/** How close a body of this profile may come to a vehicle's reach: its override clearance (moving) or STOPPED_CLEAR_M (stopped); robots ROBOT_GAP_M. */
export function clearanceFrom(v: Readonly<Pick<Vehicle, "moving">>, prof: Readonly<DodgeProfile>): number {
  if (prof.override === null) return ROBOT_GAP_M;
  return v.moving ? prof.override : STOPPED_CLEAR_M;
}

/**
 * Is the spot clear of every vehicle's predicted footprint (plus margin, and its spread unless
 * `spread` is false) and every slow or stopped vehicle's reach (plus 0.3 m)?
 */
function clearOfVehicles(vehicles: readonly Vehicle[], x: number, z: number, r: number, margin: number, spread = true): boolean {
  for (const v of vehicles) {
    if (v.paths.length > 0) {
      if (x < v.minX - r - margin || x > v.maxX + r + margin || z < v.minZ - r - margin || z > v.maxZ + r + margin) continue;
      if (footprintWithin(v, x, z, r + margin, spread)) return false;
    } else if (zoneDistance(v, x, z) < r + 0.3) {
      return false;
    }
  }
  return true;
}

/** Does any predicted pose of the vehicle's body come within `lim` (plus its spread by then, unless `spread` is false) of (x, z)? sweepClearance(v, x, z, spread) < lim, faster. */
function footprintWithin(v: Readonly<Vehicle>, x: number, z: number, lim: number, spread: boolean): boolean {
  const k = spread ? v.spread : 0;
  const half = Math.sqrt(v.hl * v.hl + v.hw * v.hw);
  for (const path of v.paths) {
    for (const s of path) {
      const reach = lim + k * s.t;
      const dx = x - s.x;
      const dz = z - s.z;
      const far = reach + half;
      if (dx * dx + dz * dz > far * far) continue;
      if (boxDistance(x, z, s.x, s.z, s.fx, s.fz, v.hl, v.hw) - k * s.t < lim) return true;
    }
  }
  return false;
}

/**
 * Is (x, z) clear of the reach of every vehicle not moving fast enough to have a footprint
 * (parked, waiting, creeping) by the body's clearance from it and STOPPED_GAP_M? A dive's line
 * never goes through one.
 */
function clearOfStopped(stopped: readonly Vehicle[], x: number, z: number, r: number, prof: Readonly<DodgeProfile>): boolean {
  for (const v of stopped) if (zoneDistance(v, x, z) < r + clearanceFrom(v, prof) + STOPPED_GAP_M) return false;
  return true;
}

/** Does the line from (px, pz) to (x, z) keep clear of every stopped vehicle (clearOfStopped every MARCH_M)? */
function lineClearOfStopped(stopped: readonly Vehicle[], px: number, pz: number, x: number, z: number, r: number, prof: Readonly<DodgeProfile>): boolean {
  if (stopped.length === 0) return true;
  const len = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
  const n = Math.max(1, Math.ceil(len / MARCH_M));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    if (!clearOfStopped(stopped, px + (x - px) * f, pz + (z - pz) * f, r, prof)) return false;
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

/** Is the spot clear of every player on foot and their landing (Spot.walker), with a hair to spare? */
function walkerFree(spots: readonly Spot[], x: number, z: number, r: number): boolean {
  for (const s of spots) {
    if (!s.walker) continue;
    const lim = r + s.r + 0.02;
    if ((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < lim * lim) return false;
  }
  return true;
}

/**
 * Does a body leaving (px, pz) along (wx, wz) at `speed` for `len` metres stay `passing` (plus
 * the spread) clear of every moving vehicle's predicted body on the way? It has moved one tick
 * when the samples' clock starts (they are the vehicles after this tick's move).
 */
function passesClear(vehicles: readonly Vehicle[], px: number, pz: number, wx: number, wz: number, len: number, speed: number, r: number, passing: number): boolean {
  return passCheck(vehicles, px, pz, wx, wz, len, speed, r, passing) === 0;
}

/**
 * passesClear's answer: 0 clear; 1 too close on the way (every longer line along it is too);
 * 2 too close only once at the landing, waiting there (a longer line along it may be clear).
 */
function passCheck(vehicles: readonly Vehicle[], px: number, pz: number, wx: number, wz: number, len: number, speed: number, r: number, passing: number): 0 | 1 | 2 {
  let out: 0 | 1 | 2 = 0;
  for (const v of vehicles) {
    const half = Math.sqrt(v.hl * v.hl + v.hw * v.hw);
    for (const path of v.paths) {
      for (const s of path) {
        const go = speed * (s.t + DT);
        const along = go < len ? go : len;
        const x = px + wx * along;
        const z = pz + wz * along;
        const lim = r + passing + v.spread * s.t;
        const far = lim + half;
        if ((x - s.x) * (x - s.x) + (z - s.z) * (z - s.z) > far * far) continue;
        if (boxDistance(x, z, s.x, s.z, s.fx, s.fz, v.hl, v.hw) < lim) {
          if (go < len) return 1;
          out = 2;
        }
      }
    }
  }
  return out;
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
 * margin; its line, walked over the ground (walkTo), must be clear of buildings, walls and big
 * steps and of every stopped vehicle's reach, and stay clear of the moving vehicles on the way:
 * by the body's margin when any line is, else by its clearance from them plus 0.05 m (at least
 * PASSING_M); across a vehicle's path, CROSSING_EXTRA_M more. When nothing qualifies, the spot on
 * the lines with the most clearance from the vehicles whose line never meets a vehicle's
 * predicted body (a best effort the override backs up), or null. `prefer` (a unit direction:
 * a dive already under way) keeps a body from changing its mind: its side is the side that
 * direction is on, and a line turning back against it costs up to REVERSE_COST more. `speed` is
 * the dive's speed (boosted when it scrambles).
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
  const close = Math.max(PASSING_M, (prof.override ?? ROBOT_GAP_M) + 0.05);
  // First a line that keeps the body's whole margin from every predicted footprint on the way
  // (one that only stays close by can cut in front of a turning car's arc); then, when there is
  // none, any line that stays the body's clearance from it and a little more.
  for (const passing of [prof.margin, close]) {
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
        const walk: Walk = { x: b.x, z: b.z, feet: b.y };
        for (let len = MARCH_M; len <= prof.maxDive + 1e-9; len += MARCH_M) {
          if (best && base + len >= best.cost) break;
          const x = b.x + wx * len;
          const z = b.z + wz * len;
          if (!walkTo(g, walk, x, z, b.r, b.y, DIVE_STEP_M) || !clearOfStopped(stopped, x, z, b.r, prof)) break;
          if (!clearOfVehicles(vehicles, x, z, b.r, prof.margin + LANDING_EXTRA_M)) continue;
          // (Across the vehicle's path: with a wider berth, since that line goes in front of it.)
          const pass = passCheck(moving, b.x, b.z, wx, wz, len, speed, b.r + (sideSign === side ? 0 : CROSSING_EXTRA_M), passing);
          if (pass === 1) break;
          if (pass === 2) continue;
          // Never onto a player on foot; onto another body or landing: allowed, but dearer (a
          // little further on is usually free).
          if (!walkerFree(spots, x, z, b.r)) continue;
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
  // Best effort: the spot on the lines that keeps furthest from the vehicles, on a line that
  // never meets any vehicle's predicted body on the way (never through or into one; a step that
  // would end deeper in a vehicle's reach is stopped short, and the override backs it up).
  let far: { x: number; z: number; d: number } | null = null;
  const here = vehicleClearance(vehicles, b.x, b.z);
  for (const sideSign of [side, -side]) {
    for (const [ang] of FAN) {
      const c = dcos(ang);
      const sn = dsin(ang);
      const wx = nx * sideSign * c - s.ux * sn;
      const wz = nz * sideSign * c - s.uz * sn;
      const walk: Walk = { x: b.x, z: b.z, feet: b.y };
      for (let len = MARCH_M; len <= prof.maxDive + 1e-9; len += MARCH_M) {
        const x = b.x + wx * len;
        const z = b.z + wz * len;
        if (!walkTo(g, walk, x, z, b.r, b.y, DIVE_STEP_M) || !clearOfStopped(stopped, x, z, b.r, prof)) break;
        const d = vehicleClearance(vehicles, x, z);
        if (!(d > here && (!far || d > far.d))) continue;
        if (!walkerFree(spots, x, z, b.r)) continue;
        const pass = passCheck(moving, b.x, b.z, wx, wz, len, speed, b.r, 0);
        if (pass === 1) break;
        if (pass === 2) continue;
        far = { x, z, d };
      }
    }
  }
  return far ? { x: far.x, z: far.z } : null;
}

/** The override's spot, and how far it had to go to find one (0: along a line it can walk). */
export interface OverrideSpot {
  x: number;
  z: number;
  /**
   * 0: along a line walked as a dive's is (no wall, no building, a step of at most
   * OVERRIDE_STEP_M); 1: the same with any drop; 2: over a building (never across a wall); 3:
   * anywhere outside the vehicles' reach (the last resort). 2 and 3 count as failures.
   */
  tier: 0 | 1 | 2 | 3;
  /**
   * Where its feet are there: the surface the line walked onto (a leap up a flight of steps stands
   * on the step it reached), or the surface under the spot from the body's own feet (tiers 2, 3).
   */
  feet: number;
}

/**
 * The override's spot: the nearest point outside every vehicle's reach (each moving one's plus
 * the body's override clearance, each stopped one's plus STOPPED_CLEAR_M) that the body can leap
 * to. It may leap over a vehicle. A spot in a moving vehicle's path (its predicted footprint plus
 * the clearance) costs 100 m more, so nobody is put down in front of the car to be leapt again;
 * one on another body costs 0.5 m more, and one on a player on foot is never taken (but by the
 * last resort). Lines every 15 degrees and along the vehicles' sides,
 * out to CLEAR_FINE_M every 0.1 m, CLEAR_NEAR_M every 0.25 m, then CLEAR_FAR_M every 0.5 m,
 * walked as a dive's are (a
 * player on a roof leaps along it or off it); when no line leads anywhere, the same with any
 * drop, then over buildings, then anywhere outside the vehicles (OverrideSpot.tier). Never
 * fails: there is always a spot.
 */
export function overrideSpot(g: Ground, b: Readonly<Body>, vehicles: readonly Vehicle[], spots: readonly Spot[], clearance: number): OverrideSpot {
  const moving = vehicles.filter((v) => v.paths.length > 0);
  const dirs: Array<[number, number]> = [];
  for (let k = 0; k < 24; k++) {
    const a = (k * Math.PI) / 12;
    dirs.push([dsin(a), -dcos(a)]);
  }
  for (const v of vehicles) {
    // (Along the sides of the vehicles near enough for a line out of their way to matter.)
    if (zoneDistance(v, b.x, b.z) > CLEAR_FAR_M) continue;
    dirs.push([-v.fz, v.fx], [v.fz, -v.fx], [v.fx, v.fz], [-v.fx, -v.fz]);
  }
  const outside = (x: number, z: number): boolean => {
    for (const v of vehicles) {
      const need = b.r + (v.moving ? clearance : STOPPED_CLEAR_M) + 0.02;
      if (zoneDistance(v, x, z) < need) return false;
    }
    return true;
  };
  const tiers: ReadonlyArray<{ tier: 0 | 1 | 2 | 3; reach: ReadonlyArray<readonly [number, number]> }> = [
    { tier: 0, reach: [[CLEAR_FINE_M, 0.1], [CLEAR_NEAR_M, 0.25], [CLEAR_FAR_M, 0.5]] },
    { tier: 1, reach: [[CLEAR_FINE_M, 0.1], [CLEAR_NEAR_M, 0.25], [CLEAR_FAR_M, 0.5]] },
    { tier: 2, reach: [[CLEAR_FINE_M, 0.1], [CLEAR_NEAR_M, 0.25], [CLEAR_FAR_M, 0.5]] },
    { tier: 3, reach: [[CLEAR_LAST_M, 0.25]] },
  ];
  for (const { tier, reach } of tiers) {
    for (const [reachM, stepM] of reach) {
      let best: { x: number; z: number; cost: number; feet: number } | null = null;
      for (const [wx, wz] of dirs) {
        const walk: Walk = { x: b.x, z: b.z, feet: b.y };
        for (let len = stepM; len <= reachM + 1e-9; len += stepM) {
          if (best && len >= best.cost) break;
          const x = b.x + wx * len;
          const z = b.z + wz * len;
          let feet: number;
          if (tier <= 1) {
            if (!walkTo(g, walk, x, z, b.r, b.y, tier === 0 ? OVERRIDE_STEP_M : Infinity)) break;
            feet = walk.feet;
          } else {
            if (tier === 2 && segmentCrossesWall(g.world.walls, b.x, b.z, x, z)) break;
            feet = g.height(x, z, b.y);
            if (tier === 2 && blockedAt(g, x, z, b.r, feet)) continue;
          }
          if (!outside(x, z)) continue;
          if (tier < 3 && !walkerFree(spots, x, z, b.r)) continue;
          let cost = len;
          if (!clearOfVehicles(moving, x, z, b.r, clearance, false)) cost += 100;
          if (!spotFree(spots, x, z, b.r)) cost += 0.5;
          if (!best || cost < best.cost) best = { x, z, cost, feet };
          if (cost === len) break;
        }
      }
      if (best) return { x: best.x, z: best.z, tier, feet: best.feet };
    }
  }
  // (Unreachable: the vehicles are bounded, so some point CLEAR_LAST_M away is outside them all.)
  return { x: b.x, z: b.z - CLEAR_LAST_M - 10, tier: 3, feet: g.height(b.x, b.z - CLEAR_LAST_M - 10, b.y) };
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

/** How fast a dive moves its body, m/s (its line over its ticks). */
export function diveSpeed(d: Readonly<DodgeState>): number {
  const len = Math.sqrt((d.tx - d.sx) * (d.tx - d.sx) + (d.tz - d.sz) * (d.tz - d.sz));
  return d.dur > 0 ? len / (d.dur * DT) : 0;
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

/**
 * The override's leap of `dist` metres: how long it is drawn (ticks) and how high it hops. A
 * long one is the big superhuman hop (the profile's leapPeak over LEAP_TICKS); a short one (a
 * robotaxi creeping up, a car brushing past) a quick stumble-hop aside.
 */
export function leapShape(prof: Readonly<DodgeProfile>, dist: number): { dur: number; peak: number } {
  return { dur: clamp(Math.round(12 + 6 * dist), 12, LEAP_TICKS), peak: Math.min(prof.leapPeak, 0.2 + 0.45 * dist) };
}

/**
 * Where a step from (x0, z0) to (x1, z1) must stop: short of the first point at which it would go
 * deeper into a vehicle's reach than the body may be (clearanceFrom), checked every STEP_CHECK_M;
 * null when the whole step is fine. A body already too close may still step away (any step that
 * does not take it deeper).
 */
function stepStop(vs: readonly Vehicle[], x0: number, z0: number, x1: number, z1: number, r: number, prof: Readonly<DodgeProfile>): { x: number; z: number } | null {
  if (vs.length === 0) return null;
  const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
  if (len < 1e-9) return null;
  const slack = (x: number, z: number): number => {
    let s = Infinity;
    for (const v of vs) {
      const d = zoneDistance(v, x, z) - r - clearanceFrom(v, prof);
      if (d < s) s = d;
    }
    return s;
  };
  const n = Math.ceil(len / STEP_CHECK_M);
  let prev = slack(x0, z0);
  let px = x0;
  let pz = z0;
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const x = x0 + (x1 - x0) * f;
    const z = z0 + (z1 - z0) * f;
    const s = slack(x, z);
    if (s < 0 && s < prev - 1e-9) return { x: px, z: pz };
    prev = s;
    px = x;
    pz = z;
  }
  return null;
}

// ---------------------------------------------------------------- the tick

interface Rec {
  /** A player on foot (id) or an agent (index into the agents list). */
  player: PlayerId | null;
  index: number;
  x: number;
  z: number;
  y: number;
  /** Vertical speed (a player falling), m/s. */
  vy: number;
  r: number;
  cls: DodgeClass;
  id: number;
  dodge: DodgeState | null;
  /** Under the override (people, animals, players on foot). */
  guarded: boolean;
  /** May start a dive (a player falling cannot). */
  canDive: boolean;
  /** Vehicles whose predicted footprint reaches it this tick, earliest first (null: none). */
  threats: Array<{ v: number; hit: Hit }> | null;
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
      vy: f.grounded ? 0 : f.vy,
      r: FOOT.radius,
      cls: "player",
      id: hash32(...[...id].map((ch) => ch.charCodeAt(0))),
      dodge: f.dodge,
      guarded: true,
      canDive: f.grounded,
      threats: null,
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
      vy: 0,
      r: a.radius ?? AGENT_SPEC[a.kind].radius,
      cls,
      id: a.id,
      dodge: a.dodge,
      guarded: DODGE_PROFILE[cls].override !== null,
      canDive: true,
      threats: null,
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

  // Vehicles: every player's car, every robotaxi, built only when a dodger is near enough for
  // it to matter (most of the city's robotaxis have nobody near them on most ticks). A moving
  // robotaxi predicts its path (a route walk) only when a dodger is near enough to be in it; one
  // that might matter only for where someone lands is predicted when a dive needs it
  // (ensurePaths; the same paths either way). A robotaxi that is built gets its reach from its
  // route (routeReach: a connector's vertices turn it at once).
  const prevAgents = new Map<number, AgentState>();
  for (const a of (before.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? []) prevAgents.set(a.id, a);
  const bodies = playerBodies(before);
  /**
   * What each vehicle is (a player's car or a robotaxi and its step) and cheap bounds on it,
   * before it is built: `slack` bounds how far its reach over its next step extends beyond its
   * body round where it is now; `far` how far anything of it (its footprint, its reach) is from
   * where it is now.
   */
  interface Src {
    id: PlayerId | null;
    a: AgentState | null;
    dt: number;
    x: number;
    z: number;
    speed: number;
    slack: number;
    far: number;
    /** A robotaxi near enough to someone to predict (null: not worked out yet; cars always do). */
    predict: boolean | null;
  }
  const srcs: Src[] = [];
  const carHalfDiag = Math.sqrt(CAR.halfLength * CAR.halfLength + CAR.halfWidth * CAR.halfWidth);
  for (const id of ids) {
    const c = after.players[id]!.car;
    const v = Math.sqrt(c.speed * c.speed + c.lateral * c.lateral);
    const yaw = c.yawRate < 0 ? -c.yawRate : c.yawRate;
    const slack = v * DT + CAR_DV * DT + ((yaw * DT) / 2 + CAR.wallAlign * DT) * carHalfDiag + CAR.maxPush + 0.05;
    const far = CAR.halfLength + CAR.halfWidth + (v + PLAYER_SPREAD_MPS) * horizonS(v) + slack + 0.5;
    srcs.push({ id, a: null, dt: DT, x: c.x, z: c.z, speed: v, slack, far, predict: true });
  }
  const taxiHalfDiag = Math.sqrt(ROBOTAXI_BODY.halfLength * ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth * ROBOTAXI_BODY.halfWidth);
  for (const a of agents) {
    if (!AGENT_SPEC[a.kind].road) continue;
    const close = bodies.some((p) => (p.x - a.x) * (p.x - a.x) + (p.z - a.z) * (p.z - a.z) <= NEAR_RANGE_M * NEAR_RANGE_M);
    const dt = close ? DT : DT * LOD_STRIDE;
    const travel = (a.speed + AGENT_SPEC[a.kind].accel * dt) * dt;
    const inflateMax = (a.speed * dt) / 2 + (AGENT_SPEC[a.kind].accel + a.speed * 3) * dt * dt + dt * taxiHalfDiag + 0.01;
    const slack = 2 * travel + inflateMax + 0.05;
    const far = (a.halfLength ?? ROBOTAXI_BODY.halfLength) + (a.halfWidth ?? ROBOTAXI_BODY.halfWidth) + brakingReach(a.speed) + slack + 0.5;
    srcs.push({ id: null, a, dt, x: a.x, z: a.z, speed: a.speed, slack, far, predict: null });
  }
  /** Each robotaxi's route walk this tick, shared by its prediction and its reach. */
  const segsOf = new Map<number, Route>();
  const routeSegs = (vi: number): Route => {
    let r = segsOf.get(vi);
    if (!r) {
      r = agentRouteSegs(world, srcs[vi]!.a!);
      segsOf.set(vi, r);
    }
    return r;
  };
  /** How far round where it is now the checks below look for dodgers near vehicle vi: the override's candidates, and (moving) its footprint. */
  const lookOf = (vi: number): { cand: number; foot: number } => {
    const sv = srcs[vi]!;
    const hl = sv.id !== null ? CAR.halfLength : sv.a!.halfLength ?? ROBOTAXI_BODY.halfLength;
    const hw = sv.id !== null ? CAR.halfWidth : sv.a!.halfWidth ?? ROBOTAXI_BODY.halfWidth;
    const cand = hl + hw + sv.slack + DODGE_PROFILE.care.override! + 1 + 0.75;
    if (sv.speed < DODGE_MIN_SPEED) return { cand, foot: 0 };
    return { cand, foot: sv.id === null ? brakingReach(sv.speed) + hl + hw + maxReach + 1 : sv.far + maxReach };
  };
  /** The dodgers within the farther of those (rec indices), null when none: one query per vehicle. */
  const nearOf: Array<number[] | null> = srcs.map((sv, vi) => {
    const look = lookOf(vi);
    const lim = Math.max(look.cand, look.foot);
    near(sv.x - lim, sv.z - lim, sv.x + lim, sv.z + lim, scratch);
    let out: number[] | null = null;
    for (const i of scratch) {
      const r = recs[i]!;
      if ((r.x - sv.x) * (r.x - sv.x) + (r.z - sv.z) * (r.z - sv.z) <= lim * lim) (out ??= []).push(i);
    }
    return out;
  });
  /** Is any of the dodgers near vehicle vi within `lim` of it? */
  const anyWithin = (vi: number, lim: number): boolean => {
    const sv = srcs[vi]!;
    return (nearOf[vi] ?? []).some((i) => (recs[i]!.x - sv.x) * (recs[i]!.x - sv.x) + (recs[i]!.z - sv.z) * (recs[i]!.z - sv.z) <= lim * lim);
  };
  /**
   * A moving robotaxi predicts its path when a dodger is near enough to be in it: within reach of
   * where its route goes before braking stops it (its body at any point of the route lies within
   * its half diagonal and half the spacing of one of the points looked at).
   */
  const predictOf = (sv: Src, vi: number): boolean => {
    if (sv.predict === null) {
      const a = sv.a!;
      if (a.runtimeId !== undefined) { sv.predict = true; return true; }
      // (Its predicted footprint ends where braking at no less than ROBOTAXI_BRAKE_MPS2 stops it.)
      const reach = brakingReach(a.speed);
      sv.predict = false;
      if (a.speed >= DODGE_MIN_SPEED) {
        // Who is within reach of anywhere it can get to; then, of those, who is near its route.
        const circle = reach + ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth + maxReach + 1;
        const cand: Rec[] = [];
        for (const i of nearOf[vi] ?? []) {
          const r = recs[i]!;
          if ((r.x - a.x) * (r.x - a.x) + (r.z - a.z) * (r.z - a.z) <= circle * circle) cand.push(r);
        }
        if (cand.length > 0) {
          const ds: number[] = [];
          for (let d = 0; d < reach + CORRIDOR_STEP_M; d += CORRIDOR_STEP_M) ds.push(d);
          const pts = agentRouteAt(world, a, ds, routeSegs(vi));
          const lim = taxiHalfDiag + CORRIDOR_STEP_M / 2 + maxReach + 0.05;
          // (A route that ends short, at a dead end: predicted.)
          sv.predict = pts.length < ds.length || cand.some((r) => pts.some((q) => (r.x - q.x) * (r.x - q.x) + (r.z - q.z) * (r.z - q.z) <= lim * lim));
        }
      }
    }
    return sv.predict;
  };
  const built: Array<Vehicle | null> = srcs.map(() => null);
  /** Vehicle vi, built on first use. */
  const veh = (vi: number): Vehicle => {
    let v = built[vi];
    if (v) return v;
    const sv = srcs[vi]!;
    if (sv.id !== null) v = carVehicle(world, before, after, sv.id);
    else {
      v = vehicleOfAgent(sv.a!, prevAgents.get(sv.a!.id) ?? null, sv.dt, world, predictOf(sv, vi), routeSegs(vi));
      routeReach(v, sv.a!, sv.dt, world, routeSegs(vi));
    }
    built[vi] = v;
    return v;
  };
  /** Predict every robotaxi not predicted yet that could reach within `reach` of (x, z). */
  const ensurePaths = (x: number, z: number, reach: number): void => {
    for (let vi = ids.length; vi < srcs.length; vi++) {
      const sv = srcs[vi]!;
      const a = sv.a!;
      if (a.speed < DODGE_MIN_SPEED || predictOf(sv, vi)) continue;
      const lim = reach + brakingReach(a.speed) + ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth;
      if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) > lim * lim) continue;
      const was = veh(vi);
      const v = vehicleOfAgent(a, prevAgents.get(a.id) ?? null, sv.dt, world, true, routeSegs(vi));
      v.mx = was.mx;
      v.mz = was.mz;
      v.mfx = was.mfx;
      v.mfz = was.mfz;
      v.inflate = was.inflate;
      v.zone = was.zone;
      v.span = was.span;
      built[vi] = v;
      sv.predict = true;
    }
  };
  // Who is in whose predicted footprint. (A robotaxi keeps to its route and holds still while
  // anyone is within its berth of it, agents.ts: only a footprint coming within that berth is a
  // threat, so nobody dives out of the way of one passing as it should.)
  for (let vi = 0; vi < srcs.length; vi++) {
    const sv = srcs[vi]!;
    if (sv.speed < DODGE_MIN_SPEED) continue;
    if (sv.id === null ? !predictOf(sv, vi) : !anyWithin(vi, sv.far + maxReach)) continue;
    const v = veh(vi);
    if (v.paths.length === 0) continue;
    // (Everyone its footprint can come near is among the dodgers near it.)
    for (const i of nearOf[vi] ?? []) {
      const r = recs[i]!;
      if (v.player !== null && v.player === r.player) continue; // a player's own car
      const margin = DODGE_PROFILE[r.cls].margin;
      // (Not when it cannot be at their height: a car in the street under someone on a roof.)
      const hit = sweepHitBand(world, v, r.x, r.z, r.r + (v.player === null ? Math.min(margin, robotaxiBerth(r.cls)) : margin), r.y);
      if (hit) (r.threats ??= []).push({ v: vi, hit });
    }
  }

  // Spots taken: every body where it is, every diver's landing (owner: index into recs). Built
  // when the first body needs them (most ticks nobody dives).
  let spots: Array<Spot & { owner: number }> | null = null;
  const takeSpots = (): Array<Spot & { owner: number }> => {
    if (spots) return spots;
    spots = [];
    recs.forEach((r, i) => {
      const walker = r.player !== null;
      spots!.push({ x: r.x, z: r.z, r: r.r, owner: i, walker });
      if (r.dodge && r.dodge.phase === "dive") spots!.push({ x: r.dodge.tx, z: r.dodge.tz, r: r.r, owner: i, walker });
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
  let failures = ext0.failures;
  const credit = new Map<PlayerId, { near: number; bumps: number }>();
  const creditTo = (v: Vehicle, near: number, bumps: number): void => {
    if (v.player === null) return;
    const c = credit.get(v.player) ?? { near: 0, bumps: 0 };
    c.near += near;
    c.bumps += bumps;
    credit.set(v.player, c);
  };

  const groundOf = (r: Rec): Ground => groundFor(world, r.player !== null);
  const notOwn = (r: Rec) => (v: Vehicle): boolean => v.player === null || v.player !== r.player;
  /**
   * A player's own car while they are on foot (parked): never a threat to them and never their
   * contact, but solid to them, a stopped vehicle their dives and the override's leaps go round
   * and never end in.
   */
  const ownCars = new Map<PlayerId, Vehicle>();
  const ownCar = (r: Rec): Vehicle | null => {
    if (r.player === null) return null;
    let v = ownCars.get(r.player);
    if (!v) {
      v = { ...veh(ids.indexOf(r.player)), paths: [], moving: false };
      ownCars.set(r.player, v);
    }
    return v;
  };
  const reachOf = (v: Vehicle, x: number, z: number, reach: number): boolean => {
    const lim = reach + v.hl + v.hw + v.inflate + v.span;
    return (x - v.mx) * (x - v.mx) + (z - v.mz) * (z - v.mz) <= lim * lim;
  };
  /** Could anything of vehicle vi (its footprint, its reach) be within `reach` of (x, z)? (Cheap: before it is built.) */
  const mayReach = (vi: number, x: number, z: number, reach: number): boolean => {
    const sv = srcs[vi]!;
    const lim = reach + sv.far;
    // (A square: it holds the footprint's box grown by `reach` as well as the reach's circle.)
    return x - sv.x <= lim && sv.x - x <= lim && z - sv.z <= lim && sv.z - z <= lim;
  };
  /** Vehicles whose footprint or reach comes within `reach` of the body (predicting robotaxis that may need it), and its own car (ownCar). */
  const vehiclesNear = (r: Rec, reach: number): Vehicle[] => {
    ensurePaths(r.x, r.z, reach);
    const out: Vehicle[] = [];
    for (let vi = 0; vi < srcs.length; vi++) {
      if (r.player !== null && srcs[vi]!.id === r.player) continue;
      if (!mayReach(vi, r.x, r.z, reach)) continue;
      const v = veh(vi);
      const inBox = r.x >= v.minX - reach && r.x <= v.maxX + reach && r.z >= v.minZ - reach && r.z <= v.maxZ + reach;
      if (inBox || reachOf(v, r.x, r.z, reach)) out.push(v);
    }
    const own = ownCar(r);
    if (own && reachOf(own, r.x, r.z, reach)) out.push(own);
    return out;
  };
  /** Vehicles whose reach comes within `reach` of (x, z) (no prediction), and the body's own car. */
  const reachNear = (r: Rec, x: number, z: number, reach: number): Vehicle[] => {
    const out: Vehicle[] = [];
    for (let vi = 0; vi < srcs.length; vi++) {
      if (r.player !== null && srcs[vi]!.id === r.player) continue;
      if (!mayReach(vi, x, z, reach)) continue;
      const v = veh(vi);
      if (reachOf(v, x, z, reach)) out.push(v);
    }
    const own = ownCar(r);
    if (own && reachOf(own, x, z, reach)) out.push(own);
    return out;
  };

  // 1-3. Watch and dive; every dive step stays out of the vehicles' reach.
  for (let ri = 0; ri < recs.length; ri++) {
    const r = recs[ri]!;
    // (Nobody in a vehicle's way and not dodging: nothing to do.)
    if (r.threats === null && r.dodge === null) continue;
    const prof = DODGE_PROFILE[r.cls];
    r.threats?.sort((a, b) => a.hit.t - b.hit.t || a.v - b.v);
    const threat = r.canDive && r.threats ? r.threats[0]! : null;
    let d = r.dodge;
    const diving = d !== null && d.phase === "dive" && !d.leap;
    let nearV: Vehicle[] | null = null;
    const nearby = (): Vehicle[] => nearV ?? (nearV = vehiclesNear(r, prof.maxDive + r.r + prof.margin + 1));
    // A dive under way still holds when its landing is clear of every footprint and its line
    // keeps the body's margin from the moving vehicles and clear of the stopped ones.
    let holds = true;
    if (diving) holds = diveHolds(nearby(), r.x, r.z, d!, r.r, prof);
    if ((threat && !(diving && holds)) || !holds) {
      const nv = nearby();
      let hit: Hit | null = threat ? threat.hit : null;
      let by: Vehicle | null = threat ? veh(threat.v) : null;
      if (!hit && diving) {
        const t = threatAlong(nv, r.x, r.z, d!.tx, d!.tz, r.r, prof);
        if (t) {
          hit = t.hit;
          by = t.v;
        }
      }
      let to: { x: number; z: number } | null = null;
      // Seen late, or already scrambling: scramble.
      const scramble = (hit !== null && hit.t <= EMERGENCY_S) || (diving && diveSpeed(d!) > prof.speed * 1.01);
      const speed = scramble ? prof.speed * EMERGENCY_BOOST : prof.speed;
      if (hit) {
        // A dive under way keeps its direction if it can (no dithering as a car steers about).
        let prefer: { x: number; z: number } | null = null;
        if (diving) {
          const len = Math.sqrt((d!.tx - d!.sx) * (d!.tx - d!.sx) + (d!.tz - d!.sz) * (d!.tz - d!.sz));
          if (len > 1e-9) prefer = { x: (d!.tx - d!.sx) / len, z: (d!.tz - d!.sz) / len };
        }
        const body: Body = { x: r.x, z: r.z, y: r.y, r: r.r, cls: r.cls, id: r.id };
        to = chooseDive(groundOf(r), body, hit, nv, spotsNear(ri, prof.maxDive + 2), prefer, speed);
      }
      if (to) {
        d = diving ? redirectDive(prof, d!, r.x, r.z, to.x, to.z, speed) : startDive(prof, r.x, r.z, to.x, to.z, speed);
        takeSpots().push({ x: to.x, z: to.z, r: r.r, owner: ri, walker: r.player !== null });
        if (!diving) {
          dives++;
          nearMisses++;
          if (by) creditTo(by, 1, 0);
        }
      } else if (diving && !holds) {
        // Nowhere better: land short of whatever is in the way (never through a vehicle).
        const end = clearPart(nv, r.x, r.z, d!.tx, d!.tz, r.r, prof);
        d = redirectDive(prof, d!, r.x, r.z, end.x, end.z, Math.max(diveSpeed(d!), 1));
      }
    }
    if (d) {
      const n = advanceDodge(d, prof);
      if (n.dodge && n.dodge.phase === "dive" && !n.dodge.leap) {
        const stop = stepStop(reachNear(r, r.x, r.z, 2), r.x, r.z, n.x, n.z, r.r, prof);
        if (stop) {
          // Stopped short this tick (re-aimed next tick, its line no longer holding): the dive is
          // put back along its line so it carries on from here.
          const u = n.dodge.t / n.dodge.dur;
          const k = u / (1 - u);
          n.dodge = { ...n.dodge, sx: stop.x + (stop.x - n.dodge.tx) * k, sz: stop.z + (stop.z - n.dodge.tz) * k };
          n.x = stop.x;
          n.z = stop.z;
        }
      } else if (n.dodge && n.dodge.phase === "recover" && d.phase === "dive" && !d.leap) {
        // Landing this tick: the last step is checked too, and the body gets up where it stopped.
        const stop = stepStop(reachNear(r, r.x, r.z, 2), r.x, r.z, n.x, n.z, r.r, prof);
        if (stop) {
          n.dodge = { ...n.dodge, tx: stop.x, tz: stop.z };
          n.x = stop.x;
          n.z = stop.z;
        }
      }
      r.x = n.x;
      r.z = n.z;
      r.dodge = n.dodge;
      r.changed = true;
    }
  }

  // 4. The hard guarantee. Candidates: the dodgers near each vehicle's reach.
  const cand = new Map<number, number[]>();
  for (let vi = 0; vi < srcs.length; vi++) {
    // (Nobody near where its reach can be: not built.)
    if (!anyWithin(vi, lookOf(vi).cand)) continue;
    const v = veh(vi);
    const reach = v.hl + v.hw + v.inflate + v.span + DODGE_PROFILE.care.override! + 1;
    for (const i of nearOf[vi] ?? []) {
      const r = recs[i]!;
      if ((r.x - v.mx) * (r.x - v.mx) + (r.z - v.mz) * (r.z - v.mz) > (reach + 0.75) * (reach + 0.75)) continue;
      let l = cand.get(i);
      if (!l) cand.set(i, (l = []));
      l.push(vi);
    }
  }
  for (let ri = 0; ri < recs.length; ri++) {
    const r = recs[ri]!;
    if (!r.guarded) continue;
    const mine = cand.get(ri);
    if (!mine) continue;
    const prof = DODGE_PROFILE[r.cls];
    const clearance = prof.override!;
    let inside = false;
    let worst: Vehicle | null = null;
    let worstD = 0;
    for (const vi of mine) {
      const v = veh(vi);
      if (v.player !== null && v.player === r.player) continue;
      // (Not one that cannot be at their height by the next tick: on a roof over it, under a deck it is on.)
      if (!bandMeetsNext(world, v, r.y, r.vy)) continue;
      if (bodyDistance(v, r.x, r.z) < r.r && bandOverlapsNow(v, r.y)) inside = true;
      const s = zoneDistance(v, r.x, r.z) - r.r - clearanceFrom(v, prof);
      if (s < worstD) {
        worstD = s;
        worst = v;
      }
    }
    if (!worst) continue;
    if (inside) {
      contacts++;
      creditTo(worst, 0, 1);
    }
    // (Every vehicle that can be near a spot the override may take, out to its last resort.)
    const nearV = vehiclesNear(r, CLEAR_LAST_M + 2);
    const body: Body = { x: r.x, z: r.z, y: r.y, r: r.r, cls: r.cls, id: r.id };
    const to = overrideSpot(groundOf(r), body, nearV, spotsNear(ri, CLEAR_NEAR_M + 2), clearance);
    if (to.tier >= 2) failures++;
    overrides++;
    nearMisses++;
    creditTo(worst, 1, 0);
    const dist = Math.sqrt((to.x - r.x) * (to.x - r.x) + (to.z - r.z) * (to.z - r.z));
    const shape = leapShape(prof, dist);
    r.dodge = { phase: "dive", sx: r.x, sz: r.z, tx: to.x, tz: to.z, t: 0, dur: shape.dur, peak: shape.peak, hop: 0, leap: true };
    r.x = to.x;
    r.z = to.z;
    // (Standing on what the leap reached: a step it climbed, a lower street it dropped to.)
    r.y = to.feet;
    r.changed = true;
    takeSpots().push({ x: to.x, z: to.z, r: r.r, owner: ri, walker: r.player !== null });
  }

  // Write back.
  const changed =
    recs.some((r) => r.changed) ||
    credit.size > 0 ||
    contacts !== ext0.contacts ||
    overrides !== ext0.overrides ||
    dives !== ext0.dives ||
    nearMisses !== ext0.nearMisses ||
    failures !== ext0.failures;
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
  const counters: DodgeExt = { contacts, overrides, dives, nearMisses, failures };
  ext = { ...ext, [DODGE_EXT_KEY]: counters };
  return { ...after, players, ext };
}

/**
 * Does a dive under way still hold, from where the body is (px, pz)? Its landing clear of every
 * vehicle's footprint (with the margin), its line keeping the margin from every moving vehicle
 * on the way at the dive's own speed, and clear of every stopped one.
 */
function diveHolds(vehicles: readonly Vehicle[], px: number, pz: number, d: Readonly<DodgeState>, r: number, prof: Readonly<DodgeProfile>): boolean {
  const len = Math.sqrt((d.tx - px) * (d.tx - px) + (d.tz - pz) * (d.tz - pz));
  if (!clearOfVehicles(vehicles, d.tx, d.tz, r, prof.margin)) return false;
  if (len < 1e-6) return true;
  const wx = (d.tx - px) / len;
  const wz = (d.tz - pz) / len;
  const moving = vehicles.filter((v) => v.paths.length > 0);
  const stopped = vehicles.filter((v) => v.paths.length === 0);
  return passesClear(moving, px, pz, wx, wz, len, Math.max(diveSpeed(d), 1), r, prof.margin) && lineClearOfStopped(stopped, px, pz, d.tx, d.tz, r, prof);
}

/**
 * What a dive's line from (px, pz) to (tx, tz) runs into: the earliest hit of a moving vehicle's
 * footprint on it (the body's margin), else a stopped vehicle in the way (as a hit now, its body
 * along its nose), else null.
 */
function threatAlong(vehicles: readonly Vehicle[], px: number, pz: number, tx: number, tz: number, r: number, prof: Readonly<DodgeProfile>): { hit: Hit; v: Vehicle } | null {
  const len = Math.sqrt((tx - px) * (tx - px) + (tz - pz) * (tz - pz));
  const n = Math.max(1, Math.ceil(len / MARCH_M));
  let best: { hit: Hit; v: Vehicle } | null = null;
  for (const v of vehicles) {
    if (v.paths.length === 0) continue;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const h = sweepHit(v, px + (tx - px) * f, pz + (tz - pz) * f, r + prof.margin);
      if (h && (!best || h.t < best.hit.t)) best = { hit: h, v };
    }
  }
  if (best) return best;
  for (const v of vehicles) {
    if (v.paths.length > 0) continue;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      if (zoneDistance(v, px + (tx - px) * f, pz + (tz - pz) * f) < r + clearanceFrom(v, prof) + STOPPED_GAP_M) {
        return { hit: { t: 0, sample: { t: 0, x: v.x, z: v.z, fx: v.fx, fz: v.fz, ux: v.fx, uz: v.fz } }, v };
      }
    }
  }
  return null;
}

/** The furthest point of the line from (px, pz) toward (tx, tz) up to which it stays clear of every stopped vehicle (from where it is). */
function clearPart(vehicles: readonly Vehicle[], px: number, pz: number, tx: number, tz: number, r: number, prof: Readonly<DodgeProfile>): { x: number; z: number } {
  const stopped = vehicles.filter((v) => v.paths.length === 0);
  const len = Math.sqrt((tx - px) * (tx - px) + (tz - pz) * (tz - pz));
  const n = Math.max(1, Math.ceil(len / MARCH_M));
  let at = { x: px, z: pz };
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const x = px + (tx - px) * f;
    const z = pz + (tz - pz) * f;
    if (!clearOfStopped(stopped, x, z, r, prof)) break;
    at = { x, z };
  }
  return at;
}

/**
 * An agent at (x, z) in its dodge (or done with it, dodge null): stood on the ground plus its
 * hop, mode "dive" or "recover", not walking. Recovering, it faces the way it will walk on (so
 * it turns that way as it gets up). Done: it walks on from right here (agents.ts rejoinAt: on
 * its path, or along a connector back onto its sidewalk), never jumping back to its line.
 */
function placeAgent(world: World, a: Readonly<AgentState>, x: number, z: number, dodge: DodgeState | null): AgentState {
  const y = surfaceHeight(world, x, z, a.y - (a.dodge?.hop ?? 0));
  if (dodge && dodge.phase === "dive") return { ...a, x, y: y + dodge.hop, z, speed: 0, mode: dodge.phase, dodge };
  const at = rejoinAt(world, a, x, z);
  if (dodge) return { ...a, x, y: y + dodge.hop, z, speed: 0, mode: dodge.phase, dodge, heading: at ? at.heading : a.heading };
  return { ...a, ...(at ?? {}), x, y, z, speed: 0, mode: "go", wait: 0, dodge: null };
}
