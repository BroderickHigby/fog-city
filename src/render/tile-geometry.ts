// Tile geometry as plain typed arrays: buildings extruded from collider footprints, ground
// from heightfields, roads draped over the ground, and small props. No WebGL here, so the
// same code runs in the browser (tiles with glb: null) and in Node (src/render/tools/
// build-dev-city.ts writes it into .glb files). Both paths therefore look identical.
//
// Conventions shared with the runtime materials (materials.ts):
//  - colors are linear RGB, 8-bit normalized (glTF COLOR_0).
//  - building walls carry uv = (metres along the facade, metres above the building base)
//    and _FACADE = 4 normalized bytes (storey height / 8 m, glazing 0..1, (year - 1840) / 190
//    or 0 when unknown, roof 0|1): the same encoding the pipeline writes into the real SF
//    tiles, so one shader serves both. facadeGrid() turns it into a window layout; the
//    GLSL in materials.ts mirrors it exactly.
//  - building primitives record [buildingId, firstIndex, indexCount] ranges so a landmark
//    can hide the generated building it replaces (glTF primitive extras "fcBuildings"; the
//    pipeline puts the same list in node extras "buildings").

import { ShapeUtils, Vector2 } from "three";
import type { BuildingCollider, Heightfield } from "../sim/world.ts";
import { hashString, mix32, unit } from "./hash.ts";
import { pointAt, polylineLength, roadHalfWidth, sidewalkWidth } from "./roads.ts";
import type { GroundFn, RoadEdge } from "./types.ts";

export type RGB = [number, number, number];

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex to linear RGB. */
export function srgb(hex: number): RGB {
  return [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];
}

function scaleRgb(c: RGB, k: number): RGB {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** What a facade is, as the _FACADE attribute encodes it. */
export interface FacadeCode {
  /** Storey height, metres (2.6..8). */
  storeyM: number;
  /** Rough share of the wall that is window, 0..1. 0 = blank wall. */
  glazing: number;
  /** Year built, or null when unknown. */
  year: number | null;
}

/** Window layout derived from a facade code. Mirrored in GLSL (materials.ts: fcGrid). */
export interface FacadeGrid {
  /** Window column width and storey height, metres. */
  colW: number;
  floorH: number;
  /** Window rectangle inside one cell, as fractions [x0, x1, y0, y1]. */
  win: [number, number, number, number];
  /** Fraction of windows lit at night. */
  lit: number;
  /** Street-level storefront band height (0 = none). */
  shopH: number;
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mixN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function facadeGrid(storeyM: number, glazing: number): FacadeGrid {
  const g = Math.max(0, Math.min(1, glazing));
  const floorH = Math.max(2.6, Math.min(8, storeyM));
  const colW = g < 0.2 ? 6.0 : mixN(3.2, 1.7, smooth01(0.2, 0.9, g));
  const ww = mixN(0.42, 0.9, g);
  const wh = mixN(0.42, 0.82, g);
  const y0 = 0.08 + 0.2 * (1 - g);
  const shopH = g >= 0.8 ? 5.0 : g >= 0.35 ? Math.max(floorH, 3.8) : 0;
  return { colW, floorH, win: [0.5 - ww / 2, 0.5 + ww / 2, y0, Math.min(0.96, y0 + wh)], lit: mixN(0.36, 0.2, g), shopH };
}

/** _FACADE bytes for a wall (roof = false) or roof (roof = true) vertex. */
/** The facade code as a reader of the bytes sees it (what the shader decodes). */
export function quantizedFacade(c: FacadeCode): FacadeCode {
  const b = facadeBytes(c, false);
  return { storeyM: (b[0] / 255) * 8, glazing: b[1] / 255, year: c.year };
}

export function facadeBytes(c: FacadeCode, roof: boolean): [number, number, number, number] {
  const yearN = c.year === null ? 0 : Math.min(1, Math.max(0.02, (c.year - 1840) / 190));
  return [
    Math.round((Math.min(8, Math.max(0, c.storeyM)) / 8) * 255),
    Math.round(Math.max(0, Math.min(1, c.glazing)) * 255),
    Math.round(yearN * 255),
    roof ? 255 : 0,
  ];
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** RGB, linear, 0..255 normalized. */
  colors: Uint8Array;
  uvs: Float32Array | null;
  /** _FACADE, 4 bytes per vertex (see facadeBytes). */
  facade: Uint8Array | null;
  indices: Uint32Array;
  /** [buildingId, firstIndex, indexCount] */
  ranges: Array<[string, number, number]>;
}

const NO_FACADE: readonly [number, number, number, number] = [0, 0, 0, 0];

export class MeshBuilder {
  readonly withUv: boolean;
  readonly withFacade: boolean;
  private p: number[] = [];
  private n: number[] = [];
  private c: number[] = [];
  private uv: number[] = [];
  private f: number[] = [];
  private idx: number[] = [];
  private ranges: Array<[string, number, number]> = [];
  private rangeId: string | null = null;
  private rangeStart = 0;

  constructor(opts: { uv?: boolean; facade?: boolean } = {}) {
    this.withUv = opts.uv ?? false;
    this.withFacade = opts.facade ?? false;
  }

  get vertexCount(): number {
    return this.p.length / 3;
  }

  get indexCount(): number {
    return this.idx.length;
  }

  v(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    col: RGB,
    u = 0,
    w = 0,
    facade: readonly [number, number, number, number] = NO_FACADE,
  ): number {
    const i = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(
      Math.max(0, Math.min(255, Math.round(col[0] * 255))),
      Math.max(0, Math.min(255, Math.round(col[1] * 255))),
      Math.max(0, Math.min(255, Math.round(col[2] * 255))),
    );
    if (this.withUv) this.uv.push(u, w);
    if (this.withFacade) this.f.push(facade[0], facade[1], facade[2], facade[3]);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Triangle (a, b, c) wound so its face normal agrees with (nx, ny, nz). */
  triFacing(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const P = this.p;
    const e1x = P[b * 3]! - P[a * 3]!;
    const e1y = P[b * 3 + 1]! - P[a * 3 + 1]!;
    const e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
    const e2x = P[c * 3]! - P[a * 3]!;
    const e2y = P[c * 3 + 1]! - P[a * 3 + 1]!;
    const e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  beginRange(id: string): void {
    this.rangeId = id;
    this.rangeStart = this.idx.length;
  }

  endRange(): void {
    if (this.rangeId !== null && this.idx.length > this.rangeStart) {
      this.ranges.push([this.rangeId, this.rangeStart, this.idx.length - this.rangeStart]);
    }
    this.rangeId = null;
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      colors: new Uint8Array(this.c),
      uvs: this.withUv ? new Float32Array(this.uv) : null,
      facade: this.withFacade ? new Uint8Array(this.f) : null,
      indices: new Uint32Array(this.idx),
      ranges: this.ranges.slice(),
    };
  }
}

// ---------------------------------------------------------------------------------------
// Polygons

/** Drop repeated and closing points; null when fewer than three distinct points remain. */
export function cleanFootprint(fp: ReadonlyArray<readonly [number, number]>): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  for (const p of fp) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
    else break;
  }
  if (out.length < 3 || Math.abs(signedArea(out)) < 1e-4) return null;
  return out;
}

/** Shoelace area in the x/z plane; positive for counter-clockwise as plotted with +z up. */
export function signedArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
  return a / 2;
}

export function centroid(pts: ReadonlyArray<readonly [number, number]>): [number, number] {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    z += p[1];
  }
  return [x / pts.length, z / pts.length];
}

export function scalePolygon(pts: ReadonlyArray<readonly [number, number]>, k: number): Array<[number, number]> {
  const [cx, cz] = centroid(pts);
  return pts.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k] as [number, number]);
}

// ---------------------------------------------------------------------------------------
// Buildings

export interface BuildingLook {
  wall: RGB;
  roof: RGB;
  facade: FacadeCode;
  setback: boolean;
  penthouse: boolean;
  seed: number;
}

const PASTELS = [0xeadfc6, 0xd9c48a, 0xc5d9c7, 0xb9cfe0, 0xe8c6c2, 0xd7cfe4, 0xf1ede4, 0xd9bc93, 0xaac4b2, 0xe3d3a8, 0xc9b8a8];
const STONE = [0xd2c8b6, 0xc2b5a1, 0xaba194, 0xc8a68a, 0x9e9387, 0xdbd5c9, 0xb88e72, 0xcfc0a2];
const GLASS = [0x92a6b3, 0x7f97a5, 0xa6b6bd, 0x728a97, 0xbac4c6, 0x8899a0];
const ROOFS = [0x8d8880, 0x9b968d, 0x7c7870, 0xa38b74, 0x86888a, 0xb0a99c];

function pick(list: readonly number[], h: number): RGB {
  return srgb(list[h % list.length]!);
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Appearance from the collider alone (id, height, optional meta). Deterministic. */
export function buildingLook(b: Pick<BuildingCollider, "id" | "baseY" | "topY"> & { meta?: Record<string, unknown> }): BuildingLook {
  const h = hashString(b.id);
  const H = b.topY - b.baseY;
  const use = typeof b.meta?.use === "string" ? (b.meta.use as string).toLowerCase() : "";
  const kind = typeof b.meta?.kind === "string" ? (b.meta.kind as string).toLowerCase() : "";
  const year = metaNumber(b.meta, "year");
  const stories = metaNumber(b.meta, "stories");
  const jitter = 0.92 + unit(mix32(h, 7)) * 0.16;
  const seed = unit(mix32(h, 3));
  // Storey height from the record when it is plausible, else a typical one for the use.
  const storey = (typical: number): number => (stories && stories > 0 && H / stories >= 2.6 && H / stories <= 8 ? H / stories : typical);
  const code = (storeyM: number, glazing: number): FacadeCode => ({ storeyM, glazing, year });
  if (kind === "seawall" || kind === "wall" || kind === "plain") {
    return { wall: srgb(0xb7b1a6), roof: srgb(0x9f9a91), facade: code(3, 0), setback: false, penthouse: false, seed };
  }
  if (kind === "pier" || kind === "shed" || use.includes("industrial") || use.includes("warehouse")) {
    return { wall: scaleRgb(pick([0xc9c1ad, 0xb9b3a3, 0xd5cbb0, 0xa9b0a8], mix32(h, 1)), jitter), roof: srgb(0x8a857c), facade: code(storey(6.5), 0.15), setback: false, penthouse: false, seed };
  }
  if (H < 19) {
    const shop = use.includes("retail") || use.includes("commercial") || kind === "shop" || unit(mix32(h, 9)) < 0.3;
    return { wall: scaleRgb(pick(PASTELS, mix32(h, 1)), jitter), roof: pick(ROOFS, mix32(h, 2)), facade: code(storey(3.3), shop ? 0.4 : 0.25), setback: false, penthouse: false, seed };
  }
  if (H < 62) {
    return { wall: scaleRgb(pick(STONE, mix32(h, 1)), jitter), roof: pick(ROOFS, mix32(h, 2)), facade: code(storey(3.9), 0.5), setback: false, penthouse: unit(mix32(h, 5)) < 0.55, seed };
  }
  return { wall: scaleRgb(pick(GLASS, mix32(h, 1)), jitter), roof: srgb(0x6e7274), facade: code(storey(4.0), 0.85), setback: unit(mix32(h, 4)) < 0.75, penthouse: unit(mix32(h, 5)) < 0.4, seed };
}

/** Walls and roof of one prism. Wall u runs in whole window columns so corners never cut a window. */
function prism(
  mb: MeshBuilder,
  pts: ReadonlyArray<readonly [number, number]>,
  y0: number,
  y1: number,
  vBase: number,
  wall: RGB,
  roof: RGB | null,
  facade: FacadeCode,
  uStart: number,
): void {
  const ccw = signedArea(pts) > 0;
  // Snap with the byte-quantized code, exactly what the shader will decode.
  const q = quantizedFacade(facade);
  const grid = facadeGrid(q.storeyM, q.glazing);
  const fw = facadeBytes(facade, false);
  const fr = facadeBytes(facade, true);
  let u = uStart;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // Outward normal: right of the edge for a counter-clockwise polygon.
    const nx = (ccw ? dz : -dz) / len;
    const nz = (ccw ? -dx : dx) / len;
    const cols = Math.max(1, Math.round(len / grid.colW));
    const u1 = u + cols * grid.colW;
    const shade = wallShade(nx, nz);
    const col: RGB = [wall[0] * shade, wall[1] * shade, wall[2] * shade];
    const i0 = mb.v(a[0], y0, a[1], nx, 0, nz, col, u, y0 - vBase, fw);
    const i1 = mb.v(b[0], y0, b[1], nx, 0, nz, col, u1, y0 - vBase, fw);
    const i2 = mb.v(b[0], y1, b[1], nx, 0, nz, col, u1, y1 - vBase, fw);
    const i3 = mb.v(a[0], y1, a[1], nx, 0, nz, col, u, y1 - vBase, fw);
    mb.triFacing(i0, i1, i2, nx, 0, nz);
    mb.triFacing(i0, i2, i3, nx, 0, nz);
    u = u1;
  }
  if (!roof) return;
  const contour = pts.map(([x, z]) => new Vector2(x, z));
  let tris: number[][];
  try {
    tris = ShapeUtils.triangulateShape(contour, []);
  } catch {
    tris = [];
  }
  const base = mb.vertexCount;
  for (const [x, z] of pts) mb.v(x, y1, z, 0, 1, 0, roof, x, z, fr);
  for (const t of tris) {
    if (t.length !== 3) continue;
    mb.triFacing(base + t[0]!, base + t[1]!, base + t[2]!, 0, 1, 0);
  }
}

/** Tiny baked tint so facades read even under flat light; the real shading is the sun. */
function wallShade(nx: number, nz: number): number {
  return 0.96 + 0.04 * (nx * 0.6 - nz * 0.8);
}

export interface BuildingOptions {
  /** Walls start this far below baseY so sloped ground never shows a gap. */
  sink?: number;
  /** Add setbacks and rooftop boxes (purely visual; the collider is unchanged). */
  detail?: boolean;
}

/** Append one building. Returns false when its footprint is unusable. */
export function addBuilding(
  mb: MeshBuilder,
  b: BuildingCollider & { meta?: Record<string, unknown> },
  opts: BuildingOptions = {},
): boolean {
  const pts = cleanFootprint(b.footprint);
  if (!pts || !(b.topY > b.baseY)) return false;
  const look = buildingLook(b);
  const sink = opts.sink ?? 1.0;
  const detail = opts.detail ?? true;
  const q = quantizedFacade(look.facade);
  const spec = facadeGrid(q.storeyM, q.glazing);
  const uStart = Math.floor(look.seed * 61) * spec.colW;
  const H = b.topY - b.baseY;
  mb.beginRange(b.id);
  if (detail && look.setback && pts.length === 4 && H > 70) {
    const yMid = b.baseY + Math.round((H * 0.66) / spec.floorH) * spec.floorH;
    prism(mb, pts, b.baseY - sink, yMid, b.baseY, look.wall, look.roof, look.facade, uStart);
    prism(mb, scalePolygon(pts, 0.8), yMid, b.topY, b.baseY, look.wall, look.roof, look.facade, uStart + 31 * spec.colW);
  } else {
    prism(mb, pts, b.baseY - sink, b.topY, b.baseY, look.wall, look.roof, look.facade, uStart);
  }
  if (detail && look.penthouse && pts.length === 4 && H > 18) {
    const ph = 3.2 + look.seed * 2.5;
    prism(mb, scalePolygon(pts, 0.34), b.topY, b.topY + ph, b.topY, scaleRgb(look.roof, 1.35), look.roof, { storeyM: 3, glazing: 0, year: null }, 0);
  }
  mb.endRange();
  return true;
}

// ---------------------------------------------------------------------------------------
// Ground

export type GroundColorFn = (x: number, z: number, h: number, slope: number) => RGB;

const URBAN = srgb(0x9d978b);
const URBAN_DARK = srgb(0x8a857a);
const DRY_GRASS = srgb(0xa89a62);
const ROCK = srgb(0x77736b);
const SEABED = srgb(0x4a4f4c);

/** Default land colour when nothing better is known: paved city, golden grass on steep ground, rock at the shore. */
export const defaultGroundColor: GroundColorFn = (x, z, h, slope) => {
  if (h < -0.5) return SEABED;
  if (h < 1.2) return lerpRgb(ROCK, URBAN, Math.max(0, Math.min(1, (h + 0.5) / 1.7)));
  const n = unit(mix32(mix32(0x51ed, Math.floor(x / 23)), Math.floor(z / 23)));
  const base = lerpRgb(URBAN, URBAN_DARK, n);
  return lerpRgb(base, DRY_GRASS, Math.max(0, Math.min(1, (slope - 0.22) / 0.2)));
};

/**
 * Grid mesh over a heightfield. Cells whose four corners are all below `skipBelow` (deep
 * water, hidden by the Bay) are left out.
 */
export function addHeightfield(mb: MeshBuilder, g: Heightfield, color: GroundColorFn = defaultGroundColor, skipBelow = -2): void {
  const { nx, nz, cellSizeM: c } = g;
  if (nx < 2 || nz < 2 || g.heights.length < nx * nz) return;
  const H = (ix: number, iz: number): number => g.heights[Math.max(0, Math.min(nz - 1, iz)) * nx + Math.max(0, Math.min(nx - 1, ix))] ?? 0;
  const base = mb.vertexCount;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const h = H(ix, iz);
      const dhx = (H(ix + 1, iz) - H(ix - 1, iz)) / ((ix > 0 && ix < nx - 1 ? 2 : 1) * c);
      const dhz = (H(ix, iz + 1) - H(ix, iz - 1)) / ((iz > 0 && iz < nz - 1 ? 2 : 1) * c);
      const len = Math.hypot(dhx, 1, dhz);
      const x = g.x0 + ix * c;
      const z = g.z0 + iz * c;
      mb.v(x, h, z, -dhx / len, 1 / len, -dhz / len, color(x, z, h, Math.hypot(dhx, dhz)));
    }
  }
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      if (H(ix, iz) < skipBelow && H(ix + 1, iz) < skipBelow && H(ix, iz + 1) < skipBelow && H(ix + 1, iz + 1) < skipBelow) continue;
      const a = base + iz * nx + ix;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      mb.triFacing(a, d, b, 0, 1, 0);
      mb.triFacing(b, d, e, 0, 1, 0);
    }
  }
}

/** A flat rectangle of land at height y (tiles with no heightfield). */
export function addFlatGround(mb: MeshBuilder, minX: number, minZ: number, maxX: number, maxZ: number, y: number, col: RGB = URBAN): void {
  const a = mb.v(minX, y, minZ, 0, 1, 0, col);
  const b = mb.v(maxX, y, minZ, 0, 1, 0, col);
  const c = mb.v(maxX, y, maxZ, 0, 1, 0, col);
  const d = mb.v(minX, y, maxZ, 0, 1, 0, col);
  mb.triFacing(a, b, c, 0, 1, 0);
  mb.triFacing(a, c, d, 0, 1, 0);
}

// ---------------------------------------------------------------------------------------
// Roads

export const ROAD_COLORS = {
  asphalt: srgb(0x3d3e41),
  freeway: srgb(0x6f6e6a),
  gutter: srgb(0x77746e),
  sidewalk: srgb(0xaaa69e),
  yellow: srgb(0xd8a628),
  white: srgb(0xe6e4dc),
};

/** Heights above the ground for each road layer (metres). */
export const ROAD_LIFT = { sidewalk: 0.12, asphalt: 0.2, marking: 0.24 };

export interface RoadContext {
  ground: GroundFn;
  /** Edges meeting at each node. */
  degrees: ReadonlyMap<string, number>;
  /** Largest kerb half-width among each node's edges. */
  nodeHalfWidth: ReadonlyMap<string, number>;
  /** Largest kerb half-width + sidewalk among each node's edges. */
  nodeOuter: ReadonlyMap<string, number>;
  /** Node elevations from the road graph (bridges, viaducts). */
  nodeY?: ReadonlyMap<string, number>;
  /** Sample spacing along roads, metres (default 8). Smaller drapes better over hills. */
  step?: number;
}

interface Sample {
  x: number;
  z: number;
  s: number;
  dx: number;
  dz: number;
}

/** Samples every <= step metres along [s0, s1] of a polyline, with smoothed tangents. */
function samplesAlong(pts: ReadonlyArray<readonly [number, number]>, s0: number, s1: number, step: number): Sample[] {
  const out: Sample[] = [];
  if (s1 - s0 < 1e-3) return out;
  // Include the polyline's own vertices so bends stay sharp.
  const stops: number[] = [s0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    if (acc > s0 + 1e-3 && acc < s1 - 1e-3) stops.push(acc);
  }
  stops.push(s1);
  const ss: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    const n = Math.max(1, Math.ceil((b - a) / step));
    for (let k = 0; k < n; k++) ss.push(a + ((b - a) * k) / n);
  }
  ss.push(s1);
  for (const s of ss) {
    const p = pointAt(pts, s);
    out.push({ x: p.x, z: p.z, s, dx: p.dx, dz: p.dz });
  }
  // Average tangents at interior samples so ribbons mitre at bends.
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1]!;
    const b = out[i + 1]!;
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const l = Math.hypot(tx, tz);
    if (l > 1e-6) {
      out[i]!.dx = tx / l;
      out[i]!.dz = tz / l;
    }
  }
  return out;
}

type HeightAt = (x: number, z: number, s: number) => number;

/**
 * A ribbon through the samples. offsets are lateral positions (left negative), colors one
 * per offset (or a function of arc length for per-sample colour changes).
 */
function ribbon(
  mb: MeshBuilder,
  samples: readonly Sample[],
  offsets: readonly number[],
  colors: (s: number, j: number) => RGB,
  heightAt: HeightAt,
  ground: GroundFn,
): void {
  if (samples.length < 2) return;
  const m = offsets.length;
  const base = mb.vertexCount;
  for (const p of samples) {
    const nx = -p.dz;
    const nz = p.dx;
    for (let j = 0; j < m; j++) {
      const x = p.x + nx * offsets[j]!;
      const z = p.z + nz * offsets[j]!;
      const y = heightAt(x, z, p.s);
      const gx = ground(x + 1, z) - ground(x - 1, z);
      const gz = ground(x, z + 1) - ground(x, z - 1);
      const len = Math.hypot(gx * 0.5, 1, gz * 0.5);
      mb.v(x, y, z, (-gx * 0.5) / len, 1 / len, (-gz * 0.5) / len, colors(p.s, j));
    }
  }
  for (let i = 0; i < samples.length - 1; i++) {
    for (let j = 0; j < m - 1; j++) {
      const a = base + i * m + j;
      const b = a + 1;
      const c = a + m;
      const d = c + 1;
      mb.triFacing(a, c, b, 0, 1, 0);
      mb.triFacing(b, c, d, 0, 1, 0);
    }
  }
}

/** Extend a polyline at either end by the given lengths along its end tangents. */
function extended(pts: ReadonlyArray<readonly [number, number]>, e0: number, e1: number): Array<[number, number]> {
  const out = pts.map((p) => [p[0], p[1]] as [number, number]);
  if (out.length < 2) return out;
  if (e0 > 0) {
    const a = out[0]!;
    const b = out[1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.unshift([a[0] - ((b[0] - a[0]) / l) * e0, a[1] - ((b[1] - a[1]) / l) * e0]);
  }
  if (e1 > 0) {
    const a = out[out.length - 2]!;
    const b = out[out.length - 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push([b[0] + ((b[0] - a[0]) / l) * e1, b[1] + ((b[1] - a[1]) / l) * e1]);
  }
  return out;
}

/** Sidewalks, carriageway (with gutters), centre lines, lane lines and crosswalks for one edge. */
export function addRoad(mb: MeshBuilder, e: RoadEdge, ctx: RoadContext): void {
  if (!e.points || e.points.length < 2) return;
  const L0 = polylineLength(e.points);
  if (L0 < 0.5) return;
  const hw = roadHalfWidth(e);
  const sw = sidewalkWidth(e);
  const degA = ctx.degrees.get(e.a) ?? 1;
  const degB = ctx.degrees.get(e.b) ?? 1;
  const isFreeway = e.kind === "freeway" || e.kind === "ramp";
  const ya = ctx.nodeY?.get(e.a);
  const yb = ctx.nodeY?.get(e.b);

  // Elevated (bridge/viaduct) when the graph gives node heights well clear of the ground.
  const pa = e.points[0]!;
  const pb = e.points[e.points.length - 1]!;
  const elevated =
    ya !== undefined && yb !== undefined && (ya - ctx.ground(pa[0], pa[1]) > 2 || yb - ctx.ground(pb[0], pb[1]) > 2);

  const extA = degA >= 2 ? Math.min(hw + sw, L0 * 0.4) : 0;
  const extB = degB >= 2 ? Math.min(hw + sw, L0 * 0.4) : 0;
  const pts = extended(e.points, extA, extB);
  const L = L0 + extA + extB;
  const heightAt =
    (lift: number): HeightAt =>
    (x, z, s) =>
      elevated ? ya! + (yb! - ya!) * Math.max(0, Math.min(1, (s - extA) / L0)) + lift * 0.5 : ctx.ground(x, z) + lift;

  const step = ctx.step ?? 8;
  const all = samplesAlong(pts, 0, L, step);

  // Sidewalks (one ribbon under the carriageway; only the kerb strips show).
  if (sw > 0 && !elevated) {
    const col = ROAD_COLORS.sidewalk;
    ribbon(mb, all, [-(hw + sw), hw + sw], () => col, heightAt(ROAD_LIFT.sidewalk), ctx.ground);
  }

  // Carriageway with a lighter gutter strip at each kerb, dropped inside intersections.
  const asphalt = isFreeway ? ROAD_COLORS.freeway : ROAD_COLORS.asphalt;
  const gutter = ROAD_COLORS.gutter;
  const clrA = degA >= 3 ? (ctx.nodeHalfWidth.get(e.a) ?? hw) + extA : extA;
  const clrB = degB >= 3 ? L - (ctx.nodeHalfWidth.get(e.b) ?? hw) - extB : L - extB;
  const g = Math.min(0.45, hw * 0.12);
  ribbon(
    mb,
    all,
    [-hw, -hw + g, hw - g, hw],
    (s, j) => ((j === 0 || j === 3) && s >= clrA && s <= clrB && e.kind !== "alley" ? gutter : asphalt),
    heightAt(ROAD_LIFT.asphalt),
    ctx.ground,
  );

  if (e.kind === "alley") return;

  // Where markings may go along the original edge (arc length measured on the extended polyline).
  const crossA = degA >= 3 && !isFreeway;
  const crossB = degB >= 3 && !isFreeway;
  const nhA = ctx.nodeHalfWidth.get(e.a) ?? hw;
  const nhB = ctx.nodeHalfWidth.get(e.b) ?? hw;
  const cwLen = 3.2;
  const cwA0 = extA + (degA >= 3 ? nhA + 1.0 : 0);
  const cwB1 = extA + L0 - (degB >= 3 ? nhB + 1.0 : 0);
  const m0 = crossA ? cwA0 + cwLen + 1.2 : extA + (degA >= 3 ? nhA : 0);
  const m1 = crossB ? cwB1 - cwLen - 1.2 : extA + L0 - (degB >= 3 ? nhB : 0);
  const mark = heightAt(ROAD_LIFT.marking);

  const strip = (s0: number, s1: number, off: number, halfW: number, col: RGB): void => {
    if (s1 - s0 < 0.3) return;
    ribbon(mb, samplesAlong(pts, s0, s1, step), [off - halfW, off + halfW], () => col, mark, ctx.ground);
  };

  if (m1 > m0) {
    // Residential streets carry no centre line (as in most of San Francisco).
    if (!e.oneway && e.kind !== "residential" && (e.lanes >= 2 || hw >= 4)) {
      // Double yellow centre line.
      strip(m0, m1, -0.17, 0.06, ROAD_COLORS.yellow);
      strip(m0, m1, 0.17, 0.06, ROAD_COLORS.yellow);
      // Dashed white lane lines when there are two or more lanes each way.
      const perDir = Math.floor(e.lanes / 2);
      for (let k = 1; k < perDir; k++) {
        const off = (k * (hw - (isFreeway ? 0 : 2.4))) / perDir;
        for (let s = m0; s + 3 < m1; s += 10) {
          strip(s, s + 3, off, 0.06, ROAD_COLORS.white);
          strip(s, s + 3, -off, 0.06, ROAD_COLORS.white);
        }
      }
    } else if (e.oneway && e.lanes >= 2) {
      const lanes = e.lanes;
      const inner = hw - (isFreeway ? 0.6 : 2.4);
      for (let k = 1; k < lanes; k++) {
        const off = -inner + (2 * inner * k) / lanes;
        for (let s = m0; s + 3 < m1; s += 10) strip(s, s + 3, off, 0.06, ROAD_COLORS.white);
      }
    }
  }

  // Crosswalks at each intersection end: continental bars (along the road, spaced across it)
  // where a busy street meets the intersection, two transverse lines elsewhere.
  const crosswalk = (s0: number, busy: boolean): void => {
    const s1 = s0 + cwLen;
    if (s0 < 0 || s1 > L) return;
    if (!busy) {
      strip(s0, s0 + 0.3, 0, hw - 0.3, ROAD_COLORS.white);
      strip(s1 - 0.3, s1, 0, hw - 0.3, ROAD_COLORS.white);
      return;
    }
    const bars = Math.max(2, Math.floor((2 * hw - 1) / 1.2));
    const span = (bars - 1) * 1.2;
    for (let k = 0; k < bars; k++) strip(s0, s1, -span / 2 + k * 1.2, 0.3, ROAD_COLORS.white);
  };
  const usable = cwB1 - cwA0;
  if (crossA && usable > cwLen) crosswalk(cwA0, nhA >= 6.5);
  if (crossB && usable > (crossA ? 2 : 1) * cwLen + 0.5) crosswalk(cwB1 - cwLen, nhB >= 6.5);
}

// ---------------------------------------------------------------------------------------
// Props

const TRUNK = srgb(0x5b4a3b);
const LEAF = [srgb(0x5d7a3f), srgb(0x4f6e3a), srgb(0x6c8446), srgb(0x41613a)];

/** A low-poly tree with its base at (x, y, z). variant 0 = round canopy, 1 = cypress. */
export function addTree(mb: MeshBuilder, x: number, y: number, z: number, scale: number, rot: number, variant: number, tint = 0): void {
  const leaf = scaleRgb(LEAF[Math.abs(Math.floor(tint * 4)) % LEAF.length]!, 0.9 + (tint % 0.25));
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const P = (px: number, py: number, pz: number): [number, number, number] => [
    x + (px * cos - pz * sin) * scale,
    y + py * scale,
    z + (px * sin + pz * cos) * scale,
  ];
  const face = (a: [number, number, number], b: [number, number, number], c: [number, number, number], col: RGB, out: [number, number, number]): void => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const cx = (a[0] + b[0] + c[0]) / 3 - out[0];
    const cy = (a[1] + b[1] + c[1]) / 3 - out[1];
    const cz = (a[2] + b[2] + c[2]) / 3 - out[2];
    if (nx * cx + ny * cy + nz * cz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    const i0 = mb.v(a[0], a[1], a[2], nx / l, ny / l, nz / l, col);
    const i1 = mb.v(b[0], b[1], b[2], nx / l, ny / l, nz / l, col);
    const i2 = mb.v(c[0], c[1], c[2], nx / l, ny / l, nz / l, col);
    mb.triFacing(i0, i1, i2, nx, ny, nz);
  };
  // Trunk: a 5-sided tapered prism.
  const trunkH = variant === 1 ? 1.6 : 2.4;
  const ring = (r: number, h: number): Array<[number, number, number]> =>
    Array.from({ length: 5 }, (_, k) => P(Math.cos((k / 5) * Math.PI * 2) * r, h, Math.sin((k / 5) * Math.PI * 2) * r));
  const r0 = ring(0.22, -0.2);
  const r1 = ring(0.15, trunkH);
  const axis = P(0, trunkH / 2, 0);
  for (let k = 0; k < 5; k++) {
    const k1 = (k + 1) % 5;
    face(r0[k]!, r0[k1]!, r1[k1]!, TRUNK, axis);
    face(r0[k]!, r1[k1]!, r1[k]!, TRUNK, axis);
  }
  if (variant === 1) {
    // Cypress: two stacked hexagonal cones.
    const cone = (y0: number, y1: number, r: number, col: RGB): void => {
      const tip = P(0, y1, 0);
      const ctr = P(0, (y0 + y1) / 2, 0);
      const rr = Array.from({ length: 6 }, (_, k) => P(Math.cos((k / 6) * Math.PI * 2 + 0.3) * r, y0, Math.sin((k / 6) * Math.PI * 2 + 0.3) * r));
      for (let k = 0; k < 6; k++) {
        face(rr[k]!, rr[(k + 1) % 6]!, tip, col, ctr);
        face(rr[(k + 1) % 6]!, rr[k]!, P(0, y0, 0), scaleRgb(col, 0.7), P(0, y0 + 1, 0));
      }
    };
    cone(1.2, 7.5, 2.2, scaleRgb(leaf, 0.8));
    cone(4.5, 10.5, 1.5, scaleRgb(leaf, 0.85));
    return;
  }
  // Round canopy: an octahedron stretched and jittered into a blob.
  const cy = trunkH + 2.0;
  const rx = 2.6;
  const ry = 2.2;
  const top = P(0, cy + ry, 0);
  const bot = P(0, cy - ry * 0.8, 0);
  const mid = Array.from({ length: 6 }, (_, k) => {
    const a = (k / 6) * Math.PI * 2 + 0.4;
    const j = 0.85 + 0.3 * unit(mix32(hashString("tree"), k + Math.floor(tint * 97)));
    return P(Math.cos(a) * rx * j, cy + (k % 2 ? 0.5 : -0.3), Math.sin(a) * rx * j);
  });
  const ctr = P(0, cy, 0);
  for (let k = 0; k < 6; k++) {
    const k1 = (k + 1) % 6;
    face(mid[k]!, mid[k1]!, top, scaleRgb(leaf, 1.05), ctr);
    face(mid[k1]!, mid[k]!, bot, scaleRgb(leaf, 0.75), ctr);
  }
}
