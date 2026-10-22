// The San Francisco house kit, runtime half (docs/qa/house-kit-spec.md; world QA W-15, W-37,
// W-46 to W-48, L-14): what the facade shader (materials.ts) needs per wall and per building,
// worked out from a tile's buildings mesh when it loads. Pure: arrays in, arrays out.
//
// The pipeline's buildings node (pipeline/lib/glb.ts header) gives every wall vertex
// uv = (metres along the footprint ring, metres above the record's street level) and
// _FACADE = (storey height / 8 m, glazing, (year - 1840) / 190, class: 0 rear or side, 85 party,
// 170 front, 255 roof), and node extras.fronts lists each facade with its storeys, the first
// floor's rise over the sidewalk and flags (bay, stoop, garage door, shopfront, roofline).
//
// The shader needs each wall's own frame, so windows are laid out from the wall's ends (no corner
// splits a window, K9) and the garage door and front door land where the facade wants them (K4,
// K7). Wall vertices are shared between neighbouring walls, so the per-wall values ride on each
// wall triangle's PROVOKING vertex (WebGL 2: the last vertex) and reach the fragment shader
// through `flat` varyings. prepareFacades re-orders each wall triangle's indices (keeping its
// winding) so its provoking vertex is the wall's bottom vertex at its start (the smallest u, then
// the smallest v), a vertex no other wall uses as its provoking vertex, and writes:
//
//   _wall (Int16 x4, per provoking vertex): wall length in dm; flags | (first floor rise in dm)
//         << 6; garage door centre along the wall in dm (-1 none); front door centre in dm (-1)
//   _kit  (Uint16 x4, per building): trim colour as RGB565; door colour as RGB565; the wall's
//         top above the street in dm; material | seed << 3 | building flags << 8
//
// and rewrites COLOR_0 with the house's palette body (K3, house-colours.ts), keeping the
// pipeline's darkening toward the foot of the wall.

import { hashString } from "./hash.ts";

/** Wall classes in _FACADE.w (pipeline/lib/house.ts). */
export const WALL_REAR = 0;
export const WALL_PARTY = 85;
export const WALL_FRONT = 170;
export const WALL_ROOF = 255;

/** Front flags in extras.fronts rows (pipeline/lib/house.ts FRONT_*). */
export const FRONT_BAY = 1;
export const FRONT_STOOP = 2;
export const FRONT_GARAGE = 4;
export const FRONT_SHOP = 8;
export const FRONT_ROOFLINE = 16;

/** Per-wall flags in _wall.y (low 6 bits). */
export const WF_GARAGE = 1;
export const WF_DOOR = 2;
export const WF_SHOP = 4;
export const WF_STOOP = 8;
export const WF_BAY = 16;
export const WF_ROOFLINE = 32;

/** Per-building flags in _kit.w >> 8. */
export const BF_LANDMARK = 1;
export const BF_RED_TILE = 2;
export const BF_ROW = 4;
export const BF_PALETTE = 8;

/** Facade materials (_kit.w & 7), drawn procedurally by the shader at real-world scale. */
export const MAT_CLAPBOARD = 0;
export const MAT_SHIPLAP = 1;
export const MAT_SHINGLE = 2;
export const MAT_STUCCO = 3;
export const MAT_BRICK = 4;
export const MAT_STONE = 5;
export const MAT_CONCRETE = 6;
export const MAT_CURTAIN = 7;
export const MATERIAL_NAMES = ["clapboard", "shiplap", "shingle", "stucco", "brick", "stone", "concrete", "curtain"] as const;

/** Garage door (K4): width and height, metres; the door's clearance to the facade's end. */
export const GARAGE_W = 2.5;
export const GARAGE_H = 2.2;
export const DOOR_W = 1.05;
const END_GAP = 0.35;
/** A storefront anchor stands 0.3 m out from its wall (pipeline storefronts.ts); this finds the wall. */
export const SHOP_ANCHOR_M = 1;
/** Over this rise (16 risers of 0.19 m, house-kit.json stoop) no stoop fits: an entry storey. */
export const ENTRY_STOREY_RISE_M = 3.04;

export interface FrontRow {
  /** Index into the node's extras.buildings. */
  record: number;
  /** The facade chord's middle, world metres. */
  x: number;
  z: number;
  /** Compass bearing the facade faces, degrees. */
  headingDeg: number;
  lengthM: number;
  streetY: number;
  /** The first floor's rise over the sidewalk, metres. */
  floorM: number;
  storeys: number;
  storeyM: number;
  flags: number;
}

/** extras.fronts rows (pipeline/lib/house.ts FrontRow) in world metres; `origin` is the tile's bbox min corner. */
export function decodeFronts(rows: unknown, originX: number, originZ: number): FrontRow[] {
  if (!Array.isArray(rows)) return [];
  const out: FrontRow[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 10) continue;
    const n = r as number[];
    out.push({
      record: n[0]!,
      x: originX + n[1]! / 10,
      z: originZ + n[2]! / 10,
      headingDeg: n[3]!,
      lengthM: n[4]! / 10,
      streetY: n[5]! / 100,
      floorM: n[6]! / 10,
      storeys: n[7]!,
      storeyM: n[8]! / 100,
      flags: n[9]!,
    });
  }
  return out;
}

/** The year a _FACADE z byte encodes (0: unknown). */
export function yearOfByte(b: number): number | null {
  return b <= 0 ? null : Math.round(1840 + (b / 255) * 190);
}

/**
 * The facade material a building is drawn in, by era and use (the pipeline's glazing classes:
 * 0.15 industrial, 0.25 houses and small buildings, 0.35 pre-1945 masonry, 0.5 later concrete,
 * 0.55 mid-century glass, 0.85 curtain wall) and a per-building hash so a block mixes them.
 *   houses to 1915: painted wood, clapboard mostly, channel siding (shiplap) and shingle
 *   houses 1916-1959 and the undated: stucco (a few wood-sided)
 *   houses 1960-1989: stucco, wood siding, a little brick
 *   houses 1990 on: stucco, fibre-cement siding, concrete
 *   industrial: brick before 1950, else concrete
 *   pre-1945 masonry: brick or terracotta and stone (taller buildings stone more often)
 *   later commercial: concrete or stucco; mid-century glass: concrete frame; curtain wall: glass
 */
export function facadeMaterial(glazing: number, year: number | null, heightM: number, h: number): number {
  const u = (h % 1000) / 1000;
  if (glazing >= 0.7) return MAT_CURTAIN;
  if (glazing >= 0.52) return MAT_CONCRETE;
  if (glazing < 0.2) return year !== null && year < 1950 ? (u < 0.8 ? MAT_BRICK : MAT_CONCRETE) : u < 0.25 ? MAT_BRICK : MAT_CONCRETE;
  if (glazing >= 0.3 && glazing < 0.42) return u < (heightM > 25 ? 0.35 : 0.6) ? MAT_BRICK : MAT_STONE;
  if (glazing >= 0.42) return u < 0.55 ? MAT_CONCRETE : MAT_STUCCO;
  // Houses and small buildings.
  if (year === null) return u < 0.88 ? MAT_STUCCO : MAT_SHIPLAP;
  if (year <= 1915) return u < 0.58 ? MAT_CLAPBOARD : u < 0.84 ? MAT_SHIPLAP : MAT_SHINGLE;
  if (year < 1960) return u < 0.9 ? MAT_STUCCO : u < 0.96 ? MAT_SHIPLAP : MAT_BRICK;
  if (year < 1990) return u < 0.55 ? MAT_STUCCO : u < 0.85 ? MAT_SHIPLAP : MAT_BRICK;
  return u < 0.5 ? MAT_STUCCO : u < 0.8 ? MAT_SHIPLAP : MAT_CONCRETE;
}

/** sRGB hex to linear 0..1 channels (glTF vertex colours are linear). */
export function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}

/** sRGB hex to RGB565 (the shader decodes it and converts to linear). */
export function rgb565(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return (((v >> 19) & 31) << 11) | (((v >> 10) & 63) << 5) | ((v >> 3) & 31);
}

export interface BuildingLookInput {
  id: string;
  year: number | null;
  glazing: number;
  heightM: number;
  /** Has party walls (a row house). */
  row: boolean;
}

export interface BuildingLookOut {
  /** Body colour (sRGB hex) for the walls, or null to keep the tile's colour. */
  body: string | null;
  trim: string;
  door: string;
  material: number;
  /** Building flags (BF_*). */
  flags: number;
}

/** Colours and material per building; the default keeps the tile's colours and derives a trim. */
export type LookFn = (b: BuildingLookInput) => BuildingLookOut;

const TRIMS = ["#f1ece0", "#e9e4d6", "#f6f3ea", "#ddd6c4"];
const DOORS = ["#5a2a22", "#23343f", "#2f4a33", "#6b4a2a", "#3b2c3f", "#1f2a2e"];

export const defaultLook: LookFn = (b) => {
  const h = hashString(b.id);
  return {
    body: null,
    trim: TRIMS[h % TRIMS.length]!,
    door: DOORS[(h >>> 4) % DOORS.length]!,
    material: facadeMaterial(b.glazing, b.year, b.heightM, h >>> 8),
    flags: b.row ? BF_ROW : 0,
  };
};

export interface FacadeMeshIn {
  /** Triangle indices, re-ordered in place. */
  index: Uint16Array | Uint32Array;
  /** POSITION as stored (any typed array; `positionStride` values per vertex, default 3) and the node's matrix to world (column-major 4x4). */
  position: ArrayLike<number>;
  positionStride?: number;
  positionOffset?: number;
  matrix: ArrayLike<number>;
  uv: ArrayLike<number>;
  /** _FACADE bytes, 4 per vertex. */
  facade: Uint8Array;
  /** COLOR_0: normalized Uint8 (rgba or rgb) or float; rewritten in place when a look gives a body. */
  color: Uint8Array | Uint16Array | Float32Array | null;
  colorItemSize: number;
  /** extras.buildings: [id, firstIndex, indexCount]. */
  ranges: ReadonlyArray<readonly [string, number, number]>;
  fronts: readonly FrontRow[];
  look?: LookFn;
  /** Storefront anchors on this tile's buildings (K5): the wall each stands on gets shop glazing. */
  shops?: ReadonlyArray<{ x: number; z: number; buildingId: string }>;
}

export interface WallInfo {
  /** Provoking vertex. */
  v: number;
  building: number;
  cls: number;
  /** Wall start and end (world x, z) and length. */
  ax: number;
  az: number;
  cx: number;
  cz: number;
  lengthM: number;
  flags: number;
  floorM: number;
  garageX: number;
  doorX: number;
}

export interface FacadeMeshOut {
  wall: Int16Array;
  kit: Uint16Array;
  walls: WallInfo[];
  /** Per building (range order): material, flags, top above street (m), colours. */
  buildings: BuildingKit[];
  /** Per fronts row (input order): how many front walls matched it (3 or more: the footprint draws its own bay). */
  frontWalls: number[];
  /** Per fronts row: the front door's place along the facade from its middle (metres, +x its right), or null. */
  frontDoors: Array<number | null>;
}

export interface BuildingKit {
  id: string;
  material: number;
  flags: number;
  /** The wall's top above the street, metres. */
  topM: number;
  year: number | null;
  glazing: number;
  /** Storey height the facade is drawn with, metres. */
  storeyM: number;
  /** The palette body (sRGB hex) when the look gave one. */
  body: string | null;
  /** The drawn wall colour at the top of the wall, linear 0..1. */
  wall: [number, number, number];
  trim: string;
  door: string;
}

/** Where a facade puts its garage door and front door (K4, K7), along its chord from the middle, metres. */
export function facadeFeatures(f: FrontRow, seed: number): { garage: number | null; door: number | null } {
  const half = f.lengthM / 2;
  const side = seed & 1 ? 1 : -1;
  let garage: number | null = null;
  let door: number | null = null;
  if (f.flags & FRONT_SHOP) return { garage: null, door: null };
  if (f.flags & FRONT_GARAGE && f.lengthM >= GARAGE_W + 0.3) {
    garage = side * Math.max(0, half - Math.min(END_GAP, (f.lengthM - GARAGE_W) / 2) - GARAGE_W / 2);
    if (f.lengthM >= GARAGE_W + DOOR_W + 4 * END_GAP) door = -side * (half - END_GAP - DOOR_W / 2);
  } else if (f.lengthM >= DOOR_W + 2 * END_GAP) {
    // A Victorian or Edwardian front: the door at one end, the bay (or windows) beside it.
    door = (f.flags & FRONT_BAY ? 1 : side) * Math.max(0, half - END_GAP - DOOR_W / 2 - (f.lengthM > 6 ? 0.25 : 0));
  }
  return { garage, door };
}

function applyMatrix(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** Prepare a tile's buildings mesh for the house-kit shader (see the file comment). */
export function prepareFacades(input: FacadeMeshIn): FacadeMeshOut {
  const { index, position, matrix, uv, facade, ranges, fronts } = input;
  const look = input.look ?? defaultLook;
  const nv = facade.length / 4;
  const wall = new Int16Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    wall[4 * i + 2] = -1;
    wall[4 * i + 3] = -1;
  }
  const kit = new Uint16Array(nv * 4);
  const ps = input.positionStride ?? 3;
  const po = input.positionOffset ?? 0;
  const world = (v: number): [number, number, number] => applyMatrix(matrix, position[ps * v + po]!, position[ps * v + po + 1]!, position[ps * v + po + 2]!);
  const walls: WallInfo[] = [];
  const buildingsOut: FacadeMeshOut["buildings"] = [];
  const frontsOf = new Map<number, FrontRow[]>();
  for (const f of fronts) (frontsOf.get(f.record) ?? frontsOf.set(f.record, []).get(f.record)!).push(f);
  const matched = new Map<FrontRow, number>();
  const doorAt = new Map<FrontRow, number>();
  const shopsOf = new Map<string, Array<{ x: number; z: number }>>();
  for (const a of input.shops ?? []) (shopsOf.get(a.buildingId) ?? shopsOf.set(a.buildingId, []).get(a.buildingId)!).push(a);
  const colorScale = input.color instanceof Uint8Array ? 255 : input.color instanceof Uint16Array ? 65535 : 1;

  ranges.forEach(([id, first, count], bi) => {
    // The building's vertices and its per-building values.
    const verts = new Set<number>();
    for (let k = first; k < first + count; k++) verts.add(index[k]!);
    if (verts.size === 0) return;
    let glazing = 0;
    let yearByte = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let topV = -Infinity;
    let hasParty = false;
    let storeyByte = 0;
    for (const v of verts) {
      storeyByte = Math.max(storeyByte, facade[4 * v]!);
      const cls = facade[4 * v + 3]!;
      glazing = Math.max(glazing, facade[4 * v + 1]! / 255);
      yearByte = Math.max(yearByte, facade[4 * v + 2]!);
      if (cls === WALL_PARTY) hasParty = true;
      const y = world(v)[1];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (cls !== WALL_ROOF) topV = Math.max(topV, uv[2 * v + 1]!);
    }
    const year = yearOfByte(yearByte);
    const L = look({ id, year, glazing, heightM: maxY - minY, row: hasParty });
    const seed = hashString(id);
    const topDm = Number.isFinite(topV) ? Math.max(0, Math.min(65535, Math.round(topV * 10))) : 0;
    const meta = (L.material & 7) | ((seed & 31) << 3) | ((L.flags & 255) << 8);
    const trim = rgb565(L.trim);
    const door = rgb565(L.door);
    for (const v of verts) {
      kit[4 * v] = trim;
      kit[4 * v + 1] = door;
      kit[4 * v + 2] = topDm;
      kit[4 * v + 3] = meta;
    }
    // K3: the palette body on the walls, keeping the tile's shading ratio (darker at the foot).
    if (L.body && input.color) {
      const col = input.color;
      const s = input.colorItemSize;
      const body = hexToLinear(L.body);
      let top = 0;
      for (const v of verts) if (facade[4 * v + 3] !== WALL_ROOF) top = Math.max(top, col[s * v]! + col[s * v + 1]! + col[s * v + 2]!);
      for (const v of verts) {
        if (facade[4 * v + 3] === WALL_ROOF) continue;
        const k = top > 0 ? (col[s * v]! + col[s * v + 1]! + col[s * v + 2]!) / top : 1;
        for (let c = 0; c < 3; c++) {
          const x = Math.min(1, body[c]! * k);
          col[s * v + c] = colorScale === 1 ? x : Math.round(x * colorScale);
        }
      }
    }
    const wallCol: [number, number, number] = [0.6, 0.58, 0.55];
    if (input.color) {
      const col = input.color;
      const s = input.colorItemSize;
      let best = -1;
      for (const v of verts) {
        if (facade[4 * v + 3] === WALL_ROOF) continue;
        const sum = col[s * v]! + col[s * v + 1]! + col[s * v + 2]!;
        if (sum > best) {
          best = sum;
          wallCol[0] = col[s * v]! / colorScale;
          wallCol[1] = col[s * v + 1]! / colorScale;
          wallCol[2] = col[s * v + 2]! / colorScale;
        }
      }
    }
    buildingsOut.push({ id, material: L.material, flags: L.flags, topM: topDm / 10, year, glazing, storeyM: Math.max(2.6, (storeyByte / 255) * 8), body: L.body, wall: wallCol, trim: L.trim, door: L.door });

    // Walls: each wall triangle's provoking vertex is its start-bottom vertex.
    const mine = new Map<number, WallInfo>();
    for (let k = first; k + 2 < first + count; k += 3) {
      const t = [index[k]!, index[k + 1]!, index[k + 2]!] as const;
      const cls = facade[4 * t[0] + 3]!;
      if (cls === WALL_ROOF) continue;
      const ys = t.map((v) => world(v)[1]);
      if (Math.abs(ys[0]! - ys[1]!) < 1e-3 && Math.abs(ys[1]! - ys[2]!) < 1e-3) continue; // a span's ceiling
      let p = 0;
      let q = 0;
      for (let j = 1; j < 3; j++) {
        const u = uv[2 * t[j]!]!, w = uv[2 * t[j]! + 1]!;
        const up = uv[2 * t[p]!]!, wp = uv[2 * t[p]! + 1]!;
        if (u < up - 1e-4 || (Math.abs(u - up) <= 1e-4 && w < wp)) p = j;
        if (u > uv[2 * t[q]!]! + 1e-4) q = j;
      }
      const lengthM = uv[2 * t[q]!]! - uv[2 * t[p]!]!;
      if (lengthM < 0.01) continue;
      // Rotate so the provoking vertex comes last, keeping the winding.
      const pv = t[p]!;
      if (p === 0) {
        index[k] = t[1];
        index[k + 1] = t[2];
        index[k + 2] = t[0];
      } else if (p === 1) {
        index[k] = t[2];
        index[k + 1] = t[0];
        index[k + 2] = t[1];
      }
      if (mine.has(pv)) continue;
      const a = world(pv);
      const c = world(t[q]!);
      const info: WallInfo = { v: pv, building: bi, cls, ax: a[0], az: a[2], cx: c[0], cz: c[2], lengthM, flags: 0, floorM: 0, garageX: -1, doorX: -1 };
      mine.set(pv, info);
    }
    // Front walls take their facade's row: storeys, floor, flags, garage and door.
    const rows = frontsOf.get(bi) ?? [];
    const wallsOf = new Map<FrontRow, WallInfo[]>();
    for (const w of mine.values()) {
      if (w.cls !== WALL_FRONT || rows.length === 0) continue;
      const mx = (w.ax + w.cx) / 2;
      const mz = (w.az + w.cz) / 2;
      let best: FrontRow | null = null;
      let bestD = Infinity;
      for (const r of rows) {
        const h = (r.headingDeg * Math.PI) / 180;
        const along = Math.abs((mx - r.x) * Math.cos(h) + (mz - r.z) * Math.sin(h));
        const off = Math.abs((mx - r.x) * Math.sin(h) - (mz - r.z) * Math.cos(h));
        if (along > r.lengthM / 2 + 0.5) continue;
        if (off < bestD) {
          bestD = off;
          best = r;
        }
      }
      if (!best || bestD >= 3) continue;
      (wallsOf.get(best) ?? wallsOf.set(best, []).get(best)!).push(w);
    }
    // One garage per house (K4), on its longest garage front; a garage front is a house, not a shop.
    let garageRow: FrontRow | null = null;
    for (const r of wallsOf.keys()) if (r.flags & FRONT_GARAGE && (!garageRow || r.lengthM > garageRow.lengthM)) garageRow = r;
    for (const [r, ws] of wallsOf) {
      matched.set(r, ws.length);
      const garageHere = r === garageRow;
      const shop = (r.flags & FRONT_SHOP) !== 0 && !garageRow;
      let flags = 0;
      if (shop) flags |= WF_SHOP;
      if (r.flags & FRONT_STOOP) flags |= WF_STOOP;
      if (r.flags & FRONT_BAY) flags |= WF_BAY;
      if (r.flags & FRONT_ROOFLINE) flags |= WF_ROOFLINE;
      // A first floor too high for a straight stoop: an entry storey at the sidewalk instead,
      // with the door on the street (K7; Assets' stoopLayout entryStorey).
      const floorM = r.floorM > ENTRY_STOREY_RISE_M ? 0 : r.floorM;
      for (const w of ws) {
        w.flags = flags;
        w.floorM = floorM;
      }
      const feat = facadeFeatures({ ...r, flags: (r.flags & ~(FRONT_GARAGE | FRONT_SHOP)) | (garageHere ? FRONT_GARAGE : 0) | (shop ? FRONT_SHOP : 0) }, seed);
      const h = (r.headingDeg * Math.PI) / 180;
      // The feature's place along each wall of the facade; it goes on the wall holding that
      // point, or else the nearest wall wide enough, clamped inside the wall.
      const place = (s: number, half: number): { w: WallInfo; x: number } | null => {
        let best: { w: WallInfo; x: number; d: number } | null = null;
        for (const w of ws) {
          if (w.lengthM < 2 * half + 0.1) continue;
          const len = Math.hypot(w.cx - w.ax, w.cz - w.az) || 1;
          const x = ((r.x + Math.cos(h) * s - w.ax) * (w.cx - w.ax) + (r.z + Math.sin(h) * s - w.az) * (w.cz - w.az)) / len;
          const d = x < 0 ? -x : x > w.lengthM ? x - w.lengthM : 0;
          if (!best || d < best.d) best = { w, x: Math.min(w.lengthM - half - 0.05, Math.max(half + 0.05, x)), d };
        }
        return best;
      };
      if (feat.garage !== null) {
        const p = place(feat.garage, GARAGE_W / 2);
        if (p) {
          p.w.flags |= WF_GARAGE;
          p.w.garageX = p.x;
        }
      }
      if (feat.door !== null) {
        const p = place(feat.door, DOOR_W / 2);
        // Never through the garage door.
        if (p && !(p.w.garageX >= 0 && Math.abs(p.x - p.w.garageX) < GARAGE_W / 2 + DOOR_W / 2 + 0.1)) {
          p.w.flags |= WF_DOOR;
          p.w.doorX = p.x;
          // Where the door ended up, along the facade's chord (the stoop climbs to it).
          const len = Math.hypot(p.w.cx - p.w.ax, p.w.cz - p.w.az) || 1;
          const px = p.w.ax + ((p.w.cx - p.w.ax) * p.x) / len, pz = p.w.az + ((p.w.cz - p.w.az) * p.x) / len;
          doorAt.set(r, (px - r.x) * Math.cos(h) + (pz - r.z) * Math.sin(h));
        }
      }
    }
    // A storefront anchor's own wall (it stands SHOP_ANCHOR_M out from it) is a shopfront,
    // unless the house has its garage door there.
    for (const a of shopsOf.get(id) ?? []) {
      let best: WallInfo | null = null;
      let bd = Infinity;
      for (const w of mine.values()) {
        if (w.cls === WALL_PARTY) continue;
        const ex = w.cx - w.ax, ez = w.cz - w.az;
        const u = Math.max(0, Math.min(1, ((a.x - w.ax) * ex + (a.z - w.az) * ez) / (ex * ex + ez * ez || 1)));
        const d = Math.hypot(a.x - w.ax - ex * u, a.z - w.az - ez * u);
        if (d < bd) {
          bd = d;
          best = w;
        }
      }
      if (best && bd <= SHOP_ANCHOR_M && !(best.flags & WF_GARAGE)) {
        best.flags = (best.flags | WF_SHOP) & ~WF_DOOR;
        best.doorX = -1;
        if (best.cls === WALL_REAR) best.cls = WALL_FRONT;
      }
    }
    for (const w of mine.values()) {
      const o = 4 * w.v;
      wall[o] = Math.min(32767, Math.round(w.lengthM * 10));
      wall[o + 1] = (w.flags & 63) | (Math.min(511, Math.max(0, Math.round(w.floorM * 10))) << 6);
      wall[o + 2] = w.garageX >= 0 ? Math.round(w.garageX * 10) : -1;
      wall[o + 3] = w.doorX >= 0 ? Math.round(w.doorX * 10) : -1;
      walls.push(w);
    }
  });
  return { wall, kit, walls, buildings: buildingsOut, frontWalls: fronts.map((f) => matched.get(f) ?? 0), frontDoors: fronts.map((f) => doorAt.get(f) ?? null) };
}

// ------------------------------------------------------------------------ window layout
//
// The facade shader's window layout (facade-shader.ts reads these tables and mirrors
// facadeOpenings exactly, less the per-window hash that leaves some rear windows out), so the
// tests can check the layout on the real tiles.

export interface WindowStyle {
  /** Column pitch along the wall, metres. */
  colW: number;
  /** Window width. */
  ww: number;
  /** Window height: clamp(storey * whK + whOff, whMin, whMax). */
  whK: number;
  whOff: number;
  whMin: number;
  whMax: number;
  /** Sill above the storey's floor. */
  sill: number;
}

export const WINDOW_STYLES = {
  /** Victorian and Edwardian wood houses: tall narrow double-hung sashes. */
  wood: { colW: 2.05, ww: 0.82, whK: 0.6, whOff: 0, whMin: 1.5, whMax: 2.4, sill: 0.72 },
  /** Interwar and postwar houses: wide windows. */
  house: { colW: 2.7, ww: 1.55, whK: 0, whOff: 1.4, whMin: 1.4, whMax: 1.4, sill: 0.85 },
  /** Houses from 1990: big panes, low sills. */
  houseModern: { colW: 2.5, ww: 1.9, whK: 0, whOff: 1.85, whMin: 1.85, whMax: 1.85, sill: 0.5 },
  /** Brick, stone and terracotta: punched openings. */
  masonry: { colW: 2.1, ww: 1.15, whK: 0.55, whOff: 0, whMin: 1.5, whMax: 2.7, sill: 0.85 },
  /** Concrete frames. */
  frame: { colW: 3.0, ww: 2.3, whK: 0.48, whOff: 0, whMin: 1.4, whMax: 2.2, sill: 0.95 },
  /** Curtain wall: vision glass between mullions, a spandrel at each slab. */
  curtain: { colW: 1.5, ww: 1.42, whK: 1, whOff: -1, whMin: 0.5, whMax: 99, sill: 1.0 },
} as const satisfies Record<string, WindowStyle>;

/** Side and rear walls: wider pitch, smaller windows (K1). */
export const REAR_STYLE = { colW: 1.45, ww: 0.85, wh: 0.85 } as const;
/** A front's windows stop this far below the roofline; side and rear walls' REAR_TOP_GAP_M (K9). */
export const FRONT_TOP_GAP_M = 0.45;
export const REAR_TOP_GAP_M = 0.3;
/** A shop's ground storey is at least this tall. */
export const SHOP_MIN_H = 3.4;

export type WindowStyleName = keyof typeof WINDOW_STYLES;

export function windowStyleName(material: number, glazing: number, year: number | null): WindowStyleName {
  const wood = material <= MAT_SHINGLE;
  const house = wood || (material === MAT_STUCCO && glazing < 0.3);
  if (wood) return "wood";
  if (house) return year !== null && year > 1989 ? "houseModern" : "house";
  if (material === MAT_BRICK || material === MAT_STONE) return "masonry";
  if (material === MAT_CURTAIN) return "curtain";
  return "frame";
}

export interface WallForLayout {
  cls: number;
  lengthM: number;
  flags: number;
  floorM: number;
  garageX: number;
  doorX: number;
}

export interface BuildingForLayout {
  material: number;
  glazing: number;
  year: number | null;
  topM: number;
  storeyM: number;
  flags: number;
}

export type Rect = [number, number, number, number];

/**
 * The openings the facade shader draws on a wall, in the wall's metres (x from its start, y above
 * the street): windows (every candidate; the shader leaves about 30% of side and rear windows
 * out), the front door and the garage door. Rows from the street up (from the raised first floor
 * on a front), only above ground on fronts.
 */
export function facadeOpenings(w: WallForLayout, b: BuildingForLayout): { windows: Rect[]; door: Rect | null; garage: Rect | null; shop: Rect | null } {
  const party = w.cls === WALL_PARTY;
  const front = w.cls === WALL_FRONT;
  const landmark = (b.flags & BF_LANDMARK) !== 0;
  const st = WINDOW_STYLES[windowStyleName(b.material, b.glazing, b.year)];
  const S = Math.min(8, Math.max(2.6, b.storeyM));
  const curtain = b.material === MAT_CURTAIN;
  let colW: number = st.colW;
  let ww: number = st.ww;
  let wh = Math.min(st.whMax, Math.max(st.whMin, S * st.whK + st.whOff));
  const rear = !front && !party;
  if (rear && !curtain) {
    colW *= REAR_STYLE.colW;
    ww *= REAR_STYLE.ww;
    wh *= REAR_STYLE.wh;
  }
  const garage: Rect | null = front && w.flags & WF_GARAGE ? [w.garageX - GARAGE_W / 2, w.garageX + GARAGE_W / 2, 0, GARAGE_H] : null;
  const shop = front && (w.flags & WF_SHOP) !== 0;
  const door: Rect | null = front && w.flags & WF_DOOR && !shop ? [w.doorX - DOOR_W / 2, w.doorX + DOOR_W / 2, w.floorM, w.floorM + 2.35] : null;
  const windows: Rect[] = [];
  // The shopfront's glass (K5): above the bulkhead, under the transom and fascia.
  const shopRect: Rect | null = shop ? [0, w.lengthM, 0.66, Math.max(Math.min(8, Math.max(2.6, b.storeyM)), SHOP_MIN_H) - 0.95] : null;
  if (party || landmark || b.glazing <= 0.04) return { windows, door, garage, shop: shopRect };
  let n = Math.floor((w.lengthM - 0.5) / colW);
  if (n < 1 && w.lengthM > ww + 0.5) n = 1;
  const margin = (w.lengthM - n * colW) * 0.5;
  const base = front ? w.floorM : 0;
  const topGap = front ? FRONT_TOP_GAP_M : REAR_TOP_GAP_M;
  // Basement windows under a raised first floor (K7), as the shader draws them.
  if (front && !shop && w.floorM >= 1.1) {
    for (let c = 0; c < n; c++) {
      const cx = margin + (c + 0.5) * colW;
      if (door && Math.abs(cx - w.doorX) < DOOR_W / 2 + 0.9) continue;
      if (garage && Math.abs(cx - w.garageX) < GARAGE_W / 2 + 0.9) continue;
      windows.push([cx - ww * 0.45, cx + ww * 0.45, w.floorM - 0.8, w.floorM - 0.3]);
    }
  }
  for (let row = 0; base + row * S + st.sill + wh <= b.topM - topGap; row++) {
    if (shop && row === 0) continue;
    for (let c = 0; c < n; c++) {
      const cx = margin + (c + 0.5) * colW;
      const r: Rect = [cx - ww / 2, cx + ww / 2, base + row * S + st.sill, base + row * S + st.sill + wh];
      if (door && row === 0 && r[0] < door[1] + 0.35 && r[1] > door[0] - 0.35) continue;
      if (garage && r[2] < GARAGE_H + 0.3 && r[0] < garage[1] + 0.3 && r[1] > garage[0] - 0.3) continue;
      if (garage && w.floorM < 1 && row === 0 && r[0] < garage[1] + 0.6 && r[1] > garage[0] - 0.6) continue;
      windows.push(r);
    }
  }
  return { windows, door, garage, shop: shopRect };
}
