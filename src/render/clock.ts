// The in-game clock as the renderer sees it. The sim owns time; until it publishes a time of
// day, the renderer derives one from the tick: one game clock, running at real-time speed
// from a start minute chosen once at boot (golden hour, or late evening for ?night=1).
// Night mode (KeyN) is a look and never moves the clock.
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

function fromAgentSession(state: { tick: number; ext?: unknown }): number | null {
  if (!state.ext || typeof state.ext !== "object") return null;
  const robots = (state.ext as Record<string, unknown>).robots;
  if (!robots || typeof robots !== "object") return null;
  const session = robots as Record<string, unknown>;
  return session.enabled === true && typeof session.startGameMinute === "number" && Number.isFinite(session.startGameMinute)
    ? session.startGameMinute + state.tick / TICK_HZ : null;
}

/** The clock's start minute for a game booted by day or at night. */
export function clockStartMinute(bootedAtNight: boolean): number {
  return bootedAtNight ? NIGHT_START_MINUTE : DAY_START_MINUTE;
}

/** Minutes since midnight in [0, 1440): `startMinute` at tick 0, then real-time speed. */
export function gameMinuteOfDay(state: { tick: number; ext?: unknown }, startMinute: number = DAY_START_MINUTE): number {
  const fromSim = fromExt(state.ext);
  const m = fromSim ?? fromAgentSession(state) ?? startMinute + state.tick / TICK_HZ / 60;
  return ((m % 1440) + 1440) % 1440;
}

export function formatClock(minuteOfDay: number): string {
  const m = Math.floor(minuteOfDay) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}
