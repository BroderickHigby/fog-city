import { describe, expect, it } from "vitest";
import { applyMotionBodies, prepareMotionBodies, type AgentMotionProposal } from "../../src/sim/motion.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { createInitialState, step } from "../../src/sim/step.ts";
import { makeFoot } from "../../src/sim/foot.ts";
import { createCombatState } from "../../src/sim/combat/system.ts";
import { initialTarget } from "../../src/sim/combat/shared.ts";
import { Action, DT } from "../../src/sim/contract.ts";
import { deepFreeze } from "../helpers.ts";

const world = buildWorld([]);
const vehicle: AgentMotionProposal = {
  id: "service:taxi", numericId: 100, legacyId: null, kind: "vehicle", bodyKind: "robot",
  x: 10, y: 0, z: 10, sourceX: 10, sourceY: 0, sourceZ: 10, heading: 0, speed: 0,
  radius: 1, height: 1.5, halfLength: 2.2, halfWidth: .95,
  controls: { throttle: 1, steer: 0, brake: 0, actions: 0 },
};
function ready(targetId = vehicle.id) {
  const state = prepareMotionBodies(world, createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 }), [vehicle]);
  const combat = createCombatState(1, { actors: [], players: [], walls: [], refills: [] });
  combat.targets[targetId] = { ...initialTarget(), pullOverTick: 180, pullOverSpeed: 6, stoppedUntil: 600 };
  state.ext.combat = combat;
  return state;
}

describe("combat effects reach physical runtime bodies", () => {
  it.each([vehicle.id, "agent:100"])("caps actual vehicle displacement and releases the %s identity", targetId => {
    let state = ready(targetId);
    for (const tick of [1, 90, 179, 180, 240]) {
      const before = state.ext.agents!.list[0]!;
      state = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, tick } } };
      const frozen = deepFreeze(state);
      state = applyMotionBodies(world, frozen, [vehicle]);
      const body = state.ext.agents!.list[0]!;
      const cap = tick >= 180 ? 0 : 6 * (180 - tick) / 180;
      expect(Math.abs(body.speed)).toBeLessThanOrEqual(cap + 1e-10);
      expect(Math.sqrt((body.x-before.x)*(body.x-before.x)+(body.z-before.z)*(body.z-before.z))).toBeLessThanOrEqual(cap * DT + 1e-10);
    }
    const stopped = state.ext.agents!.list[0]!;
    state = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, tick: 600, targets: {} } } };
    const released = applyMotionBodies(world, state, [vehicle]).ext.agents!.list[0]!;
    expect(released.speed).toBeGreaterThan(0);
    expect(released.z).toBeLessThan(stopped.z);
  });

  it("applies slow and disabled effects to walkers before accepted movement", () => {
    const walker = { ...vehicle, id: "walker", kind: "walker" as const, controls: undefined, x: 10, z: 9, speed: 6 };
    let state = prepareMotionBodies(world, createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 }), [walker]);
    const combat = createCombatState(1, { actors: [], players: [], walls: [], refills: [] });
    combat.targets.walker = { ...initialTarget(), movementScale: .5 };
    state.ext.combat = combat;
    const slowed = applyMotionBodies(world, state, [walker]);
    expect(10 - slowed.ext.agents!.list[0]!.z).toBeCloseTo(3 * DT, 8);
    const stopped = { ...slowed, ext: { ...slowed.ext, combat: { ...combat, targets: { walker: { ...initialTarget(), phase: "disabled" as const } } } } };
    expect(applyMotionBodies(world, stopped, [walker]).ext.agents!.list[0]!.z).toBe(slowed.ext.agents!.list[0]!.z);
  });

  it.each(["p", "player:p"])("applies player movement effects stored as %s without discarding actions", id => {
    let state = createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 });
    state.players.p = { ...state.players.p!, mode: "foot", foot: makeFoot(4, 0, 0, 0) };
    const combat = createCombatState(1, { actors: [], players: [], walls: [], refills: [] });
    combat.targets[id] = { ...initialTarget(), stoppedUntil: 100 };
    state.ext.combat = combat;
    let observedActions = 0;
    const next = step(world, deepFreeze(state), { p: { throttle: 1, steer: 1, brake: 1, actions: Action.fire } }, [], [{ key: "robots", step: context => { observedActions = context.inputs.p!.actions; return context.state; } }]);
    expect(next.players.p!.foot!.x).toBe(4);
    expect(next.players.p!.foot!.z).toBe(0);
    expect(next.players.p!.foot!.speed).toBe(0);
    expect(observedActions).toBe(Action.fire);
    const released = { ...next, ext: { ...next.ext, combat: { ...combat, tick: 100, targets: {} } } };
    expect(step(world, released, { p: { throttle: 1, steer: 0, brake: 0, actions: 0 } }, [], []).players.p!.foot!.z).toBeLessThan(0);
  });
});
