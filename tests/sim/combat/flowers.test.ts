import { describe, expect, it } from "vitest";
import { seedRng } from "../../../src/sim/rng.ts";
import { applyFlowerHit, FLOWER_EVENT, FLOWERS_UNTIL_MATCH_RESET, FLOWER_TUNING, launchFlowers } from "../../../src/sim/combat/flowers.ts";
import { advanceProjectile } from "../../../src/sim/combat/physics.ts";
import { initialPlayer, initialTarget, MAX_PROJECTILES } from "../../../src/sim/combat/shared.ts";
import type { CombatActor, CombatContext, CombatPlayer, CombatState, Projectile } from "../../../src/sim/combat/types.ts";

function player(id: string, z = 0): CombatPlayer {
  return { id, x: 0, y: 0, z, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 };
}
function body(id: string, overrides: Partial<CombatActor> = {}): CombatActor {
  return { id: `body:${id}`, playerId: id, kind: "player", firmware: "none", x: 0, y: 0, z: -5, radius: 0.35, height: 1.8, heading: 0, speed: 0, ...overrides };
}
function context(overrides: Partial<CombatContext> = {}): CombatContext {
  return { wave: 5, mode: "clean-streets", players: [player("p"), player("r", -5), player("mate", -6)],
    actors: [body("p", { z: 0 }), body("r"), body("mate", { z: -6 })], walls: [], refills: [],
    rivalPlayerIds: { p: ["r"], r: ["p"] }, ...overrides };
}
function fresh(ctx: CombatContext): CombatState {
  return { version: 1, tick: 0, rng: seedRng(7), nextId: 1,
    players: Object.fromEntries(ctx.players.map(p => [p.id, initialPlayer(p)])),
    targets: Object.fromEntries(ctx.actors.map(actor => [actor.id, initialTarget()])),
    projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: 0 };
}
function flower(overrides: Partial<Projectile> = {}): Projectile {
  return { id: 1, kind: "flower", ownerId: "p", x: 0, y: 1.35, z: 0,
    vx: 0, vy: 0, vz: -12, distance: 0, range: 20, bornTick: 0, volume: 0, salt: false, vehicle: false, rustRate: 0, ...overrides };
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

describe("PvP flower alt-fire", () => {
  it("requires wave 5, an explicit PvP mode, and at least one authorized present rival", () => {
    for (const ctx of [
      context({ wave: 4 }), context({ mode: "free-roam" }), context({ mode: undefined }),
      context({ rivalPlayerIds: undefined }), context({ rivalPlayerIds: {} }),
      context({ rivalPlayerIds: { p: [] } }), context({ rivalPlayerIds: { p: ["p"] } }),
      context({ rivalPlayerIds: { p: ["missing"] } }),
    ]) {
      const state = fresh(ctx); launchFlowers(state, ctx, { p: { altFire: true } });
      expect(state.projectiles).toEqual([]);
      expect(state.players.p!.nextFlowerTick).toBe(0);
    }
  });

  it("launches one slow lob every 90 ticks without consuming water or reserve", () => {
    const ctx = frozen(context()), state = fresh(ctx);
    const water = state.players.p!.water, reserve = state.players.p!.reserve;
    launchFlowers(state, ctx, { p: { altFire: true } });
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0]).toMatchObject({ kind: "flower", range: 20, volume: 0, rustRate: 0, salt: false });
    expect(state.projectiles[0]!.vy).toBeGreaterThan(0);
    expect(Math.hypot(state.projectiles[0]!.vx, state.projectiles[0]!.vz)).toBeCloseTo(12, 8);
    state.tick = 89; launchFlowers(state, ctx, { p: { altFire: true } }); expect(state.projectiles).toHaveLength(1);
    state.tick = 90; launchFlowers(state, ctx, { p: { altFire: true } }); expect(state.projectiles).toHaveLength(2);
    expect(state.players.p!.water).toBe(water);
    expect(state.players.p!.reserve).toBe(reserve);
  });

  it("bounds finite and malformed aim inputs and does not spend cooldown when the pool is full", () => {
    for (const [aimYaw, aimPitch] of [[NaN, Infinity], [1e300, -1e300], [0, 1e300]]) {
      const ctx = context(), state = fresh(ctx);
      launchFlowers(state, ctx, { p: { altFire: true, aimYaw, aimPitch } });
      const shot = state.projectiles[0]!;
      expect([shot.x, shot.y, shot.z, shot.vx, shot.vy, shot.vz].every(Number.isFinite)).toBe(true);
    }
    const ctx = context(), state = fresh(ctx);
    state.projectiles = Array.from({ length: MAX_PROJECTILES }, (_, id) => flower({ id }));
    launchFlowers(state, ctx, { p: { altFire: true } });
    expect(state.players.p!.nextFlowerTick).toBe(0);
    state.projectiles.pop(); launchFlowers(state, ctx, { p: { altFire: true } });
    expect(state.projectiles).toHaveLength(MAX_PROJECTILES);
    expect(state.players.p!.nextFlowerTick).toBe(90);
  });

  it("puts flowers in rival hair and applies only the Clean Streets distraction and score", () => {
    const ctx = frozen(context()), state = fresh(ctx);
    state.tick = 100;
    const before = { ...state.targets["body:r"]! };
    const snapshot = JSON.stringify(ctx);
    applyFlowerHit(state, ctx, flower(), ctx.actors[1]!);
    expect(state.targets["body:r"]!.flowersUntil).toBe(FLOWERS_UNTIL_MATCH_RESET);
    expect(state.targets.r!.flowersUntil).toBe(FLOWERS_UNTIL_MATCH_RESET);
    expect(state.targets.r!.distractedUntil).toBe(190);
    expect(state.targets["body:r"]).toMatchObject({ rust: before.rust, phase: before.phase, movementScale: before.movementScale,
      stoppedUntil: before.stoppedUntil, slowUntil: before.slowUntil, heightScale: before.heightScale });
    expect(state.events.filter(event => event.kind === FLOWER_EVENT.score)).toMatchObject([{ sourceId: "p", targetId: "p", amount: 25 }]);
    expect(state.events.some(event => event.kind === FLOWER_EVENT.runway)).toBe(false);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });

  it("emits Royale runway loss and score without directly mutating health or rust", () => {
    const ctx = context({ mode: "fog-royale" }), state = fresh(ctx);
    applyFlowerHit(state, ctx, flower(), ctx.actors[1]!);
    expect(state.events.filter(event => event.kind === FLOWER_EVENT.runway)).toMatchObject([{ targetId: "r", amount: -1 }]);
    expect(state.events.filter(event => event.kind === FLOWER_EVENT.score)).toMatchObject([{ targetId: "p", amount: 150 }]);
    expect(state.targets.r!.rust).toBe(0);
    expect(state.targets.r!.distractedUntil).toBe(0);
    expect(state.targets.r!.stoppedUntil).toBe(0);
  });

  it("leaves unspecified PvP scoring to its mode lane", () => {
    const ctx = context({ mode: "other-pvp" }), state = fresh(ctx);
    applyFlowerHit(state, ctx, flower(), ctx.actors[1]!);
    expect(state.events.some(event => event.kind === FLOWER_EVENT.hit)).toBe(true);
    expect(state.events.some(event => event.kind === FLOWER_EVENT.runway || event.kind === FLOWER_EVENT.score)).toBe(false);
  });

  it("never affects teammates, self, NPCs, or unknown player bodies", () => {
    const ctx = context();
    for (const actor of [
      ctx.actors[0]!, ctx.actors[2]!, body("missing"),
      body("r", { kind: "person", child: true }), body("r", { kind: "animal" }),
      body("r", { kind: "robot", firmware: "bad", robotBody: true }),
    ]) {
      const state = fresh(ctx); applyFlowerHit(state, ctx, flower(), actor);
      expect(state.events).toEqual([]);
      expect(state.targets["body:r"]!.flowersUntil).toBe(0);
    }
  });

  it("revalidates mode and rival assignments at impact after a mid-flight transition", () => {
    const ctx = context(), state = fresh(ctx);
    launchFlowers(state, ctx, { p: { altFire: true } });
    const shot = state.projectiles[0]!;
    state.events = [];
    applyFlowerHit(state, { ...ctx, rivalPlayerIds: { p: [] } }, shot, ctx.actors[1]!);
    applyFlowerHit(state, { ...ctx, mode: "free-roam" }, shot, ctx.actors[1]!);
    applyFlowerHit(state, { ...ctx, wave: 4 }, shot, ctx.actors[1]!);
    expect(state.events).toEqual([]);
  });

  it("rejects non-flower impacts, out-of-range metadata, and unavailable target phases", () => {
    const ctx = context();
    for (const shot of [flower({ kind: "water" }), flower({ distance: 20.1 }), flower({ distance: NaN })]) {
      const state = fresh(ctx); applyFlowerHit(state, ctx, shot, ctx.actors[1]!); expect(state.events).toEqual([]);
    }
    const state = fresh(ctx); state.targets["body:r"]!.phase = "disabled";
    applyFlowerHit(state, ctx, flower(), ctx.actors[1]!); expect(state.events).toEqual([]);
  });

  it("disables flower firing during distraction and permits it at the exact expiry tick", () => {
    const ctx = context(), state = fresh(ctx);
    state.targets["body:p"]!.distractedUntil = FLOWER_TUNING.distractionTicks;
    state.tick = 89; launchFlowers(state, ctx, { p: { altFire: true } }); expect(state.projectiles).toEqual([]);
    state.tick = 90; launchFlowers(state, ctx, { p: { altFire: true } }); expect(state.projectiles).toHaveLength(1);
  });

  it("sweeps through NPCs without striking them and clips the final segment to 20 metres", () => {
    const npc = body("npc", { kind: "person", playerId: undefined, z: -0.06, radius: 0.02 });
    const rival = body("r", { z: -0.16, radius: 0.02 });
    const ctx = context({ actors: [npc, rival] });
    expect(advanceProjectile(flower(), ctx).hit?.id).toBe(rival.id);
    const beyond = context({ actors: [body("r", { z: -20.2, radius: 0.05 })] });
    const result = advanceProjectile(flower({ z: -19.9, distance: 19.9 }), beyond);
    expect(result.hit).toBeNull();
    expect(result.expired).toBe(true);
    expect(result.projectile.distance).toBe(20);
    expect(result.projectile.z).toBeCloseTo(-20, 10);
  });

  it("can actually reach a rival near the advertised twenty-metre range with a raised aim", () => {
    const rival = body("r", { z: -19.8 });
    const ctx = context({ players: [player("p"), player("r", -19.8)], actors: [rival] });
    const state = fresh(ctx);
    launchFlowers(state, ctx, { p: { altFire: true, aimPitch: 0.59 } });
    let projectile = state.projectiles[0]!;
    let hit: CombatActor | null = null;
    for (let tick = 0; tick < 120; tick++) {
      const result = advanceProjectile(projectile, ctx);
      projectile = result.projectile;
      if (result.hit) { hit = result.hit; break; }
      if (result.blocked || result.expired || result.landed) break;
    }
    expect(hit?.id).toBe(rival.id);
    expect(projectile.distance).toBeLessThanOrEqual(20);
  });
});
