// Visual body motion for vehicles: squat under throttle, dive under the brakes, lean out of a
// corner, a bob on a landing and a jolt on a hit. RENDER ONLY: this reads the sim's CarState and
// never writes it; the car's pose, speed and collisions are untouched. The spring is mrdoob's
// Slop New York chassis spring (MIT; js/controllers.js:1150-1157 and 953-955, js/traffic.js:
// 1117-1122; licence at assets/imports/slop-new-york/LICENSE.md), re-timed to be frame-rate
// independent: instead of one Euler step per frame, each frame advances the damped spring by its
// exact solution for the frame's dt, so the feel is the same at 30, 60 or 144 fps.
//
// Conventions (the car's, render/actors.ts CarPose): pitch + = nose up, roll + = right side down,
// heave + = body up (metres). The accelerations that drive it are m/s^2 in the car's frame:
// aLong + = speeding up forward, aLat + = turning right (the car leans left, roll < 0).

import type { CarState } from "../sim/contract.ts";

/** The exact transition of an underdamped spring x'' = k (target - x) - c x' over `dt`, on e = x - target. */
export interface SpringCoeffs { a11: number; a12: number; a21: number; a22: number }

/**
 * Coefficients for one (stiffness, damping) pair, cached for the last dt: every car in a frame
 * shares the same spring and the same dt, so a fleet pays one exp/sin/cos per frame, not per car.
 */
export class SpringStepper {
  private lastDt = -1;
  private readonly co: SpringCoeffs = { a11: 1, a12: 0, a21: 0, a22: 1 };
  readonly stiffness: number;
  readonly damping: number;
  /** Damped frequency squared must stay positive: the spring rings (zeta < 1), as Slop's does. */
  constructor(stiffness: number, damping: number) {
    if (!(stiffness > (damping * damping) / 4)) throw new Error("SpringStepper: the spring must be underdamped");
    this.stiffness = stiffness;
    this.damping = damping;
  }

  coeffs(dt: number): SpringCoeffs {
    if (dt === this.lastDt) return this.co;
    this.lastDt = dt;
    const a = this.damping / 2, k = this.stiffness, b = Math.sqrt(k - a * a);
    const e = Math.exp(-a * dt), c = Math.cos(b * dt), s = Math.sin(b * dt);
    const co = this.co;
    co.a11 = e * (c + (a / b) * s);
    co.a12 = (e * s) / b;
    co.a21 = -((e * k) / b) * s;
    co.a22 = e * (c - (a / b) * s);
    return co;
  }
}

/** One spring axis: position and velocity. */
export interface Axis { x: number; v: number }

/** Move `axis` toward `target` by one exact step. */
export function advanceAxis(axis: Axis, target: number, co: SpringCoeffs): void {
  const e = axis.x - target;
  axis.x = target + co.a11 * e + co.a12 * axis.v;
  axis.v = co.a21 * e + co.a22 * axis.v;
}

/** Slop's chassis springs: pitch and roll (stiffness 68, damping 11.2), heave (85, 12). */
export const TILT_SPRING = new SpringStepper(68, 11.2);
export const HEAVE_SPRING = new SpringStepper(85, 12);

/** How hard a vehicle's body moves. */
export interface BodyTune {
  /** Target pitch per m/s^2 of forward acceleration, rad (nose up when speeding up), and its cap. */
  pitchPerAccel: number;
  pitchMax: number;
  /** Target roll per m/s^2 of rightward acceleration, rad (leans away from the turn), and its cap. */
  rollPerAccel: number;
  rollMax: number;
  /** The accelerations that count, m/s^2: a one-tick spike from a collision is the kick's job. */
  accelCap: number;
  /** Time constant of the acceleration filter, s (smooths tick steps and frame jitter). */
  accelTau: number;
  /** Hard limits on what the spring may reach: pitch/roll rad, heave m (down, up). */
  pitchLimit: number;
  rollLimit: number;
  heaveDown: number;
  heaveUp: number;
  /** Landing: heave velocity lost per m/s fallen (m/s), its cap, and the nose-down pitch velocity per m/s. */
  landHeave: number;
  landHeaveMax: number;
  landPitch: number;
  /** A hit: pitch/roll velocity per m/s of closing speed (rad/s) along the travel, heave velocity per m/s, caps. */
  hitPitch: number;
  hitRoll: number;
  hitHeave: number;
  hitHeaveMax: number;
  hitSpeedMax: number;
  /** A fall or hit shorter than this (m/s) is not felt. */
  feltSpeed: number;
}

/**
 * The player's car. Slop tilts 0.026 rad at 4.5 m/s^2 (1.5 degrees: a chassis you barely see from
 * a chase camera); Fog City's car does 6 m/s^2 flat out and 11 under the brakes and is watched
 * from 7 m behind, so the same spring is driven about 3x harder: 0.054 rad (3 degrees) at full
 * throttle, the 0.075 rad cap under hard braking, and Slop's own 0.09 rad roll cap at 9 m/s^2
 * across. Either cap alone fits the model's 0.22 m of ground clearance (lowestDrop); both at once
 * (a hard brake into a hard corner) would, so the renderer lifts the body just enough there
 * (minHeave) rather than letting it touch the road.
 */
export const CAR_BODY: BodyTune = {
  pitchPerAccel: 0.009,
  pitchMax: 0.075,
  rollPerAccel: 0.01,
  rollMax: 0.09,
  accelCap: 12,
  accelTau: 0.05,
  pitchLimit: 0.16,
  rollLimit: 0.16,
  heaveDown: -0.09,
  heaveUp: 0.14,
  landHeave: 0.17,
  landHeaveMax: 2.2,
  landPitch: 0.03,
  hitPitch: 0.1,
  hitRoll: 0.12,
  hitHeave: 0.11,
  hitHeaveMax: 1.4,
  hitSpeedMax: 14,
  feltSpeed: 1.5,
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The three springs of one body, plus the kicks that set them off. */
export class BodySpring {
  readonly pitch: Axis = { x: 0, v: 0 };
  readonly roll: Axis = { x: 0, v: 0 };
  readonly heave: Axis = { x: 0, v: 0 };
  readonly tune: BodyTune;

  constructor(tune: BodyTune = CAR_BODY) {
    this.tune = tune;
  }

  /** Advance by `dt` seconds toward the pitch and roll the accelerations (m/s^2, car frame) ask for. */
  step(dt: number, aLong: number, aLat: number): void {
    if (!(dt > 0)) return;
    const t = this.tune;
    const tilt = TILT_SPRING.coeffs(dt), bob = HEAVE_SPRING.coeffs(dt);
    advanceAxis(this.pitch, clamp(aLong * t.pitchPerAccel, -t.pitchMax, t.pitchMax), tilt);
    advanceAxis(this.roll, clamp(-aLat * t.rollPerAccel, -t.rollMax, t.rollMax), tilt);
    advanceAxis(this.heave, 0, bob);
    this.limit(this.pitch, t.pitchLimit, t.pitchLimit);
    this.limit(this.roll, t.rollLimit, t.rollLimit);
    this.limit(this.heave, -t.heaveDown, t.heaveUp);
  }

  /** Add to the spring velocities: rad/s for pitch and roll, m/s for heave. */
  kick(pitchVel: number, rollVel: number, heaveVel: number): void {
    this.pitch.v = clamp(this.pitch.v + pitchVel, -2.2, 2.2);
    this.roll.v = clamp(this.roll.v + rollVel, -2.2, 2.2);
    this.heave.v = clamp(this.heave.v + heaveVel, -2.4, 2.4);
  }

  /** Wheels touch down after a fall of `speed` m/s: the body settles on its springs. */
  land(speed: number): void {
    const t = this.tune;
    if (speed < t.feltSpeed) return;
    this.kick(-Math.min(0.25, speed * t.landPitch), 0, -Math.min(t.landHeaveMax, speed * t.landHeave));
  }

  /**
   * A hit at `speed` m/s closing. (fwd, right) is the unit direction the car was travelling in its
   * own frame; the jolt pushes against it: a frontal hit dives the nose, a side-on hit rolls the
   * body away from the wall, and any hit bounces the body up.
   */
  hit(speed: number, fwd: number, right: number, weight = 1): void {
    const t = this.tune;
    if (speed < t.feltSpeed) return;
    const s = Math.min(t.hitSpeedMax, speed) * weight;
    this.kick(-fwd * s * t.hitPitch, right * s * t.hitRoll, Math.min(t.hitHeaveMax, s * t.hitHeave));
  }

  reset(): void {
    this.pitch.x = this.pitch.v = this.roll.x = this.roll.v = this.heave.x = this.heave.v = 0;
  }

  private limit(a: Axis, lo: number, hi: number): void {
    if (a.x > hi) { a.x = hi; if (a.v > 0) a.v = 0; }
    else if (a.x < -lo) { a.x = -lo; if (a.v < 0) a.v = 0; }
  }
}

/**
 * How far the lowest corner of a body box (half length `hl`, half width `hw`) sinks when it is
 * pitched and rolled by these angles, metres. Small-angle exact for the worst corner.
 */
export function lowestDrop(pitch: number, roll: number, hl: number, hw: number): number {
  return hl * Math.abs(Math.sin(pitch)) + hw * Math.abs(Math.sin(roll));
}

/**
 * The least heave that keeps the body's lowest point `margin` above the road, given `clearance`
 * (metres from the road to the body's underside at rest). A tilt alone that fits returns -Infinity.
 */
export function minHeave(pitch: number, roll: number, hl: number, hw: number, clearance: number, margin: number): number {
  return lowestDrop(pitch, roll, hl, hw) - (clearance - margin);
}

/** The acceleration filter's state: the last sample and the smoothed result. */
export interface AccelState {
  has: boolean;
  speed: number;
  lateral: number;
  aLong: number;
  aLat: number;
}

export function newAccel(): AccelState {
  return { has: false, speed: 0, lateral: 0, aLong: 0, aLat: 0 };
}

let gainDt = -1, gainTau = -1, gainK = 0;
/** 1 - exp(-dt / tau), cached for the last (dt, tau): a fleet of cars shares one dt per frame. */
function accelGain(dt: number, tau: number): number {
  if (dt !== gainDt || tau !== gainTau) { gainDt = dt; gainTau = tau; gainK = 1 - Math.exp(-dt / tau); }
  return gainK;
}

/**
 * Longitudinal and lateral acceleration from two successive frames' (interpolated) speed and
 * sideways speed, plus the centripetal term speed * yawRate: what the tyres actually pushed with
 * (body-frame a = dv/dt + omega x v). Low-passed with the tune's time constant, capped, and
 * independent of the frame rate: a tick step or a jittery dt averages out.
 */
export function updateAccel(s: AccelState, dt: number, speed: number, lateral: number, yawRate: number, tune: BodyTune): void {
  if (!s.has || !(dt > 0)) {
    s.has = true;
    s.speed = speed;
    s.lateral = lateral;
    return;
  }
  const d = Math.max(dt, 1 / 240);
  const rawLong = (speed - s.speed) / d;
  const rawLat = (lateral - s.lateral) / d + speed * yawRate;
  s.speed = speed;
  s.lateral = lateral;
  const k = accelGain(dt, tune.accelTau);
  s.aLong += (clamp(rawLong, -tune.accelCap, tune.accelCap) - s.aLong) * k;
  s.aLat += (clamp(rawLat, -tune.accelCap, tune.accelCap) - s.aLat) * k;
}

/** What the driver reads from the sim each frame: continuous values interpolated, counters from the newest tick. */
export type BodyFeel = Pick<CarState, "speed" | "lateral" | "yawRate" | "grounded" | "hits" | "personBumps" | "impactSpeed" | "landingSpeed">;

/**
 * One car's body motion: accelerations from successive frames, kicks from the sim's own event
 * fields (hits, landings), one BodySpring. `feel` is read, never kept; nothing is written back.
 */
export class CarBodyMotion {
  readonly spring: BodySpring;
  private readonly accel = newAccel();
  private seen = false;
  private grounded = true;
  private hits = 0;
  private personBumps = 0;
  private landingSpeed = 0;

  constructor(tune: BodyTune = CAR_BODY) {
    this.spring = new BodySpring(tune);
  }

  /** The car was placed somewhere new (a respawn): no motion carries over. */
  reset(): void {
    this.spring.reset();
    this.accel.has = false;
    this.accel.aLong = this.accel.aLat = 0;
    this.seen = false;
  }

  update(dt: number, feel: BodyFeel): void {
    if (!(dt > 0)) return;
    const tune = this.spring.tune;
    if (this.seen) {
      // The direction it was travelling (its own frame) before this frame, for the jolt.
      const vf = this.accel.speed, vr = this.accel.lateral, vm = Math.hypot(vf, vr);
      const fwd = vm > 0.5 ? vf / vm : 0, right = vm > 0.5 ? vr / vm : 0;
      if (feel.hits > this.hits) this.spring.hit(feel.impactSpeed, fwd, right);
      else if (feel.personBumps > this.personBumps) this.spring.hit(feel.impactSpeed, fwd, right, 0.35);
      if ((feel.grounded && !this.grounded) || feel.landingSpeed !== this.landingSpeed) this.spring.land(feel.landingSpeed);
    }
    this.seen = true;
    this.grounded = feel.grounded;
    this.hits = feel.hits;
    this.personBumps = feel.personBumps;
    this.landingSpeed = feel.landingSpeed;
    updateAccel(this.accel, dt, feel.speed, feel.lateral, feel.yawRate, tune);
    // In the air no tyre pushes: the body floats where it was.
    this.spring.step(dt, feel.grounded ? this.accel.aLong : 0, feel.grounded ? this.accel.aLat : 0);
  }
}

/**
 * Ambient traffic and robotaxis: the same spring, lighter (Slop's traffic.js:1117-1122 uses 0.008 rad
 * per m/s^2 pitch and 0.01 roll with caps of 0.22 and 0.26; a car 30 m off needs a hint, and the
 * whole vehicle tilts, wheels included, so the caps keep an axle's dip or float under 5 cm). Pitch and roll
 * only: a driving agent has no hit or landing events to kick the body with.
 */
export const TRAFFIC_BODY: BodyTune = {
  ...CAR_BODY,
  pitchPerAccel: 0.006,
  pitchMax: 0.035,
  rollPerAccel: 0.007,
  rollMax: 0.05,
  accelCap: 8,
  accelTau: 0.08,
};

/** The fastest a drawn heading may turn and still count as driving (rad/s): more is a respawn or a spin. */
const LEAN_YAW_CAP = 2.5;
const TWO_PI = Math.PI * 2;

/**
 * One ambient vehicle's lean, from what the renderer already has: its drawn speed and heading each
 * frame. Pitch from the change of speed, roll from speed times the change of heading.
 */
export class TrafficLean {
  readonly spring: BodySpring;
  private readonly accel = newAccel();
  private heading = 0;
  private has = false;
  /** The frame it was last stepped (the layer's pruning clock). */
  seen = 0;

  constructor(tune: BodyTune = TRAFFIC_BODY) {
    this.spring = new BodySpring(tune);
  }

  /** The vehicle jumped (a respawn) or was out of sight: it starts level. */
  reset(): void {
    this.spring.reset();
    this.accel.has = false;
    this.accel.aLong = this.accel.aLat = 0;
    this.has = false;
  }

  /** `speed` m/s along the car (signed), `heading` compass radians, both as drawn this frame. */
  update(dt: number, speed: number, heading: number): void {
    if (!(dt > 0)) return;
    let yawRate = 0;
    if (this.has) {
      let dh = heading - this.heading;
      dh -= Math.round(dh / TWO_PI) * TWO_PI;
      yawRate = Math.max(-LEAN_YAW_CAP, Math.min(LEAN_YAW_CAP, dh / dt));
    }
    this.heading = heading;
    this.has = true;
    const tune = this.spring.tune;
    updateAccel(this.accel, dt, speed, 0, yawRate, tune);
    this.spring.step(dt, this.accel.aLong, this.accel.aLat);
  }
}
