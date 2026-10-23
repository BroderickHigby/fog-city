import { describe, expect, it } from "vitest";
import { NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import { buildFallbackSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { createRobotRuntime, stepRobotRuntime } from "../../../src/sim/robots/runtime.ts";

function frame(world: World, actor: CombatActor, repair = true, stopped = false) {
  const state = createInitialState(world, 17, ["p"], { x: 10, z: 20, heading: 0 });
  state.ext.combat = createCombatState(17, { actors: [actor], players: [], walls: [], refills: [] });
  state.ext.combat.targets[actor.id] = { ...state.ext.combat.targets[actor.id]!, repair, rust: repair ? 0.3 : 0,
    stoppedUntil: stopped ? 10 : 0 };
  return state;
}
const body: CombatActor = { id: "agent:1", kind: "robot", firmware: "good", model: "footman", x: 0, y: 0, z: 0,
  heading: 0, speed: 0, radius: 0.4, height: 1.8, inFidelity: true };
function move(world: World, actor: CombatActor, repair = true, stopped = false) {
  const state = frame(world, actor, repair, stopped);
  const result = stepRobotRuntime(createRobotRuntime(), { world, previous: state, state: { ...state, tick: 1 },
    inputs: { p: NEUTRAL_INPUT }, events: [] }, { actors: [actor], conversion: { baseBadCount: 1, protectedArea: false } });
  return { result, state };
}
function routeWorld() {
  const roads: RoadsFile = { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }], edges: [
    { id: "ab", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[0, 0], [50, 0]] },
  ] };
  const graph = buildFallbackSidewalkGraph(buildWorld([], roads).roads!);
  const edge = graph.edges.find(edge => edge.kind === "sidewalk")!;
  const from = graph.nodeById.get(edge.a)!, to = graph.nodeById.get(edge.b)!;
  const world = buildWorld([], roads, null, { version: 1, world: "test", sourceSnapshot: "test", refills: [], tiles: [], territories: [],
    anchors: [{ id: "repair", kind: "repair-kiosk", x: to.x, y: 0, z: to.z, roadNodeId: "b", districtId: "test" }] });
  return { world, actor: { ...body, x: from.x + 1, z: from.z }, to };
}

describe("robot runtime repair integration", () => {
  it("replaces a damaged good robot's errand with travel to an actual reachable kiosk", () => {
    const { world, actor, to } = routeWorld(), { result, state } = move(world, actor);
    expect(result.locomotion[0]).toMatchObject({ intent: { kind: "repair", kioskId: "repair", destination: { x: to.x, z: to.z } },
      repairTravel: { status: "travelling", kioskId: "repair" } });
    expect(state.ext.combat!.targets[actor.id]!.repair).toBe(true);
    expect(result.actors[0]).toMatchObject(actor);
  });

  it("keeps combat holds authoritative over a valid repair route", () => {
    const { world, actor } = routeWorld(), { result } = move(world, actor, true, true);
    expect(result.locomotion[0]).toMatchObject({ intent: { kind: "hold" }, combat: { canAttack: false } });
  });

  it("reports a missing kiosk as pending and does not invent one or clear damage", () => {
    const { result, state } = move(buildWorld([]), body);
    expect(result.locomotion[0]).toMatchObject({ intent: { kind: "hold" }, repairTravel: { status: "pending", reason: "missing-kiosk" } });
    expect(state.ext.combat!.targets[body.id]!.repair).toBe(true);
    expect(move(buildWorld([]), body, false).result.locomotion[0]).toMatchObject({ intent: { kind: "errand" } });
  });
});
