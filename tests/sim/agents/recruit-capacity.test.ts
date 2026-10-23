import { describe, expect, it } from "vitest";
import type { AgentState } from "../../../src/sim/agents.ts";
import type { SimState } from "../../../src/sim/contract.ts";
import { pathPoint, walkPath, type RoadsFile } from "../../../src/sim/roads.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createAgentRuntimeSystem } from "../../../src/sim/agents/runtime-system.ts";
import { completeAgentRuntimeOf, completeAgentRuntimeSystem } from "../../../src/sim/agents/runtime-registration.ts";
import { createRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";

const roads: RoadsFile = { version: 1, nodes: [{ id: "a", x: -600, z: 0 }, { id: "b", x: 900, z: 0 },
  { id: "c", x: 900, z: 400 }, { id: "d", x: -600, z: 400 }], edges: [
  { id: "ab", a: "a", b: "b", kind: "residential", lanes: 4, oneway: false, points: [[-600, 0], [900, 0]] },
  { id: "bc", a: "b", b: "c", kind: "residential", lanes: 4, oneway: false, points: [[900, 0], [900, 400]] },
  { id: "cd", a: "c", b: "d", kind: "residential", lanes: 4, oneway: false, points: [[900, 400], [-600, 400]] },
  { id: "da", a: "d", b: "a", kind: "residential", lanes: 4, oneway: false, points: [[-600, 400], [-600, 0]] },
] };
const world = buildWorld([], roads);
function fixture(freeSlots: number): SimState {
  const point = pathPoint(walkPath(world.roads!.edges.find(edge => edge.id === "ab")!, 1, 1), 700);
  const recruit: AgentState = { id: 1, kind: "errandRobot", x: point.x, y: 0, z: point.z, heading: 1.570796, pitch: 0,
    speed: 0, vmax: 1.5, edge: "ab", dir: 1, lane: 1, s: 700, next: "", ndir: 1, nlane: 1, conn: null,
    node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 100, dodge: null };
  const initial = enableAgentRuntime(createInitialState(world, 42, ["p"], { x: 600, z: 20, heading: 0 }),
    { wave: 3, ambientMode: "squares-v1", startGameMinute: 1 });
  let state: SimState = { ...initial, ext: { ...initial.ext, robots: { ...initial.ext.robots!, significantAgentIds: [1] },
    agents: { list: [recruit], nextId: 2 } } };
  const system = createAgentRuntimeSystem({ depots: [], ferry: { x: 10000, z: 10000 }, animalLimit: { pigeons: 0, dogs: 0 } });
  for (let index = 0; index < 24; index++) state = system.step({ world, previous: state, state: { ...state, tick: state.tick + 1 }, inputs: {}, events: [] });
  const runtime = completeAgentRuntimeOf(state)!;
  expect(runtime.population.ambient).toBe(60);
  // The base adapter accepts the prior stage's count of retained external significant bodies.
  runtime.population.extraSignificant = 2000 - runtime.significantAgentIds.length - runtime.population.ambient - freeSlots;
  runtime.routines = createRoutineRuntime(state.tick);
  runtime.routines.pendingEffects = [{ id: "agent:1/hail-taxi/1", kind: "recruit.hail-taxi", actorId: "agent:1", playerId: "p",
    targetId: "", position: null, amount: 1 }];
  return state;
}

describe("registered recruit taxi population reservation", () => {
  it("preserves ambient reservation and keeps a taxi request pending when no significant slot remains", () => {
    const state = fixture(0), ids = state.ext.agents!.list.map(actor => actor.id);
    const next = completeAgentRuntimeSystem.step({ world, previous: state, state: { ...state, tick: state.tick + 1 }, inputs: {}, events: [] });
    const runtime = completeAgentRuntimeOf(next)!;
    expect(runtime.transport?.taxis).toEqual([]);
    expect(runtime.transport?.jobs[0]).toMatchObject({ phase: "pending", taxiId: null, blocked: "significant-capacity" });
    expect(runtime.routines?.pendingEffects.map(effect => effect.id)).toContain("agent:1/hail-taxi/1");
    expect(runtime.routines?.specials).toEqual([]);
    expect(next.ext.agents!.list.map(actor => actor.id)).toEqual(ids);
  });

  it("subtracts a new taxi before admitting later routine births in the same tick", () => {
    const state = fixture(2);
    const next = completeAgentRuntimeSystem.step({ world, previous: state, state: { ...state, tick: state.tick + 1 }, inputs: {}, events: [] });
    const runtime = completeAgentRuntimeOf(next)!;
    expect(runtime.transport?.taxis).toHaveLength(1);
    expect(runtime.routines?.specials).toHaveLength(1);
    expect(runtime.transport!.taxis.length + runtime.routines!.specials.length).toBe(2);
  });
});
