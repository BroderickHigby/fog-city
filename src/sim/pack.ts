// The citywide collider pack (public/tiles/<world>/world.colliders.bin, format FCWC version 1
// with its extension block, spec in schemas/world-colliders.md) decoded into plain sim data: the
// same TileCollider objects the per-tile JSON colliders give (minus the renderer's `meta`),
// value for value, including the extension's building pieces (terrace strips, spans over a
// street) and undersides (underY), and each tile's decks, tunnels and movable spans.
//
// Every length in the pack is a whole number of centimetres and is divided by 100 here, the
// same division JSON.parse performs on the per-tile files' decimal literals, so a world built
// from the pack is bit-identical to one built from the JSON (tests/sim/pack.test.ts checks it
// against the pipeline's reference reader, pipeline/lib/world-colliders.ts, and the JSON).
//
// Pure: a DataView over the caller's bytes, no I/O. Decoding the whole city (583 tiles,
// 177,921 buildings) takes about 0.2 s in Node.

import type { BuildingCollider, Deck, Heightfield, Movable, RibbonVertex, TileCollider, Tunnel } from "./world.ts";

export const FCWC_MAGIC = "FCWC";
export const FCWC_VERSION = 1;
const TILE_RECORD_BYTES = 12;
const BUILDING_RECORD_BYTES = 20;
/** A vertex delta of this value is followed by an absolute (int32 x, int32 z) pair. */
const ESCAPE = -32768;

/** A road deck above the ground (schemas/tile-collider.schema.json decks; world.ts Deck). */
export type PackedDeck = Deck;

/** A road below the ground with a ceiling clearanceM above it (tunnels; world.ts Tunnel). */
export type PackedTunnel = Tunnel;

/** A deck piece that lifts about a hinge line (movable; world.ts Movable). */
export type PackedMovable = Movable;

/** A building with the optional underside of a structure spanning a street, path or tunnel bore. */
export type PackedBuilding = BuildingCollider & { underY?: number };

const DECK_KINDS: ReadonlyArray<PackedDeck["kind"]> = ["freeway", "ramp", "bridge", "overpass", "pier"];
const TUNNEL_KINDS: ReadonlyArray<PackedTunnel["kind"]> = ["tunnel", "underpass"];
const MOVABLE_KINDS: ReadonlyArray<PackedMovable["kind"]> = ["bascule"];
const PIECE_SUFFIX = ["", "-s", "-b"];
const NO_UNDER = -32768;
const NO_STRING = 0xffffffff;

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
  /**
   * lake (FCWC LAKE section, world QA W-11): 1 where the sample is an inland lake's water, at the
   * sample's height (its level); present only on tiles with a lake.
   */
  ground: Heightfield & { water: number[]; lake?: number[] };
  buildings: PackedBuilding[];
  /** Present only when the tile has any. */
  decks?: PackedDeck[];
  tunnels?: PackedTunnel[];
  movable?: PackedMovable[];
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
    const buildings: PackedBuilding[] = [];
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
  const extOff = dv.getUint32(28, true);
  if (extOff !== 0) decodeExtensions(bytes, dv, extOff, tiles);
  return { origin, tileSizeM, tiles };
}

/**
 * The extension block (schemas/world-colliders.md): sections `tag, u32 length, payload` from the
 * header's offset 28 to the end of the file; unknown tags are skipped. Applied in place.
 */
function decodeExtensions(bytes: Uint8Array, dv: DataView, start: number, tiles: PackedTile[]): void {
  const all: PackedBuilding[] = [];
  for (const t of tiles) for (const b of t.buildings) all.push(b);
  const strings: string[] = [];
  const str = (i: number): string | undefined => {
    if (i === NO_STRING) return undefined;
    const v = strings[i];
    if (v === undefined) throw new Error("FCWC: extension string index out of range");
    return v;
  };
  const tile = (i: number): PackedTile => {
    const t = tiles[i];
    if (!t) throw new Error("FCWC: extension tile index out of range");
    return t;
  };
  const path = (o: number): { path: RibbonVertex[]; end: number } => {
    const n = dv.getUint32(o, true);
    const out: RibbonVertex[] = [];
    let q = o + 4;
    for (let i = 0; i < n; i++, q += 16) {
      out.push([dv.getInt32(q, true) / 100, dv.getInt32(q + 4, true) / 100, dv.getInt32(q + 8, true) / 100, dv.getInt32(q + 12, true) / 100]);
    }
    return { path: out, end: q };
  };
  let o = start;
  while (o < bytes.byteLength) {
    if (o + 8 > bytes.byteLength) throw new Error("FCWC: truncated extension section");
    const tag = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    const len = dv.getUint32(o + 4, true);
    const body = o + 8;
    const end = body + len;
    if (end > bytes.byteLength || (len & 3) !== 0) throw new Error(`FCWC: extension section ${tag} is truncated`);
    const n = len >= 4 ? dv.getUint32(body, true) : 0;
    let q = body + 4;
    if (tag === "STRS") {
      for (let i = 0; i < n; i++) {
        const L = dv.getUint16(q, true);
        let v = "";
        for (let k = 0; k < L; k++) v += String.fromCharCode(bytes[q + 2 + k]!);
        strings.push(v);
        q += 2 + L;
      }
    } else if (tag === "BEXT") {
      for (let i = 0; i < n; i++, q += 8) {
        const b = all[dv.getUint32(q, true)];
        if (!b) throw new Error("FCWC: BEXT names a building past the end");
        const kind = bytes[q + 4]!;
        const u = dv.getInt16(q + 6, true);
        if (kind > 0) b.id += `${PIECE_SUFFIX[kind]}${bytes[q + 5]!}`;
        if (u !== NO_UNDER) b.underY = u / 100;
      }
    } else if (tag === "DECK") {
      for (let i = 0; i < n; i++) {
        const t = tile(dv.getUint16(q, true));
        const kind = DECK_KINDS[bytes[q + 2]!]!;
        const layer = bytes[q + 3]!;
        const id = str(dv.getUint32(q + 4, true))!;
        const edge = str(dv.getUint32(q + 8, true));
        const r = path(q + 12);
        q = r.end;
        const d: PackedDeck = edge !== undefined ? { id, kind, edge, layer, path: r.path } : { id, kind, layer, path: r.path };
        (t.decks ??= []).push(d);
      }
    } else if (tag === "TUNL") {
      for (let i = 0; i < n; i++) {
        const t = tile(dv.getUint16(q, true));
        const kind = TUNNEL_KINDS[bytes[q + 2]!]!;
        const id = str(dv.getUint32(q + 4, true))!;
        const edge = str(dv.getUint32(q + 8, true));
        const clearanceM = dv.getUint32(q + 12, true) / 100;
        const r = path(q + 16);
        q = r.end;
        const u: PackedTunnel = edge !== undefined ? { id, kind, edge, clearanceM, path: r.path } : { id, kind, clearanceM, path: r.path };
        (t.tunnels ??= []).push(u);
      }
    } else if (tag === "MOVE") {
      for (let i = 0; i < n; i++, q += 32) {
        const t = tile(dv.getUint16(q, true));
        const m: PackedMovable = {
          id: str(dv.getUint32(q + 4, true))!,
          kind: MOVABLE_KINDS[bytes[q + 2]!]!,
          deck: str(dv.getUint32(q + 8, true))!,
          hinge: [
            [dv.getInt32(q + 12, true) / 100, dv.getInt32(q + 16, true) / 100],
            [dv.getInt32(q + 20, true) / 100, dv.getInt32(q + 24, true) / 100],
          ],
          openRad: dv.getInt32(q + 28, true) / 1e6,
        };
        (t.movable ??= []).push(m);
      }
    } else if (tag === "LAKE") {
      for (let i = 0; i < n; i++) {
        const t = tile(dv.getUint16(q, true));
        const S = t.ground.nx;
        const bytesN = Math.ceil((S * S) / 8);
        const lake = new Array<number>(S * S);
        for (let k = 0; k < S * S; k++) lake[k] = (bytes[q + 4 + (k >> 3)]! >> (k & 7)) & 1;
        t.ground.lake = lake;
        q += align4(4 + bytesN);
      }
    }
    o = end;
  }
}
