import { describe, expect, it } from "vitest";
import { seedRng } from "../../../src/sim/rng.ts";
import { applyBalloon, DEVICE_TUNING, launchBalloon, stepDevices } from "../../../src/sim/combat/devices.ts";
import { initialPlayer, initialTarget } from "../../../src/sim/combat/shared.ts";
import { tickEffects } from "../../../src/sim/combat/effects.ts";
import { advanceProjectile } from "../../../src/sim/combat/physics.ts";
import type { CombatActor, CombatContext, CombatInput, CombatPlayer, CombatState, Projectile, StreakKind } from "../../../src/sim/combat/types.ts";

function player(changes: Partial<CombatPlayer> = {}): CombatPlayer {
  return { id: "p1", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1, ...changes };
}
function actor(id: string, changes: Partial<CombatActor> = {}): CombatActor {
  return { id, kind: "robot", firmware: "bad", model: "footman", x: 3, y: 0, z: 0, radius: 0.4, height: 1.8, heading: 0, speed: 0, ...changes };
}
function context(p: CombatPlayer = player(), changes: Partial<CombatContext> = {}): CombatContext {
  return { wave: 4, actors: [], players: [p], refills: [], walls: [], ...changes };
}
function state(p: CombatPlayer = player()): CombatState {
  return { version: 1, tick: 1, rng: seedRng(17), nextId: 1, players: { [p.id]: initialPlayer(p) }, targets: {}, projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: 0 };
}
function grant(c: CombatContext, kind: StreakKind, sequence = 1): CombatContext {
  return { ...c, streaks: [{ sequence, playerId: c.players[0]!.id, kind }] };
}
function input(s: CombatState, c: CombatContext, value: CombatInput): void {
  stepDevices(s, c, { p1: value });
}
function balloon(s: CombatState): Projectile {
  const p = player({ gadget: "balloon" });
  const projectile = launchBalloon(s, p, { gadget: "balloon" });
  if (!projectile) throw new Error("test balloon did not launch");
  return projectile;
}

describe("wave-four combat devices", () => {
  it("does not activate future-wave devices in earlier waves", () => {
    const p = player({ gadget: "sprinkler", gear: "boots" });
    const s = state(p);
    input(s, grant(context(p, { wave: 3, actors: [actor("bad")] }), "agi"), { gadget: "sprinkler", gear: true, streak: "agi" });
    expect(s.gadgets).toEqual([]);
    expect(s.players.p1!.gear).toBe("none");
    expect(s.pauseUntil).toBe(0);
    expect(s.events).toEqual([]);
  });

  it("requires a matching unconsumed streak authorization and never accepts one from another player", () => {
    const s = state();
    const c = context(player(), { actors: [actor("bad")] });
    input(s, c, { streak: "agi" });
    input(s, { ...c, streaks: [{ playerId: "other", kind: "agi", sequence: 1 }] }, { streak: "agi" });
    expect(s.pauseUntil).toBe(0);
    expect(s.targets.bad).toBeUndefined();
    input(s, grant(c, "agi"), { streak: "agi" });
    expect(s.targets.bad!.rust).toBe(0.6);
    expect(s.pauseUntil).toBe(s.tick + 180);
    s.tick++;
    input(s, grant(c, "agi"), { streak: "agi" });
    expect(s.targets.bad!.rust).toBe(0.6);
    expect(s.players.p1!.streakSequence.agi).toBe(1);
  });

  it("rejects nonfinite or older grant sequences and blocks a held streak even with a new grant", () => {
    const s = state();
    const c = context();
    for (const sequence of [NaN, Infinity, -1, 1.5, 0]) input(s, grant(c, "agi", sequence), { streak: "agi" });
    expect(s.pauseUntil).toBe(0);
    s.players.p1!.held = ["streak"];
    input(s, grant(c, "agi", 2), { streak: "agi" });
    expect(s.pauseUntil).toBe(0);
    s.players.p1!.held = [];
    input(s, grant(c, "agi", 2), { streak: "agi" });
    input(s, grant(c, "agi", 1), { streak: "agi" });
    expect(s.players.p1!.streakSequence.agi).toBe(2);
  });

  it("lets banked rewards activate out of order while rejecting each kind's replay", () => {
    const s = state();
    const c = context(player(), { actors: [actor("bad")], streaks: [
      { playerId: "p1", kind: "confidence", sequence: 1 },
      { playerId: "p1", kind: "agi", sequence: 2 },
    ] });
    input(s, c, { streak: "agi" });
    input(s, c, { streak: "confidence" });
    expect(s.players.p1!.streakSequence).toEqual({ agi: 2, confidence: 1 });
    expect(s.players.p1!.marks.map(mark => mark.targetId)).toEqual(["bad"]);
    const used = s.events.filter(event => event.kind === "streak.used").length;
    input(s, c, { streak: "agi" });
    input(s, c, { streak: "confidence" });
    expect(s.events.filter(event => event.kind === "streak.used")).toHaveLength(used);
  });

  it("throws only equipped balloons, uses inventory, and does not repeat a held throw", () => {
    const p = player({ gadget: "balloon" });
    const s = state(p);
    expect(launchBalloon(s, player(), { gadget: "balloon" })).toBeNull();
    const first = launchBalloon(s, p, { gadget: "balloon", aimYaw: NaN, aimPitch: Infinity })!;
    expect(first.range).toBe(15);
    expect(first.salt).toBe(false);
    expect([first.vx, first.vy, first.vz].every(Number.isFinite)).toBe(true);
    expect(s.players.p1!.balloons).toBe(1);
    s.tick += DEVICE_TUNING.balloonReuseTicks;
    s.players.p1!.held = ["gadget"];
    expect(launchBalloon(s, p, { gadget: "balloon" })).toBeNull();
    s.players.p1!.held = [];
    expect(launchBalloon(s, p, { gadget: "balloon" })).not.toBeNull();
    s.tick += DEVICE_TUNING.balloonReuseTicks;
    expect(launchBalloon(s, p, { gadget: "balloon" })).toBeNull();
  });

  it("bounds extreme finite balloon aim and fallback headings before trigonometry", () => {
    for (const aimYaw of [Number.MAX_VALUE, -Number.MAX_VALUE, 1e100, -1e100, NaN]) {
      const p = player({ gadget: "balloon", heading: Number.MAX_VALUE });
      const s = state(p);
      const projectile = launchBalloon(s, p, { gadget: "balloon", aimYaw, aimPitch: Number.MAX_VALUE })!;
      expect(projectile).not.toBeNull();
      expect([projectile.x, projectile.y, projectile.z, projectile.vx, projectile.vy, projectile.vz].every(Number.isFinite)).toBe(true);
      expect(Math.abs(projectile.x - p.x)).toBeLessThanOrEqual(0.651);
      expect(Math.abs(projectile.z - p.z)).toBeLessThanOrEqual(0.651);
      expect(Math.hypot(projectile.vx, projectile.vz)).toBeLessThanOrEqual(13.001);
    }
  });

  it("sweeps from the player so thin walls and protected bodies cannot hide in a muzzle gap", () => {
    const p = player({ gadget: "balloon" });
    const projectile = launchBalloon(state(p), p, { gadget: "balloon" })!;
    expect(projectile.x).toBe(p.x);
    expect(projectile.z).toBe(p.z);
    const child = actor("child", { kind: "person", firmware: "none", child: true, x: 0, z: -0.3, radius: 0.1 });
    const bodyHit = advanceProjectile(projectile, context(p, { actors: [child] }));
    expect(bodyHit.hit?.id).toBe("child");
    const wallContext = context(p, { walls: [{ id: "thin", minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -0.31, maxZ: -0.3 }] });
    const first = advanceProjectile(projectile, wallContext);
    const second = advanceProjectile(first.projectile, wallContext);
    expect(second.blocked).toBe(true);
  });

  it("removes balloons landing on protected people before any radial effect", () => {
    const s = state();
    const c = context(player(), { actors: [actor("bad", { x: 1 }), actor("child", { x: 0, kind: "person", firmware: "none", child: true })] });
    applyBalloon(s, c, balloon(s), { x: 0, y: 0.5, z: 0 });
    expect(s.targets).toEqual({});
    expect(s.events.at(-1)?.kind).toBe("balloon.removed");
  });

  it("balloon splash rusts only bad firmware and cannot pass through a wall", () => {
    const s = state();
    const c = context(player(), { actors: [actor("bad", { x: 2 }), actor("good", { x: -2, firmware: "good" }), actor("behind", { x: 0, z: -2 })],
      walls: [{ id: "wall", minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -1.2, maxZ: -1 }] });
    applyBalloon(s, c, balloon(s), { x: 0, y: 0.5, z: 0 });
    expect(s.targets.bad!.rust).toBe(0.2);
    expect(s.targets.good).toBeUndefined();
    expect(s.targets.behind).toBeUndefined();
  });

  it("fixed balloon rust triggers seizure and preserves occupied-taxi protection", () => {
    const s = state();
    s.targets.bad = { ...initialTarget(), rust: 0.85 };
    s.targets.taxi = { ...initialTarget(), rust: 0.2 };
    const c = context(player(), { actors: [actor("bad", { x: 2, model: "patrol" }), actor("taxi", { x: -2, model: "robotaxi", occupied: true })] });
    applyBalloon(s, c, balloon(s), { x: 0, y: 0.5, z: 0 });
    expect(s.targets.bad!.phase).toBe("seized");
    expect(s.targets.bad!.rust).toBe(1);
    expect(s.targets.taxi!.rust).toBe(0.29);
    expect(s.targets.taxi!.phase).toBe("active");
    expect(s.events.some(event => event.targetId === "taxi" && event.kind === "robot.pull-over")).toBe(true);
  });

  it("balloons hitting a wall splash its exposed side without crossing the wall", () => {
    const s = state();
    const projectile = { ...balloon(s), vx: 13, vz: 0 };
    const c = context(player(), {
      actors: [actor("exposed", { x: -1 }), actor("behind", { x: 2 })],
      walls: [{ id: "wall", minX: 1, maxX: 1.2, minY: 0, maxY: 3, minZ: -3, maxZ: 3 }],
    });
    applyBalloon(s, c, projectile, { x: 1, y: 0.8, z: 0 });
    expect(s.targets.exposed!.rust).toBe(0.2);
    expect(s.targets.behind).toBeUndefined();
  });

  it("sprinkler applies the configured rate only to bad robots and expires", () => {
    const p = player({ gadget: "sprinkler" });
    const s = state(p);
    const c = context(p, { actors: [actor("bad", { x: 2 }), actor("good", { x: -2, firmware: "good" })] });
    input(s, c, { gadget: "sprinkler" });
    expect(s.targets.bad!.rust).toBeCloseTo(0.15 / 60);
    expect(s.targets.good).toBeUndefined();
    const expiry = s.gadgets[0]!.untilTick;
    s.tick = expiry;
    input(s, c, {});
    expect(s.gadgets).toEqual([]);
  });

  it("automated water stops at a person between the sprinkler and target", () => {
    const p = player({ gadget: "sprinkler" });
    const s = state(p);
    input(s, context(p, { actors: [actor("bad"), actor("person", { x: 1.5, kind: "person", firmware: "none" })] }), { gadget: "sprinkler" });
    expect(s.targets.bad?.rust ?? 0).toBe(0);
    expect(s.targets.person).toBeUndefined();
  });

  it("automated water cannot pass through a terrain ridge", () => {
    const p = player({ gadget: "sprinkler" });
    const s = state(p);
    input(s, context(p, { actors: [actor("bad")], groundHeight: x => x > 1 && x < 2 ? 2 : 0 }), { gadget: "sprinkler" });
    expect(s.targets.bad?.rust ?? 0).toBe(0);
  });

  it("physical water radii exclude robots far above the effect", () => {
    const actors = [actor("airborne", { x: 0.1, y: 100 }), actor("grounded", { x: 2 })];
    const splash = state();
    applyBalloon(splash, context(player(), { actors }), balloon(splash), { x: 0, y: 0.5, z: 0 });
    expect(splash.targets.airborne).toBeUndefined();
    expect(splash.targets.grounded!.rust).toBe(0.2);

    const p = player({ gadget: "sprinkler" });
    const sprinkler = state(p);
    input(sprinkler, context(p, { actors }), { gadget: "sprinkler" });
    expect(sprinkler.targets.airborne).toBeUndefined();
    expect(sprinkler.targets.grounded!.rust).toBeGreaterThan(0);

    const hydrant = state();
    const hydrants = grant(context(player(), { actors, refills: [
      { id: "hydrant", kind: "hydrant", x: 0, y: 0, z: 0, radius: 1, salt: false },
    ] }), "hydrants");
    input(hydrant, hydrants, { streak: "hydrants" });
    expect(hydrant.targets.airborne).toBeUndefined();
    expect(hydrant.targets.grounded!.rust).toBeGreaterThan(0);
  });

  it("rejects remote gadget placement without consuming cooldown", () => {
    const p = player({ gadget: "sprinkler" });
    const s = state(p);
    for (const targetX of [3, NaN, Infinity]) input(s, context(p), { gadget: "sprinkler", targetX });
    expect(s.gadgets).toEqual([]);
    expect(s.players.p1!.nextGadgetTick).toBe(0);
  });

  it("cannot place a device through a nearby wall", () => {
    const p = player({ gadget: "sprinkler" });
    const s = state(p);
    const c = context(p, { walls: [{ id: "thin", minX: 0.9, maxX: 1, minY: 0, maxY: 3, minZ: -2, maxZ: 2 }] });
    input(s, c, { gadget: "sprinkler", targetX: 1.5 });
    expect(s.gadgets).toEqual([]);
    expect(s.players.p1!.nextGadgetTick).toBe(0);
  });

  it("a quiet speaker lures only the nearest stable-id target with no placement ping", () => {
    const p = player({ gadget: "speaker", perks: ["quiet"] });
    const s = state(p);
    const c = context(p, { actors: [actor("z", { x: -3 }), actor("a", { x: 3 }), actor("far", { x: 9 })] });
    input(s, c, { gadget: "speaker" });
    expect(s.gadgets[0]!.targetId).toBe("a");
    expect(s.targets.a!.distractedUntil).toBe(s.tick + 480);
    expect(s.targets.z).toBeUndefined();
    expect(s.events.filter(event => event.kind === "device.lure")).toHaveLength(1);
    expect(s.events.some(event => event.kind === "combat.ping")).toBe(false);
    s.tick++;
    s.players.p1!.held = ["gadget"];
    input(s, c, { gadget: "speaker" });
    expect(s.gadgets).toHaveLength(1);
    expect(s.events.filter(event => event.kind === "device.lure")).toHaveLength(1);
  });

  it("activates equipped gear for fifteen seconds with a ninety-second cooldown", () => {
    const p = player({ gear: "boots" });
    const s = state(p);
    input(s, context(p), { gear: true });
    expect(s.players.p1!.gear).toBe("boots");
    expect(s.players.p1!.gearUntil).toBe(s.tick + 900);
    expect(s.players.p1!.nextGearTick).toBe(s.tick + 5400);
    s.tick += 900;
    input(s, context(p), { gear: true });
    expect(s.players.p1!.gear).toBe("none");
  });

  it("confidence emits one hallucination per four real marks deterministically", () => {
    const actors: CombatActor[] = [];
    for (let i = 0; i < 20; i++) actors.push(actor(`bad-${i}`, { x: 3 + i }));
    for (let i = 0; i < 100; i++) actors.push(actor(`good-${String(i).padStart(3, "0")}`, { x: 10 + i, firmware: "good" }));
    actors.push(actor("human", { kind: "person", firmware: "none" }), actor("animal", { kind: "animal", firmware: "none" }),
      actor("protected-bad", { protected: true }), actor("protected-good", { protected: true, firmware: "good" }));
    const a = state(), b = state();
    input(a, grant(context(player(), { actors }), "confidence"), { streak: "confidence" });
    input(b, grant(context(player(), { actors: [...actors].reverse() }), "confidence"), { streak: "confidence" });
    expect(a).toEqual(b);
    const marks = a.players.p1!.marks;
    expect(marks.find(mark => mark.targetId === "bad-0")).toMatchObject({ untilTick: 1201, confidence: 98, hallucination: false });
    expect(marks.some(mark => ["human", "animal", "protected-bad", "protected-good"].includes(mark.targetId))).toBe(false);
    expect(marks.filter(mark => !mark.hallucination)).toHaveLength(20);
    expect(marks.filter(mark => mark.hallucination)).toHaveLength(5);
    a.tick += 1200;
    input(a, context(), {});
    expect(a.players.p1!.marks).toEqual([]);
  });

  it("never fabricates a majority-false confidence result in a sparse threat scene", () => {
    const goods = Array.from({ length: 100 }, (_, i) => actor(`good-${i}`, { firmware: "good", x: i }));
    const s = state();
    input(s, grant(context(player(), { actors: [actor("one-bad"), ...goods] }), "confidence"), { streak: "confidence" });
    expect(s.players.p1!.marks.map(mark => mark.targetId)).toEqual(["one-bad"]);
    input(s, grant(context(player(), { actors: goods }), "confidence", 2), { streak: "confidence" });
    expect(s.players.p1!.marks).toEqual([]);
  });

  it("prunes disappeared actors and bounds standalone confidence state under churn", () => {
    const batch = (prefix: string, count: number): CombatActor[] => Array.from({ length: count }, (_, i) => actor(`${prefix}-${i}`, { x: i % 100 }));
    const s = state();
    input(s, grant(context(player(), { actors: batch("a", 2220) }), "confidence"), { streak: "confidence" });
    expect(s.players.p1!.marks).toHaveLength(2220);
    input(s, grant(context(player(), { actors: batch("b", 2220) }), "confidence", 2), { streak: "confidence" });
    expect(s.players.p1!.marks).toHaveLength(2220);
    expect(s.players.p1!.marks.every(mark => mark.targetId.startsWith("b-"))).toBe(true);
    input(s, grant(context(player(), { actors: batch("c", 4200) }), "confidence", 3), { streak: "confidence" });
    expect(s.players.p1!.marks).toHaveLength(DEVICE_TUNING.maxConfidenceMarks);
  });

  it("parrots reject unsafe landings and cooldown calls without spending the authorized grant", () => {
    const s = state();
    const animal = actor("animal", { kind: "animal", firmware: "none", x: 20 });
    input(s, grant(context(player(), { actors: [animal] }), "parrots"), { streak: "parrots", targetX: 20 });
    expect(s.players.p1!.streakSequence.parrots).toBeUndefined();
    expect(s.gadgets).toHaveLength(0);
    const c = context(player(), { actors: [actor("bad", { x: 25 })] });
    input(s, grant(c, "parrots"), { streak: "parrots", targetX: 20 });
    expect(s.gadgets[0]!.untilTick).toBe(1201);
    expect(s.events.find(event => event.kind === "device.lure")?.amount).toBe(15);
    s.tick++;
    input(s, grant(c, "parrots", 2), { streak: "parrots", targetX: 20 });
    expect(s.players.p1!.streakSequence.parrots).toBe(1);
  });

  it("persistent lures acquire later entrants without repeated lure events", () => {
    const s = state();
    const c = context(player(), { actors: [actor("incoming", { x: 60 })] });
    input(s, grant(c, "parrots"), { streak: "parrots" });
    expect(s.targets.incoming).toBeUndefined();
    const nearer = { ...c, actors: [actor("incoming", { x: 20 })] };
    s.tick += 300;
    input(s, nearer, {});
    expect(s.targets.incoming!.distractedUntil).toBe(1201);
    input(s, nearer, {});
    expect(s.events.filter(event => event.kind === "device.lure")).toHaveLength(1);

    const p = player({ gadget: "speaker", perks: ["quiet"] });
    const speaker = state(p);
    input(speaker, context(p), { gadget: "speaker" });
    speaker.tick++;
    input(speaker, context(p, { actors: [actor("arriving")] }), {});
    expect(speaker.gadgets[0]!.targetId).toBe("arriving");
    expect(speaker.events.filter(event => event.kind === "device.lure")).toHaveLength(1);
  });

  it("tensor picks the nearest people-free lot, resets interrupted loading, and grants a fog-cooled boost", () => {
    const s = state();
    const c = grant(context(player(), {
      safeLots: [{ id: "occupied", x: 1, y: 0, z: 0, radius: 4 }, { id: "safe", x: 10, y: 0, z: 0, radius: 4 }],
      actors: [actor("person", { x: 1, kind: "person", firmware: "none" })], fog: 0.8,
    }), "tensor");
    input(s, c, { streak: "tensor" });
    expect(s.gadgets[0]!.x).toBe(10);
    const near = { ...c, players: [player({ x: 10 })] };
    input(s, near, { boost: "unrecognized" } as unknown as CombatInput);
    expect(s.gadgets[0]!.progress).toBe(0);
    for (let i = 0; i < 90; i++) { s.tick++; input(s, near, { boost: "pressure" }); }
    expect(s.gadgets[0]!.progress).toBe(90);
    s.tick++; input(s, near, {});
    expect(s.gadgets[0]!.progress).toBe(0);
    for (let i = 0; i < 180; i++) { s.tick++; input(s, near, { boost: "pressure" }); }
    expect(s.players.p1!.boost).toBe("pressure");
    expect(s.players.p1!.boostUntil).toBe(s.tick + 10800);
    expect(s.gadgets).toHaveLength(0);
  });

  it("blimp slows bad robots only in cells clear of people and animals", () => {
    const s = state();
    const c = grant(context(player(), { actors: [actor("clear", { x: 8 }), actor("unsafe", { x: -8 }), actor("person", { x: -8, kind: "person", firmware: "none" }), actor("good", { x: 12, firmware: "good" })] }), "blimp");
    input(s, c, { streak: "blimp" });
    tickEffects(s, c);
    expect(s.targets.clear!.movementScale).toBe(0.5);
    expect(s.targets.unsafe).toBeUndefined();
    expect(s.targets.good).toBeUndefined();
    expect(s.targets.person).toBeUndefined();
  });

  it("confidence and blimp affect declared opponents, never teammates or unspecified players", () => {
    const actors = [
      actor("friend-body", { kind: "player", firmware: "bad", robotBody: true, playerId: "friend", x: 5 }),
      actor("enemy-body", { kind: "player", firmware: "none", playerId: "enemy", x: 10 }),
      actor("unknown-body", { kind: "player", firmware: "none", playerId: "unknown", x: 15 }),
    ];
    const c = context(player(), { actors, mode: "clean-streets", rivalPlayerIds: { p1: ["enemy"] } });
    const s = state();
    input(s, grant(c, "confidence"), { streak: "confidence" });
    expect(s.players.p1!.marks.map(mark => mark.targetId)).toEqual(["enemy-body"]);
    input(s, grant(c, "blimp", 2), { streak: "blimp" });
    expect(s.targets["enemy-body"]!.movementScale).toBe(0.5);
    expect(s.targets["friend-body"]).toBeUndefined();
    expect(s.targets["unknown-body"]).toBeUndefined();
    const withoutRelations = state();
    input(withoutRelations, grant({ ...c, rivalPlayerIds: {} }, "confidence"), { streak: "confidence" });
    expect(withoutRelations.players.p1!.marks).toEqual([]);
  });

  it("open hydrants select one nearest bad robot and ignore good firmware", () => {
    const s = state();
    const c = grant(context(player(), { actors: [actor("a", { x: -4 }), actor("z", { x: 4 }), actor("good", { x: 0, z: 3, firmware: "good" })],
      refills: [{ id: "h", kind: "hydrant", x: 0, y: 0, z: 0, radius: 1, salt: false }, { id: "far", kind: "hydrant", x: 151, y: 0, z: 0, radius: 1, salt: false }] }), "hydrants");
    input(s, c, { streak: "hydrants" });
    expect(s.gadgets).toHaveLength(1);
    expect(s.targets.a!.rust).toBeCloseTo(0.25 / 60);
    expect(s.targets.z).toBeUndefined();
    expect(s.targets.good).toBeUndefined();
  });
});
