import { describe, expect, it } from "vitest";
import { createActivities, missionEngaged, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissionProgress, createMissions, missionPlace, stepMissions } from "../../../src/sim/missions/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import type { GameplayContext, MissionState } from "../../../src/sim/player/types.ts";

const sprint = DEFAULT_CATALOG.activities.find(value => value.id === "embarcadero-sprint")!;
function context(at: { x: number; z: number }, patch: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: at.x, y: 0, z: at.z, mode: "vehicle", speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], day: 1, month: 1, ...patch };
}
/** Launch Day queued by the campaign, waiting for the player to reach Washington Square. */
function waiting(stepId = "start"): MissionState {
  return { ...createMissions(), players: { p: { ...createMissionProgress(), missionId: "launch-day", stepId, status: "active", completedIds: ["hot-desk", "spill"] } } };
}

describe("side activities beside the campaign", () => {
  it("treats a campaign mission waiting at its start area as not engaged", () => {
    expect(missionEngaged(waiting().players.p, DEFAULT_CATALOG)).toBe(false);
    expect(missionEngaged(waiting("watch").players.p, DEFAULT_CATALOG)).toBe(true);
    expect(missionEngaged(undefined, DEFAULT_CATALOG)).toBe(false);
    // A phone call waiting for acknowledgement is a dialogue on screen, so it still holds the city.
    const spill = MISSIONS.find(value => value.id === "spill")!, first = spill.steps.find(value => value.id === (spill.start ?? spill.steps[0]!.id))!;
    expect(first.type === "trigger" && first.event.kind === "phoneCall").toBe(true);
    expect(missionEngaged({ ...createMissionProgress(), missionId: "spill", stepId: first.id, status: "active" }, DEFAULT_CATALOG)).toBe(true);
  });

  it("starts an activity while the next campaign mission only waits for its start area", () => {
    const ctx = context(sprint, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: sprint.id }] });
    const state = stepActivities(createActivities(), ctx, 1, waiting(), 7, 27);
    expect(state.players.p!.activeActivityId).toBe(sprint.id);
    expect(state.events.map(value => value.kind)).toEqual(["activity.started"]);
  });

  it("still refuses an activity during an engaged mission step", () => {
    const ctx = context(sprint, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: sprint.id }] });
    expect(stepActivities(createActivities(), ctx, 1, waiting("watch"), 7, 27).players.p!.activeActivityId).toBe("");
  });

  it("holds the campaign start area while an activity runs, then lets it fire", () => {
    const square = MISSIONS.find(value => value.id === "launch-day")!.steps[0]!;
    if (square.type !== "trigger" || square.event.kind !== "enterArea") throw new Error("Launch Day starts in an area");
    const ctx = context(missionPlace(square.event.place));
    const busy = { events: [], players: { p: { ...createActivities().players.p, activeActivityId: sprint.id } as never } };
    expect(stepMissions(waiting(), ctx, 2, createHeat(), createPlayer(), 0, busy).players.p!.stepId).toBe("start");
    expect(stepMissions(waiting(), ctx, 2, createHeat(), createPlayer(), 0, createActivities()).players.p!.stepId).not.toBe("start");
  });
});
