import { describe, expect, it } from "vitest";
import { NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import type { CombatActor, Gadget } from "../../../src/sim/combat-contract.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createRobotRuntime, stepRobotRuntime } from "../../../src/sim/robots/runtime.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";
import { createRuntimeVisualSensor, microclimateOccludes, recordedMicroclimates } from "../../../src/sim/agents/runtime-sight.ts";

const world = buildWorld([]);
const robot: CombatActor = { id: "agent:1", kind: "robot", firmware: "bad", model: "footman", x: 0, y: 0, z: 0,
  heading: 0, speed: 0, height: 1.8, radius: 0.4, inFidelity: true };
// Recorded combat6 gadget shape. The current combat producer intentionally remains unchanged.
function fog(extra: Record<string, unknown> = {}): unknown {
  return { id: 1, kind: "microclimate", ownerId: "p", x: 0, y: 0, z: -10, radius: 8, untilTick: 1200,
    targetId: "", progress: 0, boost: "salt", ...extra };
}
function state(gadgets: readonly unknown[] = []): SimState {
  const result = createInitialState(world, 17, ["p"], { x: 0, z: -20, heading: 0 });
  result.players.p = { ...result.players.p!, mode: "foot", foot: makeFoot(0, 0, -20, 0) };
  result.ext.combat = createCombatState(17, { actors: [robot], players: [], walls: [], refills: [] });
  result.ext.combat.gadgets = gadgets as Gadget[];
  return result;
}
function context(previous: SimState) {
  return { world, previous, state: { ...previous, tick: previous.tick + 1 }, inputs: { p: NEUTRAL_INPUT }, events: [] };
}

describe("recorded microclimate visual sensors", () => {
  it("does not produce weather and ignores other, malformed or expired gadget records", () => {
    const source = state([fog({ kind: "sprinkler" }), fog({ radius: NaN }), fog({ x: Infinity }), fog({ ownerId: "" }),
      fog({ id: -1 }), fog({ untilTick: 1 }), fog({ untilTick: 0 }), null, fog({ radius: 129 })]);
    const before = JSON.stringify(source);
    expect(recordedMicroclimates(source, 1)).toEqual([]);
    expect(createRuntimeVisualSensor(context(source))(robot, source.players.p!.foot!)).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
    expect(recordedMicroclimates(state())).toEqual([]);
  });

  it("matches sphere-ray occlusion through edges, endpoints and altitude", () => {
    const zones = recordedMicroclimates(state([fog({ x: 0, y: 0, z: 0, radius: 2 })]));
    expect(microclimateOccludes(zones, { x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 })).toBe(true);
    expect(microclimateOccludes(zones, { x: -5, y: 2, z: 0 }, { x: 5, y: 2, z: 0 })).toBe(true);
    expect(microclimateOccludes(zones, { x: -5, y: 2.01, z: 0 }, { x: 5, y: 2.01, z: 0 })).toBe(false);
    expect(microclimateOccludes(zones, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(microclimateOccludes(zones, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 0 })).toBe(false);
  });

  it("uses a fresh immutable sensing snapshot and expires at the current sensing tick", () => {
    const previous = state([fog({ untilTick: 2 })]), before = JSON.stringify(previous);
    const first = createRuntimeVisualSensor(context(previous));
    expect(first(robot, previous.players.p!.foot!)).toBe(false);
    const next = { ...previous, tick: 1, ext: { ...previous.ext, combat: { ...previous.ext.combat!, tick: 1 } } };
    expect(createRuntimeVisualSensor(context(next))(robot, previous.players.p!.foot!)).toBe(true);
    expect(first(robot, previous.players.p!.foot!)).toBe(false);
    expect(JSON.stringify(previous)).toBe(before);
  });

  it("keeps indexed rays identical to exhaustive sphere tests across cell boundaries", () => {
    const gadgets = Array.from({ length: 200 }, (_, id) => fog({ id, x: id * 131 - 12000, y: id % 7, z: id % 5 * 137 - 300, radius: 2 + id % 120 }));
    const previous = state(gadgets), zones = recordedMicroclimates(previous, 1), visible = createRuntimeVisualSensor(context(previous));
    for (let i = 0; i < 240; i++) {
      const from = { x: (i * 397 % 26000) - 13000, y: i % 10, z: i * 17 % 1100 - 550 };
      const to = { x: from.x + i % 300 - 150, y: from.y + 1, z: from.z + i % 80 - 40 };
      expect(visible(from, to)).toBe(!microclimateOccludes(zones, from, to));
    }
    const from = { x: -1e7, y: 3, z: -1e7 }, to = { x: 1e7, y: 3, z: 1e7 };
    expect(visible(from, to)).toBe(!microclimateOccludes(zones, from, to));
  });

  it("bounds long wall queries while retaining footprint and underpass decisions", () => {
    const collider = { id: "wall", baseY: 0, topY: 10, footprint: [[-1, -2], [1, -2], [1, 2], [-1, 2]] as [number, number][] };
    const from = { x: -1e7, y: 0, z: -1e7 }, to = { x: 1e7, y: 0, z: 1e7 };
    for (const underY of [undefined, 4.4, 4.5]) {
      const city = buildWorld([{ tileId: "0,0", ground: null, buildings: [{ ...collider, ...(underY === undefined ? {} : { underY }) }] }]);
      const ctx = { ...context(state()), world: city };
      const visible = createRuntimeVisualSensor(ctx);
      expect(visible(from, to)).toBe(underY === 4.5);
      expect(visible({ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 })).toBe(underY === 4.5);
    }
  });

  it("hides fresh robot sightings without replacing last-seen memory by unseen positions", () => {
    const initial = state(), options = { actors: [robot], conversion: { baseBadCount: 1, protectedArea: false } };
    const seen = stepRobotRuntime(createRobotRuntime(), context(initial), options);
    expect(seen.state.robots[0]!.brain!.knowledge[0]).toMatchObject({ x: 0, z: -20, observedTick: 1 });
    const hidden = { ...initial, tick: 1, players: { p: { ...initial.players.p!, foot: makeFoot(5, 0, -20, 0) } },
      ext: { ...initial.ext, combat: { ...initial.ext.combat!, tick: 1, gadgets: [fog()] as Gadget[] } } };
    const result = stepRobotRuntime(seen.state, context(hidden), options);
    expect(result.state.robots[0]!.brain!.knowledge[0]).toEqual(seen.state.robots[0]!.brain!.knowledge[0]);
    expect(stepRobotRuntime(createRobotRuntime(), context(state([fog()])), options).state.robots[0]!.brain!.knowledge).toEqual([]);
  });

  it("blocks recruit visual spotting but resumes after expiry", () => {
    const good = { ...robot, id: "agent:40", firmware: "good" as const, x: 2, z: 0 }, bad = { ...robot, id: "agent:41", x: 6, z: 0 };
    const prior = enableAgentRuntime(state([fog({ x: 4, z: 0, radius: 1, untilTick: 2 })]), { wave: 4 });
    prior.players.p = { ...prior.players.p!, foot: makeFoot(0, 0, 0, 0) };
    const routine = createRoutineRuntime(); routine.initializedOwners = ["p"];
    routine.recruits = [{ playerId: "p", state: { lastTick: 0, roster: [{ id: good.id, ownerId: "p", x: 2, y: 0, z: 0,
      phase: "follow", nextSpotTick: 0, requestSequence: 0 }] } }];
    const options = { bodies: [], actors: [good, bad], nextActorId: 1000, spawnBudget: 0 };
    const hidden = stepRoutineRuntime(context(prior), routine, options);
    expect(hidden.effects.some(effect => effect.kind === "recruit.spot")).toBe(false);
    const next = { ...prior, tick: 1, ext: { ...prior.ext, combat: { ...prior.ext.combat!, tick: 1 } } };
    const clear = stepRoutineRuntime(context(next), hidden.state, options);
    expect(clear.effects.some(effect => effect.kind === "recruit.spot" && effect.targetId === bad.id)).toBe(true);
  });
});
