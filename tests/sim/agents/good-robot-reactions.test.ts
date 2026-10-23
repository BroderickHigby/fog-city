import { describe, expect, it } from "vitest";
import type { AgentState } from "../../../src/sim/agents.ts";
import { Action, DT, NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { stepRuntimeSpatial, type RuntimeSpatialInput } from "../../../src/sim/agents/runtime-spatial.ts";
import type { RobotMovementIntent } from "../../../src/sim/robots/brain.ts";

const world = buildWorld([]);
const navigation = buildSidewalkGraph({
  nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 100, z: 0 }],
  edges: [{ id: "walk", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [100, 0]] }],
});

function robot(vmax = 1.5): AgentState {
  return { id: 1, kind: "errandRobot", x: 10, y: 0, z: 0, heading: Math.PI / 2, pitch: 0, speed: vmax, vmax,
    edge: "street", dir: 1, lane: 1, s: 10, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 192837, dodge: null };
}

function fixture(actions: number, movement: RobotMovementIntent = { kind: "errand", avoidFog: false }, vmax = 1.5): RuntimeSpatialInput {
  const base = createInitialState(world, 17, ["p"], { x: 1000, z: 1000, heading: 0 });
  const player = { ...base.players.p!, mode: "foot" as const, foot: makeFoot(9, 0, 0, 0) };
  const before = robot(vmax);
  const after = { ...before, x: before.x + before.vmax * DT, s: before.s + before.vmax * DT };
  const previous = { ...base, players: { p: player }, ext: { ...base.ext, agents: { nextId: 2, list: [before] } } };
  const state = { ...previous, tick: 1, ext: { ...previous.ext, agents: { nextId: 2, list: [after] } } };
  return { context: { world, previous, state, inputs: { p: { ...NEUTRAL_INPUT, actions } }, events: [] },
    actors: [after], anchors: [{ id: "p", x: 9, z: 0 }], navigation,
    robotIntents: [{ id: before.id, movement }], animalLimit: { pigeons: 0, dogs: 0 } };
}

describe("good robot reactions during ordinary errands", () => {
  it("glances at a sensed scan even when the runtime supplied an errand intent", () => {
    const input = fixture(Action.scan);
    const before = JSON.stringify(input);
    const result = stepRuntimeSpatial(input);
    expect(result.metadata[0]?.reaction).toBe("glance");
    expect(result.state.walkers[0]?.reaction.source?.id).toBe("p");
    expect(result.actors[0]).toMatchObject({ x: 10, z: 0, speed: 0 });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("startles at a nearby horn instead of continuing the supplied errand", () => {
    const result = stepRuntimeSpatial(fixture(Action.horn));
    expect(result.metadata[0]?.reaction).toBe("startle");
    expect(result.actors[0]).toMatchObject({ x: 10, z: 0, speed: 0 });
  });

  it("moves away from sensed spray with bounded reaction movement", () => {
    const result = stepRuntimeSpatial(fixture(Action.fire));
    expect(result.metadata[0]?.reaction).toBe("avoid");
    expect(result.actors[0]!.x).toBeCloseTo(10 + 1.4 * DT);
    expect(result.actors[0]!.z).toBe(0);
    expect(result.metadata[0]!.movedM).toBeLessThanOrEqual(1.5 * DT);
  });

  it("keeps combat slowdown and immobilization during spray avoidance", () => {
    for (const vmax of [0.2, 0]) {
      const result = stepRuntimeSpatial(fixture(Action.fire, undefined, vmax));
      expect(result.metadata[0]?.reaction).toBe("avoid");
      expect(result.actors[0]!.x).toBeCloseTo(10 + vmax * DT);
      expect(result.actors[0]!.z).toBe(0);
      expect(result.actors[0]!.speed).toBeCloseTo(vmax);
      expect(result.metadata[0]!.movedM).toBeLessThanOrEqual(vmax * DT + 1e-12);
    }
  });

  it("keeps an explicit combat hold immobile despite all nearby stimuli", () => {
    const movement: RobotMovementIntent = { kind: "hold", face: null, avoidFog: false };
    const result = stepRuntimeSpatial(fixture(Action.fire | Action.horn | Action.scan, movement));
    expect(result.actors[0]).toMatchObject({ x: 10, z: 0, speed: 0 });
    expect(result.metadata[0]?.reaction).toBe("idle");
    expect(result.metadata[0]?.movedM).toBe(0);
  });

  it("retains authoritative pursuit and flight when stimuli would otherwise interrupt movement", () => {
    const movements: RobotMovementIntent[] = [
      { kind: "pursue", target: { kind: "player", id: "p" }, destination: { x: 90, z: 0 }, stopDistance: 1, avoidFog: false },
      { kind: "flee", from: { x: 9, z: 0 }, toward: { x: 90, z: 0 }, avoidFog: false },
    ];
    for (const movement of movements) {
      const baseline = stepRuntimeSpatial(fixture(0, movement));
      const distracted = stepRuntimeSpatial(fixture(Action.fire | Action.horn | Action.scan, movement));
      expect(distracted).toEqual(baseline);
      expect(distracted.metadata[0]?.reaction).toBe("idle");
    }
  });
});
