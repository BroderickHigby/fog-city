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
  if (f.flags & FRONT_GARAGE && f.lengthM >= GARAGE_W + 2 * END_GAP) {
    garage = side * Math.max(0, half - END_GAP - GARAGE_W / 2);
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
    for (const w of mine.values()) {
      if (w.cls === WALL_FRONT && rows.length > 0) {
        const mx = (w.ax + w.cx) / 2;
        const mz = (w.az + w.cz) / 2;
        let best: FrontRow | null = null;
        let bestD = Infinity;
        for (const r of rows) {
          const h = (r.headingDeg * Math.PI) / 180;
          const nx = Math.sin(h);
          const nz = -Math.cos(h);
          const along = Math.abs((mx - r.x) * Math.cos(h) + (mz - r.z) * Math.sin(h));
          const off = Math.abs((mx - r.x) * nx + (mz - r.z) * nz);
          if (along > r.lengthM / 2 + 0.5) continue;
          if (off < bestD) {
            bestD = off;
            best = r;
          }
        }
        if (best && bestD < 3) {
          const r = best;
          matched.set(r, (matched.get(r) ?? 0) + 1);
          let flags = 0;
          if (r.flags & FRONT_SHOP) flags |= WF_SHOP;
          if (r.flags & FRONT_STOOP) flags |= WF_STOOP;
          if (r.flags & FRONT_BAY) flags |= WF_BAY;
          if (r.flags & FRONT_ROOFLINE) flags |= WF_ROOFLINE;
          w.floorM = r.floorM;
          const feat = facadeFeatures(r, seed);
          const h = (r.headingDeg * Math.PI) / 180;
          const rx = Math.cos(h);
          const rz = Math.sin(h);
          const dx = (w.cx - w.ax) / (Math.hypot(w.cx - w.ax, w.cz - w.az) || 1);
          const dz = (w.cz - w.az) / (Math.hypot(w.cx - w.ax, w.cz - w.az) || 1);
          const local = (s: number, half: number): number | null => {
            const fx = r.x + rx * s - w.ax;
            const fz = r.z + rz * s - w.az;
            const x = fx * dx + fz * dz;
            return x >= half && x <= w.lengthM - half ? x : null;
          };
          if (feat.garage !== null) {
            const x = local(feat.garage, GARAGE_W / 2 - 0.05);
            if (x !== null) {
              flags |= WF_GARAGE;
              w.garageX = x;
            }
          }
          if (feat.door !== null) {
            const x = local(feat.door, DOOR_W / 2 - 0.05);
            if (x !== null) {
              flags |= WF_DOOR;
              w.doorX = x;
            }
          }
          w.flags = flags;
        }
      }
      const o = 4 * w.v;
      wall[o] = Math.min(32767, Math.round(w.lengthM * 10));
      wall[o + 1] = (w.flags & 63) | (Math.min(511, Math.max(0, Math.round(w.floorM * 10))) << 6);
      wall[o + 2] = w.garageX >= 0 ? Math.round(w.garageX * 10) : -1;
      wall[o + 3] = w.doorX >= 0 ? Math.round(w.doorX * 10) : -1;
      walls.push(w);
    }
  });
  return { wall, kit, walls, buildings: buildingsOut, frontWalls: fronts.map((f) => matched.get(f) ?? 0) };
}
