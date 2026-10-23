import { expect, it } from "vitest";
import { captureProgression, restoreProgression } from "../../../src/save/progression.ts";
import { Action, NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { createPlayerSystems, defaultGameplayProvider, gameplaySnapshot } from "../../../src/sim/player/adapter.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

it("settles activity rewards before immediate save, exactly once across reload", () => {
  const world = buildWorld([]);
  const systems = createPlayerSystems(context => ({
    ...defaultGameplayProvider(context),
    wave: 4,
    missions: [],
    activities: [{
      id: "soma-delivery", kind: "delivery", wave: 2, x: 0, y: 0, z: 0, radius: 5,
      rewardCents: 7500, rewardXp: 100, objective: { event: "delivery.completed", count: 1 },
      checkpoints: [{ id: "drop", x: 0, y: 0, z: 0, radius: 5 }],
    }],
  }));
  const initial = () => createInitialState(world, 17, ["p1"], { x: 0, z: 0, heading: 0 });
  const inputs = { p1: { ...NEUTRAL_INPUT, actions: Action.interact } };
  let city = step(world, initial(), inputs, [{
    tick: 1, kind: "gameplay.command", playerId: "p1",
    payload: { kind: "activity-start", targetId: "soma-delivery", sequence: 1 },
  }], systems);
  for (let n = 0; n < 59; n++) city = step(world, city, inputs, [], systems);
  expect(gameplaySnapshot({ state: city }).activities.players.p1!.completedIds).toEqual([]);

  city = step(world, city, inputs, [], systems);
  const completed = gameplaySnapshot({ state: city });
  expect(completed.activities.players.p1!.completedIds).toEqual(["soma-delivery"]);
  expect(completed.economy.players.p1!.cashCents).toBe(207500);
  expect(completed.progression.players.p1!.xp).toBe(100);

  // A checkpoint autosave or manual save can occur now,
  // without another simulation tick to consume the activity's reward events.
  const document = captureProgression(city, "p1");
  const fresh = step(world, initial(), {}, [], systems);
  const restored = restoreProgression(fresh, document, "p1");
  const resumed = step(world, restored, inputs, [], systems);
  const replayed = step(world, city, inputs, [], systems);
  for (const state of [restored, resumed, replayed]) {
    const view = gameplaySnapshot({ state });
    expect(view.economy.players.p1!.cashCents).toBe(207500);
    expect(view.progression.players.p1!.xp).toBe(100);
    expect(view.activities.players.p1!.completedIds).toEqual(["soma-delivery"]);
  }

});
