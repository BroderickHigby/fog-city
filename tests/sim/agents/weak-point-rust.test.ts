import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { applyRust } from "../../../src/sim/combat/effects.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";
import { createFinaleState, type FinaleRoute } from "../../../src/sim/robots/finale.ts";

function walker(): CombatActor {
  return { id: "agent:2000", kind: "robot", model: "walker", firmware: "bad", x: 0, y: 0, z: 0,
    heading: 0, speed: 0, radius: 3, height: 3 };
}
function combat(actors: readonly CombatActor[]) { return createCombatState(1, { actors, players: [], walls: [], refills: [] }); }

describe("finale weak-point rust resistance", () => {
  it("uses actual routine weak-point descriptors at full water rate while the main shell stays resistant", () => {
    const world = buildWorld([]);
    const before = enableAgentRuntime(createInitialState(world, 13, ["p"], { x: 100, z: 0, heading: 0 }), { wave: 8 });
    const body: RuntimePhysicalBody = { ...walker(), numericId: 2000, kind: "robot", model: "walker", operational: true,
      previousX: 0, previousZ: 0, previousHeading: 0, halfLength: 4, halfWidth: 2, dodge: null };
    const route: FinaleRoute = { id: "weak", waypoints: [{ id: "step", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const prior = createRoutineRuntime(); prior.initializedOwners = ["p"];
    prior.finales.push({ body, route, state: createFinaleState({ kind: "walker", route, position: body, tick: 0 }), landingId: null, applied: [] });
    const result = stepRoutineRuntime({ world, previous: before, state: { ...before, tick: 1 }, inputs: {}, events: [] }, prior,
      { bodies: [body], actors: [], nextActorId: 2001, spawnBudget: 0 });
    expect(result.finaleWeakPoints).toHaveLength(4);
    const shell = walker(), state = combat([shell, ...result.finaleWeakPoints]);
    applyRust(state, shell, 0.25, "p", true);
    for (const point of result.finaleWeakPoints) applyRust(state, point, 0.25, "p", true);
    expect(state.targets[shell.id]!.rust).toBeCloseTo(0.075, 12);
    for (const point of result.finaleWeakPoints) expect(state.targets[point.id]!.rust).toBe(0.25);
  });

  it("validates explicit resistance overrides at the combat boundary", () => {
    for (const rustScale of [0, -1, 1.01, Infinity, NaN]) expect(() => combat([{ ...walker(), rustScale }])).toThrow(/rust rate/);
    const target = { ...walker(), rustScale: 0.8 }, state = combat([target]);
    applyRust(state, target, 0.25, "p", true);
    expect(state.targets[target.id]!.rust).toBe(0.2);
  });
});
