// The binary world collider pack (schemas/world-colliders.md): the committed sf pack decodes to
// exactly the per-tile JSON colliders, and the encoder/reader handle the format's edge cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWorld, decodeColliderPack, groundHeight } from "../../src/sim/index.ts";
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
      expect(t.buildings).toEqual(c.buildings.map(({ meta: _meta, ...b }) => b));
      expect(t.decks).toEqual(c.decks);
      expect(t.tunnels).toEqual(c.tunnels);
      expect(t.movable).toEqual(c.movable);
    });
  });

  it("the sim's reader (src/sim/pack.ts) decodes it to the same tiles, extension included", () => {
    const sim = decodeColliderPack(packBytes);
    expect(sim.tiles.length).toBe(pack.tiles.length);
    sim.tiles.forEach((t, i) => expect(t, t.tileId).toEqual(pack.tiles[i]));
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

  it("round-trips the extension block: piece ids, undersides, decks, tunnels and movable spans; a world without them is plain version 1", () => {
    const w = world([
      { id: "201006.0000002", footprint: [[0, 0], [10, 0], [10, 10]], baseY: 3, topY: 9 },
      { id: "201006.0000002-b1", footprint: [[10, 0], [20, 0], [20, 10]], baseY: 3, topY: 12, underY: 8.5 },
      { id: "201006.0000002-s3", footprint: [[0, 10], [10, 10], [10, 20]], baseY: 6, topY: 11.25 },
      { id: "201006.0000003-1-tower-s2", footprint: [[5, 5], [6, 5], [6, 6]], baseY: -1, topY: 40 },
      { id: "201006.0000004", footprint: [[30, 30], [31, 30], [31, 31]], baseY: 50, topY: 58, underY: 50 },
    ]);
    const t = w.tiles[0]!;
    t.decks = [
      { id: "c1~0", kind: "freeway", edge: "c1", layer: 1, path: [[0, 12.5, 0, 14.3], [100, 18.75, -40.01, 14.3]] },
      { id: "c2~3", kind: "bridge", layer: 2, path: [[-5, 3.4, 5, 11], [5, 3.6, 5, 11], [15, 3.5, 5, 11]] },
    ];
    t.tunnels = [{ id: "c3~0", kind: "tunnel", edge: "c3", clearanceM: 5.5, path: [[0, 20, 0, 9.4], [0, 22, 300, 9.4]] }];
    t.movable = [{ id: "c2~3-leaf", kind: "bascule", deck: "c2~3", hinge: [[-5, 0], [-5, 10]], openRad: 1.2 }];
    const bytes = encodeWorldColliders(w);
    expect(new DataView(bytes.buffer).getUint32(28, true)).toBeGreaterThan(0);
    const back = decodeWorldColliders(bytes);
    expect(back).toEqual(w);
    expect(Buffer.from(encodeWorldColliders(back)).equals(Buffer.from(bytes))).toBe(true);
    // The sim's own reader (src/sim/pack.ts) decodes the extension identically.
    expect(decodeColliderPack(bytes)).toEqual(back);
    const plain = world([{ id: "201006.0000005", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]);
    const plainBytes = encodeWorldColliders(plain);
    expect(new DataView(plainBytes.buffer).getUint32(28, true)).toBe(0);
    expect(decodeWorldColliders(plainBytes)).toEqual(plain);
  });

  it("refuses what the format cannot hold, and rejects a foreign or truncated file", () => {
    expect(() => encodeWorldColliders(world([{ id: "other-id", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]))).toThrow(/id encoding/);
    expect(() => encodeWorldColliders(world([{ id: "201006.0000001-s0", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]))).toThrow(/piece number/);
    expect(() => encodeWorldColliders(world([{ id: "201006.0000001", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3, underY: 1.234 }]))).toThrow(/centimetres/);
    expect(() => encodeWorldColliders(world([{ id: "201006.0000001", footprint: [[0, 0], [1.001, 0], [1, 1]], baseY: 0, topY: 3 }]))).toThrow(/centimetres/);
    const ok = encodeWorldColliders(world([{ id: "201006.0000001", footprint: [[0, 0], [1, 0], [1, 1]], baseY: 0, topY: 3 }]));
    const bad = ok.slice();
    bad[0] = 0x58;
    expect(() => decodeWorldColliders(bad)).toThrow(/magic/);
    expect(() => decodeWorldColliders(ok.slice(0, ok.byteLength - 8))).toThrow(/truncated|vertex/);
  });
});
