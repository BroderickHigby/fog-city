import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { pathPoint } from "../../../src/sim/roads.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { createRobotRuntime, stepRobotRuntime } from "../../../src/sim/robots/runtime.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";

const world = buildWorld([], { version: 1,
  nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 200, z: 0 }],
  edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[0, 0], [200, 0]] }],
});
function context(previous: SimState, actions = 0): SimSystemContext {
  return { world, previous, state: { ...previous, tick: previous.tick + 1 }, inputs: { p: { ...NEUTRAL_INPUT, actions } }, events: [] };
}

function scene(rust = 0) {
  const initial = enableAgentRuntime(createInitialState(world, 9, ["p"], { x: 50, z: 0, heading: 0 }), { wave: 3 });
  const boot = stepRoutineRuntime(context(initial), createRoutineRuntime(), { bodies: [], actors: [], nextActorId: 1000 });
  const unit = boot.state.specials.find(special => special.role === "patrol")!;
  expect(unit).toBeDefined();
  const at = pathPoint(world.roads!.edges[0]!.walkPaths[0][0]!, 0);
  const body = { ...unit.body, x: at.x, z: at.z, previousX: at.x, previousZ: at.z, heading: Math.PI / 2, previousHeading: Math.PI / 2, speed: 0 };
  const descriptor: CombatActor = { id: body.id, kind: "robot", firmware: "bad", model: "patrol", x: body.x, y: body.y, z: body.z,
    heading: body.heading, speed: 0, radius: body.radius, height: body.height, inFidelity: true };
  initial.players.p = { ...initial.players.p!, mode: "foot", foot: makeFoot(body.x + 25, 0, body.z, Math.PI / 2) };
  initial.ext.combat = createCombatState(9, { actors: [descriptor], players: [], walls: [], refills: [], conversionCap: 2, wave: 3 });
  initial.ext.combat.targets[body.id] = { ...initialTarget(), rust };
  const robot = stepRobotRuntime(createRobotRuntime(), context(initial, Action.fire), {
    actors: [descriptor], conversion: { baseBadCount: 1, protectedArea: false }, wave: 3,
  });
  const previous: SimState = { ...initial, tick: 1, ext: { ...initial.ext,
    combat: { ...initial.ext.combat, tick: 1 },
    robots: { ...initial.ext.robots!, locomotion: JSON.parse(JSON.stringify(robot.locomotion)) },
  } };
  const routine = { ...boot.state, specials: [{ ...unit, body, plan: null }], initializedOwners: ["p"], pendingEffects: [] };
  return { previous, routine, body, descriptor, robot };
}

describe("Patrol movement uses the existing robot brain", () => {
  it("continues toward the sensed position instead of the owner's new hidden position", () => {
    const setup = scene();
    const intent = setup.robot.locomotion[0]!.intent;
    expect(intent.kind).toBe("pursue");
    setup.previous.players.p = { ...setup.previous.players.p!, foot: makeFoot(setup.body.x - 25, 0, setup.body.z, Math.PI / 2) };
    const result = stepRoutineRuntime(context(setup.previous), setup.routine, { bodies: [setup.body], actors: [setup.descriptor], nextActorId: 1100, spawnBudget: 0 });
    const patrol = result.state.specials[0]!;
    expect(patrol.body.x).toBeGreaterThan(setup.body.x);
    expect(patrol.plan?.goal.x).toBe(setup.body.x + 25);
    expect(patrol.plan?.goal.x).not.toBe(setup.previous.players.p!.foot!.x);
  });

  it("moves away from the observed threat at rust 0.6 instead of following the owner", () => {
    const setup = scene(0.6);
    expect(setup.robot.locomotion[0]!.intent.kind).toBe("flee");
    const result = stepRoutineRuntime(context(setup.previous), setup.routine, { bodies: [setup.body], actors: [setup.descriptor], nextActorId: 1100, spawnBudget: 0 });
    expect(result.state.specials[0]!.body.x).toBeLessThan(setup.body.x);
    expect(result.effects.some(effect => effect.kind === "patrol.terms")).toBe(false);
  });

  it("honors a current combat stop even when the previous brain requested pursuit", () => {
    const setup = scene();
    expect(setup.robot.locomotion[0]!.intent.kind).toBe("pursue");
    setup.previous.ext.combat!.targets[setup.body.id] = { ...initialTarget(), stoppedUntil: 100 };
    const result = stepRoutineRuntime(context(setup.previous), setup.routine, { bodies: [setup.body], actors: [setup.descriptor], nextActorId: 1100, spawnBudget: 0 });
    expect(result.state.specials[0]!.body).toMatchObject({ x: setup.body.x, z: setup.body.z, speed: 0 });
    expect(result.effects.some(effect => effect.kind === "patrol.terms")).toBe(false);
  });

  it("keeps the brain's alert hold and face direction instead of inventing a chase", () => {
    const setup = scene();
    setup.previous.ext.robots!.locomotion = [{ agentId: setup.body.numericId,
      intent: { kind: "hold", face: { x: setup.body.x, z: setup.body.z - 10 }, avoidFog: true },
      combat: { maxSpeed: null, scale: 1, blind: false, canAttack: true } }];
    const result = stepRoutineRuntime(context(setup.previous), setup.routine, { bodies: [setup.body], actors: [setup.descriptor], nextActorId: 1100, spawnBudget: 0 });
    expect(result.state.specials[0]!.body).toMatchObject({ x: setup.body.x, z: setup.body.z, speed: 0, heading: 0 });
  });
});
