import { describe, expect, it } from "vitest";
import { type AgentState, agentsOf } from "../../../src/sim/agents.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import type { SimState } from "../../../src/sim/contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem } from "../../../src/sim/agents/runtime-system.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";

const world = buildWorld([]);
const system = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } });
function actor(id = 42, kind: AgentState["kind"] = "errandRobot"): AgentState {
  return { id, kind, x: 30, y: 0, z: 0, heading: 0, pitch: 0, speed: 0, vmax: 1.5, edge: "retained-route", dir: 1, lane: 1, s: 37, next: "next-edge", ndir: 1, nlane: 1, conn: null, node: "", resume: 21, lat: 0.2, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 81923, dodge: null };
}
function fixture(kind: AgentState["kind"] = "errandRobot"): SimState {
  const initial = enableAgentRuntime(createInitialState(world, 31, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 2 });
  const first = { ...initial, ext: { ...initial.ext, agents: { nextId: 100, list: [actor(42, kind)] } } };
  const state = system.step({ world, previous: first, state: { ...first, tick: 1 }, inputs: {}, events: [] });
  const combat = createCombatState(31, { actors: [{ id: "agent:42", kind: kind === "person" ? "person" : "robot", firmware: kind === "person" ? "none" : "good", model: "footman", x: 30, y: 0, z: 0, heading: 0, speed: 0, radius: 0.4, height: 1.8 }], players: [], walls: [], refills: [] }, state.tick);
  return { ...state, ext: { ...state.ext, combat } };
}
function removedNext(previous: SimState, leave = true): SimState {
  return { ...previous, tick: previous.tick + 1, players: leave ? {} : { p: { ...previous.players.p!, car: { ...previous.players.p!.car, x: 1000, z: 1000 } } },
    ext: { ...previous.ext, agents: { ...previous.ext.agents!, list: [] } } };
}
function apply(previous: SimState, leave = true): SimState {
  return system.step({ world, previous, state: removedNext(previous, leave), inputs: {}, events: [] });
}

describe("promotion before ambient pruning", () => {
  it.each(["water", "scan", "conversion", "pending-attack"] as const)("retains the same physical identity after player departure following %s", kind => {
    const previous = fixture();
    if (kind === "water") previous.ext.combat!.targets["agent:42"] = { ...initialTarget(), rust: 0.02, lastWaterTick: previous.tick, sourceId: "p" };
    if (kind === "scan") previous.ext.combat!.events.push({ id: 1, tick: previous.tick, kind: "scan.result", sourceId: "p", targetId: "agent:42", amount: 1, detail: "bad" });
    if (kind === "conversion") previous.ext.combat!.events.push({ id: 1, tick: previous.tick, kind: "robot.converted", sourceId: "agent:7", targetId: "agent:42", amount: 1, detail: "forced-update" });
    if (kind === "pending-attack") previous.ext.combat!.attacks.push({ id: "attack:1", kind: "handshake", attackerId: "agent:42", targetId: "p", startTick: previous.tick, resolveTick: previous.tick + 60, endTick: previous.tick + 180, presses: 0, active: false });
    const original = agentsOf(previous)[0]!, result = apply(previous);
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([42]);
    expect(agentsOf(result)[0]).toMatchObject({ id: original.id, x: original.x, z: original.z, edge: original.edge, s: original.s, rng: original.rng, resume: original.resume });
    expect(result.ext.combat).toBe(previous.ext.combat);
  });

  it("promotes a person after an actual wet hit before a fidelity exit", () => {
    const previous = fixture("person");
    previous.ext.combat!.targets["agent:42"] = { ...initialTarget(), wetHits: [previous.tick] };
    const result = apply(previous, false);
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([42]);
    expect(agentsOf(result)[0]?.id).toBe(42);
  });

  it("retains a saved recruit before the robot reducer observes its new roster", () => {
    const previous = fixture(), runtime = agentsRuntimeOf(previous)!;
    runtime.routines = { recruits: [{ playerId: "p", state: { roster: [{ id: "agent:42" }] } }] };
    const result = apply(previous);
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([42]);
  });

  it("does not promote a pristine combat target or a retired actor", () => {
    const pristine = fixture();
    expect(agentsOf(apply(pristine))).toEqual([]);
    const retired = fixture(); retired.ext.combat!.targets["agent:42"]!.rust = 0.4;
    retired.ext.robots = { ...retired.ext.robots!, retiredAgentIds: [42] };
    expect(agentsOf(apply(retired))).toEqual([]);
  });

  it("bounds new promotions by the remaining shared significant capacity", () => {
    const previous = fixture(), runtime = agentsRuntimeOf(previous)!;
    runtime.population.extraSignificant = 2000;
    previous.ext.combat!.targets["agent:42"]!.rust = 0.1;
    const result = apply(previous);
    expect(agentsRuntimeOf(result)?.population.significant).toBe(2000);
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([]);
    expect(agentsRuntimeOf(result)?.diagnostics).toContain("promotion-capacity:42");
  });
  it("preserves space already reserved for arriving van units", () => {
    const previous = fixture(), runtime = agentsRuntimeOf(previous)!;
    runtime.population.extraSignificant = 1998;
    runtime.population.reservedVanUnits = 2;
    previous.ext.combat!.targets["agent:42"]!.rust = 0.1;
    const result = apply(previous);
    expect(agentsRuntimeOf(result)?.significantAgentIds).toEqual([]);
    expect(agentsRuntimeOf(result)?.diagnostics).toContain("promotion-capacity:42");
  });
});
