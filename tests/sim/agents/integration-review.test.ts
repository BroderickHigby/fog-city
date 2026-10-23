import { describe, expect, it } from "vitest";
import { Action, type SimInput, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { CAR, makeCar } from "../../../src/sim/car.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { bodyDistance, dodgeExtOf, vehicleOfCar } from "../../../src/sim/dodge.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { agentsRuntimeOf, createAgentRuntimeSystem } from "../../../src/sim/agents/runtime-system.ts";
import { emptyWorld } from "../fixtures.ts";

const world = emptyWorld();
const neutral: SimInput = { throttle: 0, steer: 0, brake: 0, actions: 0 };
function body(id: number, changes: Partial<RuntimePhysicalBody> = {}): RuntimePhysicalBody {
  return { id: `body:${id}`, numericId: id, kind: "vehicle", model: "bus", x: 0, y: 0, z: 0,
    previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 1.3,
    halfLength: 4.5, halfWidth: 1.3, height: 3.2, dodge: null, ...changes };
}
function fixture(bodies: RuntimePhysicalBody[]): SimState {
  const base = enableAgentRuntime(createInitialState(world, 151, ["p"], { x: 60, z: 60, heading: 0 }), { wave: 2 });
  const initialized = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step({
    world, previous: base, state: { ...base, tick: 1 }, inputs: {}, events: [],
  });
  const runtime = agentsRuntimeOf(initialized)!;
  const agents = { ...initialized.ext.agents!, nextId: 1_000, runtime: { ...runtime, bodies } };
  return { ...initialized, ext: { ...initialized.ext, agents } };
}

describe("runtime bodies participate before player movement", () => {
  it("prevents walking into the long nose of a parked bus without counting a contact", () => {
    const initial = fixture([body(100)]);
    initial.players = { p: { ...initial.players.p!, mode: "foot", foot: { ...makeFoot(0, 0, 4.9, 0), speed: 4.2 } } };
    const result = step(world, initial, { p: { ...neutral, throttle: 1 } }, [], []);
    expect(dodgeExtOf(result).contacts).toBe(0);
    expect(result.players.p!.foot!.z).toBeGreaterThan(4.5 + 0.35);
  });

  it("waits inside the car when the runtime vehicle reach blocks all exit candidates", () => {
    const bus = body(100, { x: 3.4, previousX: 3.4, speed: 6 });
    const initial = fixture([bus]);
    initial.players = { p: { ...initial.players.p!, car: makeCar(0, 0, 0) } };
    const result = step(world, initial, { p: { ...neutral, actions: Action.enterExit } }, [], []);
    expect(result.players.p!.mode).toBe("vehicle");
    expect(result.players.p!.exitPending).toBe(true);
    expect(dodgeExtOf(result).contacts).toBe(0);
  });

  it("stops a driven car at the bus's actual length instead of passing through its nose", () => {
    let current = fixture([body(100)]);
    current.players = { p: { ...current.players.p!, car: { ...makeCar(0, -7.4, Math.PI), speed: 10 } } };
    for (let tick = 0; tick < 8; tick++) current = step(world, current, { p: { ...neutral, throttle: 1 } }, [], []);
    expect(current.players.p!.car.hits).toBeGreaterThan(0);
    expect(current.players.p!.car.z + CAR.halfLength).toBeLessThan(-4.5 + 0.05);
  });

  it("does not turn airborne robots into ground car obstacles", () => {
    const drone = body(100, { kind: "robot", model: "drone", y: 20, radius: 0.4, halfLength: 0.4, halfWidth: 0.4, height: 0.5 });
    let current = fixture([drone]);
    current.players = { p: { ...current.players.p!, car: makeCar(0, 0, 0) } };
    for (let tick = 0; tick < 12; tick++) current = step(world, current, { p: { ...neutral, throttle: 1 } }, [], []);
    expect(current.players.p!.car.speed).toBeGreaterThan(0);
    expect(current.players.p!.car.hits).toBe(0);
  });

  it("keeps a solid grounded runtime robot in the car collision set", () => {
    const robot = body(100, { kind: "robot", model: "walker", radius: 1, halfLength: 1, halfWidth: 1, height: 3 });
    let current = fixture([robot]);
    current.players = { p: { ...current.players.p!, car: { ...makeCar(0, 3.6, 0), speed: 10 } } };
    for (let tick = 0; tick < 8; tick++) current = step(world, current, { p: { ...neutral, throttle: 1 } }, [], []);
    expect(current.players.p!.car.hits).toBeGreaterThan(0);
    expect(current.players.p!.car.z - CAR.halfLength).toBeGreaterThan(1 - 0.05);
  });

  it("keeps parked player cars solid when their owners are walking elsewhere", () => {
    const initial = fixture([]);
    initial.players = {
      p: { ...initial.players.p!, mode: "foot", foot: { ...makeFoot(0, 0, CAR.halfLength + 0.4, 0), speed: 4.2 } },
      q: { id: "q", mode: "foot", car: makeCar(0, 0, 0), foot: makeFoot(50, 0, 50, 0), exitPending: false },
    };
    const result = step(world, initial, { p: { ...neutral, throttle: 1 }, q: neutral }, [], []);
    expect(dodgeExtOf(result).contacts).toBe(0);
    expect(result.players.q!.car.x).toBe(0);
    expect(result.players.q!.car.z).toBe(0);
  });

  it("places a joining car clear of a stationary runtime bus on the same ground layer", () => {
    const initial = fixture([body(100)]);
    const result = step(world, initial, {}, [{ kind: "player.join", tick: initial.tick + 1, playerId: "q", payload: { x: 0, z: 0, heading: 0 } }], []);
    const car = result.players.q!.car;
    // Circumscribed circles are conservative, so their clear result also clears the bus box.
    expect(Math.abs(car.x) > 1.3 + CAR.halfWidth || Math.abs(car.z) > 4.5 + CAR.halfLength).toBe(true);
    expect(car.y).toBe(0);
    expect(Math.hypot(car.x, car.z)).toBeLessThan(50);
    expect(dodgeExtOf(result).contacts).toBe(0);
  });

  it("places a joining car clear of an animal without moving the animal to repair the spawn", () => {
    const animal = body(100, { kind: "animal", model: "pigeon", radius: 0.2, halfLength: 0.2, halfWidth: 0.2, height: 0.25 });
    const initial = fixture([animal]);
    const result = step(world, initial, {}, [{ kind: "player.join", tick: initial.tick + 1, playerId: "q", payload: { x: 0, z: 0, heading: 0 } }], []);
    const car = result.players.q!.car, actual = agentsRuntimeOf(result)!.bodies[0]!;
    expect(bodyDistance(vehicleOfCar("q", car), 0, 0)).toBeGreaterThan(0.2);
    expect(actual).toMatchObject({ x: 0, y: 0, z: 0, dodge: null });
    expect(car.y).toBe(0);
    expect(Math.hypot(car.x, car.z)).toBeLessThan(50);
    expect(dodgeExtOf(result).contacts).toBe(0);
  });
});
