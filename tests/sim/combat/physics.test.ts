import { describe, expect, it } from "vitest";
import { advanceProjectile, lineOfSight, PROJECTILE_GRAVITY, segmentActorFraction, segmentWallFraction } from "../../../src/sim/combat/physics.ts";
import type { CombatActor, CombatContext, Projectile, Wall } from "../../../src/sim/combat/types.ts";

const DT = 1 / 60;
const levelVy = PROJECTILE_GRAVITY * DT / 2;
function shot(patch: Partial<Projectile> = {}): Projectile {
  return { id: 1, kind: "water", ownerId: "owner", x: 0, y: 1, z: 0, vx: 600, vy: levelVy, vz: 0,
    distance: 0, range: 30, bornTick: 0, volume: 0.08, salt: false, vehicle: false, rustRate: 1, ...patch };
}
function actor(id: string, x: number, patch: Partial<CombatActor> = {}): CombatActor {
  return { id, kind: "robot", x, y: 0, z: 0, radius: 0.25, height: 2, heading: 0, speed: 0, firmware: "bad", ...patch };
}
function wall(x: number, patch: Partial<Wall> = {}): Wall {
  return { id: "wall", minX: x, maxX: x + 0.001, minY: 0, maxY: 3, minZ: -2, maxZ: 2, ...patch };
}
function context(actors: CombatActor[] = [], walls: Wall[] = []): CombatContext {
  return { actors, walls, players: [], refills: [] };
}

describe("continuous combat projectile physics", () => {
  it("integrates position and gravity for exactly one tick", () => {
    const result = advanceProjectile(shot({ vx: 12, vy: 3, vz: -6 }), context());
    expect(result.projectile.x).toBeCloseTo(12 * DT, 12);
    expect(result.projectile.z).toBeCloseTo(-6 * DT, 12);
    expect(result.projectile.y).toBeCloseTo(1 + 3 * DT - PROJECTILE_GRAVITY * DT * DT / 2, 12);
    expect(result.projectile.vy).toBeCloseTo(3 - PROJECTILE_GRAVITY * DT, 12);
    expect(result.projectile.distance).toBeCloseTo(Math.sqrt(12 * 12 + 6 * 6) * DT, 12);
    expect(result.hit).toBeNull();
    expect(result.blocked || result.landed || result.expired).toBe(false);
  });

  it("intercepts a narrow actor crossed completely between tick endpoints", () => {
    const target = actor("thin", 4, { radius: 0.001 });
    const result = advanceProjectile(shot(), context([target]));
    expect(result.hit?.id).toBe("thin");
    expect(result.projectile.x).toBeCloseTo(3.999, 8);
    expect(result.projectile.distance).toBeCloseTo(3.999, 8);
  });

  it("intercepts a thin wall before a target", () => {
    const result = advanceProjectile(shot(), context([actor("behind", 6)], [wall(2)]));
    expect(result.hit).toBeNull();
    expect(result.blocked).toBe(true);
    expect(result.projectile.x).toBe(2);
    expect(result.projectile.distance).toBe(2);
  });

  it("hits a target before a more distant wall", () => {
    const result = advanceProjectile(shot(), context([actor("near", 2)], [wall(4)]));
    expect(result.hit?.id).toBe("near");
    expect(result.blocked).toBe(false);
    expect(result.projectile.x).toBeCloseTo(1.75, 10);
  });

  it("gives walls precedence over actors at the same contact point", () => {
    const result = advanceProjectile(shot(), context([actor("touching", 4.25)], [wall(4)]));
    expect(result.hit).toBeNull();
    expect(result.blocked).toBe(true);
    expect(result.projectile.x).toBe(4);
  });

  it("resolves nearest hits and overlap ties identically after input reordering", () => {
    const a = actor("a", 2);
    const b = actor("b", 2);
    const c = actor("c", 7);
    const first = advanceProjectile(shot(), context([c, b, a], [wall(9), wall(8)]));
    const second = advanceProjectile(shot(), context([a, c, b], [wall(8), wall(9)]));
    expect(first).toEqual(second);
    expect(first.hit?.id).toBe("a");
  });

  it("ignores both the owner's actor id and a separately named owner body", () => {
    const result = advanceProjectile(shot(), context([
      actor("owner", 1), actor("body", 2, { playerId: "owner", kind: "player" }), actor("target", 5),
    ]));
    expect(result.hit?.id).toBe("target");
  });

  it.each([
    { kind: "animal" as const },
    { kind: "person" as const, child: true },
    { kind: "person" as const, posture: "seated" as const },
    { kind: "person" as const, posture: "lying" as const },
    { kind: "person" as const, mobilityAid: true },
  ])("physically shields a target behind a protected subject: %j", patch => {
    const result = advanceProjectile(shot(), context([actor("behind", 6), actor("protected", 2, patch)]));
    expect(result.hit?.id).toBe("protected");
    expect(result.projectile.x).toBeCloseTo(1.75, 10);
  });

  it.each(["cone", "balloon"] as const)("also intercepts protected subjects for %s", kind => {
    const result = advanceProjectile(shot({ kind }), context([actor("protected", 3, { kind: "animal" })]));
    expect(result.hit?.id).toBe("protected");
  });

  it("water passes through founder avatars but is intercepted by a rival robot body", () => {
    const result = advanceProjectile(shot(), context([
      actor("founder", 2, { kind: "player", playerId: "other" }),
      actor("robot-player", 4, { kind: "player", playerId: "remote", robotBody: true }),
      actor("behind", 6),
    ]));
    expect(result.hit?.id).toBe("robot-player");
  });

  it.each(["cone", "balloon"] as const)("%s is removed by a founder avatar instead of passing through", kind => {
    const result = advanceProjectile(shot({ kind }), context([actor("founder", 2, { kind: "player" }), actor("behind", 6)]));
    expect(result.hit?.id).toBe("founder");
  });

  it.each([false, true])("flowers pass through NPCs and their owner to reach a rival player, robotBody=%s", robotBody => {
    const result = advanceProjectile(shot({ kind: "flower" }), context([
      actor("npc-robot", 1), actor("npc-person", 2, { kind: "person", firmware: "none" }),
      actor("npc-animal", 3, { kind: "animal", firmware: "none" }),
      actor("owner-avatar", 5, { kind: "player", playerId: "owner" }),
      actor("rival", 6, { kind: "player", playerId: "other", robotBody }),
    ]));
    expect(result.hit?.id).toBe("rival");
    expect(result.projectile.x).toBeCloseTo(5.75, 10);
  });

  it("flowers never collide with an NPC when there is no rival", () => {
    const result = advanceProjectile(shot({ kind: "flower" }), context([actor("npc", 2, { kind: "person" })]));
    expect(result.hit).toBeNull();
    expect(result.projectile.x).toBe(10);
  });

  it("clips the final segment to remaining range before finding targets or walls", () => {
    const result = advanceProjectile(shot({ distance: 4, range: 4.5 }), context([actor("beyond", 1)], [wall(0.75)]));
    expect(result.projectile.x).toBe(0.5);
    expect(result.projectile.distance).toBe(4.5);
    expect(result.expired).toBe(true);
    expect(result.hit).toBeNull();
    expect(result.blocked).toBe(false);
  });

  it("measures and clips diagonal travel horizontally without shortening an arc", () => {
    const result = advanceProjectile(shot({ vx: 180, vz: 240, vy: 90, range: 2.5 }), context());
    expect(result.projectile.distance).toBe(2.5);
    expect(result.projectile.x).toBeCloseTo(1.5, 12);
    expect(result.projectile.z).toBeCloseTo(2, 12);
    expect(result.projectile.y).toBeGreaterThan(1.7);
    expect(result.expired).toBe(true);
  });

  it("does not spend horizontal range while moving only vertically", () => {
    const result = advanceProjectile(shot({ vx: 0, vy: 10, range: 0.1 }), context());
    expect(result.projectile.distance).toBe(0);
    expect(result.expired).toBe(false);
    expect(result.projectile.y).toBeGreaterThan(1);
  });

  it("still applies a contact exactly at the remaining range boundary", () => {
    const result = advanceProjectile(shot({ range: 1 }), context([actor("edge", 1.25)]));
    expect(result.hit?.id).toBe("edge");
    expect(result.projectile.x).toBe(1);
    expect(result.expired).toBe(false);
  });

  it("expires an already-spent projectile without moving or hitting an overlapping actor", () => {
    const p = shot({ distance: 30 });
    const result = advanceProjectile(p, context([actor("overlap", 0)]));
    expect(result.projectile).toEqual(p);
    expect(result.expired).toBe(true);
    expect(result.hit).toBeNull();
  });

  it("clips at the ground and reports landing before a later actor or wall", () => {
    const result = advanceProjectile(shot({ y: 0.05, vy: -10 }), context([actor("later", 8)], [wall(9)]));
    expect(result.landed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.hit).toBeNull();
    expect(result.projectile.y).toBe(0);
    expect(result.projectile.x).toBeGreaterThan(2);
    expect(result.projectile.x).toBeLessThan(4);
  });

  it("lets a projectile launch upward from ground level", () => {
    const result = advanceProjectile(shot({ y: 0, vy: 5, vx: 1 }), context());
    expect(result.landed).toBe(false);
    expect(result.projectile.y).toBeGreaterThan(0);
  });

  it("lands an eight-metre cone arc at its advertised range after one second", () => {
    let projectile = shot({ kind: "cone", x: 0, y: 1.2, z: 0, vx: 8, vy: 3.705, vz: 0, range: 8 });
    let last = advanceProjectile(projectile, context());
    for (let tick = 0; tick < 70; tick++) {
      last = advanceProjectile(projectile, context());
      projectile = last.projectile;
      if (last.landed || last.expired) break;
    }
    expect(last.landed).toBe(true);
    expect(last.expired).toBe(false);
    expect(projectile.x).toBeCloseTo(8, 9);
    expect(projectile.y).toBe(0);
    expect(projectile.distance).toBeCloseTo(8, 9);
  });

  it("lands at the first crossing of sloped terrain using deterministic bisection", () => {
    const ctx = { ...context(), groundHeight: (x: number): number => x * 0.5 };
    const result = advanceProjectile(shot(), ctx);
    expect(result.landed).toBe(true);
    expect(result.projectile.x).toBeCloseTo(2, 8);
    expect(result.projectile.y).toBeCloseTo(1, 8);
  });

  it("detects a terrain crest even when both endpoints clear the ground", () => {
    const ctx = { ...context(), groundHeight: (x: number): number => x <= 5 ? x * 0.5 : (10 - x) * 0.5 };
    const result = advanceProjectile(shot(), ctx);
    expect(result.landed).toBe(true);
    expect(result.projectile.x).toBeCloseTo(2, 8);
  });

  it("does not land an upward launch on a raised terrain surface", () => {
    const ctx = { ...context(), groundHeight: (): number => 8 };
    const result = advanceProjectile(shot({ y: 8, vy: 5, vx: 1 }), ctx);
    expect(result.landed).toBe(false);
    expect(result.projectile.y).toBeGreaterThan(8);
  });

  it("intercepts vertical cylinder caps but misses above and beside the volume", () => {
    const target = actor("target", 0);
    expect(segmentActorFraction({ x: 0, y: 3, z: 0 }, { x: 0, y: 1, z: 0 }, target)).toBe(0.5);
    expect(segmentActorFraction({ x: -2, y: 2.1, z: 0 }, { x: 2, y: 2.1, z: 0 }, target)).toBeNull();
    expect(segmentActorFraction({ x: -2, y: 1, z: 0.3 }, { x: 2, y: 1, z: 0.3 }, target)).toBeNull();
  });

  it("counts tangent, initial-overlap and zero-length cylinder contacts", () => {
    const target = actor("target", 0, { radius: 1 });
    expect(segmentActorFraction({ x: -2, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }, target)).toBe(0.5);
    expect(segmentActorFraction({ x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, target)).toBe(0);
    expect(segmentActorFraction({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, target)).toBe(0);
  });

  it("checks all three wall dimensions, including zero-thickness and start-inside walls", () => {
    const obstacle = wall(2);
    expect(segmentWallFraction({ x: 0, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }, obstacle)).toBeCloseTo(0.4, 10);
    expect(segmentWallFraction({ x: 0, y: 4, z: 0 }, { x: 5, y: 4, z: 0 }, obstacle)).toBeNull();
    expect(segmentWallFraction({ x: 2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, obstacle)).toBe(0);
    expect(segmentWallFraction({ x: 0, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }, wall(2, { maxX: 2 }))).toBeCloseTo(0.4, 10);
  });

  it("reports opaque line of sight without treating walls above the ray as blockers", () => {
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 10, y: 1, z: 0 };
    expect(lineOfSight(from, to, [])).toBe(true);
    expect(lineOfSight(from, to, [wall(3)])).toBe(false);
    expect(lineOfSight(from, to, [wall(3, { minY: 2, maxY: 4 })])).toBe(true);
    expect(lineOfSight(from, to, [wall(0)])).toBe(false);
  });

  it("never mutates a frozen projectile, actor, wall or context", () => {
    const p = Object.freeze(shot());
    const target = Object.freeze(actor("target", 5));
    const obstacle = Object.freeze(wall(8));
    const ctx = Object.freeze({ actors: Object.freeze([target]), walls: Object.freeze([obstacle]), players: Object.freeze([]), refills: Object.freeze([]) });
    const snapshot = JSON.stringify({ p, ctx });
    const result = advanceProjectile(p, ctx);
    expect(result.hit).toBe(target);
    expect(result.projectile).not.toBe(p);
    expect(JSON.stringify({ p, ctx })).toBe(snapshot);
  });
});
