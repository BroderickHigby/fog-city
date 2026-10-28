// Standalone calls preserve the v18 handling below. The game explicitly selects v19 city-road
// controls from reference-driving.ts; collision bodies, static safety and SF ground remain shared.
// v24 adds brake-steer rotation and the handbrake drift there (reference-driving.ts): the v18
// tail kick returns for the handbrake, capped by the tyres' grip. Every caller that passes a
// version (the player's car, a driven taxi or stolen car) gets it; ambient traffic never runs here.
// Car handling: deterministic, pure, plain-JSON state (CarState in contract.ts).
//
// v15 dynamics (the owner: "drive faster", "more realistic"): a modern EV, 0-100 km/h in about
// 5.5 s (drive limited by what the tyres put down, then by the motor's power, CAR.powerPerKg / v)
// and about 195 km/h flat out (power meets drag). The tyres share one grip budget, tyreMu g scaled
// by the road's traction (a friction circle): braking or drive leaves less for cornering. Braking
// and accelerating move weight between the axles (CAR.weightTransfer): the front axle's grip caps
// how fast the car turns (understeer at the limit), the rear's how well it holds a slide (it lets
// go first under hard braking). The brakes are ABS-limited to the tyres' grip (about 36 m from
// 100 km/h dry, longer wet), a handbrake turn kicks the tail out (CAR.handbrakeKick), and the
// wheels turn more slowly at speed. The rest below is the model that carries all of that.
//
// Model, per tick:
//  - Velocity is (speed, lateral) in the car's frame. Yaw rotates the frame but not the
//    world velocity, so turning creates sideways slip that tyre grip then removes.
//  - Full grip: yaw is the kinematic bicycle rate, capped so lateral acceleration stays under
//    gripAccel (the car understeers at speed rather than sliding). Steering lock shrinks with
//    speed (maxSteer / (1 + v / steerSpeedRef)).
//  - Brake + steer above driftMinSpeed drops `grip` toward 0: lateral friction falls to
//    driftGripAccel, yaw gets an oversteer boost, the brake becomes a light handbrake, and a
//    stability term yaws the nose back toward the direction of travel (a controlled slide).
//    Releasing the brake lets grip recover (slower while powersliding on throttle); the slide's
//    sideways speed is partly converted back into forward speed (driftConserve).
//  - Slopes: gravity along the ground gradient (sampled under the four wheel positions)
//    accelerates the car downhill and slows it uphill, in both the forward and sideways axes.
//  - Vertical: the car follows the ground while the ground is above its ballistic path; when
//    the ground falls away faster than gravity (cresting a hill fast) it flies, keeps its
//    horizontal velocity, has no traction, and lands when the ground comes back up. Its
//    vertical speed on the ground is the ground's slope under its wheels along its velocity:
//    never the height gained by being pushed sideways (out of a wall or a building) or placed
//    on higher ground, and never more than maxClimbGrade times its speed, so nothing but a
//    crest launches it. While it touches a wall, a building or a body it stays on the ground
//    (unless it meets a real drop), and wall friction slows a vertical slide along a wall as
//    it slows the horizontal one. The ground includes a roof the wheels reach (within
//    ROOF_STEP_M of them): a car that gets onto a roof drives on it and off its edge.
//  - Collision: the body is an oriented rectangle pushed out of building footprints and
//    obstacle circles in small substeps, by at most CAR.maxPush a tick beyond its own travel
//    (so a car placed overlapping a footprint eases out over a few ticks instead of jumping).
//    A building blocks it between its wheels plus ROOF_STEP_M and the top of its body (it
//    passes under a structure with a higher underside). Velocity into the surface is removed (a little
//    bounce on hard hits) and scraping friction slows the slide, so the car slides along
//    walls. A hit is counted once per impact event: a contact that starts at least
//    hitCooldown ticks after the previous one, at hitMinSpeed or more into the surface.
//  - Bodies that can be shoved (another car, a robotaxi: a Circle with a `body`) are not walls:
//    the first time in a tick the car closes on one, the two exchange momentum along the contact
//    normal (masses CAR.mass and body.mass, restitution CAR.bodyRestitution), the car's share
//    turns it about its centre (an off-centre hit spins it), and the impulse is reported in
//    `contacts` so step.ts (impacts.ts) can give the other body its share. The car is still held
//    out of the body's circles, which stand where the body was at the start of the tick.

import { stepReferenceDriving, type ReferenceDrivingResult } from "./reference-driving.ts";
import { DT, type CarState, type SimInput } from "./contract.ts";
import { approach, clamp, datan, datan2, dcos, dsin, dtan, wrapAngle } from "./dmath.ts";
import { boxBlocked, boxCrossedWall, resolveBox, type Box, type Circle, type ImpactBody } from "./collide.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { ROOF_STEP_M, meshGroundHeight, surfaceHeight, type World } from "./world.ts";

export const CAR = {
  /**
   * About the top speed on the flat, m/s (~195 km/h), where the motor's power meets drag and
   * rolling resistance (v15 dynamics: a modern EV). Gravity can take you past it downhill; other
   * code uses it as "the car's natural top speed".
   */
  maxSpeed: 54,
  /** Hard cap on the speed along the body, m/s (downhill), and the fastest reverse. */
  speedCap: 62,
  maxReverse: 8,
  /**
   * Drive: at most `accel` m/s^2 (what the tyres put down from rest), and no more than
   * `powerPerKg` / v (the motor's power, W per kg): 0 to 100 km/h in about 5 s.
   */
  accel: 6,
  powerPerKg: 110,
  reverseAccel: 5,
  /** Brake demand at full pedal, m/s^2; ABS holds it to what the tyres can give (tyreMu g). */
  brakeDecel: 11,
  /** Brake deceleration while drifting (the brake is the handbrake: rear wheels locked). */
  handbrakeDecel: 4,
  /** A handbrake turn starting kicks the tail out at this yaw rate, rad/s (toward the steer). */
  handbrakeKick: 0.9,
  rolling: 0.25,
  /** Aerodynamic drag coefficient: a = aero * v^2. */
  aero: 0.0006,
  wheelbase: 2.7,
  maxSteer: 0.6,
  /** Wheel angle rate, rad/s, slowing with speed (steerRate / (1 + v / steerRateRef)): calm at speed. */
  steerRate: 3.2,
  steerRateRef: 25,
  steerSpeedRef: 11,
  /**
   * Tyres: the friction coefficient of the four together on a dry road (scaled by traction in
   * the wet). Drive or braking and cornering share it (a friction circle): sqrt(long^2 + lat^2)
   * <= tyreMu g.
   */
  tyreMu: 1.05,
  /** Max lateral acceleration with full grip, m/s^2 (tyreMu g). */
  gripAccel: 10.3,
  /**
   * Weight transfer: braking at a m/s^2 loads the front axle by weightTransfer * a / g (more
   * front grip: sharper turn-in) and lightens the rear as much (it lets go first); accelerating
   * does the opposite (understeer). Clamped to +-maxTransfer.
   */
  weightTransfer: 0.5,
  maxTransfer: 0.35,
  /** Lateral friction while fully sliding, m/s^2. */
  driftGripAccel: 6,
  driftYawBoost: 0.6,
  maxDriftYaw: 1.9,
  /** rad/s of counter-yaw per radian of slip angle while sliding. */
  stability: 3.2,
  gripDrop: 4,
  gripRecover: 1.3,
  /** Speed lost (m/s^2) while the front tyres scrub: steering past what grip allows at speed. */
  understeerScrub: 3,
  /** Grip recovery multiplier while powersliding (throttle + steer). */
  gripRecoverPower: 0.45,
  driftMinSpeed: 9,
  driftConserve: 0.65,
  yawResponse: 12,
  /** Body: half length and half width of the collision rectangle, metres. */
  halfLength: 2.2,
  halfWidth: 0.95,
  /** Ground samples: front/rear axle distance from centre, half track. */
  axle: 1.35,
  track: 0.8,
  gravity: 9.81,
  /** Gap under the wheels that still counts as on the ground (suspension travel). */
  suspension: 0.08,
  /** On the ground the car rises at most this many metres per metre travelled (a steeper lattice step is climbed, not launched from). */
  maxClimbGrade: 1,
  /** Top of the body above the wheels' contact point, metres: it passes under a structure whose underside is higher. */
  bodyHeight: 1.5,
  /**
   * Most the car is pushed out of buildings and bodies in one tick, metres, on top of its own
   * travel: a car placed overlapping a footprint, or left in one, leaves it over a few ticks
   * instead of jumping out (walls are not capped: they only undo this tick's own crossing).
   */
  maxPush: 0.5,
  hitMinSpeed: 2,
  hitCooldown: 30,
  restitution: 0.1,
  restitutionMin: 8,
  wallFriction: 0.25,
  wallAlign: 3.5,
  /** A hit harder than this (m/s into the surface) knocks grip down to impactGrip so the car slides off. */
  impactLoose: 5,
  impactGrip: 0.4,
  /** Legacy Phase 0 collision radius (kept for consumers that still read it). */
  radius: 1.6,
  bounce: 0.25,
  /** Kilograms, for momentum exchange with other bodies (impacts.ts). */
  mass: 1400,
  /** Yaw moment of inertia per unit mass, m^2: (length^2 + width^2) / 12 of the body box. */
  yawK2: 1.91,
  /** Restitution of a car against a body it can shove (bumpers give a little). */
  bodyRestitution: 0.25,
  /** How much of the off-centre impulse becomes spin (arcade: a little more than a rigid box), and its cap, rad/s. */
  spinGain: 1.2,
  maxSpinKick: 2.5,
  /** Coulomb friction between the bodies along the contact, as a share of the normal impulse. */
  bodyFriction: 0.15,
} as const;

/**
 * The most a car's velocity can change in one second on its own (not counting a hit on a body,
 * which dodge.ts bounds separately), m/s^2, a safe upper bound on the model above: the rear
 * axle's grip with full weight transfer (x1.5 sliding catch-up), the stronger of braking and
 * drive, drag at the speed cap, rolling, understeer scrub, and gravity on any slope.
 */
export const CAR_MAX_DV_PER_S =
  CAR.gripAccel * (1 + CAR.maxTransfer) * 1.5 + Math.max(CAR.brakeDecel, CAR.accel) + CAR.aero * CAR.speedCap * CAR.speedCap + CAR.rolling + CAR.understeerScrub + CAR.gravity;

/** The hardest a car's tyres can turn it, as lateral acceleration, m/s^2 (front grip with full weight transfer). */
export const CAR_MAX_TURN_ACCEL = CAR.gripAccel * (1 + CAR.maxTransfer);

/**
 * A car's hit on a body it can shove, from stepCar: the impulse on the car (kg m/s) along the
 * contact normal (nx, nz), pointing out of the body toward the car; the body takes -j.
 */
export interface CarContact {
  /** The body (ImpactBody.key). */
  key: string;
  j: number;
  nx: number;
  nz: number;
  /** Friction impulse on the car along the contact's tangent (tx, tz), kg m/s. */
  jt: number;
  tx: number;
  tz: number;
  /** Where the bodies touched, and how fast they closed, m/s. */
  x: number;
  z: number;
  speed: number;
}

const SINCE_CONTACT_CAP = 600;

export function makeCar(x: number, z: number, heading: number, y = 0): CarState {
  return {
    x,
    y,
    z,
    heading,
    speed: 0,
    steer: 0,
    hits: 0,
    lateral: 0,
    yawRate: 0,
    vy: 0,
    grounded: true,
    airTicks: 0,
    grip: 1,
    pitch: 0,
    roll: 0,
    sinceContact: SINCE_CONTACT_CAP,
    impactSpeed: 0,
    landingSpeed: 0,
    personBumps: 0,
    nearMisses: 0,
  };
}

/** A body that shoves and is shoved: mass (kg), yaw inertia per unit mass (m^2), centre and world velocity. */
export interface Shover {
  mass: number;
  k2: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * One hit of `self` on a body it can shove (`circle` is the slice of `body` it touched, the
 * normal (nx, nz) points out of the body toward self): self's velocity after exchanging momentum
 * along the normal (with `restitution`) and a little friction along the contact, the spin the
 * off-centre impulse gives self (rad/s, + = clockwise, capped), and the contact (the body takes
 * the opposite impulse at the same point). Null when they are not closing.
 */
export function bodyHit(
  self: Readonly<Shover>,
  body: Readonly<ImpactBody>,
  circle: Readonly<Circle>,
  nx: number,
  nz: number,
  restitution: number,
): { vx: number; vz: number; kick: number; contact: CarContact } | null {
  const rvx = self.vx - body.vx;
  const rvz = self.vz - body.vz;
  const vn = rvx * nx + rvz * nz;
  if (vn >= 0) return null;
  // (A prop hit below its break speed does not give: an immovable body.)
  const inv = 1 / self.mass + (body.breakSpeed !== undefined && -vn < body.breakSpeed ? 0 : 1 / body.mass);
  const j = ((1 + restitution) * -vn) / inv;
  // Friction along the contact, against the sliding, at most bodyFriction of the normal impulse.
  const tx = -nz;
  const tz = nx;
  const vt = rvx * tx + rvz * tz;
  const jt = clamp(-vt / inv, -CAR.bodyFriction * j, CAR.bodyFriction * j);
  const jx = j * nx + jt * tx;
  const jz = j * nz + jt * tz;
  // The touching point: on the circle, toward self.
  const px = circle.x + nx * circle.r;
  const pz = circle.z + nz * circle.r;
  const kick = spinKick(self.mass, self.k2, px - self.x, pz - self.z, jx, jz);
  return { vx: self.vx + jx / self.mass, vz: self.vz + jz / self.mass, kick, contact: { key: body.key, j, nx, nz, jt, tx, tz, x: px, z: pz, speed: -vn } };
}

/** A body's velocity once it has taken the opposite of contact `k`'s impulse. */
export function bodyAfter(body: Readonly<ImpactBody>, k: Readonly<CarContact>): { vx: number; vz: number } {
  if (body.breakSpeed !== undefined && k.speed < body.breakSpeed) return { vx: body.vx, vz: body.vz };
  return { vx: body.vx - (k.j * k.nx + k.jt * k.tx) / body.mass, vz: body.vz - (k.j * k.nz + k.jt * k.tz) / body.mass };
}

/**
 * The spin (rad/s, + = clockwise) an impulse (jx, jz) at offset (ox, oz) from a body's centre
 * gives it (a point's velocity from yaw rate w is w * (-oz, ox)), scaled by CAR.spinGain and capped.
 */
export function spinKick(mass: number, k2: number, ox: number, oz: number, jx: number, jz: number): number {
  return clamp((CAR.spinGain * (-oz * jx + ox * jz)) / (mass * k2), -CAR.maxSpinKick, CAR.maxSpinKick);
}

/** The car's collision rectangle. */
export function carBox(c: Readonly<Pick<CarState, "x" | "z" | "heading">>): Box {
  return { x: c.x, z: c.z, heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth };
}

/** How far from a requested spot clearCarSpot looks for room, metres. */
export const CLEAR_SPOT_RADIUS_M = 30;

/**
 * Where to put a car asked for at (x, z) facing `heading` (a spawn, a join, a respawn or a
 * teleport): there, when its body is clear of every building, wall and other car (`others`);
 * else the nearest clear spot on rings 1 m apart out to CLEAR_SPOT_RADIUS_M, reached from the
 * requested spot without crossing a wall, in a fixed order (so every client picks the same).
 * A car placed overlapping a footprint would otherwise be pushed out of it (at most
 * CAR.maxPush a tick). `keepOff`: more round bodies its body must not overlap (step.ts: people,
 * animals and players on foot grown by the dodge's clearance, robots, robotaxis), so a car never
 * appears on top of anyone. When nothing within reach is clear, the requested spot.
 */
export function clearCarSpot(
  world: World,
  x: number,
  z: number,
  heading: number,
  others: ReadonlyArray<Readonly<Box>> = [],
  keepOff: readonly Circle[] = [],
): { x: number; z: number } {
  const circles: Circle[] = [...others.flatMap((b) => carCircles(b)), ...keepOff];
  const clear = (px: number, pz: number): boolean => {
    const y = meshGroundHeight(world, px, pz);
    return !boxBlocked(world, { x: px, z: pz, heading, hl: CAR.halfLength, hw: CAR.halfWidth }, y + ROOF_STEP_M, circles, y + CAR.bodyHeight);
  };
  if (clear(x, z)) return { x, z };
  for (let r = 1; r <= CLEAR_SPOT_RADIUS_M; r++) {
    const n = 8 * r;
    for (let k = 0; k < n; k++) {
      const a = heading + (2 * Math.PI * k) / n;
      const px = x + dsin(a) * r;
      const pz = z - dcos(a) * r;
      if (segmentCrossesWall(world.walls, x, z, px, pz)) continue;
      if (clear(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** Three circles covering the car, for other bodies that treat it as an obstacle. */
export function carCircles(c: Readonly<Pick<CarState, "x" | "z" | "heading">>): Circle[] {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const o = CAR.halfLength - CAR.halfWidth;
  return [
    { x: c.x - fx * o, z: c.z - fz * o, r: CAR.halfWidth, person: false },
    { x: c.x, z: c.z, r: CAR.halfWidth, person: false },
    { x: c.x + fx * o, z: c.z + fz * o, r: CAR.halfWidth, person: false },
  ];
}

/**
 * Mean surface height under the four wheel positions and the slopes (rise per metre) forward
 * and to the right. The surface is the ground, or a roof the wheels reach (surfaceHeight) for
 * a car whose wheels are at `feet` (default: below every roof, so the bare ground).
 */
export function sampleGround(
  world: World,
  x: number,
  z: number,
  heading: number,
  feet = -Infinity,
): { h: number; slopeF: number; slopeR: number } {
  const fx = dsin(heading);
  const fz = -dcos(heading);
  const rx = -fz;
  const rz = fx;
  const hF = surfaceHeight(world, x + fx * CAR.axle, z + fz * CAR.axle, feet);
  const hB = surfaceHeight(world, x - fx * CAR.axle, z - fz * CAR.axle, feet);
  const hR = surfaceHeight(world, x + rx * CAR.track, z + rz * CAR.track, feet);
  const hL = surfaceHeight(world, x - rx * CAR.track, z - rz * CAR.track, feet);
  return { h: (hF + hB + hR + hL) / 4, slopeF: (hF - hB) / (2 * CAR.axle), slopeR: (hR - hL) / (2 * CAR.track) };
}

/**
 * Advance one car by one tick. `obstacles` are circles the car cannot pass through (robots,
 * other cars), positioned as of the previous tick. Since v4 step() never passes people or
 * animals here: they are not obstacles to a car (they dive out of its way, src/sim/dodge.ts). A
 * circle marked `person` still stops the car and counts in personBumps, for callers that ask.
 */
export function stepCar(
  world: World,
  c: Readonly<CarState>,
  input: Readonly<SimInput>,
  obstacles: readonly Circle[] = [],
  /** Road surface grip 0..1 (1 dry; rain and flooding lower it: src/sim/fog tractionAt). Scales cornering grip and braking. */
  traction = 1,
  contacts: CarContact[] = [],
  /** Optional body dimensions for another vehicle using the same handling model. */
  dimensions: Readonly<{halfLength:number;halfWidth:number;bodyHeight:number}> = CAR,
  /** Standalone callers retain v18; the game explicitly passes its saved simulation version. */
  handlingVersion = 18,
): CarState {
  const G = CAR.gravity;
  const mu = traction > 0 && traction < 1 ? traction : 1;
  const h0 = c.heading;
  const f0x = dsin(h0);
  const f0z = -dcos(h0);
  const g0 = sampleGround(world, c.x, c.z, h0, c.y);
  const onGround = c.y - g0.h <= CAR.suspension;

  let speed = c.speed;
  let lateral = c.lateral;
  let yawRate = c.yawRate;
  let grip = c.grip;
  let steer=c.steer,heading=h0,fx=f0x,fz=f0z,rx=-f0z,rz=f0x;
  let vx=0,vz=0;
  let reference:ReferenceDrivingResult|null=null;
  if(handlingVersion>=19&&onGround) {
    const gravityF=(-G*g0.slopeF)/Math.sqrt(1+g0.slopeF*g0.slopeF);
    const gravityR=(-G*g0.slopeR)/Math.sqrt(1+g0.slopeR*g0.slopeR);
    reference=stepReferenceDriving(c,input,mu,f0x*gravityF-f0z*gravityR,f0z*gravityF+f0x*gravityR,handlingVersion);
    ({speed,lateral,yawRate,steer,grip,heading}=reference);
    fx=dsin(heading);fz=-dcos(heading);rx=-fz;rz=fx;
  } else {
    const absV = speed < 0 ? -speed : speed;
    const steerIn = input.steer < 0 ? -input.steer : input.steer;

    // Speed-sensitive steering lock, and a wheel that turns more calmly at speed.
    const steerLimit = CAR.maxSteer / (1 + absV / CAR.steerSpeedRef);
    steer = approach(c.steer, input.steer * steerLimit, (CAR.steerRate / (1 + absV / CAR.steerRateRef)) * DT);

    // The tyres' grip budget (a friction circle) and what drive or braking takes of it this tick,
    // with the weight transfer that goes with it: load = +1 braking at 1 g, -1 accelerating at 1 g.
    const muG = CAR.tyreMu * G * mu;
    const thr0 = input.throttle;
    const wantBrake = (thr0 > 0 && speed < -0.1) || (thr0 < 0 && speed > 0.1) ? (thr0 < 0 ? -thr0 : thr0) : 0;
    const pedal = Math.min(1, wantBrake + (input.brake > 0 && !(input.brake > 0.5 && steerIn > 0.3 && speed > CAR.driftMinSpeed) ? input.brake : 0));
    const drive = thr0 > 0 && speed >= -0.1 ? thr0 * Math.min(CAR.accel, CAR.powerPerKg / Math.max(absV, 1)) : 0;
    const longUse = Math.min(muG, Math.max(pedal * CAR.brakeDecel, drive));
    const latBudget = Math.sqrt(Math.max(0, muG * muG - longUse * longUse));
    const transfer = clamp((CAR.weightTransfer * (pedal * Math.min(CAR.brakeDecel, muG) - drive)) / G, -CAR.maxTransfer, CAR.maxTransfer);
    const frontGrip = latBudget * (1 + transfer);
    const rearGrip = latBudget * (1 - transfer);

    let drifting = false;
    let scrub = 0;
    if (onGround) {
      if (input.brake > 0.5 && steerIn > 0.3 && speed > CAR.driftMinSpeed) {
        // Handbrake turn: the rear wheels lock and let go; the tail kicks out toward the steer.
        if (grip >= 0.95) yawRate += (input.steer < 0 ? -1 : 1) * CAR.handbrakeKick;
        grip = Math.max(0, grip - CAR.gripDrop * DT);
        drifting = true;
      } else {
        const power = input.throttle > 0.5 && steerIn > 0.3 && grip < 0.98 && speed > CAR.driftMinSpeed * 0.6;
        grip = Math.min(1, grip + CAR.gripRecover * (power ? CAR.gripRecoverPower : 1) * DT);
      }
      const slip = 1 - grip;
      const kin = (speed / CAR.wheelbase) * dtan(steer);
      // The front axle's grip limits how fast the car can turn (understeer at the limit).
      const gripLim = frontGrip / Math.max(absV, 1);
      const lim = Math.max(gripLim, CAR.maxDriftYaw * slip);
      const want = kin * (1 + CAR.driftYawBoost * slip);
      const wantAbs = want < 0 ? -want : want;
      scrub = wantAbs > lim ? (CAR.understeerScrub * (wantAbs - lim)) / wantAbs : 0;
      let target = clamp(want, -lim, lim);
      if (speed > 1 && slip > 0) target += CAR.stability * slip * datan2(lateral, speed);
      yawRate += (target - yawRate) * Math.min(1, CAR.yawResponse * DT);
    } else {
      yawRate -= yawRate * 0.5 * DT;
    }

    heading = wrapAngle(h0 + yawRate * DT);
    fx = dsin(heading);
    fz = -dcos(heading);
    rx = -fz;
    rz = fx;
    // World velocity is unchanged by the yaw; re-express it in the new frame.
    vx = speed * f0x + lateral * -f0z;
    vz = speed * f0z + lateral * f0x;
    speed = vx * fx + vz * fz;
    lateral = vx * rx + vz * rz;

    if (onGround) {
      const thr = input.throttle;
      let engine = 0;
      // Brakes, held by ABS to the tyres' grip (wet roads stop longer); the handbrake while drifting.
      const brake = Math.min(muG, pedal * CAR.brakeDecel) + (drifting ? CAR.handbrakeDecel * input.brake * mu : 0);
      if (thr > 0 && speed >= -0.1) engine += Math.min(drive, muG);
      else if (thr < 0 && speed <= 0.1) engine -= CAR.reverseAccel * -thr * clamp((CAR.maxReverse + speed) / (CAR.maxReverse * 0.5), 0, 1);
      const sF = g0.slopeF;
      const gravF = (-G * sF) / Math.sqrt(1 + sF * sF);
      speed += (engine + gravF) * DT;
      speed = approach(speed, 0, (brake + CAR.rolling + scrub) * DT);
      speed -= CAR.aero * speed * (speed < 0 ? -speed : speed) * DT;

      const sR = g0.slopeR;
      lateral += ((-G * sR) / Math.sqrt(1 + sR * sR)) * DT;
      const v2 = speed * speed + lateral * lateral;
      // The rear axle holds the slide: what the friction circle leaves it (less under braking),
      // down to the sliding friction while drifting.
      const latCap = CAR.driftGripAccel * mu + (rearGrip * 1.5 - CAR.driftGripAccel * mu) * grip;
      const newLat = approach(lateral, 0, latCap * DT);
      if (grip < 1 && speed > 1) {
        const keep = Math.sqrt(Math.max(0, v2 - newLat * newLat));
        speed += (keep - speed) * CAR.driftConserve;
      }
      lateral = newLat;

      // Parked or crawling with no throttle: hold still (no creeping on hills).
      const thrAbs = thr < 0 ? -thr : thr;
      if (thrAbs < 0.05 && (speed < 0 ? -speed : speed) < 0.3 && (lateral < 0 ? -lateral : lateral) < 0.3) {
        speed = 0;
        lateral = 0;
        yawRate = 0;
      }
    } else {
      speed -= CAR.aero * speed * (speed < 0 ? -speed : speed) * DT;
      lateral -= CAR.aero * lateral * (lateral < 0 ? -lateral : lateral) * DT;
    }
  }
  speed = clamp(speed, -15, CAR.speedCap);

  // Move in substeps, sliding along whatever we touch.
  let x = c.x;
  let z = c.z;
  vx = speed * fx + lateral * rx;
  vz = speed * fz + lateral * rz;
  const moveVx=reference?reference.dx/DT:vx,moveVz=reference?reference.dz/DT:vz;
  const travel = Math.sqrt(moveVx * moveVx + moveVz * moveVz) * DT;
  const n = clamp(Math.ceil(travel / 0.3), 1, 6);
  // Buildings block the body between its wheels plus the step it can climb onto a roof, and
  // its top (it passes under a structure higher than that).
  const colY = c.y + ROOF_STEP_M;
  const topY = c.y + dimensions.bodyHeight;
  // Walls hold each point of the body on the side it was on at the start of the tick.
  const ref = { x: c.x, z: c.z, heading: h0 };
  let touched = false;
  let impact = 0;
  let impactPerson = false;
  // Speed removed into walls and buildings this tick (their normal impulse, per unit mass).
  let scrape = 0;
  let pushLeft: number = CAR.maxPush;
  for (let i = 0; i < n; i++) {
    const lastX = x;
    const lastZ = z;
    x += ((reference && !touched ? moveVx : vx) * DT) / n;
    z += ((reference && !touched ? moveVz : vz) * DT) / n;
    const res = resolveBox(world, { x, z, heading, hl: dimensions.halfLength, hw: dimensions.halfWidth }, colY, obstacles, ref, pushLeft, topY);
    pushLeft -= res.pushed;
    if (!res.hit) continue;
    x = res.x;
    z = res.z;
    touched = true;
    if (boxCrossedWall(world, { x, z, heading, hl: dimensions.halfLength, hw: dimensions.halfWidth }, ref)) {
      // Wedged where the pushes cannot clear a wall (a sharp corner): undo this step, and the
      // turn too if even the last place is across a wall with the new heading. No point of the
      // body ever ends a tick on the far side of a wall from where it started.
      x = lastX;
      z = lastZ;
      if (boxCrossedWall(world, { x, z, heading, hl: dimensions.halfLength, hw: dimensions.halfWidth }, ref)) {
        x = c.x;
        z = c.z;
        heading = h0;
        fx = f0x;
        fz = f0z;
        rx = -fz;
        rz = fx;
        yawRate = 0;
      }
      const vn = vx * res.nx + vz * res.nz;
      if (vn < 0) {
        vx -= vn * res.nx;
        vz -= vn * res.nz;
      }
      break;
    }
    const body = res.person ? undefined : res.circle?.body;
    if (body) {
      // Another car or a robotaxi: momentum is exchanged once a tick; after that the car only
      // stops closing on it (it moves at the body's velocity along the normal).
      // (After the exchange the body moves at its new velocity: bodyAfter.)
      const hit = contacts.find((k) => k.key === body.key);
      const bv = hit ? bodyAfter(body, hit) : body;
      const rvx = vx - bv.vx;
      const rvz = vz - bv.vz;
      const vn = rvx * res.nx + rvz * res.nz;
      if (vn < 0) {
        if (-vn > impact) {
          impact = -vn;
          impactPerson = false;
        }
        if (hit) {
          vx -= vn * res.nx;
          vz -= vn * res.nz;
        } else {
          const h = bodyHit({ mass: CAR.mass, k2: CAR.yawK2, x, z, vx, vz }, body, res.circle!, res.nx, res.nz, CAR.bodyRestitution)!;
          vx = h.vx;
          vz = h.vz;
          yawRate += h.kick;
          contacts.push(h.contact);
        }
      }
      continue;
    }
    const vn = vx * res.nx + vz * res.nz;
    if (vn < 0) {
      if (-vn > impact) {
        impact = -vn;
        impactPerson = res.person;
      }
      if (!res.person) scrape += -vn;
      const e = -vn > CAR.restitutionMin ? CAR.restitution : 0;
      const tx = vx - vn * res.nx;
      const tz = vz - vn * res.nz;
      const tmag = Math.sqrt(tx * tx + tz * tz);
      const fr = tmag > 1e-9 ? Math.max(0, 1 - (CAR.wallFriction * -vn) / tmag) : 0;
      vx = tx * fr - e * vn * res.nx;
      vz = tz * fr - e * vn * res.nz;
    }
  }

  if (touched && !impactPerson) {
    if (impact > CAR.impactLoose) grip = Math.min(grip, CAR.impactGrip);
    // Scraping along a wall turns the nose to follow it.
    const vmag = Math.sqrt(vx * vx + vz * vz);
    if (vmag > 1 && vx * fx + vz * fz > 0) {
      const delta = wrapAngle(datan2(vx, -vz) - heading);
      const aligned = wrapAngle(heading + clamp(delta, -CAR.wallAlign * DT, CAR.wallAlign * DT));
      // (Never swinging a corner of the body across a wall.)
      if ((delta < 0 ? -delta : delta) < 1.2 && !boxCrossedWall(world, { x, z, heading: aligned, hl: dimensions.halfLength, hw: dimensions.halfWidth }, ref)) {
        heading = aligned;
        fx = dsin(heading);
        fz = -dcos(heading);
        rx = -fz;
        rz = fx;
      }
    }
  }
  speed = vx * fx + vz * fz;
  lateral = vx * rx + vz * rz;

  // Vertical: ballistic unless the ground (or a roof the wheels reach) holds the car up.
  const g1 = sampleGround(world, x, z, heading, c.y);
  // Friction at a wall acts on the vertical slide too: a car that flies into a wall or a
  // building does not carry on rising (or falling) along it at full speed (the same Coulomb
  // coefficient as the horizontal scrape, on the speed the impact removed).
  const vy0 = scrape > 0 ? approach(c.vy, 0, CAR.wallFriction * scrape) : c.vy;
  const vyB = vy0 - G * DT;
  const yB = c.y + vyB * DT;
  let y: number;
  let vy: number;
  let landingSpeed = c.landingSpeed;
  // The ground's rate of rise under the car: its slope under the wheels along the velocity,
  // never the height change over the tick. A collision push moves the car sideways (out of a
  // building, back from a wall) without it driving there, and a roof edge or a placement can
  // put it on higher ground at once; none of that is climbing, so none of it becomes lift.
  const climb = Math.sqrt(vx * vx + vz * vz) * CAR.maxClimbGrade;
  const rise = speed * g1.slopeF + lateral * g1.slopeR;
  const groundRate = rise > climb ? climb : rise;
  // In contact with something and on the ground at the start of the tick, the car stays on the
  // ground, its vertical speed the slope's along its new velocity: a hit that stops it on an
  // uphill does not carry it on upward, and a push (or a hit that turns it downhill) that
  // carries it over ground falling faster than gravity would follow is not a crest. A drop
  // steeper than maxClimbGrade over the tick's travel and push (a roof edge) is still fallen off.
  const held = touched && onGround && g1.h >= g0.h - CAR.maxClimbGrade * (travel + (CAR.maxPush - pushLeft)) - 1e-9;
  if (yB <= g1.h || held) {
    y = g1.h;
    vy = groundRate;
  } else {
    y = yB;
    vy = vyB;
  }
  const grounded = y - g1.h <= CAR.suspension;
  const airTicks = grounded ? 0 : c.airTicks + 1;
  if (grounded && c.airTicks > 0) {
    // Touchdown: how fast the car was falling relative to the ground under it.
    landingSpeed = Math.max(0, groundRate - vyB);
    if (landingSpeed > 2) {
      const loss = Math.min(0.25, 0.02 * landingSpeed);
      speed *= 1 - loss;
      lateral *= 1 - loss;
      grip = Math.min(grip, 0.75);
    }
  }
  // (+ 0 turns a -0 from a flat ground into 0, so states print the same as they compare.)
  const pitch = grounded ? datan(g1.slopeF) + 0 : c.pitch;
  const roll = grounded ? datan(-g1.slopeR) + 0 : c.roll;

  let hits = c.hits;
  let personBumps = c.personBumps;
  let impactSpeed = c.impactSpeed;
  if (touched && impact >= CAR.hitMinSpeed && c.sinceContact >= CAR.hitCooldown) {
    if (impactPerson) personBumps += 1;
    else hits += 1;
    impactSpeed = impact;
  }
  const sinceContact = touched ? 0 : Math.min(SINCE_CONTACT_CAP, c.sinceContact + 1);

  return {
    x,
    y,
    z,
    heading,
    speed,
    steer,
    hits,
    lateral,
    yawRate,
    vy,
    grounded,
    airTicks,
    grip,
    pitch,
    roll,
    sinceContact,
    impactSpeed,
    landingSpeed,
    personBumps,
    nearMisses: c.nearMisses,
  };
}
