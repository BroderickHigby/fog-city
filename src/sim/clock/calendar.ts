import type { SimState } from "../contract.ts";
import { hash32 } from "../rng.ts";
import type { SimSystem } from "../system-contract.ts";

/** One game day takes 24 real minutes at 60 fixed updates per second. */
export const DAY_TICKS = 86_400;
export const WEEK_TICKS = 7 * DAY_TICKS;
export interface ClockState { version: 1; elapsedTicks: number }
export interface CalendarEpoch { year: number; month: number; day: number; hour: number }
export interface GameCalendar extends CalendarEpoch {
  minute: number;
  second: number;
  /** Sunday = 0 through Saturday = 6. */
  weekday: number;
  /**
   * Calendar days since the epoch's date: it rolls over at midnight with `day`, not 24 game
   * hours after the 08:00 start. gameWeek is its one-based week (seasons follow it).
   */
  dayIndex: number;
  gameWeek: number;
  season: "summer" | "winter";
}

function leap(year: number): boolean { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
function monthDays(year: number, month: number): number {
  return month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function daysBeforeYear(year: number): number {
  const y = year - 1;
  return 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

export function calendarEpoch(seed: number): CalendarEpoch {
  let day = hash32(seed, 0x434c4f43) % 365;
  let month = 1;
  while (day >= monthDays(2031, month)) day -= monthDays(2031, month++);
  return { year: 2031, month, day: day + 1, hour: 8 };
}

/** Gregorian calendar arithmetic only; never reads the host clock or global RNG. */
export function calendarAt(seed: number, elapsedTicks: number, epoch: CalendarEpoch = calendarEpoch(seed)): GameCalendar {
  if (!Number.isSafeInteger(elapsedTicks) || elapsedTicks < 0) throw new Error("Calendar ticks must be nonnegative safe integers");
  if (!Number.isInteger(epoch.year) || epoch.year < 1 || !Number.isInteger(epoch.month) || epoch.month < 1 || epoch.month > 12
    || !Number.isInteger(epoch.day) || epoch.day < 1 || epoch.day > monthDays(epoch.year, epoch.month)
    || !Number.isInteger(epoch.hour) || epoch.hour < 0 || epoch.hour > 23) throw new Error("Invalid calendar epoch");
  let epochDay = daysBeforeYear(epoch.year) + epoch.day - 1;
  for (let month = 1; month < epoch.month; month++) epochDay += monthDays(epoch.year, month);
  const dayAdvance = Math.floor(elapsedTicks / DAY_TICKS);
  const daySeconds = elapsedTicks % DAY_TICKS + epoch.hour * 3600;
  const absoluteDay = epochDay + dayAdvance + Math.floor(daySeconds / DAY_TICKS);
  let day = absoluteDay;
  let year = Math.floor(day / 146097) * 400 + 1;
  day %= 146097;
  while (day >= (leap(year) ? 366 : 365)) day -= leap(year++) ? 366 : 365;
  let month = 1;
  while (day >= monthDays(year, month)) day -= monthDays(year, month++);
  const secondOfDay = daySeconds % DAY_TICKS;
  const dayIndex = absoluteDay - epochDay, gameWeek = Math.floor(dayIndex / 7) + 1;
  return { year, month, day: day + 1, hour: Math.floor(secondOfDay / 3600), minute: Math.floor(secondOfDay / 60) % 60,
    second: secondOfDay % 60, weekday: (absoluteDay + 1) % 7, dayIndex, gameWeek,
    season: (gameWeek - 1) % 8 < 4 ? "summer" : "winter" };
}

export function gameTime(state: Readonly<SimState>): GameCalendar {
  return calendarAt(state.seed, state.ext.clock?.elapsedTicks ?? state.tick);
}

/** Explicitly registered by the gameplay runner; skipping this hook freezes game time. */
export function createClockSystem(): SimSystem {
  return { key: "clock", step: ({ previous, state }) => ({ ...state, ext: { ...state.ext,
    clock: { version: 1, elapsedTicks: (previous.ext.clock?.elapsedTicks ?? previous.tick) + 1 } } }) };
}
