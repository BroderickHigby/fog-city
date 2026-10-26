import { describe, expect, it } from "vitest";
import { CAR, ROBOTAXI_BODY, createInitialState, lanePath, makeCar, pathPoint, step, type AgentState, type SimState } from "../../src/sim/index.ts";
import { commandeerTaxi } from "../../src/sim/manual-taxi.ts";
import { emptyWorld, gridCity } from "./fixtures.ts";

type Body = { x: number; z: number; heading: number; hl: number; hw: number };

/** Independent SAT measurement of the physical/render footprint, including corner contacts. */
function penetration(a: Body, b: Body): number {
  const af = [Math.sin(a.heading), -Math.cos(a.heading)], ar = [Math.cos(a.heading), Math.sin(a.heading)];
  const bf = [Math.sin(b.heading), -Math.cos(b.heading)], br = [Math.cos(b.heading), Math.sin(b.heading)];
  let depth = Infinity;
  for (const axis of [af, ar, bf, br]) {
    const dot = (v: number[]) => Math.abs(v[0]! * axis[0]! + v[1]! * axis[1]!);
    const extent = a.hl * dot(af) + a.hw * dot(ar) + b.hl * dot(bf) + b.hw * dot(br);
    const separation = Math.abs((a.x - b.x) * axis[0]! + (a.z - b.z) * axis[1]!);
    if (separation >= extent) return 0;
    depth = Math.min(depth, extent - separation);
  }
  return depth;
}
const carBody = (c: { x: number; z: number; heading: number }): Body => ({ ...c, hl: CAR.halfLength, hw: CAR.halfWidth });
const taxiBody = (a: AgentState): Body => ({ x: a.x, z: a.z, heading: a.heading, hl: a.halfLength ?? ROBOTAXI_BODY.halfLength, hw: a.halfWidth ?? ROBOTAXI_BODY.halfWidth });
const neutral = { throttle: 0, steer: 0, brake: 0, actions: 0 };

describe("solid vehicle bodies in the current simulation", () => {
  it("keeps two cars separate when both move into the same head-on contact during a tick", () => {
    const world = emptyWorld(), initial = createInitialState(world, 3, ["a", "b"], { x: 0, z: 0, heading: 0 });
    let state: SimState = { ...initial, players: {
      a: { ...initial.players.a!, car: { ...makeCar(0, 0, 0), speed: 30 } },
      b: { ...initial.players.b!, car: { ...makeCar(0, -15, Math.PI), speed: 30 } },
    } };
    expect(penetration(carBody(state.players.a!.car), carBody(state.players.b!.car))).toBe(0);
    for (let tick = 0; tick < 80; tick++) {
      state = step(world, state, { a: { ...neutral, throttle: 1 }, b: neutral });
      expect(penetration(carBody(state.players.a!.car), carBody(state.players.b!.car)), `tick ${state.tick}`).toBeLessThanOrEqual(.02);
    }
  });

  it("keeps a manually driven taxi and an oncoming personal car separate", () => {
    const grid = gridCity(), world = { ...emptyWorld(), roads: { ...grid.roads!, areas: [], areaIndex: new Map() } };
    const template = createInitialState(grid, 7, ["a"], { x: 150, z: -40, heading: 0 }).ext.agents!.list.find(a => a.kind === "robotaxi")!;
    const initial = createInitialState(world, 7, ["a", "b"], { x: -100, z: -100, heading: 0 });
    const taxi: AgentState = { ...commandeerTaxi(template), id: 1001, x: 0, y: 0, z: 0, heading: 0, pitch: 0,
      speed: 30, manualCar: { ...makeCar(0, 0, 0), speed: 30 } };
    let state: SimState = { ...initial, ext: { ...initial.ext, agents: { ...initial.ext.agents!, list: [taxi] } }, players: {
      a: { ...initial.players.a!, ride: { agentId: taxi.id, manual: true, x: 0, y: 0, z: 0, heading: 0, speed: 30, goal: null, exitPending: false } },
      b: { ...initial.players.b!, car: { ...makeCar(0, -15, Math.PI), speed: 30 } },
    } };
    expect(penetration(taxiBody(taxi), carBody(state.players.b!.car))).toBe(0);
    for (let tick = 0; tick < 100; tick++) {
      state = step(world, state, { a: { ...neutral, throttle: 1 }, b: neutral });
      const driven = state.ext.agents!.list.find(a => a.id === taxi.id)!;
      expect(penetration(taxiBody(driven), carBody(state.players.b!.car)), `tick ${state.tick}`).toBeLessThanOrEqual(.02);
    }
  });

  it("keeps a personal car outside an ambient taxi's full body during a sustained rear-end impact", () => {
    const grid = gridCity(), world = { ...grid, roads: { ...grid.roads!, areas: [], areaIndex: new Map() } };
    const initial = createInitialState(grid, 7, ["p"], { x: 0, z: 0, heading: 0 });
    const template = initial.ext.agents!.list.find(a => a.kind === "robotaxi")!;
    const edge = world.roads.edges[world.roads.edgeIndex.get("h00")!]!, point = pathPoint(lanePath(edge, 1, 0), 45);
    const taxi: AgentState = { ...template, id: 1001, edge: edge.id, dir: 1, lane: 0, s: 45, x: point.x, z: point.z, y: 0,
      heading: Math.PI / 2, pitch: 0, speed: 10, vmax: 10, next: "h10", ndir: 1, nlane: 0,
      conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", dodge: null };
    let state: SimState = { ...initial, ext: { ...initial.ext, agents: { ...initial.ext.agents!, list: [taxi] } }, players: {
      p: { ...initial.players.p!, car: { ...makeCar(taxi.x - 15, taxi.z + .5, Math.PI / 2), speed: 24 } },
    } };
    expect(penetration(carBody(state.players.p!.car), taxiBody(taxi))).toBe(0);
    for (let tick = 0; tick < 120; tick++) {
      state = step(world, state, { p: { ...neutral, throttle: 1 } });
      const ambient = state.ext.agents!.list.find(a => a.id === taxi.id)!;
      expect(penetration(carBody(state.players.p!.car), taxiBody(ambient)), `tick ${state.tick}`).toBeLessThanOrEqual(.02);
    }
  });

  it("does not let a naturally timed deadlock escape drive through a visible stationary taxi", () => {
    const original = gridCity();
    // Keep the real lane graph and collision world, but omit unrelated population-refill areas.
    const world = { ...original, roads: { ...original.roads!, areas: [], areaIndex: new Map() } };
    const initial = createInitialState(original, 7, ["p"], { x: 55, z: -10, heading: 0 });
    const template = initial.ext.agents!.list.find(a => a.kind === "robotaxi")!;
    const edge = world.roads.edges[world.roads.edgeIndex.get("h00")!]!, path = lanePath(edge, 1, 0);
    const taxi = (id: number, at: number): AgentState => {
      const point = pathPoint(path, at);
      return { ...template, id, edge: edge.id, dir: 1, lane: 0, s: at, x: point.x, z: point.z, y: 0,
        heading: Math.PI / 2, pitch: 0, speed: 0, vmax: 10, next: "h10", ndir: 1, nlane: 0,
        conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", dodge: null };
    };
    const rear = taxi(1001, 30), front = { ...taxi(1002, 45), dwell: 6000 };
    let state: SimState = { ...initial, ext: { ...initial.ext, agents: { ...initial.ext.agents!, list: [rear, front] } } };
    expect(penetration(taxiBody(rear), taxiBody(front))).toBe(0);
    // Both are visible beside the player; wait/ghost start at zero and evolve through normal step.
    for (let tick = 0; tick < 3000; tick++) {
      state = step(world, state, {});
      const a = state.ext.agents!.list.find(a => a.id === rear.id), b = state.ext.agents!.list.find(a => a.id === front.id);
      expect(a, `rear taxi should not vanish in view at tick ${state.tick}`).toBeDefined();
      expect(b, `front taxi should not vanish in view at tick ${state.tick}`).toBeDefined();
      expect(penetration(taxiBody(a!), taxiBody(b!)), `tick ${state.tick}, ghost ${a!.ghost}`).toBeLessThanOrEqual(.02);
      expect(a!.x).toBeLessThan(b!.x);
    }
  });
});
