import { describe, expect, it } from "vitest";
import { SIM_VERSION, buildWorld, createInitialState, step, upgradeState } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";
import { surfaceWorld } from "./fixtures.ts";

describe("structural-world migration", () => {
  it("upgrades a live v7 save without changing its bodies or extensions", () => {
    const world = surfaceWorld();
    const current = createInitialState(world, 41, ["p1"], { x: 30, z: 130, heading: 0 });
    const old = deepFreeze({ ...current, version: 7, ext: { ...current.ext, future: { keep: [1, "value"] } } });
    const migrated = upgradeState(old);
    expect(SIM_VERSION).toBe(8);
    expect(migrated).toEqual({ ...old, version: 8 });
    expect(old.version).toBe(7);
    expect(upgradeState(migrated)).toBe(migrated);
    expect(() => step(world, migrated, {}, [], [])).not.toThrow();
  });

  it("retains optional gameplay metadata when building structural worlds", () => {
    const source = surfaceWorld();
    const data = { version: 1 as const, world: "fixture", sourceSnapshot: "fixture", tiles: [], refills: [], anchors: [], territories: [] };
    const world = buildWorld(source.tiles, null, null, data);
    expect(world.gameplay).toBe(data);
    expect(world.surfaces).not.toBeNull();
  });
});
