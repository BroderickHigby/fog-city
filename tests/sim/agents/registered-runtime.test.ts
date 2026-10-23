import { describe, expect, it } from "vitest";
import { agentsOf, type AgentState } from "../../../src/sim/agents.ts";
import { type SimEvent, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { pathPoint, walkPath, type RoadsFile } from "../../../src/sim/roads.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { agentRuntimeSession, enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem, enforceAgentRuntimePopulation, MAX_RUNTIME_REQUEST_KEYS, runtimeCombatActors, runtimePhysicalBodies, type AgentRuntimeData } from "../../../src/sim/agents/runtime-system.ts";

function roadWorld(): World {
  const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }, { id: "c", x: 240, z: 120 }, { id: "d", x: 0, z: 120 }];
  const edge = (id: string, a: number, b: number): RoadsFile["edges"][number] => ({ id, a: nodes[a]!.id, b: nodes[b]!.id, kind: "residential", lanes: 2, oneway: false, widthM: 14, speedLimitMps: 16, points: [[nodes[a]!.x, nodes[a]!.z], [nodes[b]!.x, nodes[b]!.z]] });
  return buildWorld([{ tileId: "test", buildings: [], ground: null }], { version: 1, nodes, edges: [edge("ab", 0, 1), edge("bc", 1, 2), edge("cd", 2, 3), edge("da", 3, 0)] });
}

function actor(id: number, x = 30, z = 9, kind: AgentState["kind"] = "errandRobot"): AgentState {
  return { id, kind, x, y: 0, z, heading: 1.570796, pitch: 0, speed: 0, vmax: 1.5, edge: "ab", dir: 1, lane: 1, s: x, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1234, dodge: null };
}

function fixture(world: World, list: AgentState[] = []): SimState {
  const state = enableAgentRuntime(createInitialState(world, 42, ["p"], { x: 180, z: 0, heading: 0 }), { wave: 2, startGameMinute: 1 });
  return { ...state, ext: { ...state.ext, agents: { nextId: Math.max(100, ...list.map((value) => value.id + 1)), list } } };
}

const options = { depots: [{ id: "depot", kind: "depot" as const, x: 15, z: 0 }], ferry: { x: 15, z: 120 }, animalLimit: { pigeons: 0, dogs: 0 } };
function threat(id = "threat:p:1", tick = 1): SimEvent {
  return { kind: "threat.spawn", tick, payload: { id, requestTick: tick, playerId: "p", player: { x: 9999, z: 9999 }, kind: "van", threat: 2, unitCount: 2 } };
}

describe("registered agent runtime", () => {
  it("is an exact no-op without the serialized activation marker", () => {
    const world = roadWorld();
    const state = createInitialState(world, 42, ["p"], { x: 180, z: 0, heading: 0 });
    const system = createAgentRuntimeSystem(options);
    expect(system.step({ world, previous: state, state, inputs: {}, events: [threat()] })).toBe(state);
    expect(agentsRuntimeOf(state)).toBeNull();
    expect(runtimePhysicalBodies(state)).toEqual([]);
  });

  it("rejects malformed enabled runtime state explicitly without resetting live fleet data", () => {
    const world = buildWorld([]);
    const state = fixture(world);
    const malformed = { ...state, ext: { ...state.ext, agents: { ...state.ext.agents!, runtime: { version: 1, tick: 0, bodies: [], requests: [], significantAgentIds: [], spatial: {}, fleet: {} } } } };
    expect(() => agentsRuntimeOf(malformed)).toThrow("Invalid agent runtime state");
    expect(() => createAgentRuntimeSystem(options).step({ world, previous: malformed, state: { ...malformed, tick: 1 }, inputs: {}, events: [] })).toThrow("Invalid agent runtime state");
  });

  it("registers through the real step hook and maps repeated string requests exactly once", () => {
    const world = roadWorld();
    const system = createAgentRuntimeSystem(options);
    const previous = fixture(world);
    const next = step(world, previous, {}, [threat()], [system]);
    expect(agentsRuntimeOf(next)?.fleet.vans.jobs).toHaveLength(1);
    expect(agentsRuntimeOf(next)?.requests[0]).toMatchObject({ key: "threat:p:1", numericId: 0 });
    const target = agentsRuntimeOf(next)!.fleet.vans.jobs[0]!.route!.target;
    expect(Math.abs(target.x - next.players.p!.car.x)).toBeLessThanOrEqual(12);
    const repeated = step(world, next, {}, [{ ...threat(), tick: 2 }], [system]);
    expect(agentsRuntimeOf(repeated)?.fleet.vans.jobs).toHaveLength(1);
    expect(agentsRuntimeOf(repeated)?.nextRequestId).toBe(1);
    expect(next.ext.agents!.nextId).toBeGreaterThan(agentsRuntimeOf(next)!.fleet.vehicles[0]!.id);
  });

  it("includes the published departure at activation before the first runtime tick", () => {
    const world = roadWorld();
    const previous = enableAgentRuntime(fixture(world), { wave: 2, startGameMinute: 0 });
    const result = createAgentRuntimeSystem(options).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(result)?.fleet.buses.runs).toHaveLength(1);
    expect(agentsRuntimeOf(result)?.fleet.buses.runs[0]?.scheduledGameMinute).toBe(0);
    expect(runtimePhysicalBodies(result).some((body) => body.model === "bus")).toBe(true);
  });

  it("turns physical disembarkations into persistent, correctly routed legacy robot actors", () => {
    const world = roadWorld();
    const system = createAgentRuntimeSystem(options);
    let state = fixture(world);
    let event: AgentRuntimeData["events"][number] | undefined;
    for (let tick = 1; tick <= 1201; tick++) {
      state = step(world, state, {}, tick === 1 ? [threat()] : [], [system]);
      event = agentsRuntimeOf(state)?.events[0];
      if (event) break;
    }
    expect(event?.unitIds).toHaveLength(2);
    const runtime = agentsRuntimeOf(state)!;
    expect(runtime.deliveredAgentIds).toEqual(event!.unitIds);
    expect(runtime.significantAgentIds).toEqual(event!.unitIds);
    for (const id of event!.unitIds) {
      const unit = agentsOf(state).find((candidate) => candidate.id === id)!;
      expect(unit.kind).toBe("errandRobot");
      expect(world.roads!.edgeIndex.has(unit.edge)).toBe(true);
      expect(unit.dodge).toBeNull();
    }
    const removedByAmbient = { ...state, tick: state.tick + 1, ext: { ...state.ext, agents: { ...state.ext.agents!, list: [] } } };
    const restored = system.step({ world, previous: state, state: removedByAmbient, inputs: {}, events: [] });
    expect(event!.unitIds.every((id) => agentsOf(restored).some((candidate) => candidate.id === id))).toBe(true);
  });

  it("consumes valid player/heat events and rejects malformed or future requests", () => {
    const world = roadWorld();
    const system = createAgentRuntimeSystem(options);
    const previous = fixture(world);
    const state: SimState = { ...previous, tick: 1, ext: { ...previous.ext, heat: { events: [{ kind: "threat.spawn", tick: 1,
      payload: { id: "threat:p:1", requestTick: 1, playerId: "p", player: { x: 9999, z: 9999 }, kind: "van", threat: 2, unitCount: 2 } }] } } };
    const result = system.step({ world, previous, state, inputs: {}, events: [{ ...threat("future", 2) }, { ...threat("bad", 1), payload: { id: "bad", kind: "van", threat: 2, unitCount: 30 } }] });
    expect(agentsRuntimeOf(result)?.requests.map((value) => value.key)).toEqual(["threat:p:1"]);
  });

  it("retains significant actors and prioritizes robot parity within the ambient budget", () => {
    const world = buildWorld([]);
    const system = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } });
    const actors = Array.from({ length: 240 }, (_, i) => actor(i + 1, 180 + i % 5, 0, i < 120 ? "person" : "errandRobot"));
    const previous = fixture(world, actors);
    const state = { ...previous, tick: 1 };
    const result = system.step({ world, previous, state, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(result)!;
    expect(runtime.population.ambient).toBe(60);
    expect(runtime.population.robots).toBeGreaterThanOrEqual(runtime.population.people);
    expect(runtime.population.perAnchor[0]?.count).toBeLessThanOrEqual(60);
    expect(runtime.diagnostics).toContain("population:ambient=60:significant=0");
  });

  it("raises actual selected bad-robot density 1.5 times during nearby Conference Week", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 200 }, (_, index) => actor(index + 1, 180, 0, index < 100 ? "errandRobot" : "person"));
    const base = fixture(world, list);
    const metadata = list.filter((value) => value.kind !== "person").map((value) => ({ agentId: value.id, firmware: value.id % 3 === 0 ? "bad" : "good" }));
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, metadata } } };
    const system = createAgentRuntimeSystem(options);
    const normal = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const normalRuntime = agentsRuntimeOf(normal)!;
    const conferencing = { ...normal, ext: { ...normal.ext, agents: { ...normal.ext.agents!, runtime: { ...normalRuntime,
      routineOutput: { conference: { badRateMultiplier: 1.5, lanyardCrowd: true, center: { x: 180, y: 0, z: 0 }, radiusM: 600 } } } } } };
    const result = system.step({ world, previous: conferencing, state: { ...conferencing, tick: 2, ext: { ...conferencing.ext, agents: { ...conferencing.ext.agents!, list } } }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(result)!;
    expect(normalRuntime.population.badRobots).toBe(10);
    expect(runtime.population.badRobots).toBe(15);
    expect(agentsOf(result).filter((value) => value.kind === "errandRobot" && value.id % 3 === 0)).toHaveLength(15);
    expect(runtime.population.ambient).toBe(60);
    expect(runtime.lanyardPersonIds).toHaveLength(30);
    expect(agentsOf(result).every((value) => list.some((source) => source.id === value.id))).toBe(true);
    const continued = system.step({ world, previous: result, state: { ...result, tick: 3, ext: { ...result.ext, agents: { ...result.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(continued)?.population.badRobots).toBe(15);
    const ended = { ...continued, ext: { ...continued.ext, agents: { ...continued.ext.agents!, runtime: { ...agentsRuntimeOf(continued)!,
      routineOutput: { conference: { badRateMultiplier: 1, lanyardCrowd: false } } } } } };
    const reverted = system.step({ world, previous: ended, state: { ...ended, tick: 4, ext: { ...ended.ext, agents: { ...ended.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(reverted)?.population.badRobots).toBe(10);
    expect(agentsRuntimeOf(reverted)?.lanyardPersonIds).toEqual([]);
    const restarted = { ...reverted, ext: { ...reverted.ext, agents: { ...reverted.ext.agents!, runtime: { ...agentsRuntimeOf(reverted)!,
      routineOutput: { conference: { badRateMultiplier: 1.5, lanyardCrowd: true, center: { x: 180, y: 0, z: 0 }, radiusM: 600 } } } } } };
    const boostedAgain = system.step({ world, previous: restarted, state: { ...restarted, tick: 5, ext: { ...restarted.ext, agents: { ...restarted.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(boostedAgain)?.population.badRobots).toBe(15);
    const distant = { ...normal, ext: { ...normal.ext, agents: { ...normal.ext.agents!, runtime: { ...normalRuntime,
      routineOutput: { conference: { badRateMultiplier: 1.5, lanyardCrowd: true, center: { x: 5000, y: 0, z: 0 }, radiusM: 600 } } } } } };
    const outside = system.step({ world, previous: distant, state: { ...distant, tick: 2, ext: { ...distant.ext, agents: { ...distant.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(outside)?.population.badRobots).toBe(10);
    expect(agentsRuntimeOf(outside)?.lanyardPersonIds).toEqual([]);
  });

  it("counts every overlapping anchor while preserving significant actors outside the ambient budget", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 240 }, (_, i) => actor(i + 1, i % 2 === 0 ? -20 : 20, 0, i < 120 ? "errandRobot" : "person"));
    list.push(actor(500, 0, 0));
    const base = fixture(world, list);
    const previous = { ...base, players: {
      p: { ...base.players.p!, car: { ...base.players.p!.car, x: -100, z: 0 } },
      q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 100, z: 0 } },
    }, ext: { ...base.ext, robots: { ...base.ext.robots!, significantAgentIds: [500] } } };
    const result = createAgentRuntimeSystem(options).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(result)!;
    const ambient = agentsOf(result).filter(value => value.id !== 500);
    expect(ambient).toHaveLength(60);
    expect(runtime.population.significant).toBe(1);
    expect(agentsOf(result).some(value => value.id === 500)).toBe(true);
    for (const player of [result.players.p!, result.players.q!]) {
      expect(ambient.filter(value => (value.x - player.car.x) ** 2 + (value.z - player.car.z) ** 2 <= 300 ** 2)).toHaveLength(60);
    }
    expect(runtime.population.perAnchor).toEqual([{ id: "p", count: 60 }, { id: "q", count: 60 }]);
  });

  it("keeps stable identities when overlap ownership moves and input order reverses", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 120 }, (_, i) => actor(i + 100, -20, 0, i < 60 ? "errandRobot" : "person"));
    const base = fixture(world, list);
    const previous = { ...base, players: {
      p: { ...base.players.p!, car: { ...base.players.p!.car, x: 0, z: 0 } },
      q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 100, z: 0 } },
    } };
    const system = createAgentRuntimeSystem(options);
    const first = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const ids = agentsOf(first).map(value => value.id);
    const fresh = Array.from({ length: 80 }, (_, i) => actor(i + 1, -120, 0, i < 40 ? "errandRobot" : "person"));
    const moved = { ...first, tick: 2, players: {
      p: { ...first.players.p!, car: { ...first.players.p!.car, x: -100 } },
      q: { ...first.players.q!, car: { ...first.players.q!.car, x: 0 } },
    }, ext: { ...first.ext, agents: { ...first.ext.agents!, list: [...list, ...fresh] } } };
    const result = system.step({ world, previous: first, state: moved, inputs: {}, events: [] });
    expect(agentsOf(result).map(value => value.id)).toEqual(ids);
    const reversed = { ...moved, players: { q: moved.players.q, p: moved.players.p }, ext: { ...moved.ext, agents: { ...moved.ext.agents, list: [...moved.ext.agents.list].reverse() } } };
    const replay = createAgentRuntimeSystem(options).step({ world, previous: first, state: reversed, inputs: {}, events: [] });
    expect(agentsOf(replay).map(value => value.id)).toEqual(ids);
  });

  it("reserves animals against every overlapping anchor's ambient budget", () => {
    const world = roadWorld();
    const list = Array.from({ length: 180 }, (_, i) => actor(i + 1, 100 + i % 2, 9, i < 90 ? "errandRobot" : "person"));
    const base = fixture(world, list);
    const previous = { ...base, players: { ...base.players, q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 160 } } } };
    const result = createAgentRuntimeSystem({ ...options, animalLimit: { pigeons: 4, dogs: 0 } }).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(result)!;
    expect(runtime.spatial.animals).toHaveLength(4);
    expect(runtime.population.ambient).toBe(60);
    expect(runtime.population.perAnchor).toEqual([{ id: "p", count: 60 }, { id: "q", count: 60 }]);
    for (const player of [result.players.p!, result.players.q!]) {
      const actual = [...agentsOf(result), ...runtime.spatial.animals].filter(value => (value.x - player.car.x) ** 2 + (value.z - player.car.z) ** 2 <= 300 ** 2);
      expect(actual).toHaveLength(60);
    }
  });

  it("keeps the Conference Week multiplier and its baseline when anchors overlap", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 200 }, (_, i) => actor(i + 1, i % 2 === 0 ? 160 : 220, 0, i < 100 ? "errandRobot" : "person"));
    const base = fixture(world, list);
    const metadata = list.filter(value => value.kind !== "person").map(value => ({ agentId: value.id, firmware: value.id % 3 === 0 ? "bad" : "good" }));
    const previous = { ...base, players: { ...base.players, q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 200 } } },
      ext: { ...base.ext, robots: { ...base.ext.robots!, metadata } } };
    const system = createAgentRuntimeSystem(options);
    const normal = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(normal)!;
    const active = { ...normal, ext: { ...normal.ext, agents: { ...normal.ext.agents!, runtime: { ...runtime, routineOutput: { conference: { badRateMultiplier: 1.5, lanyardCrowd: true } } } } } };
    const boosted = system.step({ world, previous: active, state: { ...active, tick: 2, ext: { ...active.ext, agents: { ...active.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(runtime.population.badRobots).toBe(10);
    expect(agentsRuntimeOf(boosted)?.population.badRobots).toBe(15);
    expect(agentsRuntimeOf(boosted)?.population.perAnchor.every(value => value.count <= 60)).toBe(true);
    const ended = { ...boosted, ext: { ...boosted.ext, agents: { ...boosted.ext.agents!, runtime: { ...agentsRuntimeOf(boosted)!, routineOutput: { conference: { badRateMultiplier: 1, lanyardCrowd: false } } } } } };
    const restored = system.step({ world, previous: ended, state: { ...ended, tick: 3, ext: { ...ended.ext, agents: { ...ended.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(restored)?.population.badRobots).toBe(10);
  });

  it("keeps people, robots and Conference quotas when separate crowds enter overlap", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 240 }, (_, i) => actor(i + 1, i % 2 === 0 ? -100 : 100, 0, i < 120 ? "errandRobot" : "person"));
    const base = fixture(world, list);
    const metadata = list.filter(value => value.kind !== "person").map(value => ({ agentId: value.id, firmware: value.id % 3 === 0 ? "bad" : "good" }));
    const previous = { ...base, players: {
      p: { ...base.players.p!, car: { ...base.players.p!.car, x: -400, z: 0 } },
      q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 400, z: 0 } },
    }, ext: { ...base.ext, robots: { ...base.ext.robots!, metadata } } };
    const system = createAgentRuntimeSystem(options);
    const separated = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(separated)?.population.ambient).toBe(120);
    const active = { ...separated, players: {
      p: { ...separated.players.p!, car: { ...separated.players.p!.car, x: -50 } },
      q: { ...separated.players.q!, car: { ...separated.players.q!.car, x: 50 } },
    }, ext: { ...separated.ext, agents: { ...separated.ext.agents!, runtime: { ...agentsRuntimeOf(separated)!, routineOutput: { conference: { badRateMultiplier: 1.5, lanyardCrowd: true } } } } } };
    const merged = system.step({ world, previous: active, state: { ...active, tick: 2, ext: { ...active.ext, agents: { ...active.ext.agents!, list } } }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(merged)?.population).toMatchObject({ ambient: 60, robots: 30, people: 30, badRobots: 15 });
    expect(agentsRuntimeOf(merged)?.population.perAnchor).toEqual([{ id: "p", count: 60 }, { id: "q", count: 60 }]);
    expect(agentsRuntimeOf(merged)?.population.badBaselines.map(value => value.count)).toEqual([5, 5]);
  });

  it("recaps final boundary-crossing poses and prunes walkers, metadata and orphaned dogs", () => {
    const world = buildWorld([]);
    const list = [
      ...Array.from({ length: 60 }, (_, i) => actor(i + 100, 0, 0, i < 30 ? "errandRobot" : "person")),
      ...Array.from({ length: 60 }, (_, i) => actor(i + 200, 300.1, 0, i < 30 ? "errandRobot" : "person")),
    ];
    const base = fixture(world, list);
    const previous = { ...base, players: {
      p: { ...base.players.p!, car: { ...base.players.p!.car, x: 0, z: 0 } },
      q: { ...base.players.p!, id: "q", car: { ...base.players.p!.car, x: 600, z: 0 } },
    } };
    const first = createAgentRuntimeSystem(options).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(first)!;
    const dog = { id: "dog:259", kind: "dog" as const, x: 299.9, y: 0, z: 0, heading: 0, speed: 0, radius: 0.3, protected: true as const, wet: false as const,
      ownerId: 259, leashM: 2.2, edgeId: null, distanceM: 0, direction: 1 as const, phaseTicks: 0, rng: 1, reaction: { mode: "idle" as const, untilTick: 0, source: null } };
    const dogBody: RuntimePhysicalBody = { id: dog.id, numericId: 1000, kind: "animal", model: "dog", x: dog.x, y: 0, z: 0, previousX: 300.1, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: .3, halfLength: .3, halfWidth: .3, height: .5, dodge: null };
    const crossed = { ...first, ext: { ...first.ext, agents: { ...first.ext.agents!, list: agentsOf(first).map(value => value.id === 259 ? { ...value, x: 299.9 } : value),
      runtime: { ...runtime, bodies: [dogBody], spatial: { ...runtime.spatial, animals: [dog] }, animalIds: [{ key: dog.id, id: 1000, lastSeenTick: 1 }], routineOutput: { actorMetadata: { "agent:259": { firmware: "good" } } } } },
      robots: { ...first.ext.robots!, actors: [{ id: dog.id, kind: "animal" }], metadata: list.map(value => ({ agentId: value.id, actorId: `agent:${value.id}` })),
        locomotion: list.map(value => ({ agentId: value.id })), baselines: list.map(value => ({ agentId: value.id })),
        brain: { version: 1, tick: 1, robots: list.map(value => ({ agentId: value.id })) } } } };
    const result = enforceAgentRuntimePopulation(crossed);
    const next = agentsRuntimeOf(result)!;
    const retained = new Set(agentsOf(result).map(value => value.id));
    expect(retained.has(259)).toBe(false);
    expect(next.population.perAnchor.every(value => value.count <= 60)).toBe(true);
    expect(next.spatial.walkers.every(value => retained.has(value.id))).toBe(true);
    expect(next.spatial.animals).toEqual([]);
    expect(next.animalIds).toEqual([]);
    expect(next.bodies).toEqual([]);
    expect(result.ext.robots!.actors).toEqual([]);
    expect(result.ext.robots!.metadata).toEqual(expect.not.arrayContaining([expect.objectContaining({ agentId: 259 })]));
    expect(result.ext.robots!.locomotion).toEqual(expect.not.arrayContaining([expect.objectContaining({ agentId: 259 })]));
    expect((next.routineOutput as { actorMetadata: Record<string, unknown> }).actorMetadata["agent:259"]).toBeUndefined();
  });

  it("caps global ambient population at 800 across 24 independent anchors", () => {
    const world = buildWorld([]);
    const system = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } });
    const base = fixture(world);
    const players: SimState["players"] = {};
    const list: AgentState[] = [];
    for (let group = 0; group < 24; group++) {
      const id = `p${String(group).padStart(2, "0")}`;
      players[id] = { ...base.players.p!, id, car: { ...base.players.p!.car, x: group * 1000, z: 0 } };
      for (let index = 0; index < 70; index++) list.push(actor(group * 100 + index + 1, group * 1000 + 20, 0));
    }
    const previous = { ...base, players, ext: { ...base.ext, agents: { nextId: 3000, list } } };
    const state = { ...previous, tick: 1 };
    const result = system.step({ world, previous, state, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(result)!;
    expect(runtime.population.ambient).toBe(800);
    expect(runtime.population.perAnchor.every((value) => value.count <= 60)).toBe(true);
  });

  it("uses previous robot hold intents and preserves a significant actor omitted by ambient population", () => {
    const world = roadWorld();
    const path = walkPath(world.roads!.edges.find((edge) => edge.id === "ab")!, 1, 1);
    const point = pathPoint(path, 30);
    const robot = actor(1, point.x, point.z);
    const base = fixture(world, [robot]);
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, significantAgentIds: [1], locomotion: [{ agentId: 1, intent: { kind: "hold", face: null, avoidFog: false }, combat: { maxSpeed: 0, scale: 0, blind: false, canAttack: false } }] } } };
    const state = { ...previous, tick: 1, ext: { ...previous.ext, agents: { nextId: 100, list: [] } } };
    const result = createAgentRuntimeSystem(options).step({ world, previous, state, inputs: {}, events: [] });
    expect(agentsOf(result)).toHaveLength(1);
    expect(agentsOf(result)[0]).toMatchObject({ id: 1, x: robot.x, z: robot.z, speed: 0 });
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([1]);
  });

  it("applies fractional combat movement limits without permanently changing cruise speed", () => {
    const world = roadWorld();
    const path = walkPath(world.roads!.edges.find((edge) => edge.id === "ab")!, 1, 1);
    const point = pathPoint(path, 30);
    const robot = actor(1, point.x, point.z);
    const base = fixture(world, [robot]);
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, locomotion: [{ agentId: 1, intent: { kind: "errand", avoidFog: false }, combat: { maxSpeed: null, scale: 0.5, blind: false, canAttack: true } }] } } };
    const currentRobot = { ...robot, x: robot.x + 0.025, speed: 1.5 };
    const state = { ...previous, tick: 1, ext: { ...previous.ext, agents: { nextId: 100, list: [currentRobot] } } };
    const result = createAgentRuntimeSystem(options).step({ world, previous, state, inputs: {}, events: [] });
    expect(agentsOf(result)[0]!.x - robot.x).toBeLessThanOrEqual(0.01250001);
    expect(agentsOf(result)[0]!.vmax).toBe(1.5);
  });

  it("applies a seizure from the immediately previous combat tick before stale locomotion", () => {
    const world = roadWorld();
    const path = walkPath(world.roads!.edges.find((edge) => edge.id === "ab")!, 1, 1);
    const point = pathPoint(path, 30);
    const robot = actor(1, point.x, point.z);
    const combat = createCombatState(42, { actors: [{ id: "agent:1", kind: "robot", firmware: "bad", model: "footman", radius: 0.4, height: 1.8,
      x: robot.x, y: robot.y, z: robot.z, heading: robot.heading, speed: 0 }], players: [], walls: [], refills: [] }, 0);
    combat.targets["agent:1"]!.phase = "seized";
    const base = fixture(world, [robot]);
    const previous = { ...base, ext: { ...base.ext, combat, robots: { ...base.ext.robots!, locomotion: [{ agentId: 1, intent: { kind: "errand", avoidFog: false }, combat: { maxSpeed: null, scale: 1, blind: false, canAttack: true } }] } } };
    const current = { ...previous, tick: 1, ext: { ...previous.ext, agents: { nextId: 100, list: [{ ...robot, x: robot.x + 0.025, speed: 1.5 }] } } };
    const result = createAgentRuntimeSystem(options).step({ world, previous, state: current, inputs: {}, events: [] });
    expect(agentsOf(result)[0]).toMatchObject({ x: robot.x, z: robot.z, speed: 0, vmax: robot.vmax });
  });

  it("preserves all 2000 significant actors outside every active anchor", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 2000 }, (_, index) => actor(index + 1, 10000 + index, 0));
    const base = fixture(world, list);
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, significantAgentIds: list.map((value) => value.id) } } };
    const current = { ...previous, tick: 1, ext: { ...previous.ext, agents: { nextId: 2001, list: [] } } };
    const result = createAgentRuntimeSystem(options).step({ world, previous, state: current, inputs: {}, events: [] });
    expect(agentsOf(result)).toHaveLength(2000);
    expect(agentsRuntimeOf(result)?.population.significant).toBe(2000);
    expect(agentsRuntimeOf(result)?.population.ambient).toBe(0);
  });

  it("queues a van while significance capacity is full, then retries the same mapped request", () => {
    const world = roadWorld();
    const list = Array.from({ length: 1999 }, (_, index) => actor(index + 1, 10000 + index, 0));
    const base = fixture(world, list);
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, significantAgentIds: list.map((value) => value.id) } } };
    const system = createAgentRuntimeSystem(options);
    const queued = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [threat()] });
    expect(agentsRuntimeOf(queued)?.queuedVanRequests).toHaveLength(1);
    expect(agentsRuntimeOf(queued)?.fleet.vans.jobs).toEqual([]);
    const retired = { ...queued, ext: { ...queued.ext, robots: { ...queued.ext.robots!, retiredAgentIds: [1999] } } };
    const dispatched = system.step({ world, previous: retired, state: { ...retired, tick: 2 }, inputs: {}, events: [threat()] });
    expect(agentsRuntimeOf(dispatched)?.queuedVanRequests).toEqual([]);
    expect(agentsRuntimeOf(dispatched)?.fleet.vans.jobs[0]?.requestId).toBe(0);
    expect(agentsRuntimeOf(dispatched)?.nextRequestId).toBe(1);
  });

  it("emits an explicit rejection when a capacity-queued van reaches its deadline", () => {
    const world = buildWorld([]);
    const list = Array.from({ length: 1999 }, (_, index) => actor(index + 1, 10000 + index, 0));
    const base = fixture(world, list);
    const previous = { ...base, ext: { ...base.ext, robots: { ...base.ext.robots!, significantAgentIds: list.map((value) => value.id) } } };
    const system = createAgentRuntimeSystem(options);
    const queued = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [threat()] });
    const expired = system.step({ world, previous: queued, state: { ...queued, tick: 1201 }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(expired)?.queuedVanRequests).toEqual([]);
    expect(agentsRuntimeOf(expired)?.events).toMatchObject([{ kind: "van.rejected", reason: "capacity-deadline", sourceRequestId: "threat:p:1" }]);
  });

  it("reserves externally owned significant bodies before admitting two van units", () => {
    const world = roadWorld(); const base = fixture(world); const system = createAgentRuntimeSystem(options);
    const first = system.step({ world, previous: base, state: { ...base, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(first)!;
    const full = { ...first, ext: { ...first.ext, agents: { ...first.ext.agents!, runtime: { ...runtime, population: { ...runtime.population, significant: 1999, extraSignificant: 1999 } } } } };
    const queued = system.step({ world, previous: full, state: { ...full, tick: 2 }, inputs: {}, events: [threat("extra-capacity", 2)] });
    expect(agentsRuntimeOf(queued)?.queuedVanRequests).toHaveLength(1);
    expect(agentsRuntimeOf(queued)?.fleet.vans.jobs).toEqual([]);
    const queuedRuntime = agentsRuntimeOf(queued)!;
    const freed = { ...queued, ext: { ...queued.ext, agents: { ...queued.ext.agents!, runtime: { ...queuedRuntime, population: { ...queuedRuntime.population, significant: 1998, extraSignificant: 1998 } } } } };
    const dispatched = system.step({ world, previous: freed, state: { ...freed, tick: 3 }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(dispatched)?.queuedVanRequests).toEqual([]);
    expect(agentsRuntimeOf(dispatched)?.fleet.vans.jobs[0]?.vehicleId).not.toBeNull();
    expect(agentsRuntimeOf(dispatched)?.population.reservedVanUnits).toBe(2);
  });

  it("allocates animal IDs centrally and exposes protected extra bodies", () => {
    const world = roadWorld();
    const previous = fixture(world);
    const result = createAgentRuntimeSystem({ ...options, animalLimit: { pigeons: 2, dogs: 0 } }).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const bodies = runtimePhysicalBodies(result);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.numericId)).size).toBe(2);
    expect(result.ext.agents!.nextId).toBeGreaterThan(Math.max(...bodies.map((body) => body.numericId)));
    expect(runtimeCombatActors(result).every((body) => body.kind === "animal" && body.protected && body.firmware === "none")).toBe(true);
  });

  it("keeps bounded request keys and deterministic mappings under replay and input permutation", () => {
    const world = buildWorld([]);
    const a = createAgentRuntimeSystem(options);
    const b = createAgentRuntimeSystem(options);
    const previous = fixture(world);
    const state = { ...previous, tick: 1 };
    const events = Array.from({ length: 150 }, (_, index) => threat(`r${index}`, 1));
    const result = a.step({ world, previous, state, inputs: {}, events });
    expect(b.step({ world, previous, state, inputs: {}, events: [...events].reverse() })).toEqual(result);
    expect(agentsRuntimeOf(result)!.requests.length).toBeLessThanOrEqual(MAX_RUNTIME_REQUEST_KEYS);
    const restored = JSON.parse(JSON.stringify(result)) as SimState;
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const replay = a.step({ world, previous: restored, state: { ...restored, tick: 2 }, inputs: {}, events });
    expect(agentsRuntimeOf(replay)?.nextRequestId).toBe(150);
  });

  it("reuses its navigation cache safely across different worlds", () => {
    const system = createAgentRuntimeSystem(options);
    const aWorld = roadWorld(); const bWorld = buildWorld([]);
    const a = fixture(aWorld); const b = fixture(bWorld);
    const first = system.step({ world: aWorld, previous: a, state: { ...a, tick: 1 }, inputs: {}, events: [] });
    system.step({ world: bWorld, previous: b, state: { ...b, tick: 1 }, inputs: {}, events: [] });
    expect(system.step({ world: aWorld, previous: a, state: { ...a, tick: 1 }, inputs: {}, events: [] })).toEqual(first);
    expect(agentRuntimeSession(first)?.enabled).toBe(true);
  });

  it("preserves future extra-robot models and firmware in combat descriptors", () => {
    const world = buildWorld([]); const previous = fixture(world);
    const state = createAgentRuntimeSystem(options).step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(state)!;
    const body: RuntimePhysicalBody = { id: "tidy:1", numericId: 999, kind: "robot", model: "tidy", firmware: "good", operational: true, x: 10, y: 0, z: 10, previousX: 10, previousZ: 10, heading: 0, previousHeading: 0, speed: 0, radius: 1, halfLength: 1, halfWidth: 1, height: 2, dodge: null };
    const modified = { ...state, ext: { ...state.ext, agents: { ...state.ext.agents!, runtime: { ...runtime, bodies: [body] } } } };
    expect(runtimeCombatActors(modified)[0]).toMatchObject({ kind: "robot", model: "tidy", firmware: "good" });
    const finale = { ...modified, ext: { ...modified.ext, agents: { ...modified.ext.agents!, runtime: { ...runtime, bodies: [{ ...body, model: "elizabeth", firmware: "bad" as const }] } } } };
    expect(runtimeCombatActors(finale)[0]?.model).toBe("walker");
    const unknown = { ...modified, ext: { ...modified.ext, agents: { ...modified.ext.agents!, runtime: { ...runtime, bodies: [{ ...body, model: "unclassified-special" }] } } } };
    expect(runtimeCombatActors(unknown)[0]?.model).toBeUndefined();
    const progressed = createAgentRuntimeSystem(options).step({ world, previous: modified, state: { ...modified, tick: 2 }, inputs: {}, events: [] });
    expect(runtimePhysicalBodies(progressed).some((value) => value.id === "tidy:1" && value.firmware === "good")).toBe(true);
    expect(progressed.ext.agents!.nextId).toBeGreaterThan(999);
  });

  it("preserves same-key routine and transport payloads for composed runtime reducers", () => {
    const world = buildWorld([]); const previous = fixture(world);
    const system = createAgentRuntimeSystem(options);
    const first = system.step({ world, previous, state: { ...previous, tick: 1 }, inputs: {}, events: [] });
    const runtime = agentsRuntimeOf(first)!;
    const shared = { ...first, ext: { ...first.ext, agents: { ...first.ext.agents!, runtime: { ...runtime, routines: { phase: 1 }, routineOutput: { visible: true }, effectState: { sequence: 2 }, transport: { status: "driving" } } } } };
    const next = system.step({ world, previous: shared, state: { ...shared, tick: 2 }, inputs: {}, events: [] });
    expect(agentsRuntimeOf(next)).toMatchObject({ routines: { phase: 1 }, routineOutput: { visible: true }, effectState: { sequence: 2 }, transport: { status: "driving" } });
  });
});
