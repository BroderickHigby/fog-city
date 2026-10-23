import { describe, expect, it } from "vitest";
import { createInitialState, type SimState } from "../../../src/sim/index.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createTidyState } from "../../../src/sim/agents/routines.ts";
import { createRoutineRuntime, stepRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";
import type { World } from "../../../src/sim/world.ts";
import { gridCity } from "../fixtures.ts";

const world = { ...gridCity(), gameplay: { anchors: [{ id: "kiosk", kind: "repair-kiosk", x: 100, y: 0, z: -8, districtId: "test", roadNodeId: "g10" }] } } as unknown as World;
const heap: CombatActor = { id: "agent:80", kind: "robot", firmware: "bad", model: "footman", x: 75, y: 0, z: -8, heading: 0, speed: 0, radius: 0.4, height: 1.8 };
const obstacle: CombatActor = { id: "person:blocker", kind: "person", firmware: "none", x: 26, y: 0, z: -8, heading: 0, speed: 0, radius: 0.4, height: 1.8 };

function fixture() {
  const state = enableAgentRuntime(createInitialState(world, 31, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 3 });
  state.ext.agents = { nextId: 1000, list: [] };
  state.ext.combat = { targets: { [heap.id]: { ...initialTarget(), phase: "heap" } }, events: [] } as unknown as NonNullable<SimState["ext"]["combat"]>;
  const body: RuntimePhysicalBody = { id: "agent:42", numericId: 42, kind: "robot", model: "tidy", firmware: "good", operational: true, x: 25, y: 0, z: -8, previousX: 25, previousZ: -8, heading: Math.PI / 2, previousHeading: Math.PI / 2, speed: 0, radius: 0.4, halfLength: 0.35, halfWidth: 0.35, height: 1.6, dodge: null };
  const routines = createRoutineRuntime(); routines.initializedOwners = ["p"];
  routines.specials.push({ body, role: "tidy", ownerId: "p", plan: { goal: { x: heap.x, y: heap.y, z: heap.z }, points: [{ x: heap.x, y: heap.y, z: heap.z }], index: 0 }, drone: null, boxIn: null, tidy: createTidyState(), theft: null, stolenOwnerId: null, carryingHeapId: null, attackSequence: 0, nextTermsTick: 0 });
  return { state, routines, bodies: [body], nextId: 1000 };
}
type Fixture = ReturnType<typeof fixture>;
function advance(f: Fixture, actors: CombatActor[] = [heap, obstacle]): Fixture {
  const after = { ...f.state, tick: f.state.tick + 1 };
  const result = stepRoutineRuntime({ world, previous: f.state, state: after, inputs: {}, events: [] }, f.routines, { bodies: f.bodies, actors, nextActorId: f.nextId, spawnBudget: 0 });
  return { state: after, routines: result.state, bodies: result.bodies, nextId: result.nextActorId };
}
const tidy = (f: Fixture) => f.routines.specials[0]!;

describe("routine blocked movement recovery", () => {
  it("backs away through checked motion after two seconds of requested travel without progress", () => {
    let f = fixture();
    for (let tick = 1; tick < 120; tick++) {
      f = advance(f);
      expect(tidy(f).body.x).toBe(25);
      expect(tidy(f).recovery).toBeUndefined();
    }
    f = advance(f);
    expect(tidy(f).recovery).toBeDefined();
    expect(tidy(f).body.x).toBeLessThan(25);
    expect(25 - tidy(f).body.x).toBeLessThanOrEqual(1 / 60 + 1e-8);
    expect(tidy(f).plan).toBeNull();
  });

  it("resumes the real route when a blocker leaves and clears accumulated stalls", () => {
    let f = fixture();
    for (let tick = 0; tick < 60; tick++) f = advance(f);
    expect(tidy(f).stalledTicks).toBe(60);
    f = advance(f, [heap]);
    expect(tidy(f).body.x).toBeGreaterThan(25);
    expect(tidy(f).stalledTicks).toBeUndefined();
    expect(tidy(f).recovery).toBeUndefined();
    for (let tick = 0; tick < 10; tick++) f = advance(f, [heap]);
    expect(tidy(f).body.x).toBeGreaterThan(25.2);
  });

  it("does not accumulate stalls or run recovery during a dodge", () => {
    let f = fixture();
    for (let tick = 0; tick < 60; tick++) f = advance(f);
    const body = tidy(f).body;
    f = { ...f, bodies: [{ ...body, dodge: { phase: "dive", sx: 25, sz: -8, tx: 24, tz: -8, t: 1, dur: 30, peak: 1, hop: 0.2, leap: false } }] };
    for (let tick = 0; tick < 150; tick++) f = advance(f);
    expect(tidy(f).body.x).toBe(25);
    expect(tidy(f).stalledTicks).toBeUndefined();
    expect(tidy(f).recovery).toBeUndefined();
  });

  it("counts no off-fidelity decisions as blocked travel", () => {
    let f = fixture();
    const observed: CombatActor = { ...heap, ...tidy(f).body, kind: "robot", firmware: "good", model: "tidy", inFidelity: false };
    for (let tick = 0; tick < 150; tick++) f = advance(f, [heap, obstacle, observed]);
    expect(tidy(f).body.x).toBe(25);
    expect(tidy(f).stalledTicks).toBeUndefined();
    expect(tidy(f).recovery).toBeUndefined();
  });

  it("counts elapsed simulation time across a four-tick active cadence", () => {
    let f = fixture();
    f.state.tick = 120; f.routines.tick = 120;
    tidy(f).stalledTicks = 116;
    tidy(f).stalledAt = { tick: 117, x: 25, z: -8 };
    f = advance(f);
    expect(tidy(f).recovery).toBeDefined();
    expect(tidy(f).body.x).toBeLessThan(25);
  });
});
