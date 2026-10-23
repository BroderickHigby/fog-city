import { describe, expect, it } from "vitest";
import { createInitialState, type SimEvent, type SimState } from "../../../src/sim/index.ts";
import { Action } from "../../../src/sim/contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import { buildWorld, circleBlocked } from "../../../src/sim/world.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, routineSwarmAllowsAttack, stepRoutineRuntime, type RoutineRuntimeOptions } from "../../../src/sim/agents/routine-runtime.ts";
import { createFinaleState, type FinaleRoute } from "../../../src/sim/robots/finale.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { gridCity } from "../fixtures.ts";

const world = gridCity();
function start(wave: 2 | 3 | 4 | 7 | 8 = 3): SimState {
  const state = enableAgentRuntime(createInitialState(world, 13, ["p"], { x: 50, z: 0, heading: 0 }), { wave });
  return { ...state, ext: { ...state.ext, agents: { nextId: 1000, list: [] } } };
}
function context(previous: SimState, events: SimEvent[] = [], actions = 0): SimSystemContext {
  return { world, previous, state: { ...previous, tick: previous.tick + 1 }, inputs: { p: { throttle: 0, steer: 0, brake: 0, actions } }, events };
}
const options: RoutineRuntimeOptions = { bodies: [], actors: [], nextActorId: 1000, spawnBudget: 32 };
function onFoot(state: SimState, x = 50): SimState {
  const p = state.players.p!;
  return { ...state, players: { p: { ...p, mode: "foot", foot: { x, y: 0, z: 0, heading: 0, speed: 0, sprint: false, grounded: true, vy: 0, dodge: null } } } };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

describe("registered later-wave routine runtime", () => {
  it("does not create advanced actors before wave three, or start the finale implicitly", () => {
    const result = stepRoutineRuntime(context(start(2)), createRoutineRuntime(), options);
    expect(result.bodies).toEqual([]);
    expect(result.state.finales).toEqual([]);
    const advanced = stepRoutineRuntime(context(start(8)), createRoutineRuntime(), options);
    expect(advanced.bodies.some(b => b.model === "elizabeth" || b.model === "walker")).toBe(false);
  });
  it("spawns distinct physical actors on unblocked surfaces with the intended firmware", () => {
    const result = stepRoutineRuntime(context(start()), createRoutineRuntime(), options);
    expect(result.bodies.map(b => b.model)).toEqual(["drone", "patrol", "tidy", "sign-spinner", "associate", "footman"]);
    expect(new Set(result.bodies.map(b => b.id)).size).toBe(6);
    expect(result.nextActorId).toBe(1006);
    expect(result.bodies.every(b => b.numericId >= 1000 && !circleBlocked(world, b.x, b.z, b.radius))).toBe(true);
    expect(result.bodies.find(b => b.model === "tidy")?.firmware).toBe("good");
    expect(result.bodies.find(b => b.model === "associate")?.kind).toBe("person");
    expect(result.bodies.find(b => b.model === "drone")?.y).toBe(6);
  });
  it("carries measured body positions between ticks without respawning or teleporting", () => {
    const before = start(), first = stepRoutineRuntime(context(before), createRoutineRuntime(), options);
    const current = { ...before, tick: 1 };
    const next = stepRoutineRuntime(context(current), first.state, { ...options, bodies: first.bodies, nextActorId: first.nextActorId });
    expect(next.nextActorId).toBe(first.nextActorId);
    expect(next.bodies).toHaveLength(first.bodies.length);
    for (const body of next.bodies) {
      const old = first.bodies.find(b => b.id === body.id)!;
      expect(Math.hypot(body.x - old.x, body.z - old.z)).toBeLessThanOrEqual(8 / 60 + 1e-8);
      expect(body.previousX).toBe(old.x);
      expect(body.previousZ).toBe(old.z);
    }
  });
  it("keeps the final clearance override in control of a body already diving", () => {
    const before = start(), first = stepRoutineRuntime(context(before), createRoutineRuntime(), options);
    const held = first.bodies.map(b => b.model === "drone" ? { ...b, dodge: { phase: "dive" as const, sx: b.x, sz: b.z, tx: b.x + 4, tz: b.z, t: 1, dur: 30, peak: 1, hop: 0.2, leap: false } } : b);
    const next = stepRoutineRuntime(context({ ...before, tick: 1 }), first.state, { ...options, bodies: held, nextActorId: first.nextActorId });
    const drone = next.bodies.find(b => b.model === "drone")!, original = held.find(b => b.model === "drone")!;
    expect([drone.x, drone.y, drone.z]).toEqual([original.x, original.y, original.z]);
  });
  it("rejects malformed activation events and applies their sequence at most once", () => {
    const before = onFoot(start(7));
    const bad = stepRoutineRuntime(context(before, [{ kind: "agents.robot-body.start", tick: 1, playerId: "p", payload: { sequence: 1, model: "human" } }]), createRoutineRuntime(), options);
    expect(bad.state.controlled).toEqual([]);
    const event = { kind: "agents.robot-body.start", tick: 1, playerId: "p", payload: { sequence: 2, model: "footman" } };
    const first = stepRoutineRuntime(context(before, [event]), createRoutineRuntime(), options);
    expect(first.state.controlled).toHaveLength(1);
    expect(first.actorMetadata["player:p"]?.robotBody).toBe(true);
    const replay = stepRoutineRuntime(context({ ...before, tick: 1 }, [{ ...event, tick: 2 }]), first.state, { ...options, bodies: first.bodies, nextActorId: first.nextActorId });
    expect(replay.state.controlled).toHaveLength(1);
  });
  it("requires a genuine nearby recruitment offer and reputation before joining", () => {
    const before = onFoot(start(4));
    const recruit: CombatActor = { id: "agent:40", kind: "robot", model: "footman", firmware: "good", x: 47, y: 0, z: 0, heading: 0, speed: 0, radius: 0.4, height: 1.8 };
    const request = [{ kind: "agents.recruit", tick: 1, playerId: "p", payload: { sequence: 1, actorId: "agent:40" } }];
    const opts = { ...options, actors: [recruit], reputations: { p: 60 }, recruitOffers: { "agent:40": { playerId: "p", offeredTick: 0 } } };
    const accepted = stepRoutineRuntime(context(before, request), createRoutineRuntime(), opts);
    expect(accepted.state.recruits[0]?.state.roster.map(r => r.id)).toEqual(["agent:40"]);
    expect(stepRoutineRuntime(context(before, request), createRoutineRuntime(), { ...opts, reputations: { p: 59 } }).state.recruits[0]?.state.roster).toEqual([]);
    expect(stepRoutineRuntime(context(before, request), createRoutineRuntime(), { ...opts, recruitOffers: {} }).state.recruits[0]?.state.roster).toEqual([]);
    expect(stepRoutineRuntime(context(before, request), createRoutineRuntime(), { ...opts, actors: [{ ...recruit, x: 0 }] }).state.recruits[0]?.state.roster).toEqual([]);
  });
  it("creates a bounded physical parrot flock only from wave four", () => {
    const result = stepRoutineRuntime(context(start(4)), createRoutineRuntime(), options);
    const flock = result.bodies.filter(b => b.model === "parrot");
    expect(flock.length).toBeGreaterThan(0);
    expect(flock.length).toBeLessThanOrEqual(12);
    expect(flock.every(b => b.kind === "animal" && b.firmware === "none")).toBe(true);
  });
  it("never acknowledges missing physical dependencies as a completed task", () => {
    const result = stepRoutineRuntime(context(onFoot(start())), createRoutineRuntime(), options);
    expect(result.diagnostics).toContain("tidy-needs-repair-kiosk");
    expect(result.diagnostics).toContain("theft-needs-depot");
    expect(result.state.specials.find(s => s.role === "tidy")?.tidy?.phase).toBe("seek");
    expect(result.state.specials.find(s => s.role === "thief")?.theft?.phase).toBe("idle");
    expect(result.effects.some(e => e.kind === "heap.restore")).toBe(false);
  });
  it("checks real player poses when an explicit finale footprint would overlap them", () => {
    const before = onFoot(start(8));
    const route = { id: "unsafe-walker", waypoints: [{ id: "foot", x: 50, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 3 }, windupTicks: 60, shedRobots: 0 }] };
    const result = stepRoutineRuntime(context(before, [{ kind: "agents.finale.start", tick: 1, playerId: "p", payload: { sequence: 1, kind: "walker", route } }]), createRoutineRuntime(), options);
    expect(result.state.finales).toEqual([]);
    expect(result.diagnostics).toContain("unsafe-finale-spawn");
  });
  it("rejects an authored foot shape that misses a person inside the actual Walker body", () => {
    const before = onFoot(start(8), 100);
    const route = { id: "small-foot", waypoints: [{ id: "foot", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const person: CombatActor = { id: "person:inside-box", kind: "person", firmware: "none", x: 1.95, y: 0, z: 3.95, heading: 0, speed: 0, radius: 0.35, height: 1.8 };
    const result = stepRoutineRuntime(context(before, [{ kind: "agents.finale.start", tick: 1, playerId: "p", payload: { sequence: 1, kind: "walker", route } }]), createRoutineRuntime(), { ...options, actors: [person] });
    expect(result.state.finales).toEqual([]);
    expect(result.diagnostics).toContain("unsafe-finale-spawn");
  });
  it("is deterministic and immutable on frozen inputs, with plain JSON state", () => {
    const before = freeze(start()), ctx = freeze(context(before)), previous = freeze(createRoutineRuntime());
    const source = JSON.stringify({ ctx, previous });
    const one = stepRoutineRuntime(ctx, previous, options), two = stepRoutineRuntime(ctx, previous, options);
    expect(one).toEqual(two);
    expect(JSON.stringify({ ctx, previous })).toBe(source);
    expect(JSON.parse(JSON.stringify(one.state))).toEqual(one.state);
  });
  it("rejects duplicate body identities independent of input order", () => {
    const body: RuntimePhysicalBody = { id: "animal:1", numericId: 1, kind: "animal", model: "dog", x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 0.3, halfLength: 0.3, halfWidth: 0.3, height: 0.5, dodge: null };
    expect(() => stepRoutineRuntime(context(start()), createRoutineRuntime(), { ...options, bodies: [body, { ...body, x: 10 }] })).toThrow(/Duplicate/);
  });
  it("preserves the previous pose of a fleet body already advanced by its owner", () => {
    const bus: RuntimePhysicalBody = { id: "fleet:bus", numericId: 50, kind: "vehicle", model: "bus", x: 10.1, y: 0, z: 0, previousX: 10, previousZ: 0, heading: 1, previousHeading: 0.99, speed: 6, radius: 1.5, halfLength: 5, halfWidth: 1.5, height: 3, dodge: null };
    const result = stepRoutineRuntime(context(start()), createRoutineRuntime(), { ...options, bodies: [bus] });
    expect(result.bodies.find(b => b.id === bus.id)).toEqual(bus);
  });
  it("respects the shared significant population budget without deleting existing identities", () => {
    const limited = stepRoutineRuntime(context(start()), createRoutineRuntime(), { ...options, remainingSignificantCapacity: 2 });
    expect(limited.bodies).toHaveLength(2);
    const next = stepRoutineRuntime(context({ ...start(), tick: 1 }), limited.state, { ...options, bodies: limited.bodies, nextActorId: limited.nextActorId, remainingSignificantCapacity: 0 });
    expect(next.bodies.map(b => b.id)).toEqual(limited.bodies.map(b => b.id));
  });
  it("bounds warm-up work and retains deferred threat units until they physically spawn", () => {
    const before = start(), request = { id: "deferred-swarm", kind: "swarm" as const, playerId: "p", player: { x: 50, z: 0 }, requestTick: 1, threat: 4 as const, unitCount: 8 };
    let current = stepRoutineRuntime(context(before), createRoutineRuntime(), { ...options, spawnBudget: undefined, threatRequests: [request] });
    expect(current.bodies).toHaveLength(4);
    expect(current.state.initializedOwners).toEqual([]);
    expect(current.state.threatSpawnQueue?.[0]?.remaining).toBe(8);
    for (let tick = 1; tick <= 3; tick++) current = stepRoutineRuntime(context({ ...before, tick }), current.state, { ...options, spawnBudget: undefined, bodies: current.bodies, nextActorId: current.nextActorId });
    expect(current.bodies).toHaveLength(14);
    expect(current.state.threatSpawnQueue).toEqual([]);
    expect(current.state.initializedOwners).toEqual(["p"]);
  });
  it("preserves restoration and stops former hostile routines", () => {
    const first = stepRoutineRuntime(context(start()), createRoutineRuntime(), options);
    const bodies = first.bodies.map(b => b.model === "drone" ? { ...b, firmware: "good" as const, x: 50, y: 6, z: 1 } : b);
    const next = stepRoutineRuntime(context({ ...start(), tick: 1 }), first.state, { ...options, bodies, nextActorId: first.nextActorId });
    expect(next.attackRequests).toEqual([]);
    expect(next.bodies.find(b => b.model === "drone")).toMatchObject({ firmware: "good", x: 50, z: 1, speed: 0 });
    expect(next.actorMetadata[bodies.find(b => b.model === "drone")!.id]?.firmware).toBe("good");
  });
  it("suspends a bound special and preserves its real carried pose without a second body", () => {
    const first = stepRoutineRuntime(context(start()), createRoutineRuntime(), options);
    const drone = first.bodies.find(b => b.model === "drone")!;
    const carried = { ...drone, x: 70, z: 0, speed: 4 };
    const result = stepRoutineRuntime(context({ ...start(), tick: 1 }), first.state, { ...options, bodies: first.bodies.filter(b => b.id !== drone.id), boundActorIds: [drone.id], carriedBodies: [carried], nextActorId: first.nextActorId });
    expect(result.bodies.some(b => b.id === drone.id)).toBe(false);
    expect(result.state.specials.find(s => s.body.id === drone.id)?.body.x).toBe(70);
    expect(result.attackRequests.some(a => a.attackerId === drone.id)).toBe(false);
    expect(result.actorMetadata[drone.id]).toBeUndefined();
  });
  it("does not fabricate a theft claim or Tidy attachment from a requested intent", () => {
    const before = onFoot(start(), 100), first = stepRoutineRuntime(context(before), createRoutineRuntime(), options);
    const thief = first.state.specials.find(s => s.role === "thief")!;
    thief.theft = { lastTick: 1, phase: "claim", carId: "car:p", ownerId: "p", startedTick: 0, sequence: 1 };
    thief.stolenOwnerId = "p"; Object.assign(thief.body, { x: 50, z: 0 });
    const tidy = first.state.specials.find(s => s.role === "tidy")!; tidy.carryingHeapId = "agent:99";
    const next = stepRoutineRuntime(context({ ...before, tick: 1 }), first.state, { ...options, bodies: first.state.specials.map(s => s.body), nextActorId: first.nextActorId });
    expect(next.state.specials.find(s => s.role === "thief")?.theft?.phase).toBe("claim");
    expect(next.playerOverrides).toEqual({});
    expect(next.state.specials.find(s => s.role === "tidy")?.carryingHeapId).toBeNull();
  });
  it("blocks a finale approach swept footprint when a person crosses it", () => {
    const before = { ...onFoot(start(8), 100), tick: 1 };
    const route: FinaleRoute = { id: "crossing", waypoints: [{ id: "step", x: 10, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const walker: RuntimePhysicalBody = { id: "agent:2000", numericId: 2000, kind: "robot", model: "walker", firmware: "bad", operational: true, x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 3, halfLength: 4, halfWidth: 2, height: 3, dodge: null };
    const prior = createRoutineRuntime(1); prior.initializedOwners = ["p"];
    prior.finales.push({ body: walker, route, state: createFinaleState({ kind: "walker", route, position: walker, tick: 1 }), landingId: null, applied: [] });
    const crossing: CombatActor = { id: "person:1", kind: "person", firmware: "none", x: 4.37, y: 0, z: 0, heading: 0, speed: 0, radius: 0.35, height: 1.8 };
    const result = stepRoutineRuntime(context(before), prior, { ...options, bodies: [walker], actors: [crossing], nextActorId: 2001 });
    expect(result.bodies.find(b => b.id === walker.id)?.x).toBe(0);
    expect(result.diagnostics).toContain(`finale-route-blocked:${walker.id}`);
    expect(result.effects.some(e => e.kind === "finale.impact")).toBe(false);
  });
  it("derives weak-point progress from the named physical combat targets", () => {
    const before = { ...onFoot(start(8), 100), tick: 1 };
    const route: FinaleRoute = { id: "weak-points", waypoints: [{ id: "step", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const walker: RuntimePhysicalBody = { id: "agent:2000", numericId: 2000, kind: "robot", model: "walker", firmware: "bad", operational: true, x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 3, halfLength: 4, halfWidth: 2, height: 3, dodge: null };
    const prior = createRoutineRuntime(1); prior.initializedOwners = ["p"];
    prior.finales.push({ body: walker, route, state: createFinaleState({ kind: "walker", route, position: walker, tick: 1 }), landingId: null, applied: [] });
    before.ext.combat = { targets: { "agent:2000/weak/front-left": { ...initialTarget(), rust: 0.5, sourceId: "p", lastWaterTick: 1 }, "agent:2000": { ...initialTarget(), rust: 1 } } } as unknown as NonNullable<SimState["ext"]["combat"]>;
    const result = stepRoutineRuntime(context(before), prior, { ...options, bodies: [walker], nextActorId: 2001 });
    expect(result.state.finales[0]?.state.weakPoints.map(p => p.rust)).toEqual([0.5, 0, 0, 0]);
    expect(result.finaleWeakPoints).toHaveLength(4);
    expect(result.finaleWeakPoints.every(p => p.id.startsWith("agent:2000/weak/"))).toBe(true);
  });
  it("admits at most eight swarm members and only two melee attackers", () => {
    const result = stepRoutineRuntime(context(start()), createRoutineRuntime(), { ...options, threatLevels: { p: 4 }, threatRequests: [{ id: "swarm:1", kind: "swarm", playerId: "p", player: { x: 50, z: 0 }, requestTick: 1, threat: 4, unitCount: 8 }] });
    expect(result.swarmAssignments.length).toBeGreaterThan(2);
    expect(result.swarmAssignments.length).toBeLessThanOrEqual(8);
    expect(result.swarmAssignments.filter(a => a.role === "melee")).toHaveLength(2);
    const ranged = result.swarmAssignments.find(a => a.role === "ranged")!;
    expect(routineSwarmAllowsAttack(result, { attackerId: ranged.actorId, targetId: "p", kind: "shove" })).toBe(false);
    expect(routineSwarmAllowsAttack(result, { attackerId: ranged.actorId, targetId: "p", kind: "ad-blast" })).toBe(true);
    const ended = stepRoutineRuntime(context({ ...start(), tick: 1 }), result.state, { ...options, bodies: result.bodies, nextActorId: result.nextActorId, threatLevels: { p: 0 } });
    expect(ended.swarmAssignments).toEqual([]);
  });
  it("moves an NPC out of a pending footfall using a bounded physical evacuation step", () => {
    const before = { ...onFoot(start(8), 100), tick: 1 };
    const route: FinaleRoute = { id: "evacuate", waypoints: [{ id: "step", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const walker: RuntimePhysicalBody = { id: "agent:2000", numericId: 2000, kind: "robot", model: "walker", firmware: "bad", operational: true, x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 3, halfLength: 4, halfWidth: 2, height: 3, dodge: null };
    const npc: RuntimePhysicalBody = { ...walker, id: "agent:2001", numericId: 2001, kind: "person", model: "person", firmware: "none", x: 2.5, previousX: 2.5, radius: 0.35, halfLength: 0.35, halfWidth: 0.35, height: 1.8 };
    const prior = createRoutineRuntime(1); prior.initializedOwners = ["p"];
    prior.finales.push({ body: walker, route, state: createFinaleState({ kind: "walker", route, position: walker, tick: 1 }), landingId: null, applied: [] });
    const result = stepRoutineRuntime(context(before), prior, { ...options, bodies: [walker, npc], nextActorId: 2002 });
    const moved = result.bodies.find(b => b.id === npc.id)!;
    expect(moved.x).toBeGreaterThan(npc.x);
    expect(moved.x - npc.x).toBeLessThanOrEqual(1.8 / 60 + 1e-8);
    expect(result.effects.some(e => e.kind === "finale.impact")).toBe(false);
  });
  it("activates threat-five Walker only on a proven ground-backed patrol", () => {
    const city = buildWorld([{ tileId: "flat", buildings: [], ground: { x0: -200, z0: -200, cellSizeM: 5, nx: 81, nz: 81, heights: Array(81 * 81).fill(0) as number[] } }], {
      version: 1, nodes: [{ id: "a", x: 100, z: -90 }, { id: "b", x: 100, z: 90 }],
      edges: [{ id: "patrol", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[100, -90], [100, 90]] }],
    });
    const before = enableAgentRuntime(createInitialState(city, 13, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 8 });
    const previous = createRoutineRuntime(); previous.initializedOwners = ["p"];
    const result = stepRoutineRuntime({ world: city, previous: before, state: { ...before, tick: 1 }, inputs: {}, events: [] }, previous, { ...options, threatLevels: { p: 5 } });
    expect(result.state.finales).toHaveLength(1);
    expect(result.state.finales[0]?.state.kind).toBe("walker");
    expect(result.state.finales[0]?.route.waypoints.length).toBeGreaterThan(4);
    const unknownGround = stepRoutineRuntime(context(start(8)), previous, { ...options, threatLevels: { p: 5 } });
    expect(unknownGround.state.finales).toEqual([]);
    expect(unknownGround.diagnostics).toContain("walker-route-no-safe-segment");
  });
});
