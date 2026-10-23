import { describe, expect, it } from "vitest";
import { SIM_VERSION, buildWorld, createInitialState, step, upgradeState } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";
import { surfaceWorld } from "./fixtures.ts";

describe("structural-world migration", () => {
  it("upgrades live v7 and v8 saves to v9 without changing their bodies or extensions", () => {
    const world = surfaceWorld();
    const current = createInitialState(world, 41, ["p1"], { x: 30, z: 130, heading: 0 });
    expect(SIM_VERSION).toBe(9);
    for (const version of [7, 8]) {
      const old = deepFreeze({ ...current, version, ext: { ...current.ext, future: { keep: [1, "value"] } } });
      const migrated = upgradeState(old);
      expect(migrated).toEqual({ ...old, version: 9 });
      expect(old.version).toBe(version);
      expect(upgradeState(migrated)).toBe(migrated);
      expect(() => step(world, migrated, {}, [], [])).not.toThrow();
    }
  });

  it("retains optional gameplay metadata when building structural worlds", () => {
    const source = surfaceWorld();
    const data = { version: 1 as const, world: "fixture", sourceSnapshot: "fixture", tiles: [], refills: [], anchors: [], territories: [] };
    const world = buildWorld(source.tiles, null, null, data);
    expect(world.gameplay).toBe(data);
    expect(world.surfaces).not.toBeNull();
  });
});
