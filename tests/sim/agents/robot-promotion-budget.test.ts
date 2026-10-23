import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { createRobotRuntime, stepRobotRuntime, type RobotRuntimeState } from "../../../src/sim/robots/runtime.ts";

const world = buildWorld([]);
const actors: CombatActor[] = [1, 2].map(id => ({ id: `agent:${id}`, kind: "robot", model: "footman", firmware: "good",
  x: id * 2, y: 0, z: 0, heading: 0, speed: 0, radius: 0.4, height: 1.8, inFidelity: true }));
function frame(tick = 0) {
  const state = createInitialState(world, 17, ["p"], { x: 0, z: 20, heading: 0 });
  state.tick = tick;
  state.ext.combat = createCombatState(17, { actors, players: [], walls: [], refills: [] }, tick);
  for (const actor of actors) state.ext.combat.targets[actor.id]!.rust = 0.1;
  return state;
}
function run(previous: RobotRuntimeState, state = frame(), promotionBudget?: number, promotionExemptIds?: readonly number[]) {
  return stepRobotRuntime(previous, { world, previous: state, state: { ...state, tick: state.tick + 1 }, inputs: {}, events: [] },
    { actors, conversion: { baseBadCount: 0, protectedArea: false }, promotionBudget, promotionExemptIds });
}

describe("robot promotion admission", () => {
  it("defers new wet identities at capacity and deterministically retries when a slot opens", () => {
    const deferred = run(createRobotRuntime(), frame(), 0);
    expect(deferred.state.robots.every(entry => entry.significant.length === 0 && entry.deferredSignificance?.includes("rusted"))).toBe(true);
    const admitted = run(deferred.state, frame(1), 1);
    expect(admitted.state.robots.find(entry => entry.agentId === 1)?.significant).toContain("rusted");
    expect(admitted.state.robots.find(entry => entry.agentId === 2)?.significant).toEqual([]);
    expect(admitted.state.robots.find(entry => entry.agentId === 2)?.deferredSignificance).toContain("rusted");
    const restored = run(JSON.parse(JSON.stringify(admitted.state)), frame(2), 0);
    expect(restored.state.robots.find(entry => entry.agentId === 1)?.significant).toContain("rusted");
  });

  it("does not spend new slots on already-counted significant bodies", () => {
    const result = run(createRobotRuntime(), frame(), 1, [2]);
    expect(result.state.robots.every(entry => entry.significant.includes("rusted"))).toBe(true);
    expect(result.state.robots.every(entry => !entry.deferredSignificance?.length)).toBe(true);
  });

  it("preserves standalone behavior when no registered budget is supplied", () => {
    expect(run(createRobotRuntime()).state.robots.every(entry => entry.significant.includes("rusted"))).toBe(true);
  });
});
