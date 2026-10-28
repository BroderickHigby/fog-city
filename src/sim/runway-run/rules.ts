// Runway Run: the numbers and the pure money rules. One place to tune; the system (system.ts)
// only calls these. Money is whole dollars, time is ticks; nothing here reads a clock.

import { TICK_HZ } from "../contract.ts";
import { clamp } from "../dmath.ts";

export const RUNWAY_RULES = Object.freeze({
  /** Runway at the start, seconds. (Play-testing: 60 s ran out before the first investor was reached in SF's one-way streets.) */
  startS: 90,
  /** An investor waits this far from the player when chosen, metres (straight line). */
  pickupMinM: 150,
  pickupMaxM: 500,
  /** The demo is this far from the pickup, metres (straight line). */
  dropMinM: 300,
  dropMaxM: 1200,
  /** Pickup and drop: the car inside this radius, slower than this, for this many ticks. */
  stopRadiusM: 8,
  stopSpeedMps: 2,
  stopHoldTicks: TICK_HZ / 2,
  /** A check is this many dollars per `dollarsPerM` metres of pickup-to-demo distance. */
  dollars: 250_000,
  dollarsPerM: 300,
  /** Par pace, m/s: the trip time to beat for the speed bonus. */
  parMps: 12,
  /** The speed bonus reaches its best at a trip this fraction faster than par. */
  fastSpan: 0.5,
  /** Best speed bonus: the check doubles (1 + 1). */
  maxSpeedBonus: 1,
  /**
   * Time a check adds, seconds: a base, the trip's par time times this share, and up to
   * `addSpeedS` for speed. (Play-testing: the specced 10 s + up to 15 s cannot pay for a drive
   * that takes about a minute, so the check also returns the trip's par time.)
   */
  addBaseS: 10,
  addParShare: 1,
  addSpeedS: 15,
  /** Hype: +step per near miss while carrying, capped, easing back to 1 at this rate per second. */
  hypeStep: 0.1,
  hypeCap: 3,
  hypeDecayPerS: 0.02,
  /** A hard crash while carrying cuts the trip's check by this much, each time. */
  downRoundCut: 0.2,
  /** Hard means a change of velocity above this, m/s (impacts.ts ImpactEvent.dv). */
  downRoundDv: 4,
  /** One crash can log several events; count at most one per this many ticks. */
  downRoundGapTicks: TICK_HZ / 2,
  /** Hitting a person while carrying: the investor leaves and the clock loses this much, seconds. */
  scandalS: 5,
  /** Checks are rounded to this many dollars. */
  roundTo: 1000,
});

/** The stage ladder, best first: total raised (dollars) at or above `min` earns `title`. */
export const STAGES: readonly { readonly min: number; readonly title: string }[] = Object.freeze([
  { min: 1_000_000_000, title: "Unicorn" },
  { min: 100_000_000, title: "Series C" },
  { min: 20_000_000, title: "Series B" },
  { min: 5_000_000, title: "Series A" },
  { min: 1_000_000, title: "Seed" },
  { min: 0, title: "Pre-seed" },
]);

export function stageFor(raised: number): string {
  for (const s of STAGES) if (raised >= s.min) return s.title;
  return STAGES[STAGES.length - 1]!.title;
}

/** The par time for a trip, ticks. */
export function parTicks(distM: number): number {
  return Math.round(distM / RUNWAY_RULES.parMps * TICK_HZ);
}

/** How well a trip beat par: 0 (par or slower) .. 1 (the best bonus). */
export function speedFactor(distM: number, tripTicks: number): number {
  const par = parTicks(distM);
  if (par <= 0) return 0;
  return clamp((par - tripTicks) / (par * RUNWAY_RULES.fastSpan), 0, 1);
}

/** The check before hype and down rounds: scales with the straight-line distance. */
export function baseCheck(distM: number): number {
  return RUNWAY_RULES.dollars * distM / RUNWAY_RULES.dollarsPerM;
}

/**
 * The check for a finished trip, whole dollars. `speed` is speedFactor(); `hype` is the
 * multiplier at the drop; each down round cut 20% (compounding).
 */
export function checkDollars(distM: number, speed: number, hype: number, downRounds: number): number {
  let cut = 1;
  for (let i = 0; i < downRounds; i++) cut *= 1 - RUNWAY_RULES.downRoundCut;
  const raw = baseCheck(distM) * (1 + RUNWAY_RULES.maxSpeedBonus * speed) * hype * cut;
  return Math.max(0, Math.round(raw / RUNWAY_RULES.roundTo) * RUNWAY_RULES.roundTo);
}

/** Runway a check adds, ticks: a base, the trip's par time (share), and up to 15 s for speed. */
export function addedTicks(distM: number, speed: number): number {
  return Math.round(RUNWAY_RULES.addBaseS * TICK_HZ + RUNWAY_RULES.addParShare * parTicks(distM) + RUNWAY_RULES.addSpeedS * speed * TICK_HZ);
}

/** One tick of hype easing back toward 1. */
export function decayHype(hype: number): number {
  return Math.max(1, hype - RUNWAY_RULES.hypeDecayPerS / TICK_HZ);
}

/** Hype after `nearMisses` more near misses. */
export function addHype(hype: number, nearMisses: number): number {
  return Math.min(RUNWAY_RULES.hypeCap, hype + RUNWAY_RULES.hypeStep * nearMisses);
}
