import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import type { AgentState } from "../../../src/sim/agents.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import type { CombatActor, CombatContext, CombatState } from "../../../src/sim/combat-contract.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { pruneDefaultCombatTargets, runtimeCombatContext, runtimeCombatSystem } from "../../../src/sim/agents/runtime-combat.ts";
import { robotRuntimeSystem, robotsRuntimeOf, storeRobotActor } from "../../../src/sim/robots/runtime-system.ts";
import { finalizeRoutineEffects } from "../../../src/sim/agents/routine-effects.ts";
import { createRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";

const world = buildWorld([]);
function actor(id: number, x: number, z: number): AgentState {
  return { id, kind: "errandRobot", x, y: 0, z, heading: 0, pitch: 0, speed: 0, vmax: 0,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1, dodge: null };
}
function scene(): SimState {
  const state = enableAgentRuntime(createInitialState(world, 17, ["p"], { x: 50, z: 50, heading: 0 }), { wave: 3 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(0, 0, 5, 0);
  state.ext.agents = { nextId: 4, list: [actor(1, 0, 0), actor(2, 10, 0), actor(3, 15, 0)] };
  const ctx = contextFromState(world, state);
  const actors = ctx.actors.map(value => value.id === "agent:1" ? { ...value, firmware: "bad" as const } : value);
  state.ext.robots = { ...state.ext.robots!, actors, attacks: [], cancellations: [], conversionCap: 2 } as never;
  state.ext.combat = createCombatState(state.seed, { ...ctx, actors }, state.tick);
  return state;
}
function context(state: SimState): CombatContext {
  return runtimeCombatContext({ world, state, previous: state, inputs: {}, events: [] });
}
function expandTargets(state: SimState): SimState {
  const ctx = context(state), combat = state.ext.combat!;
  const targets = { ...combat.targets };
  for (const id of [...ctx.players.map(value => value.id), ...ctx.actors.map(value => value.id)]) targets[id] ??= initialTarget();
  return { ...state, ext: { ...state.ext, combat: { ...combat, targets } } };
}
function compact(state: SimState): SimState {
  const actors = state.ext.robots!.actors as unknown as CombatActor[];
  const physical = new Map(contextFromState(world, state).actors.map(value => [value.id, value]));
  return { ...state, ext: { ...state.ext, robots: { ...state.ext.robots!, actors: actors.map(value => storeRobotActor(value, physical.get(value.id))) } as never,
    combat: pruneDefaultCombatTargets(state.ext.combat!) } };
}
function materialContext(ctx: CombatContext): Omit<CombatContext, "groundHeight"> {
  const { groundHeight: _height, ...rest } = ctx;
  return rest;
}

describe("runtime snapshot storage", () => {
  it("omits only duplicate pose fields and reconstructs the same combat context", () => {
    const full = scene(), small = compact(full), saved = JSON.stringify(full);
    expect(materialContext(context(small))).toEqual(materialContext(context(full)));
    expect(small.ext.robots!.actors as unknown[]).not.toHaveLength(0);
    for (const entry of small.ext.robots!.actors as unknown as Record<string, unknown>[]) {
      for (const key of ["x", "y", "z", "heading", "speed"]) expect(Object.hasOwn(entry, key)).toBe(false);
      expect(Object.hasOwn(entry, "radius")).toBe(false);
      expect(Object.hasOwn(entry, "height")).toBe(false);
    }
    const custom = { ...context(full).actors[0]!, custom: { retained: true } };
    expect(storeRobotActor(custom)).toMatchObject({ custom: { retained: true } });
    const derived = storeRobotActor(custom, custom);
    expect(derived).toMatchObject({ custom: { retained: true } });
    expect(Object.hasOwn(derived, "radius")).toBe(false);
    expect(Object.hasOwn(derived, "height")).toBe(false);
    const falsePursuit = { ...custom, pursuing: false };
    expect(Object.hasOwn(storeRobotActor(falsePursuit, custom), "pursuing")).toBe(false);
    expect(storeRobotActor(falsePursuit, { ...custom, pursuing: true }).pursuing).toBe(false);
    expect(storeRobotActor({ ...custom, pursuing: true }, custom).pursuing).toBe(true);
    expect(storeRobotActor(custom, { radius: custom.radius + 1, height: custom.height + 1 }))
      .toMatchObject({ radius: custom.radius, height: custom.height });
    expect(JSON.stringify(full)).toBe(saved);
    const robot = robotRuntimeSystem.step({ world, previous: full, state: { ...full, tick: 1 }, inputs: {}, events: [] });
    expect(robotsRuntimeOf(robot)!.actors.every(value => !Object.hasOwn(value, "x"))).toBe(true);
    expect(robotsRuntimeOf(robot)!.metadata.every(value => value.phase === "active" && value.rust === 0)).toBe(true);
  });

  it("prunes exact initial targets while retaining every changed or custom field", () => {
    const combat = scene().ext.combat!;
    combat.targets.rusted = { ...initialTarget(), rust: 0.001 };
    combat.targets.expired = { ...initialTarget(), blindUntil: 1 };
    combat.targets.wet = { ...initialTarget(), wetHits: [0] };
    combat.targets.custom = { ...initialTarget(), custom: true } as typeof combat.targets[string];
    const before = JSON.stringify(combat), pruned = pruneDefaultCombatTargets(combat);
    expect(Object.keys(pruned.targets).sort()).toEqual(["custom", "expired", "rusted", "wet"]);
    for (const id of Object.keys(pruned.targets)) expect(pruned.targets[id]).toBe(combat.targets[id]);
    expect(JSON.stringify(combat)).toBe(before);
    expect(pruneDefaultCombatTargets(pruned)).toBe(pruned);
  });

  it("replays water, scan and an active attack identically from dense and compact snapshots", () => {
    let dense = scene();
    dense.ext.combat!.attacks = [{ id: "ad", kind: "ad-blast", attackerId: "agent:2", targetId: "p", startTick: 0,
      resolveTick: 0, endTick: 600, presses: 0, active: true }];
    let small = JSON.parse(JSON.stringify(compact(dense))) as SimState;
    const events: string[] = [];
    for (let tick = 1; tick <= 110; tick++) {
      const input = { p: { ...NEUTRAL_INPUT, actions: tick <= 35 ? Action.fire : Action.scan, aimYaw: 0, aimPitch: 0 } };
      const commands = tick === 4 ? [{ tick, kind: "gameplay.command", playerId: "p", payload: { sequence: 1, kind: "close-ad" } }] : [];
      dense = expandTargets(step(world, dense, input, commands, [runtimeCombatSystem]));
      small = step(world, small, input, commands, [runtimeCombatSystem]);
      events.push(...small.ext.combat!.events.map(value => value.kind));
      expect(materialContext(context(small))).toEqual(materialContext(context(dense)));
      expect(expandTargets(small).ext.combat).toEqual(dense.ext.combat);
      expect(small.players).toEqual(dense.players);
    }
    expect(events).toContain("weapon.water");
    expect(events).toContain("scan.result");
    expect(events).toContain("player.ad-popup");
    expect(small.ext.combat!.targets["agent:1"]!.rust).toBeGreaterThan(0);
  });

  it("preserves observed safehouse restoration from dense and compact target snapshots", () => {
    const before = scene();
    const body: RuntimePhysicalBody = { id: "agent:99", numericId: 99, kind: "robot", model: "footman", firmware: "bad",
      x: 10, y: 0, z: 10, previousX: 10, previousZ: 10, heading: 0, previousHeading: 0, speed: 0,
      radius: 0.4, halfLength: 0.4, halfWidth: 0.4, height: 1.6, dodge: null };
    const effect = { id: "restore:99", actorId: body.id, playerId: "p", kind: "recruit.restore-at-safehouse", targetId: "", position: null, amount: 1 };
    const runtime = { bodies: [body], routines: createRoutineRuntime(), significantAgentIds: [], deliveredAgentIds: [],
      routineOutput: { effects: [effect], actorMetadata: {} }, restorationArrivals: [{ actorId: body.id, effectId: effect.id, playerId: "p", sequence: 1,
        safehouseId: "home", position: { x: 10, y: 0, z: 10 } }], restoreSafehouses: [{ id: "home", x: 10, z: 10 }] };
    const dense = JSON.parse(JSON.stringify({ ...before, tick: 1, ext: { ...before.ext, agents: { ...before.ext.agents!, runtime } } })) as SimState;
    dense.ext.combat!.tick = 1;
    dense.ext.combat!.targets[body.id] = { ...initialTarget(), rust: 1, phase: "heap" };
    const small = compact(dense);
    const a = finalizeRoutineEffects(world, before, dense), b = finalizeRoutineEffects(world, before, small);
    expect(pruneDefaultCombatTargets(b.ext.combat!)).toEqual(pruneDefaultCombatTargets(a.ext.combat!));
    expect(b.ext.agents).toEqual(a.ext.agents);
    expect(b.ext.robots?.restoredAgentIds).toEqual([99]);
    const output = b.ext.agents as unknown as { runtime: { bodies: RuntimePhysicalBody[]; effectState: { acks: string[] } } };
    expect(output.runtime.bodies[0]!.firmware).toBe("good");
    expect(output.runtime.effectState.acks).toContain(effect.id);
  });
});
