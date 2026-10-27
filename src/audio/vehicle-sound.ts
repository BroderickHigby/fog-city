// What the player's car and feet should sound like this frame, from the sim state the renderer
// draws. Pure and read-only: the procedural synth (vehicle-synth.ts) and the one-shots follow it.
//
// - Engine: a four-cylinder petrol engine, RPM from speed through five gears (it drops on each
//   upshift), firing pulses louder and brighter under throttle.
// - Road and tyre roar: filtered noise, louder and brighter with speed, silent in the air.
// - Tyre squeal: lateral slip, lost grip, or hard braking at speed.
// - Impacts (a new hit) and landings (back on the ground after a jump), scaled by their speed.
// - Doors on getting in and out; footsteps on foot, paced by speed.

import type { CarState, FootState } from "../sim/contract.ts";

export interface EngineParams {
  /** Firing pulses per second (two per crank turn on a four-cylinder), Hz. */
  firingHz: number;
  engineGain: number;
  /** 0..1: how hard the engine is pulling; opens the exhaust filter. */
  throttle: number;
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
/** Each gear's top speed, m/s: the engine reaches REDLINE_RPM there and shifts up. */
export const GEAR_TOP_MPS = [8, 15, 22, 29, 40] as const;
export const MAX_SPEED_MPS = 32;

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Engine speed at a road speed: the lowest gear that is not past its top, never under idle. */
export function engineRpm(speedMps: number): number {
  const v = Math.abs(speedMps);
  const top = GEAR_TOP_MPS.find((t) => v <= t) ?? GEAR_TOP_MPS[GEAR_TOP_MPS.length - 1]!;
  return Math.max(IDLE_RPM, Math.min(REDLINE_RPM, (REDLINE_RPM * v) / top));
}

/** The engine and road layers at a speed, with `accel` (m/s²) as the throttle and `cabin` scaling the level. */
function layers(speed: number, accel: number, grounded: boolean, cabin: number): Omit<EngineParams, "squealGain"> {
  const s = clamp01(speed / MAX_SPEED_MPS);
  const throttle = clamp01(accel / 4);
  const rpm = engineRpm(speed);
  // Idle: a low burble. Revving and pulling: a little louder; the road takes over at speed.
  const engineGain = (0.045 + 0.05 * ((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)) + 0.04 * throttle) * cabin;
  return {
    firingHz: (rpm / 60) * 2,
    engineGain,
    throttle,
    roarCutoff: 220 + 30 * speed,
    roarGain: grounded ? 0.08 * Math.pow(s, 1.3) * cabin : 0,
  };
}

/** The continuous engine and road layers for a car this frame (`prev` a frame earlier). */
export function engineParams(car: CarState, prev: CarState | null, dtS: number): EngineParams {
  const speed = Math.abs(car.speed);
  const accel = prev && dtS > 0 ? (Math.abs(car.speed) - Math.abs(prev.speed)) / dtS : 0;
  const slip = clamp01((Math.abs(car.lateral) - 0.8) / 4);
  const gripLoss = clamp01((0.85 - car.grip) / 0.6);
  const braking = speed > 7 && accel < -7 ? clamp01((-accel - 7) / 6) : 0;
  const squealGain = car.grounded && speed > 3 ? 0.25 * Math.max(slip, gripLoss, braking) : 0;
  return { ...layers(speed, accel, car.grounded, 1), squealGain };
}

/** Riding in the back of a robotaxi: its engine and road, softer from the rear seat; it never squeals. */
export const RIDE_CABIN = 0.6;

export function rideEngineParams(speed: number, prevSpeed: number | null, dtS: number): EngineParams {
  const accel = prevSpeed !== null && dtS > 0 ? (Math.abs(speed) - Math.abs(prevSpeed)) / dtS : 0;
  return { ...layers(Math.abs(speed), accel, true, RIDE_CABIN), squealGain: 0 };
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
