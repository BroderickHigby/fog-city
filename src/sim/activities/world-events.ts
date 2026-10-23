import { facts, validId } from "../player/common.ts";
import type { GameplayContext, GameplayEvent } from "../player/types.ts";

export type Faction = "pausers" | "accelerators";
/** Supplied by the authored contract/provider adapter, never by a completion command. */
export interface FactionContract { id: string; faction: Faction; wave: number; cashCents: number }
export interface FactionTally { pausers: number; accelerators: number }
export interface DoomState {
  months: number;
  resets: number;
  lastGameDay: number | null;
  phase: "normal" | "agi" | "winter";
  phaseUntilDay: number | null;
  phaseUntilTick: number;
  pauseUntilTick: number;
  factions: Record<string, FactionTally>;
  completedContracts: string[];
}
export interface WorldEventsState {
  version: 1;
  tick: number;
  doom: DoomState;
  conferenceWeek: boolean;
  lastGameWeek: number | null;
  factCursors: Record<string, number>;
  streakCursor: number;
}
export type WorldEmission = Omit<GameplayEvent, "id" | "tick">;
const DAY_TICKS = 24 * 60 * 60; // One game minute per real second, at 60 Hz.

export function createWorldEvents(): WorldEventsState {
  return { version: 1, tick: -1, doom: { months: 24, resets: 0, lastGameDay: null,
    phase: "normal", phaseUntilDay: null, phaseUntilTick: 0, pauseUntilTick: 0,
    factions: {}, completedContracts: [] }, conferenceWeek: false, lastGameWeek: null, factCursors: {}, streakCursor: 0 };
}

export function factionOf(tally: FactionTally | undefined): Faction | null {
  if (!tally || tally.pausers === tally.accelerators) return null;
  return tally.pausers > tally.accelerators ? "pausers" : "accelerators";
}

export function doomModifiers(doom: DoomState) {
  return { badRobotFactor: doom.months < 12 ? 1.5 : doom.months > 36 ? 0.7 : 1,
    payFactor: doom.months < 12 ? 1.25 : doom.months > 36 ? 0.8 : 1,
    doubleAds: doom.months < 12, fewerAssociates: doom.months > 36,
    robotSpeedFactor: doom.phase === "winter" ? 0.9 : 1,
    associatesAvailable: doom.phase !== "winter" };
}

function copyDoom(previous: DoomState): DoomState {
  return { ...previous, factions: Object.fromEntries(Object.keys(previous.factions).sort().map(id => [id, { ...previous.factions[id]! }])),
    completedContracts: [...previous.completedContracts] };
}

function boundary(doom: DoomState, kind: "agi" | "winter", tick: number, day: number | null,
  emissions: WorldEmission[], playerId = "", count = 1): void {
  doom.months = 24;
  doom.resets += count;
  doom.phase = kind;
  doom.phaseUntilDay = day === null ? null : day + 1;
  doom.phaseUntilTick = tick + DAY_TICKS;
  if (kind === "agi") doom.pauseUntilTick = tick + 180;
  emissions.push({ kind: `doom.${kind}`, playerId, targetId: "", amount: count, detail: kind === "agi" ? "pause:180" : "speed:0.9" });
}

/** Used by once-only match settlement after its free-roam snapshot has been restored. */
export function moveDoomClock(previous: DoomState, delta: number, tick: number, playerId = "") {
  const doom = copyDoom(previous), emissions: WorldEmission[] = [];
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > 48 || !Number.isSafeInteger(tick) || tick < 0) return { doom, emissions };
  doom.months += delta;
  if (doom.months <= 0) boundary(doom, "agi", tick, doom.lastGameDay, emissions, playerId);
  else if (doom.months >= 48) boundary(doom, "winter", tick, doom.lastGameDay, emissions, playerId);
  if (delta) emissions.push({ kind: "doom.changed", playerId, targetId: "", amount: doom.months, detail: "faction" });
  return { doom, emissions };
}

/** A shared, deterministic clock. Calendar fields are absolute zero-based game day/week. */
export function stepWorldEvents(previous: WorldEventsState | undefined, ctx: GameplayContext, tick: number,
  progression: readonly GameplayEvent[] = []): { state: WorldEventsState; emissions: WorldEmission[] } {
  const old = previous ?? createWorldEvents();
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("World events require a valid tick");
  if (tick <= old.tick || ctx.wave < 4 || (ctx.mode ?? "freeRoam") !== "freeRoam") return { state: old, emissions: [] };
  const state: WorldEventsState = { ...old, tick, doom: copyDoom(old.doom), factCursors: { ...old.factCursors } };
  const emissions: WorldEmission[] = [];
  const day = Number.isSafeInteger(ctx.gameDay) && ctx.gameDay! >= 0 ? ctx.gameDay! : null;
  const doom = state.doom;
  if ((doom.phaseUntilDay !== null && day !== null && day >= doom.phaseUntilDay) || tick >= doom.phaseUntilTick) doom.phase = "normal";
  if (day !== null && (doom.lastGameDay === null || day >= doom.lastGameDay)) {
    const elapsed = doom.lastGameDay === null ? 0 : day - doom.lastGameDay;
    doom.lastGameDay = day;
    if (elapsed >= doom.months) {
      const afterFirst = elapsed - doom.months;
      const resets = 1 + Math.floor(afterFirst / 24);
      const sinceReset = afterFirst % 24;
      boundary(doom, "agi", tick, day - sinceReset, emissions, "", resets);
      doom.months = 24 - sinceReset;
      if (sinceReset > 0) {
        doom.phase = "normal"; doom.pauseUntilTick = 0;
        emissions.pop();
        emissions.push({ kind: "doom.reset-summary", playerId: "", targetId: "", amount: resets, detail: "elapsed-days" });
      }
    } else doom.months -= elapsed;
    if (elapsed) emissions.push({ kind: "doom.changed", playerId: "", targetId: "", amount: doom.months, detail: "daily-drift" });
  }
  const week = Number.isSafeInteger(ctx.gameWeek) && ctx.gameWeek! >= 0 ? ctx.gameWeek! : day === null ? null : Math.floor(day / 7);
  if (week !== null && (state.lastGameWeek === null || week >= state.lastGameWeek)) {
    state.lastGameWeek = week;
    if (state.conferenceWeek !== (week % 4 === 2)) {
    state.conferenceWeek = week % 4 === 2;
    emissions.push({ kind: "world.conference", playerId: "", targetId: "soma", amount: state.conferenceWeek ? 1 : 0, detail: "bad-rate:1.5;ads:2" });
    }
  }
  for (const fact of facts(ctx, tick, state.factCursors)) {
    if (fact.source !== "world" || fact.kind !== "faction.contract-completed" || !fact.actorId) continue;
    const contract = ctx.factionContracts?.find(row => row.id === fact.actorId && row.wave <= ctx.wave);
    if (!contract || !["pausers", "accelerators"].includes(contract.faction) || !Number.isSafeInteger(contract.cashCents) || contract.cashCents < 0) continue;
    const key = JSON.stringify([fact.playerId, contract.id]);
    if (!ctx.bodies.some(body => body.id === fact.playerId) || !validId(contract.id) || doom.completedContracts.includes(key)) continue;
    doom.completedContracts.push(key);
    const tally = doom.factions[fact.playerId] ?? { pausers: 0, accelerators: 0 };
    tally[contract.faction]++;
    doom.factions[fact.playerId] = tally;
    const moved = moveDoomClock(doom, contract.faction === "pausers" ? 3 : -3, tick, fact.playerId);
    Object.assign(doom, moved.doom);
    emissions.push(...moved.emissions,
      { kind: "faction.completed", playerId: fact.playerId, targetId: contract.id, amount: 1, detail: contract.faction },
      { kind: "activity.cash", playerId: fact.playerId, targetId: contract.id, amount: contract.cashCents, detail: "faction" });
  }
  for (const grant of [...progression].sort((a, b) => a.id - b.id)) {
    if (grant.tick !== tick || grant.id <= state.streakCursor) continue;
    state.streakCursor = grant.id;
    if (grant.kind === "streak.grant" && grant.targetId === "agi") boundary(doom, "agi", tick, day, emissions, grant.playerId);
  }
  return { state, emissions };
}
