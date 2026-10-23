import { describe, expect, it } from "vitest";
import { seedRng, nextFloat } from "../../../src/sim/rng.ts";
import { dcos, dsin, TAU } from "../../../src/sim/dmath.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import { applyRust, applyWaterHit, EFFECTS, hasLineOfSight, scanAccuracy, stepSupport, tickEffects } from "../../../src/sim/combat/effects.ts";
import { initialPlayer, targetOf } from "../../../src/sim/combat/shared.ts";
import type { CombatActor, CombatContext, CombatPlayer, CombatState, Projectile, RefillSource } from "../../../src/sim/combat/types.ts";

function player(overrides: Partial<CombatPlayer> = {}): CombatPlayer {
  return { id: "p1", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1, ...overrides };
}
function actor(overrides: Partial<CombatActor> = {}): CombatActor {
  return { id: "bot", kind: "robot", firmware: "bad", model: "footman", x: 0, y: 0, z: -5, radius: 0.5, height: 1.8, speed: 0, heading: 0, ...overrides };
}
function state(p = player(), seed = 1): CombatState {
  return { version: 1, tick: 0, rng: seedRng(seed), nextId: 1, players: { [p.id]: initialPlayer(p) }, targets: {}, projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: 0 };
}
function context(actors: readonly CombatActor[] = [actor()], p = player(), extra: Partial<CombatContext> = {}): CombatContext {
  return { actors, players: [p], refills: [], walls: [], ...extra };
}
function water(overrides: Partial<Projectile> = {}): Projectile {
  return { id: 1, kind: "water", ownerId: "p1", x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: -13, distance: 0, range: 12, bornTick: 0, volume: 0.08, salt: false, vehicle: false, rustRate: 0.025, ...overrides };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}
function advanceSupport(s: CombatState, ctx: CombatContext, input: { scan?: boolean; refill?: string; aimYaw?: number }, ticks: number): void {
  for (let n = 0; n < ticks; n++) { s.tick += 1; stepSupport(s, ctx, { p1: input }); }
}

describe("combat rust and lifecycle", () => {
  it("applies direct-water salt and model multipliers without changing actors", () => {
    const footman = freeze(actor());
    const s = state();
    applyWaterHit(s, footman, water({ salt: true }));
    expect(s.targets.bot!.rust).toBeCloseTo(0.04, 12);
    const patrol = freeze(actor({ id: "patrol", model: "patrol" }));
    applyWaterHit(s, patrol, water());
    expect(s.targets.patrol!.rust).toBeCloseTo(0.0125, 12);
    const drone = actor({ id: "drone", model: "drone" });
    applyWaterHit(s, drone, water());
    expect(s.targets.drone!.rust).toBeCloseTo(0.0375, 12);
    expect(footman.firmware).toBe("bad");
  });

  it("does not penalize grazing; crosses 0.3 once and requests a repair kiosk", () => {
    const good = actor({ firmware: "good" });
    const s = state();
    for (let n = 0; n < 10; n++) applyWaterHit(s, good, water());
    expect(s.targets.bot!.rust).toBeCloseTo(0.25, 12);
    expect(s.events).toEqual([]);
    for (let n = 0; n < 5; n++) applyWaterHit(s, good, water());
    expect(s.targets.bot!.rust).toBeCloseTo(0.375, 12);
    expect(s.targets.bot!.phase).toBe("active");
    expect(s.targets.bot!.repair).toBe(true);
    expect(s.targets.bot!.movementScale).toBe(0.7);
    expect(s.events.filter(event => event.kind === "economy.penalty")).toMatchObject([{ amount: 50, detail: "reputation:-5" }]);
    applyWaterHit(s, good, water());
    expect(s.events.filter(event => event.kind === "economy.penalty")).toHaveLength(1);
  });

  it("rejects ambient rust on good robots, nonrobots, and invalid numeric damage", () => {
    const s = state();
    applyRust(s, actor({ firmware: "good" }), 10, "rain", false);
    applyRust(s, actor({ kind: "person", firmware: "none" }), 10, "p1", true);
    for (const amount of [NaN, Infinity, -1, 0]) applyRust(s, actor(), amount, "p1", true);
    expect(s.targets).toEqual({});
    expect(s.events).toEqual([]);
  });

  it("applies partial rust thresholds exactly without compounding modifiers", () => {
    const s = state();
    const bot = actor();
    applyRust(s, bot, 0.49, "p1", true);
    expect(s.targets.bot!.movementScale).toBe(1);
    applyRust(s, bot, 0.01, "p1", true);
    expect(s.targets.bot!.movementScale).toBe(0.7);
    expect(s.targets.bot!.windupScale).toBe(1.3);
    for (let n = 0; n < 100; n++) { s.tick += 1; tickEffects(s, context([bot])); }
    expect(s.targets.bot!.movementScale).toBe(0.7);
    expect(s.targets.bot!.windupScale).toBe(1.3);
  });

  it("preserves active blimp slowing over rust modifiers and restores the rust speed at expiry", () => {
    const s = state();
    const bot = actor();
    applyRust(s, bot, 0.5, "p1", true);
    s.targets.bot!.slowUntil = 20;
    s.tick = 19; tickEffects(s, context([bot]));
    expect(s.targets.bot!.movementScale).toBe(0.5);
    expect(s.targets.bot!.windupScale).toBe(1.3);
    s.tick = 20; tickEffects(s, context([bot]));
    expect(s.targets.bot!.movementScale).toBe(0.7);
  });

  it("supports explicitly fixed rust effects without armor scaling and keeps the occupied-taxi cap", () => {
    const s = state();
    const patrol = actor({ model: "patrol" });
    applyRust(s, patrol, 0.2, "p1", false, false);
    expect(s.targets.bot!.rust).toBe(0.2);
    applyRust(s, patrol, 0.2, "p1", false);
    expect(s.targets.bot!.rust).toBeCloseTo(0.3, 12);
    const occupied = actor({ id: "occupied", model: "robotaxi", occupied: true });
    applyRust(s, occupied, 0.6, "p1", false, false);
    expect(s.targets.occupied!.rust).toBe(0.29);
    expect(s.targets.occupied!.phase).toBe("active");
  });

  it("dries only subthreshold rust after five seconds, never permanent rust", () => {
    const s = state();
    applyRust(s, actor(), 0.25, "p1", true);
    s.tick = 299; tickEffects(s, context());
    expect(s.targets.bot!.rust).toBe(0.25);
    s.tick = 300; tickEffects(s, context());
    expect(s.targets.bot!.rust).toBeCloseTo(0.25 - 0.02 / 60, 12);
    const permanent = actor({ id: "permanent" });
    applyRust(s, permanent, 0.3, "p1", true);
    s.tick = 1000; tickEffects(s, context([permanent]));
    expect(s.targets.permanent!.rust).toBe(0.3);
  });

  it.each(["footman", "trundle", "patrol", "drone", "sign-spinner"] as const)("%s collapses within two seconds with heap and puddle", model => {
    const s = state();
    const bot = actor({ model });
    applyRust(s, bot, 100, "p1", true);
    expect(s.targets.bot!.phase).toBe("seized");
    s.tick = 29; tickEffects(s, context([bot]));
    expect(s.targets.bot!.phase).toBe("seized");
    s.tick = 30; tickEffects(s, context([bot]));
    expect(s.targets.bot!.phase).toBe("slumping");
    s.tick = 119; tickEffects(s, context([bot]));
    expect(s.targets.bot!.heightScale).toBeLessThanOrEqual(0.4);
    s.tick = 120; tickEffects(s, context([bot]));
    expect(s.targets.bot!.phase).toBe("heap");
    expect(s.targets.bot!.heightScale).toBeLessThanOrEqual(0.4);
    expect(s.targets.bot!.puddle).toBe(true);
    applyRust(s, bot, 100, "p1", true);
    s.tick = 121; tickEffects(s, context([bot]));
    expect(s.events.filter(event => event.kind === "robot.seized")).toHaveLength(1);
    expect(s.events.filter(event => event.kind === "robot.heap")).toHaveLength(1);
  });

  it("disables empty robotaxis without shrinking them and protects occupied robotaxis", () => {
    const s = state();
    const empty = actor({ model: "robotaxi", speed: 25 });
    applyRust(s, empty, 100, "p1", true);
    s.tick = 120; tickEffects(s, context([empty]));
    expect(s.targets.bot!.phase).toBe("disabled");
    expect(s.targets.bot!.heightScale).toBe(1);
    expect(s.targets.bot!.puddle).toBe(false);
    expect(s.events.some(event => event.kind === "robot.pull-over")).toBe(true);
    const occupied = actor({ id: "occupied", model: "robotaxi", firmware: "good", occupied: true, speed: 25 });
    for (let n = 0; n < 50; n++) applyRust(s, occupied, 1, "p1", true);
    expect(s.targets.occupied!.rust).toBeLessThan(0.3);
    expect(s.targets.occupied!.phase).toBe("active");
    expect(s.events.filter(event => event.targetId === "occupied" && event.kind === "robot.pull-over")).toHaveLength(1);
    expect(s.events.some(event => event.targetId === "occupied" && event.kind === "economy.penalty")).toBe(false);
  });

  it("clears a heap only when outside every player's fidelity radius", () => {
    const s = state();
    const bot = actor({ x: 400, z: 0 });
    applyRust(s, bot, 10, "p1", true);
    s.tick = 120;
    const near = player({ id: "p2", x: 390 });
    tickEffects(s, context([bot], player(), { players: [player(), near] }));
    expect(s.targets.bot!.phase).toBe("heap");
    s.tick += 1; tickEffects(s, context([bot]));
    expect(s.targets.bot!.phase).toBe("cleared");
    expect(s.targets.bot!.heightScale).toBe(0);
    expect(s.targets.bot!.puddle).toBe(false);
    expect(s.targets.bot!.movementScale).toBe(0);
    expect(s.events.at(-1)?.kind).toBe("robot.heap-cleared");
    // Context snapshots may retain the actor for a few ticks after its removal event.
    for (let n = 0; n < 2; n++) {
      s.tick += 1;
      tickEffects(s, context([bot], player(), { wave: 3, night: true, fog: 0.8, rain: 1 }));
      applyWaterHit(s, bot, water());
    }
    expect(s.targets.bot!.phase).toBe("cleared");
    expect(s.targets.bot!.heightScale).toBe(0);
    expect(s.events.filter(event => event.kind === "robot.heap-cleared")).toHaveLength(1);
    expect(s.events.filter(event => event.kind === "robot.seized")).toHaveLength(1);
  });

  it("gates ambient rust by wave, darkness, exposure, and firmware", () => {
    const p = player();
    const bad = actor(), pursuing = actor({ id: "chasing", pursuing: true }), sheltered = actor({ id: "roofed", sheltered: true }), good = actor({ id: "good", firmware: "good" });
    const ctx = context([bad, pursuing, sheltered, good], p, { wave: 3, night: true, fog: 0.8 });
    const s = state(p);
    tickEffects(s, { ...ctx, wave: 2 });
    expect(s.targets).toEqual({});
    for (let n = 0; n < 60; n++) { s.tick += 1; tickEffects(s, ctx); }
    expect(s.targets.bot!.rust).toBeCloseTo(0.01, 12);
    expect(s.targets.chasing!.rust).toBeCloseTo(0.03, 12);
    expect(s.targets.roofed).toBeUndefined();
    expect(s.targets.good).toBeUndefined();
    const rain = state();
    for (let n = 0; n < 60; n++) { rain.tick += 1; tickEffects(rain, { ...ctx, night: false, rain: 1 }); }
    expect(rain.targets.bot!.rust).toBeCloseTo(EFFECTS.rainRustPerSecond, 12);
  });
});

describe("protected targets and wrong-target consequences", () => {
  it("requires three impacts within two seconds and penalizes once per wet episode", () => {
    const s = state();
    const adult = actor({ kind: "person", firmware: "none", model: undefined, posture: "standing" });
    applyWaterHit(s, adult, water());
    s.tick = 60; applyWaterHit(s, adult, water());
    expect(s.events).toEqual([]);
    s.tick = 120; applyWaterHit(s, adult, water());
    expect(s.targets.bot!.wetUntil).toBe(120 + EFFECTS.wetDuration);
    expect(s.events.filter(event => event.kind === "economy.penalty")).toMatchObject([{ amount: 20, detail: "reputation:-3" }]);
    for (let n = 0; n < 100; n++) applyWaterHit(s, adult, water());
    expect(s.events.filter(event => event.kind === "person.wet")).toHaveLength(1);
    s.tick = 120 + EFFECTS.wetDuration;
    for (let n = 0; n < 3; n++) applyWaterHit(s, adult, water());
    expect(s.events.filter(event => event.kind === "person.wet")).toHaveLength(2);
  });

  it("does not accumulate impacts outside the rolling time span or from vehicles", () => {
    const adult = actor({ kind: "person", firmware: "none", model: undefined });
    const s = state();
    for (let n = 0; n < 3; n++) { s.tick = n * 121; applyWaterHit(s, adult, water()); }
    expect(s.events).toEqual([]);
    for (let n = 0; n < 100; n++) applyWaterHit(s, adult, water({ vehicle: true }));
    expect(s.targets.bot!.wetUntil).toBe(0);
  });

  it("seeded protected-subject fuzz never adds rust, wet state or a penalty", () => {
    const protectedKinds: Partial<CombatActor>[] = [
      { kind: "animal" }, { kind: "person", child: true }, { kind: "person", mobilityAid: true },
      { kind: "person", posture: "seated" }, { kind: "person", posture: "lying" },
      { kind: "player", robotBody: false },
    ];
    for (let seed = 1; seed <= 50; seed++) {
      const s = state(player(), seed);
      let rng = seedRng(seed);
      for (const [index, kind] of protectedKinds.entries()) {
        const subject = freeze(actor({ ...kind, id: `safe-${index}` }));
        for (let n = 0; n < 20; n++) {
          const [roll, next] = nextFloat(rng); rng = next;
          s.tick += 1;
          applyWaterHit(s, subject, water({ vehicle: roll > 0.5, salt: roll > 0.2, rustRate: roll * 100 }));
          applyRust(s, subject, roll * 100, "p1", true);
        }
      }
      expect(s.targets).toEqual({});
      expect(s.events).toEqual([]);
    }
  });

  it("permits water on teleoperated robot bodies without wetting a human avatar", () => {
    const s = state();
    const controlledRobot = actor({ kind: "player", robotBody: true, playerId: "p2" });
    applyWaterHit(s, controlledRobot, water());
    expect(s.targets.bot!.rust).toBeGreaterThan(0);
    expect(s.targets.bot!.wetUntil).toBe(0);
  });
});

describe("refills and support", () => {
  const source: RefillSource = { id: "tap", kind: "hydrant", x: 0, y: 0, z: 0, radius: 3, salt: false };

  it.each([["hydrant", 120], ["fountain", 120], ["bay", 180], ["puddle", 240]] as const)("%s completes on its prescribed tick and replaces water type", (kind, ticks) => {
    const p = player();
    const s = state(p); s.players.p1!.water = 0; s.players.p1!.balloons = 0; s.players.p1!.salt = kind !== "bay";
    const ctx = freeze(context([], p, { refills: [{ ...source, kind }] }));
    advanceSupport(s, ctx, { refill: "tap" }, ticks - 1);
    expect(s.players.p1!.water).toBe(0);
    advanceSupport(s, ctx, { refill: "tap" }, 1);
    expect(s.players.p1!.water).toBe(8);
    expect(s.players.p1!.salt).toBe(kind === "bay");
    expect(s.players.p1!.balloons).toBe(2);
    expect(s.events.filter(event => event.kind === "refill.complete")).toHaveLength(1);
  });

  it("cancels a refill when input, source range or stopped condition is lost", () => {
    const p = player(), s = state(p), ctx = context([], p, { refills: [source] });
    s.players.p1!.water = 0;
    advanceSupport(s, ctx, { refill: "tap" }, 80);
    advanceSupport(s, ctx, {}, 1);
    expect(s.players.p1!.refillTicks).toBe(0);
    advanceSupport(s, ctx, { refill: "tap" }, 80);
    advanceSupport(s, { ...ctx, players: [player({ speed: 3.01 })] }, { refill: "tap" }, 1);
    expect(s.players.p1!.refillTicks).toBe(0);
    advanceSupport(s, ctx, { refill: "tap" }, 80);
    advanceSupport(s, { ...ctx, players: [player({ x: 3.01 })] }, { refill: "tap" }, 1);
    expect(s.players.p1!.refillTicks).toBe(0);
    expect(s.players.p1!.water).toBe(0);
  });

  it("cannot refill from another floor despite matching horizontal coordinates", () => {
    const p = player();
    const s = state(p); s.players.p1!.water = 0;
    const upperFloor = { ...source, y: 100 };
    advanceSupport(s, context([], p, { refills: [upperFloor] }), { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(0);
    expect(s.players.p1!.refillTicks).toBe(0);
    const justOutside = { ...source, y: 3.01 };
    advanceSupport(s, context([], p, { refills: [justOutside] }), { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(0);
    advanceSupport(s, context([], p, { refills: [{ ...source, y: 3 }] }), { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(8);
  });

  it("applies tier capacities and the two refill perks", () => {
    const p = player({ tankTier: 2, perks: ["lean", "whisperer"] });
    const s = state(p); s.players.p1!.water = 0;
    advanceSupport(s, context([], p, { refills: [source] }), { refill: "tap" }, 60);
    expect(s.players.p1!.water).toBe(14);
    const salty = player({ perks: ["brackish"] });
    const t = state(salty); t.players.p1!.water = 0;
    advanceSupport(t, context([], salty, { refills: [{ ...source, kind: "bay" }] }), { refill: "tap" }, 90);
    expect(t.players.p1!.water).toBe(8);
    expect(t.players.p1!.salt).toBe(true);
  });

  it("conserves the 20-litre trunk reserve and rejects another player's trunk", () => {
    const p = player({ trunk: true });
    const s = state(p); s.players.p1!.water = 0;
    const ctx = context([], p, { refills: [{ ...source, kind: "trunk", ownerId: "p1" }] });
    advanceSupport(s, ctx, { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(8); expect(s.players.p1!.reserve).toBe(12);
    s.players.p1!.water = 0;
    advanceSupport(s, ctx, { refill: "tap" }, 120);
    expect(s.players.p1!.reserve).toBe(4);
    s.players.p1!.water = 0;
    advanceSupport(s, ctx, { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(4); expect(s.players.p1!.reserve).toBe(0);
    s.players.p1!.water = 0;
    advanceSupport(s, { ...ctx, refills: [{ ...source, kind: "trunk", ownerId: "p2" }] }, { refill: "tap" }, 120);
    expect(s.players.p1!.water).toBe(0);
  });

  it("discards incompatible water atomically and consumes actual trunk supply for a type change", () => {
    const p = player({ trunk: true });
    const s = state(p);
    s.players.p1!.water = 8;
    s.players.p1!.salt = true;
    s.players.p1!.reserve = 3;
    const ctx = context([], p, { refills: [{ ...source, kind: "trunk", ownerId: "p1", salt: false }] });
    advanceSupport(s, ctx, { refill: "tap" }, 119);
    expect(s.players.p1!.water).toBe(8);
    expect(s.players.p1!.salt).toBe(true);
    expect(s.players.p1!.reserve).toBe(3);
    advanceSupport(s, ctx, { refill: "tap" }, 1);
    expect(s.players.p1!.water).toBe(3);
    expect(s.players.p1!.salt).toBe(false);
    expect(s.players.p1!.reserve).toBe(0);
    expect(s.events.at(-1)).toMatchObject({ kind: "refill.complete", amount: 3, detail: "fresh" });

    const bay = context([], p, { refills: [{ ...source, kind: "bay", salt: true }] });
    advanceSupport(s, bay, { refill: "tap" }, 180);
    expect(s.players.p1!.water).toBe(8);
    expect(s.players.p1!.salt).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ kind: "refill.complete", amount: 8, detail: "salt" });
  });

  it("restocks cones on reentry once, not on every driving tick", () => {
    const s = state(); s.players.p1!.cones = 0;
    const ctx = context([], player({ mount: "vehicle" }));
    advanceSupport(s, ctx, {}, 1);
    expect(s.players.p1!.cones).toBe(3);
    s.players.p1!.cones = 1;
    advanceSupport(s, ctx, {}, 5);
    expect(s.players.p1!.cones).toBe(1);
    expect(s.events.filter(event => event.kind === "inventory.cones")).toHaveLength(1);
  });
});

describe("scanner", () => {
  it("uses three-dimensional ranges for scanning, pings, and close-target alerts", () => {
    const high = actor({ y: 100 });
    const distant = state();
    advanceSupport(distant, context([high]), { scan: true }, 60);
    expect(distant.players.p1!.scan).toBeNull();
    expect(distant.targets).toEqual({});

    const scanned = actor({ y: 10, z: -5 });
    const above = actor({ id: "upper-floor", x: 0, y: 31, z: -1 });
    const below = actor({ id: "lower-floor", x: 0, y: -31, z: -1, firmware: "good" });
    const s = state();
    advanceSupport(s, context([scanned, above, below]), { scan: true }, 60);
    expect(s.players.p1!.scan?.targetId).toBe("bot");
    expect(s.targets.bot!.waryUntil).toBeGreaterThan(s.tick);
    expect(s.targets.bot!.alerted).toBe(false);
    expect(s.targets["upper-floor"]).toBeUndefined();
    expect(s.events.some(event => event.targetId === "lower-floor")).toBe(false);
  });

  it("normalizes huge finite aim angles without bypassing the scan cone or changing replay results", () => {
    const huge = Number.MAX_VALUE;
    const angle = huge % TAU;
    const back = actor({ x: -dsin(angle) * 10, z: dcos(angle) * 10 });
    const excluded = state();
    advanceSupport(excluded, context([back]), { scan: true, aimYaw: huge }, 60);
    expect(excluded.players.p1!.scan).toBeNull();
    const front = actor({ x: dsin(angle) * 10, z: -dcos(angle) * 10 });
    const a = state(), b = state();
    advanceSupport(a, context([front]), { scan: true, aimYaw: huge }, 60);
    advanceSupport(b, context([front]), { scan: true, aimYaw: angle }, 60);
    expect(a.players.p1!.scan?.targetId).toBe("bot");
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(() => canonicalJson(a)).not.toThrow();
  });

  it("needs sixty consecutive ticks, range, aim and clear sight", () => {
    const s = state();
    const bot = actor();
    const ctx = context([bot]);
    advanceSupport(s, ctx, { scan: true }, 59);
    expect(s.players.p1!.scan).toBeNull();
    advanceSupport(s, ctx, {}, 1);
    expect(s.players.p1!.scanTicks).toBe(0);
    advanceSupport(s, ctx, { scan: true }, 60);
    expect(s.players.p1!.scan?.targetId).toBe("bot");
    for (const blocked of [
      context([actor({ z: -25.01 })]), context([actor({ x: 5, z: 0 })]),
      context([bot], player(), { walls: [{ id: "wall", minX: -1, maxX: 1, minY: 0, maxY: 4, minZ: -3, maxZ: -2 }] }),
    ]) {
      const b = state(); advanceSupport(b, freeze(blocked), { scan: true }, 120);
      expect(b.players.p1!.scan).toBeNull();
    }
    expect(hasLineOfSight(ctx, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 })).toBe(true);
  });

  it("uses a deterministic actor-id tie-break and independent confidence randomness", () => {
    const robots = [actor({ id: "b", firmware: "good" }), actor({ id: "a" })];
    const s = state(), t = state();
    advanceSupport(s, context(robots), { scan: true }, 60);
    advanceSupport(t, context([...robots].reverse()), { scan: true }, 60);
    expect(s.players.p1!.scan?.targetId).toBe("a");
    expect(canonicalJson(s)).toBe(canonicalJson(t));
    expect(s.players.p1!.scan!.confidence).toBeGreaterThanOrEqual(85);
    expect(s.players.p1!.scan!.confidence).toBeLessThanOrEqual(99);
  });

  it("pings nearby good and bad robots, alerts only the scanned close bad robot, and honors quiet", () => {
    const robots = [actor(), actor({ id: "other", x: 10, z: -10 }), actor({ id: "good", firmware: "good", z: 20 })];
    const s = state(); advanceSupport(s, context(robots), { scan: true }, 60);
    expect(s.targets.bot!.alerted).toBe(true);
    expect(s.targets.other!.alerted).toBe(false);
    expect(s.targets.other!.waryUntil).toBe(s.tick + 600);
    expect(s.events.some(event => event.kind === "robot.glance" && event.targetId === "good")).toBe(true);
    const quiet = player({ perks: ["quiet"] }), q = state(quiet);
    advanceSupport(q, context(robots, quiet), { scan: true }, 60);
    expect(q.players.p1!.scan).not.toBeNull();
    expect(q.targets).toEqual({});
    expect(q.events.map(event => event.kind)).toEqual(["scan.result"]);
  });

  it("disables scanning while Airplane Mode is active, then permits it at expiry", () => {
    const s = state(); s.players.p1!.gear = "airplane"; s.players.p1!.gearUntil = 61;
    advanceSupport(s, context(), { scan: true }, 60);
    expect(s.players.p1!.scan).toBeNull();
    advanceSupport(s, context(), { scan: true }, 60);
    expect(s.players.p1!.scan).not.toBeNull();
  });

  it.each([1, 2, 3, 4] as const)("tier %i matches its table over ten thousand seeded scans", tier => {
    const p = player({ scannerTier: tier, perks: ["quiet"] });
    const s = state(p, 731 + tier), ctx = context([actor({ subtlety: 3 })], p);
    let correct = 0, correctConfidence = 0, wrongConfidence = 0;
    for (let n = 0; n < 10000; n++) {
      s.tick += 1; s.players.p1!.scanId = "bot"; s.players.p1!.scanTicks = 59;
      stepSupport(s, ctx, { p1: { scan: true } });
      const result = s.players.p1!.scan!;
      if (result.bad) { correct += 1; correctConfidence += result.confidence; }
      else wrongConfidence += result.confidence;
      s.events = [];
    }
    expect(Math.abs(correct / 10000 - scanAccuracy(tier, 3))).toBeLessThan(0.02);
    expect(Math.abs(correctConfidence / correct - wrongConfidence / (10000 - correct))).toBeLessThan(0.8);
    expect(scanAccuracy(tier, 1)).toBe(Math.min(1, scanAccuracy(tier, 3) + 0.1));
    expect(scanAccuracy(tier, 5)).toBeCloseTo(scanAccuracy(tier, 3) - 0.1, 12);
  });
});
