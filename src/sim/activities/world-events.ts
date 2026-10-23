import type { GameplayContext, GameplayEvent } from "../player/types.ts";

/** Calendar presentation only. The one Doom Clock lives in ProgressionState.doom. */
export interface WorldEventsState {
  version: 1;
  tick: number;
  conferenceWeek: boolean;
  lastGameWeek: number | null;
}
export type WorldEmission = Omit<GameplayEvent, "id" | "tick">;
export function createWorldEvents(): WorldEventsState {
  return { version: 1, tick: -1, conferenceWeek: false, lastGameWeek: null };
}
/** Conference Week is every fourth game week, offset by two from Fleet Week. */
export function stepWorldEvents(previous: WorldEventsState | undefined, ctx: GameplayContext,
  tick: number): { state: WorldEventsState; emissions: WorldEmission[] } {
  const old = previous ?? createWorldEvents();
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("World events require a valid tick");
  if (tick <= old.tick || ctx.wave < 4 || (ctx.mode ?? "freeRoam") !== "freeRoam") return { state: old, emissions: [] };
  const day = Number.isSafeInteger(ctx.gameDay) && ctx.gameDay! >= 0 ? ctx.gameDay! : null;
  const week = Number.isSafeInteger(ctx.gameWeek) && ctx.gameWeek! >= 0 ? ctx.gameWeek!
    : day === null ? null : Math.floor(day / 7);
  const state: WorldEventsState = { version: 1, tick, conferenceWeek: old.conferenceWeek, lastGameWeek: old.lastGameWeek };
  const emissions: WorldEmission[] = [];
  if (week !== null && (state.lastGameWeek === null || week >= state.lastGameWeek)) {
    state.lastGameWeek = week;
    const active = week % 4 === 2;
    if (state.conferenceWeek !== active) {
      state.conferenceWeek = active;
      emissions.push({ kind: "world.conference", playerId: "", targetId: "soma", amount: active ? 1 : 0, detail: "bad-rate:1.5;ads:2" });
    }
  }
  return { state, emissions };
}
