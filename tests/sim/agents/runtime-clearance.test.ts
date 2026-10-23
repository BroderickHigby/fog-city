import { describe, expect, it } from "vitest";
import type { AgentState, AgentsExt } from "../../../src/sim/agents.ts";
import { DT, type SimState } from "../../../src/sim/contract.ts";
import { bodyDistance, dodgeExtOf, stepDodge, vehicleOfAgent, zoneDistance, type AgentDodgeGeometry } from "../../../src/sim/dodge.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { MAX_CLEARANCE_BODIES, stepAgentRuntimeDodge, type ClearedRuntimeBody } from "../../../src/sim/agents/runtime-clearance.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem, type AgentRuntimeData } from "../../../src/sim/agents/runtime-system.ts";
import { deepFreeze } from "../../helpers.ts";
import { emptyWorld } from "../fixtures.ts";

const world = emptyWorld();
const geometry = (body: RuntimePhysicalBody): AgentDodgeGeometry => ({ vehicle: true, radius: body.radius,
  halfLength: body.halfLength, halfWidth: body.halfWidth, height: body.height, dodgeClass: null, acceleration: 20 });
function agent(id: number, x = 20, z = 20): AgentState {
  return { id, kind: "person", x, y: 0, z, heading: 0, pitch: 0, speed: 0, vmax: 1.5,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0, lat: 0,
    wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id, dodge: null };
}
function body(id: number, kind: RuntimePhysicalBody["kind"] = "animal", changes: Partial<RuntimePhysicalBody> = {}): RuntimePhysicalBody {
  return { id: `body:${id}`, numericId: id, kind, model: kind === "vehicle" ? "bus" : "pigeon",
    x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0,
    radius: kind === "vehicle" ? 1.3 : 0.2, halfLength: kind === "vehicle" ? 4.5 : 0.2,
    halfWidth: kind === "vehicle" ? 1.3 : 0.2, height: kind === "vehicle" ? 3.2 : 0.25, dodge: null, ...changes };
}
interface Store { bodies: ClearedRuntimeBody[]; spatial: { animals: Array<{
  id: string; x: number; y: number; z: number; heading: number; speed: number; ownerId: number | null; leashM: number | null; pairedCarry?: boolean;
}> }; fleet: { vehicles: Array<{ id: number; x: number; y: number; z: number; heading: number; speed: number }> } }
function store(state: Readonly<SimState>): Store {
  return (state.ext.agents as AgentsExt & { runtime: Store }).runtime;
}
function state(bodies: RuntimePhysicalBody[], list: AgentState[] = []): SimState {
  const base = createInitialState(world, 831, ["p"], { x: 90, z: 90, heading: 0 });
  const runtime: Store = { bodies, spatial: { animals: bodies.filter((b) => b.kind === "animal").map((b) => ({
    id: b.id, x: b.x, y: b.y, z: b.z, heading: b.heading, speed: b.speed, ownerId: null, leashM: null,
  })) }, fleet: { vehicles: bodies.filter((b) => b.kind === "vehicle").map((b) => ({
    id: b.numericId, x: b.x, y: b.y, z: b.z, heading: b.heading, speed: b.speed,
  })) } };
  return { ...base, ext: { agents: { nextId: 1_000, list, runtime } as AgentsExt & { runtime: Store } } };
}
function next(before: SimState, bodies = store(before).bodies): SimState {
  const ext = before.ext.agents as AgentsExt & { runtime: Store };
  const agents: AgentsExt & { runtime: Store } = { ...ext, runtime: { ...ext.runtime, bodies } };
  return { ...before, tick: before.tick + 1, ext: { ...before.ext, agents } };
}
function asVehicle(body: RuntimePhysicalBody) {
  const a = { ...agent(body.numericId, body.x, body.z), kind: "robotaxi" as const, y: body.y, heading: body.heading, speed: body.speed };
  const previous = { ...a, x: body.previousX, z: body.previousZ, heading: body.previousHeading };
  return vehicleOfAgent(a, previous, DT, world, true, null, geometry(body));
}

describe("runtime bodies in the one final dodge pass", () => {
  it("keeps the established path byte-for-byte when there are no extras", () => {
    const before = state([], [agent(3)]);
    const after = next(before);
    expect(stepAgentRuntimeDodge(world, before, after)).toEqual(stepDodge(world, before, after));
  });

  it("recaps actual anchor coverage after a real dodge crosses the 300m boundary", () => {
    const people = [agent(1, 300.1, 0), ...Array.from({ length: 60 }, (_, i) => agent(100 + i, 0, 30)),
      ...Array.from({ length: 59 }, (_, i) => agent(200 + i, 450, 30))];
    const initial = enableAgentRuntime(createInitialState(world, 831, ["p", "q"], { x: 0, z: 0, heading: 0 }), { wave: 2 });
    initial.players.q!.car.x = 600;
    initial.ext.agents = { nextId: 10_001, list: people };
    const ready = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step({
      world, previous: initial, state: { ...initial, tick: 1 }, inputs: {}, events: [],
    });
    const van = body(10_000, "vehicle", { model: "van", x: 301, previousX: 301,
      halfLength: 2.6, halfWidth: 1.1, radius: 1.1, height: 2.1 });
    const ext: AgentsExt & { runtime: AgentRuntimeData } = { ...ready.ext.agents!, runtime: { ...agentsRuntimeOf(ready)!, bodies: [van] } };
    const before = { ...ready, ext: { ...ready.ext, agents: ext } };
    const coverage = (value: SimState, x: number): number => value.ext.agents!.list.filter(person =>
      (person.x - x) * (person.x - x) + person.z * person.z <= 300 * 300).length;
    expect(coverage(before, 0)).toBe(60);
    expect(coverage(before, 600)).toBe(60);
    const snapshot = JSON.stringify(before);
    const result = stepAgentRuntimeDodge(world, before, next(before));
    const moved = result.ext.agents!.list.find(person => person.id === 1)!;
    expect(moved).toBeDefined();
    expect(moved.x).toBeLessThan(300);
    expect(moved.dodge?.leap).toBe(true);
    expect(dodgeExtOf(result).overrides).toBeGreaterThan(0);
    expect(bodyDistance(asVehicle(van), moved.x, moved.z)).toBeGreaterThanOrEqual(0.3);
    expect(result.ext.agents!.list).toHaveLength(119);
    const runtime = agentsRuntimeOf(result)!;
    for (const anchor of runtime.population.perAnchor) {
      expect(anchor.count).toBe(coverage(result, anchor.id === "p" ? 0 : 600));
      expect(anchor.count).toBeLessThanOrEqual(60);
    }
    expect(runtime.population.ambientIds).toEqual(result.ext.agents!.list.map(person => person.id));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("uses the full 9m bus and the observed displacement, without any road target", () => {
    const bus = body(100, "vehicle", { speed: 6, z: -0.1, previousZ: 0 });
    const v = asVehicle(bus);
    expect(v.hl).toBe(4.5);
    expect(v.hw).toBe(1.3);
    expect(v.route).toBeNull();
    expect(v.vx).toBe(0);
    expect(v.vz).toBeCloseTo(-6, 10);
    expect(bodyDistance(v, 0, 3.6)).toBeLessThan(0);
    // A ninety-degree next-step turn is inside the conservative orientation envelope.
    expect(zoneDistance(v, 4.4, 0)).toBeLessThan(0);
  });

  it("clears animals, legacy people and a player exit from a bus in the same call", () => {
    const bus = body(100, "vehicle");
    const bird = body(101, "animal", { z: 3.8, previousZ: 3.8 });
    const before = state([bus, bird], [agent(3, 0, -3.8)]);
    const after = next(before);
    after.players = { ...after.players, p: { ...after.players.p!, mode: "foot", foot: makeFoot(1, 0, 0, 0) } };
    const result = stepAgentRuntimeDodge(world, before, after);
    const v = asVehicle(bus);
    const animal = store(result).bodies.find((b) => b.kind === "animal")!;
    const person = result.ext.agents!.list[0]!;
    const player = result.players.p!.foot!;
    expect(bodyDistance(v, animal.x, animal.z)).toBeGreaterThanOrEqual(animal.radius);
    expect(bodyDistance(v, person.x, person.z)).toBeGreaterThanOrEqual(0.3);
    expect(bodyDistance(v, player.x, player.z)).toBeGreaterThanOrEqual(0.3);
    expect(result.ext.agents!.list.map((a) => a.id)).toEqual([3]);
    expect(dodgeExtOf(result).overrides).toBeGreaterThan(0);
    expect(store(result).spatial.animals[0]).toMatchObject({ x: animal.x, y: animal.y, z: animal.z });
    expect(store(result).fleet.vehicles[0]).toMatchObject({ x: bus.x, y: bus.y, z: bus.z });
  });

  it("retains a drone's altitude and does not ground-dodge it through a bus", () => {
    const drone = body(101, "robot", { model: "airborne-drone", y: 18 });
    const before = state([body(100, "vehicle"), drone]);
    const result = stepAgentRuntimeDodge(world, before, next(before));
    expect(store(result).bodies.find((b) => b.numericId === 101)).toMatchObject({ x: 0, y: 18, z: 0, dodge: null });
  });

  it("leaves aerial parrots and giant finale motion to their authoritative systems", () => {
    const parrot = body(101, "animal", { model: "parrot", y: 15 });
    const giant = body(102, "robot", { model: "elizabeth", x: 8, previousX: 8, height: 500, radius: 20, halfLength: 40, halfWidth: 20 });
    const walker = body(103, "robot", { model: "walker", x: 5, previousX: 5, radius: 2, halfLength: 4, halfWidth: 2, height: 3 });
    const before = state([body(100, "vehicle"), parrot, giant, walker]);
    const result = stepAgentRuntimeDodge(world, before, next(before));
    expect(store(result).bodies.slice(1).map(({ x, y, dodge }) => ({ x, y, dodge }))).toEqual([
      { x: 0, y: 15, dodge: null }, { x: 8, y: 0, dodge: null }, { x: 5, y: 0, dodge: null },
    ]);
  });

  it("clears an endangered airborne animal horizontally while preserving its altitude", () => {
    const parrot = body(101, "animal", { model: "parrot", y: 2.5 });
    const before = state([body(100, "vehicle"), parrot]);
    const result = stepAgentRuntimeDodge(world, before, next(before));
    const actual = store(result).bodies[1]!;
    expect(actual.y).toBe(2.5);
    expect(bodyDistance(asVehicle(store(result).bodies[0]!), actual.x, actual.z)).toBeGreaterThanOrEqual(actual.radius);
  });

  it("keeps a dog leashed after its owner is authoritatively moved", () => {
    const dog = body(101, "animal", { model: "dog", x: 0.6, previousX: 0.6, radius: 0.28, height: 0.5 });
    const before = state([body(100, "vehicle"), dog], [agent(3, 0, 0)]);
    store(before).spatial.animals[0]!.ownerId = 3;
    store(before).spatial.animals[0]!.leashM = 2.2;
    const result = stepAgentRuntimeDodge(world, before, next(before));
    const owner = result.ext.agents!.list[0]!;
    const actual = store(result).bodies.find((b) => b.numericId === 101)!;
    expect(Math.hypot(actual.x - owner.x, actual.z - owner.z)).toBeLessThanOrEqual(2.2 + 1e-8);
    expect(bodyDistance(asVehicle(store(result).bodies[0]!), actual.x, actual.z)).toBeGreaterThanOrEqual(actual.radius);
    expect(store(result).spatial.animals[0]).toMatchObject({ x: actual.x, y: actual.y, z: actual.z, pairedCarry: actual.pairedCarry });
  });

  it("uses an explicitly carried joint envelope when the leash has no separate room", () => {
    const dog = body(101, "animal", { model: "dog", x: 8, previousX: 8, radius: 0.28, height: 0.5 });
    const before = state([body(100, "vehicle"), dog], [agent(3, 0, 0)]);
    store(before).spatial.animals[0]!.ownerId = 3;
    store(before).spatial.animals[0]!.leashM = 0.1;
    const result = stepAgentRuntimeDodge(world, before, next(before));
    const owner = result.ext.agents!.list[0]!;
    const actual = store(result).bodies.find((b) => b.numericId === 101)!;
    expect(actual).toMatchObject({ x: owner.x, z: owner.z, pairedCarry: true });
    expect(actual.y).toBeGreaterThan(owner.y - (owner.dodge?.hop ?? 0));
    expect(bodyDistance(asVehicle(store(result).bodies[0]!), actual.x, actual.z)).toBeGreaterThanOrEqual(actual.radius);
  });

  it("does not mutate frozen input and does not depend on runtime body array order", () => {
    const before = state([body(100, "vehicle"), body(101, "animal", { z: 3.9, previousZ: 3.9 })]);
    const after = next(before);
    const reverse = next(before, [...store(after).bodies].reverse());
    const snapshot = JSON.stringify(before);
    deepFreeze(before); deepFreeze(after); deepFreeze(reverse);
    expect(stepAgentRuntimeDodge(world, before, after)).toEqual(stepAgentRuntimeDodge(world, before, reverse));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("rejects duplicate IDs, nonfinite geometry, stale observations and unbounded vehicle motion", () => {
    const before = state([body(100, "vehicle")], [agent(3)]);
    const invalid = [
      [body(3)],
      [body(101), body(101)],
      [body(101, "animal", { height: Number.NaN })],
      [body(100, "vehicle", { previousZ: 1 })],
      [body(100, "vehicle", { x: 10 })],
      [body(100, "vehicle", { speed: 4 })],
      Array.from({ length: MAX_CLEARANCE_BODIES + 1 }, (_, i) => body(1_000 + i)),
    ];
    for (const bodies of invalid) expect(() => stepAgentRuntimeDodge(world, before, next(before, bodies))).toThrow(RangeError);
  });

  it("accepts the runtime's full bounded extra-body capacity", () => {
    const before = state(Array.from({ length: MAX_CLEARANCE_BODIES }, (_, i) => body(1_000 + i, "robot", { model: "drone", y: 50 })));
    expect(store(stepAgentRuntimeDodge(world, before, next(before))).bodies).toHaveLength(MAX_CLEARANCE_BODIES);
  });

  it("preserves final mixed-body clearance across seeded bounded bus and van steps", () => {
    for (const seed of [7, 41, 831]) {
      const bus = body(100, "vehicle", { x: -8, previousX: -8, z: -8, previousZ: -8, heading: Math.PI / 2, previousHeading: Math.PI / 2, speed: 6 });
      const van = body(101, "vehicle", { model: "van", x: 10, previousX: 10, z: 10, previousZ: 10, halfLength: 2.6, halfWidth: 1.1,
        radius: 1.1, height: 2.1, heading: Math.PI * 1.5, previousHeading: Math.PI * 1.5, speed: 4 });
      let current = state([bus, van, ...Array.from({ length: 6 }, (_, i) => body(110 + i, "animal", {
        x: ((seed * (i + 3)) % 19) - 9, previousX: ((seed * (i + 3)) % 19) - 9,
        z: ((seed * (i + 5)) % 23) - 11, previousZ: ((seed * (i + 5)) % 23) - 11,
      }))]);
      let contactsAfterPlacement = 0;
      for (let tick = 0; tick < 45; tick++) {
        const moved = store(current).bodies.map((b) => ({ ...b, previousX: b.x, previousZ: b.z, previousHeading: b.heading,
          x: b.x + (b.numericId === 100 ? 6 * DT : b.numericId === 101 ? -4 * DT : 0) }));
        current = stepAgentRuntimeDodge(world, current, next(current, moved));
        if (tick === 0) contactsAfterPlacement = dodgeExtOf(current).contacts;
        else expect(dodgeExtOf(current).contacts, `new contact: seed ${seed} tick ${tick}`).toBe(contactsAfterPlacement);
        const all = store(current).bodies;
        for (const animal of all.filter((b) => b.kind === "animal")) {
          for (const vehicle of all.filter((b) => b.kind === "vehicle")) {
            expect(bodyDistance(asVehicle(vehicle), animal.x, animal.z), `seed ${seed} tick ${tick}`).toBeGreaterThanOrEqual(animal.radius);
          }
        }
      }
    }
  });
});
