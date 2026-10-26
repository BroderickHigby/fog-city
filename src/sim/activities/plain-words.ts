import { ACTIVITY_RULES } from "../../content/gameplay.ts";
import { toLocal } from "../../geo/project.ts";
import { event, planarDistanceSquared } from "../player/common.ts";
import type { ActivitiesState, GameplayContext, GameplayFact, PlainWordsRun, WaterTrace } from "../player/types.ts";

/**
 * Plain Words (docs/design.md, "Plain Words"): sign-spinner robots rebrand sandwich boards along
 * Columbus Ave with the hype word of the moment; two seconds of the player's stream washes a
 * board back to plain words. Every few rebrands the word climbs the ladder. Boards and washing
 * are measured here from the player's real water; the spinners are ordinary bad robots that the
 * agents runtime stages and the combat system rusts.
 */
const RULES = ACTIVITY_RULES.plainWords;
export const PLAIN_WORDS_ID = "plain-words";
/** Board half-size the stream must pass through: a sandwich board about 0.6 m wide, 1.1 m tall. */
const BOARD_RADIUS_M = .45, BOARD_TOP_M = 1.2;
/** A board counts as being sprayed for this many ticks after a hit, so a pulsed stream reads as continuous. */
const SPRAY_HOLD_TICKS = 12;
/** A spinner reaches and rebrands the nearest plain board within this range, once per interval. */
const REBRAND_RANGE_M = 50, REBRAND_EVERY_TICKS = 8 * 60;
export const PLAIN_WORDS_BOARDS: readonly { id: string; x: number; z: number; headingDeg: number }[] =
  RULES.boards.map(board => ({ id: board.id, ...toLocal(board.lat, board.lon), headingDeg: board.headingDeg }));
export const PLAIN_WORDS_LADDER: readonly string[] = RULES.ladder;

export function spinnerId(playerId: string, startedTick: number, index: number): string {
  return `mission:${PLAIN_WORDS_ID}:${playerId}:a${startedTick}:spinner-${index + 1}`;
}

/** A fresh run: every board shows the first hype word, and four spinners are asked for near the boards. */
export function startPlainWords(state: ActivitiesState, playerId: string, tick: number): PlainWordsRun {
  const spinners = Array.from({ length: RULES.spinnerCount }, (_, index) => spinnerId(playerId, tick, index));
  // Spread the spinners along the corridor, each beside its own stretch of boards. The scene is
  // anchored mid-corridor: a staged actor must sit within 1 km of its anchor.
  const anchor = PLAIN_WORDS_BOARDS[Math.floor(PLAIN_WORDS_BOARDS.length / 2)]!;
  const actors = spinners.map((id, index) => {
    // Among the southern half's boards, so one run is a compact loop from the Broadway start.
    const near = PLAIN_WORDS_BOARDS[Math.min(PLAIN_WORDS_BOARDS.length - 1, 1 + index * 3)]!;
    return { id, role: `${playerId}-spinner-${index + 1}`, model: "footman", firmware: "bad", offset: { x: near.x - anchor.x, z: near.z - anchor.z }, radius: .45, height: 1.6 };
  });
  event(state, "mission.scene-request", playerId, PLAIN_WORDS_ID, 0, JSON.stringify({ missionId: PLAIN_WORDS_ID, anchor: { x: anchor.x, y: 0, z: anchor.z }, actors }));
  return { boards: PLAIN_WORDS_BOARDS.map(board => ({ id: board.id, word: 0, wash: 0, sprayedUntil: -1, qualified: false })), rung: 0, rebrands: 0, washed: 0, spinnerIds: spinners, rusted: [], nextRebrandTick: tick + REBRAND_EVERY_TICKS };
}

/** Does a stream segment pass through a board standing at (x, z)? */
function hits(trace: WaterTrace, board: { x: number; z: number }): boolean {
  const dx = trace.bx - trace.ax, dz = trace.bz - trace.az, length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((board.x - trace.ax) * dx + (board.z - trace.az) * dz) / length2)) : 0;
  const x = trace.ax + dx * t, z = trace.az + dz * t, height = trace.ah + (trace.bh - trace.ah) * t;
  return (x - board.x) * (x - board.x) + (z - board.z) * (z - board.z) <= BOARD_RADIUS_M * BOARD_RADIUS_M && height >= -.1 && height <= BOARD_TOP_M;
}

/**
 * One tick of a run. Returns newly qualified distinct boards (one `board.washed` objective each).
 * Spinners rebrand while they stand; a rusted spinner stops.
 */
export function stepPlainWords(run: PlainWordsRun, ctx: GameplayContext, playerId: string, tick: number, incoming: readonly GameplayFact[], state: ActivitiesState): number {
  for (const fact of incoming) {
    if (fact.source === "combat" && fact.playerId === playerId && fact.kind === "robot.heap" && fact.actorId && (ctx.rustByActor?.[fact.actorId] ?? 0) >= 1 && run.spinnerIds.includes(fact.actorId) && !run.rusted.includes(fact.actorId)) {
      run.rusted.push(fact.actorId);
      event(state, "plainWords.spinnerRusted", playerId, fact.actorId);
    }
  }
  const traces = (ctx.waterTraces ?? []).filter(trace => trace.playerId === playerId);
  let washed = 0;
  // The flags, not the number of cleaning/rebranding events, own distinct progress.
  run.washed = run.boards.filter(board => board.qualified === true).length;
  const qualify = (board: PlainWordsRun["boards"][number], detail = ""): void => {
    if (board.qualified) return;
    board.qualified = true;
    washed++; run.washed++;
    event(state, "board.washed", playerId, board.id, 0, detail);
  };
  for (const board of run.boards) {
    const where = PLAIN_WORDS_BOARDS.find(value => value.id === board.id)!;
    if (traces.some(trace => hits(trace, where))) board.sprayedUntil = tick + SPRAY_HOLD_TICKS;
    if (board.word < 0) { board.wash = 0; continue; }
    board.wash = board.sprayedUntil >= tick ? board.wash + 1 : Math.max(0, board.wash - 2);
    if (board.wash >= RULES.boardWashS * 60) {
      board.word = -1; board.wash = 0;
      qualify(board);
    }
  }
  if (tick >= run.nextRebrandTick) {
    run.nextRebrandTick = tick + REBRAND_EVERY_TICKS;
    const standing = (ctx.actorBodies ?? []).filter(actor => actor.kind === "robot" && actor.firmware === "bad" && run.spinnerIds.includes(actor.id) && !run.rusted.includes(actor.id) && (ctx.rustByActor?.[actor.id] ?? 0) < 1).sort((a, b) => a.id < b.id ? -1 : 1);
    for (const spinner of standing) {
      const target = run.boards.filter(board => board.word < 0)
        .map(board => ({ board, at: PLAIN_WORDS_BOARDS.find(value => value.id === board.id)! }))
        .filter(({ at }) => planarDistanceSquared(at, spinner) <= REBRAND_RANGE_M * REBRAND_RANGE_M)
        .sort((a, b) => planarDistanceSquared(a.at, spinner) - planarDistanceSquared(b.at, spinner) || (a.board.id < b.board.id ? -1 : 1))[0];
      if (!target) continue;
      run.rebrands++;
      if (run.rebrands % RULES.advanceEvery === 0) run.rung = Math.min(PLAIN_WORDS_LADDER.length - 1, run.rung + 1);
      // At the top of the ladder the hype ate itself: "made by humans" is plain words.
      if (run.rung === PLAIN_WORDS_LADDER.length - 1) { qualify(target.board, "made-by-humans"); continue; }
      target.board.word = run.rung;
      event(state, "plainWords.rebranded", playerId, target.board.id, run.rung, spinner.id);
    }
  }
  return washed;
}

/** The solo goal: every spinner rusted. Washing is the activity's counted objective. */
export function plainWordsSpinnersDone(run: PlainWordsRun | undefined): boolean {
  return !!run && run.spinnerIds.length === RULES.spinnerCount && new Set(run.spinnerIds).size === RULES.spinnerCount && run.spinnerIds.every(id => run.rusted.includes(id));
}

/** Counted wash events alone never settle a run: all authored boards and spinners must qualify. */
export function plainWordsComplete(run: PlainWordsRun | undefined): boolean {
  return !!run && PLAIN_WORDS_BOARDS.every(authored => run.boards.some(board => board.id === authored.id && board.qualified === true)) && plainWordsSpinnersDone(run);
}
