import { describe, expect, it } from "vitest";
import { Action, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState } from "../../../src/sim/index.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import type { Gadget } from "../../../src/sim/combat-contract.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime, type RoutineRuntimeEffect, type RoutineRuntimeState } from "../../../src/sim/agents/routine-runtime.ts";
import { finalizeRoutineEffects, recordRoutineLandingReceipts, type RoutineEffectState, type RoutineRestorationArrival } from "../../../src/sim/agents/routine-effects.ts";
import { createFinaleState, type FinaleRoute } from "../../../src/sim/robots/finale.ts";
import type { World } from "../../../src/sim/world.ts";
import { gridCity } from "../fixtures.ts";

const world = gridCity();
const body = (id: number, x: number, z = 0): RuntimePhysicalBody => ({ id: `agent:${id}`, numericId: id, kind: "robot", model: "footman", firmware: "bad", operational: true, x, y: 0, z, previousX: x, previousZ: z, heading: 0, previousHeading: 0, speed: 0, radius: 0.4, halfLength: 0.35, halfWidth: 0.35, height: 1.6, dodge: null });
const effect = (kind: string, actorId: string, targetId = "", playerId = "", amount = 0): RoutineRuntimeEffect => ({ id: `${actorId}/${kind}/${targetId}`, kind, actorId, targetId, playerId, amount, position: null });
type TestRuntime = { bodies: RuntimePhysicalBody[]; routines: RoutineRuntimeState; effectState: RoutineEffectState; routineOutput: { effects: RoutineRuntimeEffect[]; actorMetadata: Record<string, unknown> }; restorationArrivals?: RoutineRestorationArrival[]; restoreSafehouses?: { id: string; x: number; z: number; radiusM?: number }[] };
const runtime = (state: SimState): TestRuntime => (state.ext.agents as unknown as { runtime: TestRuntime }).runtime;

function fixture(effects: RoutineRuntimeEffect[] = []): { before: SimState; after: SimState } {
  const start = enableAgentRuntime(createInitialState(world, 31, ["p"], { x: 50, z: 0, heading: 0 }), { wave: 8 });
  const p = start.players.p!;
  const before: SimState = { ...start, players: { p: { ...p, mode: "foot", foot: { x: 100, y: 0, z: 0, heading: 0, speed: 0, sprint: false, grounded: true, vy: 0, dodge: null } } } };
  const next = { ...before, tick: 1 };
  const seeded = stepRoutineRuntime({ world, previous: before, state: next, inputs: {}, events: [] }, createRoutineRuntime(), { bodies: [], actors: [], nextActorId: 1000, spawnBudget: 32 });
  const routines = { ...seeded.state, specials: seeded.state.specials.filter(s => s.role === "tidy" || s.role === "thief") };
  const bodies = routines.specials.map(s => ({ ...s.body }));
  const tidy = bodies.find(b => b.model === "tidy")!; Object.assign(tidy, { x: 0, z: 0, y: 0 });
  const thief = bodies.find(b => b.model === "footman")!; Object.assign(thief, { x: 50, z: 0, y: 0 });
  for (const s of routines.specials) s.body = bodies.find(b => b.id === s.body.id)!;
  const combat = createCombatState(31, { actors: [], players: [{ id: "p", x: 100, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 }], walls: [], refills: [] }, 1);
  const after = { ...next, ext: { ...next.ext, combat, agents: { nextId: 1100, list: [], runtime: { bodies, routines, significantAgentIds: [], deliveredAgentIds: [], routineOutput: { effects, actorMetadata: {} } } } } } as unknown as SimState;
  return { before, after };
}

describe("physical routine effect finalization", () => {
  it("claims an actual empty car once, rejecting a competing thief", () => {
    const f = fixture(), r = runtime(f.after), thief = r.bodies.find(b => b.model === "footman")!;
    f.before.tick = 180; f.after.tick = 181;
    r.routines.specials.find(s => s.role === "thief")!.theft = { lastTick: 181, phase: "claim", carId: "car:p", ownerId: "p", startedTick: 1, sequence: 1 };
    const competitor = { ...thief, id: "agent:1101", numericId: 1101 };
    r.bodies.push(competitor); r.routines.specials.push({ ...r.routines.specials.find(s => s.role === "thief")!, body: competitor });
    r.routineOutput.effects = [effect("theft.claim", thief.id, "car:p", "p", 1), effect("theft.claim", competitor.id, "car:p", "p", 1)];
    const out = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(out).effectState.carClaims).toHaveLength(1);
    expect(runtime(out).effectState.acks).toHaveLength(1);
    expect(out.players.p!.car).toEqual(f.after.players.p!.car);
  });
  it("does not claim occupied or moving cars or bind a restored thief", () => {
    for (const mode of ["occupied", "moving", "good"] as const) {
      const f = fixture(), r = runtime(f.after), thief = r.bodies.find(b => b.model === "footman")!;
      r.routineOutput.effects = [effect("theft.claim", thief.id, "car:p", "p", 1)];
      if (mode === "occupied") f.after.players.p!.mode = "vehicle";
      if (mode === "moving") f.after.players.p!.car.speed = 2;
      if (mode === "good") thief.firmware = "good";
      expect(runtime(finalizeRoutineEffects(world, f.before, f.after)).effectState.carClaims).toEqual([]);
    }
  });
  it("attaches one physical heap, then carries its actual body on later frames", () => {
    const f = fixture(), r = runtime(f.after), tidy = r.bodies.find(b => b.model === "tidy")!, heap = body(99, 1);
    r.bodies.push(heap); f.after.ext.combat!.targets[heap.id] = { ...initialTarget(), phase: "heap" };
    r.routineOutput.effects = [effect("heap.attach", tidy.id, heap.id)];
    const attached = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(attached).effectState.bindings).toEqual([{ heapId: heap.id, tidyId: tidy.id }]);
    const next = JSON.parse(JSON.stringify(attached)) as SimState; next.tick++;
    runtime(next).bodies.find(b => b.id === tidy.id)!.x = 3;
    runtime(next).routineOutput.effects = [];
    const carried = finalizeRoutineEffects(world, attached, next);
    expect(runtime(carried).bodies.find(b => b.id === heap.id)?.x).toBe(3);
    expect(runtime(carried).bodies.find(b => b.id === heap.id)?.y).toBe(0.4);
  });
  it("does not restore a heap without an actual kiosk and carrying binding", () => {
    const f = fixture(), r = runtime(f.after), tidy = r.bodies.find(b => b.model === "tidy")!, heap = body(99, 0);
    r.bodies.push(heap); f.after.ext.combat!.targets[heap.id] = { ...initialTarget(), phase: "heap", rust: 1 };
    r.routineOutput.effects = [effect("heap.restore", tidy.id, heap.id)];
    const out = finalizeRoutineEffects(world, f.before, f.after);
    expect(out.ext.combat!.targets[heap.id]!.phase).toBe("heap");
    expect(runtime(out).effectState.acks).toEqual([]);
  });
  it("restores the same numeric identity at a kiosk and resets its combat phase", () => {
    const f = fixture(), r = runtime(f.after), tidy = r.bodies.find(b => b.model === "tidy")!, heap = body(99, 0);
    r.bodies.push(heap); f.after.ext.combat!.targets[heap.id] = { ...initialTarget(), phase: "heap", rust: 1 };
    r.routineOutput.effects = [effect("heap.attach", tidy.id, heap.id)];
    const attached = finalizeRoutineEffects(world, f.before, f.after), next = JSON.parse(JSON.stringify(attached)) as SimState; next.tick++;
    runtime(next).routineOutput.effects = [effect("heap.restore", tidy.id, heap.id)];
    const kioskWorld = { ...world, gameplay: { anchors: [{ id: "kiosk", kind: "repair-kiosk", x: 0, y: 0, z: 0 }] } } as unknown as World;
    const out = finalizeRoutineEffects(kioskWorld, attached, next);
    expect(runtime(out).bodies.find(b => b.id === heap.id)).toMatchObject({ numericId: 99, firmware: "good", operational: true });
    expect(out.ext.combat!.targets[heap.id]).toEqual(initialTarget());
    expect(out.ext.robots?.restoredAgentIds).toContain(99);
  });
  it("requires the full terms windup, then allows interaction to end the two-second stop", () => {
    const f = fixture(), r = runtime(f.after), patrol = body(1102, 98); patrol.model = "patrol";
    r.bodies.push(patrol); r.routineOutput.effects = [effect("patrol.terms", patrol.id, "p", "p")];
    let out = finalizeRoutineEffects(world, f.before, f.after);
    expect(out.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    for (let i = 0; i < 60; i++) {
      const next = JSON.parse(JSON.stringify(out)) as SimState; next.tick++;
      out = finalizeRoutineEffects(world, out, next);
    }
    expect(out.ext.combat!.targets.p!.stoppedUntil).toBe(out.tick + 120);
    const next = JSON.parse(JSON.stringify(out)) as SimState; next.tick++;
    const accepted = finalizeRoutineEffects(world, out, next, { p: { throttle: 0, steer: 0, brake: 0, actions: Action.interact } });
    expect(accepted.ext.combat!.targets.p!.stoppedUntil).toBe(accepted.tick);
  });
  it("cancels an in-flight terms windup when newly recorded fog blocks its current sight", () => {
    const f = fixture(), r = runtime(f.after), patrol = { ...body(1102, 98), model: "patrol" };
    const request = effect("patrol.terms", patrol.id, "p", "p");
    r.bodies.push(patrol); r.routineOutput.effects = [request];
    const started = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(started).effectState.terms).toHaveLength(1);
    const obscured = JSON.parse(JSON.stringify(started)) as SimState; obscured.tick++;
    obscured.ext.combat!.gadgets = [{ id: 1, kind: "microclimate", ownerId: "p", x: 99, y: 0, z: 0,
      radius: 0.5, untilTick: 1000, targetId: "", progress: 0, boost: "salt" }] as unknown as Gadget[];
    const cancelled = finalizeRoutineEffects(world, started, obscured);
    expect(runtime(cancelled).effectState.terms).toEqual([]);
    expect(runtime(cancelled).effectState.events).toContainEqual(expect.objectContaining({ kind: "patrol.terms-cancelled" }));
    expect(cancelled.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    expect(runtime(cancelled).effectState.acks).toContain(request.id);
    let out = cancelled;
    for (let i = 0; i < 60; i++) {
      const next = JSON.parse(JSON.stringify(out)) as SimState; next.tick++;
      out = finalizeRoutineEffects(world, out, next);
    }
    expect(out.ext.combat!.targets.p!.stoppedUntil).toBe(0);
  });
  it("keeps a recruit spot pending through new fog and marks only after the ray clears", () => {
    const f = fixture(), r = runtime(f.after), recruit = { ...body(1102, 90), firmware: "good" as const }, target = body(1103, 94);
    const request = effect("recruit.spot", recruit.id, target.id, "p", 1801);
    r.bodies.push(recruit, target); r.routineOutput.effects = [request];
    f.after.ext.combat!.gadgets = [{ id: 1, kind: "microclimate", ownerId: "p", x: 92, y: 0, z: 0,
      radius: 0.5, untilTick: 2, targetId: "", progress: 0, boost: "salt" }] as unknown as Gadget[];
    const denied = finalizeRoutineEffects(world, f.before, f.after);
    expect(denied.ext.combat!.players.p!.marks).toEqual([]);
    expect(runtime(denied).effectState.acks).not.toContain(request.id);
    const next = JSON.parse(JSON.stringify(denied)) as SimState; next.tick++;
    const spotted = finalizeRoutineEffects(world, denied, next);
    expect(spotted.ext.combat!.players.p!.marks).toContainEqual(expect.objectContaining({ targetId: target.id }));
    expect(runtime(spotted).effectState.acks).toContain(request.id);
  });
  it("leaves transport requests unacknowledged until the transport owner acts", () => {
    const f = fixture([effect("recruit.board", "agent:99", "", "p", 1)]);
    const out = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(out).effectState.acks).toEqual([]);
    expect(runtime(out).effectState.diagnostics).toContain("unhandled:recruit.board");
  });
  it("restores a transported recruit only after observed safehouse arrival", () => {
    const f = fixture(), r = runtime(f.after), recruit = body(99, 10);
    r.bodies.push(recruit); f.after.ext.combat!.targets[recruit.id] = { ...initialTarget(), phase: "heap", rust: 1 };
    const request = effect("recruit.restore-at-safehouse", recruit.id, "", "p", 1);
    r.routineOutput.effects = [request];
    r.restorationArrivals = [{ actorId: recruit.id, effectId: request.id, playerId: "p", sequence: 1, safehouseId: "home", position: { x: 10, y: 0, z: 0 } }];
    r.restoreSafehouses = [{ id: "home", x: 100, z: 0 }];
    const denied = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(denied).effectState.acks).toEqual([]);
    r.restoreSafehouses = [{ id: "home", x: 10, z: 0 }];
    const restored = finalizeRoutineEffects(world, f.before, f.after);
    expect(restored.ext.combat!.targets[recruit.id]).toEqual(initialTarget());
    expect(runtime(restored).bodies.find(b => b.id === recruit.id)?.firmware).toBe("good");
    expect(runtime(restored).effectState.acks).toContain(request.id);
  });
  it("records a landing only from the exact current body pose with current full clearance", () => {
    const f = fixture(), r = runtime(f.after);
    const route: FinaleRoute = { id: "walk", waypoints: [{ id: "foot", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 }] };
    const state = { ...createFinaleState({ kind: "walker", route, position: { x: 0, z: 0 }, tick: 1 }), status: "landing" as const, landing: { id: "land:1", requestedTick: 0 } };
    const walker = { ...body(1200, 0), model: "walker", radius: 3 };
    r.bodies.push(walker); r.routines.finales.push({ body: walker, route, state, landingId: "land:1", applied: [] });
    let out = finalizeRoutineEffects(world, f.before, f.after);
    expect(runtime(recordRoutineLandingReceipts(world, out)).effectState.landingReceipts).toHaveLength(1);
    runtime(out).bodies.find(b => b.id === walker.id)!.x = 0.1;
    expect(runtime(recordRoutineLandingReceipts(world, out)).effectState.landingReceipts).toEqual([]);
    runtime(out).bodies.find(b => b.id === walker.id)!.x = 0;
    runtime(out).bodies.push({ ...body(1201, 2), kind: "person", firmware: "none" });
    expect(runtime(recordRoutineLandingReceipts(world, out)).effectState.landingReceipts).toEqual([]);
  });
  it("keeps finale shedding pending when ambient or arriving vans reserve the last slots", () => {
    for (const reserve of [{ ambient: 1, reservedVanUnits: 0 }, { ambient: 0, reservedVanUnits: 1 }]) {
      const f = fixture(), r = runtime(f.after);
      f.after = enableAgentRuntime(f.after, { ambientMode: "squares-v1" });
      const route: FinaleRoute = { id: "shed", waypoints: [{ id: "foot", x: 0, z: 0, phase: "patrol", footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 2 }] };
      const pending = { id: "shed:1", kind: "shed-robots" as const, count: 2, x: 0, z: 0 };
      const finale = { ...createFinaleState({ kind: "walker", route, position: { x: 0, z: 0 }, tick: 1 }), pendingEffects: [pending] };
      const walker = { ...body(1200, 0), model: "walker", radius: 3 };
      r.bodies.push(walker);
      r.routines.finales.push({ body: walker, route, state: finale, landingId: null, applied: [] });
      r.routineOutput.effects = [{ ...effect("finale.shed-robots", walker.id), id: pending.id }];
      Object.assign(r, { population: { significant: 1998, ...reserve } });
      const denied = finalizeRoutineEffects(world, f.before, f.after);
      expect(runtime(denied).effectState.diagnostics).toContain("finale-significant-capacity");
      expect(runtime(denied).effectState.acks).not.toContain(pending.id);
      expect(denied.ext.agents!.nextId).toBe(f.after.ext.agents!.nextId);
      expect(runtime(denied).routines.finales[0]!.state.pendingEffects).toEqual([pending]);

      Object.assign(runtime(denied), { population: { significant: 1997, ...reserve } });
      const next = { ...denied, tick: denied.tick + 1 };
      const resumed = finalizeRoutineEffects(world, denied, next);
      expect(runtime(resumed).effectState.diagnostics).not.toContain("finale-significant-capacity");
      expect(runtime(resumed).effectState.acks).toContain(pending.id);
      expect(resumed.ext.agents!.nextId).toBe(f.after.ext.agents!.nextId + 2);
    }
  });
});
