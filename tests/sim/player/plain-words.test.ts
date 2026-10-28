import { describe, expect, it } from "vitest";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_LADDER, plainWordsComplete, plainWordsSpinnersDone, stepPlainWords } from "../../../src/sim/activities/plain-words.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { ACTIVITY_RULES } from "../../../src/content/gameplay.ts";
import { decodeMissionScene } from "../../../src/sim/agents/scene-actors.ts";
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
  return stepActivities(createActivities(), context({ commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: "plain-words" }] }), 1, createMissions(), 7, 24);
}
function step(state: ActivitiesState, tick: number, patch: Patch = {}): ActivitiesState {
  return stepActivities(state, context(patch), tick, createMissions(), 7, 24);
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
    // The agents runtime accepts the request as a scene it can stage.
    expect(decodeMissionScene({ kind: request.kind, detail: request.detail })?.actors).toHaveLength(run.spinnerIds.length);
  });

  it("washes a board after two seconds of the player's own stream, and only then", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[0]!;
    for (let tick = 2; tick < 2 + 119; tick++) state = step(state, tick, { waterTraces: [spray(board)] });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(0);
    state = step(state, 121, { waterTraces: [spray(board)] });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(-1);
    expect(state.players.p!.objectiveCount).toBe(1);
    expect(state.players.p!.plainWords!.washed).toBe(1);
    expect(state.players.p!.plainWords!.boards[0]!.qualified).toBe(true);
    expect(state.events.map(value => value.kind)).toContain("board.washed");
  });

  it("ignores water that passes over a board, someone else's water, and claimed washes", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[1]!, claim: GameplayFact = { id: "spoof", source: "world", sequence: 1, tick: 2, kind: "board.washed", playerId: "p", actorId: board.id };
    const miss = { ...spray(board), az: board.z + 2, bz: board.z + 2 };
    for (let tick = 2; tick < 400; tick++) state = step(state, tick, { waterTraces: [spray(board, 2.5), miss, { ...spray(board), playerId: "q" }], facts: tick === 2 ? [claim] : [] });
    expect(state.players.p!.plainWords!.boards[1]!.word).toBe(0);
    expect(state.players.p!.objectiveCount).toBe(0);
    expect(state.players.p!.plainWords!.washed).toBe(0);
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

  it("cleans a rebranded board again without counting the same board twice", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[0]!;
    for (let tick = 2; tick <= 121; tick++) state = step(state, tick, { waterTraces: [spray(board)] });
    const due = state.players.p!.plainWords!.nextRebrandTick;
    state = step(state, due, { actorBodies: [spinner(state, 0, { x: board.x + 3, z: board.z })] });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(0);
    const events: string[] = [];
    for (let tick = due + 1; tick <= due + 120; tick++) {
      state = step(state, tick, { waterTraces: [spray(board)] });
      events.push(...state.events.map(value => value.kind));
    }
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(-1);
    expect(state.players.p!.plainWords!.washed).toBe(1);
    expect(state.players.p!.objectiveCount).toBe(1);
    expect(events).not.toContain("board.washed");
    expect(state.players.p!.activeActivityId).toBe("plain-words");
  });

  it("qualifies a made-by-humans board once even when several spinners rebrand it repeatedly", () => {
    const state = started(), run = state.players.p!.plainWords!, board = PLAIN_WORDS_BOARDS[0]!;
    // A plain board without a first-qualification flag models a not-yet-counted holdout.
    run.boards[0]!.word = -1;
    run.rung = PLAIN_WORDS_LADDER.length - 1;
    const robots = [spinner(state, 0, board), spinner(state, 1, board)];
    const due = run.nextRebrandTick;
    state.events = [];
    expect(stepPlainWords(run, context({ actorBodies: robots }), "p", due, [], state)).toBe(1);
    expect(run.washed).toBe(1);
    expect(state.events.filter(event => event.kind === "board.washed")).toHaveLength(1);
    expect(state.events.find(event => event.kind === "board.washed")?.detail).toBe("made-by-humans");
    state.events = [];
    expect(stepPlainWords(run, context({ actorBodies: robots }), "p", run.nextRebrandTick, [], state)).toBe(0);
    expect(run.washed).toBe(1);
    expect(state.events.filter(event => event.kind === "board.washed")).toHaveLength(0);
  });

  it("rejects claimed spinner heaps and combat events without the measured rust state", () => {
    let state = started();
    const run = state.players.p!.plainWords!, id = run.spinnerIds[0]!;
    const fact: GameplayFact = { id: "world:1", source: "world", sequence: 1, tick: 2, kind: "robot.heap", playerId: "p", actorId: id };
    state = step(state, 2, { facts: [fact], rustByActor: { [id]: 1 } });
    expect(state.players.p!.plainWords!.rusted).toEqual([]);
    state = step(state, 3, { facts: [{ ...fact, id: "combat:1", source: "combat", tick: 3 }], rustByActor: { [id]: .9 } });
    expect(state.players.p!.plainWords!.rusted).toEqual([]);
    state = step(state, 4, { facts: [{ ...fact, id: "combat:2", source: "combat", sequence: 2, tick: 4 }], rustByActor: { [id]: 1 } });
    expect(state.players.p!.plainWords!.rusted).toEqual([id]);
    expect(plainWordsSpinnersDone(state.players.p!.plainWords)).toBe(false);
  });

  it("requires every distinct authored board and exact spinner id even if stored counts are inflated", () => {
    const run = started().players.p!.plainWords!;
    run.washed = 100;
    run.rusted = [...run.spinnerIds];
    run.boards[0]!.qualified = true;
    expect(plainWordsComplete(run)).toBe(false);
    for (const board of run.boards) board.qualified = true;
    expect(plainWordsComplete(run)).toBe(true);
    run.rusted = run.spinnerIds.map(() => run.spinnerIds[0]!);
    expect(plainWordsSpinnersDone(run)).toBe(false);
    expect(plainWordsComplete(run)).toBe(false);
  });

  it("stops a seizing spinner's rebrands before the heap event, without awarding its completion early", () => {
    let state = started();
    const board = PLAIN_WORDS_BOARDS[0]!;
    for (let tick = 2; tick <= 121; tick++) state = step(state, tick, { waterTraces: [spray(board)] });
    const run = state.players.p!.plainWords!, robot = spinner(state, 0, board);
    state = step(state, run.nextRebrandTick, { actorBodies: [robot], rustByActor: { [robot.id]: 1 } });
    expect(state.players.p!.plainWords!.boards[0]!.word).toBe(-1);
    expect(state.players.p!.plainWords!.rusted).toEqual([]);
    expect(state.events.map(value => value.kind)).not.toContain("plainWords.rebranded");
    expect(plainWordsSpinnersDone(state.players.p!.plainWords)).toBe(false);
  });

  it("stops a rusted spinner and pays only with twenty washes and every spinner rusted", () => {
    let state = started();
    const run = state.players.p!.plainWords!;
    const heaps: GameplayFact[] = run.spinnerIds.map((id, index) => ({ id: `combat:${index + 1}`, source: "combat", sequence: index + 1, tick: 2, kind: "robot.heap", playerId: "p", actorId: id }));
    state = step(state, 2, { facts: heaps, rustByActor: Object.fromEntries(run.spinnerIds.map(id => [id, 1])) });
    expect(state.players.p!.plainWords!.rusted).toEqual(run.spinnerIds);
    // A rusted spinner never rebrands, even standing next to a plain board.
    let tick = 3;
    const seen: string[] = [];
    for (const board of PLAIN_WORDS_BOARDS) {
      for (let i = 0; i < 120 && state.players.p!.activeActivityId; i++) {
        state = step(state, tick++, { at: board, waterTraces: [spray(board)], actorBodies: [spinner(state, 0, board)] });
        seen.push(...state.events.map(value => value.kind));
      }
    }
    expect(seen).not.toContain("plainWords.rebranded");
    expect(seen.filter(kind => kind === "board.washed")).toHaveLength(20);
    // The twentieth wash with every spinner rusted pays at once; the corridor needs no route.
    expect(seen.slice(-3)).toEqual(["activity.cash", "activity.xp", "activity.finished"]);
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
