// Projectiles on stacked structural surfaces: the combat adapter answers the ground query at the
// projectile's own level (CombatContext.groundHeight's y), so a spray in a tunnel bore flies down
// the bore instead of "landing" in the hill above it, and one on a deck lands on the deck instead
// of falling through to the street under it.
import { describe, expect, it } from "vitest";
import { createInitialState, surfaceHeight, type SimState } from "../../src/sim/index.ts";
import { contextFromState } from "../../src/sim/combat/adapter.ts";
import { advanceProjectile } from "../../src/sim/combat/physics.ts";
import type { Projectile } from "../../src/sim/combat-contract.ts";
import { overpassY, surfaceWorld } from "./fixtures.ts";

describe("projectiles in bores and on decks", () => {
  const world = surfaceWorld(true);
  const spray = (x: number, y: number, z: number, vz: number): Projectile => ({
    id: 1, kind: "water", ownerId: "p1", x, y, z, vx: 0, vy: 0, vz, distance: 0, range: 40, bornTick: 0, volume: 0.1, salt: false, vehicle: false, rustRate: 1,
  });
  const fly = (state: SimState, p0: Projectile, ticks: number): { p: Projectile; landed: boolean } => {
    const ctx = contextFromState(world, state);
    let p = p0;
    for (let t = 0; t < ticks; t++) {
      const step = advanceProjectile(p, ctx);
      p = step.projectile;
      if (step.landed) return { p, landed: true };
    }
    return { p, landed: false };
  };

  it("flies down the tunnel bore under the ridge", () => {
    const floor = surfaceHeight(world, 0, -120, 0);
    expect(surfaceHeight(world, 0, -100, 40)).toBeGreaterThan(floor + 15);
    const state = createInitialState(world, 1, ["p1"], { x: 250, z: 250, heading: 0 });
    // Fired north from inside the south part of the bore at chest height, level.
    const { p, landed } = fly(state, spray(0, floor + 1.4, -70, -14), 40);
    // A level shot from 1.4 m at 14 m/s falls to the floor after about 7.4 m.
    expect(-70 - p.z, "travelled along the bore").toBeGreaterThan(5);
    expect(landed).toBe(true);
    expect(p.y).toBeLessThan(floor + 0.5);
  });

  it("lands on the overpass deck, not the street under it", () => {
    const deck = overpassY(130);
    const state = createInitialState(world, 1, ["p1"], { x: 250, z: 250, heading: 0 });
    const { p, landed } = fly(state, spray(30, deck + 1.4, 125, 6), 240);
    expect(landed).toBe(true);
    expect(p.y).toBeGreaterThan(deck - 0.5);
  });
});
