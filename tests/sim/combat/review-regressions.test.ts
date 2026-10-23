import { describe, expect, it } from "vitest";
import { applyRust, applyWaterHit } from "../../../src/sim/combat/effects.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { sightRange } from "../../../src/sim/combat/perception.ts";
import { createCombatState, movementLimit, stepCombat } from "../../../src/sim/combat/system.ts";
import { seedRng, nextFloat } from "../../../src/sim/rng.ts";
import { buildWorld, createInitialState } from "../../../src/sim/index.ts";
import type { CombatActor, CombatContext, CombatPlayer, Projectile } from "../../../src/sim/combat/types.ts";

const player: CombatPlayer = { id: "p", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 };
const actor = (id: string, extra: Partial<CombatActor> = {}): CombatActor => ({ id, kind: "robot", firmware: "bad", model: "footman", x: 0, y: 0, z: -2, heading: 0, speed: 0, radius: .5, height: 1.8, ...extra });
const context = (actors: CombatActor[], extra: Partial<CombatContext> = {}): CombatContext => ({ actors, players: [player], refills: [], walls: [], wave: 3, ...extra });
const spray: Projectile = { id: 1, kind: "water", ownerId: "p", x: 0, y: 1.2, z: 0, vx: 0, vy: 0, vz: -13, volume: .08, salt: false, vehicle: false, rustRate: .025, bornTick: 0, distance: 0, range: 12 };

describe("reviewed combat integration regressions", () => {
  it("a cone inherits a moving car's velocity and retains its relative flight budget", () => {
    const driver = { ...player, mount: "vehicle" as const, speed: 25 };
    const ctx = context([], { players: [driver] });
    const state = stepCombat(createCombatState(1, ctx), ctx, { p: { cone: true, aimYaw: Math.PI / 2 } });
    const cone = state.projectiles[0]!;
    expect(cone.vx).toBeCloseTo(8, 8);
    expect(cone.vz).toBeCloseTo(-25, 8);
    expect(cone.x).toBeCloseTo(8 / 60, 8);
    expect(cone.z).toBeCloseTo(-25 / 60, 8);
    expect(cone.range).toBeCloseTo(Math.sqrt(8 * 8 + 25 * 25), 8);
  });

  it("a cone thrown from a 25 m/s car stops a moving taxi, then releases it", () => {
    const driver = { ...player, mount: "vehicle" as const, speed: 25 };
    const taxi = actor("taxi", { model: "robotaxi", heading: Math.PI, speed: 25, z: -9, obeysTraffic: true, radius: 1.1 });
    const ctx = context([taxi], { players: [driver] });
    let state = createCombatState(1, ctx);
    let impact = -1, stopped = -1, released = -1;
    for (let tick = 0; tick < 800; tick++) {
      const cap = movementLimit(state, taxi).maxSpeed;
      taxi.speed = cap === null ? 25 : Math.min(25, cap);
      driver.z -= driver.speed / 60;
      taxi.z += taxi.speed / 60;
      state = stepCombat(state, ctx, { p: { cone: tick === 0 } });
      if (state.events.some(event => event.kind === "vehicle.pull-over")) impact = state.tick;
      if (impact >= 0 && movementLimit(state, taxi).maxSpeed === 0 && stopped < 0) stopped = state.tick;
      if (stopped >= 0 && movementLimit(state, taxi).maxSpeed === null) { released = state.tick; break; }
    }
    expect(impact).toBeGreaterThan(0);
    expect(impact).toBeLessThan(60);
    expect(stopped).toBe(impact + 180);
    expect(released).toBe(impact + 600);
    expect(state.targets.taxi).toMatchObject({ pullOverTick: 0, pullOverSpeed: 0, stoppedUntil: 0 });
    expect(movementLimit(state, taxi)).toMatchObject({ maxSpeed: null, scale: 1, canAttack: true });
  });

  it("a rusted empty taxi decelerates before staying disabled", () => {
    const taxi = actor("taxi", { model: "robotaxi", speed: 25 });
    const ctx = context([taxi]);
    const state = createCombatState(1, ctx);
    applyRust(state, taxi, 10, "p", true);
    expect(movementLimit(state, taxi)).toMatchObject({ maxSpeed: 25, scale: 1, canAttack: false });
    state.tick = 90;
    expect(movementLimit(state, taxi)).toMatchObject({ maxSpeed: 12.5, scale: 1, canAttack: false });
    state.tick = 180;
    expect(movementLimit(state, taxi)).toMatchObject({ maxSpeed: 0, scale: 0, canAttack: false });
  });

  it("rain and local fog do not cancel a phone hack; direct spray does", () => {
    const bot = actor("hacker");
    const ctx = context([bot], { night: true, rain: 1, fogAt: () => .9, attacks: [{ id: "hack", sequence: 1, attackerId: bot.id, targetId: player.id, kind: "phone-hack" }] });
    let state = createCombatState(2, ctx);
    let started = false;
    for (let tick = 0; tick < 45; tick++) {
      state = stepCombat(state, ctx);
      started ||= state.events.some(event => event.kind === "player.phone-hack" && event.amount === 1);
      expect(state.events.some(event => event.kind === "attack.cancelled")).toBe(false);
    }
    expect(started).toBe(true);
    expect(state.targets.hacker!.rust).toBeGreaterThan(0);
    expect(state.attacks[0]?.active).toBe(true);
    applyWaterHit(state, bot, spray);
    state = stepCombat(state, ctx);
    expect(state.attacks).toEqual([]);
    expect(state.events.some(event => event.kind === "attack.cancelled" && event.detail === "phone-hack:interrupted")).toBe(true);
  });

  it("uses each actor's local fog for exposure and visibility", () => {
    const foggy = actor("foggy", { x: -100 }), clear = actor("clear", { x: 100 });
    const ctx = context([foggy, clear], { night: true, fog: .9, fogAt: x => x < 0 ? .9 : 0 });
    let state = createCombatState(3, ctx);
    for (let tick = 0; tick < 60; tick++) state = stepCombat(state, ctx);
    expect(state.targets.foggy!.rust).toBeCloseTo(.01, 10);
    expect(state.targets.clear!.rust).toBe(0);
    expect(sightRange(state, ctx, foggy)).toBeCloseTo(13.8, 10);
    expect(sightRange(state, ctx, clear)).toBe(30);
    const world = buildWorld([]);
    const adapted = contextFromState(world, createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 }), { fogAt: ctx.fogAt });
    expect(adapted.fogAt?.(-100, 0)).toBe(.9);
    expect(adapted.fogAt?.(100, 0)).toBe(0);
  });

  it("permits a local forced update without a separately supplied cap", () => {
    const ctx = context([actor("bad"), actor("helper", { firmware: "good", z: -3 })], { attacks: [{ id: "update", sequence: 1, attackerId: "bad", targetId: "helper", kind: "forced-update" }] });
    let state = createCombatState(4, ctx), converted = false;
    for (let tick = 0; tick < 365; tick++) {
      state = stepCombat(state, ctx);
      converted ||= state.events.some(event => event.kind === "robot.converted" && event.targetId === "helper");
    }
    expect(converted).toBe(true);
  });

  it("protects varied people and animals in seeded crowds through the real particle reducer", () => {
    let rng = seedRng(5150);
    const random = () => { const result = nextFloat(rng); rng = result[1]; return result[0]; };
    for (let scene = 0; scene < 40; scene++) {
      const yaw = random() * Math.PI * 2, pitch = (random() - .5) * .2;
      const origin = { ...player, x: random() * 40 - 20, z: random() * 40 - 20 };
      const forward = { x: Math.sin(yaw), z: -Math.cos(yaw) };
      const protectedBody = actor("protected", { kind: scene % 5 === 0 ? "animal" : "person", firmware: "none", x: origin.x + forward.x * 2, z: origin.z + forward.z * 2, radius: .5 + random() * .4, height: 2.5, child: scene % 5 === 1, posture: scene % 5 === 2 ? "seated" : scene % 5 === 3 ? "lying" : "standing", mobilityAid: scene % 5 === 4 });
      const behind = actor("behind", { x: origin.x + forward.x * 4, z: origin.z + forward.z * 4 });
      const crowd = Array.from({ length: 5 }, (_, i) => {
        const along = random() * 20 - 10, side = (i % 2 ? -1 : 1) * (3 + random() * 7);
        return actor(`crowd-${i}`, { kind: "person", firmware: "none", protected: true, x: origin.x + forward.x * along + forward.z * side, z: origin.z + forward.z * along - forward.x * side });
      });
      const ctx = context([protectedBody, behind, ...crowd], { players: [origin] });
      let state = createCombatState(scene, ctx), interceptions = 0;
      for (let tick = 0; tick < 90; tick++) {
        state = stepCombat(state, ctx, { p: { fire: true, aimYaw: yaw, aimPitch: pitch } });
        interceptions += state.events.filter(event => event.kind === "projectile.ended" && event.targetId === "protected").length;
        expect(state.events.some(event => event.targetId === "protected" && ["person.wet", "economy.penalty"].includes(event.kind))).toBe(false);
      }
      expect(interceptions).toBeGreaterThan(0);
      expect(state.targets.protected).toMatchObject({ rust: 0, wetUntil: 0 });
      expect(state.targets.behind!.rust).toBe(0);
    }
  });
});
