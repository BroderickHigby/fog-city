import { describe, expect, it } from "vitest";
import type { AgentState } from "../../../src/sim/agents.ts";
import { Action } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import {
  createSpatialNavigation, MAX_RUNTIME_DOGS, MAX_RUNTIME_PIGEONS, MAX_SPATIAL_WALKERS, RUNTIME_LEASH_M, stepRuntimeSpatial,
} from "../../../src/sim/agents/runtime-spatial.ts";
import type { RuntimeSpatialInput, RuntimeSpatialState } from "../../../src/sim/agents/runtime-spatial.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { BuildingCollider, World } from "../../../src/sim/world.ts";

const graph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 100, z: 0 }],
  edges: [{ id: "walk", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [100, 0]] }] });
const anchor = { id: "player", x: 10, z: 0 };
const noAnimals = { pigeons: 0, dogs: 0 };

function actor(overrides: Partial<AgentState> = {}): AgentState {
  return { id: 1, kind: "person", x: 10, y: 0, z: 0, heading: Math.PI / 2, pitch: 0, speed: 1.5, vmax: 1.5,
    edge: "street", dir: 1, lane: 1, s: 10, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 192837, dodge: null, ...overrides };
}

function worldWith(buildings: BuildingCollider[] = []): World {
  return buildWorld([{ tileId: "fixture", buildings, ground: null }]);
}

function fixture(previous: AgentState[], current: AgentState[], tick = 1, world = worldWith()): RuntimeSpatialInput {
  const state = createInitialState(world, 17, [], { x: 1000, z: 1000, heading: 0 });
  return { context: { world, previous: { ...state, tick: tick - 1, ext: { agents: { nextId: 100, list: previous } } },
    state: { ...state, tick, ext: { agents: { nextId: 100, list: current } } }, inputs: {}, events: [] },
  actors: current, anchors: [anchor], navigation: graph, animalLimit: noAnimals };
}

function rectangle(x0: number, z0: number, x1: number, z1: number): BuildingCollider {
  return { id: "wall", footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY: 10 };
}

describe("runtime spatial adapter", () => {
  it("gives pigeons bounded stable identities even when source junction keys are deeply escaped", () => {
    const longId = JSON.stringify(["junction", "long".repeat(80)]);
    const navigation = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 100, z: 0 }],
      edges: [{ id: longId, a: "a", b: "b", kind: "sidewalk", points: [[0, 0], [100, 0]] }] });
    const input = { ...fixture([], []), navigation, animalLimit: { pigeons: 1, dogs: 0 } };
    const first = stepRuntimeSpatial(input);
    expect(first.animals).toHaveLength(1);
    expect(first.animals[0]!.id.length).toBeLessThanOrEqual(128);
    expect(first.animals[0]!.edgeId).toBe(longId);
    expect(stepRuntimeSpatial(input).animals[0]!.id).toBe(first.animals[0]!.id);
  });

  it("preserves an already legal legacy step exactly, without moving twice or reseeding it", () => {
    const previous = actor();
    const current = actor({ x: 10.025, s: 10.025, rng: 7654321 });
    const input = fixture([previous], [current]);
    const before = JSON.stringify(input);
    const result = stepRuntimeSpatial(input);
    expect(result.actors[0]).toBe(current);
    expect(result.metadata[0]).toMatchObject({ override: false, joining: false });
    expect(result.metadata[0]!.movedM).toBeCloseTo(0.025);
    expect(result.actors[0]!.id).toBe(1);
    expect(result.actors[0]!.rng).toBe(7654321);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("joins an actual sidewalk gradually from the previous authoritative pose", () => {
    let previous = actor({ z: 1 });
    let state: RuntimeSpatialState | undefined;
    const first = stepRuntimeSpatial({ ...fixture([previous], [actor({ x: 10.025, z: 1 })]), previous: state });
    expect(first.actors[0]!.z).toBeCloseTo(0.975);
    expect(first.actors[0]!.x).toBe(10);
    expect(first.metadata[0]!.movedM).toBeCloseTo(0.025);
    previous = first.actors[0]!;
    state = first.state;
    const phase = state.walkers[0]!.phaseTicks;
    for (let tick = 2; tick <= 60; tick++) {
      const current = { ...previous, x: previous.x + 0.025 };
      const result = stepRuntimeSpatial({ ...fixture([previous], [current], tick), previous: state });
      expect(result.metadata[0]!.movedM).toBeLessThanOrEqual(0.02500001);
      expect(result.actors[0]!.rng).toBe(previous.rng);
      previous = result.actors[0]!;
      state = result.state;
    }
    expect(previous.z).toBeCloseTo(0);
    expect(state.walkers[0]!.phaseTicks).toBe(phase);
    expect(state.walkers[0]!.joining).toBe(false);
  });

  it("only snaps a newly allocated explicitly fresh body after a swept safety check", () => {
    const current = actor({ z: 1 });
    const ordinary = stepRuntimeSpatial(fixture([], [current]));
    expect(ordinary.actors[0]!.z).toBeCloseTo(0.975);
    const fresh = stepRuntimeSpatial({ ...fixture([], [current]), freshSpawnIds: [1] });
    expect(fresh.actors[0]!.z).toBe(0);
    const existing = stepRuntimeSpatial({ ...fixture([current], [current]), freshSpawnIds: [1] });
    expect(existing.actors[0]!.z).toBeCloseTo(0.975);
  });

  it("refuses a join through a thin building and detects a capsule grazing a polygon vertex", () => {
    for (const wall of [rectangle(9, 0.7, 11, 0.8), rectangle(10.28, 0.7, 11, 0.8)]) {
      const previous = actor({ z: 1.5, vmax: 120 });
      const result = stepRuntimeSpatial(fixture([previous], [previous], 1, worldWith([wall])));
      expect(result.actors[0]!.z).toBe(1.5);
      expect(result.metadata[0]!.blockedBy).toBe("building");
      expect(result.metadata[0]!.movedM).toBe(0);
    }
  });

  it("blocks a vehicle's entire swept path, even when both vehicle endpoints are far away", () => {
    const previous = actor({ z: 1.5, vmax: 120 });
    const result = stepRuntimeSpatial({ ...fixture([previous], [previous]), vehicles: [{ id: "van", x: 20, z: 0.75,
      previousX: 0, previousZ: 0.75, halfLength: 0.5, halfWidth: 0.3, speed: 20 }] });
    expect(result.actors[0]!.z).toBe(1.5);
    expect(result.metadata[0]!.blockedBy).toBe("vehicle");
  });

  it("applies pursue and hold from the authoritative base, rather than adding to legacy movement", () => {
    const previous = actor({ kind: "errandRobot" });
    const current = actor({ kind: "errandRobot", x: 9.975 });
    const pursue = stepRuntimeSpatial({ ...fixture([previous], [current]), robotIntents: [{ id: 1,
      movement: { kind: "pursue", destination: { x: 90, z: 0 }, target: { kind: "player", id: "p" }, stopDistance: 1, avoidFog: false } }] });
    expect(pursue.actors[0]!.x).toBeCloseTo(10.025);
    expect(pursue.metadata[0]!.movedM).toBeCloseTo(0.025);
    const held = stepRuntimeSpatial({ ...fixture([previous], [current]), robotIntents: [{ id: 1,
      movement: { kind: "hold", face: { x: 10, z: -10 }, avoidFog: false } }] });
    expect(held.actors[0]!.x).toBe(10);
    expect(held.actors[0]!.speed).toBe(0);
    expect(held.actors[0]!.heading).toBe(0);
    const still = stepRuntimeSpatial({ ...fixture([previous], [previous]), robotIntents: [{ id: 1,
      movement: { kind: "hold", face: null, avoidFog: false } }] });
    expect(still.actors[0]!.speed).toBe(0);
  });

  it("preserves safe legacy motion when no nearby sidewalk exists", () => {
    const previous = actor();
    const current = actor({ x: 10.025 });
    const result = stepRuntimeSpatial({ ...fixture([previous], [current]), navigation: buildSidewalkGraph({ nodes: [], edges: [] }) });
    expect(result.actors[0]).toBe(current);
    expect(result.metadata[0]!.joining).toBe(true);
  });

  it("advances significant offscreen walkers abstractly and preserves identity when they return", () => {
    let previous = actor();
    const initial = stepRuntimeSpatial(fixture([previous], [previous]));
    let state = initial.state;
    const phase = state.walkers[0]!.phaseTicks;
    for (let tick = 2; tick <= 121; tick++) {
      const result = stepRuntimeSpatial({ ...fixture([previous], [{ ...previous, x: previous.x + 0.025 }], tick), previous: state,
        anchors: [{ id: "far", x: 3000, z: 0 }], significantActorIds: [1] });
      expect(result.metadata[0]!.fidelity).toBe("abstract");
      previous = result.actors[0]!;
      state = result.state;
    }
    expect(previous.x).toBeGreaterThan(10);
    expect(previous.x).toBeLessThanOrEqual(13.01);
    const returned = stepRuntimeSpatial({ ...fixture([previous], [{ ...previous, x: previous.x + 0.025 }], 122), previous: state, significantActorIds: [1] });
    expect(returned.actors[0]!.id).toBe(1);
    expect(returned.actors[0]!.rng).toBe(previous.rng);
    expect(returned.state.walkers[0]!.phaseTicks).toBe(phase);
    expect(returned.actors[0]!.x).toBeCloseTo(previous.x + 0.025);
  });

  it("carries abstract elapsed travel across a graph node", () => {
    const joined = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 100, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
        { id: "bc", a: "b", b: "c", kind: "sidewalk", roadId: "street", points: [[10, 0], [100, 0]] }] });
    const previous = actor({ x: 9.99 });
    const initial = stepRuntimeSpatial({ ...fixture([previous], [previous]), navigation: joined });
    const tick = 120 + initial.state.walkers[0]!.phaseTicks;
    const state = { ...initial.state, walkers: initial.state.walkers.map((track) => ({ ...track, lastTick: tick - 60 })) };
    const result = stepRuntimeSpatial({ ...fixture([previous], [previous], tick), navigation: joined, previous: state,
      anchors: [{ id: "far", x: 3000, z: 0 }], significantActorIds: [1] });
    expect(result.actors[0]!.x).toBeCloseTo(11.49);
    expect(result.state.walkers[0]!.route!.steps[0]!.edgeId).toBe("bc");
  });

  it("applies the owner leash guard across an abstract/active anchor seam", () => {
    const longGraph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 1000, z: 0 }],
      edges: [{ id: "walk", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [1000, 0]] }] });
    const owner = actor({ x: 300.1 });
    const initial = stepRuntimeSpatial({ ...fixture([owner], [owner]), navigation: longGraph, animalLimit: { pigeons: 0, dogs: 1 } });
    const dog = { ...initial.animals[0]!, x: 298, z: 0 };
    const tick = 120 + initial.state.walkers[0]!.phaseTicks;
    const state = { ...initial.state, walkers: initial.state.walkers.map((track) => ({ ...track, lastTick: tick - 60 })), animals: [dog] };
    const result = stepRuntimeSpatial({ ...fixture([owner], [owner], tick), navigation: longGraph, previous: state,
      anchors: [{ id: "origin", x: 0, z: 0 }], significantActorIds: [1], animalLimit: { pigeons: 0, dogs: 1 } });
    expect(result.metadata[0]!.blockedBy).toBe("leash");
    expect(result.actors[0]!.x).toBe(300.1);
    expect(Math.abs(result.animals[0]!.x - result.actors[0]!.x)).toBeLessThanOrEqual(RUNTIME_LEASH_M);
  });

  it("keeps pursuit behind a closed crosswalk instead of taking a direct street shortcut", () => {
    const crossing = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
      { id: "c", x: 20, z: 0 }, { id: "d", x: 30, z: 0 }], edges: [
      { id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
      { id: "bc", a: "b", b: "c", kind: "crosswalk", points: [[10, 0], [20, 0]] },
      { id: "cd", a: "c", b: "d", kind: "sidewalk", points: [[20, 0], [30, 0]] },
    ] });
    let prior = actor({ kind: "errandRobot", x: 9.99 });
    let state: RuntimeSpatialState | undefined;
    for (let tick = 1; tick <= 10; tick++) {
      const result = stepRuntimeSpatial({ ...fixture([prior], [{ ...prior, x: prior.x + 0.025 }], tick), navigation: crossing,
        previous: state, canCross: () => false, robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" },
          destination: { x: 30, z: 0 }, stopDistance: 1, avoidFog: false } }] });
      expect(result.actors[0]!.x).toBeLessThanOrEqual(10);
      prior = result.actors[0]!;
      state = result.state;
    }
  });

  it("preserves live dive/recover state and explicit dodge authority", () => {
    const diving = actor({ mode: "dive", dodge: { phase: "dive", sx: 10, sz: 0, tx: 12, tz: 0,
      t: 2, dur: 20, peak: 1, hop: 0.2, leap: false } });
    const moved = { ...diving, x: 10.2, y: 0.2 };
    expect(stepRuntimeSpatial(fixture([diving], [moved])).actors[0]).toBe(moved);
    const current = actor({ x: 11 });
    expect(stepRuntimeSpatial({ ...fixture([actor()], [current]), dodgeActorIds: [1] }).actors[0]).toBe(current);
  });

  it("uses authoritative player horn observations for reactions", () => {
    const previous = actor();
    const current = actor({ x: 10.025 });
    const base = fixture([previous], [current]);
    const playerState = createInitialState(base.context.world, 17, ["p"], { x: 1000, z: 1000, heading: 0 });
    const player = { ...playerState.players.p!, mode: "foot" as const, foot: makeFoot(9, 0, 0, 0) };
    const context = { ...base.context, previous: { ...base.context.previous, players: { p: player } },
      state: { ...base.context.state, players: { p: player } }, inputs: { p: { throttle: 0, steer: 0, brake: 0, actions: Action.horn } } };
    const result = stepRuntimeSpatial({ ...base, context });
    expect(result.metadata[0]!.reaction).toBe("startle");
    expect(result.actors[0]!.x).toBe(10);
  });

  it("spawns bounded protected animals with persistent identities and leashes", () => {
    const people = Array.from({ length: 20 }, (_, i) => actor({ id: i + 1, x: 5 + i * 4 }));
    const first = stepRuntimeSpatial({ ...fixture(people, people), animalLimit: undefined });
    expect(first.animals.filter((animal) => animal.kind === "dog").length).toBeLessThanOrEqual(MAX_RUNTIME_DOGS);
    expect(first.animals.filter((animal) => animal.kind === "pigeon").length).toBeLessThanOrEqual(MAX_RUNTIME_PIGEONS);
    expect(first.animals.some((animal) => animal.kind === "dog")).toBe(true);
    expect(first.animals.some((animal) => animal.kind === "pigeon")).toBe(true);
    const ownerMap = new Map(first.actors.map((value) => [value.id, value]));
    for (const animal of first.animals) {
      expect(animal.protected).toBe(true);
      expect(animal.wet).toBe(false);
      if (animal.kind === "dog") {
        const owner = ownerMap.get(animal.ownerId!)!;
        expect(Math.sqrt((owner.x - animal.x) ** 2 + (owner.z - animal.z) ** 2)).toBeLessThanOrEqual(RUNTIME_LEASH_M);
      }
    }
    const second = stepRuntimeSpatial({ ...fixture([...people].reverse(), [...people].reverse(), 2), previous: first.state, animalLimit: undefined });
    expect(second.animals.map((value) => value.id)).toEqual(first.animals.map((value) => value.id));
    expect(second.animals.map((value) => value.rng)).toEqual(first.animals.map((value) => value.rng));
  });

  it("refuses an owner's step that would pull an existing dog beyond the leash", () => {
    const owner = actor({ heading: 0 });
    const initial = stepRuntimeSpatial({ ...fixture([owner], [owner]), animalLimit: { pigeons: 0, dogs: 1 } });
    const dog = { ...initial.animals[0]!, x: 10, z: 2.19 };
    const shiftedGraph = buildSidewalkGraph({ nodes: [{ id: "a", x: 10, z: -100 }, { id: "b", x: 10, z: 100 }],
      edges: [{ id: "walk", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[10, -100], [10, 100]] }] });
    const result = stepRuntimeSpatial({ ...fixture([owner], [{ ...owner, z: -0.025 }], 2), navigation: shiftedGraph,
      previous: { ...initial.state, walkers: [], animals: [dog] }, animalLimit: { pigeons: 0, dogs: 1 },
      robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" }, destination: { x: 10, z: -50 }, stopDistance: 1, avoidFog: false } }] });
    expect(result.actors[0]!.z).toBe(0);
    expect(result.metadata[0]!.blockedBy).toBe("leash");
  });

  it("suppresses dog policy movement while its owner is recovering from a dive", () => {
    const owner = actor();
    const initial = stepRuntimeSpatial({ ...fixture([owner], [owner]), animalLimit: { pigeons: 0, dogs: 1 } });
    const recovering = actor({ mode: "recover", dodge: { phase: "recover", sx: 10, sz: 0, tx: 10, tz: 0,
      t: 1, dur: 20, peak: 0, hop: 0, leap: false } });
    const result = stepRuntimeSpatial({ ...fixture([owner], [recovering], 2), previous: initial.state, animalLimit: { pigeons: 0, dogs: 1 } });
    expect(result.animals[0]!.x).toBe(initial.animals[0]!.x);
    expect(result.animals[0]!.z).toBe(initial.animals[0]!.z);
    expect(result.animals[0]!.speed).toBe(0);
  });

  it("produces identical state and animals after actor, anchor and intent reordering", () => {
    const people = [actor(), actor({ id: 2, x: 20 })];
    const input = { ...fixture(people, people), animalLimit: { pigeons: 2, dogs: 2 },
      anchors: [anchor, { id: "b", x: 100, z: 0 }], robotIntents: [
        { id: 1, movement: { kind: "errand" as const, avoidFog: false } },
        { id: 2, movement: { kind: "hold" as const, face: null, avoidFog: false } },
      ] };
    const a = stepRuntimeSpatial(input);
    const b = stepRuntimeSpatial({ ...input, actors: [...input.actors].reverse(), anchors: [...input.anchors].reverse(), robotIntents: [...input.robotIntents].reverse() });
    expect(b).toEqual(a);
    expect(JSON.stringify(a.state)).not.toMatch(/undefined|NaN|Infinity/);
  });

  it("builds fallback navigation without freeway or ramp bodies", () => {
    const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 100, z: 0 }, { id: "c", x: 200, z: 0 }],
      edges: [{ id: "street", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[0, 0], [100, 0]] },
        { id: "freeway", a: "b", b: "c", kind: "freeway", lanes: 2, oneway: false, points: [[100, 0], [200, 0]] }] });
    expect(createSpatialNavigation(world).edges.some((edge) => edge.roadId === "freeway")).toBe(false);
  });

  it("rejects duplicate dynamic IDs and non-finite state at public boundaries", () => {
    const input = fixture([actor()], [actor()]);
    const vehicle = { id: "van", x: 10, z: 10, previousX: 9, previousZ: 10, halfLength: 2, halfWidth: 1, speed: 1 };
    expect(() => stepRuntimeSpatial({ ...input, vehicles: [vehicle, { ...vehicle, x: 20 }] })).toThrow("vehicle");
    expect(() => stepRuntimeSpatial({ ...input, actors: [actor({ x: NaN })] })).toThrow("actor");
    const initial = stepRuntimeSpatial(input);
    expect(() => stepRuntimeSpatial({ ...input, previous: { ...initial.state, walkers: [{ ...initial.state.walkers[0]!, phaseTicks: NaN }] } }))
      .toThrow("walker state");
  });

  it("accepts the combined 2000-significant plus 800-ambient budget and rejects overflow", () => {
    const walkers = Array.from({ length: 2800 }, (_, id) => actor({ id: id + 1 }));
    const input = { ...fixture(walkers, walkers), anchors: [], navigation: buildSidewalkGraph({ nodes: [], edges: [] }) };
    const result = stepRuntimeSpatial(input);
    expect(MAX_SPATIAL_WALKERS).toBe(2800);
    expect(result.actors).toHaveLength(2800);
    expect(result.state.walkers).toHaveLength(2800);
    expect(() => stepRuntimeSpatial({ ...input, actors: [...walkers, actor({ id: 2801 })] })).toThrow("capacity");
  });

  it("shares crossing queries across walkers within a tick and rechecks next tick", () => {
    const crossing = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 20, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
        { id: "bc", a: "b", b: "c", kind: "crosswalk", points: [[10, 0], [20, 0]] }] });
    const walkers = Array.from({ length: 20 }, (_, id) => actor({ id: id + 1, kind: "errandRobot", x: 9.9 }));
    const robotIntents = walkers.map((value) => ({ id: value.id, movement: { kind: "pursue" as const,
      target: { kind: "player" as const, id: "p" }, destination: { x: 20, z: 0 }, stopDistance: 1, avoidFog: false } }));
    let calls = 0;
    const canCross = (): boolean => { calls++; return false; };
    const first = stepRuntimeSpatial({ ...fixture(walkers, walkers), navigation: crossing, robotIntents, canCross });
    expect(calls).toBe(1);
    stepRuntimeSpatial({ ...fixture([...first.actors], [...first.actors], 2), previous: first.state,
      navigation: crossing, robotIntents, canCross });
    expect(calls).toBe(2);
  });

  it("keeps signals, fog, and vehicle sweeps dynamic after warming static edge clearance", () => {
    const crossing = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 20, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
        { id: "bc", a: "b", b: "c", kind: "crosswalk", points: [[10, 0], [20, 0]] }] });
    const world = worldWith();
    let tick = 0;
    const route = (extra: Partial<RuntimeSpatialInput> = {}) => {
      const value = actor({ kind: "errandRobot", x: 9.9 });
      return stepRuntimeSpatial({ ...fixture([value], [value], ++tick, world), navigation: crossing,
        robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" },
          destination: { x: 20, z: 0 }, stopDistance: 1, avoidFog: true } }], ...extra }).state.walkers[0]!.route!.nodeIds;
    };
    expect(route({ canCross: () => true, fogDensity: () => 0 })).toContain("c");
    expect(route({ canCross: () => false })).not.toContain("c");
    expect(route({ canCross: () => true })).toContain("c");
    expect(route({ fogDensity: x => x > 10 ? 0.1 : 0 })).not.toContain("c");
    expect(route({ fogDensity: () => 0 })).toContain("c");
    const van = { id: "van", x: 15, z: 0, previousX: 15, previousZ: 0, halfLength: 1, halfWidth: 0.5, speed: 0 };
    expect(route({ vehicles: [van] })).not.toContain("c");
    expect(route({ vehicles: [{ ...van, z: 20, previousZ: 20 }] })).toContain("c");
  });

  it("isolates static edge clearance by world, edge identity, and body radius", () => {
    const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 20, z: 0 }];
    const makeGraph = (detour: boolean) => buildSidewalkGraph({ nodes, edges: [
      { id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
      { id: "bc", a: "b", b: "c", kind: "crosswalk", points: detour ? [[10, 0], [15, 5], [20, 0]] : [[10, 0], [20, 0]] },
    ] });
    const direct = makeGraph(false), empty = worldWith(), blocked = worldWith([rectangle(14, -1, 16, 1)]);
    const grazing = worldWith([rectangle(14, 0.4, 16, 0.6)]);
    let tick = 0;
    const route = (world: World, navigation = direct, kind: AgentState["kind"] = "errandRobot") => {
      const value = actor({ kind, x: 9.9 });
      return stepRuntimeSpatial({ ...fixture([value], [value], ++tick, world), navigation,
        robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" },
          destination: { x: 20, z: 0 }, stopDistance: 1, avoidFog: false } }] }).state.walkers[0]!.route!.nodeIds;
    };
    expect(route(empty)).toContain("c");
    expect(route(blocked)).not.toContain("c");
    expect(route(blocked, makeGraph(true))).toContain("c");
    expect(route(grazing, direct, "person")).toContain("c");
    expect(route(grazing, direct, "errandRobot")).not.toContain("c");
    expect(route(grazing, direct, "person")).toContain("c");
  });

  it("rejects static disconnections before repeated dynamic route searches without storing a retry delay", () => {
    const navigation = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
      { id: "e", x: 10, z: 10 }, { id: "c", x: 30, z: 0 }, { id: "d", x: 40, z: 0 }], edges: [
      { id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
      { id: "be", a: "b", b: "e", kind: "crosswalk", points: [[10, 0], [10, 10]] },
      { id: "cd", a: "c", b: "d", kind: "sidewalk", points: [[30, 0], [40, 0]] },
    ] });
    const world = worldWith(), value = actor({ kind: "errandRobot", x: 9.9 });
    let calls = 0;
    const query = () => stepRuntimeSpatial({ ...fixture([value], [value], 1, world), navigation,
      canCross: () => { calls++; return true; }, robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" },
        destination: { x: 40, z: 0 }, stopDistance: 1, avoidFog: false } }] });
    const cold = query(), warm = query();
    expect(warm).toEqual(cold);
    expect(cold.state.walkers[0]!.goalKey).toBe("");
    expect(calls).toBe(0);
    expect(JSON.stringify(warm.state)).not.toMatch(/retry|component/);
  });

  it("keeps stair routes and directed search authoritative within a weak component", () => {
    const navigation = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
      { id: "c", x: 20, z: 0 }, { id: "d", x: 30, z: 0 }], edges: [
      { id: "ab", a: "a", b: "b", kind: "sidewalk", roadId: "street", points: [[0, 0], [10, 0]] },
      { id: "bc", a: "b", b: "c", kind: "stairs", bidirectional: false, points: [[10, 0], [20, 0]] },
      { id: "cd", a: "c", b: "d", kind: "sidewalk", points: [[20, 0], [30, 0]] },
    ] });
    const world = worldWith();
    const query = (value: AgentState, target: number) => stepRuntimeSpatial({ ...fixture([value], [value], 1, world), navigation,
      robotIntents: [{ id: 1, movement: { kind: "pursue", target: { kind: "player", id: "p" },
        destination: { x: target, z: 0 }, stopDistance: 1, avoidFog: false } }] }).state.walkers[0]!;
    expect(query(actor({ kind: "errandRobot", x: 9.9 }), 30).route!.nodeIds).toContain("d");
    expect(query(actor({ kind: "errandRobot", x: 20.1, edge: "" }), 0).goalKey).toBe("");
  });
});
