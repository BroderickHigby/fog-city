import { describe, expect, it } from "vitest";
import { createCombatState, stepCombat } from "../../../src/sim/combat/system.ts";
import type { CombatActor, CombatContext, CombatState, MaintenanceRequest } from "../../../src/sim/combat/types.ts";

const actor = (id: string, patch: Partial<CombatActor> = {}): CombatActor => ({ id, kind: "robot", model: "footman", firmware: "bad", x: 2, y: 0, z: 0, heading: 0, speed: 0, radius: 0.4, height: 1.8, inFidelity: true, ...patch });
const worker = (): CombatActor => actor("tidy", { model: "tidy", firmware: "good", x: 0 });
const collect: MaintenanceRequest = { id: "collect", sequence: 1, kind: "collect-heap", actorId: "heap", workerId: "tidy" };
function context(): CombatContext { return { wave: 3, players: [], actors: [worker(), actor("heap")], refills: [], walls: [], maintenance: [collect], maintenanceKiosks: [{ id: "kiosk", x: 1, y: 0, z: 0 }] }; }
function heap(ctx: CombatContext): CombatState { const s = createCombatState(1, ctx); Object.assign(s.targets.heap!, { phase: "heap", rust: 1, heightScale: 0.3, puddle: true }); return s; }
function run(s: CombatState, ctx: CombatContext, count: number): CombatState { for (let i = 0; i < count; i++) s = stepCombat(s, ctx); return s; }

describe("Tidy maintenance", () => {
  it("requires three continuous seconds and consumes the request only once", () => {
    const ctx = context(); let state = run(heap(ctx), ctx, 179);
    expect(state.targets.heap!.phase).toBe("heap");
    const previous = JSON.stringify(state); state = stepCombat(state, ctx);
    expect(state.targets.heap!.phase).toBe("cleared"); expect(state.targets.heap!.puddle).toBe(false);
    expect(state.events.filter((e) => e.kind === "robot.heap-cleared")).toHaveLength(1);
    expect(state.maintenanceSequence?.tidy).toBe(1);
    expect(run(state, ctx, 10).events).toEqual([]); expect(previous).toContain('"phase":"heap"');
    state.targets.heap!.phase = "heap";
    expect(run(state, ctx, 180).targets.heap!.phase).toBe("heap");
  });

  it("resets interrupted work and cannot accept duplicate conflicting intents", () => {
    const ctx = context(); let state = run(heap(ctx), ctx, 100);
    state = stepCombat(state, { ...ctx, actors: [{ ...worker(), speed: 1 }, actor("heap")] });
    state = run(state, ctx, 179); expect(state.targets.heap!.phase).toBe("heap");
    state = stepCombat(state, ctx); expect(state.targets.heap!.phase).toBe("cleared");
    const conflict = { ...ctx, maintenance: [collect, { ...collect, id: "other", actorId: "other" }] };
    expect(run(heap(ctx), conflict, 180).targets.heap!.phase).toBe("heap");
  });

  it.each([
    { inFidelity: false }, { inFidelity: undefined }, { firmware: "bad" as const },
    { model: "footman" as const }, { y: 3 }, { protected: true },
  ])("rejects a missing, offscreen, non-Tidy or non-operational worker (%j)", (patch) => {
    const ctx = { ...context(), actors: [actor("tidy", { ...worker(), ...patch }), actor("heap")] };
    expect(run(heap(ctx), ctx, 180).targets.heap!.phase).toBe("heap");
  });

  it("never collects protected bodies or occupied taxis", () => {
    for (const patch of [{ protected: true }, { kind: "person" as const }, { model: "robotaxi" as const, occupied: true }]) {
      const ctx = { ...context(), actors: [worker(), actor("heap", patch)] };
      expect(run(heap(ctx), ctx, 180).targets.heap!.phase).toBe("heap");
    }
  });

  it("restores only a repaired helper or converted cargo after sixty seconds at a real kiosk", () => {
    const ctx = { ...context(), maintenance: [{ ...collect, id: "restore", sequence: 2, kind: "restore" as const, kioskId: "kiosk" }] };
    let state = heap(ctx); state.targets.heap!.phase = "cleared";
    expect(run(state, ctx, 3600).targets.heap!.phase).toBe("cleared");
    state.targets.heap!.repair = true;
    state = run(state, ctx, 3599); expect(state.targets.heap!.phase).toBe("cleared");
    state = stepCombat(state, ctx); expect(state.targets.heap).toMatchObject({ phase: "active", rust: 0, repair: false, heightScale: 1 });
    expect(state.events.some((e) => e.kind === "robot.restored")).toBe(true);
    const noKiosk = { ...ctx, maintenanceKiosks: [] };
    state = heap(noKiosk); state.targets.heap!.repair = true;
    expect(run(state, noKiosk, 3600).targets.heap!.phase).toBe("heap");
  });

  it("does not advance the work channel while combat is paused", () => {
    const ctx = context(); let state = run(heap(ctx), ctx, 90);
    state.pauseUntil = state.tick + 30;
    state = run(state, ctx, 30); expect(state.targets.heap!.phase).toBe("heap");
    state = run(state, ctx, 89); expect(state.targets.heap!.phase).toBe("heap");
    expect(stepCombat(state, ctx).targets.heap!.phase).toBe("cleared");
  });

  it("restores converted cargo but never works through a wall", () => {
    const ctx = { ...context(), maintenance: [{ ...collect, id: "restore", sequence: 2, kind: "restore" as const, kioskId: "kiosk" }] };
    let state = heap(ctx); state.targets.heap!.phase = "cleared"; state.targets.heap!.converted = true;
    state = run(state, ctx, 3600);
    expect(state.targets.heap).toMatchObject({ phase: "active", rust: 0 });
    expect(state.targets.heap!.converted).not.toBe(true);
    const wall = { id: "wall", minX: 0.9, maxX: 1.1, minY: -1, maxY: 2, minZ: -1, maxZ: 1 };
    const blocked = { ...context(), walls: [wall] };
    expect(run(heap(blocked), blocked, 180).targets.heap!.phase).toBe("heap");
  });
});
