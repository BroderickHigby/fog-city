// Signal-timing search: choose a cycle length, Lombard's green at each signal and the offsets,
// to cut the hours everyone loses waiting, on Lombard and on the cross streets alike (so it
// cannot win by starving the side streets). Plain coordinate descent over a deterministic
// model; the result is then checked on seeds it never saw.
import type { Corridor } from "./corridor.ts";
import type { Demand } from "./demand.ts";
import { LOST_PER_CYCLE_S, MIN_CROSS_GREEN_S, MIN_MAIN_GREEN_S, greenWavePlan, splitGreens, type FixedPlan } from "./signals.ts";
import { CROSS_SAT_PER_S, runScenario, type Metrics } from "./traffic.ts";

export interface OptimizeOptions {
  cycles?: readonly number[];
  offsetStepS?: number;
  greenStepS?: number;
  sweeps?: number;
  seed?: number;
  durationS?: number;
  /** Kilograms of CO2 counted as one hour of delay in the objective (0: delay only). */
  co2KgPerDelayHour?: number;
  progress?: (note: string) => void;
}

export function objective(m: Metrics, co2Weight = 0): number {
  return m.delayHoursPerHour.main + m.delayHoursPerHour.cross + (co2Weight > 0 ? m.co2KgPerHour.total / co2Weight : 0);
}

/** Lombard's saturation flow per lane in this model (scripts/planner/satflow.ts measures it). */
export const LOMBARD_SAT_PER_LANE_H = 1577;

/** Greens split by each signal's critical flow ratios, for a cycle length. */
export function volumeGreens(c: Corridor, d: Demand, cycleS: number): number[] {
  const main = c.signals.map((_, i) => Math.max(d.linkFlow[0][i]!, d.linkFlow[1][i]!) / c.lanesPerDirection / LOMBARD_SAT_PER_LANE_H);
  // Both cross approaches run together; the busier one sets the need (assume a 60/40 split).
  const cross = d.crossRate.map((r, i) => r * 0.6 / Math.max(1, c.signals[i]!.crossLanes / 2) / (CROSS_SAT_PER_S * 3600));
  return splitGreens(cycleS, main, cross);
}

export function optimizePlan(c: Corridor, d: Demand, opts: OptimizeOptions = {}): { plan: FixedPlan; score: number; evaluations: number } {
  const cycles = opts.cycles ?? [60, 70, 80, 90, 100, 110, 120];
  const step = opts.offsetStepS ?? 4, gStep = opts.greenStepS ?? 4, sweeps = opts.sweeps ?? 2;
  const run = { seed: opts.seed ?? 1, warmupS: 300, durationS: opts.durationS ?? 1200 };
  let evaluations = 0;
  const score = (p: FixedPlan): number => { evaluations++; return objective(runScenario(c, d, p, run), opts.co2KgPerDelayHour ?? 0); };
  const busy: 0 | 1 = d.period === "pm" ? 0 : 1;
  // 1. Cycle length, starting from a green wave for the busy direction.
  let best: FixedPlan | null = null, bestScore = Infinity;
  for (const cy of cycles) {
    const p = greenWavePlan(c.signals.map((s) => s.s), volumeGreens(c, d, cy), busy, 11.5, cy, c.length);
    const sc = score(p);
    opts.progress?.(`cycle ${cy}s: ${sc.toFixed(1)}`);
    if (sc < bestScore) { best = p; bestScore = sc; }
  }
  let plan: FixedPlan = { ...best!, label: "Optimized timing", mainGreenS: [...best!.mainGreenS], offsetS: [...best!.offsetS] };
  const usable = plan.cycleS - LOST_PER_CYCLE_S;
  // 2. Offsets and greens, one signal at a time.
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let i = 0; i < c.signals.length; i++) {
      for (let o = 0; o < plan.cycleS; o += step) {
        if (o === plan.offsetS[i]) continue;
        const offs = [...plan.offsetS]; offs[i] = o;
        const cand = { ...plan, offsetS: offs }, sc = score(cand);
        if (sc < bestScore - 1e-9) { plan = cand; bestScore = sc; }
      }
      for (const dg of [-2 * gStep, -gStep, gStep, 2 * gStep]) {
        const g = plan.mainGreenS[i]! + dg;
        if (g < MIN_MAIN_GREEN_S || usable - g < MIN_CROSS_GREEN_S) continue;
        const greens = [...plan.mainGreenS]; greens[i] = g;
        const cand = { ...plan, mainGreenS: greens }, sc = score(cand);
        if (sc < bestScore - 1e-9) { plan = cand; bestScore = sc; }
      }
    }
    opts.progress?.(`sweep ${sweep + 1}: ${bestScore.toFixed(1)}`);
  }
  return { plan, score: bestScore, evaluations };
}
