import { expect, it } from "vitest";
import { Action, NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { createPlayerSystems, defaultGameplayProvider, gameplaySnapshot } from "../../../src/sim/player/adapter.ts";
import { applyModeSettlements } from "../../../src/sim/player/settlements.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

it("settles activity rewards before mode capture and prevents repeated payouts", () => {
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

  // This mode branch has no save host. Reward publication must still precede
  // any mode capture and remain idempotent over later simulation ticks.
  let resumed = city;
  for (let tick = 0; tick < 120; tick++) resumed = step(world, resumed, inputs, [], systems);
  for (const state of [city, resumed]) {
    const view = gameplaySnapshot({ state });
    expect(view.economy.players.p1!.cashCents).toBe(207500);
    expect(view.progression.players.p1!.xp).toBe(100);
    expect(view.activities.players.p1!.completedIds).toEqual(["soma-delivery"]);
  }

  const payout = { id: "local-1:p1", playerId: "p1", cashCents: 1000, xp: 25, achievements: [], factionClockMoves: 0 as const };
  const returned = applyModeSettlements(city, [payout]);
  const returnedAgain = applyModeSettlements(returned, [payout]);
  expect(gameplaySnapshot({ state: returnedAgain }).economy.players.p1!.cashCents).toBe(208500);
  expect(gameplaySnapshot({ state: returnedAgain }).progression.players.p1!.xp).toBe(125);
});
