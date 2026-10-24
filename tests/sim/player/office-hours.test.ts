import { describe, expect, it } from "vitest";
import { Action, type SimEvent, type SimInput, type SimState } from "../../../src/sim/contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { datan2 } from "../../../src/sim/dmath.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { activityUnlocked, createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissionProgress, createMissions, stepMissions } from "../../../src/sim/missions/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { createObservedGameplayProvider, createPlayerSystems } from "../../../src/sim/player/adapter.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { agentsCombatOptions } from "../../../src/sim/agents/systems.ts";
import { runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { ActivitiesState, GameplayCommand, GameplayContext, MissionState } from "../../../src/sim/player/types.ts";

const door = DEFAULT_CATALOG.activities.find(value => value.id === "office-hours")!;
function context(patch: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: door.x, y: 0, z: door.z, mode: "foot", speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], day: 1, month: 1, ...patch };
}
const book: GameplayCommand = { playerId: "p", sequence: 1, kind: "activity-start", targetId: "office-hours" };
const done = (completedIds: string[]): MissionState => ({ ...createMissions(), players: { p: { ...createMissionProgress(), status: "complete", completedIds } } });
const after4 = ["hot-desk", "spill", "launch-day", "demoed-correctly"];

describe("Ramen Office Hours", () => {
  it("is offered at the Ramen door only once Demo'd Correctly has unlocked it", () => {
    expect(door).toBeDefined();
    expect(activityUnlocked("office-hours", ["hot-desk", "spill", "launch-day"])).toBe(false);
    expect(activityUnlocked("office-hours", after4)).toBe(true);
    expect(stepActivities(createActivities(), context({ commands: [book] }), 1, done(["hot-desk", "spill", "launch-day"]), 7).players.p!.activeActivityId).toBe("");
    expect(stepActivities(createActivities(), context({ commands: [book] }), 1, done(after4), 7).players.p!.activeActivityId).toBe("office-hours");
    expect(DEFAULT_CATALOG.activities.some(value => value.id === "ramen-house")).toBe(false);
  });

  it("starts its interview only through the booked activity, never from a direct mission request", () => {
    const missions = done(after4), direct: GameplayCommand = { playerId: "p", sequence: 1, kind: "mission-start", targetId: "office-hours" };
    expect(stepMissions(missions, context({ commands: [direct] }), 1, createHeat(), createPlayer()).players.p!.missionId).not.toBe("office-hours");
    const booked = stepActivities(createActivities(), context({ commands: [book] }), 1, missions, 7);
    const started = stepMissions(missions, context(), 2, createHeat(), createPlayer(), booked).players.p!;
    expect(started).toMatchObject({ missionId: "office-hours", status: "active", stepId: "pitch-philosopher" });
    expect(started.completedIds).toEqual(after4);
  });

  it("finishes the activity on the forwarded presentation and fails it when the mission ends without one", () => {
    const booked = stepActivities(createActivities(), context({ commands: [book] }), 1, done(after4), 7);
    const presented: MissionState = { ...done(after4), events: [
      { id: 1, tick: 900, kind: "demo.robotPresented", playerId: "p", targetId: "office-hours", amount: 0, detail: "" },
      { id: 2, tick: 900, kind: "mission.finished", playerId: "p", targetId: "office-hours", amount: 0, detail: "termSheet" },
    ] };
    const paid = stepActivities(booked, context(), 900, presented, 7);
    expect(paid.events.map(value => value.kind)).toEqual(["activity.cash", "activity.xp", "activity.finished"]);
    // Office Hours pays through the mission's outcome; the activity adds nothing on top.
    expect(paid.events.filter(value => value.kind === "activity.cash" || value.kind === "activity.xp").every(value => value.amount === 0)).toBe(true);
    const failed = stepActivities(booked, context(), 900, { ...done(after4), events: [presented.events[1]!] }, 7);
    expect(failed.events.map(value => value.kind)).toEqual(["activity.failed"]);
    // A claimed presentation fact from outside the mission never counts.
    const spoofed = stepActivities(booked, context({ facts: [{ id: "x", source: "world", sequence: 1, tick: 900, kind: "demo.robotPresented", playerId: "p" }] }), 900, done(after4), 7);
    expect(spoofed.players.p!.objectiveCount).toBe(0);
  });
});

/** The real interview and live demo in a composed game: physical robots, real water, recorded answers. */
describe("Ramen Office Hours composed", () => {
  function play(bookings: number): SimState {
    const at = { x: door.x, z: door.z };
    const hydrant = { id: "fixture-hydrant", kind: "hydrant" as const, x: at.x + 30, y: 0, z: at.z + 30, radius: 4, salt: false };
    const world = buildWorld([], null, null, { version: 1, world: "fixture", sourceSnapshot: "fixture", refills: [hydrant], anchors: [], tiles: [], territories: [] });
    let state = createInitialState(world, 319, ["p"], { x: at.x + 30, z: at.z + 30, heading: 0 });
    const progress = { ...createMissionProgress(), status: "complete" as const, completedIds: [...after4] };
    state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(at.x, 0, at.z, 0) } }, ext: { ...state.ext, missions: { ...createMissions(), players: { p: progress } } } };
    const owned = new Set(["player", "heat", "missions", "activities", "economy", "progression"]);
    const observed = createObservedGameplayProvider({ wave: 3, actors: c => contextFromState(c.world, c.state, agentsCombatOptions(c.state)).actors, protectedArea: () => false });
    const systems = [...createGameSystems({ wave: 3, protectedArea: () => false }).filter(system => !owned.has(system.key)), ...createPlayerSystems(observed)];
    let sequence = 0;
    const tick = (actions = 0, command?: Omit<GameplayCommand, "playerId" | "sequence">) => {
      const events: SimEvent[] = command ? [{ tick: state.tick + 1, kind: "gameplay.command", playerId: "p", payload: { ...command, sequence: ++sequence } }] : [];
      const input: SimInput = { throttle: 0, steer: 0, brake: 1, actions, ...((actions & Action.fire) ? { aimPitch: -.25 } : {}) };
      state = step(world, state, { p: input }, events, systems);
    };
    const place = (x: number, z: number, heading = 0) => { state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(x, 0, z, heading) } } }; };
    const actorId = (alias: string) => state.ext.robots?.missionBindings[`p:office-hours:${alias}`] ?? `mission:office-hours:${alias}`;
    const face = (alias: string, distance = 5) => {
      const actor = runtimeCombatActors(state).find(value => value.id === actorId(alias));
      if (!actor) throw new Error(`Missing physical ${alias}`);
      // Stand where no other demo robot shares the line of sight, so Watch reads this one.
      const others = ["demoGoodA", "demoGoodB", "demoBad"].filter(other => other !== alias).flatMap(other => runtimeCombatActors(state).filter(value => value.id === actorId(other)));
      const views = Array.from({ length: 16 }, (_, k) => {
        const angle = k * Math.PI / 8, x = actor.x + Math.sin(angle) * distance, z = actor.z - Math.cos(angle) * distance;
        const look = datan2(actor.x - x, -(actor.z - z));
        const clearance = Math.min(Math.PI, ...others.map(other => Math.abs(Math.atan2(Math.sin(datan2(other.x - x, -(other.z - z)) - look), Math.cos(datan2(other.x - x, -(other.z - z)) - look)))));
        return { x, z, look, clearance };
      }).sort((a, b) => b.clearance - a.clearance);
      place(views[0]!.x, views[0]!.z, views[0]!.look);
    };
    const mission = MISSIONS.find(value => value.id === "office-hours")!;
    for (let booking = 0; booking < bookings; booking++) {
      place(at.x, at.z);
      tick(0, { kind: "activity-start", targetId: "office-hours" });
      tick();
      expect(state.ext.missions!.players.p!.missionId).toBe("office-hours");
      for (let question = 0; question < 6; question++) {
        const current = mission.steps.find(value => value.id === state.ext.missions!.players.p!.stepId)!;
        if (current.type !== "dialogue") throw new Error(`Expected a partner question, found ${current.id}`);
        const q = current.questions[state.ext.missions!.players.p!.questionIndex]!, best = [...q.answers].sort((a, b) => b.delta - a.delta)[0]!;
        tick(0, { kind: "mission-answer", questionId: q.id, choiceId: best.id });
      }
      for (let i = 0; i < 4; i++) tick();
      expect(state.ext.missions!.players.p!.stepId).toBe("present");
      for (const alias of ["demoGoodA", "demoGoodB", "demoBad"]) for (let i = 0; i < 185; i++) { face(alias); tick(Action.watch); }
      for (let i = 0; i < 2400 && state.ext.missions!.players.p!.status === "active"; i++) {
        // A dry tank refills at the hydrant, as a player would, then the melt carries on.
        if ((state.ext.combat?.players.p?.water ?? 0) < .1) { place(hydrant.x, hydrant.z); for (let j = 0; j < 240 && (state.ext.combat?.players.p?.water ?? 0) < 8; j++) tick(Action.interact); }
        face("demoBad", 3); tick(Action.fire);
      }
      expect(state.ext.missions!.players.p).toMatchObject({ status: "idle", outcome: "termSheet" });
      expect(state.ext.activities!.players.p!.activeActivityId).toBe("");
      expect(state.ext.activities!.players.p!.completedIds).toContain("office-hours");
      expect(state.ext.combat!.targets[actorId("demoGoodA")]?.rust ?? 0).toBe(0);
      // The next booking opens after the authored cooldown.
      const until = state.ext.activities!.players.p!.cooldowns!["office-hours"]!;
      while (state.tick < until) tick();
    }
    return state;
  }
  it("pays the term-sheet outcome once per booking, through the real demo outcome", () => {
    const once = play(1), twice = play(2);
    const termSheet = (state: SimState) => state.ext.missions!.players.p!.rewardedIds.filter(id => id.startsWith("office-hours:term-sheet:"));
    expect(termSheet(once)).toHaveLength(1);
    expect(termSheet(twice)).toHaveLength(2);
    expect(twice.ext.economy!.players.p!.cashCents - once.ext.economy!.players.p!.cashCents).toBeGreaterThanOrEqual(150_000);
  }, 120_000);
});
