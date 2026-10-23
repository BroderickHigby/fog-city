import { describe, expect, it } from "vitest";
import { buildLoadedWorld, loadWorldFiles, RUNTIME_LAYERS, type WorldManifestLike } from "../../src/io/world-load.ts";
import type { Assets } from "../../src/io/assets.ts";
import type { ParkingLayer, StreetCleaningLayer } from "../../src/sim/parking-data.ts";
import { buildWorldWithRoads } from "../helpers.ts";
import { makeWorld } from "../e2e/determinism-scenario.ts";

const parking: ParkingLayer = { version: 1, world: "test", rules: [{
  id: "p", edge: "road", side: "R", kind: "time-limited", days: [1, 2, 3, 4, 5],
  from: 480, to: 1080, hourLimit: 2, permitAreas: [], lengthM: 20,
}] };
const streetCleaning: StreetCleaningLayer = { version: 1, world: "test", rules: [{
  edge: "road", side: "R", day: 2, fromHour: 8, toHour: 10, weeks: [1, 3], holidays: false,
}] };
function assetsFor(layers: Record<string, string>, files: Record<string, unknown>): Assets {
  const manifest: WorldManifestLike = { spawn: { x: 0, z: 0, heading: 0 }, tiles: [], layers };
  return { mode: "loose", defaultWorld: null, worlds: null, has: () => true,
    bytes: async () => new Uint8Array(), json: async <T>(path: string): Promise<T> => {
      if (path.endsWith("manifest.json")) return manifest as T;
      if (path in files) return files[path] as T;
      throw new Error("missing fixture file");
    } };
}

describe("parking world metadata", () => {
  it("loads the same immutable rule data into browser, replay and Node worlds", async () => {
    const before = JSON.stringify({ parking, streetCleaning });
    const assets = assetsFor({ parking: "parking.json", streetCleaning: "cleaning.json" }, {
      "tiles/test/parking.json": parking, "tiles/test/cleaning.json": streetCleaning,
    });
    const files = await loadWorldFiles(assets, "test");
    const worlds = [buildLoadedWorld(files), buildWorldWithRoads([], null, null, { gameplay: null, sidewalks: null, transit: null, ...files }), makeWorld([], null, null, files)];
    for (const world of worlds) {
      expect(world.parking).toBe(parking);
      expect(world.streetCleaning).toBe(streetCleaning);
      expect(world.parking!.rules[0]!.from).toBe(480);
      expect(world.streetCleaning!.rules[0]!.fromHour).toBe(8);
    }
    expect(JSON.stringify({ parking, streetCleaning })).toBe(before);
    expect(RUNTIME_LAYERS).toContain("parking");
    expect(RUNTIME_LAYERS).toContain("streetCleaning");
  });

  it.each([
    ["parking", "parking.json", "parking layer parking.json"],
    ["streetCleaning", "cleaning.json", "street-cleaning layer cleaning.json"],
  ])("rejects a missing declared %s layer", async (key, file, message) => {
    await expect(loadWorldFiles(assetsFor({ [key]: file }, {}), "test")).rejects.toThrow(message);
  });

  it("keeps rules absent for worlds that do not declare them", async () => {
    const world = buildLoadedWorld(await loadWorldFiles(assetsFor({}, {}), "test"));
    expect(world.parking).toBeUndefined();
    expect(world.streetCleaning).toBeUndefined();
  });
});
