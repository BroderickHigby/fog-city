// The binary world collider pack (schemas/world-colliders.md): the committed sf pack decodes to
// exactly the per-tile JSON colliders, and the encoder/reader handle the format's edge cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWorld, groundHeight } from "../../src/sim/index.ts";
import { decodeWorldColliders, encodeWorldColliders, PackGroundIndex, type WorldColliders } from "../../pipeline/lib/world-colliders.ts";
import { ORIGIN } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";
import { loadSf } from "./util.ts";

// Whole-city checks: generous timeouts, since the suite shares the CPU with other workers.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { manifest, colliders } = loadSf();
const packBytes = new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", manifest.worldColliders)));

describe("world.colliders.bin (sf)", () => {
  const pack = decodeWorldColliders(packBytes);

  it("decodes to exactly the per-tile JSON colliders: tiles, heights, water, ids, footprints, baseY, topY", () => {
    expect(pack.origin).toEqual({ lat: ORIGIN.lat, lon: ORIGIN.lon });
    expect(pack.tileSizeM).toBe(500);
    expect(pack.tiles.map((t) => t.tileId)).toEqual(manifest.tiles.map((t) => t.id));
    pack.tiles.forEach((t, i) => {
      const c = colliders[i]!;
      expect(t.tileId).toBe(c.tileId);
      expect(t.ground).toEqual(c.ground);
      expect(t.buildings).toEqual(c.buildings.map((b) => ({ id: b.id, footprint: b.footprint, baseY: b.baseY, topY: b.topY })));
    });
  });

  it("re-encodes byte for byte", () => {
    expect(Buffer.from(encodeWorldColliders(pack)).equals(Buffer.from(packBytes))).toBe(true);
  });

  it("its indexed ground lookup agrees with the sim's (src/sim/world.ts groundHeight)", () => {
    const world = buildWorld(colliders);
    const idx = new PackGroundIndex(pack);
    let n = 0;
    // A deterministic spread of points over the world, including tile borders and open water.
    for (let x = -11000; x <= 3500; x += 137.5) {
      for (let z = -4500; z <= 10500; z += 250) {
        expect(idx.heightAt(x, z), `${x},${z}`).toBe(groundHeight(world, x, z));
        n++;
      }
    }
    expect(n).toBeGreaterThan(5000);
  });

  it("is far smaller than the JSON it replaces at boot", () => {
    const json = manifest.tiles.reduce((s, t) => s + readFileSync(join(ROOT, "public/tiles/sf", t.collider)).byteLength, 0);
    expect(packBytes.byteLength * 4).toBeLessThan(json);
  });
});

describe("FCWC encoder and reader edge cases", () => {
  const S = 51;
  const flat = (h: number) => ({ x0: 0, z0: 0, cellSizeM: 10, nx: S, nz: S, heights: new Array<number>(S * S).fill(h), water: new Array<number>(S * S).fill(0) });
  const world = (buildings: WorldColliders["tiles"][number]["buildings"]): WorldColliders => ({
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: 500,
    tiles: [{ tileId: "t0_0", ix: 0, iz: 0, ground: flat(12.34), buildings }],
  });

  it("round-trips long edges through the escape, negative coordinates, parts and towers", () => {
    const w = world([
      { id: "201006.0000001", footprint: [[0, 0], [400.01, 0], [400.01, -10.5], [-0.07, -10.5]], baseY: 3.21, topY: 9.99 },
      { id: "201006.0000001-2", footprint: [[1, 1], [2, 1], [2, 2]], baseY: 0, topY: 2.5 },
      { id: "201006.9999999-3-tower", footprint: [[-327.68, 0], [327.67, 0], [0, 327.68]], baseY: 280.5, topY: 600.12 },
    ]);
    w.tiles[0]!.ground.water[7] = 1;
    w.tiles[0]!.ground.heights[S * S - 1] = 283.82;
    const back = decodeWorldColliders(encodeWorldColliders(w));
    expect(back).toEqual(w);
  });

  it("refuses what version 1 cannot hold, and rejects a foreign or truncated file", () => {
    expect(() => encodeWorldColliders(world([{ id: "other-id", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]))).toThrow(/id encoding/);
    expect(() => encodeWorldColliders(world([{ id: "201006.0000001", footprint: [[0, 0], [1.001, 0], [1, 1]], baseY: 0, topY: 3 }]))).toThrow(/centimetres/);
    const ok = encodeWorldColliders(world([{ id: "201006.0000001", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]));
    const bad = ok.slice();
    bad[0] = 0x58;
    expect(() => decodeWorldColliders(bad)).toThrow(/magic/);
    expect(() => decodeWorldColliders(ok.slice(0, ok.byteLength - 8))).toThrow(/truncated|vertex/);
  });
});
