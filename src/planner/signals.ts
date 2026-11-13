// Signal control for the corridor: fixed-time plans and an adaptive (actuated, look-ahead) controller.
// Each intersection has two phases: the main street (Lombard) and the cross street.

export type Aspect = "green" | "yellow" | "red";

export const YELLOW_S = 3;
export const ALL_RED_S = 2;
/** Shortest cross-street green: time for a person to cross six lanes of Lombard. */
export const MIN_CROSS_GREEN_S = 14;
export const MIN_MAIN_GREEN_S = 15;

export interface FixedPlan {
  kind: "fixed";
  label: string;
  cycleS: number;
  /** Lombard green per intersection (east to west), seconds. */
  mainGreenS: readonly number[];
  /** When each intersection's Lombard green starts, seconds into the cycle. */
  offsetS: readonly number[];
}

export interface AdaptivePlan {
  kind: "adaptive";
  label: string;
  /** Keep Lombard green while a car is this many seconds from the stop line (gap-out). */
  gapS: number;
  maxMainS: number;
  maxCrossS: number;
  /** Hold Lombard green for a platoon of this many cars due within lookAheadS. */
  platoon: number;
  lookAheadS: number;
}

export type ControlPlan = FixedPlan | AdaptivePlan;

/** Interlock time between the two greens: yellow then all-red, twice a cycle. */
export const LOST_PER_CYCLE_S = 2 * (YELLOW_S + ALL_RED_S);

export function crossGreenS(plan: FixedPlan, i: number): number {
  return plan.cycleS - plan.mainGreenS[i]! - LOST_PER_CYCLE_S;
}

/** Lombard's aspect and the cross street's, at time t, under a fixed plan. */
export function fixedAspects(plan: FixedPlan, i: number, t: number): { main: Aspect; cross: Aspect } {
  const c = plan.cycleS, g = plan.mainGreenS[i]!;
  const u = (((t - plan.offsetS[i]!) % c) + c) % c;
  if (u < g) return { main: "green", cross: "red" };
  if (u < g + YELLOW_S) return { main: "yellow", cross: "red" };
  if (u < g + YELLOW_S + ALL_RED_S) return { main: "red", cross: "red" };
  const crossEnd = c - YELLOW_S - ALL_RED_S;
  if (u < crossEnd) return { main: "red", cross: "green" };
  if (u < crossEnd + YELLOW_S) return { main: "red", cross: "yellow" };
  return { main: "red", cross: "red" };
}

/** A small deterministic hash in [0, 1), for "uncoordinated" offsets that do not change between runs. */
export function unitHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

/**
 * Split each signal's cycle between Lombard and the cross street in proportion to their critical
 * flow ratios (flow per lane over saturation flow per lane), within the minimum greens.
 */
export function splitGreens(cycleS: number, mainRatio: readonly number[], crossRatio: readonly number[]): number[] {
  const usable = cycleS - LOST_PER_CYCLE_S;
  return crossRatio.map((cross, i) => {
    const main = mainRatio[i]!;
    const share = main / Math.max(1e-6, main + cross);
    const g = Math.round(usable * share);
    return Math.max(MIN_MAIN_GREEN_S, Math.min(usable - MIN_CROSS_GREEN_S, g));
  });
}

/**
 * The assumed "today" plan. SFMTA does not publish its timing, so this is an assumption, labelled
 * as such: an 80 s cycle split by volume, with offsets that are not coordinated for the flows.
 */
export function todayPlan(nodes: readonly string[], greens: readonly number[], cycleS = 80): FixedPlan {
  return { kind: "fixed", label: "Today (assumed timing)", cycleS, mainGreenS: greens,
    offsetS: nodes.map((n) => Math.round(unitHash(`today:${n}`) * cycleS)) };
}

/** A one-way green wave: each green starts when a car leaving the first at `speed` arrives. */
export function greenWavePlan(signalS: readonly number[], greens: readonly number[], direction: 0 | 1, speedMps: number, cycleS = 80, length = 0): FixedPlan {
  const offs = signalS.map((s) => {
    const along = direction === 0 ? s : length - s;
    return Math.round(((along / speedMps) % cycleS + cycleS) % cycleS);
  });
  return { kind: "fixed", label: direction === 0 ? "Green wave (westbound)" : "Green wave (eastbound)", cycleS, mainGreenS: greens, offsetS: offs };
}

export const ADAPTIVE_PLAN: AdaptivePlan = Object.freeze({
  kind: "adaptive", label: "Adaptive signals (look-ahead)", gapS: 3, maxMainS: 60, maxCrossS: 35, platoon: 4, lookAheadS: 8,
});

/** Live state of one intersection under the adaptive controller. */
export interface AdaptiveState { phase: "main" | "toCross" | "cross" | "toMain"; elapsed: number }

export function adaptiveAspects(st: AdaptiveState): { main: Aspect; cross: Aspect } {
  switch (st.phase) {
    case "main": return { main: "green", cross: "red" };
    case "cross": return { main: "red", cross: "green" };
    case "toCross": return { main: st.elapsed < YELLOW_S ? "yellow" : "red", cross: "red" };
    case "toMain": return { main: "red", cross: st.elapsed < YELLOW_S ? "yellow" : "red" };
  }
}

/**
 * One step of the adaptive controller. `mainDemand.gap` = a Lombard car is within gapS of the
 * stop line; `mainDemand.platoon` = cars due within lookAheadS; `crossQueue` = waiting cross cars.
 */
export function adaptiveStep(plan: AdaptivePlan, st: AdaptiveState, dt: number, mainDemand: { gap: boolean; platoon: number }, crossQueue: number): void {
  st.elapsed += dt;
  const interlock = YELLOW_S + ALL_RED_S;
  if (st.phase === "main") {
    if (st.elapsed < MIN_MAIN_GREEN_S || crossQueue < 0.5) return;
    const hold = mainDemand.gap || mainDemand.platoon >= plan.platoon;
    if (!hold || st.elapsed >= plan.maxMainS) { st.phase = "toCross"; st.elapsed = 0; }
  } else if (st.phase === "toCross") {
    if (st.elapsed >= interlock) { st.phase = "cross"; st.elapsed = 0; }
  } else if (st.phase === "cross") {
    if (st.elapsed < MIN_CROSS_GREEN_S) return;
    if (crossQueue < 0.5 || st.elapsed >= plan.maxCrossS) { st.phase = "toMain"; st.elapsed = 0; }
  } else if (st.elapsed >= interlock) { st.phase = "main"; st.elapsed = 0; }
}
