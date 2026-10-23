import { describe, expect, it } from "vitest";
import { DT, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import { makeCar } from "../../../src/sim/car.ts";
import { wrapAngle } from "../../../src/sim/dmath.ts";
import { lanePath, pathPoint } from "../../../src/sim/roads.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createBoxInState } from "../../../src/sim/agents/routines.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { createRoutineRuntime, ROGUE_TAXI_ARRIVAL_M, ROGUE_TAXI_TURN_RATE, stepRoutineRuntime, type RoutineRuntimeState } from "../../../src/sim/agents/routine-runtime.ts";

const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 300, z: 0 }],
  edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[0, 0], [300, 0]] }],
});
function context(previous: SimState): SimSystemContext {
  return { world, previous, state: { ...previous, tick: previous.tick + 1 }, inputs: { p: NEUTRAL_INPUT }, events: [] };
}
function taxiActor(body: RuntimePhysicalBody): CombatActor {
  return { id: body.id, kind: "robot", model: "robotaxi", firmware: "bad", x: body.x, y: body.y, z: body.z,
    heading: body.heading, speed: body.speed, radius: body.radius, height: body.height };
}
function scene() {
  const at = pathPoint(lanePath(world.roads!.edges[0]!, -1, 0), 100);
  const initial = enableAgentRuntime(createInitialState(world, 2, ["p"], { x: at.x, z: at.z, heading: Math.PI / 2 }), { wave: 3 });
  initial.players.p = { ...initial.players.p!, car: makeCar(at.x, at.z, Math.PI / 2) };
  const boot = stepRoutineRuntime(context(initial), createRoutineRuntime(), { bodies: [], actors: [], nextActorId: 1000,
    spawnBudget: 8, threatRequests: [{ id: "taxi:1", kind: "taxi", playerId: "p", player: at, requestTick: 1, threat: 3, unitCount: 1 }] });
  const original = boot.state.specials.find(special => special.role === "rogue-taxi")!;
  expect(original).toBeDefined();
  const body: RuntimePhysicalBody = { ...original.body, x: at.x + 20, z: at.z, previousX: at.x + 20, previousZ: at.z,
    heading: -Math.PI / 2, previousHeading: -Math.PI / 2, speed: 0 };
  return { state: { ...initial, tick: 1 }, routine: { ...boot.state, initializedOwners: ["p"], pendingEffects: [],
    specials: [{ ...original, body, boxIn: createBoxInState() }] }, body, goal: { x: at.x + 10, z: at.z } };
}
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));

describe("rogue taxi physical box-in arrival", () => {
  it("holds and honks only after the actual body arrives, then turns gradually across the lane", () => {
    const setup = scene();
    let state = setup.state, body = setup.body, firstHold = -1;
    let routine: RoutineRuntimeState = setup.routine;
    for (let n = 0; n < 600; n++) {
      const owner = state.players.p!;
      const player: CombatActor = { id: "player:p", playerId: "p", kind: "player", firmware: "none", ...owner.car, radius: 2.4, height: 1.8 };
      const next = stepRoutineRuntime(context(state), routine, { bodies: [body], actors: [taxiActor(body), player], nextActorId: 1100, spawnBudget: 0 });
      const taxi = next.state.specials[0]!, previousBody = body;
      body = taxi.body;
      expect(Math.abs(wrapAngle(body.heading - previousBody.heading))).toBeLessThanOrEqual(ROGUE_TAXI_TURN_RATE * DT + 1e-9);
      expect(distance(body, previousBody)).toBeLessThanOrEqual(8 * DT + 1e-9);
      if (taxi.boxIn!.phase === "hold") {
        if (firstHold < 0) firstHold = state.tick + 1;
        expect(distance(body, setup.goal)).toBeLessThanOrEqual(ROGUE_TAXI_ARRIVAL_M);
        expect(body.speed).toBe(0);
        expect(next.actorMetadata[body.id]?.honking).toBe(true);
      } else {
        expect(next.actorMetadata[body.id]?.honking).toBe(false);
      }
      routine = next.state;
      state = { ...state, tick: state.tick + 1 };
      if (firstHold > 0 && state.tick - firstHold > 100) break;
    }
    expect(firstHold).toBeGreaterThan(120);
    expect(Math.abs(wrapAngle(body.heading - Math.PI))).toBeLessThan(0.05);
  });

  it("does not treat elapsed approach time or a missing road as an arrival", () => {
    const setup = scene();
    const blockedWorld = buildWorld([{ tileId: "barrier", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10,
      footprint: [[setup.body.x - 3, setup.body.z - 10], [setup.body.x - 2, setup.body.z - 10], [setup.body.x - 2, setup.body.z + 10], [setup.body.x - 3, setup.body.z + 10]] }] }]);
    let state = setup.state, body = setup.body;
    let routine: RoutineRuntimeState = setup.routine;
    for (let n = 0; n < 220; n++) {
      const ctx = { ...context(state), world: blockedWorld };
      const next = stepRoutineRuntime(ctx, routine, { bodies: [body], actors: [taxiActor(body)], nextActorId: 1100, spawnBudget: 0 });
      body = next.state.specials[0]!.body;
      expect(next.state.specials[0]!.boxIn!.phase).not.toBe("hold");
      expect(next.actorMetadata[body.id]?.honking).toBe(false);
      routine = next.state; state = { ...state, tick: state.tick + 1 };
    }
    expect(distance(body, setup.goal)).toBeGreaterThan(ROGUE_TAXI_ARRIVAL_M);
  });
});
