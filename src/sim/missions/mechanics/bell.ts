// The bell duel as a mission producer (docs/design.md "Bell duel"): at the nearest cable car
// turntable, an associate rings 4-8 bells and the cornered founder repeats the pattern with
// interact, each ring within ±120 ms. Best of three. The rules are bell-duel.ts (ported from
// lane/sim-player/wave4-continuation); this file binds them to authored mission steps.
import { Action } from "../../contract.ts";
import { toLocal } from "../../../geo/project.ts";
import { isGameplayId } from "../../gameplay-contract.ts";
import type { Mission, ObjectiveStep } from "../../../content/missions.ts";
import type { GameplayContext, GameplayFact, HeatState, MissionProgress, MissionState } from "../../player/types.ts";
import { advanceBellDuel, canStartDuel, newBellRound, type BellDuelProgress, type BellDuelRequest, type MechanicEmission } from "./bell-duel.ts";
import { planarDistanceSquared } from "./geometry.ts";

/** Cable car turntables, Powell & Market and Hyde & Beach first (design.md). */
export const TURNTABLES: readonly { id: string; x: number; z: number }[] = Object.freeze([
  { id: "powell-market", ...toLocal(37.78475, -122.40775) },
  { id: "hyde-beach", ...toLocal(37.8066, -122.42095) },
].map(t => Object.freeze({ id: t.id, x: t.x, z: t.z })));
/** A won duel costs you back to two stars (8 quarters). */
export const DUEL_WIN_QUARTERS = 8;
/** Win: "we'll circle back" and $500. */
export const DUEL_WIN_CENTS = 50_000;
export const DUEL_RADIUS_M = 6;

export interface MissionBellState { tick: number; nextSequence: number; previousInteract: Record<string, boolean>; duels: Record<string, BellDuelProgress> }

/** The authored objective a player is on, when it is one of the duel's two events. */
function duelStep(mission: Mission, progress: MissionProgress): ObjectiveStep | undefined {
  const step = mission.steps.find(value => value.id === progress.stepId);
  return step?.type === "objective" && step.objective.kind === "event" && (step.objective.event === "bell.duelStarted" || step.objective.event === "bell.duelWon") ? step : undefined;
}

/** One duel per attempt: the win step shares the request its start step opened. */
function requestId(mission: Mission, step: ObjectiveStep, progress: MissionProgress): string | undefined {
  let anchor = step.id, visit = progress.visits;
  if (step.objective.kind === "event" && step.objective.event === "bell.duelWon") {
    const starts = mission.steps.filter((value): value is ObjectiveStep => value.type === "objective" && value.objective.kind === "event"
      && value.objective.event === "bell.duelStarted" && value.next === step.id);
    if (starts.length > 1) return undefined;
    if (starts.length === 1) { anchor = starts[0]!.id; visit--; }
  }
  if (!Number.isSafeInteger(progress.startedTick) || progress.startedTick < 0 || visit < 1) return undefined;
  const id = `${mission.id}:${anchor}:${progress.startedTick}:${visit}`;
  return isGameplayId(id) ? id : undefined;
}

/** The turntable nearest the player's body when the duel step began (stable through the duel). */
export function nearestTurntable(x: number, z: number): { id: string; x: number; z: number } {
  let best = TURNTABLES[0]!, bestD = Infinity;
  for (const t of TURNTABLES) { const d = planarDistanceSquared(x, z, t.x, t.z); if (d < bestD) { bestD = d; best = t; } }
  return best;
}

/**
 * Step every active duel once per tick. Returns world facts (bell.duelStarted, bell.cue,
 * bell.ring, bell.roundWon/Lost, bell.duelWon, bell-duel.lost) for the mission interpreter.
 * Only this producer may supply them; the caller strips copies from other sources.
 */
export function prepareMissionBell(previous: MissionBellState | undefined, missions: MissionState, ctx: GameplayContext, _heat: HeatState, tick: number, seed: number): { state: MissionBellState; facts: GameplayFact[] } {
  const old = previous ?? { tick: -1, nextSequence: 1, previousInteract: {}, duels: {} };
  if (tick <= old.tick) return { state: old, facts: [] };
  const state: MissionBellState = { tick, nextSequence: old.nextSequence, previousInteract: {}, duels: {} }, facts: GameplayFact[] = [];
  const emit = (value: MechanicEmission): void => {
    const sequence = state.nextSequence++;
    facts.push({ ...value, id: `mission-bell:${sequence}`, source: "world", sequence, tick });
  };
  for (const body of [...ctx.bodies].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const interacting = Boolean((ctx.actions?.[body.id] ?? 0) & Action.interact);
    state.previousInteract[body.id] = interacting;
    const pressed = interacting && !old.previousInteract[body.id];
    const progress = missions.players[body.id];
    if (!progress || progress.status !== "active") continue;
    const mission = ctx.missions.find(value => value.id === progress.missionId && (value.wave ?? 2) <= ctx.wave);
    const step = mission && duelStep(mission, progress), id = mission && step && requestId(mission, step, progress);
    if (!mission || !step || !id) continue;
    const before = old.duels[body.id];
    const table = before?.requestId === id ? TURNTABLES.find(t => before.opponentId === `associate:${t.id}`) : nearestTurntable(body.x, body.z);
    if (!table) continue;
    const request: BellDuelRequest = { id, playerId: body.id, opponentId: `associate:${table.id}`, x: table.x, y: body.y, z: table.z, radius: DUEL_RADIUS_M };
    if (before?.requestId === id) {
      state.duels[body.id] = before.phase === "won" || before.phase === "lost" ? before : advanceBellDuel(before, request, body, seed, tick, old.tick, pressed, emit);
    } else if (pressed && ((ctx.simVersion??20)<24||ctx.associatesAnswer!==false) && canStartDuel(body, request)) {
      // The authored step already granted the five stars; they decay out of every associate's
      // sight while you reach the turntable, so the mission's duel does not re-check them.
      state.duels[body.id] = newBellRound(id, request.opponentId, seed, 1, tick);
      emit({ kind: "bell.duelStarted", playerId: body.id, actorId: request.opponentId, detail: id });
    }
  }
  return { state, facts };
}
