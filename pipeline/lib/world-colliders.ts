// The binary citywide collider pack (public/tiles/<world>/world.colliders.bin), format "FCWC"
// version 1. The spec is schemas/world-colliders.md; this file is its reference encoder and
// reader. The reader is pure TypeScript over a DataView (no Node, DOM or three.js), so the sim
// can adopt it as is: the decoded tiles are the same TileCollider objects the per-tile JSON
// gives (minus `meta`), bit for bit.

export const FCWC_MAGIC = "FCWC";
export const FCWC_VERSION = 1;
const HEADER_BYTES = 64;
const TILE_RECORD_BYTES = 12;
const BUILDING_RECORD_BYTES = 20;
/** A vertex delta of this value is followed by an absolute (int32 x, int32 z) pair. */
const ESCAPE = -32768;
const ID_RE = /^201006\.(\d{7})(?:-(\d+))?(-tower)?$/;

export interface PackBuilding {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
}

export interface PackGround {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
  water: number[];
}

export interface PackTile {
  tileId: string;
  ix: number;
  iz: number;
  ground: PackGround;
  buildings: PackBuilding[];
}

export interface WorldColliders {
  origin: { lat: number; lon: number };
  tileSizeM: number;
  tiles: PackTile[];
}

const align4 = (n: number): number => (n + 3) & ~3;

function cm(v: number, what: string): number {
  const c = Math.round(v * 100);
  if (Math.abs(c / 100 - v) > 1e-9) throw new Error(`FCWC: ${what} ${v} is not a whole number of centimetres`);
  return c;
}

/** Encode a world. Tiles are written in the given order; buildings in each tile's order. */
export function encodeWorldColliders(w: WorldColliders): Uint8Array {
  if (w.tiles.length === 0) throw new Error("FCWC: no tiles");
  const s = w.tiles[0]!.ground.nx;
  const cell = w.tiles[0]!.ground.cellSizeM;
  const samples = s * s;
  const waterBytes = Math.ceil(samples / 8);
  let buildingCount = 0;
  // Vertex stream size: 4 bytes per delta, 12 for an escaped one.
  let vertexBytes = 0;
  for (const t of w.tiles) {
    const g = t.ground;
    if (g.nx !== s || g.nz !== s || g.cellSizeM !== cell) throw new Error(`FCWC: tile ${t.tileId} has a different lattice`);
    if (g.x0 !== t.ix * w.tileSizeM || g.z0 !== t.iz * w.tileSizeM) throw new Error(`FCWC: tile ${t.tileId} lattice is not at its corner`);
    for (const b of t.buildings) {
      buildingCount++;
      const f = b.footprint;
      for (let i = 1; i < f.length; i++) {
        const dx = cm(f[i]![0], "x") - cm(f[i - 1]![0], "x");
        const dz = cm(f[i]![1], "z") - cm(f[i - 1]![1], "z");
        vertexBytes += dx > -32768 && dx <= 32767 && dz > -32768 && dz <= 32767 ? 4 : 12;
      }
    }
  }
  const tilesOff = HEADER_BYTES;
  const heightsOff = align4(tilesOff + w.tiles.length * TILE_RECORD_BYTES);
  const waterOff = align4(heightsOff + w.tiles.length * samples * 2);
  const buildingsOff = align4(waterOff + w.tiles.length * waterBytes);
  const verticesOff = align4(buildingsOff + buildingCount * BUILDING_RECORD_BYTES);
  const total = align4(verticesOff + vertexBytes);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  for (let i = 0; i < 4; i++) buf[i] = FCWC_MAGIC.charCodeAt(i);
  dv.setUint16(4, FCWC_VERSION, true);
  dv.setUint16(6, HEADER_BYTES, true);
  dv.setUint32(8, w.tiles.length, true);
  dv.setUint32(12, buildingCount, true);
  dv.setUint32(16, vertexBytes, true);
  dv.setUint16(20, s, true);
  dv.setUint16(22, cm(cell, "cellSizeM"), true);
  dv.setUint32(24, cm(w.tileSizeM, "tileSizeM"), true);
  dv.setFloat64(32, w.origin.lat, true);
  dv.setFloat64(40, w.origin.lon, true);

  let bIndex = 0;
  let vOff = verticesOff;
  w.tiles.forEach((t, ti) => {
    const tr = tilesOff + ti * TILE_RECORD_BYTES;
    dv.setInt16(tr, t.ix, true);
    dv.setInt16(tr + 2, t.iz, true);
    dv.setUint32(tr + 4, bIndex, true);
    dv.setUint32(tr + 8, t.buildings.length, true);
    const g = t.ground;
    for (let i = 0; i < samples; i++) {
      const h = cm(g.heights[i]!, "height");
      if (h < -32768 || h > 32767) throw new Error(`FCWC: height ${g.heights[i]} out of int16 cm range`);
      dv.setInt16(heightsOff + (ti * samples + i) * 2, h, true);
      if (g.water[i]) buf[waterOff + ti * waterBytes + (i >> 3)]! |= 1 << (i & 7);
    }
    for (const b of t.buildings) {
      const m = ID_RE.exec(b.id);
      if (!m) throw new Error(`FCWC: building id ${b.id} does not fit the version-1 id encoding`);
      const part = m[2] === undefined ? 0 : Number(m[2]);
      if (part > 255) throw new Error(`FCWC: building ${b.id} part index > 255`);
      const f = b.footprint;
      if (f.length < 3 || f.length > 65535) throw new Error(`FCWC: building ${b.id} has ${f.length} vertices`);
      const base = cm(b.baseY, "baseY");
      const height = cm(b.topY, "topY") - base;
      if (base < -32768 || base > 32767 || height < 0 || height > 65535) throw new Error(`FCWC: building ${b.id} heights out of range`);
      const br = buildingsOff + bIndex * BUILDING_RECORD_BYTES;
      dv.setUint32(br, Number(m[1]), true);
      buf[br + 4] = part;
      buf[br + 5] = m[3] ? 1 : 0;
      dv.setUint16(br + 6, f.length, true);
      dv.setInt16(br + 8, base, true);
      dv.setUint16(br + 10, height, true);
      dv.setInt32(br + 12, cm(f[0]![0], "x"), true);
      dv.setInt32(br + 16, cm(f[0]![1], "z"), true);
      for (let i = 1; i < f.length; i++) {
        const x = cm(f[i]![0], "x");
        const z = cm(f[i]![1], "z");
        const dx = x - cm(f[i - 1]![0], "x");
        const dz = z - cm(f[i - 1]![1], "z");
        if (dx > -32768 && dx <= 32767 && dz > -32768 && dz <= 32767) {
          dv.setInt16(vOff, dx, true);
          dv.setInt16(vOff + 2, dz, true);
          vOff += 4;
        } else {
          dv.setInt16(vOff, ESCAPE, true);
          dv.setInt16(vOff + 2, 0, true);
          dv.setInt32(vOff + 4, x, true);
          dv.setInt32(vOff + 8, z, true);
          vOff += 12;
        }
      }
      bIndex++;
    }
  });
  if (vOff !== verticesOff + vertexBytes) throw new Error("FCWC: vertex stream size mismatch");
  return buf;
}

const tileIdOf = (ix: number, iz: number): string => `t${ix}_${iz}`;

/** Decode a pack. Throws on a wrong magic, version or truncated buffer. */
export function decodeWorldColliders(bytes: Uint8Array): WorldColliders {
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
  const waterBytes = Math.ceil(samples / 8);
  const tilesOff = headerBytes;
  const heightsOff = align4(tilesOff + tileCount * TILE_RECORD_BYTES);
  const waterOff = align4(heightsOff + tileCount * samples * 2);
  const buildingsOff = align4(waterOff + tileCount * waterBytes);
  const verticesOff = align4(buildingsOff + buildingCount * BUILDING_RECORD_BYTES);
  if (bytes.byteLength < verticesOff + vertexBytes) throw new Error("FCWC: truncated");

  let vOff = verticesOff;
  const tiles: PackTile[] = [];
  for (let ti = 0; ti < tileCount; ti++) {
    const tr = tilesOff + ti * TILE_RECORD_BYTES;
    const ix = dv.getInt16(tr, true);
    const iz = dv.getInt16(tr + 2, true);
    const first = dv.getUint32(tr + 4, true);
    const count = dv.getUint32(tr + 8, true);
    const heights = new Array<number>(samples);
    const water = new Array<number>(samples);
    for (let i = 0; i < samples; i++) {
      heights[i] = dv.getInt16(heightsOff + (ti * samples + i) * 2, true) / 100;
      water[i] = (bytes[waterOff + ti * waterBytes + (i >> 3)]! >> (i & 7)) & 1;
    }
    const buildings: PackBuilding[] = [];
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
        const dx = dv.getInt16(vOff, true);
        if (dx === ESCAPE) {
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
      const id = `201006.${String(num).padStart(7, "0")}${part ? `-${part}` : ""}${flags & 1 ? "-tower" : ""}`;
      buildings.push({ id, footprint, baseY: base / 100, topY: (base + height) / 100 });
    }
    tiles.push({
      tileId: tileIdOf(ix, iz),
      ix,
      iz,
      ground: { x0: ix * tileSizeM, z0: iz * tileSizeM, cellSizeM, nx: s, nz: s, heights, water },
      buildings,
    });
  }
  if (vOff !== verticesOff + vertexBytes) throw new Error("FCWC: vertex stream does not match the building records");
  return { origin, tileSizeM, tiles };
}

/**
 * O(1) ground lookup over a decoded pack: the ground mesh's two triangles per cell (split along
 * the (i+1, k)-(i, k+1) diagonal) of the tile containing (x, z), the same arithmetic as
 * src/sim/world.ts groundHeight() and Ground.meshHeightAt; 0 where there is no tile (open
 * water). A point on a tile's far border belongs to that tile when the next tile is absent.
 */
export class PackGroundIndex {
  private readonly byKey = new Map<string, PackGround>();
  private readonly tileSizeM: number;
  constructor(w: WorldColliders) {
    this.tileSizeM = w.tileSizeM;
    for (const t of w.tiles) this.byKey.set(`${t.ix},${t.iz}`, t.ground);
  }
  heightAt(x: number, z: number): number {
    const ix = Math.floor(x / this.tileSizeM);
    const iz = Math.floor(z / this.tileSizeM);
    const onX = x === ix * this.tileSizeM;
    const onZ = z === iz * this.tileSizeM;
    const g =
      this.byKey.get(`${ix},${iz}`) ??
      (onX ? this.byKey.get(`${ix - 1},${iz}`) : undefined) ??
      (onZ ? this.byKey.get(`${ix},${iz - 1}`) : undefined) ??
      (onX && onZ ? this.byKey.get(`${ix - 1},${iz - 1}`) : undefined);
    if (!g) return 0;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
    const i = Math.min(Math.max(Math.floor(fx), 0), g.nx - 2);
    const k = Math.min(Math.max(Math.floor(fz), 0), g.nz - 2);
    const tx = fx - i;
    const tz = fz - k;
    const h00 = g.heights[k * g.nx + i]!;
    const h10 = g.heights[k * g.nx + i + 1]!;
    const h01 = g.heights[(k + 1) * g.nx + i]!;
    const h11 = g.heights[(k + 1) * g.nx + i + 1]!;
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}
