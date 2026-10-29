// What the player's car and feet should sound like this frame, from the sim state the renderer
// draws. Pure and read-only: the procedural synth (vehicle-synth.ts) and the one-shots follow it.
//
// - Engine: a four-cylinder petrol engine, RPM from speed and throttle through five gears (early
//   upshifts when cruising, to the redline when pulling hard), louder and brighter under throttle.
//   The gearbox remembers its gear: a shift needs a margin (no hunting at a shift point), a gear is
//   held a moment, an upshift briefly cuts the power, and the throttle eases up faster than down.
// - Road and tyre roar: filtered noise, louder and brighter with speed, silent in the air.
// - Tyre squeal: lateral slip, lost grip, or hard braking at speed.
// - Impacts (a new hit) and landings (back on the ground after a jump), scaled by their speed.
// - Doors on getting in and out; footsteps on foot, paced by speed.

import type { CarState, FootState } from "../sim/contract.ts";

export interface EngineParams {
  /** Firing pulses per second (two per crank turn on a four-cylinder), Hz. */
  firingHz: number;
  engineGain: number;
  /** 0..1: how hard the engine is pulling (cut for a moment on an upshift); opens the exhaust filter. */
  throttle: number;
  /**
   * 0..1: how loaded the engine sounds: the pulling power plus the road and air load that holding
   * a speed takes. It picks between the synth's on-load and off-load firing loops.
   */
  load: number;
  /** Road noise low-pass cutoff, Hz. */
  roarCutoff: number;
  roarGain: number;
  squealGain: number;
}

export interface VehicleOneShot {
  sound: "impact" | "door-open" | "door-close";
  gain: number;
  /** Playback rate (heavier hits play lower). */
  rate?: number;
  /** Start this many seconds from now (a door shuts after it opens). */
  delayS?: number;
  /** A landing rather than a collision. */
  landing?: true;
}

export const IDLE_RPM = 850;
export const REDLINE_RPM = 5800;
/** Each gear's top speed, m/s: the engine reaches REDLINE_RPM there. */
export const GEAR_TOP_MPS = [10, 18, 27, 37, 58] as const;
/** Upshift point: early when cruising (about 3000 rpm at 30 m/s), at the redline when pulling hard. */
export const CRUISE_SHIFT_RPM = 3200;
export const MAX_SPEED_MPS = 32;

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Under this road speed the car is at a stop: the next pull-away starts in first, even after a hard stop from top gear. */
export const LAUNCH_MPS = 0.5;
/** A gear is kept at least this long after any shift, s. */
export const GEAR_HOLD_S = 0.65;
/** An upshift cuts the power for this long, s. */
export const UPSHIFT_DIP_S = 0.16;
/** The throttle the engine still shows while the power is cut. */
export const DIP_THROTTLE = 0.06;
/** The throttle follows the pedal up faster than it lets go (time constants, s). */
export const THROTTLE_RISE_S = 0.14;
export const THROTTLE_FALL_S = 0.32;
/** Hysteresis: a downshift needs the lower gear to land this share of the shift point or less. */
export const DOWNSHIFT_BAND = 0.82;
/** An engine below this rpm is lugging and drops a gear (once the band allows it). */
export const LUG_RPM = 1900;
/**
 * Under this, or at the redline, with the right gear two or more away, the hold gives way: a crash
 * or a teleport changes the road speed by more than a gear at once, and the box goes straight to
 * the gear the stateless pick says instead of lugging (or screaming) through one shift per hold.
 * A one-gear step always waits out the hold.
 */
export const RESCUE_RPM = 1400;
/** Kick-down: pulling hard (throttle above KICKDOWN_THROTTLE) in a gear under this share of the shift point drops a gear. */
export const KICKDOWN_THROTTLE = 0.65;
export const KICKDOWN_BAND = 0.55;

const LAST_GEAR = GEAR_TOP_MPS.length - 1;

/** The rpm a gear would turn at a road speed, before the idle floor and the redline. */
const gearRpm = (gear: number, speedMps: number): number => (REDLINE_RPM * speedMps) / GEAR_TOP_MPS[gear]!;
/** The rpm where the next gear is wanted: early when cruising, the redline when pulling hard. */
const shiftRpm = (throttle: number): number => CRUISE_SHIFT_RPM + (REDLINE_RPM - CRUISE_SHIFT_RPM) * throttle;
const clampRpm = (rpm: number): number => Math.max(IDLE_RPM, Math.min(REDLINE_RPM, rpm));

/** The lowest gear (0-based) that stays under the shift point at a road speed and throttle: where a gearbox with no history sits. */
export function pickGear(speedMps: number, throttle = 1): number {
  const v = Math.abs(speedMps);
  const shift = shiftRpm(throttle);
  const gear = GEAR_TOP_MPS.findIndex((_, g) => gearRpm(g, v) <= shift);
  return gear < 0 ? LAST_GEAR : gear;
}

/** Engine speed at a road speed and throttle (0..1) with no gear history: the lowest gear under the shift point, never under idle. */
export function engineRpm(speedMps: number, throttle = 1): number {
  const v = Math.abs(speedMps);
  return clampRpm(gearRpm(pickGear(v, throttle), v));
}

/** What the gearbox remembers from frame to frame. Plain data: `stepGearbox` returns a new one. */
export interface Gearbox {
  /** The current gear, 0-based (0 is first). */
  gear: number;
  /** Seconds before the next shift is allowed. */
  holdS: number;
  /** Seconds of upshift power cut left. */
  dipS: number;
  /** The throttle after smoothing, 0..1. */
  throttle: number;
}

/** A gearbox for an engine just heard for the first time: it sits where the stateless pick says. */
export function settleGearbox(speedMps: number, throttle: number): Gearbox {
  const t = clamp01(throttle);
  return { gear: pickGear(speedMps, t), holdS: 0, dipS: 0, throttle: t };
}

/**
 * One frame of the gearbox. Pure: the road speed (m/s), the throttle the pedal asks for (0..1)
 * and the frame time give the next state.
 *
 * - The throttle is smoothed, rising faster than it falls.
 * - Under LAUNCH_MPS the car is stopped and the box goes back to first at once.
 * - Otherwise a shift needs the hold over (GEAR_HOLD_S after the last one). Up: the gear is past
 *   the shift point. Down: the lower gear would land under DOWNSHIFT_BAND of the shift point, and
 *   the engine is lugging or the pedal is down (kick-down). The band is the hysteresis: a shift
 *   up never puts the lower gear in range to shift straight back.
 * - An upshift also cuts the power for UPSHIFT_DIP_S.
 */
export function stepGearbox(box: Gearbox, speedMps: number, throttleAsked: number, dtS: number): Gearbox {
  // A non-finite frame (never sent today: the director clamps dt) must not stick in the box.
  const v = Number.isFinite(speedMps) ? Math.abs(speedMps) : 0;
  const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0;
  const asked = Number.isFinite(throttleAsked) ? clamp01(throttleAsked) : 0;
  const prev = Number.isFinite(box.throttle) ? box.throttle : asked;
  const throttle = prev + (asked - prev) * (1 - Math.exp(-dt / (asked > prev ? THROTTLE_RISE_S : THROTTLE_FALL_S)));
  let { gear } = box;
  let holdS = Math.max(0, box.holdS - dt);
  let dipS = Math.max(0, box.dipS - dt);
  if (v < LAUNCH_MPS) return { gear: 0, holdS: 0, dipS: 0, throttle };
  const now = gearRpm(gear, v);
  if (holdS > 0 && (now < RESCUE_RPM || now >= REDLINE_RPM)) {
    const target = pickGear(v, throttle);
    if (Math.abs(target - gear) >= 2) return { gear: target, holdS: GEAR_HOLD_S, dipS: 0, throttle };
  }
  if (holdS === 0) {
    const shift = shiftRpm(throttle);
    const rpm = gearRpm(gear, v);
    let next = gear;
    if (gear < LAST_GEAR && rpm > shift) next = gear + 1;
    else if (gear > 0 && gearRpm(gear - 1, v) < DOWNSHIFT_BAND * shift && (rpm < LUG_RPM || (throttle > KICKDOWN_THROTTLE && rpm < KICKDOWN_BAND * shift))) next = gear - 1;
    if (next !== gear) {
      holdS = GEAR_HOLD_S;
      if (next > gear) dipS = UPSHIFT_DIP_S;
      gear = next;
    }
  }
  return { gear, holdS, dipS, throttle };
}

/** The engine's rpm in the gearbox's gear, never under idle or over the redline (the limiter, when a hold keeps a low gear). */
export function gearboxRpm(box: Gearbox, speedMps: number): number {
  return clampRpm(gearRpm(box.gear, Math.abs(speedMps)));
}

/** How hard the engine pulls now: the smoothed throttle, cut to almost nothing while an upshift's dip lasts. */
export function enginePower(box: Gearbox): number {
  return box.dipS > 0 ? Math.min(box.throttle, DIP_THROTTLE) : box.throttle;
}

/** The throttle the pedal is taken to ask for, from the car's acceleration (m/s²). */
const throttleOfAccel = (accel: number): number => clamp01(accel / 4);

/** Acceleration (m/s²) of the road speed over a frame; zero with no previous frame or no time. */
function accelOf(speed: number, prevSpeed: number | null, dtS: number): number {
  return prevSpeed !== null && dtS > 0 ? (Math.abs(speed) - Math.abs(prevSpeed)) / dtS : 0;
}

/**
 * The engine and road layers at a speed, with the gearbox's gear and power and `cabin` scaling the
 * level. `accel` (m/s²) tells holding a speed (the engine works against the road and the air)
 * from coasting (the wheels turn the engine, which then sounds unloaded).
 */
function layers(speed: number, box: Gearbox, grounded: boolean, cabin: number, accel: number): Omit<EngineParams, "squealGain"> {
  const s = clamp01(speed / MAX_SPEED_MPS);
  const throttle = enginePower(box);
  const rpm = gearboxRpm(box, speed);
  // Idle: a low burble. Revving and pulling: a little louder; the road takes over at speed.
  const engineGain = (0.045 + 0.05 * ((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)) + 0.04 * throttle) * cabin;
  return {
    firingHz: (rpm / 60) * 2,
    engineGain,
    throttle,
    load: clamp01(0.85 * throttle + 0.3 * Math.pow(s, 1.5) * clamp01(1 + (Number.isFinite(accel) ? accel : 0) / 0.6)),
    roarCutoff: 220 + 30 * speed,
    roarGain: grounded ? 0.08 * Math.pow(s, 1.3) * cabin : 0,
  };
}

/**
 * The continuous engine and road layers for a car this frame (`prev` a frame earlier). `gears` is
 * the gearbox already stepped to this frame (EngineClock keeps it); without one the engine has no
 * history and sits where `settleGearbox` puts it.
 */
export function engineParams(car: CarState, prev: CarState | null, dtS: number, gears?: Gearbox): EngineParams {
  const speed = Math.abs(car.speed);
  const accel = accelOf(car.speed, prev ? prev.speed : null, dtS);
  const slip = clamp01((Math.abs(car.lateral) - 0.8) / 4);
  const gripLoss = clamp01((0.85 - car.grip) / 0.6);
  const braking = speed > 7 && accel < -7 ? clamp01((-accel - 7) / 6) : 0;
  const squealGain = car.grounded && speed > 3 ? 0.25 * Math.max(slip, gripLoss, braking) : 0;
  return { ...layers(speed, gears ?? settleGearbox(speed, throttleOfAccel(accel)), car.grounded, 1, accel), squealGain };
}

/** Riding in the back of a robotaxi: its engine and road, softer from the rear seat; it never squeals. */
export const RIDE_CABIN = 0.6;

export function rideEngineParams(speed: number, prevSpeed: number | null, dtS: number, gears?: Gearbox): EngineParams {
  const v = Math.abs(speed);
  const accel = accelOf(speed, prevSpeed, dtS);
  return { ...layers(v, gears ?? settleGearbox(v, throttleOfAccel(accel)), true, RIDE_CABIN, accel), squealGain: 0 };
}

/** What the engine shows now, for the debug panel and tests. */
export interface EngineReading {
  /** 1 for first. */
  gear: number;
  rpm: number;
  /** The smoothed throttle, before the upshift cut. */
  throttle: number;
  /** An upshift's power cut is on. */
  dip: boolean;
}

/**
 * The engine the player hears, across frames: keeps the gearbox, so the gear does not hunt.
 * `owner` names whose engine it is (the player's car, a taxi they drive or ride in); a new
 * owner starts a fresh gearbox, and so does `stop` (on foot, no engine).
 */
export class EngineClock {
  private box: Gearbox | null = null;
  private owner: string | null = null;
  private last: EngineReading | null = null;

  /** The player's car, or a taxi they drive. */
  car(owner: string, car: CarState, prev: CarState | null, dtS: number): EngineParams {
    const speed = Math.abs(car.speed);
    const box = this.step(owner, speed, prev ? prev.speed : null, dtS);
    return engineParams(car, prev, dtS, box);
  }

  /** A robotaxi the player rides in the back of. */
  ride(owner: string, speed: number, prevSpeed: number | null, dtS: number): EngineParams {
    const box = this.step(owner, Math.abs(speed), prevSpeed, dtS);
    return rideEngineParams(speed, prevSpeed, dtS, box);
  }

  /** No engine is heard: forget the gearbox. */
  stop(): null {
    this.box = null;
    this.owner = null;
    this.last = null;
    return null;
  }

  reading(): EngineReading | null {
    return this.last;
  }

  private step(owner: string, speed: number, prevSpeed: number | null, dtS: number): Gearbox {
    const asked = throttleOfAccel(accelOf(speed, prevSpeed, dtS));
    const box = this.box && this.owner === owner ? stepGearbox(this.box, speed, asked, dtS) : settleGearbox(speed, asked);
    this.box = box;
    this.owner = owner;
    this.last = { gear: box.gear + 1, rpm: gearboxRpm(box, speed), throttle: box.throttle, dip: box.dipS > 0 };
    return box;
  }
}

/** Impacts and landings since the previous frame. */
export function carOneShots(car: CarState, prev: CarState | null): VehicleOneShot[] {
  if (!prev) return [];
  const out: VehicleOneShot[] = [];
  if (car.hits > prev.hits) {
    const v = clamp01(car.impactSpeed / 14);
    // Harder hits are louder and a little lower.
    out.push({ sound: "impact", gain: 0.25 + 0.75 * v, rate: 1.15 - 0.3 * v });
  }
  if (car.grounded && !prev.grounded && car.landingSpeed > 1.5) {
    const v = clamp01(car.landingSpeed / 8);
    out.push({ sound: "impact", gain: 0.15 + 0.5 * v, rate: 0.75, landing: true });
  }
  return out;
}

/** Doors when the player gets in or out: open, then shut a moment later. */
export function doorOneShots(prevMode: string | undefined, mode: string | undefined): VehicleOneShot[] {
  if (!prevMode || !mode || prevMode === mode) return [];
  if ((prevMode === "vehicle" && mode === "foot") || (prevMode === "foot" && mode === "vehicle"))
    return [{ sound: "door-open", gain: 0.8, delayS: 0 }, { sound: "door-close", gain: 0.9, delayS: mode === "vehicle" ? 0.55 : 0.75 }];
  return [];
}

export type Pace = "still" | "walk" | "jog" | "sprint";

/** Walking pace from the walker's state. */
export function pace(foot: FootState): Pace {
  const v = Math.abs(foot.speed);
  if (!foot.grounded || v < 0.3) return "still";
  if (foot.sprint || v > 4.5) return "sprint";
  return v > 2.2 ? "jog" : "walk";
}

/** Seconds between steps at a pace (heel strikes, either foot). */
export const STEP_INTERVAL_S: Readonly<Record<Exclude<Pace, "still">, number>> = { walk: 0.52, jog: 0.36, sprint: 0.28 };
export const STEP_GAIN: Readonly<Record<Exclude<Pace, "still">, number>> = { walk: 0.35, jog: 0.5, sprint: 0.65 };

/** Paces footsteps: call each frame; returns a step to play (variant 1..4) or null. */
export class FootstepClock {
  private untilNextS = 0;
  private variant = 0;
  private wasStill = true;

  update(foot: FootState | null, dtS: number): { variant: 1 | 2 | 3 | 4; gain: number } | null {
    const p = foot ? pace(foot) : "still";
    if (p === "still") {
      this.wasStill = true;
      return null;
    }
    // The first step lands promptly when setting off.
    if (this.wasStill) {
      this.wasStill = false;
      this.untilNextS = 0.12;
    }
    this.untilNextS -= dtS;
    if (this.untilNextS > 0) return null;
    this.untilNextS += STEP_INTERVAL_S[p];
    if (this.untilNextS < 0) this.untilNextS = STEP_INTERVAL_S[p];
    // Cycle the four recordings without an immediate repeat.
    this.variant = (this.variant % 4) + 1;
    return { variant: this.variant as 1 | 2 | 3 | 4, gain: STEP_GAIN[p] };
  }

  reset(): void {
    this.untilNextS = 0;
    this.wasStill = true;
  }
}
