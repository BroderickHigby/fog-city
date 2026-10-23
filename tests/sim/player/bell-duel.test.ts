import { describe, expect, it } from "vitest";
import { advanceBellDuel, newBellRound, BELL_FIRST_RING_TICKS, BELL_TOLERANCE_TICKS, type MechanicEmission } from "../../../src/sim/missions/mechanics/bell-duel.ts";

const request = { id: "duel", playerId: "p", opponentId: "associate:powell-market", x: 0, y: 0, z: 0, radius: 6 };
const body = { id: "p", x: 0, y: 0, z: 0, mode: "foot" as const, speed: 0 };
/** Play one round from `start`, pressing at the pattern's offsets from `first` plus `drift` per later ring. */
function play(first: number, drift: number) {
  let duel = newBellRound("duel", request.opponentId, 7, 1, 0);
  const offsets = duel.responseTicks.map(t => t - duel.responseTicks[0]!);
  const presses = new Set(offsets.map((o, i) => duel.responseTicks[0]! + first + o + (i > 0 ? drift : 0)));
  const events: MechanicEmission[] = [];
  for (let tick = 1; tick < duel.responseTicks.at(-1)! + 400 && duel.phase !== "intermission" && duel.phase !== "won" && duel.phase !== "lost"; tick++) {
    duel = advanceBellDuel(duel, request, body, 7, tick, tick - 1, presses.has(tick), e => events.push(e));
  }
  return { duel, events, cues: offsets.length };
}

describe("bell duel rhythm", () => {
  it("rings 4-8 cues and accepts the pattern started on the player's own first ring", () => {
    for (const first of [-BELL_TOLERANCE_TICKS, 0, 45, BELL_FIRST_RING_TICKS]) {
      const { duel, events, cues } = play(first, 0);
      expect(cues).toBeGreaterThanOrEqual(4);
      expect(cues).toBeLessThanOrEqual(8);
      expect(events.filter(e => e.kind === "bell.cue")).toHaveLength(cues);
      expect(duel.wins, `first ring at ${first}`).toBe(1);
    }
  });
  it("loses the round when a later ring misses ±120 ms, or the first ring never comes", () => {
    expect(play(0, BELL_TOLERANCE_TICKS + 1).duel.losses).toBe(1);
    expect(play(0, -BELL_TOLERANCE_TICKS - 1).duel.losses).toBe(1);
    expect(play(0, BELL_TOLERANCE_TICKS).duel.wins).toBe(1);
    expect(play(BELL_FIRST_RING_TICKS + 1, 0).duel.losses).toBe(1);
  });
});
