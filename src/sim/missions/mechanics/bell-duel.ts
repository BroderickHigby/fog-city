// Ported from lane/sim-player/wave4-continuation (b706fa7). Change: the response is timed from
// the player's own first ring (within BELL_FIRST_RING_TICKS), not from a hidden clock.
import type { GameplayBody } from "../../gameplay-contract.ts";
import { planarDistanceSquared } from "./geometry.ts";

export interface BellDuelRequest { id: string; playerId: string; opponentId: string; x: number; y: number; z: number; radius?: number }
export interface BellDuelProgress { requestId: string; opponentId: string; phase: "demonstration" | "response" | "intermission" | "won" | "lost"; round: number; wins: number; losses: number; cues: number[]; responseTicks: number[]; ringIndex: number; nextRoundTick: number }
export interface MechanicEmission { kind: string; playerId: string; actorId?: string; amount?: number; detail?: string }
export const BELL_TOLERANCE_TICKS = 7; // 116.7 ms at 60 Hz, inside the design's ±120 ms.
/** "Your turn": the first ring may come up to 2 s after the response opens; the pattern is timed from it. */
export const BELL_FIRST_RING_TICKS = 120;
const hash = (text: string): number => { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return value >>> 0; };

export function canStartDuel(body: GameplayBody | undefined, request: BellDuelRequest): boolean {
  const radius = request.radius ?? 5;
  return !!body && !!request.opponentId && [body.x, body.y, body.z, body.speed, request.x, request.y, request.z, request.radius ?? 5].every(Number.isFinite)
    && body.mode === "foot" && Math.abs(body.speed) < 2 && radius > 0 && planarDistanceSquared(body.x, body.z, request.x, request.z) <= radius * radius && Math.abs(body.y - request.y) <= 2;
}

export function newBellRound(id: string, opponentId: string, seed: number, round: number, tick: number, wins = 0, losses = 0): BellDuelProgress {
  let random = hash(`${seed}:${id}:${opponentId}:${round}`);
  const next = (): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const count = 4 + next() % 5;
  const offsets = [0];
  for (let i = 1; i < count; i++) offsets.push(offsets[i - 1]! + 24 + next() % 31);
  const cueStart = tick + 30;
  const responseStart = cueStart + offsets[offsets.length - 1]! + 90;
  return { requestId: id, opponentId, phase: "demonstration", round, wins, losses, cues: offsets.map((offset) => cueStart + offset), responseTicks: offsets.map((offset) => responseStart + offset), ringIndex: 0, nextRoundTick: 0 };
}

export function advanceBellDuel(previous: BellDuelProgress, request: BellDuelRequest, body: GameplayBody | undefined, seed: number, tick: number, previousTick: number, pressed: boolean, emit: (event: MechanicEmission) => void): BellDuelProgress {
  let state = { ...previous, cues: [...previous.cues], responseTicks: [...previous.responseTicks] };
  if (state.phase === "won" || state.phase === "lost") return state;
  const event = (kind: string, amount = state.round): void => emit({ kind, playerId: request.playerId, actorId: request.opponentId, amount, detail: request.id });
  const finishRound = (won: boolean): void => {
    state.wins += won ? 1 : 0; state.losses += won ? 0 : 1;
    event(won ? "bell.roundWon" : "bell.roundLost");
    if (state.wins === 2 || state.losses === 2) {
      state.phase = state.wins === 2 ? "won" : "lost";
      event(state.phase === "won" ? "bell.duelWon" : "bell-duel.lost");
    } else { state.phase = "intermission"; state.nextRoundTick = tick + 90; }
  };
  if (!canStartDuel(body, request)) { state.losses = 2; state.phase = "lost"; event("bell-duel.lost"); return state; }
  if (state.phase === "intermission") {
    if (tick >= state.nextRoundTick) state = newBellRound(state.requestId, state.opponentId, seed, state.round + 1, tick, state.wins, state.losses);
    return state;
  }
  for (const cue of state.cues) if (cue > previousTick && cue <= tick) event("bell.cue", cue);
  if (tick >= state.responseTicks[0]! - BELL_TOLERANCE_TICKS) state.phase = "response";
  if (state.phase !== "response") return state;
  if (state.ringIndex === 0) {
    // You repeat the rhythm, not the clock: the first ring sets where the pattern starts.
    if (tick > state.responseTicks[0]! + BELL_FIRST_RING_TICKS) { finishRound(false); return state; }
    if (!pressed) return state;
    const shift = tick - state.responseTicks[0]!;
    state.responseTicks = state.responseTicks.map(value => value + shift);
  }
  const expected = state.responseTicks[state.ringIndex]!;
  if (tick > expected + BELL_TOLERANCE_TICKS) { finishRound(false); return state; }
  if (pressed) {
    if (Math.abs(tick - expected) > BELL_TOLERANCE_TICKS) finishRound(false);
    else {
      state.ringIndex++; event("bell.ring", state.ringIndex);
      if (state.ringIndex === state.responseTicks.length) finishRound(true);
    }
  }
  return state;
}
