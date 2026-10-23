import { describe, expect, it } from "vitest";
import { agentsOf, personIsChild, stepAgents, type AgentState } from "../../../src/sim/agents.ts";
import { agentDodgeClass } from "../../../src/sim/dodge.ts";
import { type SimState } from "../../../src/sim/contract.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { lanePath, projectOnPath, type RoadsFile } from "../../../src/sim/roads.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { ambientProfilesOf, expandAmbientProfiles, readAmbientState, stepAmbientRuntime, type AmbientRuntimeResult } from "../../../src/sim/agents/ambient-runtime.ts";
import { createSpatialNavigation, stepRuntimeSpatial } from "../../../src/sim/agents/runtime-spatial.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { newLook, personLook } from "../../../src/render/person.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem } from "../../../src/sim/agents/runtime-system.ts";
import { completeAgentRuntimeOf, completeAgentRuntimeSystem } from "../../../src/sim/agents/runtime-registration.ts";

const roads: RoadsFile = { version: 1, nodes: [], edges: [] };
for (const z of [-200, 0, 200]) {
  roads.nodes = [...roads.nodes, { id: `a${z}`, x: -600, z }, { id: `b${z}`, x: 600, z }];
  roads.edges = [...roads.edges, { id: `road${z}`, a: `a${z}`, b: `b${z}`, kind: "residential", lanes: 4, oneway: false, points: [[-600, z], [600, z]] }];
}
const world = buildWorld([], roads), navigation = createSpatialNavigation(world);
const system = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } });
function initial(seed = 42): SimState {
  const state = enableAgentRuntime(createInitialState(world, seed, ["p"], { x: 0, z: 60, heading: 0 }), { wave: 2, ambientMode: "squares-v1" });
  return { ...state, ext: { ...state.ext, agents: { nextId: 1, list: [] } } };
}
function generate(state: SimState, previous: AmbientRuntimeResult | null = null, limit = 60, x = 0, anchors = [{ id: "p", x, z: 60 }]): AmbientRuntimeResult {
  return stepAmbientRuntime({ world, state, previous: previous?.state ?? null, actors: previous?.actors ?? [], anchors, extras: [], significant: new Set(),
    nextId: previous?.nextId ?? state.ext.agents!.nextId, ambientLimit: limit, reserved: [], navigation });
}
function fill(state: SimState, previous: AmbientRuntimeResult | null = null): AmbientRuntimeResult {
  let result = previous;
  for (let i = 0; i < 40; i++) result = generate({ ...state, tick: state.tick + i }, result);
  return result!;
}
function apply(previous: SimState, x?: number): SimState {
  const players = x === undefined ? previous.players : { p: { ...previous.players.p!, car: { ...previous.players.p!.car, x, z: 60 } } };
  return system.step({ world, previous, state: { ...previous, tick: previous.tick + 1, players }, inputs: {}, events: [] });
}

describe("100 m ambient runtime provenance", () => {
  it("regenerates the same canonical identities and phenotype with fresh public incarnations", () => {
    const state = initial(), first = fill(state);
    expect(first.actors.length).toBe(60);
    const departure = generate({ ...state, tick: 60 }, { ...first, actors: [] }, 60, 3000);
    expect(departure.state.profiles).toEqual([]);
    const returned = fill({ ...state, tick: 120 }, { ...departure, actors: [] });
    const a = expandAmbientProfiles(first.state, state.seed), b = expandAmbientProfiles(returned.state, state.seed);
    expect(b.map(({ id: _id, ...profile }) => profile)).toEqual(a.map(({ id: _id, ...profile }) => profile));
    expect(Math.min(...returned.actors.map(actor => actor.id))).toBeGreaterThan(Math.max(...first.actors.map(actor => actor.id)));
    expect(returned.actors.map(({ id: _id, ...actor }) => actor)).toEqual(first.actors.map(({ id: _id, ...actor }) => actor));
    expect(JSON.stringify(first.state).length).toBeLessThan(8000);
  });

  it("retains active square epochs across bucket boundaries and reload, changing only after exit", () => {
    const state = initial(), first = fill({ ...state, tick: 1790 });
    const reloaded = JSON.parse(JSON.stringify(first)) as AmbientRuntimeResult;
    const held = generate({ ...state, tick: 3600 }, reloaded);
    expect(held.state.squares).toEqual(first.state.squares);
    expect(held.state.profiles).toEqual(first.state.profiles);
    const departed = generate({ ...state, tick: 3601 }, { ...held, actors: [] }, 60, 3000);
    const returned = fill({ ...state, tick: 3602 }, departed);
    expect(returned.state.squares.every(square => square.timeBucket === 2)).toBe(true);
    expect(expandAmbientProfiles(returned.state, state.seed)[0]!.key).not.toBe(expandAmbientProfiles(first.state, state.seed)[0]!.key);
    expect(generate({ ...state, tick: 3600 }, reloaded)).toEqual(held);
  });

  it("keeps human appearance, child clearance class and branch choice across numeric incarnations", () => {
    const base = fill(initial()).actors.find(actor => actor.kind === "person")!;
    const graph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 100, z: -50 }, { id: "d", x: 100, z: 50 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
        { id: "bc", a: "b", b: "c", kind: "sidewalk", roadId: "street", points: [[10, 0], [100, -50]] },
        { id: "bd", a: "b", b: "d", kind: "sidewalk", roadId: "street", points: [[10, 0], [100, 50]] }] });
    const bareWorld = buildWorld([]), branches: string[] = [], looks: unknown[] = [], classes: unknown[] = [];
    for (let id = 1; id <= 12; id++) {
      const actor: AgentState = { ...base, id, x: 9.99, y: 0, z: 0, heading: Math.PI / 2, edge: "street", s: 9.99, vmax: 1.5 };
      const seedState = createInitialState(bareWorld, 42, [], { x: 0, z: 0, heading: 0 });
      const input = { context: { world: bareWorld, previous: { ...seedState, ext: { agents: { nextId: 100, list: [actor] } } },
        state: { ...seedState, tick: 1, ext: { agents: { nextId: 100, list: [actor] } } }, inputs: {}, events: [] }, actors: [actor],
      anchors: [{ id: "near", x: 10, z: 0 }], navigation: graph, animalLimit: { pigeons: 0, dogs: 0 } };
      const first = stepRuntimeSpatial(input), tick = 120 + first.state.walkers[0]!.phaseTicks;
      const result = stepRuntimeSpatial({ ...input, context: { ...input.context, previous: { ...input.context.previous, tick: tick - 1 }, state: { ...input.context.state, tick } },
        anchors: [{ id: "far", x: 3000, z: 0 }], significantActorIds: [id], previous: { ...first.state, walkers: first.state.walkers.map(track => ({ ...track, lastTick: tick - 60 })) } });
      branches.push(result.state.walkers[0]!.route!.steps[0]!.edgeId);
      const look = personLook(actor.identitySeed ?? actor.id, newLook());
      looks.push({ shirt: look.shirt.getHex(), pants: look.pants.getHex(), skin: look.skin.getHex(), hair: look.hair.getHex(), scale: look.scale });
      classes.push([personIsChild(actor.id, actor.identitySeed), agentDodgeClass(actor)]);
    }
    expect(branches[0]).not.toBe("ab"); expect(new Set(branches).size).toBe(1);
    expect(looks.every(look => JSON.stringify(look) === JSON.stringify(looks[0]))).toBe(true);
    expect(classes.every(value => JSON.stringify(value) === JSON.stringify(classes[0]))).toBe(true);
  });

  it("uses real safe road lanes for taxis and retains exact initial sidewalk route/phase", () => {
    const state = initial(), result = fill(state), profiles = expandAmbientProfiles(result.state, state.seed);
    const taxis = result.actors.filter(actor => actor.kind === "robotaxi");
    expect(taxis.length).toBeGreaterThan(0);
    for (const actor of taxis) {
      const edge = world.roads!.edges[world.roads!.edgeIndex.get(actor.edge)!]!;
      expect(edge.drivable).toBe(true);
      expect(projectOnPath(lanePath(edge, actor.dir, actor.lane), actor.x, actor.z).dist).toBeLessThan(0.00001);
    }
    const batch = generate(state);
    for (const track of batch.freshTracks) {
      expect(track.route).not.toBeNull(); expect(track.joining).toBe(false);
      expect(track.phaseTicks).toBe(profiles.find(profile => profile.id === track.id)!.phaseTicks);
    }
  });

  it("clears parked cars even while their owner is far away on foot", () => {
    const state = initial(), first = generate(state), target = first.actors[0]!;
    const car = { ...state.players.p!.car, x: target.x, z: target.z };
    const foot = { x: 0, z: 60, y: 0, heading: 0, speed: 0, vy: 0, grounded: true, dodge: null, sprint: false };
    const occupied = { ...state, players: { p: { ...state.players.p!, car, mode: "foot" as const, foot } } };
    const result = fill(occupied);
    expect(result.actors.every(actor => (actor.x - car.x) * (actor.x - car.x) + (actor.z - car.z) * (actor.z - car.z) > 3 * 3)).toBe(true);
  });

  it("is independent of numeric allocation, global RNG, road insertion order and anchor insertion order", () => {
    const state = initial(), a = generate(state);
    const changed = { ...state, rng: [1, 2, 3, 4] as [number, number, number, number], ext: { ...state.ext, agents: { nextId: 900, list: [] } } };
    const b = generate(changed);
    expect(a.actors.map(({ id: _id, ...actor }) => actor)).toEqual(b.actors.map(({ id: _id, ...actor }) => actor));
    const anchors = [{ id: "a", x: 0, z: 60 }, { id: "b", x: 20, z: 60 }];
    expect(generate(state, null, 60, 0, anchors)).toEqual(generate(state, null, 60, 0, [...anchors].reverse()));
    const reordered = buildWorld([], { ...roads, nodes: [...roads.nodes].reverse(), edges: [...roads.edges].reverse() });
    const c = stepAmbientRuntime({ world: reordered, state, previous: null, actors: [], anchors: [{ id: "p", x: 0, z: 60 }], extras: [], significant: new Set(), nextId: 1, ambientLimit: 60, reserved: [], navigation: createSpatialNavigation(reordered) });
    expect(c).toEqual(a);
    expect(stepAgents(world, { ...state, tick: 59 }, 60, { populate: false })!.rng).toBe(state.rng);
  });

  it("counts every overlapping anchor and limits the reserved promotion budget", () => {
    const state = initial(); let result: AmbientRuntimeResult | null = null;
    const anchors = [{ id: "a", x: 0, z: 60 }, { id: "b", x: 30, z: 60 }];
    for (let i = 0; i < 40; i++) result = generate({ ...state, tick: i }, result, 7, 0, anchors);
    expect(result!.actors).toHaveLength(7);
    for (const anchor of anchors) expect(result!.actors.filter(actor => (actor.x - anchor.x) * (actor.x - anchor.x) + (actor.z - anchor.z) * (actor.z - anchor.z) <= 90000).length).toBeLessThanOrEqual(60);
  });

  it("rejects corrupt or duplicate saved provenance instead of renumbering it", () => {
    const result = fill(initial()), valid = JSON.parse(JSON.stringify(result.state));
    expect(readAmbientState(valid)).toEqual(result.state);
    expect(() => readAmbientState({ ...valid, profiles: [...valid.profiles, valid.profiles[0]] })).toThrow(/ambient profile/);
    expect(() => readAmbientState({ ...valid, profiles: [{ id: 1, origin: [0, 0, -1, 0] }] })).toThrow(/ambient profile/);
  });
});

describe("registered ambient adapter", () => {
  it("runs the explicit path through step and retains interacted IDs/progress across departure", () => {
    let state = step(world, initial(), {}, [], [system]);
    expect(ambientProfilesOf(state).length).toBeGreaterThan(0);
    const actor = agentsOf(state).find(actor => actor.kind === "errandRobot")!;
    const combat = createCombatState(state.seed, { actors: [], players: [], walls: [], refills: [] }, state.tick);
    combat.targets[`agent:${actor.id}`] = { ...initialTarget(), rust: 0.4, lastWaterTick: state.tick, sourceId: "p" };
    state = { ...state, ext: { ...state.ext, combat } };
    const result = apply(state, 3000);
    expect(agentsRuntimeOf(result)!.significantAgentIds).toContain(actor.id);
    expect(agentsOf(result).find(value => value.id === actor.id)).toMatchObject({ id: actor.id, rng: actor.rng });
    expect(ambientProfilesOf(result).find(profile => profile.id === actor.id)).toEqual(ambientProfilesOf(state).find(profile => profile.id === actor.id));
    expect(result.ext.combat!.targets[`agent:${actor.id}`]!.rust).toBe(0.4);
  });

  it("preserves legacy snapshot behavior unless the square mode is explicitly enabled", () => {
    const original = initial(), legacy = { ...original, ext: { ...original.ext, robots: { ...original.ext.robots! } } };
    delete legacy.ext.robots.ambientMode;
    const next = apply(legacy);
    expect(agentsRuntimeOf(next)!.ambient).toBeUndefined();
    expect(agentsOf(next)).toEqual([]);
  });

  it("does not allocate ambient into significant and pending-delivery reservations", () => {
    const first = apply(initial()), runtime = agentsRuntimeOf(first)!;
    runtime.population.extraSignificant = 1998; runtime.population.reservedVanUnits = 2;
    const result = apply(first);
    expect(agentsOf(result)).toEqual([]);
    expect(ambientProfilesOf(result)).toEqual([]);
    expect(agentsRuntimeOf(result)!.population.significant).toBe(1998);
  });

  it("prevents later routine births consuming slots reserved for live ambient", () => {
    const first = apply(initial()), runtime = agentsRuntimeOf(first)!;
    expect(runtime.population.ambient).toBeGreaterThan(0);
    runtime.population.extraSignificant = 2000 - runtime.population.ambient;
    first.ext.robots!.wave = 3;
    const result = completeAgentRuntimeSystem.step({ world, previous: first, state: { ...first, tick: first.tick + 1 }, inputs: {}, events: [] });
    expect(completeAgentRuntimeOf(result)!.routines!.specials).toEqual([]);
    expect(agentsOf(result).map(actor => actor.id)).toEqual(agentsOf(first).map(actor => actor.id));
  });
});
