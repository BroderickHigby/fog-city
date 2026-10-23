import { facts } from "../player/common.ts";
import type { GameplayContext, GameplayEvent } from "../player/types.ts";

export interface FactionRecord { pauser: number; accelerator: number }
export interface DoomClockState {
  months: number;
  lastDay: number;
  resets: number;
  winters: number;
  pausedUntil: number;
  winterUntilDay: number;
  factions: Record<string, FactionRecord>;
  factCursors: Record<string, number>;
  /** Optional so existing profiles still load without a state-format migration. */
  lastTick?: number;
  streakCursor?: number;
  winterUntilTick?: number;
}
export interface DoomChange {
  kind: "world.agi-achieved" | "world.ai-winter" | "faction.changed";
  playerId: string;
  amount: number;
}
export function createDoomClock(): DoomClockState {
  return { months: 24, lastDay: -1, resets: 0, winters: 0, pausedUntil: 0,
    winterUntilDay: -1, factions: {}, factCursors: {}, lastTick: -1, streakCursor: 0, winterUntilTick: 0 };
}
const DAY_TICKS = 24 * 60 * 60;
const validDay = (day: number | undefined): day is number => Number.isSafeInteger(day) && day! >= 0;
function copyClock(previous: DoomClockState): DoomClockState {
  return { ...previous, factions: Object.fromEntries(Object.keys(previous.factions).sort()
    .map(id => [id, { ...previous.factions[id]! }])), factCursors: { ...previous.factCursors } };
}
function reachBoundary(state: DoomClockState, kind: "agi" | "winter", tick: number,
  day: number, playerId: string, events: DoomChange[]): void {
  state.months = 24;
  if (kind === "agi") {
    state.resets++;
    state.pausedUntil = tick + 180;
    events.push({ kind: "world.agi-achieved", playerId, amount: state.resets });
  } else {
    state.winters++;
    state.winterUntilDay = day >= 0 ? day + 1 : -1;
    state.winterUntilTick = tick + DAY_TICKS;
    events.push({ kind: "world.ai-winter", playerId, amount: state.winters });
  }
}

/** Move the canonical clock immediately, including a restored match crossing a boundary. */
export function moveDoomClock(previous: DoomClockState, delta: number, tick: number,
  playerId = ""): { state: DoomClockState; events: DoomChange[] } {
  const state = copyClock(previous), events: DoomChange[] = [];
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > 48 || !Number.isSafeInteger(tick) || tick < 0) return { state, events };
  state.months += delta;
  if (state.months <= 0) reachBoundary(state, "agi", tick, state.lastDay, playerId, events);
  else if (state.months >= 48) reachBoundary(state, "winter", tick, state.lastDay, playerId, events);
  return { state, events };
}

/** A day of hype advances one month; measured faction completions move three months. */
export function stepDoomClock(previous: DoomClockState, ctx: GameplayContext, tick: number,
  progression: readonly GameplayEvent[] = []): { state: DoomClockState; events: DoomChange[] } {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Doom Clock requires a valid tick");
  if (tick <= (previous.lastTick ?? -1) || ctx.wave < 4 || (ctx.mode ?? "freeRoam") !== "freeRoam") return { state: previous, events: [] };
  const state = copyClock(previous), events: DoomChange[] = [];
  state.lastTick = tick;
  // gameDay is absolute; day is retained for existing provider callers.
  const day = validDay(ctx.gameDay) ? ctx.gameDay : validDay(ctx.day) ? ctx.day : null;
  if (day !== null && day >= state.lastDay) {
    const elapsed = state.lastDay < 0 ? 0 : day - state.lastDay;
    state.lastDay = day;
    if (elapsed > 0) state.pausedUntil = 0;
    if (elapsed >= state.months) {
      const afterFirst = elapsed - state.months;
      const crossings = 1 + Math.floor(afterFirst / 24);
      const sinceLast = afterFirst % 24;
      state.resets += crossings;
      state.months = 24 - sinceLast;
      // Catch-up after an old midnight updates counters, not today's audiovisual event.
      if (sinceLast === 0) {
        state.pausedUntil = tick + 180;
        events.push({ kind: "world.agi-achieved", playerId: "", amount: state.resets });
      } else state.pausedUntil = 0;
    } else state.months -= elapsed;
  }
  for (const fact of facts(ctx, tick, state.factCursors)) {
    if (fact.source !== "world") continue;
    if (fact.kind === "world.agi-trigger") reachBoundary(state, "agi", tick, state.lastDay, fact.playerId, events);
    if (fact.kind !== "faction.pauser-completed" && fact.kind !== "faction.accelerator-completed") continue;
    const own = state.factions[fact.playerId] ?? { pauser: 0, accelerator: 0 };
    state.factions[fact.playerId] = own;
    const delta = fact.kind === "faction.pauser-completed" ? 3 : -3;
    if (delta > 0) own.pauser++; else own.accelerator++;
    state.months += delta;
    events.push({ kind: "faction.changed", playerId: fact.playerId, amount: delta });
    if (state.months <= 0) reachBoundary(state, "agi", tick, state.lastDay, fact.playerId, events);
    else if (state.months >= 48) reachBoundary(state, "winter", tick, state.lastDay, fact.playerId, events);
  }
  for (const grant of [...progression].sort((a, b) => a.id - b.id)) {
    if (!Number.isSafeInteger(grant.id) || grant.id <= (state.streakCursor ?? 0)
      || !Number.isSafeInteger(grant.tick) || grant.tick < 0 || grant.tick > tick) continue;
    state.streakCursor = grant.id;
    if (grant.kind === "streak.grant" && grant.targetId === "agi") reachBoundary(state, "agi", tick, state.lastDay, grant.playerId, events);
  }
  return { state, events };
}

export function factionFor(clock: DoomClockState, playerId: string): "pauser" | "accelerator" | "unaffiliated" {
  const own = clock.factions[playerId];
  return !own || own.pauser === own.accelerator ? "unaffiliated" : own.pauser > own.accelerator ? "pauser" : "accelerator";
}
export function doomEffects(clock: DoomClockState, day: number, tick: number) {
  const effectiveDay = validDay(day) ? Math.max(day, clock.lastDay) : clock.lastDay;
  const datedWinter = effectiveDay >= 0 && clock.winterUntilDay >= 0;
  const winter = datedWinter ? effectiveDay < clock.winterUntilDay
    && (clock.winterUntilTick === undefined || tick < clock.winterUntilTick)
    : tick < (clock.winterUntilTick ?? 0);
  const crunch = clock.months < 12, cooling = clock.months > 36;
  return { bountyMultiplier: crunch ? 1.25 : cooling ? 0.8 : 1,
    badRateMultiplier: crunch ? 1.5 : cooling ? 0.7 : 1, robotSpeedMultiplier: winter ? 0.9 : 1,
    associatesAnswer: !winter, adMultiplier: crunch ? 2 : 1, paused: tick < clock.pausedUntil };
}
