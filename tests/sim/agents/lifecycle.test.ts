import { describe, expect, it, vi } from "vitest";
import { badRobotRate, distanceM, distanceToPolygonM } from "../../../src/content/places.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { AgentState } from "../../../src/sim/agents.ts";
import { createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import { agentsRuntimeOf, createAgentsRuntime, planAgentRuntime, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";

const world = buildWorld([], {
  version: 1, nodes: [{ id: "a", x: -500, z: 0 }, { id: "b", x: 500, z: 0 }],
  edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[-500, 0], [500, 0]] }],
});
// No ambient replenishment: the tests exercise retained and explicitly owned bodies.
world.roads = { ...world.roads!, areas: [] };

function initial() {
  const state = createInitialState(world, 7, ["p"], { x: 0, z: 8, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(0, 0, 8, 0);
  state.players.p!.car.z = 30;
  state.ext.agents = { nextId: 100, list: [] };
  return state;
}

function spawn(id = "extra", extra: Partial<RuntimeSpawn> = {}): RuntimeSpawn {
  return { id, numericId: 100, model: "person", firmware: "none", x: 10, y: 0, z: 8, heading: 0, radius: .35, height: 1.8, posted: true, ...extra };
}

function legacy(): AgentState {
  return { id: 10, kind: "person", runtimeId: "agent:10", runtimeLegacy: true,
    x: 10, y: 0, z: 8, heading: 0, speed: 0, pitch: 0, vmax: 1.5,
    edge: "road", dir: 1, lane: 0, s: 510, next: "", ndir: 1, nlane: 0,
    conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0,
    mode: "go", rng: 1, dodge: null };
}

describe("bounded runtime actor lifecycle", () => {
  it("removes a disposable actor's physical body when it leaves all simulation anchors", () => {
    let state = initial();
    let add = true;
    const system = createAgentsSystem(() => ({ services: false, ...(add ? { spawns: [spawn()] } : {}) }));
    state = step(world, state, {}, [], [system]);
    expect(state.ext.agents!.list.some(body => body.runtimeId === "extra")).toBe(true);
    add = false;
    state.players.p!.foot!.x = 1000;
    state = step(world, state, {}, [], [system]);
    expect(state.ext.agents!.list.some(body => body.runtimeId === "extra")).toBe(false);
    expect(agentsRuntimeOf(state)!.actors.extra).toBeUndefined();
  });

  it("does not restore far claimed ambient bodies after population culling", () => {
    let state = initial();
    state.ext.agents!.list = [legacy()];
    const system = createAgentsSystem(() => ({ services: false, firmware: { "agent:10": "none" } }));
    state = step(world, state, {}, [], [system]);
    state.players.p!.foot!.x = 1000;
    state.tick = 59;
    state = step(world, state, {}, [], [system]);
    expect(state.ext.agents!.list).toEqual([]);
    expect(agentsRuntimeOf(state)!.actors["agent:10"]).toBeUndefined();
  });

  it("preserves a significant ambient identity while away and readmits it on return", () => {
    let state = initial();
    state.ext.agents!.list = [legacy()];
    state.ext.robots = createAgentsRuntime(state, { firmware: { "agent:10": "none" } });
    state.ext.robots.actors["agent:10"]!.significant = true;
    state.ext.robots.actors["agent:10"]!.posted = true;
    const system = createAgentsSystem(() => ({ services: false }));
    state.players.p!.foot!.x = 1000;
    state.tick = 59;
    state = step(world, state, {}, [], [system]);
    expect(state.ext.agents!.list).toEqual([]);
    expect(agentsRuntimeOf(state)!.actors["agent:10"]).toMatchObject({ numericId: 10, legacyId: null, fidelity: "abstract", retired: false });
    state.players.p!.foot!.x = 0;
    state = step(world, state, {}, [], [system]);
    expect(state.ext.agents!.list.filter(body => body.runtimeId === "agent:10")).toHaveLength(1);
    expect(state.ext.agents!.list[0]!.id).toBe(10);
  });

  it("releases transient retirement records through more than the runtime capacity", () => {
    let state = initial();
    for (let tick = 0; tick < 5000; tick++) {
      state.tick = tick;
      const id = `service:retirement-${tick}`;
      const runtime = planAgentRuntime(world, state, {}, { spawns: [spawn(id, { numericId: 100 + tick, significant: true })] });
      expect(Object.keys(runtime.actors)).toEqual([id]);
      // Service/transit owners signal this after their observed trip finishes.
      runtime.actors[id]!.retired = true;
      state.ext.robots = runtime;
    }
  });

  it("retains mission retirement tombstones and pending admission for their owners", () => {
    const state = initial();
    const runtime = createAgentsRuntime(state, { spawns: [spawn("mission:delivery:recipient", { significant: true }), spawn("blocked", { numericId: 101, significant: true })] });
    runtime.actors["mission:delivery:recipient"]!.retired = true;
    runtime.missionBindings["delivery:recipient"] = "mission:delivery:recipient";
    runtime.actors.blocked!.behavior = "pending-admission";
    runtime.actors.blocked!.fidelity = "abstract";
    state.ext.robots = runtime;
    const next = planAgentRuntime(world, state, {});
    expect(next.actors["mission:delivery:recipient"]!.retired).toBe(true);
    expect(next.actors.blocked).toBeDefined();
    expect(next.actors.blocked!.retired).toBe(false);
  });

  it("repopulates ordinary traffic instead of restoring a culled taxi without its lane route", () => {
    const roadWorld = buildWorld([], {
      version: 1, nodes: [{ id: "a", x: -500, z: 0 }, { id: "b", x: 2500, z: 0 }],
      edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[-500, 0], [2500, 0]] }],
    });
    let state = createInitialState(roadWorld, 7, ["p"], { x: 0, z: 30, heading: 0 });
    const oldTaxi = state.ext.agents!.list.find(body => body.kind === "robotaxi")!;
    expect(oldTaxi).toBeDefined();
    state.ext.robots = createAgentsRuntime(state);
    const id = `agent:${oldTaxi.id}`;
    state.ext.robots.actors[id]!.significant = true;
    const system = createAgentsSystem(() => ({ services: false }));
    state.players.p!.car.x = 1800;
    state.tick = 59;
    state = step(roadWorld, state, {}, [], [system]);
    expect(state.ext.agents!.list.some(body => body.id === oldTaxi.id)).toBe(false);
    expect(agentsRuntimeOf(state)!.actors[id]).toBeUndefined();
    state.players.p!.car.x = 0;
    state.tick = 119;
    state = step(roadWorld, state, {}, [], [system]);
    expect(state.ext.agents!.list.some(body => body.kind === "robotaxi" && body.id !== oldTaxi.id)).toBe(true);
    expect(agentsRuntimeOf(state)!.actors[id]).toBeUndefined();
  });
});

describe("runtime broadphase and portable content arithmetic", () => {
  it("does not query a city-wide line of sight for a distant player that cannot cause a reaction", () => {
    const distantWorld = buildWorld([]);
    const state = createInitialState(distantWorld, 7, ["near", "far"], { x: 0, z: 8, heading: 0 });
    state.players.far!.car.x = 5000;
    state.players.far!.car.z = 5000;
    const reads = vi.spyOn(distantWorld.cells, "get");
    planAgentRuntime(distantWorld, state, {}, { spawns: [spawn()] });
    expect(reads.mock.calls.length).toBeLessThan(10);
    reads.mockRestore();
  });

  it("keeps simulated content queries off the engine-dependent hypot path", () => {
    const hypot = vi.spyOn(Math, "hypot").mockImplementation(() => { throw new Error("non-portable hypot"); });
    try {
      expect(distanceM([37.79, -122.4], [37.7901, -122.4])).toBeGreaterThan(10);
      expect(distanceToPolygonM([37.795, -122.395], [[37.79, -122.4], [37.79, -122.39], [37.78, -122.39], [37.78, -122.4]])).toBeGreaterThan(0);
      expect(badRobotRate([37.79, -122.4])).toBeGreaterThan(0);
    } finally { hypot.mockRestore(); }
  });
});
