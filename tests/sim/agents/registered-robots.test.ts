import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import { AGENT_SPEC, type AgentKind, type AgentState } from "../../../src/sim/agents.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem, runtimeCombatActors } from "../../../src/sim/agents/runtime-system.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { baselineRobotFirmware, robotRuntimeSystem, robotsRuntimeOf } from "../../../src/sim/robots/runtime-system.ts";

const world = buildWorld([]);
function agent(id: number, kind: AgentKind = "errandRobot", x = 0, z = 0): AgentState {
  return { id, kind, x, y: 0, z, heading: 0, pitch: 0, speed: 0, vmax: AGENT_SPEC[kind].vmax,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1, dodge: null };
}
function initial(actors: AgentState[] = [agent(1)], enabled = true, selectedWorld = world): SimState {
  let state = createInitialState(selectedWorld, 17, ["p"], { x: 0, z: -25, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(0, 0, -25, 0);
  state.ext.agents = { nextId: Math.max(0, ...actors.map(actor => actor.id)) + 1, list: actors };
  if (enabled) state = enableAgentRuntime(state, { wave: 2 });
  return state;
}
function context(previous: SimState, selectedWorld = world, actions = 0): SimSystemContext {
  return { world: selectedWorld, previous, state: { ...previous, tick: previous.tick + 1, ext: { ...previous.ext } },
    inputs: { p: { ...NEUTRAL_INPUT, actions } }, events: [] };
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) frozen((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function idWith(firmware: "good" | "bad", from = 1): number {
  let id = from;
  while (baselineRobotFirmware(17, id, "errandRobot") !== firmware) id++;
  return id;
}
function nativeRobot(id: number, firmware: "good" | "bad", z: number): RuntimePhysicalBody {
  return { id: `agent:${id}`, numericId: id, kind: "robot", model: "footman", firmware,
    x: 0, y: 0, z, previousX: 0, previousZ: z, heading: 0, previousHeading: 0,
    speed: 0, radius: 0.4, halfLength: 0.5, halfWidth: 0.4, height: 1.8, dodge: null };
}

describe("registered robot runtime", () => {
  it("does not touch legacy snapshots or invalid/disabled session markers", () => {
    for (const marker of [undefined, { enabled: false, version: 1, wave: 2, startGameMinute: 720, startWeekday: 0 },
      { enabled: true, version: 1, wave: 9, startGameMinute: 720, startWeekday: 0 },
      { enabled: true, version: 1, wave: 2, startGameMinute: -1, startWeekday: 0 }]) {
      const state = initial(undefined, false);
      if (marker) state.ext.robots = marker;
      const system = context(frozen(state));
      expect(robotRuntimeSystem.step(system)).toBe(system.state);
      expect(robotsRuntimeOf(state)).toBeNull();
    }
  });

  it("stores typed output under the session root while preserving unrelated state and body fields", () => {
    const state = initial([agent(idWith("bad")), agent(idWith("good"), "sidewalkBot", 1, -2)]);
    state.ext.robots = { ...state.ext.robots!, foreign: ["keep", 2] };
    state.ext.future = { untouched: true };
    const before = JSON.stringify(state);
    const result = robotRuntimeSystem.step(context(frozen(state)));
    const data = robotsRuntimeOf(result)!;
    expect(data.brain.tick).toBe(1);
    expect(data.enabled).toBe(true);
    expect(data.wave).toBe(2);
    expect(result.ext.robots!.foreign).toEqual(["keep", 2]);
    expect(result.ext.future).toBe(state.ext.future);
    expect(result.players).toBe(state.players);
    expect(result.ext.agents).toBe(state.ext.agents);
    expect(JSON.stringify(state)).toBe(before);
    expect(data.metadata.every(record => record.actorId === `agent:${record.agentId}`)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("assigns stable firmware by seed and numeric identity independently of list order", () => {
    const actors = Array.from({ length: 30 }, (_, index) => agent(index + 1, index % 2 ? "sidewalkBot" : "errandRobot", index, 0));
    actors.push(agent(100, "robotaxi", 40, 0), agent(101, "person", 42, 0));
    const state = initial(actors);
    const first = robotRuntimeSystem.step(context(state));
    const reversed = robotRuntimeSystem.step(context({ ...state, ext: { ...state.ext, agents: { ...state.ext.agents!, list: [...actors].reverse() } } }));
    expect(robotsRuntimeOf(reversed)).toEqual(robotsRuntimeOf(first));
    const data = robotsRuntimeOf(first)!;
    for (const body of actors) {
      const actor = data.actors.find(value => value.id === `agent:${body.id}`)!;
      expect(actor.firmware).toBe(body.kind === "person" ? "none" : baselineRobotFirmware(state.seed, body.id, body.kind));
    }
    expect(data.actors.some(actor => actor.firmware === "bad")).toBe(true);
    expect(data.actors.some(actor => actor.kind === "robot" && actor.firmware === "good")).toBe(true);
    expect(first.rng).toBe(state.rng);
  });

  it("runs through the core system registry only when explicitly enabled", () => {
    const disabled = initial(undefined, false);
    expect(step(world, disabled, {}, [], [robotRuntimeSystem]).ext.robots).toBeUndefined();
    const enabled = initial();
    const result = step(world, enabled, {}, [], [robotRuntimeSystem]);
    expect(robotsRuntimeOf(result)?.brain.tick).toBe(result.tick);
  });

  it("uses the agent wrapper's extra actors and classifies delivered units as bad without changing their identity", () => {
    const delivered = idWith("good");
    const state = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step(context(initial([agent(delivered)])));
    const runtime = {
      ...agentsRuntimeOf(state)!,
      bodies: [{ id: "animal:200", numericId: 200, kind: "animal", model: "pigeon", x: 0, y: 0, z: 3,
        previousX: 0, previousZ: 3, heading: 0, previousHeading: 0, speed: 0, radius: 0.2,
        halfLength: 0.2, halfWidth: 0.2, height: 0.3, dodge: null }],
      significantAgentIds: [delivered], deliveredAgentIds: [delivered],
    };
    state.ext.agents = { ...state.ext.agents!, runtime } as typeof state.ext.agents;
    const result = robotsRuntimeOf(robotRuntimeSystem.step(context(state)))!;
    expect(result.actors.find(actor => actor.id === `agent:${delivered}`)?.firmware).toBe("bad");
    expect(result.actors.find(actor => actor.id === "animal:200")).toMatchObject({ kind: "animal", protected: true, firmware: "none" });
    expect(result.brain.robots.map(entry => entry.agentId)).not.toContain(200);
    expect(result.robotSignificantAgentIds).toContain(delivered);
  });

  it("consumes combat conversion once, preserves alignment across ticks, and honors persistent restores", () => {
    const good = idWith("good"), bad = idWith("bad");
    const first = robotRuntimeSystem.step(context(initial([agent(bad), agent(good, "errandRobot", 0, -2)])));
    first.ext.combat = createCombatState(17, contextFromState(world, first), first.tick);
    first.ext.combat.events = [{ id: 1, tick: first.tick, kind: "robot.converted", sourceId: `agent:${bad}`, targetId: `agent:${good}`, amount: 1, detail: "forced-update" }];
    const converted = robotRuntimeSystem.step(context(first));
    const convertedData = robotsRuntimeOf(converted)!;
    expect(convertedData.results).toMatchObject([{ kind: "converted", agentId: good }]);
    expect(convertedData.metadata.find(record => record.agentId === good)).toMatchObject({ firmware: "bad", convertedTick: 1 });
    expect(convertedData.robotSignificantAgentIds).toContain(good);
    converted.ext.combat = { ...first.ext.combat, tick: converted.tick };
    const repeated = robotRuntimeSystem.step(context(converted));
    expect(robotsRuntimeOf(repeated)!.results).toEqual([]);
    expect(robotsRuntimeOf(repeated)!.actors.find(actor => actor.id === `agent:${good}`)?.firmware).toBe("bad");
    repeated.ext.combat = { ...converted.ext.combat, tick: repeated.tick };
    repeated.ext.robots = { ...repeated.ext.robots!, restoredAgentIds: [good] };
    const restored = robotRuntimeSystem.step(context(repeated));
    expect(robotsRuntimeOf(restored)!.metadata.find(record => record.agentId === good)).toMatchObject({ firmware: "good", convertedTick: null });
    restored.ext.combat = { ...repeated.ext.combat, tick: restored.tick };
    const persisted = robotRuntimeSystem.step(context(restored));
    expect(robotsRuntimeOf(persisted)!.actors.find(actor => actor.id === `agent:${good}`)?.firmware).toBe("good");
  });

  it("counts native bad units in a stable baseline without feeding completed conversions back into the cap", () => {
    const state = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step(context(initial([])));
    const runtime = { ...agentsRuntimeOf(state)!, bodies: [nativeRobot(201, "bad", 0), nativeRobot(202, "good", -2)] };
    state.ext.agents = { ...state.ext.agents!, runtime } as typeof state.ext.agents;
    const first = robotRuntimeSystem.step(context(state));
    expect(robotsRuntimeOf(first)!.conversionCap).toBe(2);
    const protectedState = { ...state, ext: { ...state.ext, robots: { ...state.ext.robots!, protectedArea: true } } };
    expect(robotsRuntimeOf(robotRuntimeSystem.step(context(protectedState)))!.conversionCap).toBe(1);
    first.ext.combat = createCombatState(17, contextFromState(world, first, { extraActors: runtimeCombatActors(first) }), first.tick);
    first.ext.combat.events = [{ id: 1, tick: first.tick, kind: "robot.converted", sourceId: "agent:201", targetId: "agent:202", amount: 1, detail: "forced-update" }];
    const converted = robotRuntimeSystem.step(context(first));
    expect(robotsRuntimeOf(converted)!.metadata.find(entry => entry.agentId === 202)).toMatchObject({ firmware: "bad", baselineFirmware: "good" });
    expect(robotsRuntimeOf(converted)!.conversionCap).toBe(2);
    converted.ext.combat = { ...first.ext.combat, tick: converted.tick };
    converted.ext.agents = { ...converted.ext.agents!, runtime: { ...runtime, bodies: [nativeRobot(201, "bad", 0), nativeRobot(202, "bad", -2)] } } as typeof converted.ext.agents;
    expect(robotsRuntimeOf(robotRuntimeSystem.step(context(converted)))!.conversionCap).toBe(2);
  });

  it("keeps an explicitly restored native extra good even while its body descriptor still says bad", () => {
    const state = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step(context(initial([])));
    state.ext.agents = { ...state.ext.agents!, runtime: { ...agentsRuntimeOf(state)!, bodies: [nativeRobot(201, "bad", 0)] } } as typeof state.ext.agents;
    state.ext.robots = { ...state.ext.robots!, restoredAgentIds: [201] };
    const restored = robotRuntimeSystem.step(context(state));
    expect(robotsRuntimeOf(restored)!.metadata[0]).toMatchObject({ firmware: "good", baselineFirmware: "bad" });
    const repeated = robotRuntimeSystem.step(context(restored));
    expect(robotsRuntimeOf(repeated)!.actors.find(actor => actor.id === "agent:201")?.firmware).toBe("good");
  });

  it("uses real world sight before producing knowledge or attack requests", () => {
    const blockedWorld = buildWorld([{ tileId: "blocked", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10,
      footprint: [[-2, -8], [2, -8], [2, -7], [-2, -7]] }] }]);
    const id = idWith("bad");
    const state = initial([agent(id)], true, blockedWorld);
    state.players.p!.foot = makeFoot(0, 0, -10, 0);
    const result = robotRuntimeSystem.step(context(state, blockedWorld, Action.fire));
    expect(robotsRuntimeOf(result)!.brain.robots[0]?.brain?.knowledge).toEqual([]);
    expect(robotsRuntimeOf(result)!.attacks).toEqual([]);
  });

  it("lets a later combat conversion supersede an older restore acknowledgement", () => {
    const id = idWith("bad"), initialState = initial([agent(id)]);
    initialState.ext.robots = { ...initialState.ext.robots!, restoredAgentIds: [id] };
    const restored = robotRuntimeSystem.step(context(initialState));
    expect(robotsRuntimeOf(restored)!.metadata[0]?.firmware).toBe("good");
    restored.ext.combat = createCombatState(17, contextFromState(world, restored), restored.tick);
    restored.ext.combat.events = [{ id: 1, tick: restored.tick, kind: "robot.converted", sourceId: "agent:999", targetId: `agent:${id}`, amount: 1, detail: "forced-update" }];
    const converted = robotRuntimeSystem.step(context(restored));
    expect(robotsRuntimeOf(converted)!.restoredAgentIds).toEqual([]);
    expect(robotsRuntimeOf(converted)!.metadata[0]?.firmware).toBe("bad");
    converted.ext.combat = { ...restored.ext.combat, tick: converted.tick };
    expect(robotsRuntimeOf(robotRuntimeSystem.step(context(converted)))!.metadata[0]?.firmware).toBe("bad");
  });

  it("rejects malformed persisted runtime data instead of silently replacing an interacted identity", () => {
    const state = initial();
    state.ext.robots = { ...state.ext.robots!, brain: { version: 1, tick: 0, robots: [] } };
    expect(() => robotRuntimeSystem.step(context(state))).toThrow(/persisted/);
  });
});
