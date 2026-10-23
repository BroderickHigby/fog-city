import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { robotRuntimeSystem, robotsRuntimeOf } from "../../../src/sim/robots/runtime-system.ts";

const world = buildWorld([]);
function initial() {
  const state = enableAgentRuntime(createInitialState(world, 17, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 2 });
  state.ext.robots!.reputations = { p: 10 };
  return state;
}
function step(state: ReturnType<typeof initial>) {
  return robotRuntimeSystem.step({ world, previous: state, state: { ...state, tick: 1 }, inputs: {}, events: [] });
}

describe("robot runtime economy authority", () => {
  it("uses a valid prior wallet reputation over an injected fallback without changing the wallet", () => {
    const state = initial();
    state.ext.economy = { version: 1, tick: 0, players: { p: { cashCents: 100, runwayMonths: 6, reputation: 80,
      commandSequence: 0, paidActorIds: [], ownedItemIds: [], ownedSiteIds: [] } } };
    const before = JSON.stringify(state.ext.economy);
    const result = step(state);
    expect(robotsRuntimeOf(result)?.reputations.p).toBe(80);
    expect(JSON.stringify(result.ext.economy)).toBe(before);
  });

  it("keeps the explicit fallback when no authoritative wallet exists", () => {
    const result = step(initial());
    expect(robotsRuntimeOf(result)?.reputations.p).toBe(10);
    expect(result.ext.economy).toBeUndefined();
  });
});
