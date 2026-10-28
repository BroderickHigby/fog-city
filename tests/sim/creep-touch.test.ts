// v26 (TRUNDLE_FREE_VERSION): two vehicles nobody drives that touch closing slower than
// TOUCH_CONTACT_MPS only lean on each other. Before v26 such a touch knocked a runtime vehicle
// at any speed (100 ticks honking, its wait cleared), so a bus creeping into a stopped robotaxi was
// knocked, crept back and was knocked again, and no deadlock breaker ever fired (The Embarcadero,
// seed 1, traffic-flow-sf.test.ts). A real bump still knocks, and a player's car is unchanged.
import { describe, expect, it } from "vitest";
import { TRUNDLE_FREE_VERSION, createInitialState, makeCar, type AgentState, type SimState } from "../../src/sim/index.ts";
import { TOUCH_CONTACT_MPS, impactsOf, resolveVehicleContacts } from "../../src/sim/impacts.ts";
import { emptyWorld } from "./fixtures.ts";

const world = emptyWorld();
const taxi = (id: number, x: number, z: number, heading = 0): AgentState => ({ id, kind: "robotaxi", x, y: 0, z, heading, pitch: 0, speed: 0, vmax: 10,
  edge: "old", dir: 1, lane: 0, s: 12, next: "next", ndir: 1, nlane: 0, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 7, dodge: null });

/** A service vehicle (a runtime bus-like body, halfLength 2.2) at `speed` m/s nose-first into a stopped robotaxi, one tick. */
function touch(version: number, speed: number): { result: SimState; before: SimState } {
  const initial = createInitialState(world, 3, ["a"], { x: 100, z: 100, heading: 0 });
  const base: SimState = { ...initial, version, players: { a: { ...initial.players.a!, car: makeCar(200, 200, 0) } } };
  // heading 0 drives towards -z. The robotaxi (default 2.5 x 1.0 box) stands just short of touching.
  const a: AgentState = { ...taxi(10, 0, 0), halfLength: 2.2, halfWidth: 0.95, speed, vehicle: { ...makeCar(0, 0, 0), speed } };
  const b = taxi(20, 0, -(2.2 + 2.5 + 0.0005));
  const dz = -speed / 60;
  const before: SimState = { ...base, ext: { ...base.ext, agents: { nextId: 21, list: [a, b] } } };
  const after: SimState = { ...before, tick: 1, ext: { ...before.ext, agents: { nextId: 21, list: [{ ...a, z: dz, vehicle: { ...a.vehicle!, z: dz } }, b] } } };
  return { result: resolveVehicleContacts(world, before, after), before };
}
const actors = (s: SimState) => s.ext.agents!.list;

describe("v26: a creeping touch between two vehicles nobody drives is a lean, not a hit", () => {
  it("is 0.3 m/s, under the 0.4 m/s that knocks a plain robotaxi", () => {
    expect(TOUCH_CONTACT_MPS).toBe(0.3);
  });

  it("v26: creeping at 0.1 m/s, neither is knocked, no event, the creep is refused", () => {
    const { result } = touch(TRUNDLE_FREE_VERSION, 0.1);
    const [bus, robotaxi] = actors(result);
    expect(bus!.knock).toBeUndefined();
    expect(robotaxi!.knock).toBeUndefined();
    expect(bus!.mode).not.toBe("honk");
    expect(impactsOf(result)?.events ?? []).toEqual([]);
    expect(bus!.z).toBeGreaterThanOrEqual(-0.0017);
  });

  it("v25 (before): the same touch knocks the service vehicle and records a hit", () => {
    const { result } = touch(TRUNDLE_FREE_VERSION - 1, 0.1);
    const [bus] = actors(result);
    expect(bus!.knock).toBeDefined();
    expect(bus!.mode).toBe("honk");
    expect((impactsOf(result)?.events ?? []).length).toBe(1);
  });

  it("v26: a real bump (2 m/s) still knocks and records a hit", () => {
    const { result } = touch(TRUNDLE_FREE_VERSION, 2);
    const [bus] = actors(result);
    expect(bus!.knock).toBeDefined();
    expect((impactsOf(result)?.events ?? []).length).toBe(1);
  });
});
