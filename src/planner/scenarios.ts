// The demo's choices: four ways to run the signals and three traffic levels.
import type { Corridor } from "./corridor.ts";
import { lombardDemand, type Demand, type Period } from "./demand.ts";
import { forecast2031 } from "./forecast.ts";
import { volumeGreens } from "./optimize.ts";
import plans from "./plans.json" with { type: "json" };
import { ADAPTIVE_PLAN, greenWavePlan, todayPlan, type ControlPlan, type FixedPlan } from "./signals.ts";
import { runScenario, type Metrics, type RunOptions } from "./traffic.ts";

export type PlanId = "today" | "greenwave" | "optimized" | "adaptive";
export type DemandId = "now" | "trend2031" | "grow2031";

export const PLAN_IDS: readonly PlanId[] = ["today", "greenwave", "optimized", "adaptive"];
export const DEMAND_IDS: readonly DemandId[] = ["now", "trend2031", "grow2031"];

/** The assumed cycle for today's timing (and the plain green wave): typical of SF arterials. */
export const TODAY_CYCLE_S = 90;

/** People per new home in the 2031 levels: an assumption, stated on screen. */
export const PEOPLE_PER_HOME = 2;

export const PLAN_NOTES: Readonly<Record<PlanId, string>> = {
  today: "SFMTA does not publish signal timing: an assumed 90 s cycle, green split by measured traffic, offsets not coordinated.",
  greenwave: "Greens start in sequence for cars at 41 km/h (25 mph) in the busy direction.",
  optimized: "Cycle, greens and offsets searched to cut everyone's waiting, cross streets included.",
  adaptive: "Each signal reacts to the cars it sees: holds green for a platoon, serves side streets when Lombard is clear.",
};

export function planFor(c: Corridor, id: PlanId, period: Period, demand: Demand): ControlPlan {
  const busy: 0 | 1 = period === "pm" ? 0 : 1;
  const greens = volumeGreens(c, demand, TODAY_CYCLE_S);
  if (id === "today") return todayPlan(c.signals.map((s) => s.node), greens, TODAY_CYCLE_S);
  if (id === "greenwave") return greenWavePlan(c.signals.map((s) => s.s), greens, busy, 11.5, TODAY_CYCLE_S, c.length);
  if (id === "adaptive") return ADAPTIVE_PLAN;
  const stored = (plans as unknown as Record<string, { cycleS: number; mainGreenS: number[]; offsetS: number[] }>)[period];
  if (!stored || stored.offsetS.length !== c.signals.length) throw new Error(`no optimized ${period} plan for this corridor: run scripts/planner/optimize-lombard.ts`);
  return { kind: "fixed", label: "Optimized timing", cycleS: stored.cycleS, mainGreenS: stored.mainGreenS, offsetS: stored.offsetS } satisfies FixedPlan;
}

export function demandFor(c: Corridor, id: DemandId, period: Period): Demand {
  if (id === "now") return lombardDemand(c, period, 1, "Today's peak hour (Caltrans count)");
  const trend = forecast2031(PEOPLE_PER_HOME);
  if (id === "trend2031") return lombardDemand(c, period, trend.scale, "2031, all 82,069 homes: traffic follows the 1996-2023 trend");
  const grow = forecast2031(PEOPLE_PER_HOME, 1);
  return lombardDemand(c, period, grow.scale, `2031, all 82,069 homes: traffic grows with population (+${((grow.scale - 1) * 100).toFixed(0)}%)`);
}

/** Average of several seeds, so one lucky draw cannot decide a comparison. */
export function averageRuns(c: Corridor, d: Demand, p: ControlPlan, seeds: readonly number[], opts: RunOptions = {}): Metrics {
  const runs = seeds.map((seed) => runScenario(c, d, p, { ...opts, seed }));
  const avg = (f: (m: Metrics) => number): number => runs.reduce((s, m) => s + f(m), 0) / runs.length;
  const first = runs[0]!;
  return {
    ...first,
    travelTimeS: [avg((m) => m.travelTimeS[0]), avg((m) => m.travelTimeS[1])],
    through: [avg((m) => m.through[0]), avg((m) => m.through[1])],
    stopsPerCar: avg((m) => m.stopsPerCar),
    delayHoursPerHour: { main: avg((m) => m.delayHoursPerHour.main), cross: avg((m) => m.delayHoursPerHour.cross) },
    co2KgPerHour: { main: avg((m) => m.co2KgPerHour.main), cross: avg((m) => m.co2KgPerHour.cross), total: avg((m) => m.co2KgPerHour.total) },
    fuelLitresPerHour: avg((m) => m.fuelLitresPerHour),
    exitsPerHour: [avg((m) => m.exitsPerHour[0]), avg((m) => m.exitsPerHour[1])],
    maxEntryQueue: Math.max(...runs.map((m) => m.maxEntryQueue)),
    meanSpeedKmh: avg((m) => m.meanSpeedKmh),
  };
}
