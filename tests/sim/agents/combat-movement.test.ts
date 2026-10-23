import { describe, expect, it } from "vitest";
import { stepAgents, type AgentState } from "../../../src/sim/agents.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { lanePath, pathPoint } from "../../../src/sim/roads.ts";

const world = buildWorld([], {
  version: 1, nodes: [{ id: "a", x: -500, z: 0 }, { id: "b", x: 500, z: 0 }],
  edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[-500, 0], [500, 0]] }],
});
world.roads = { ...world.roads!, areas: [] };

function initial() {
  const state = createInitialState(world, 11, ["p"], { x: 0, z: 40, heading: 0 });
  const point = pathPoint(lanePath(world.roads!.edges[0]!, 1, 0), 500);
  const taxi: AgentState = { id: 12, kind: "robotaxi", x: point.x, y: 0, z: point.z,
    heading: Math.PI / 2, speed: 12, vmax: 12, pitch: 0, edge: "road", dir: 1,
    lane: 0, s: 500, next: "", ndir: 1, nlane: 0, conn: null, node: "",
    resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 12, dodge: null };
  state.ext.agents = { nextId: 13, list: [taxi] };
  state.ext.combat = createCombatState(11, contextFromState(world, state));
  return state;
}

describe("legacy traffic obeys combat movement constraints", () => {
  it("applies the hood-cone speed cap to the actual lane movement", () => {
    const state = initial(), target = state.ext.combat!.targets["agent:12"]!;
    target.pullOverTick = 180;
    target.pullOverSpeed = 12;
    target.stoppedUntil = 600;
    state.ext.combat!.tick = 90;
    const old = state.ext.agents!.list[0]!;
    const taxi = stepAgents(world, state, 1)!.ext.list[0]!;
    expect(taxi.speed).toBe(6);
    expect(taxi.s - old.s).toBeCloseTo(6 / 60, 10);
    expect(old.speed).toBe(12);
    expect(taxi.vmax).toBe(12);
  });

  it("stops at a zero cap and resumes when combat releases it", () => {
    const state = initial(), target = state.ext.combat!.targets["agent:12"]!;
    target.pullOverTick = 180;
    target.pullOverSpeed = 12;
    target.stoppedUntil = 600;
    state.ext.combat!.tick = 180;
    const old = state.ext.agents!.list[0]!;
    const stopped = stepAgents(world, state, 1)!.ext;
    expect(stopped.list[0]).toMatchObject({ x: old.x, z: old.z, s: old.s, speed: 0, vmax: 12 });
    state.ext.agents = stopped;
    target.pullOverTick = 0;
    target.stoppedUntil = 0;
    state.ext.combat!.tick = 600;
    const resumed = stepAgents(world, state, 2)!.ext.list[0]!;
    expect(resumed.speed).toBeGreaterThan(0);
    expect(resumed.s).toBeGreaterThan(old.s);
    expect(resumed.vmax).toBe(12);
  });

  it("leaves unmodified combat-free lane traffic unchanged", () => {
    const state = initial();
    const withCombat = stepAgents(world, state, 1);
    delete state.ext.combat;
    expect(stepAgents(world, state, 1)).toEqual(withCombat);
  });
});
