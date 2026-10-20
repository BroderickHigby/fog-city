// Arcade car handling: deterministic, pure, plain-JSON state (CarState in contract.ts).
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
//    horizontal velocity, has no traction, and lands when the ground comes back up.
//  - Collision: the body is an oriented rectangle pushed out of building footprints and
//    obstacle circles in small substeps. Velocity into the surface is removed (a little
//    bounce on hard hits) and scraping friction slows the slide, so the car slides along
//    walls. A hit is counted once per impact event: a contact that starts at least
//    hitCooldown ticks after the previous one, at hitMinSpeed or more into the surface.

import { DT, type CarState, type SimInput } from "./contract.ts";
import { approach, clamp, datan, datan2, dcos, dsin, dtan, wrapAngle } from "./dmath.ts";
import { resolveBox, type Box, type Circle } from "./collide.ts";
import { groundHeight, type World } from "./world.ts";

export const CAR = {
  /** Engine top speed on the flat, m/s (~108 km/h). Gravity can take you past it downhill. */
  maxSpeed: 30,
  maxReverse: 8,
  /** Engine acceleration at low speed, m/s^2; fades out over the top engineFade of maxSpeed. */
  accel: 9.5,
  engineFade: 0.35,
  reverseAccel: 5,
  brakeDecel: 22,
  /** Brake deceleration while drifting (the brake acts as a light handbrake). */
  handbrakeDecel: 4,
  rolling: 0.25,
  /** Aerodynamic drag coefficient: a = aero * v^2. */
  aero: 0.0012,
  wheelbase: 2.7,
  maxSteer: 0.6,
  steerRate: 3.2,
  steerSpeedRef: 11,
  /** Max lateral acceleration with full grip, m/s^2. */
  gripAccel: 18,
  /** Lateral friction while fully sliding, m/s^2. */
  driftGripAccel: 9,
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
} as const;

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
  };
}

/** The car's collision rectangle. */
export function carBox(c: Readonly<Pick<CarState, "x" | "z" | "heading">>): Box {
  return { x: c.x, z: c.z, heading: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth };
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

/** Mean ground height under the four wheel positions and the slopes (rise per metre) forward and to the right. */
export function sampleGround(
  world: World,
  x: number,
  z: number,
  heading: number,
): { h: number; slopeF: number; slopeR: number } {
  const fx = dsin(heading);
  const fz = -dcos(heading);
  const rx = -fz;
  const rz = fx;
  const hF = groundHeight(world, x + fx * CAR.axle, z + fz * CAR.axle);
  const hB = groundHeight(world, x - fx * CAR.axle, z - fz * CAR.axle);
  const hR = groundHeight(world, x + rx * CAR.track, z + rz * CAR.track);
  const hL = groundHeight(world, x - rx * CAR.track, z - rz * CAR.track);
  return { h: (hF + hB + hR + hL) / 4, slopeF: (hF - hB) / (2 * CAR.axle), slopeR: (hR - hL) / (2 * CAR.track) };
}

/**
 * Advance one car by one tick. `obstacles` are circles the car cannot pass through (agents,
 * people, other cars), positioned as of the previous tick.
 */
export function stepCar(
  world: World,
  c: Readonly<CarState>,
  input: Readonly<SimInput>,
  obstacles: readonly Circle[] = [],
): CarState {
  const G = CAR.gravity;
  const h0 = c.heading;
  const f0x = dsin(h0);
  const f0z = -dcos(h0);
  const g0 = sampleGround(world, c.x, c.z, h0);
  const onGround = c.y - g0.h <= CAR.suspension;

  let speed = c.speed;
  let lateral = c.lateral;
  let yawRate = c.yawRate;
  let grip = c.grip;
  const absV = speed < 0 ? -speed : speed;
  const steerIn = input.steer < 0 ? -input.steer : input.steer;

  // Speed-sensitive steering lock.
  const steerLimit = CAR.maxSteer / (1 + absV / CAR.steerSpeedRef);
  const steer = approach(c.steer, input.steer * steerLimit, CAR.steerRate * DT);

  let drifting = false;
  let scrub = 0;
  if (onGround) {
    if (input.brake > 0.5 && steerIn > 0.3 && speed > CAR.driftMinSpeed) {
      grip = Math.max(0, grip - CAR.gripDrop * DT);
      drifting = true;
    } else {
      const power = input.throttle > 0.5 && steerIn > 0.3 && grip < 0.98 && speed > CAR.driftMinSpeed * 0.6;
      grip = Math.min(1, grip + CAR.gripRecover * (power ? CAR.gripRecoverPower : 1) * DT);
    }
    const slip = 1 - grip;
    const kin = (speed / CAR.wheelbase) * dtan(steer);
    const gripLim = CAR.gripAccel / Math.max(absV, 1);
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

  let heading = wrapAngle(h0 + yawRate * DT);
  let fx = dsin(heading);
  let fz = -dcos(heading);
  let rx = -fz;
  let rz = fx;
  // World velocity is unchanged by the yaw; re-express it in the new frame.
  let vx = speed * f0x + lateral * -f0z;
  let vz = speed * f0z + lateral * f0x;
  speed = vx * fx + vz * fz;
  lateral = vx * rx + vz * rz;

  if (onGround) {
    const thr = input.throttle;
    let engine = 0;
    let brake = 0;
    if (thr > 0) {
      if (speed < -0.1) brake += CAR.brakeDecel * thr;
      else engine += CAR.accel * thr * clamp((CAR.maxSpeed - speed) / (CAR.maxSpeed * CAR.engineFade), 0, 1);
    } else if (thr < 0) {
      if (speed > 0.1) brake += CAR.brakeDecel * -thr;
      else engine -= CAR.reverseAccel * -thr * clamp((CAR.maxReverse + speed) / (CAR.maxReverse * 0.5), 0, 1);
    }
    if (input.brake > 0) brake += (drifting ? CAR.handbrakeDecel : CAR.brakeDecel) * input.brake;
    const sF = g0.slopeF;
    const gravF = (-G * sF) / Math.sqrt(1 + sF * sF);
    speed += (engine + gravF) * DT;
    speed = approach(speed, 0, (brake + CAR.rolling + scrub) * DT);
    speed -= CAR.aero * speed * (speed < 0 ? -speed : speed) * DT;

    const sR = g0.slopeR;
    lateral += ((-G * sR) / Math.sqrt(1 + sR * sR)) * DT;
    const v2 = speed * speed + lateral * lateral;
    const latCap = CAR.driftGripAccel + (CAR.gripAccel * 1.5 - CAR.driftGripAccel) * grip;
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
  speed = clamp(speed, -15, 50);

  // Move in substeps, sliding along whatever we touch.
  let x = c.x;
  let z = c.z;
  vx = speed * fx + lateral * rx;
  vz = speed * fz + lateral * rz;
  const travel = Math.sqrt(vx * vx + vz * vz) * DT;
  const n = clamp(Math.ceil(travel / 0.3), 1, 6);
  const colY = c.y + 0.5;
  let touched = false;
  let impact = 0;
  let impactPerson = false;
  for (let i = 0; i < n; i++) {
    x += (vx * DT) / n;
    z += (vz * DT) / n;
    const res = resolveBox(world, { x, z, heading, hl: CAR.halfLength, hw: CAR.halfWidth }, colY, obstacles);
    if (!res.hit) continue;
    x = res.x;
    z = res.z;
    touched = true;
    const vn = vx * res.nx + vz * res.nz;
    if (vn < 0) {
      if (-vn > impact) {
        impact = -vn;
        impactPerson = res.person;
      }
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
      if ((delta < 0 ? -delta : delta) < 1.2) {
        heading = wrapAngle(heading + clamp(delta, -CAR.wallAlign * DT, CAR.wallAlign * DT));
        fx = dsin(heading);
        fz = -dcos(heading);
        rx = -fz;
        rz = fx;
      }
    }
  }
  speed = vx * fx + vz * fz;
  lateral = vx * rx + vz * rz;

  // Vertical: ballistic unless the ground holds the car up.
  const g1 = sampleGround(world, x, z, heading);
  const vyB = c.vy - G * DT;
  const yB = c.y + vyB * DT;
  let y: number;
  let vy: number;
  let landingSpeed = c.landingSpeed;
  const groundRate = (g1.h - g0.h) / DT;
  if (yB <= g1.h) {
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
  };
}
