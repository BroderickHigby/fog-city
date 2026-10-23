import { describe, expect, it } from "vitest";
import type { AttackRequest, CombatActor, CombatContext, CombatState, ConversionScope } from "../../../src/sim/combat-contract.ts";
import { createConversionScopeLedger, MAX_CONVERSION_SCOPES, MAX_CONVERSION_SCOPE_MEMBERS } from "../../../src/sim/combat/conversion-scopes.ts";
import { ATTACK_EVENT, stepAttacks } from "../../../src/sim/combat/attacks.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

function robot(id: string, good = false, x = 0, z = 0): CombatActor {
  return { id, kind: "robot", model: "footman", firmware: good ? "good" : "bad", x, y: 0, z,
    radius: 0.4, height: 1.8, heading: 0, speed: 0, inFidelity: true };
}
const actors = [robot("a"), robot("b", false, 20), robot("good-a", true, 0, 2), robot("good-b", true, 20, 2)];
const request = (source: "a" | "b", target = `good-${source}`, sequence = 1): AttackRequest => ({ id: `${source}/${sequence}`, attackerId: source, targetId: target, sequence, kind: "forced-update" });
function context(scopes?: readonly ConversionScope[], overrides: Partial<CombatContext> = {}): CombatContext {
  return { actors, players: [], walls: [], refills: [], conversionCap: 10, conversionScopes: scopes, ...overrides };
}
function tick(state: CombatState, ctx: CombatContext): void {
  state.tick++;
  state.events = [];
  stepAttacks(state, ctx, {});
}
function until(state: CombatState, ctx: CombatContext, target: number): void { while (state.tick < target) tick(state, ctx); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
const common = (cap: number): ConversionScope[] => [{ id: "shared", actorIds: actors.map(actor => actor.id), cap }];

describe("compiled conversion scopes", () => {
  it("preserves absence but denies explicit empty and uncovered targets", () => {
    expect(createConversionScopeLedger(actors)).toBeNull();
    expect(createConversionScopeLedger(actors, [])!.allows("good-a")).toBe(false);
    const ledger = createConversionScopeLedger(actors, [{ id: "one", actorIds: ["a", "good-a"], cap: 2 }])!;
    expect(ledger.allows("good-a")).toBe(true);
    expect(ledger.allows("good-b")).toBe(false);
  });

  it("requires room in every containing scope and counts bad firmware plus unique reservations", () => {
    const source = freeze([robot("bad"), robot("one", true), robot("two", true)]);
    const scopes = freeze([{ id: "wide", actorIds: ["bad", "one", "two"], cap: 3 }, { id: "tight", actorIds: ["bad", "one"], cap: 1 }]);
    const before = JSON.stringify({ source, scopes });
    const ledger = createConversionScopeLedger(source, scopes)!;
    expect(ledger.allows("one")).toBe(false);
    expect(ledger.allows("two")).toBe(true);
    ledger.reserve("one"); // Existing reservations are represented even after a cap shrinks.
    ledger.reserve("one");
    ledger.reserve("bad"); // Baseline bad IDs never count twice.
    expect(ledger.allows("two")).toBe(true);
    ledger.reserve("two");
    expect(ledger.allows("two")).toBe(false);
    ledger.release("bad");
    ledger.release("two"); ledger.release("two");
    expect(ledger.allows("two")).toBe(true);
    expect(ledger.allows("one")).toBe(false);
    expect(JSON.stringify({ source, scopes })).toBe(before);
  });

  it("produces the same decisions after scope, member and actor order changes", () => {
    const scopes = [{ id: "left", actorIds: ["a", "good-a", "good-b"], cap: 2 }, { id: "right", actorIds: ["b", "good-b"], cap: 2 }];
    const a = createConversionScopeLedger(actors, scopes)!;
    const b = createConversionScopeLedger([...actors].reverse(), [...scopes].reverse().map(scope => ({ ...scope, actorIds: [...scope.actorIds].reverse() })))!;
    for (const id of ["good-a", "good-b"]) {
      expect(a.allows(id)).toBe(b.allows(id));
      a.reserve(id); b.reserve(id);
    }
    a.release("good-a"); b.release("good-a");
    expect(a.allows("good-a")).toBe(b.allows("good-a"));
  });

  it("rejects malformed or excessive scopes and duplicate IDs", () => {
    for (const scopes of [
      [{ id: "x", actorIds: ["a", "a"], cap: 2 }],
      [{ id: "x", actorIds: [], cap: 0 }, { id: "x", actorIds: [], cap: 1 }],
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(cap => [{ id: "x", actorIds: [], cap }]),
      [{ id: "", actorIds: [], cap: 0 }], [{ id: "x", actorIds: [""], cap: 0 }],
      Array.from({ length: MAX_CONVERSION_SCOPES + 1 }, (_, i) => ({ id: String(i), actorIds: [], cap: 0 })),
      [{ id: "x", actorIds: Array.from({ length: MAX_CONVERSION_SCOPE_MEMBERS + 1 }, (_, i) => String(i)), cap: 0 }],
    ]) expect(() => createConversionScopeLedger(actors, scopes)).toThrow();
    expect(() => createConversionScopeLedger([actors[0]!, actors[0]!], common(3))).toThrow();
  });

  it("forwards supplied scopes through the combat adapter without changing them", () => {
    const world = buildWorld([]), state = createInitialState(world, 12, [], { x: 0, z: 0, heading: 0 });
    const scopes = freeze(common(3));
    expect(contextFromState(world, state, { extraActors: actors, conversionScopes: scopes }).conversionScopes).toBe(scopes);
    expect(contextFromState(world, state).conversionScopes).toBeUndefined();
  });
});

describe("scoped forced-update combat", () => {
  it("admits only the canonical first simultaneous channel while preserving legacy starts", () => {
    const ctx = context(common(3), { attacks: [request("b"), request("a")] });
    const state = createCombatState(12, ctx); tick(state, ctx);
    expect(state.attacks.map(attack => attack.attackerId)).toEqual(["a"]);
    const reversed = context([...common(3)].reverse().map(scope => ({ ...scope, actorIds: [...scope.actorIds].reverse() })), { actors: [...actors].reverse(), attacks: [request("a"), request("b")] });
    const other = createCombatState(12, reversed); tick(other, reversed);
    expect(other.attacks).toEqual(state.attacks);
    expect(other.events).toEqual(state.events);
    const unscoped = context(undefined, { conversionCap: 3, attacks: [request("a"), request("b")] });
    const legacy = createCombatState(12, unscoped); tick(legacy, unscoped);
    expect(legacy.attacks).toHaveLength(2);
  });

  it("prevents a full or protected local scope borrowing capacity from another scope", () => {
    const ctx = context([{ id: "left", actorIds: ["a", "good-a"], cap: 1 }, { id: "right", actorIds: ["b", "good-b"], cap: 2 },
      { id: "protected", actorIds: ["good-a"], cap: 0 }], { attacks: [request("a"), request("b")] });
    const state = createCombatState(12, ctx); tick(state, ctx);
    expect(state.attacks.map(attack => attack.targetId)).toEqual(["good-b"]);
  });

  it("reserves the global scalar ceiling as well as local capacity", () => {
    const ctx = context(common(10), { conversionCap: 3, attacks: [request("a"), request("b")] });
    const state = createCombatState(12, ctx); tick(state, ctx);
    expect(state.attacks.map(attack => attack.attackerId)).toEqual(["a"]);
  });

  it("rechecks current scope capacity on every pending channel tick", () => {
    const wide = context(common(4), { attacks: [request("a"), request("b")] });
    const state = createCombatState(12, wide); tick(state, wide);
    tick(state, context(common(3)));
    expect(state.attacks.map(attack => attack.attackerId)).toEqual(["a"]);
    expect(state.events.filter(event => event.kind === ATTACK_EVENT.interrupted).map(event => event.targetId)).toEqual(["good-b"]);
    expect(state.events.some(event => event.kind === ATTACK_EVENT.converted)).toBe(false);
  });

  it("revalidates shrinking scopes and keeps a completed reservation for the rest of that tick", () => {
    const wide = context(common(4), { attacks: [request("a"), request("b")] });
    const state = createCombatState(12, wide); tick(state, wide);
    expect(state.attacks).toHaveLength(2);
    until(state, wide, 360);
    const narrowed = context(common(3), { attacks: [request("b", "good-b", 2)] });
    tick(state, narrowed);
    expect(state.events.filter(event => event.kind === ATTACK_EVENT.converted).map(event => event.targetId)).toEqual(["good-a"]);
    expect(state.events.filter(event => event.kind === ATTACK_EVENT.interrupted).map(event => event.targetId)).toEqual(["good-b"]);
    expect(state.attacks).toEqual([]);
  });

  it("rechecks target membership on the exact completion tick", () => {
    const ctx = context(common(4), { attacks: [request("a")] });
    const state = createCombatState(12, ctx); until(state, ctx, 360);
    tick(state, context([{ id: "moved-away", actorIds: ["a", "b", "good-b"], cap: 4 }]));
    expect(state.events.some(event => event.kind === ATTACK_EVENT.converted)).toBe(false);
    expect(state.events.some(event => event.kind === ATTACK_EVENT.interrupted)).toBe(true);
  });

  it("releases an interrupted pending slot for a valid request in the same tick", () => {
    const first = context(common(3), { attacks: [request("a")] });
    const state = createCombatState(12, first); tick(state, first);
    state.targets.a!.rust = 0.2;
    tick(state, context(common(3), { attacks: [request("b")] }));
    expect(state.events.some(event => event.kind === ATTACK_EVENT.interrupted && event.targetId === "good-a")).toBe(true);
    expect(state.attacks.map(attack => attack.targetId)).toEqual(["good-b"]);
  });

  it("rejects competing reservations for one target even when numeric caps have room", () => {
    const close = [robot("a"), robot("b"), robot("good-a", true, 0, 2)];
    const ctx = context([{ id: "room", actorIds: close.map(actor => actor.id), cap: 10 }], { actors: close, attacks: [request("b", "good-a"), request("a")] });
    const state = createCombatState(12, ctx); tick(state, ctx);
    expect(state.attacks).toHaveLength(1);
    expect(state.attacks[0]?.attackerId).toBe("a");
  });

  it("does not double count a same-tick conversion already reflected in bad actor firmware", () => {
    const current = actors.map(actor => actor.id === "good-a" ? { ...actor, firmware: "bad" as const } : actor);
    const ctx = context(common(4), { actors: current, conversionCap: 4, attacks: [request("b")] });
    const state = createCombatState(12, ctx); state.tick = 1;
    state.events = [{ id: 1, tick: 1, kind: ATTACK_EVENT.converted, sourceId: "a", targetId: "good-a", amount: 1, detail: "forced-update" }];
    state.nextId = 2;
    stepAttacks(state, ctx, {});
    expect(state.attacks.map(attack => attack.targetId)).toEqual(["good-b"]);
  });

  it("denies new and existing conversions under an explicit empty scope list", () => {
    const ctx = context(common(4), { attacks: [request("a")] });
    const state = createCombatState(12, ctx); tick(state, ctx);
    tick(state, context([], { attacks: [request("b")] }));
    expect(state.attacks).toEqual([]);
    expect(state.events.filter(event => event.kind === ATTACK_EVENT.interrupted)).toHaveLength(1);
  });
});
