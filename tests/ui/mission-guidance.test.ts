import { describe, expect, it } from "vitest";
import { buildWorld, createInitialState } from "../../src/sim/index.ts";
import { createMissions, createMissionProgress } from "../../src/sim/missions/system.ts";
import { uiProjection } from "../../src/ui/projection.ts";

describe("mission evidence acknowledgement", () => {
  it("offers Continue only after the actual false-positive evidence has been recorded", () => {
    const state = createInitialState(buildWorld([]), 1, ["p"], { x: 0, z: 0, heading: 0 });
    const progress = { ...createMissionProgress(), missionId: "launch-day", stepId: "false-positive", status: "active" as const, startedTick: 1 };
    state.ext.missions = { ...createMissions(), players: { p: progress } };
    expect(uiProjection(state, "p", null, undefined, 3).interaction).toBeUndefined();
    progress.observed = { missionId: "launch-day", startedTick: 1, watched: [], falsePositives: ["mission:launch-day:courier"], melted: [], dirty: false, commandSequence: 0, previousInteract: false };
    expect(uiProjection(state, "p", null, undefined, 3).interaction?.choices.map(choice => choice.id)).toEqual(["ack"]);
  });
});
