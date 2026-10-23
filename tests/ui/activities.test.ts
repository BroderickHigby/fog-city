import { describe, expect, it } from "vitest";
import { buildWorld, createInitialState, type SimState } from "../../src/sim/index.ts";
import { createActivities } from "../../src/sim/activities/system.ts";
import { createMissionProgress, createMissions } from "../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { makeCar } from "../../src/sim/car.ts";
import { uiText } from "../../src/content/ui.ts";
import { activityCopyKey, activityDestination, activityProjection } from "../../src/ui/activities.ts";

const sprint = DEFAULT_CATALOG.activities.find(value => value.id === "embarcadero-sprint")!;
function at(x: number, z: number, patch: (state: SimState) => void = () => {}): SimState {
  const state = createInitialState(buildWorld([]), 1, ["p"], { x, z, heading: 0 });
  state.players.p = { ...state.players.p!, car: makeCar(x, z, 0) };
  state.ext.activities = { ...createActivities(), players: { p: {
    nextDirectorTick: 9999, directorRng: [1, 2, 3, 4], activeCardId: "", cardUntilTick: 0, cardCooldowns: {}, activeActivityId: "",
    activityStartedTick: 0, completedIds: [], commandSequence: 0, checkpointIndex: 0, objectiveCount: 0, cooldowns: {},
  } } } as never;
  patch(state);
  return state;
}

describe("side activity panel", () => {
  it("names every offered wave-three activity in the UI copy", () => {
    for (const activity of DEFAULT_CATALOG.activities.filter(value => value.wave === 3 && value.checkpoints?.length)) {
      expect(() => uiText(activityCopyKey(activity.id))).not.toThrow();
    }
  });

  it("offers a start only at the marker, never far away or during an engaged mission", () => {
    expect(activityProjection(at(sprint.x, sprint.z), "p", 3, uiText).offer?.id).toBe(sprint.id);
    expect(activityProjection(at(sprint.x + 200, sprint.z), "p", 3, uiText).offer).toBeUndefined();
    const engaged = at(sprint.x, sprint.z, state => {
      state.ext.missions = { ...createMissions(), players: { p: { ...createMissionProgress(), missionId: "launch-day", stepId: "watch", status: "active" } } } as never;
    });
    expect(activityProjection(engaged, "p", 3, uiText).offer).toBeUndefined();
  });

  it("guides a running route to its next checkpoint and never offers a second start", () => {
    const running = at(sprint.x, sprint.z, state => {
      const own = (state.ext.activities as { players: Record<string, { activeActivityId: string; checkpointIndex: number; activityStartedTick: number }> }).players.p!;
      own.activeActivityId = sprint.id; own.checkpointIndex = 1; own.activityStartedTick = 0;
      state.tick = 600;
    });
    const view = activityProjection(running, "p", 3, uiText);
    expect(view.offer).toBeUndefined();
    expect(view.active?.detail).toBe(uiText("ui.activity.checkpoint", { label: "The Embarcadero at Harrison", index: 2, total: 3 }));
    expect(view.active?.remainingTicks).toBe(150 * 60 - 600);
    expect(activityDestination(view)).toEqual({ x: sprint.checkpoints![1]!.x, z: sprint.checkpoints![1]!.z });
  });
});
