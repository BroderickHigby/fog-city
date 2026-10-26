import { describe, expect, it } from "vitest";
import { tileBounds, distanceToBounds, selectTiles, DEFAULT_RADIUS_M, type TileBounds } from "../../src/render/tile-select.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import type { Manifest } from "../../src/render/types.ts";
import { readJson } from "../helpers.ts";

function grid(n: number, size = 500): TileBounds[] {
  const out: TileBounds[] = [];
  for (let iz = 0; iz < n; iz++)
    for (let ix = 0; ix < n; ix++)
      out.push(tileBounds({ id: `t${ix}_${iz}`, ix, iz, collider: "", glb: null }, size));
  return out;
}

describe("tileBounds", () => {
  it("prefers bbox, then grid index, then collider contents", () => {
    const collider: TileCollider = {
      tileId: "x",
      buildings: [{ id: "b", footprint: [[10, 20], [30, 20], [30, 50]], baseY: 0, topY: 5 }],
      ground: { x0: -5, z0: 0, cellSizeM: 10, nx: 3, nz: 2, heights: [0, 0, 0, 0, 0, 0] },
    };
    expect(tileBounds({ id: "a", bbox: [0, 1, 2, 3], ix: 9, iz: 9, collider: "", glb: null }, 500, collider)).toMatchObject({ minX: 0, minZ: 1, maxX: 2, maxZ: 3, exact: true });
    expect(tileBounds({ id: "a", ix: -2, iz: 3, collider: "", glb: null }, 500, collider)).toMatchObject({ minX: -1000, minZ: 1500, maxX: -500, maxZ: 2000, exact: true });
    expect(tileBounds({ id: "a", collider: "", glb: null }, 500, collider)).toMatchObject({ minX: -5, minZ: 0, maxX: 30, maxZ: 50, exact: false });
    expect(tileBounds({ id: "a", collider: "", glb: null }, 500, null)).toMatchObject({ minX: 0, maxX: 0, exact: false });
  });

  it("normalises a bbox given with swapped corners", () => {
    expect(tileBounds({ id: "a", bbox: [10, 10, 0, 0], collider: "", glb: null }, 500)).toMatchObject({ minX: 0, minZ: 0, maxX: 10, maxZ: 10 });
  });
});

describe("distanceToBounds", () => {
  const b: TileBounds = { id: "b", minX: 0, minZ: 0, maxX: 500, maxZ: 500, exact: true };
  it("is zero inside and on the edge", () => {
    expect(distanceToBounds(b, 250, 250)).toBe(0);
    expect(distanceToBounds(b, 500, 0)).toBe(0);
  });
  it("is the straight distance to the nearest edge or corner outside", () => {
    expect(distanceToBounds(b, -100, 250)).toBe(100);
    expect(distanceToBounds(b, 250, 900)).toBe(400);
    expect(distanceToBounds(b, 800, -400)).toBeCloseTo(500, 9);
  });
});

describe("selectTiles", () => {
  const tiles = grid(7); // 3.5 km square
  it("loads every tile within the radius, nearest first, ties by id", () => {
    const sel = selectTiles(tiles, 1750, 1750, new Set(), { radius: 600, hysteresis: 100 });
    // Camera in the middle of t3_3: itself (0), its 4 edge neighbours (250), 4 corners (~354).
    expect(sel.load[0]).toBe("t3_3");
    expect(sel.load.slice(1, 5).sort()).toEqual(["t2_3", "t3_2", "t3_4", "t4_3"]);
    expect(sel.load.slice(1, 5)).toEqual(["t2_3", "t3_2", "t3_4", "t4_3"]);
    expect(sel.load.slice(5).sort()).toEqual(["t2_2", "t2_4", "t4_2", "t4_4"]);
    expect(sel.load).toHaveLength(9);
    expect(sel.unload).toEqual([]);
  });

  it("never reloads present tiles and never unloads absent ones", () => {
    const sel = selectTiles(tiles, 1750, 1750, new Set(["t3_3", "t0_0"]), { radius: 600, hysteresis: 100 });
    expect(sel.load).not.toContain("t3_3");
    expect(sel.unload).toEqual(["t0_0"]);
  });

  it("keeps a tile inside the hysteresis band and drops it beyond", () => {
    // t5_3 spans x 2500..3000; camera at x 1750 is 750 m away.
    const present = new Set(["t5_3"]);
    expect(selectTiles(tiles, 1750, 1750, present, { radius: 600, hysteresis: 200 }).unload).toEqual([]);
    expect(selectTiles(tiles, 1750, 1750, present, { radius: 600, hysteresis: 100 }).unload).toEqual(["t5_3"]);
  });

  it("streams as the camera moves: tiles behind unload, tiles ahead load", () => {
    const present = new Set<string>();
    const apply = (x: number, z: number): void => {
      const s = selectTiles(tiles, x, z, present, { radius: 700, hysteresis: 150 });
      for (const id of s.unload) present.delete(id);
      for (const id of s.load) present.add(id);
    };
    apply(250, 1750);
    expect(present.has("t0_3")).toBe(true);
    expect(present.has("t6_3")).toBe(false);
    for (let x = 250; x <= 3250; x += 50) apply(x, 1750);
    expect(present.has("t6_3")).toBe(true);
    expect(present.has("t0_3")).toBe(false);
    // Everything present is within radius + hysteresis of the camera.
    for (const id of present) expect(distanceToBounds(tiles.find((t) => t.id === id)!, 3250, 1750)).toBeLessThanOrEqual(850);
  });

  it("dev-city at its spawn loads the near city and leaves the far west for later", () => {
    const m = readJson<Manifest>("public/tiles/dev-city/manifest.json");
    const bounds = m.tiles.map((t) => tileBounds(t, m.tileSizeM ?? 500));
    const sel = selectTiles(bounds, m.spawn.x, m.spawn.z, new Set(), { radius: DEFAULT_RADIUS_M, hysteresis: 250 });
    expect(sel.load.length).toBeGreaterThan(10);
    expect(sel.load.length).toBeLessThan(m.tiles.length);
    expect(sel.load).not.toContain("t-5_-3");
    expect(sel.load[0]).toBe("t-1_0");
  });
});
