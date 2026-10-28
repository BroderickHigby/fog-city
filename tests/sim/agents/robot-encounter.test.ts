import { describe, expect, it } from "vitest";
import { Action, SIM_VERSION, type SimState } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState, step, upgradeState } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { canonicalJson, hashState } from "../../../src/sim/serialize.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { datan2 } from "../../../src/sim/dmath.ts";
import { agentsRuntimeOf, createAgentsRuntime, planAgentRuntime, type AgentRuntimeOptions, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { gridCity } from "../fixtures.ts";

const world = buildWorld([]);
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
function initial(): SimState {
  const state = createInitialState(world, 1, ["p"], { x: 30, z: 30, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = makeFoot(0, 0, -4, Math.PI);
  return state;
}
function bot(changes: Partial<RuntimeSpawn> = {}): RuntimeSpawn {
  return { id: "rogue", numericId: 10, model: "footman", firmware: "bad", x: 0, y: 0, z: 0,
    heading: 0, radius: .4, height: 1.8, ...changes };
}
const encounter: AgentRuntimeOptions = { engagePlayers: true, wave: 3, protectedArea: () => false, services: false };
function systems(spawns: RuntimeSpawn[]) {
  return createGameSystems({ wave: 3, protectedArea: () => false, agents: () => ({ spawns, services: false }) });
}

describe("rogue encounters, v17", () => {
  it("initiates from actual close sight, without a fire/scan input or a global heat flag", () => {
    const state = initial(), before = canonicalJson(state);
    const runtime = planAgentRuntime(world, state, {}, { ...encounter, spawns: [bot()] });
    expect(runtime.actors.rogue!.brain!.mode).toBe("alerted");
    expect(runtime.actors.rogue!.brain!.knowledge).toMatchObject([{ playerId: "p", channel: "sight" }]);
    expect(runtime.attacks).toEqual([]);
    expect(canonicalJson(state)).toBe(before);
  });

  it("samples sequential ambient IDs without losing the bad share at the release seed", () => {
    const city = gridCity(), state = createInitialState(city, 1, ["p"], { x: 150, z: 150, heading: 0 });
    const source = state.ext.agents!.list.find(actor => actor.kind === "errandRobot")!;
    state.ext.agents = { ...state.ext.agents!, list: Array.from({ length: 256 }, (_, index) => ({ ...source, id: index + 1 })) };
    const sampled = createAgentsRuntime(state, { badRateAt: () => .1 });
    const robots = Object.values(sampled.actors).filter(actor => actor.model === "footman" || actor.model === "trundle");
    const bad = robots.filter(actor => actor.firmware === "bad");
    expect(robots.length).toBe(256);
    expect(bad.length / robots.length).toBeGreaterThan(.06);
    expect(bad.length / robots.length).toBeLessThan(.14);
    const old = { ...state, version: 16 };
    const previous = createAgentsRuntime(old, { badRateAt: () => .1 });
    const saved = { ...state, ext: { ...state.ext, robots: previous } };
    const after = planAgentRuntime(city, saved, {}, { engagePlayers: true, badRateAt: () => .1 });
    for (const id of Object.keys(previous.actors)) expect(after.actors[id]!.firmware).toBe(previous.actors[id]!.firmware);
  });

  it("keeps the old reactive behavior for v16, opt-outs, cars, distant, hidden and protected players", () => {
    const behindWall = buildWorld([{ tileId: "wall", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10,
      footprint: [[-2, -3], [2, -3], [2, -2], [-2, -2]] }] }]);
    const legacy = initial(); legacy.version = 16;
    const inCar = initial(); inCar.players.p!.mode = "vehicle"; inCar.players.p!.car = { ...inCar.players.p!.car, x: 0, z: -4 };
    const far = initial(); far.players.p!.foot!.z = -24;
    const rows = [
      { state: legacy, options: encounter, world },
      { state: initial(), options: { ...encounter, engagePlayers: false }, world },
      { state: inCar, options: encounter, world },
      { state: far, options: encounter, world },
      { state: initial(), options: encounter, world: behindWall },
      { state: initial(), options: { ...encounter, protectedArea: () => true }, world },
    ];
    for (const row of rows) {
      const runtime = planAgentRuntime(row.world, row.state, {}, { ...row.options, spawns: [bot()] });
      expect(runtime.actors.rogue!.brain!.mode).toBe("disguised");
      expect(runtime.attacks).toEqual([]);
    }
    expect(planAgentRuntime(world, initial(), {}, { ...encounter, spawns: [bot({ heading: Math.PI })] }).actors.rogue!.brain!.mode).toBe("disguised");
    expect(planAgentRuntime(world, initial(), {}, { ...encounter, spawns: [bot({ protected: true })] }).actors.rogue!.brain!.mode).toBe("disguised");
    expect(planAgentRuntime(world, initial(), {}, { ...encounter, spawns: [bot({ firmware: "good" })] }).actors.rogue!.brain).toBeNull();
  });

  it("telegraphs and resolves a real player attack, then actual water disables the moving rogue", () => {
    let state = initial();
    const registry = systems([bot(), bot({ id: "helper", numericId: 11, firmware: "good", x: 20 })]);
    const events: { kind: string; tick: number; targetId: string }[] = [];
    const record = () => events.push(...state.ext.combat!.events);
    for (let tick = 0; tick < 90; tick++) { state = step(world, state, { p: idle }, [], registry); record(); }
    const windup = events.find(event => event.kind === "attack.windup" && event.targetId === "p")!;
    const resolved = events.find(event => event.kind === "attack.resolved" && event.targetId === "p")!;
    expect(windup).toBeDefined();
    expect(resolved).toBeDefined();
    expect(resolved.tick - windup.tick).toBeGreaterThanOrEqual(30);
    expect(events.some(event => event.kind === "player.ad-popup")).toBe(true);
    for (let tick = 0; tick < 570; tick++) {
      const rogue = agentsRuntimeOf(state)!.actors.rogue!, player = state.players.p!.foot!;
      state = step(world, state, { p: { ...idle, actions: Action.fire, aimYaw: datan2(rogue.x - player.x, -(rogue.z - player.z)), aimPitch: .15 } }, [], registry);
      record();
    }
    expect(events.filter(event => event.kind === "weapon.water").length).toBeGreaterThan(40);
    expect(events.filter(event => event.kind === "robot.seized" && event.targetId === "rogue")).toHaveLength(1);
    expect(events.filter(event => event.kind === "robot.heap" && event.targetId === "rogue")).toHaveLength(1);
    expect(state.ext.combat!.targets.rogue!.phase).toBe("heap");
    expect(state.ext.combat!.targets.helper!.rust).toBe(0);
    expect(state.ext.combat!.players.p!.water).toBe(8);
  });

  it("gives the fake-courier Trundle a legal wave-3 player attack once hostile", () => {
    let state = initial();
    state.players.p!.foot!.z = -3;
    const registry = systems([bot({ model: "trundle", archetype: "fakeCourier", level: 1, height: .9 })]);
    const events: string[] = [];
    for (let tick = 0; tick < 75; tick++) {
      state = step(world, state, { p: idle }, [], registry);
      events.push(...state.ext.combat!.events.map(event => event.kind));
    }
    expect(events).toContain("attack.windup");
    expect(events).toContain("player.phone-hack");
  });

  it("reacts to actual spraying beyond the automatic encounter radius", () => {
    let state = initial();
    state.players.p!.foot!.z = -20;
    const registry = systems([bot()]);
    state = step(world, state, { p: { ...idle, actions: Action.fire, aimYaw: Math.PI } }, [], registry);
    expect(state.ext.combat!.events.some(event => event.kind === "weapon.water")).toBe(true);
    expect(agentsRuntimeOf(state)!.actors.rogue!.brain!.mode).toBe("disguised");
    for (let tick = 0; tick < 2; tick++) state = step(world, state, { p: idle }, [], registry);
    expect(agentsRuntimeOf(state)!.actors.rogue!.brain!.mode).toBe("attack");
    expect(agentsRuntimeOf(state)!.actors.rogue!.intent!.movement).toMatchObject({ kind: "pursue", target: { kind: "player", id: "p" } });
  });

  it("does not redirect an eligible foot encounter onto a closer car or protected player", () => {
    for (const mode of ["vehicle", "protected"] as const) {
      let state = initial();
      state.players.q = { ...state.players.p!, id: "q", mode: mode === "vehicle" ? "vehicle" : "foot",
        car: { ...state.players.p!.car, x: 0, z: -2 }, foot: makeFoot(0, 0, -2, Math.PI) };
      const options = { ...encounter, spawns: [bot()], protectedArea: (_x: number, z: number) => mode === "protected" && z < -1 && z > -3 };
      const requests: string[] = [];
      for (let tick = 0; tick < 4; tick++) {
        const runtime = planAgentRuntime(world, { ...state, tick }, {}, options);
        requests.push(...runtime.attacks.map(attack => attack.targetId));
        state = { ...state, ext: { ...state.ext, robots: runtime } };
      }
      expect(requests, mode).toEqual(["p"]);
      expect(agentsRuntimeOf(state)!.actors.rogue!.brain!.knowledge.find(row => row.playerId === "q")!.targetable).toBe(false);
    }
  });

  it("keeps multiplayer ordering stable and upgrades a v16 encounter save without rewriting fields", () => {
    function run(reverse: boolean) {
      let state = initial();
      const second = { ...state.players.p!, id: "q", car: { ...state.players.p!.car, x: 40 }, foot: makeFoot(2, 0, -4, Math.PI) };
      state.players = reverse ? { q: second, p: state.players.p! } : { p: state.players.p!, q: second };
      const spawns = [bot(), bot({ id: "helper", numericId: 11, firmware: "good", x: 20 })];
      const registry = systems(reverse ? spawns.reverse() : spawns);
      for (let tick = 0; tick < 120; tick++) state = step(world, state, reverse ? { q: idle, p: idle } : { p: idle, q: idle }, [], registry);
      return state;
    }
    const state = run(false);
    expect(hashState(run(true))).toBe(hashState(state));
    const old = { ...state, version: 16, ext: { ...state.ext, future: { keep: [1, true] } } };
    const before = canonicalJson(old), upgraded = upgradeState(old);
    expect(SIM_VERSION).toBe(26);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(upgraded.players).toBe(old.players);
    expect(upgraded.ext).toBe(old.ext);
    expect(canonicalJson(old)).toBe(before);
  });
});
