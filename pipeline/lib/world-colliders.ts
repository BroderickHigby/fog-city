// The binary citywide collider pack (public/tiles/<world>/world.colliders.bin), format "FCWC"
// version 1 with the extension block. The spec is schemas/world-colliders.md; this file is its
// reference encoder and reader. The reader is pure TypeScript over a DataView (no Node, DOM or
// three.js), so the sim can adopt it as is: the decoded tiles are the same TileCollider objects
// the per-tile JSON gives (minus `meta`), bit for bit, including the extension's building
// pieces and undersides and the tiles' decks, tunnels and movable spans.

import { DECK_KINDS, MOVABLE_KINDS, TUNNEL_KINDS, type Deck, type Movable, type RibbonVertex, type Tunnel } from "./structures.ts";

export const FCWC_MAGIC = "FCWC";
export const FCWC_VERSION = 1;
const HEADER_BYTES = 64;
const TILE_RECORD_BYTES = 12;
const BUILDING_RECORD_BYTES = 20;
/** A vertex delta of this value is followed by an absolute (int32 x, int32 z) pair. */
const ESCAPE = -32768;
/** The version-1 id, plus an optional piece suffix (extension): -s<n> terrace strip, -b<n> span over a street. */
const ID_RE = /^201006\.(\d{7})(?:-(\d+))?(-tower)?(?:-([sb])(\d+))?$/;
/** Header offset of the extension block's byte offset (0 = no extensions; reserved in files before it). */
const EXT_OFFSET_AT = 28;
const NO_UNDER = -32768;
const NO_STRING = 0xffffffff;
const PIECE_KINDS = ["", "s", "b"] as const;

export interface PackBuilding {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  /** Underside of a structure spanning a street or path, or of a building over a tunnel bore (extension). */
  underY?: number;
}

export interface PackGround {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
  water: number[];
  /**
   * Extension (LAKE, world QA W-11): 1 where the sample is an inland lake's water, whose level is
   * the sample's height (the lattice is flattened across every lake); same layout as heights.
   * Present only on tiles with a lake. The tile JSON's ground.cover digits say the same.
   */
  lake?: number[];
}

export interface PackTile {
  tileId: string;
  ix: number;
  iz: number;
  ground: PackGround;
  buildings: PackBuilding[];
  /** Extension: present only when the tile has any. */
  decks?: Deck[];
  tunnels?: Tunnel[];
  movable?: Movable[];
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
  const extOff = align4(verticesOff + vertexBytes);
  const ext = encodeExtensions(w);
  const total = extOff + ext.byteLength;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  if (ext.byteLength > 0) {
    buf.set(ext, extOff);
    dv.setUint32(EXT_OFFSET_AT, extOff, true);
  }

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
      if (!m) throw new Error(`FCWC: building id ${b.id} does not fit the id encoding`);
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
  const extOff = dv.getUint32(EXT_OFFSET_AT, true);
  if (extOff !== 0) decodeExtensions(bytes, extOff, tiles);
  return { origin, tileSizeM, tiles };
}

// ---------------------------------------------------------------- extension block
//
// A sequence of sections, each `char[4] tag, u32 payload bytes (a multiple of 4), payload`, from
// the header's extension offset to the end of the file. Readers skip tags they do not know.
//   STRS  u32 n, then n strings as (u16 byte length, ASCII bytes), padded to 4
//   BEXT  u32 n, then n x (u32 building record index, u8 piece kind 0 none / 1 strip / 2 span,
//         u8 piece number, i16 underY cm or -32768 for none)
//   DECK  u32 n, then per deck (u16 tile, u8 kind, u8 layer, u32 id string, u32 edge string or
//         0xffffffff, u32 vertex count, vertices as i32 x, i32 y, i32 z, i32 w cm)
//   TUNL  u32 n, then per tunnel (u16 tile, u8 kind, u8 0, u32 id string, u32 edge string,
//         u32 clearance cm, u32 vertex count, vertices as in DECK)
//   MOVE  u32 n, then per span (u16 tile, u8 kind, u8 0, u32 id string, u32 deck string,
//         i32 hinge ax, az, bx, bz cm, i32 open angle in microradians)
//   LAKE  u32 n, then per tile with an inland lake (u16 tile, u16 0, ceil(S²/8) bytes of lake
//         flags, bit i & 7 of byte i >> 3 like the water mask, padded to 4)

class Writer {
  private buf = new Uint8Array(1024);
  private dv = new DataView(this.buf.buffer);
  length = 0;
  private need(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.need(1);
    this.buf[this.length++] = v;
  }
  u16(v: number): void {
    this.need(2);
    this.dv.setUint16(this.length, v, true);
    this.length += 2;
  }
  i16(v: number): void {
    this.need(2);
    this.dv.setInt16(this.length, v, true);
    this.length += 2;
  }
  u32(v: number): void {
    this.need(4);
    this.dv.setUint32(this.length, v, true);
    this.length += 4;
  }
  i32(v: number): void {
    this.need(4);
    this.dv.setInt32(this.length, v, true);
    this.length += 4;
  }
  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  pad4(): void {
    while (this.length & 3) this.u8(0);
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Extension strings are ASCII (ids), so every reader decodes them byte for byte. */
function ascii(v: string): Uint8Array {
  const b = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c > 127) throw new Error(`FCWC: string ${JSON.stringify(v)} is not ASCII`);
    b[i] = c;
  }
  return b;
}

function i32cm(v: number, what: string): number {
  const c = cm(v, what);
  if (c < -2147483648 || c > 2147483647) throw new Error(`FCWC: ${what} ${v} out of range`);
  return c;
}

function section(out: Writer, tag: string, body: Writer): void {
  body.pad4();
  for (let i = 0; i < 4; i++) out.u8(tag.charCodeAt(i));
  out.u32(body.length);
  out.bytes(body.done());
}

function ribbon(wr: Writer, path: readonly RibbonVertex[], what: string): void {
  if (path.length < 2) throw new Error(`FCWC: ${what} has fewer than 2 vertices`);
  wr.u32(path.length);
  for (const v of path) {
    wr.i32(i32cm(v[0], `${what} x`));
    wr.i32(i32cm(v[1], `${what} y`));
    wr.i32(i32cm(v[2], `${what} z`));
    wr.i32(i32cm(v[3], `${what} w`));
  }
}

/** The extension block for a world, or an empty array when it needs none (a plain version-1 file). */
function encodeExtensions(w: WorldColliders): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const str = (v: string | undefined): number => {
    if (v === undefined) return NO_STRING;
    let i = index.get(v);
    if (i === undefined) {
      i = strings.length;
      strings.push(v);
      index.set(v, i);
    }
    return i;
  };
  const bext = new Writer();
  let bextN = 0;
  let bi = 0;
  const deck = new Writer();
  const tunl = new Writer();
  const move = new Writer();
  const lake = new Writer();
  let nDeck = 0, nTunl = 0, nMove = 0, nLake = 0;
  w.tiles.forEach((t, ti) => {
    if (ti > 65535) throw new Error("FCWC: too many tiles for the extension block");
    const lk = t.ground.lake;
    if (lk && lk.some((v) => v === 1)) {
      const S = t.ground.nx;
      if (lk.length !== S * S) throw new Error(`FCWC: tile ${t.tileId} lake mask has ${lk.length} samples`);
      lake.u16(ti);
      lake.u16(0);
      const mask = new Uint8Array(Math.ceil((S * S) / 8));
      lk.forEach((v, i) => {
        if (v === 1) mask[i >> 3]! |= 1 << (i & 7);
      });
      lake.bytes(mask);
      lake.pad4();
      nLake++;
    }
    for (const b of t.buildings) {
      const m = ID_RE.exec(b.id);
      if (!m) throw new Error(`FCWC: building id ${b.id} does not fit the id encoding`);
      const kind = m[4] === undefined ? 0 : PIECE_KINDS.indexOf(m[4] as "s" | "b");
      const piece = m[5] === undefined ? 0 : Number(m[5]);
      if (kind > 0 && (piece < 1 || piece > 255)) throw new Error(`FCWC: building ${b.id} piece number out of 1..255`);
      if (kind > 0 || b.underY !== undefined) {
        const u = b.underY === undefined ? NO_UNDER : cm(b.underY, "underY");
        if (b.underY !== undefined && (u <= NO_UNDER || u > 32767)) throw new Error(`FCWC: building ${b.id} underY out of range`);
        bext.u32(bi);
        bext.u8(kind);
        bext.u8(piece);
        bext.i16(u);
        bextN++;
      }
      bi++;
    }
    for (const d of t.decks ?? []) {
      deck.u16(ti);
      deck.u8(DECK_KINDS.indexOf(d.kind));
      deck.u8(d.layer);
      deck.u32(str(d.id));
      deck.u32(str(d.edge));
      ribbon(deck, d.path, `deck ${d.id}`);
      nDeck++;
    }
    for (const u of t.tunnels ?? []) {
      tunl.u16(ti);
      tunl.u8(TUNNEL_KINDS.indexOf(u.kind));
      tunl.u8(0);
      tunl.u32(str(u.id));
      tunl.u32(str(u.edge));
      tunl.u32(cm(u.clearanceM, `tunnel ${u.id} clearance`));
      ribbon(tunl, u.path, `tunnel ${u.id}`);
      nTunl++;
    }
    for (const m of t.movable ?? []) {
      move.u16(ti);
      move.u8(MOVABLE_KINDS.indexOf(m.kind));
      move.u8(0);
      move.u32(str(m.id));
      move.u32(str(m.deck));
      move.i32(i32cm(m.hinge[0][0], "hinge"));
      move.i32(i32cm(m.hinge[0][1], "hinge"));
      move.i32(i32cm(m.hinge[1][0], "hinge"));
      move.i32(i32cm(m.hinge[1][1], "hinge"));
      const mu = Math.round(m.openRad * 1e6);
      if (Math.abs(mu / 1e6 - m.openRad) > 1e-12) throw new Error(`FCWC: movable ${m.id} openRad is not a whole number of microradians`);
      move.i32(mu);
      nMove++;
    }
  });
  if (bextN === 0 && nDeck === 0 && nTunl === 0 && nMove === 0 && nLake === 0) return new Uint8Array(0);
  const out = new Writer();
  if (strings.length) {
    const s = new Writer();
    s.u32(strings.length);
    for (const v of strings) {
      const b = ascii(v);
      if (b.length > 65535) throw new Error("FCWC: string too long");
      s.u16(b.length);
      s.bytes(b);
    }
    section(out, "STRS", s);
  }
  const counted = (n: number, body: Writer): Writer => {
    const wr = new Writer();
    wr.u32(n);
    wr.bytes(body.done());
    return wr;
  };
  if (bextN) section(out, "BEXT", counted(bextN, bext));
  if (nDeck) section(out, "DECK", counted(nDeck, deck));
  if (nTunl) section(out, "TUNL", counted(nTunl, tunl));
  if (nMove) section(out, "MOVE", counted(nMove, move));
  if (nLake) section(out, "LAKE", counted(nLake, lake));
  return out.done();
}

/** Apply an extension block to decoded tiles (in place): piece ids, undersides, decks, tunnels, movable spans. */
function decodeExtensions(bytes: Uint8Array, start: number, tiles: PackTile[]): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const all: PackBuilding[] = [];
  for (const t of tiles) for (const b of t.buildings) all.push(b);
  const strings: string[] = [];
  const s = (i: number): string | undefined => {
    if (i === NO_STRING) return undefined;
    const v = strings[i];
    if (v === undefined) throw new Error("FCWC: extension string index out of range");
    return v;
  };
  const tile = (i: number): PackTile => {
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
    if (end > bytes.byteLength || len & 3) throw new Error(`FCWC: extension section ${tag} is truncated`);
    const n = len >= 4 ? dv.getUint32(body, true) : 0;
    let q = body + 4;
    if (tag === "STRS") {
      for (let i = 0; i < n; i++) {
        const L = dv.getUint16(q, true);
        strings.push(String.fromCharCode(...bytes.subarray(q + 2, q + 2 + L)));
        q += 2 + L;
      }
    } else if (tag === "BEXT") {
      for (let i = 0; i < n; i++, q += 8) {
        const b = all[dv.getUint32(q, true)];
        if (!b) throw new Error("FCWC: BEXT names a building past the end");
        const kind = bytes[q + 4]!;
        const piece = bytes[q + 5]!;
        const u = dv.getInt16(q + 6, true);
        if (kind > 0) b.id += `-${PIECE_KINDS[kind]}${piece}`;
        if (u !== NO_UNDER) b.underY = u / 100;
      }
    } else if (tag === "DECK") {
      for (let i = 0; i < n; i++) {
        const t = tile(dv.getUint16(q, true));
        const kind = DECK_KINDS[bytes[q + 2]!]!;
        const layer = bytes[q + 3]!;
        const id = s(dv.getUint32(q + 4, true))!;
        const edge = s(dv.getUint32(q + 8, true));
        const r = path(q + 12);
        q = r.end;
        const d: Deck = { id, kind, ...(edge !== undefined ? { edge } : {}), layer, path: r.path };
        (t.decks ??= []).push(d);
      }
    } else if (tag === "TUNL") {
      for (let i = 0; i < n; i++) {
        const t = tile(dv.getUint16(q, true));
        const kind = TUNNEL_KINDS[bytes[q + 2]!]!;
        const id = s(dv.getUint32(q + 4, true))!;
        const edge = s(dv.getUint32(q + 8, true));
        const clearanceM = dv.getUint32(q + 12, true) / 100;
        const r = path(q + 16);
        q = r.end;
        const u: Tunnel = { id, kind, ...(edge !== undefined ? { edge } : {}), clearanceM, path: r.path };
        (t.tunnels ??= []).push(u);
      }
    } else if (tag === "MOVE") {
      for (let i = 0; i < n; i++, q += 32) {
        const t = tile(dv.getUint16(q, true));
        const m: Movable = {
          id: s(dv.getUint32(q + 4, true))!,
          kind: MOVABLE_KINDS[bytes[q + 2]!]!,
          deck: s(dv.getUint32(q + 8, true))!,
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
        const mask = bytes.subarray(q + 4, q + 4 + bytesN);
        t.ground.lake = Array.from({ length: S * S }, (_, k) => (mask[k >> 3]! >> (k & 7)) & 1);
        q += align4(4 + bytesN);
      }
    }
    o = end;
  }
}

/**
 * O(1) ground lookup over a decoded pack: bilinear over the tile containing (x, z), the same
 * arithmetic as src/sim/world.ts groundHeight(); 0 where there is no tile (open water). A point
 * on a tile's far border belongs to that tile when the next tile is absent.
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
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
}
