import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import { AGENT_SPEC, type AgentState } from "../../../src/sim/agents.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState, step as stepSim } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { completeAgentRuntimeOf, completeAgentRuntimeSystem } from "../../../src/sim/agents/runtime-registration.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { runtimeCombatSystem } from "../../../src/sim/agents/runtime-combat.ts";
import { baselineRobotFirmware, robotRuntimeSystem, robotsRuntimeOf } from "../../../src/sim/robots/runtime-system.ts";

// A roadless simulation keeps this contact fixture stationary while all registered
// population, routine, brain, combat and final clearance stages still execute.
const world = buildWorld([]);
const systems = [completeAgentRuntimeSystem, robotRuntimeSystem, runtimeCombatSystem];
const seed = 17;
function firmwareId(firmware: "good" | "bad"): number {
  let id = 1;
  while (baselineRobotFirmware(seed, id, "errandRobot") !== firmware) id++;
  return id;
}
const pusherId = firmwareId("bad"), helperId = firmwareId("good");
function robot(id: number, z: number): AgentState {
  return { id, kind: "errandRobot", x: 0, y: 0, z, heading: 0, pitch: 0, speed: 0,
    vmax: AGENT_SPEC.errandRobot.vmax, edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1,
    conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1, dodge: null };
}
function scene(playerZ: number): SimState {
  const state = enableAgentRuntime(createInitialState(world, seed, ["p"], { x: 30, z: 30, heading: 0 }), { wave: 3 });
  state.ext.robots!.catalogArchetypes = { [pusherId]: { bad: "updatePusher" } };
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(0, 0, playerZ, 0);
  state.ext.agents = { nextId: Math.max(pusherId, helperId) + 1,
    list: [robot(pusherId, 0), robot(helperId, -2)].sort((a, b) => a.id - b.id) };
  return state;
}
function tick(state: SimState, actions = 0): SimState {
  return stepSim(world, state, { p: { ...NEUTRAL_INPUT, actions } }, [], systems);
}

describe("registered robot/combat integration", () => {
  it("starts a real six-second update and preserves converted firmware through subsequent routine composition", () => {
    let state = tick(scene(35));
    const first = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update")!;
    expect(first).toMatchObject({ attackerId: `agent:${pusherId}`, targetId: `agent:${helperId}`, startTick: 1 });
    expect(first.resolveTick - first.startTick).toBe(360);
    let conversions = 0, reports = 0;
    while (state.tick < first.resolveTick + 65) {
      state = tick(state);
      conversions += state.ext.combat!.events.filter(event => event.kind === "robot.converted" && event.targetId === `agent:${helperId}`).length;
      reports += robotsRuntimeOf(state)!.results.filter(event => event.kind === "converted" && event.agentId === helperId).length;
      if (state.tick < first.resolveTick) expect(conversions).toBe(0);
      if (state.tick > first.resolveTick) {
        expect(robotsRuntimeOf(state)!.metadata.find(entry => entry.agentId === helperId)).toMatchObject({ firmware: "bad", convertedTick: first.resolveTick });
        expect(robotsRuntimeOf(state)!.actors.find(actor => actor.id === `agent:${helperId}`)?.firmware).toBe("bad");
      }
    }
    expect(conversions).toBe(1);
    expect(reports).toBe(1);
    expect(completeAgentRuntimeOf(state)?.routines?.tick).toBe(state.tick);
    expect(completeAgentRuntimeOf(state)?.routineOutput).toBeDefined();
    expect(robotsRuntimeOf(state)!.baselines.find(entry => entry.agentId === helperId)?.firmware).toBe("good");
    expect(robotsRuntimeOf(state)!.conversionCap).toBe(2);
  });

  it("cancels an actually running update when a continuous close Watch makes its pusher wary", () => {
    let state = tick(scene(8), Action.watch);
    const started = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update")!;
    expect(started).toBeDefined();
    let interrupted = 0, cancellationTick = -1, converted = 0;
    while (state.tick < 420) {
      state = tick(state, Action.watch);
      const interruption = state.ext.combat!.events.filter(event => event.kind === "update.interrupted" && event.targetId === `agent:${helperId}`);
      interrupted += interruption.length;
      if (interruption.length) cancellationTick = state.tick;
      converted += state.ext.combat!.events.filter(event => event.kind === "robot.converted").length;
    }
    expect(interrupted).toBe(1);
    expect(cancellationTick).toBeGreaterThan(180);
    expect(cancellationTick).toBeLessThan(started.resolveTick);
    expect(converted).toBe(0);
    expect(state.ext.combat!.attacks.some(attack => attack.id === started.id)).toBe(false);
    expect(robotsRuntimeOf(state)!.metadata.find(entry => entry.agentId === helperId)?.firmware).toBe("good");
    expect(robotsRuntimeOf(state)!.metadata.find(entry => entry.agentId === pusherId)?.mode).toBe("wary");
  });

  it("starts its one full combat clock only after previously denied capacity becomes available", () => {
    let state = scene(35);
    state.ext.robots!.protectedArea = true;
    for (let count = 0; count < 25; count++) {
      state = tick(state);
      expect(state.ext.combat!.attacks.filter(attack => attack.kind === "forced-update")).toEqual([]);
      expect(robotsRuntimeOf(state)!.brain.robots.find(entry => entry.agentId === pusherId)?.brain?.update).toBeNull();
    }
    state.ext.robots!.protectedArea = false;
    state = tick(state);
    const accepted = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update")!;
    expect(accepted.startTick).toBe(26);
    expect(accepted.resolveTick).toBe(accepted.startTick + 360);
    let conversions = 0;
    while (state.tick < accepted.resolveTick) {
      state = tick(state);
      const fresh = state.ext.combat!.events.filter(event => event.kind === "robot.converted" && event.targetId === `agent:${helperId}`);
      if (state.tick < accepted.resolveTick) expect(fresh).toEqual([]);
      conversions += fresh.length;
    }
    expect(conversions).toBe(1);
    state = tick(state);
    expect(robotsRuntimeOf(state)!.metadata.find(entry => entry.agentId === helperId)?.convertedTick).toBe(accepted.resolveTick);
  });

  it("starts a fresh full combat clock after a real pending channel is interrupted and readmitted", () => {
    let state = tick(scene(35));
    const interrupted = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update")!;
    for (let count = 0; count < 20; count++) state = tick(state);
    state.ext.combat!.targets[`agent:${pusherId}`] = { ...(state.ext.combat!.targets[`agent:${pusherId}`] ?? initialTarget()), stoppedUntil: state.tick + 2 };
    state = tick(state);
    expect(state.ext.combat!.events.filter(event => event.kind === "update.interrupted")).toHaveLength(1);
    expect(state.ext.combat!.attacks.some(attack => attack.id === interrupted.id)).toBe(false);
    let accepted = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update");
    for (let count = 0; count < 90 && !accepted; count++) {
      state = tick(state);
      accepted = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update");
    }
    expect(accepted).toBeDefined();
    expect(accepted!.id).not.toBe(interrupted.id);
    expect(accepted!.resolveTick - accepted!.startTick).toBe(360);
    let conversions = 0;
    while (state.tick < accepted!.resolveTick) {
      state = tick(state);
      const fresh = state.ext.combat!.events.filter(event => event.kind === "robot.converted" && event.targetId === `agent:${helperId}`);
      if (state.tick < accepted!.resolveTick) expect(fresh).toEqual([]);
      conversions += fresh.length;
    }
    expect(conversions).toBe(1);
  });

  it("resumes a pending registered channel from a JSON snapshot without restarting its timer", () => {
    let state = scene(35);
    while (state.tick < 120) state = tick(state);
    const pending = state.ext.combat!.attacks.find(attack => attack.kind === "forced-update")!;
    expect(pending).toBeDefined();
    let restored = JSON.parse(JSON.stringify(state)) as SimState;
    while (state.tick < pending.resolveTick + 1) {
      state = tick(state);
      restored = tick(restored);
    }
    expect(restored).toEqual(state);
    expect(robotsRuntimeOf(restored)!.metadata.find(entry => entry.agentId === helperId)?.convertedTick).toBe(pending.resolveTick);
  });
});
