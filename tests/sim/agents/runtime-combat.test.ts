import { describe, expect, it } from "vitest";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { AgentState } from "../../../src/sim/agents.ts";
import { Action, type SimState } from "../../../src/sim/contract.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { runtimeCombatSystem } from "../../../src/sim/agents/runtime-combat.ts";
import { robotRuntimeSystem } from "../../../src/sim/robots/runtime-system.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";

const world = buildWorld([]);
const neutral = { throttle: 0, steer: 0, brake: 0, actions: 0 };
function agent(id: number, x: number): AgentState {
  return { id, kind: "errandRobot", x, y: 0, z: 0, heading: Math.PI / 2, pitch: 0, speed: 0, vmax: 1.7,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id, dodge: null };
}
function initial(): SimState {
  const state = enableAgentRuntime(createInitialState(world, 1, ["p"], { x: 50, z: 50, heading: 0 }));
  state.ext.agents = { nextId: 3, list: [agent(1, 0), agent(2, 2)] };
  return state;
}

describe("registered agent combat bridge", () => {
  it("leaves legacy states untouched when runtime activation is absent", () => {
    const before = createInitialState(world, 1, ["p"], { x: 50, z: 50, heading: 0 });
    expect(step(world, before, { p: neutral }, [], [runtimeCombatSystem]).ext).toEqual({});
  });

  it("cancels an explicit pending update before combat can resolve it", () => {
    const before = initial();
    const actors = contextFromState(world, before).actors.map(a => ({ ...a, firmware: a.id === "agent:1" ? "bad" as const : a.firmware }));
    const context = { ...contextFromState(world, before), actors, conversionCap: 2 };
    before.ext.combat = createCombatState(before.seed, context, before.tick);
    before.ext.combat.attacks = [{ id: "update:1", kind: "forced-update", attackerId: "agent:1", targetId: "agent:2",
      startTick: -360, resolveTick: 1, endTick: 1, presses: 0, active: false }];
    before.ext.robots = { ...before.ext.robots, actors, attacks: [], conversionCap: 2,
      cancellations: [{ attackId: "update:1", kind: "forced-update", attackerId: "agent:1", targetId: "agent:2", reason: "policy" }] } as never;
    const result = step(world, before, { p: neutral }, [], [runtimeCombatSystem]);
    expect(result.ext.combat!.attacks).toEqual([]);
    expect(result.ext.combat!.events.some(e => e.kind === "robot.converted")).toBe(false);
    expect(result.ext.combat!.events.filter(e => e.kind === "update.interrupted")).toHaveLength(1);
    expect(before.ext.combat.attacks).toHaveLength(1);
  });

  it("passes recorded close-ad commands without repeating held input effects", () => {
    const before = initial();
    const context = contextFromState(world, before);
    before.ext.combat = createCombatState(before.seed, context, before.tick);
    before.ext.combat.attacks = [{ id: "ad:1", kind: "ad-blast", attackerId: "agent:1", targetId: "p",
      startTick: -50, resolveTick: 0, endTick: 600, presses: 0, active: true }];
    const result = step(world, before, { p: neutral }, [{ tick: 1, kind: "gameplay.command", playerId: "p",
      payload: { sequence: 1, kind: "close-ad" } }], [runtimeCombatSystem]);
    expect(result.ext.combat!.attacks).toEqual([]);
    expect(result.ext.combat!.events.some(e => e.kind === "player.ad-popup" && e.amount === -1)).toBe(true);
  });

  it("registers robot decisions and combat without mutating the previous snapshot", () => {
    const before = initial();
    const saved = JSON.stringify(before);
    const first = step(world, before, { p: { ...neutral, actions: Action.horn } }, [], [runtimeCombatSystem, robotRuntimeSystem]);
    const replay = step(world, JSON.parse(saved), { p: { ...neutral, actions: Action.horn } }, [], [robotRuntimeSystem, runtimeCombatSystem]);
    expect(first).toEqual(replay);
    expect(first.ext.combat?.tick).toBe(1);
    expect(first.ext.robots?.brain).toBeDefined();
    expect(JSON.stringify(before)).toBe(saved);
  });
});
