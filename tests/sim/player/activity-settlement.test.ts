import { expect, it } from "vitest";
import { Action, NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { createPlayerSystems, defaultGameplayProvider, gameplaySnapshot } from "../../../src/sim/player/adapter.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

it("settles authoritative activity rewards immediately and exactly once on later ticks", () => {
  const world = buildWorld([]);
  const systems = createPlayerSystems(context => ({
    ...defaultGameplayProvider(context),
    wave: 2,
    missions: [],
    facts: context.state.tick === 61 ? [{ id: "activity:complete", tick: 61, source: "world", sequence: 1, kind: "activity.objective-complete", playerId: "p1", actorId: "soma-delivery" }] : [],
    activities: [{
      id: "soma-delivery", kind: "delivery", wave: 2, x: 0, y: 0, z: 0, radius: 5,
      rewardCents: 7500, rewardXp: 100,
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

  // The online branch has no save/UI host. Confirm the authoritative wallet is
  // already settled when completion publishes and cannot pay again later.
  let resumed = city;
  for (let tick = 0; tick < 120; tick++) {
    resumed = step(world, resumed, inputs, [], systems);
    const view = gameplaySnapshot({ state: resumed });
    expect(view.economy.players.p1!.cashCents).toBe(207500);
    expect(view.progression.players.p1!.xp).toBe(100);
    expect(view.activities.players.p1!.completedIds).toEqual(["soma-delivery"]);
  }
  expect(city.tick).toBe(61);
});
