import { describe, expect, it } from "vitest";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_LADDER } from "../../../src/sim/activities/plain-words.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { ACTIVITY_RULES } from "../../../src/content/gameplay.ts";
import type { ActivitiesState, GameplayContext, GameplayFact, WaterTrace } from "../../../src/sim/player/types.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";

const activity = DEFAULT_CATALOG.activities.find(value => value.id === "plain-words")!;
type Patch = Partial<GameplayContext> & { at?: { x: number; z: number } };
function context(patch: Patch = {}): GameplayContext {
  const at = patch.at ?? activity;
  return { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: at.x, y: 0, z: at.z, mode: "foot", speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], day: 1, month: 1, ...patch };
}
/** A stream particle passing through a board at the given height above the ground. */
const spray = (board: { x: number; z: number }, height = .6): WaterTrace => ({ playerId: "p", ax: board.x - 1, az: board.z, ah: height, bx: board.x + 1, bz: board.z, bh: height });
function started(): ActivitiesState {
  return stepActivities(createActivities(), context({ commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: "plain-words" }] }), 1, createMissions(), 7);
}
function step(state: ActivitiesState, tick: number, patch: Patch = {}): ActivitiesState {
  return stepActivities(state, context(patch), tick, createMissions(), 7);
}
const spinner = (state: ActivitiesState, index: number, at: { x: number; z: number }): CombatActor =>
  ({ id: state.players.p!.plainWords!.spinnerIds[index]!, kind: "robot", firmware: "bad", x: at.x, y: 0, z: at.z, heading: 0, speed: 0, radius: .45, height: 1.6 }) as CombatActor;

describe("Plain Words", () => {
  it("is offered, with twenty boards on the authored corridor showing the first hype word", () => {
    expect(activity).toBeDefined();
    const state = started(), run = state.players.p!.plainWords!;
    expect(state.players.p!.activeActivityId).toBe("plain-words");
    expect(run.boards).toHaveLength(ACTIVITY_RULES.plainWords.boardCount);
    expect(run.boards.every(board => board.word === 0)).toBe(true);
    expect(run.spinnerIds).toHaveLength(ACTIVITY_RULES.plainWords.spinnerCount);
    const request = state.events.find(value => value.kind === "mission.scene-request")!;
    const scene = JSON.parse(request.detail) as { actors: { id: string; firmware: string }[] };
    expect(scene.actors.map(value => value.id)).toEqual(run.spinnerIds);
    expect(scene.actors.every(value => value.firmware === "bad")).toBe(true);
  });

  it("washes a board after two seconds of the player's own stream, and only then", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[0]!;
    for (let tick = 2; tick < 2 + 119; tick++) state = step(state, tick, { waterTraces: [spray(board)] });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(0);
    state = step(state, 121, { waterTraces: [spray(board)] });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(-1);
    expect(state.players.p!.objectiveCount).toBe(1);
    expect(state.events.map(value => value.kind)).toContain("board.washed");
  });

  it("ignores water that passes over a board, someone else's water, and claimed washes", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[1]!, claim: GameplayFact = { id: "spoof", source: "world", sequence: 1, tick: 2, kind: "board.washed", playerId: "p", actorId: board.id };
    for (let tick = 2; tick < 400; tick++) state = step(state, tick, { waterTraces: [spray(board, 2.5), { ...spray(board), playerId: "q" }], facts: tick === 2 ? [claim] : [] });
    expect(state.players.p!.plainWords!.boards[1]!.word).toBe(0);
    expect(state.players.p!.objectiveCount).toBe(0);
  });

  it("lets a standing spinner rebrand a washed board, climbing the ladder every four rebrands", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[0]!;
    for (let tick = 2; tick <= 121; tick++) state = step(state, tick, { waterTraces: [spray(board)] });
    const robot = spinner(state, 0, { x: board.x + 3, z: board.z });
    const due = state.players.p!.plainWords!.nextRebrandTick;
    state = step(state, due, { actorBodies: [robot] });
    const run = state.players.p!.plainWords!;
    expect(run.boards[0]!.word).toBe(0);
    expect(run.rebrands).toBe(1);
    expect(state.events.map(value => value.kind)).toContain("plainWords.rebranded");
    expect(PLAIN_WORDS_LADDER).toEqual(ACTIVITY_RULES.plainWords.ladder);
  });

  it("stops a rusted spinner and pays only with twenty washes, every spinner rusted and the route walked", () => {
    let state = started();
    const run = state.players.p!.plainWords!;
    const heaps: GameplayFact[] = run.spinnerIds.map((id, index) => ({ id: `combat:${index + 1}`, source: "combat", sequence: index + 1, tick: 2, kind: "robot.heap", playerId: "p", actorId: id }));
    state = step(state, 2, { facts: heaps });
    expect(state.players.p!.plainWords!.rusted).toEqual(run.spinnerIds);
    // A rusted spinner never rebrands, even standing next to a plain board.
    let tick = 3;
    for (const board of PLAIN_WORDS_BOARDS) {
      for (let i = 0; i < 120; i++) state = step(state, tick++, { at: board, waterTraces: [spray(board)], actorBodies: [spinner(state, 0, board)] });
    }
    expect(state.players.p!.plainWords!.rebrands).toBe(0);
    expect(state.players.p!.objectiveCount).toBe(20);
    expect(state.events.some(value => value.kind === "activity.finished")).toBe(false);
    for (const checkpoint of activity.checkpoints!) state = step(state, tick++, { at: checkpoint });
    expect(state.events.map(value => value.kind)).toEqual(["activity.cash", "activity.xp", "activity.finished"]);
    expect(state.players.p!.plainWords).toBeUndefined();
    expect(state.players.p!.completedIds).toEqual(["plain-words"]);
  });

  it("fails and clears the run when time runs out", () => {
    let state = started();
    state = step(state, 2 + 60 * ACTIVITY_RULES.plainWords.timeLimitS);
    expect(state.events.map(value => value.kind)).toEqual(["activity.failed"]);
    expect(state.players.p!.plainWords).toBeUndefined();
  });
});
