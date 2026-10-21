// The sim's reader for the citywide collider pack (src/sim/pack.ts): it decodes to exactly what
// the pipeline's reference reader (pipeline/lib/world-colliders.ts) and the per-tile JSON give,
// round-trips everything the format can hold, refuses a broken file, and a world built from it
// is the world built from the JSON. Also the tile index the ground lookup uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeWorldColliders, encodeWorldColliders, type WorldColliders } from "../../pipeline/lib/world-colliders.ts";
import { ORIGIN, TILE_SIZE_M } from "../../src/geo/project.ts";
import {
  buildWorld,
  cellKey,
  circleBlocked,
  decodeColliderPack,
  groundHeight,
  type Heightfield,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";
import { ROOT, readJson, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const SF = "public/tiles/sf";
const sfPresent = worldExists("sf");

/** The pre-index lookup: the first tile in id order whose heightfield covers the point (bilinear), else 0. */
const sortedTiles = new WeakMap<readonly TileCollider[], TileCollider[]>();

function scanGround(tiles: readonly TileCollider[], x: number, z: number): number {
  let sorted = sortedTiles.get(tiles);
  if (!sorted) sortedTiles.set(tiles, (sorted = [...tiles].sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0))));
  for (const t of sorted) {
    const g = t.ground;
    if (!g) continue;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
    const ix = Math.min(Math.floor(fx), g.nx - 2);
    const iz = Math.min(Math.floor(fz), g.nz - 2);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = (i: number, k: number): number => g.heights[k * g.nx + i] ?? 0;
    return (h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx) * (1 - tz) + (h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx) * tz;
  }
  return 0;
}

describe("collider pack reader: synthetic packs", () => {
  const S = 51;
  const field = (ix: number, iz: number, f: (i: number, k: number) => number): WorldColliders["tiles"][number]["ground"] => {
    const heights: number[] = [];
    const water: number[] = [];
    for (let k = 0; k < S; k++) {
      for (let i = 0; i < S; i++) {
        heights.push(f(ix * 50 + i, iz * 50 + k));
        water.push((i + k) % 7 === 0 ? 1 : 0);
      }
    }
    return { x0: ix * 500, z0: iz * 500, cellSizeM: 10, nx: S, nz: S, heights, water };
  };
  // Heights on the global lattice, so neighbours repeat their shared border exactly (as the pipeline's do).
  const lattice = (gi: number, gk: number): number => Math.round((Math.sin(gi * 0.37) * 40 + Math.cos(gk * 0.21) * 25 + 60) * 100) / 100;
  const sample: WorldColliders = {
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: 500,
    tiles: [
      {
        tileId: "t-1_-1",
        ix: -1,
        iz: -1,
        ground: field(-1, -1, lattice),
        buildings: [
          { id: "201006.0000001", footprint: [[-400, -400], [-0.01, -400], [-0.01, -390.5], [-400, -390.5]], baseY: 3.21, topY: 9.99 },
          { id: "201006.0000001-2", footprint: [[-10, -10], [-9, -10], [-9, -9]], baseY: -2.5, topY: 0 },
        ],
      },
      { tileId: "t0_-1", ix: 0, iz: -1, ground: field(0, -1, lattice), buildings: [] },
      {
        tileId: "t-1_0",
        ix: -1,
        iz: 0,
        ground: field(-1, 0, lattice),
        buildings: [{ id: "201006.9999999-3-tower", footprint: [[-327.68, 0], [327.67, 0], [0, 327.68]], baseY: 280.5, topY: 600.12 }],
      },
      { tileId: "t0_0", ix: 0, iz: 0, ground: field(0, 0, lattice), buildings: [{ id: "201006.0123456", footprint: [[1, 1], [2, 1], [2, 2], [1, 2]], baseY: 0.03, topY: 4 }] },
    ],
  };
  const bytes = encodeWorldColliders(sample);

  it("round-trips through the pipeline's encoder: ids, parts, towers, long edges, negative coordinates, water bits", () => {
    const pack = decodeColliderPack(bytes);
    expect(pack.origin).toEqual(sample.origin);
    expect(pack.tileSizeM).toBe(500);
    expect(pack.tiles).toEqual(sample.tiles);
  });

  it("decodes to exactly the pipeline's reference reader", () => {
    expect(decodeColliderPack(bytes)).toEqual(decodeWorldColliders(bytes));
  });

  it("decodes plain data: arrays and numbers only, JSON round-trips unchanged", () => {
    const pack = decodeColliderPack(bytes);
    expect(JSON.parse(JSON.stringify(pack))).toEqual(pack);
    expect(Array.isArray(pack.tiles[0]!.ground.heights)).toBe(true);
  });

  it("reads from a view into a larger buffer (a slice of a pack file)", () => {
    const big = new Uint8Array(bytes.byteLength + 13);
    big.set(bytes, 7);
    expect(decodeColliderPack(big.subarray(7, 7 + bytes.byteLength))).toEqual(decodeColliderPack(bytes));
  });

  it("refuses a foreign, newer, truncated or inconsistent file", () => {
    const bad = bytes.slice();
    bad[0] = 0x58;
    expect(() => decodeColliderPack(bad)).toThrow(/magic/);
    const newer = bytes.slice();
    new DataView(newer.buffer).setUint16(4, 2, true);
    expect(() => decodeColliderPack(newer)).toThrow(/version 2/);
    expect(() => decodeColliderPack(bytes.slice(0, 40))).toThrow(/truncated/);
    expect(() => decodeColliderPack(bytes.slice(0, bytes.byteLength - 8))).toThrow(/truncated|vertex/);
    const lying = bytes.slice();
    new DataView(lying.buffer).setUint32(64 + 8, 99, true); // tile 0 claims 99 buildings
    expect(() => decodeColliderPack(lying)).toThrow();
  });

  it("indexes ground by floor(x / 500), floor(z / 500): the same heights as scanning every tile, borders and corners included", () => {
    const tiles = decodeColliderPack(bytes).tiles;
    const world = buildWorld(tiles);
    expect(world.tileGround).not.toBeNull();
    expect(world.tileGround!.size).toBe(4);
    expect(world.tileGround!.get(cellKey(-1, 0))).toBe(tiles[2]!.ground);
    let n = 0;
    for (let x = -520; x <= 520; x += 2.5) {
      for (let z = -520; z <= 520; z += 2.5) {
        expect(groundHeight(world, x, z), `${x},${z}`).toBe(scanGround(tiles, x, z));
        n++;
      }
    }
    // Every border and corner of the 2 x 2 block, and the far borders where no tile follows.
    for (const x of [-500, -250, 0, 250, 500]) for (const z of [-500, -250, 0, 250, 500]) expect(groundHeight(world, x, z)).toBe(scanGround(tiles, x, z));
    expect(groundHeight(world, 500, 500)).toBe(lattice(50, 50));
    expect(groundHeight(world, 600, 0)).toBe(0);
    expect(n).toBeGreaterThan(170_000);
  });

  it("keeps the first-in-id-order scan for hand-made worlds whose heightfields are not tile-aligned", () => {
    const g: Heightfield = { x0: -30, z0: -30, cellSizeM: 10, nx: 7, nz: 7, heights: Array.from({ length: 49 }, (_, i) => i / 10) };
    const tiles: TileCollider[] = [{ tileId: "hill", buildings: [], ground: g }];
    const world = buildWorld(tiles);
    expect(world.tileGround).toBeNull();
    for (let x = -40; x <= 40; x += 1.5) for (let z = -40; z <= 40; z += 1.5) expect(groundHeight(world, x, z)).toBe(scanGround(tiles, x, z));
  });
});

describe.skipIf(!sfPresent)("collider pack reader: the committed sf pack", () => {
  const manifest = sfPresent ? readJson<{ worldColliders: string; tiles: Array<{ id: string; collider: string }> }>(`${SF}/manifest.json`) : null;
  const bytes = sfPresent ? new Uint8Array(readFileSync(join(ROOT, SF, manifest!.worldColliders))) : new Uint8Array();

  it(
    "decodes the whole city exactly as the pipeline's reader does, in manifest order",
    () => {
      const ours = decodeColliderPack(bytes);
      const ref = decodeWorldColliders(bytes);
      expect(ours.tiles.map((t) => t.tileId)).toEqual(manifest!.tiles.map((t) => t.id));
      expect(ours.tiles.length).toBe(ref.tiles.length);
      ours.tiles.forEach((t, i) => expect(t, t.tileId).toEqual(ref.tiles[i]));
      expect(ours.tiles.reduce((s, t) => s + t.buildings.length, 0)).toBeGreaterThan(170_000);
    },
    SF_RUN_MS,
  );

  it(
    "matches the per-tile JSON colliders (minus meta) on a spread of tiles, and builds the same world",
    () => {
      const pack = decodeColliderPack(bytes);
      const picks = manifest!.tiles.map((_, i) => i).filter((i) => i % 37 === 0);
      const json: TileCollider[] = [];
      for (const i of picks) {
        const c = readJson<TileCollider & { buildings: Array<TileCollider["buildings"][number] & { meta?: unknown }> }>(`${SF}/${manifest!.tiles[i]!.collider}`);
        const t = pack.tiles[i]!;
        expect(t.tileId).toBe(c.tileId);
        expect(t.ground).toEqual(c.ground);
        expect(t.buildings).toEqual(c.buildings.map((b) => ({ id: b.id, footprint: b.footprint, baseY: b.baseY, topY: b.topY })));
        json.push(c);
      }
      const fromPack: World = buildWorld(picks.map((i) => pack.tiles[i]!));
      const fromJson: World = buildWorld(json);
      for (const t of json) {
        const g = t.ground!;
        for (let k = 0; k <= 20; k++) {
          const x = g.x0 + k * 25 + 0.37;
          const z = g.z0 + ((k * 7) % 21) * 25 + 0.11;
          expect(groundHeight(fromPack, x, z)).toBe(groundHeight(fromJson, x, z));
          expect(circleBlocked(fromPack, x, z, 1.2)).toBe(circleBlocked(fromJson, x, z, 1.2));
        }
      }
    },
    SF_RUN_MS,
  );

  it(
    "gives the city a tile-indexed ground: every pack tile is aligned to its 500 m tile",
    () => {
      const pack = decodeColliderPack(bytes);
      const world = buildWorld(pack.tiles);
      expect(world.tileGround).not.toBeNull();
      expect(world.tileGround!.size).toBe(pack.tiles.length);
      for (const t of pack.tiles) expect(world.tileGround!.get(cellKey(t.ix, t.iz))).toBe(t.ground);
      // A point in a tile reads that tile's lattice; outside every tile the ground is sea level.
      const t = pack.tiles[100]!;
      expect(groundHeight(world, t.ix * TILE_SIZE_M + 10, t.iz * TILE_SIZE_M + 20)).toBe(t.ground.heights[2 * 51 + 1]);
      expect(groundHeight(world, 50_000, 50_000)).toBe(0);
      // 20,000 seeded points over the whole city, half of them snapped to tile borders and
      // corners: the index answers exactly what scanning every tile answers.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pack.tiles) {
        minX = Math.min(minX, p.ix * TILE_SIZE_M);
        maxX = Math.max(maxX, (p.ix + 1) * TILE_SIZE_M);
        minZ = Math.min(minZ, p.iz * TILE_SIZE_M);
        maxZ = Math.max(maxZ, (p.iz + 1) * TILE_SIZE_M);
      }
      let seed = 2026;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
      for (let i = 0; i < 20_000; i++) {
        let x = minX - 50 + rnd() * (maxX - minX + 100);
        let z = minZ - 50 + rnd() * (maxZ - minZ + 100);
        if (i % 2 === 1) x = Math.round(x / TILE_SIZE_M) * TILE_SIZE_M;
        if (i % 4 >= 2) z = Math.round(z / TILE_SIZE_M) * TILE_SIZE_M;
        expect(groundHeight(world, x, z), `${x},${z}`).toBe(scanGround(pack.tiles, x, z));
      }
    },
    SF_RUN_MS,
  );
});
