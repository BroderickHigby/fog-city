import { describe, expect, it } from "vitest";
import { seedRng } from "../../../src/sim/rng.ts";
import { initialPlayer, initialTarget } from "../../../src/sim/combat/shared.ts";
import { AD_POPUP_TICKS, ATTACK_EVENT, MAX_ATTACK_SOURCES, stepAttacks } from "../../../src/sim/combat/attacks.ts";
import type { AttackKind, AttackRequest, CombatActor, CombatContext, CombatEvent, CombatInputs, CombatPlayer, CombatState } from "../../../src/sim/combat/types.ts";

function player(overrides: Partial<CombatPlayer> = {}): CombatPlayer {
  return { id: "p", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1, ...overrides };
}
function robot(id = "bad", overrides: Partial<CombatActor> = {}): CombatActor {
  return { id, kind: "robot", x: 0, y: 0, z: 1, radius: 0.3, height: 1.6, heading: 0, speed: 0, firmware: "bad", model: "footman", inFidelity: true, ...overrides };
}
function context(actors: CombatActor[] = [robot()], overrides: Partial<CombatContext> = {}): CombatContext {
  return { wave: 2, actors, players: [player()], walls: [], refills: [], ...overrides };
}
function fresh(ctx: CombatContext): CombatState {
  return {
    version: 1, tick: 0, rng: seedRng(11), nextId: 1, players: Object.fromEntries(ctx.players.map(p => [p.id, initialPlayer(p)])),
    targets: Object.fromEntries(ctx.actors.map(actor => [actor.id, initialTarget()])), projectiles: [], gadgets: [],
    attacks: [], attackSequence: {}, events: [], pauseUntil: 0,
  };
}
function request(kind: AttackKind, overrides: Partial<AttackRequest> = {}): AttackRequest {
  return { id: "a1", sequence: 1, attackerId: "bad", targetId: "p", kind, ...overrides };
}
function tick(state: CombatState, ctx: CombatContext, inputs: CombatInputs = {}): CombatEvent[] {
  state.tick++;
  state.events = [];
  stepAttacks(state, ctx, inputs);
  // The package runner records edges after all combat systems consume them.
  for (const p of ctx.players) {
    const own = state.players[p.id]!;
    own.held = own.held.filter(action => action !== "closeAd" && action !== "breakFree");
    if (inputs[p.id]?.closeAd) own.held.push("closeAd");
    if (inputs[p.id]?.breakFree) own.held.push("breakFree");
  }
  return [...state.events];
}
function frames(state: CombatState, ctx: CombatContext, n: number, inputs: CombatInputs = {}): CombatEvent[] {
  const events: CombatEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...tick(state, ctx, inputs));
  return events;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) frozen(nested);
    Object.freeze(value);
  }
  return value;
}

describe("bad-robot attack channels", () => {
  it("gives a shove 36 ticks of warning and spends its sequence exactly once", () => {
    const ctx = context(undefined, { attacks: [request("shove")] });
    const state = fresh(ctx);
    expect(tick(state, ctx).map(e => e.kind)).toEqual([ATTACK_EVENT.windup]);
    expect(frames(state, ctx, 35).filter(e => e.kind === ATTACK_EVENT.runway)).toEqual([]);
    expect(tick(state, ctx).filter(e => e.kind === ATTACK_EVENT.runway)).toMatchObject([{ amount: -1, targetId: "p" }]);
    expect(frames(state, ctx, 100).filter(e => e.kind === ATTACK_EVENT.runway)).toEqual([]);
    expect(state.attacks).toEqual([]);
    expect(state.attackSequence).toEqual({ bad: 1 });
  });

  it("revalidates range, attacker phase and firmware on the completion tick", () => {
    for (const reason of ["range", "phase", "firmware"] as const) {
      const ctx = context(undefined, { attacks: [request("shove")] });
      const state = fresh(ctx);
      tick(state, ctx); frames(state, ctx, 35);
      const changed = reason === "range" ? { ...ctx, players: [player({ z: 5 })] } : reason === "firmware" ?
        { ...ctx, actors: [robot("bad", { firmware: "good" })] } : ctx;
      if (reason === "phase") state.targets.bad!.phase = "heap";
      const events = tick(state, changed);
      expect(events.some(e => e.kind === ATTACK_EVENT.cancelled)).toBe(true);
      expect(events.some(e => e.kind === ATTACK_EVENT.runway)).toBe(false);
      expect(state.attacks).toEqual([]);
    }
  });

  it("never attacks any NPC person or animal, and validates model and vertical range", () => {
    for (const actor of [
      robot("target", { kind: "person", firmware: "none", child: true }),
      robot("target", { kind: "person", firmware: "none", posture: "seated" }),
      robot("target", { kind: "person", firmware: "none", posture: "lying" }),
      robot("target", { kind: "person", firmware: "none", mobilityAid: true }),
      robot("target", { kind: "person", firmware: "none", posture: "standing" }),
      robot("target", { kind: "animal", firmware: "none" }),
      robot("target", { firmware: "good", protected: true }),
    ]) {
      const ctx = context([robot(), actor], { attacks: [request("shove", { targetId: "target" })] });
      const state = fresh(ctx); frames(state, ctx, 50);
      expect(state.events).toEqual([]);
      expect(state.attacks).toEqual([]);
    }
    const wrongModel = context([robot("bad", { model: "trundle" })], { attacks: [request("handshake")] });
    const highTarget = context(undefined, { players: [player({ y: 10 })], attacks: [request("shove")] });
    for (const ctx of [wrongModel, highTarget]) {
      const state = fresh(ctx); tick(state, ctx); expect(state.attacks).toEqual([]);
    }
  });

  it("does not send short-range effects through a wall", () => {
    const ctx = context(undefined, { attacks: [request("shove")], walls: [{ id: "wall", minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: 0.3, maxZ: 0.5 }] });
    const state = fresh(ctx); tick(state, ctx);
    expect(state.attacks).toEqual([]);
    expect(state.attackSequence.bad).toBe(1);
  });

  it("allows at most two melee channels per player, independently of input order", () => {
    const actors = [robot("a"), robot("b"), robot("c")];
    const requests = actors.map(actor => request("handshake", { attackerId: actor.id, id: actor.id }));
    const ctx = context(actors, { attacks: requests });
    const reverse = context([...actors].reverse(), { attacks: [...requests].reverse() });
    const a = fresh(ctx), b = fresh(reverse);
    tick(a, ctx); tick(b, reverse);
    expect(a.attacks.map(attack => attack.attackerId)).toEqual(["a", "b"]);
    expect(a.attacks).toEqual(b.attacks);
    expect(a.events).toEqual(b.events);
  });

  it("shoves and snatches good-robot groceries without changing actor-lane data", () => {
    for (const kind of ["shove", "snatch"] as const) {
      const ctx = frozen(context([robot(), robot("helper", { firmware: "good", z: 1.5 })], { attacks: [request(kind, { targetId: "helper" })] }));
      const before = JSON.stringify(ctx);
      const state = fresh(ctx);
      const events = frames(state, ctx, kind === "shove" ? 37 : 31);
      expect(events.filter(e => e.kind === ATTACK_EVENT.inventory)).toMatchObject([{ amount: -1, targetId: "helper" }]);
      expect(events.some(e => e.kind === ATTACK_EVENT.runway)).toBe(false);
      expect(JSON.stringify(ctx)).toBe(before);
    }
  });

  it("interrupts a six-second conversion at rust 0.2, even on its exact completion tick", () => {
    const ctx = context([robot(), robot("helper", { firmware: "good", z: 2 })], { attacks: [request("forced-update", { targetId: "helper" })], conversionCap: 2 });
    const state = fresh(ctx);
    tick(state, ctx); frames(state, ctx, 359);
    state.targets.bad!.rust = 0.2;
    const events = tick(state, ctx);
    expect(events.some(e => e.kind === ATTACK_EVENT.converted)).toBe(false);
    expect(events.some(e => e.kind === ATTACK_EVENT.interrupted)).toBe(true);
    expect(state.attacks).toEqual([]);
  });

  it("refuses to start a forced update on an occupied robotaxi", () => {
    const ctx = context([robot(), robot("taxi", { firmware: "good", model: "robotaxi", occupied: true, z: 2 })],
      { attacks: [request("forced-update", { targetId: "taxi" })] });
    const state = fresh(ctx);
    const events = frames(state, ctx, 361);
    expect(events.some(e => e.kind === ATTACK_EVENT.windup || e.kind === ATTACK_EVENT.converted)).toBe(false);
    expect(state.attacks).toEqual([]);
  });

  it("cancels a forced update when a rider boards, but permits conversion after they leave", () => {
    const taxi = robot("taxi", { firmware: "good", model: "robotaxi", z: 2 });
    const ctx = context([robot(), taxi], { attacks: [request("forced-update", { targetId: "taxi" })] });
    const state = fresh(ctx);
    tick(state, ctx); frames(state, ctx, 359);
    const occupied = { ...ctx, actors: [robot(), { ...taxi, occupied: true }] };
    const cancelled = tick(state, occupied);
    expect(cancelled.some(e => e.kind === ATTACK_EVENT.converted)).toBe(false);
    expect(cancelled.some(e => e.kind === ATTACK_EVENT.interrupted)).toBe(true);
    expect(state.attacks).toEqual([]);
    const empty = { ...ctx, attacks: [request("forced-update", { id: "a2", sequence: 2, targetId: "taxi" })] };
    const resumed = frames(state, empty, 361);
    expect(resumed.filter(e => e.kind === ATTACK_EVENT.converted)).toMatchObject([{ targetId: "taxi" }]);
  });

  it("counts conversions within one tick so simultaneous channels cannot exceed the cap", () => {
    const actors = [robot("a"), robot("b"), robot("good-a", { firmware: "good", z: 2 }), robot("good-b", { firmware: "good", z: 2 })];
    const ctx = frozen(context(actors, { conversionCap: 3, attacks: [
      request("forced-update", { id: "one", attackerId: "a", targetId: "good-a" }),
      request("forced-update", { id: "two", attackerId: "b", targetId: "good-b" }),
    ] }));
    const state = fresh(ctx);
    const events = frames(state, ctx, 361);
    expect(events.filter(e => e.kind === ATTACK_EVENT.converted)).toHaveLength(1);
    expect(events.filter(e => e.kind === ATTACK_EVENT.bounty)).toMatchObject([{ amount: 3600 }]);
    expect(ctx.actors.filter(actor => actor.firmware === "bad")).toHaveLength(2);
  });

  it("does not convert outside fidelity, at the supplied cap, or after the target moves away", () => {
    for (const variation of ["outside", "cap-reached", "range"] as const) {
      const actors = [robot(), robot("helper", { firmware: "good", z: 2, inFidelity: variation !== "outside" })];
      const ctx = context(actors, { attacks: [request("forced-update", { targetId: "helper" })], conversionCap: variation === "cap-reached" ? 1 : 2 });
      const state = fresh(ctx);
      tick(state, ctx);
      const changed = variation === "range" ? { ...ctx, actors: [robot(), robot("helper", { firmware: "good", z: 12 })] } : ctx;
      const events = frames(state, changed, 360);
      expect(events.some(e => e.kind === ATTACK_EVENT.converted)).toBe(false);
      expect(state.attacks).toEqual([]);
    }
    const far = context([robot("bad", { x: 1000 }), robot("helper", { x: 1000, firmware: "good", z: 2 })], {
      conversionCap: 2, attacks: [request("forced-update", { targetId: "helper" })],
    });
    const state = fresh(far); tick(state, far);
    expect(state.attacks).toEqual([]);
  });

  it("requires eight distinct button presses to escape a handshake and times out at two seconds", () => {
    const ctx = context(undefined, { attacks: [request("handshake")] });
    const state = fresh(ctx); frames(state, ctx, 31);
    frames(state, ctx, 30, { p: { breakFree: true } });
    expect(state.attacks[0]!.presses).toBe(1);
    for (let n = 0; n < 7; n++) { tick(state, ctx); tick(state, ctx, { p: { breakFree: true } }); }
    expect(state.attacks).toEqual([]);
    expect(state.events.some(e => e.kind === ATTACK_EVENT.handshake && e.detail === "broke-free")).toBe(true);

    const timeout = fresh(ctx); frames(timeout, ctx, 150);
    expect(timeout.attacks).toHaveLength(1);
    tick(timeout, ctx); expect(timeout.attacks).toEqual([]);
  });

  it("Rubber Boots reject shoves and handshakes, including activation during windup", () => {
    for (const kind of ["shove", "handshake"] as const) {
      const ctx = context(undefined, { attacks: [request(kind)] });
      const state = fresh(ctx); tick(state, ctx);
      state.players.p!.gear = "boots"; state.players.p!.gearUntil = 1000;
      expect(tick(state, ctx).some(e => e.kind === ATTACK_EVENT.cancelled)).toBe(true);
      expect(state.attacks).toEqual([]);
    }
  });

  it("caps popup slots at three and drains once per player, with one close per press", () => {
    const actors = ["a", "b", "c", "d"].map(id => robot(id));
    const ctx = context(actors, { attacks: actors.map(actor => request("ad-blast", { id: actor.id, attackerId: actor.id })) });
    const state = fresh(ctx); tick(state, ctx); expect(state.attacks).toHaveLength(3);
    frames(state, ctx, 47); const resolved = tick(state, ctx);
    expect(state.attacks.filter(attack => attack.active)).toHaveLength(3);
    expect(resolved.filter(e => e.kind === ATTACK_EVENT.runway)).toMatchObject([{ amount: -0.2 / 60 }]);
    tick(state, ctx, { p: { closeAd: true } }); expect(state.attacks).toHaveLength(2);
    frames(state, ctx, 10, { p: { closeAd: true } }); expect(state.attacks).toHaveLength(2);
    tick(state, ctx); tick(state, ctx, { p: { closeAd: true } }); expect(state.attacks).toHaveLength(1);
    frames(state, ctx, AD_POPUP_TICKS); expect(state.attacks).toEqual([]);
  });

  it("retains a delivered popup after its source leaves, but Airplane Mode clears it", () => {
    const ctx = context(undefined, { attacks: [request("ad-blast")] });
    const state = fresh(ctx); frames(state, ctx, 49);
    const departed = { ...ctx, actors: [] };
    tick(state, departed); expect(state.attacks).toHaveLength(1);
    state.players.p!.gear = "airplane"; state.players.p!.gearUntil = 1000;
    tick(state, departed); expect(state.attacks).toEqual([]);
    expect(state.events.some(e => e.kind === ATTACK_EVENT.runway)).toBe(false);
  });

  it("normalizes player-body aliases so effect start and close address the same player", () => {
    const avatar = robot("player:p", { kind: "player", firmware: "none", playerId: "p", robotBody: false, z: 0 });
    const ctx = context([robot(), avatar], { attacks: [request("ad-blast", { targetId: "player:p" })] });
    const state = fresh(ctx);
    const events = frames(state, ctx, 49);
    expect(state.attacks[0]!.targetId).toBe("p");
    expect(events.filter(e => e.kind === ATTACK_EVENT.popup)).toMatchObject([{ targetId: "p" }]);
    const closed = tick(state, ctx, { p: { closeAd: true } });
    expect(closed.filter(e => e.kind === ATTACK_EVENT.popup)).toMatchObject([{ targetId: "p", amount: -1 }]);
  });

  it("gates phone hacks to wave 3 and breaks them by range, water, or Airplane Mode", () => {
    const old = context(undefined, { attacks: [request("phone-hack")] });
    const oldState = fresh(old); tick(oldState, old); expect(oldState.attacks).toEqual([]);
    for (const reason of ["range", "water", "gear"] as const) {
      const ctx = context(undefined, { wave: 3, attacks: [request("phone-hack")] });
      const state = fresh(ctx); const events = frames(state, ctx, 31);
      expect(events.filter(e => e.kind === ATTACK_EVENT.runway)).toMatchObject([{ amount: -0.1 / 60 }]);
      if (reason === "water") state.targets.bad!.lastDirectWaterTick = state.tick;
      if (reason === "gear") { state.players.p!.gear = "airplane"; state.players.p!.gearUntil = 1000; }
      const changed = reason === "range" ? { ...ctx, players: [player({ z: -5 })] } : ctx;
      const ended = tick(state, changed);
      expect(state.attacks).toEqual([]);
      expect(ended.some(e => e.kind === ATTACK_EVENT.runway)).toBe(false);
    }
  });

  it("consumes rejected sequence tokens and never forgets a source cursor", () => {
    const ctx = context(undefined, { players: [player({ z: 20 })], attacks: [request("shove")] });
    const state = fresh(ctx); tick(state, ctx);
    expect(state.attackSequence.bad).toBe(1);
    tick(state, { ...ctx, players: [player()] }); expect(state.attacks).toEqual([]);
    tick(state, { ...ctx, players: [player()], attacks: [request("shove", { sequence: 2 })] }); expect(state.attacks).toHaveLength(1);
    frames(state, ctx, 50);
    tick(state, { ...ctx, players: [player()] }); expect(state.attacks).toEqual([]);

    const full = fresh(context());
    for (let i = 0; i < MAX_ATTACK_SOURCES; i++) full.attackSequence[`source-${i}`] = 1;
    tick(full, context(undefined, { attacks: [request("shove")] }));
    expect(Object.keys(full.attackSequence)).toHaveLength(MAX_ATTACK_SOURCES);
    expect(full.attacks).toEqual([]);
  });

  it("unknown attackers cannot exhaust the cursor budget before a real attack",()=>{
    const ctx=context(undefined,{attacks:Array.from({length:MAX_ATTACK_SOURCES},(_,i)=>request("shove",{attackerId:`unknown-${i}`}))});
    const state=fresh(ctx);tick(state,ctx);
    expect(Object.keys(state.attackSequence)).toHaveLength(0);
    tick(state,context(undefined,{attacks:[request("shove")]}));
    expect(state.attacks).toHaveLength(1);
  });

  it("canonical player IDs cannot bypass their robot body's collapsed phase",()=>{
    const avatar=robot("player:p",{kind:"player",firmware:"none",playerId:"p",robotBody:true,z:0});
    const ctx=context([robot(),avatar],{attacks:[request("shove",{targetId:"p"})]});
    const state=fresh(ctx);state.targets[avatar.id]!.phase="heap";
    tick(state,ctx);expect(state.attacks).toEqual([]);
  });
});
