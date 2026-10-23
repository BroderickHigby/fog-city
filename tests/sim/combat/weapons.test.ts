import { describe, expect, it } from "vitest";
import { PI, wrapAngle } from "../../../src/sim/dmath.ts";
import { initialPlayer, initialTarget } from "../../../src/sim/combat/shared.ts";
import type { CombatContext, CombatPlayer, CombatState, PlayerCombat } from "../../../src/sim/combat/types.ts";
import { waterShot } from "../../../src/sim/combat/weapons.ts";

function player(patch: Partial<CombatPlayer> = {}): CombatPlayer {
  return { id: "p1", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1, ...patch };
}
function state(p: CombatPlayer, patch: Partial<PlayerCombat> = {}): CombatState {
  return { version: 1, tick: 10, rng: [1, 2, 3, 4], nextId: 1, players: { [p.id]: { ...initialPlayer(p), ...patch } },
    targets: {}, projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: 0 };
}
function context(p: CombatPlayer, patch: Partial<CombatContext> = {}): CombatContext {
  return { actors: [], players: [p], walls: [], refills: [], ...patch };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

describe("water weapon configuration", () => {
  it("keeps the starting foot blaster at ten particles per second and advertised flow", () => {
    const p = player();
    const shot = waterShot(state(p), p, { fire: true, aimPitch: 0 }, context(p))!;
    expect(shot).toMatchObject({ speed: 13, range: 12, volume: 0.08, rustRate: 0.025, rateTicks: 6,
      spawnHeight: 1.2, supply: "water", salt: false, vehicle: false });
    expect(shot.direction.x).toBeCloseTo(0, 8);
    expect(shot.direction.y).toBeCloseTo(0, 8);
    expect(shot.direction.z).toBeCloseTo(-1, 8);
    expect(shot.volume * 60 / shot.rateTicks).toBeCloseTo(0.8, 12);
  });

  it("applies the flow tier and pressure nozzle without changing cadence", () => {
    const p = player({ flowTier: 1, nozzle: "pressure" });
    const shot = waterShot(state(p), p, { fire: true }, context(p))!;
    expect(shot).toMatchObject({ speed: 16, range: 18, volume: 0.12, rustRate: 0.035, rateTicks: 6 });
  });

  it.each(["vehicle", "running-board", "roof"] as const)("rejects %s water fire in the default wave two", mount => {
    const p = player({ mount, trunk: true, roofCannon: true });
    expect(waterShot(state(p), p, { fire: true }, context(p))).toBeNull();
  });

  it("reduces driver flow and rust proportionally and fixes the sideward range", () => {
    const p = player({ mount: "vehicle", speed: 7, nozzle: "pressure" });
    const shot = waterShot(state(p), p, { fire: true, aimYaw: 0, aimPitch: 0 }, context(p, { wave: 3 }))!;
    expect(shot).toMatchObject({ range: 8, volume: 0.048, rustRate: 0.015, supply: "water", vehicle: true });
    expect(shot.yaw).toBeCloseTo(PI / 2, 12);
    expect(shot.direction.x).toBeCloseTo(1, 8);
    expect(shot.direction.z).toBeCloseTo(0, 8);
    expect(shot.volume * 10).toBeCloseTo(0.8 * 0.6, 12);
  });

  it.each([7.000001, -7.000001, 40, -40])("rejects driver water at speed %s", speed => {
    const p = player({ mount: "vehicle", speed });
    expect(waterShot(state(p), p, { fire: true }, context(p, { wave: 3 }))).toBeNull();
  });

  it.each([7, -7, 0])("allows driver water at speed %s", speed => {
    const p = player({ mount: "vehicle", speed });
    expect(waterShot(state(p), p, { fire: true }, context(p, { wave: 3 }))).not.toBeNull();
  });

  it("chooses the closest side across the heading wrap boundary", () => {
    const p = player({ mount: "vehicle", heading: PI - 0.1 });
    const right = waterShot(state(p), p, { fire: true, aimYaw: -PI + 0.1 }, context(p, { wave: 3 }))!;
    const left = waterShot(state(p), p, { fire: true, aimYaw: PI - 0.2 }, context(p, { wave: 3 }))!;
    expect(wrapAngle(right.yaw - p.heading)).toBeCloseTo(PI / 2, 12);
    expect(wrapAngle(left.yaw - p.heading)).toBeCloseTo(-PI / 2, 12);
  });

  it("provides full flow on a running board regardless of vehicle speed", () => {
    const p = player({ mount: "running-board", speed: 20, flowTier: 1, nozzle: "pressure" });
    const shot = waterShot(state(p), p, { fire: true, aimYaw: -1 }, context(p, { wave: 3 }))!;
    expect(shot).toMatchObject({ range: 18, volume: 0.12, rustRate: 0.035, supply: "water", vehicle: true });
    expect(shot.yaw).toBeCloseTo(-1, 12);
  });

  it("requires both the owned roof cannon and trunk supply in wave four", () => {
    for (const patch of [{ trunk: false, roofCannon: true }, { trunk: true, roofCannon: false }, { trunk: true }]) {
      const p = player({ mount: "roof", ...patch });
      expect(waterShot(state(p, { reserve: 20 }), p, { fire: true }, context(p, { wave: 4 }))).toBeNull();
    }
    const p = player({ mount: "roof", trunk: true, roofCannon: true });
    expect(waterShot(state(p), p, { fire: true }, context(p, { wave: 3 }))).toBeNull();
    expect(waterShot(state(p, { reserve: 0 }), p, { fire: true }, context(p, { wave: 4 }))).toBeNull();
  });

  it("fires the roof cannon at any speed with half rust and fresh trunk water", () => {
    const p = player({ mount: "roof", trunk: true, roofCannon: true, speed: 38, y: 12 });
    const s = state(p, { water: 0, reserve: 1, salt: true });
    const shot = waterShot(s, p, { fire: true }, context(p, { wave: 4 }))!;
    expect(shot).toMatchObject({ range: 15, volume: 0.08, rustRate: 0.0125, supply: "reserve", salt: false,
      spawnHeight: 14, vehicle: true });
  });

  it("clamps roof aim to a total thirty-degree forward arc, including wrapped headings", () => {
    const p = player({ mount: "roof", trunk: true, roofCannon: true, heading: PI - 0.1 });
    const s = state(p);
    const ctx = context(p, { wave: 4 });
    const right = waterShot(s, p, { fire: true, aimYaw: p.heading + 2 }, ctx)!;
    const left = waterShot(s, p, { fire: true, aimYaw: p.heading - 2 }, ctx)!;
    const inside = waterShot(s, p, { fire: true, aimYaw: -PI + 0.05 }, ctx)!;
    expect(wrapAngle(right.yaw - p.heading)).toBeCloseTo(PI / 12, 12);
    expect(wrapAngle(left.yaw - p.heading)).toBeCloseTo(-PI / 12, 12);
    expect(wrapAngle(inside.yaw - p.heading)).toBeCloseTo(0.15, 12);
  });

  it("respects firing, refill, cooldown and global pause gates", () => {
    const p = player();
    const s = state(p);
    const ctx = context(p);
    expect(waterShot(s, p, {}, ctx)).toBeNull();
    expect(waterShot(s, p, { fire: true, refill: "hydrant" }, ctx)).toBeNull();
    expect(waterShot(state(p, { nextWaterTick: 11 }), p, { fire: true }, ctx)).toBeNull();
    expect(waterShot({ ...s, pauseUntil: 11 }, p, { fire: true }, ctx)).toBeNull();
    expect(waterShot(state(p, { nextWaterTick: 10 }), p, { fire: true }, ctx)).not.toBeNull();
    expect(waterShot({ ...s, pauseUntil: 10 }, p, { fire: true }, ctx)).not.toBeNull();
  });

  it("checks the correct supply without modifying either tank", () => {
    const p = player();
    expect(waterShot(state(p, { water: 0.079, reserve: 20 }), p, { fire: true }, context(p))).toBeNull();
    const roof = player({ mount: "roof", trunk: true, roofCannon: true });
    expect(waterShot(state(roof, { water: 8, reserve: 0.079 }), roof, { fire: true }, context(roof, { wave: 4 }))).toBeNull();
  });

  it("honours the flower distraction on an aliased player body", () => {
    const p = player();
    const s = state(p);
    s.targets["body:p1"] = { ...initialTarget(), distractedUntil: 20 };
    const ctx = context(p, { actors: [{ id: "body:p1", playerId: p.id, kind: "player", x: 0, y: 0, z: 0,
      heading: 0, speed: 0, radius: 0.3, height: 1.8, firmware: "none" }] });
    expect(waterShot(s, p, { fire: true }, ctx)).toBeNull();
  });

  it("uses active pressure and salt boosts without applying expired or future-wave upgrades", () => {
    const p = player({ nozzle: "pressure" });
    const pressure = state(p, { boost: "pressure", boostUntil: 20 });
    expect(waterShot(pressure, p, { fire: true }, context(p, { wave: 4 }))?.range).toBe(27);
    expect(waterShot(pressure, p, { fire: true }, context(p, { wave: 3 }))?.range).toBe(18);
    expect(waterShot(state(p, { boost: "pressure", boostUntil: 10 }), p, { fire: true }, context(p, { wave: 4 }))?.range).toBe(18);
    expect(waterShot(state(p, { boost: "salt", boostUntil: 20 }), p, { fire: true }, context(p, { wave: 4 }))?.salt).toBe(true);
  });

  it("bounds nonfinite or enormous input aim without nonfinite direction components", () => {
    const p = player({ heading: PI - 0.01 });
    for (const angle of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const shot = waterShot(state(p), p, { fire: true, aimYaw: angle, aimPitch: angle }, context(p))!;
      expect([shot.yaw, shot.pitch, shot.direction.x, shot.direction.y, shot.direction.z].every(Number.isFinite)).toBe(true);
      expect(Math.abs(shot.pitch)).toBeLessThanOrEqual(1.2);
    }
  });

  it("is repeatable and leaves frozen state, input and context untouched", () => {
    const p = freeze(player({ mount: "vehicle", heading: 2.4 }));
    const s = freeze(state(p));
    const ctx = freeze(context(p, { wave: 3 }));
    const input = freeze({ fire: true, aimYaw: -2.5 });
    const before = JSON.stringify({ s, p, ctx, input });
    const first = waterShot(s, p, input, ctx);
    expect(waterShot(s, p, input, ctx)).toEqual(first);
    expect(JSON.stringify({ s, p, ctx, input })).toBe(before);
  });
});
