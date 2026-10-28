import { describe, expect, it } from "vitest";
import { ACTIVITY_DEFINITIONS } from "../../../src/content/gameplay.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { Action } from "../../../src/sim/contract.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { activityAvailable } from "../../../src/sim/activities/availability.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { ActivityDefinition, GameplayContext } from "../../../src/sim/player/types.ts";

const authored = (id: string): ActivityDefinition => {
  const activity = ACTIVITY_DEFINITIONS.find(value => value.id === id)!;
  return { ...activity, ...toLocal(activity.checkpoints[0]!.lat, activity.checkpoints[0]!.lon), y: 0,
    radius: activity.checkpoints[0]!.radiusM, checkpoints: activity.checkpoints.map(point => ({
      ...point, ...toLocal(point.lat, point.lon), y: 0, radius: point.radiusM,
    })), rewardCents: activity.reward.cashCents, rewardXp: activity.reward.xp };
};
function context(activity: ActivityDefinition, patch: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: activity.x, y: activity.y, z: activity.z, mode: "foot", speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], missions: [], day: 1, month: 1,
    activities: [activity], ...patch };
}

describe("playable activity catalog", () => {
  it("offers only the wave-three routes with physical completion in the runtime", () => {
    expect(DEFAULT_CATALOG.activities.filter(value => value.wave === 3).map(value => value.id).sort())
      .toEqual(["embarcadero-sprint", "hill-delivery", "office-hours", "plain-words", "search-and-park"]);
    expect(DEFAULT_CATALOG.activities.some(value => value.id === "ramen-house")).toBe(false);
    // Coit Recon has its measured producer now (coit-viewer.ts emits recon.viewerCompleted).
    expect(DEFAULT_CATALOG.activities.some(value => value.id === "coit-recon")).toBe(true);
    expect(DEFAULT_CATALOG.activities.some(value => value.id === "soma-delivery")).toBe(true);
  });

  it.each(ACTIVITY_DEFINITIONS.filter(value => value.wave <= 3).map(value => value.id))("gives authored %s a measured producer", id => {
    expect(activityAvailable(authored(id))).toBe(true);
  });

  it("refuses an activity kind without a producer and releases a saved one with no payout", () => {
    const activity = { ...authored("embarcadero-sprint"), id: "made-up", kind: "unknownKind" }, ctx = context(activity, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: activity.id }] });
    const state = stepActivities(createActivities(), ctx, 1, createMissions(), 7, 24);
    expect(state.players.p!.activeActivityId).toBe("");
    expect(state.events).toEqual([]);
    state.players.p!.activeActivityId = activity.id;
    const restored = stepActivities(state, { ...ctx, commands: [] }, 2, createMissions(), 7, 24);
    expect(restored.players.p!.activeActivityId).toBe("");
    expect(restored.events.map(value => value.kind)).toEqual(["activity.failed"]);
  });

  it.each(["embarcadero-sprint", "hill-delivery"])("finishes %s only after ordered accepted checkpoints", id => {
    const activity = DEFAULT_CATALOG.activities.find(value => value.id === id)!;
    let ctx = context(activity, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: id }] });
    let state = stepActivities(createActivities(), ctx, 1, createMissions(), 7, 24);
    expect(state.players.p!.activeActivityId).toBe(id);
    const final = activity.checkpoints!.at(-1)!;
    ctx = { ...ctx, commands: [{ playerId: "p", sequence: 2, kind: "activity-complete", targetId: id }], bodies: [{ ...ctx.bodies[0]!, x: final.x, y: final.y, z: final.z }] };
    state = stepActivities(state, ctx, 61, createMissions(), 7, 24);
    expect(state.events.some(value => value.kind === "activity.finished")).toBe(false);
    for (const [index, point] of activity.checkpoints!.entries()) {
      ctx = { ...ctx, commands: [], actions: {}, bodies: [{ ...ctx.bodies[0]!, x: point.x, y: point.y, z: point.z }] };
      state = stepActivities(state, ctx, 62 + index, createMissions(), 7, 24);
    }
    if (activity.kind === "delivery") {
      expect(state.events.some(value => value.kind === "activity.finished")).toBe(false);
      state = stepActivities(state, { ...ctx, actions: { p: Action.interact } }, 70, createMissions(), 7, 24);
    }
    expect(state.events.map(value => value.kind)).toEqual(["activity.cash", "activity.xp", "activity.finished"]);
    expect(state.players.p!.completedIds).toEqual([id]);
    expect(stepActivities(state, ctx, 71, createMissions(), 7, 24).events).toEqual([]);
  });
});
