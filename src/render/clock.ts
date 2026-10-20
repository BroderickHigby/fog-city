// The in-game clock as the renderer sees it. The sim owns time; until it publishes a
// time of day, the renderer derives one from the tick so clocks on landmarks move at
// real-time speed from a fixed start (golden hour by day, late evening at night).
//
// If a sim system later stores the time in state.ext (ext.clock as minutes since midnight,
// or { minuteOfDay } / { minutes }), that value wins.

import { TICK_HZ } from "../sim/contract.ts";

export const DAY_START_MINUTE = 18 * 60 + 52; // 18:52, low sun over the Pacific
export const NIGHT_START_MINUTE = 22 * 60 + 40;

function fromExt(ext: unknown): number | null {
  if (!ext || typeof ext !== "object") return null;
  const e = ext as Record<string, unknown>;
  for (const key of ["clock", "time"]) {
    const v = e[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const f of ["minuteOfDay", "minutes"]) {
        const m = o[f];
        if (typeof m === "number" && Number.isFinite(m)) return m;
      }
    }
  }
  return null;
}

/** Minutes since midnight in [0, 1440). */
export function gameMinuteOfDay(state: { tick: number; ext?: unknown }, night: boolean): number {
  const fromSim = fromExt(state.ext);
  const m = fromSim ?? (night ? NIGHT_START_MINUTE : DAY_START_MINUTE) + state.tick / TICK_HZ / 60;
  return ((m % 1440) + 1440) % 1440;
}

export function formatClock(minuteOfDay: number): string {
  const m = Math.floor(minuteOfDay) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}
