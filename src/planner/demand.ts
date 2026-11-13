// How many cars use the corridor in the busiest hour, where they join and leave, and how many
// wait on each cross street. Anchored to Caltrans' measured peak hours (data.ts).
import type { Corridor } from "./corridor.ts";
import { CALTRANS_COUNTS, CROSS_STREETS, PEAK_HOUR_SHARE } from "./data.ts";

export type Period = "pm" | "am";

export interface Demand {
  label: string;
  period: Period;
  scale: number;
  /** Cars per hour entering each end: [westbound at Van Ness, eastbound at Richardson]. */
  entry: readonly [number, number];
  /** Per direction, per signal (east-to-west index): share of passing cars that turn off there. */
  outShare: readonly [readonly number[], readonly number[]];
  /** Per direction, per signal: cars per hour turning onto Lombard there, during the cross green. */
  inRate: readonly [readonly number[], readonly number[]];
  /** Per direction, per signal: Lombard cars per hour arriving at that signal. */
  linkFlow: readonly [readonly number[], readonly number[]];
  /** Cross-street arrivals per signal, cars per hour (both approaches). */
  crossRate: readonly number[];
  /** Which cross-street figures were counted and which estimated. */
  crossSource: readonly string[];
}

/** The busy direction carries this share of the peak hour (SFMTA 2015 counts at Broderick St). */
export const PEAK_DIRECTION_SHARE = 0.55;
/** Share of passing cars that turn off at each signal (and as many turn on), before the net change. */
export const TURNOVER_SHARE = 0.03;

export function latestCount(): (typeof CALTRANS_COUNTS)[number] {
  return CALTRANS_COUNTS[CALTRANS_COUNTS.length - 1]!;
}

/**
 * The peak hour. `scale` multiplies every flow (1 = Caltrans' latest count). PM: westbound (to the
 * bridge) is the busy direction; AM: eastbound.
 */
export function lombardDemand(c: Corridor, period: Period = "pm", scale = 1, label?: string): Demand {
  const base = latestCount();
  const east = base.lombardVanNessPeakHour * scale, west = base.broderickPeakHour * scale;
  const wbShare = period === "pm" ? PEAK_DIRECTION_SHARE : 1 - PEAK_DIRECTION_SHARE;
  const ebShare = 1 - wbShare;
  const n = c.signals.length;
  const crossRate: number[] = [], crossSource: string[] = [];
  for (const sig of c.signals) {
    const known = CROSS_STREETS.find((x) => x.street === sig.street);
    crossRate.push((known?.daily ?? 4000) * PEAK_HOUR_SHARE * scale);
    crossSource.push(known ? `${sig.street}: ${known.source}` : `${sig.street}: estimate (no count)`);
  }
  const weight = crossRate.map((r) => r / crossRate.reduce((p, q) => p + q, 0));
  const out: [number[], number[]] = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
  const inn: [number[], number[]] = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
  const link: [number[], number[]] = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
  // Westbound gains (more cars at Broderick than at Van Ness): side streets feed the bridge.
  {
    let f = wbShare * east;
    const gain = wbShare * (west - east);
    const wsum = weight.slice(1).reduce((p, q) => p + q, 0);
    for (let i = 1; i < n; i++) {
      const o = f * TURNOVER_SHARE, add = gain * weight[i]! / wsum;
      link[0][i] = f; out[0][i] = TURNOVER_SHARE; inn[0][i] = o + add; f += add;
    }
  }
  // Eastbound loses the same way: cars leave Lombard for the Marina and Cow Hollow.
  {
    let f = ebShare * west;
    const loss = ebShare * (west - east);
    const wsum = weight.slice(1).reduce((p, q) => p + q, 0);
    for (let i = n - 1; i >= 1; i--) {
      const drop = loss * weight[i]! / wsum, o = f * TURNOVER_SHARE + drop;
      link[1][i] = f;
      out[1][i] = Math.min(0.5, o / Math.max(1, f)); inn[1][i] = f * TURNOVER_SHARE; f -= drop;
    }
    link[1][0] = f;
  }
  return { label: label ?? `${period === "pm" ? "Evening" : "Morning"} peak, ${base.year} count${scale === 1 ? "" : ` x${scale.toFixed(2)}`}`,
    period, scale, entry: [wbShare * east, ebShare * west], outShare: out, inRate: inn, linkFlow: link, crossRate, crossSource };
}
