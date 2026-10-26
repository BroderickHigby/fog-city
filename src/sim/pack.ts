// The citywide collider pack (public/tiles/<world>/world.colliders.bin, format FCWC version 1,
// spec in schemas/world-colliders.md) decoded into plain sim data: the same TileCollider
// objects the per-tile JSON colliders give (minus the renderer's `meta`), value for value.
//
// Every length in the pack is a whole number of centimetres and is divided by 100 here, the
// same division JSON.parse performs on the per-tile files' decimal literals, so a world built
// from the pack is bit-identical to one built from the JSON (tests/sim/pack.test.ts checks it
// against the pipeline's reference reader, pipeline/lib/world-colliders.ts, and the JSON).
//
// Pure: a DataView over the caller's bytes, no I/O. Decoding the whole city (583 tiles,
// 177,921 buildings) takes about 0.2 s in Node.

import type { BuildingCollider, Heightfield, TileCollider } from "./world.ts";

export const FCWC_MAGIC = "FCWC";
export const FCWC_VERSION = 1;
const TILE_RECORD_BYTES = 12;
const BUILDING_RECORD_BYTES = 20;
/** A vertex delta of this value is followed by an absolute (int32 x, int32 z) pair. */
const ESCAPE = -32768;

export interface ColliderPack {
  origin: { lat: number; lon: number };
  tileSizeM: number;
  /** Tiles in the pack's order (by iz, then ix, like the manifest). */
  tiles: PackedTile[];
}

/** A decoded tile: a TileCollider whose heightfield always exists and carries the water mask. */
export interface PackedTile extends TileCollider {
  ix: number;
  iz: number;
  ground: Heightfield & { water: number[] };
}

const align4 = (n: number): number => (n + 3) & ~3;

function pad7(n: number): string {
  let s = String(n);
  while (s.length < 7) s = "0" + s;
  return s;
}

/** Decode a pack. Throws on a wrong magic or version, or a truncated or inconsistent buffer. */
export function decodeColliderPack(bytes: Uint8Array): ColliderPack {
  if (bytes.byteLength < 64) throw new Error("FCWC: truncated header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== FCWC_MAGIC) throw new Error(`FCWC: bad magic "${magic}"`);
  const version = dv.getUint16(4, true);
  if (version !== FCWC_VERSION) throw new Error(`FCWC: unsupported version ${version}`);
  const headerBytes = dv.getUint16(6, true);
  const tileCount = dv.getUint32(8, true);
  const buildingCount = dv.getUint32(12, true);
  const vertexBytes = dv.getUint32(16, true);
  const s = dv.getUint16(20, true);
  const cellSizeM = dv.getUint16(22, true) / 100;
  const tileSizeM = dv.getUint32(24, true) / 100;
  const origin = { lat: dv.getFloat64(32, true), lon: dv.getFloat64(40, true) };
  const samples = s * s;
  const waterBytes = (samples + 7) >> 3;
  const tilesOff = headerBytes;
  const heightsOff = align4(tilesOff + tileCount * TILE_RECORD_BYTES);
  const waterOff = align4(heightsOff + tileCount * samples * 2);
  const buildingsOff = align4(waterOff + tileCount * waterBytes);
  const verticesOff = align4(buildingsOff + buildingCount * BUILDING_RECORD_BYTES);
  if (bytes.byteLength < verticesOff + vertexBytes) throw new Error("FCWC: truncated");

  let vOff = verticesOff;
  const vEnd = verticesOff + vertexBytes;
  const tiles: PackedTile[] = [];
  for (let ti = 0; ti < tileCount; ti++) {
    const tr = tilesOff + ti * TILE_RECORD_BYTES;
    const ix = dv.getInt16(tr, true);
    const iz = dv.getInt16(tr + 2, true);
    const first = dv.getUint32(tr + 4, true);
    const count = dv.getUint32(tr + 8, true);
    if (first + count > buildingCount) throw new Error(`FCWC: tile t${ix}_${iz} lists buildings past the end`);
    const heights = new Array<number>(samples);
    const water = new Array<number>(samples);
    const hBase = heightsOff + ti * samples * 2;
    const wBase = waterOff + ti * waterBytes;
    for (let i = 0; i < samples; i++) {
      heights[i] = dv.getInt16(hBase + i * 2, true) / 100;
      water[i] = (bytes[wBase + (i >> 3)]! >> (i & 7)) & 1;
    }
    const buildings: BuildingCollider[] = [];
    for (let bi = first; bi < first + count; bi++) {
      const br = buildingsOff + bi * BUILDING_RECORD_BYTES;
      const num = dv.getUint32(br, true);
      const part = bytes[br + 4]!;
      const flags = bytes[br + 5]!;
      const n = dv.getUint16(br + 6, true);
      const base = dv.getInt16(br + 8, true);
      const height = dv.getUint16(br + 10, true);
      let x = dv.getInt32(br + 12, true);
      let z = dv.getInt32(br + 16, true);
      const footprint: Array<[number, number]> = [[x / 100, z / 100]];
      for (let i = 1; i < n; i++) {
        if (vOff + 4 > vEnd) throw new Error("FCWC: vertex stream ends early");
        const dx = dv.getInt16(vOff, true);
        if (dx === ESCAPE) {
          if (vOff + 12 > vEnd) throw new Error("FCWC: vertex stream ends early");
          x = dv.getInt32(vOff + 4, true);
          z = dv.getInt32(vOff + 8, true);
          vOff += 12;
        } else {
          x += dx;
          z += dv.getInt16(vOff + 2, true);
          vOff += 4;
        }
        footprint.push([x / 100, z / 100]);
      }
      const id = `201006.${pad7(num)}${part ? `-${part}` : ""}${flags & 1 ? "-tower" : ""}`;
      buildings.push({ id, footprint, baseY: base / 100, topY: (base + height) / 100 });
    }
    tiles.push({
      tileId: `t${ix}_${iz}`,
      ix,
      iz,
      buildings,
      ground: { x0: ix * tileSizeM, z0: iz * tileSizeM, cellSizeM, nx: s, nz: s, heights, water },
    });
  }
  if (vOff !== vEnd) throw new Error("FCWC: vertex stream does not match the building records");
  return { origin, tileSizeM, tiles };
}
