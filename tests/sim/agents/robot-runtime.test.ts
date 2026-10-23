import { describe, expect, it, vi } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { createCombatState, stepCombat } from "../../../src/sim/combat/system.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import type { CombatActor, CombatContext, CombatPlayer, CombatState } from "../../../src/sim/combat/types.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import * as brainPolicy from "../../../src/sim/robots/brain.ts";
import type { RobotObservations } from "../../../src/sim/robots/brain.ts";
import {
  createRobotRuntime, robotActorId, robotAgentId, stepRobotRuntime, MAX_RUNTIME_ROBOTS,
  type RobotRuntimeOptions, type RobotRuntimeState,
} from "../../../src/sim/robots/runtime.ts";

function actor(id = 1, changes: Partial<CombatActor> = {}): CombatActor {
  return { id: robotActorId(id), kind: "robot", firmware: "bad", model: "footman", x: 0, y: 0, z: 0,
    heading: 0, speed: 0, height: 1.8, radius: 0.4, inFidelity: true, ...changes };
}
function player(state: SimState): CombatPlayer {
  const body = state.players.p!.foot!;
  return { id: "p", ...body, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 };
}
function combatContext(state: SimState, actors: readonly CombatActor[], cap = 2): CombatContext {
  return { actors, players: [player(state)], walls: [], refills: [], conversionCap: cap, wave: 2 };
}
function initial(world = buildWorld([]), actors: readonly CombatActor[] = [actor()]): SimState {
  const state = createInitialState(world, 17, ["p"], { x: 0, z: -25, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = { x: 0, y: 0, z: -25, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null };
  state.ext.combat = createCombatState(17, combatContext(state, actors));
  return state;
}
function system(previous: SimState, world = buildWorld([]), actions = 0): SimSystemContext {
  return { world, previous, state: { ...previous, tick: previous.tick + 1, ext: { ...previous.ext } },
    inputs: { p: { ...NEUTRAL_INPUT, actions } }, events: [] };
}
function options(actors: readonly CombatActor[], extra: Partial<RobotRuntimeOptions> = {}): RobotRuntimeOptions {
  return { actors, conversion: { baseBadCount: 1, protectedArea: false }, ...extra };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function advance(runtime: RobotRuntimeState, state: SimState, actors: readonly CombatActor[], actions = 0, world = buildWorld([]), extra: Partial<RobotRuntimeOptions> = {}) {
  const context = system(state, world, actions);
  const result = stepRobotRuntime(runtime, context, options(actors, extra));
  const combat = stepCombat(state.ext.combat!, { ...combatContext(context.state, result.actors, result.conversionCap), wave: extra.wave ?? 2, attacks: result.attacks });
  return { result, state: { ...context.state, ext: { ...context.state.ext, combat } }, combat };
}

describe("robot runtime adapter", () => {
  it("keeps numeric identities canonical and ignores foreign robot identifiers", () => {
    expect(robotAgentId("agent:42")).toBe(42);
    expect(robotActorId(42)).toBe("agent:42");
    for (const id of ["42", "other:42", "agent:01", "agent:-1", "agent:1x", "agent:9007199254740992"]) expect(robotAgentId(id)).toBeNull();
    const actors = [actor(1, { id: "foreign" }), actor(2, { id: "agent:01" })];
    const result = stepRobotRuntime(createRobotRuntime(), system(initial(undefined, actors)), options(actors));
    expect(result.state.robots).toEqual([]);
    expect(result.attacks).toEqual([]);
  });

  it("is pure with frozen inputs, preserves bodies and is invariant to actor order", () => {
    const actors = [actor(10), actor(2, { firmware: "good", z: -2 })];
    const state = initial(undefined, actors), context = system(state), runtime = createRobotRuntime();
    const before = JSON.stringify({ runtime, actors, state });
    freeze(runtime); freeze(actors); freeze(state);
    const result = stepRobotRuntime(runtime, context, options(actors));
    expect(stepRobotRuntime(runtime, context, options([...actors].reverse()))).toEqual(result);
    expect(JSON.stringify({ runtime, actors, state })).toBe(before);
    for (const current of result.actors) expect(current).toMatchObject(actors.find(original => original.id === current.id)!);
    expect(result.state.robots.map(robot => robot.agentId)).toEqual([2, 10]);
    expect(result.state.robots.every(robot => !robot.brain?.update && !robot.brain?.windup)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("requests forced update immediately and leaves the single six-second timer to combat", () => {
    let actors = [actor(), actor(2, { firmware: "good", z: -2 })];
    let state = initial(undefined, actors), runtime = createRobotRuntime();
    let requests = 0, convertedAt = 0;
    for (let tick = 1; tick <= 362; tick++) {
      const frame = advance(runtime, state, actors);
      requests += frame.result.attacks.length;
      if (tick === 1) {
        expect(frame.result.attacks).toMatchObject([{ attackerId: "agent:1", targetId: "agent:2", kind: "forced-update", sequence: 1 }]);
        expect(frame.combat.attacks[0]).toMatchObject({ startTick: 1, resolveTick: 361 });
      }
      if (tick <= 360) expect(frame.combat.events.some(event => event.kind === "robot.converted")).toBe(false);
      if (frame.combat.events.some(event => event.kind === "robot.converted")) convertedAt = tick;
      if (tick === 362) {
        expect(frame.result.results.filter(event => event.kind === "converted")).toHaveLength(1);
        expect(frame.result.actors.find(current => current.id === "agent:2")?.firmware).toBe("bad");
        expect(frame.result.state.robots.find(current => current.agentId === 2)).toMatchObject({ convertedTick: 361, bountyUntilTick: 3961 });
      }
      runtime = frame.result.state; state = frame.state; actors = [...frame.result.actors];
    }
    expect(requests).toBe(1);
    expect(convertedAt).toBe(361);
  });

  it("hands off an ordinary attack at wind-up start without adding a second delay", () => {
    const actors = [actor()];
    let state = initial(undefined, actors); state.players.p!.foot!.z = -1;
    let runtime = createRobotRuntime(), requestedAt = 0, resolvedAt = 0;
    for (let tick = 1; tick <= 38; tick++) {
      const frame = advance(runtime, state, actors, Action.fire);
      if (frame.result.attacks.length) requestedAt = tick;
      if (frame.combat.events.some(event => event.kind === "attack.resolved")) resolvedAt = tick;
      runtime = frame.result.state; state = frame.state;
    }
    expect(requestedAt).toBe(2);
    expect(resolvedAt).toBe(38);
  });

  it("lets combat retain active handshakes and phone hacks after their wind-up resolves", () => {
    for (const kind of ["handshake", "phone-hack"] as const) {
      const actors = [actor(1, { model: kind === "handshake" ? "footman" : "trundle" })];
      let state = initial(undefined, actors); state.players.p!.foot!.z = kind === "handshake" ? -1 : -3;
      let runtime = createRobotRuntime();
      const configuration: Partial<RobotRuntimeOptions> = { wave: 3, goalWeights: {
        shove: 0, adBlast: 0, handshake: kind === "handshake" ? 10 : 0, phoneHack: kind === "phone-hack" ? 10 : 0,
      } };
      for (let tick = 1; tick <= 65; tick++) {
        const frame = advance(runtime, state, actors, Action.fire, undefined, configuration);
        if (tick >= 32) expect(frame.combat.attacks).toMatchObject([{ kind, active: true }]);
        expect(frame.result.cancellations).toEqual([]);
        runtime = frame.result.state; state = frame.state;
      }
      state.players.p!.foot!.z = -10;
      const escaped = advance(runtime, state, actors, Action.fire, undefined, configuration);
      expect(escaped.result.cancellations).toMatchObject([{ kind, reason: "policy" }]);
      expect(escaped.combat.attacks).toEqual([]);
    }
  });

  it("consumes previous combat results once and retains converted identity outside the active actor set", () => {
    const actors = [actor(2, { firmware: "good" })], state = initial(undefined, actors);
    state.ext.combat!.events = [{ id: 7, tick: 0, kind: "robot.converted", sourceId: "agent:1", targetId: "agent:2", amount: 1, detail: "forced-update" }];
    const first = stepRobotRuntime(createRobotRuntime(), system(state), options(actors));
    expect(first.results).toHaveLength(1);
    const retained: SimState = { ...state, tick: 1, ext: { ...state.ext, combat: { ...state.ext.combat!, tick: 1 } } };
    const absent = stepRobotRuntime(first.state, system(retained), options([]));
    expect(absent.results).toEqual([]);
    expect(absent.state.robots).toHaveLength(1);
    const returning: SimState = { ...retained, tick: 2, ext: { ...retained.ext, combat: { ...retained.ext.combat!, tick: 2 } } };
    const restored = stepRobotRuntime(absent.state, system(returning), options(actors));
    expect(restored.results).toEqual([]);
    expect(restored.actors[0]?.firmware).toBe("bad");
    const explicit = stepRobotRuntime(absent.state, system(returning), options(actors, { restoredIds: [2] }));
    expect(explicit.actors[0]?.firmware).toBe("good");
    expect(explicit.state.robots[0]?.convertedTick).toBeNull();
    const retired = stepRobotRuntime(absent.state, system(returning), options([], { retiredIds: [2] }));
    expect(retired.state.robots).toEqual([]);
  });

  it("builds sight from actual world occlusion and hearing from the recorded source pose", () => {
    const world = buildWorld([{ tileId: "wall", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10,
      footprint: [[-2, -8], [2, -8], [2, -7], [-2, -7]] }] }]);
    const actors = [actor()], state = initial(world, actors);
    state.players.p!.foot!.z = -10;
    const blocked = stepRobotRuntime(createRobotRuntime(), system(state, world, Action.fire), options(actors));
    expect(blocked.state.robots[0]?.brain?.knowledge).toEqual([]);
    expect(blocked.attacks).toEqual([]);
    state.ext.combat!.events = [{ id: 1, tick: 0, kind: "weapon.water", sourceId: "p", targetId: "", amount: 0.1, detail: "" }];
    const context = system(state, world);
    context.state.players = { p: { ...state.players.p!, foot: { ...state.players.p!.foot!, x: 50, z: 50 } } };
    const heard = stepRobotRuntime(createRobotRuntime(), context, options(actors));
    expect(heard.state.robots[0]?.brain?.knowledge).toMatchObject([{ playerId: "p", x: 0, z: -10, channel: "hearing" }]);
  });

  it("matches exhaustive perception while excluding distant allocations in a 24-player scene", () => {
    const focus = actor(1, { x: -30, z: -30 });
    const actors = [focus, actor(2, { firmware: "good", x: -30, z: -32 }),
      actor(3, { firmware: "good", x: -30, z: -60 }), // Inclusive 30 m boundary in a neighbouring cell.
      actor(4, { firmware: "good", x: -30, z: -60.0001 }),
      actor(5, { firmware: "good", x: -30, z: 0 }),
      ...Array.from({ length: 800 }, (_, index) => actor(100 + index, { firmware: "good", x: 1000 + index * 5, z: 1000 }))];
    const state = initial(undefined, actors);
    state.players.p!.foot = { ...state.players.p!.foot!, x: -30, z: -55 };
    for (let i = 1; i < 24; i++) {
      state.players[`p${i}`] = { ...state.players.p!, foot: { ...state.players.p!.foot!, x: 500 + i * 50, z: 500 } };
    }
    const exhaustive: RobotObservations["sight"][number][] = [];
    const visible = (x: number, z: number): boolean => (x - focus.x) * (x - focus.x) + (z - focus.z) * (z - focus.z) <= 900;
    for (const id of Object.keys(state.players).sort()) {
      const body = state.players[id]!.foot!;
      exhaustive.push({ kind: "player", id, x: body.x, z: body.z, heading: body.heading, inVehicle: false, threatening: false, lineOfSight: visible(body.x, body.z) });
    }
    for (const target of [...actors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      exhaustive.push({ kind: "robot", id: robotAgentId(target.id)!, x: target.x, z: target.z, alignment: target.firmware as "good" | "bad",
        operational: target.x < 1000, lineOfSight: visible(target.x, target.z) });
    }
    const policy = brainPolicy.stepRobotBrain;
    const spy = vi.spyOn(brainPolicy, "stepRobotBrain");
    try {
      for (const fogDensity of [0, 0.7]) {
        const expected = policy(brainPolicy.createRobotBrain({ id: 1, tick: 1 }), {
          tick: 1, self: { x: focus.x, z: focus.z, heading: 0, rust: 0, fogDensity, shoved: false },
          observations: { sight: exhaustive, sounds: [], broadcasts: [], scans: [], watches: [] },
          conversion: { baseBadCount: 1, protectedArea: false, withinFidelity: true, badCount: 1, reservedCount: 0 },
          goalWeights: { phoneHack: 0 }, meleeSlotsAvailable: 2,
        });
        spy.mockClear();
        const result = stepRobotRuntime(createRobotRuntime(), system(state), options(actors, { fogDensity }));
        expect(result.state.robots.find(entry => entry.agentId === 1)?.brain).toEqual({ ...expected.state, windup: null, update: null, pendingUpdates: [] });
        expect(result.locomotion.find(entry => entry.agentId === 1)?.intent).toEqual(expected.intent.movement);
        const observed = spy.mock.calls.find(call => call[0].id === 1)![1].observations.sight;
        expect(observed).toHaveLength(5);
        expect(observed.some(sight => sight.kind === "robot" && sight.id === 3)).toBe(true);
        expect(observed.some(sight => sight.kind === "robot" && sight.id === 4)).toBe(false);
        expect(stepRobotRuntime(createRobotRuntime(), system(state), options([...actors].reverse(), { fogDensity }))).toEqual(result);
      }
    } finally { spy.mockRestore(); }
  });

  it("emits explicit cancellation on a scan without falsifying firmware or fidelity", () => {
    const actors = [actor(), actor(2, { firmware: "good", z: -2 })];
    const first = advance(createRobotRuntime(), initial(undefined, actors), actors);
    first.state.ext.combat!.events.push({ id: first.combat.nextId, tick: 1, kind: "robot.wary", sourceId: "p", targetId: "agent:1", amount: 600, detail: "" });
    const next = stepRobotRuntime(first.result.state, system(first.state), options(actors));
    expect(next.cancellations).toMatchObject([{ attackId: first.combat.attacks[0]!.id, kind: "forced-update", reason: "policy" }]);
    expect(next.attacks).toEqual([]);
    expect(next.actors.find(current => current.id === "agent:1")).toMatchObject({ firmware: "bad", inFidelity: true });
  });

  it("never turns a person or protected robot into an attack or conversion target", () => {
    const actors = [actor(), actor(2, { kind: "person", firmware: "none", z: -1 }), actor(3, { firmware: "good", protected: true, z: -2 })];
    const result = stepRobotRuntime(createRobotRuntime(), system(initial(undefined, actors)), options(actors));
    expect(result.attacks).toEqual([]);
    expect(result.state.robots.map(robot => robot.agentId)).toEqual([1, 3]);
  });

  it("reselects a supported robot attack when conversion is capped, instead of requesting a robot-targeted ad blast", () => {
    const actors = [actor(), actor(2, { firmware: "good", z: -2 })];
    const result = stepRobotRuntime(createRobotRuntime(), system(initial(undefined, actors)), options(actors, {
      conversion: { baseBadCount: 0, protectedArea: false },
    }));
    expect(result.attacks).toEqual([]);
    expect(result.locomotion.find(value => value.agentId === 1)?.intent).toMatchObject({ kind: "pursue", stopDistance: 1.5 });
  });

  it("selects one watched robot using current aim and real sight", () => {
    const actors = [actor(1, { z: -2, heading: Math.PI }), actor(2, { z: -4, heading: Math.PI })];
    let state = initial(undefined, actors); state.players.p!.foot!.z = 0;
    let runtime = createRobotRuntime();
    for (let tick = 1; tick <= 182; tick++) {
      const frame = advance(runtime, state, actors, Action.watch);
      runtime = frame.result.state; state = frame.state;
    }
    expect(runtime.robots.find(robot => robot.agentId === 1)?.brain?.mode).toBe("wary");
    expect(runtime.robots.find(robot => robot.agentId === 2)?.brain?.mode).toBe("disguised");
  });

  it("offers a recruit only for an actual recorded water interrupter with sufficient reputation", () => {
    const actors = [actor(), actor(2, { firmware: "good", z: -2 })];
    const state = initial(undefined, actors);
    state.ext.combat!.targets["agent:1"] = { ...initialTarget(), rust: 0.2, lastWaterTick: 0, sourceId: "p" };
    state.ext.combat!.events = [{ id: 1, tick: 0, kind: "update.interrupted", sourceId: "agent:1", targetId: "agent:2", amount: 0, detail: "interrupted" }];
    const recruited = stepRobotRuntime(createRobotRuntime(), system(state), options(actors, { reputations: { p: 60 } }));
    expect(recruited.results[0]).toMatchObject({ kind: "interrupted", rescuerId: "p" });
    expect(recruited.state.robots.find(robot => robot.agentId === 2)?.recruitOffer).toEqual({ playerId: "p", offeredTick: 0 });
    const lowRep = stepRobotRuntime(createRobotRuntime(), system(state), options(actors, { reputations: { p: 59 } }));
    expect(lowRep.state.robots.find(robot => robot.agentId === 2)?.recruitOffer).toBeNull();
    state.ext.combat!.targets["agent:1"]!.sourceId = "unknown";
    const unknown = stepRobotRuntime(createRobotRuntime(), system(state), options(actors, { reputations: { p: 100 } }));
    expect(unknown.results[0]?.rescuerId).toBeNull();
  });

  it("sends seizure broadcasts with stored knowledge, never with the player's hidden current position", () => {
    const actors = [actor(), actor(2, { x: 5, heading: Math.PI / 2 })], state = initial(undefined, actors);
    state.players.p!.foot!.z = -5;
    const first = stepRobotRuntime(createRobotRuntime(), system(state), options(actors));
    const nextState: SimState = { ...state, tick: 1, players: { p: { ...state.players.p!, foot: { ...state.players.p!.foot!, x: 100, z: 100 } } },
      ext: { ...state.ext, combat: { ...state.ext.combat!, tick: 1, events: [{ id: 1, tick: 1, kind: "robot.seized", sourceId: "p", targetId: "agent:1", amount: 1, detail: "footman" }],
        targets: { ...state.ext.combat!.targets, "agent:1": { ...initialTarget(), phase: "seized" } } } } };
    const second = stepRobotRuntime(first.state, system(nextState), options(actors));
    expect(second.state.robots.find(robot => robot.agentId === 2)?.brain?.knowledge).toMatchObject([{ playerId: "p", x: 0, z: -5, channel: "broadcast" }]);
  });

  it("honors combat movement restrictions and does not advance inactive brains", () => {
    const actors = [actor()], state = initial(undefined, actors);
    state.ext.combat!.targets["agent:1"] = { ...initialTarget(), phase: "heap", movementScale: 0 };
    const result = stepRobotRuntime(createRobotRuntime(), system(state), options(actors));
    expect(result.locomotion[0]).toMatchObject({ intent: { kind: "hold" }, combat: { maxSpeed: 0, canAttack: false } });
    expect(result.state.robots[0]?.brain?.lastTick).toBe(0);
    const far = [actor(1, { x: 1000 })];
    expect(stepRobotRuntime(createRobotRuntime(), system(initial(undefined, far)), options(far)).attacks).toEqual([]);
  });

  it("fails closed on duplicate identities, capacity overflow and unsynchronized snapshots", () => {
    const state = initial(), context = system(state);
    expect(() => stepRobotRuntime(createRobotRuntime(), context, options([actor(), actor()]))).toThrow();
    expect(() => stepRobotRuntime(createRobotRuntime(), context, options(Array.from({ length: MAX_RUNTIME_ROBOTS + 1 }, (_, index) => actor(index))))).toThrow(/capacity/);
    expect(() => stepRobotRuntime(createRobotRuntime(1), context, options([actor()]))).toThrow(/consecutive/);
    const stale: SimState = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, tick: 3 } } };
    expect(() => stepRobotRuntime(createRobotRuntime(), system(stale), options([actor()]))).toThrow(/stale/);
  });
});
