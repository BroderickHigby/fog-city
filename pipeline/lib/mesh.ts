// Triangle meshes for one tile: ground, road ribbons, freeways, buildings.
// Positions are in the world frame (local metres, y up), the same frame as the colliders.

import { ShapeUtils, Vector2 } from "three";
import type { Building } from "./buildings.ts";
import type { TileRef } from "./config.ts";
import { clipSegment, distToSegment, hash32, r2, type P2 } from "./geom.ts";
import type { RoadEdge } from "./roads.ts";
import type { Deck } from "./structures.ts";
import { GROUND_CELL_M, type Ground, type Heightfield } from "./terrain.ts";

/** Texture coordinates are snapped to 1 / UV_GRID metres. */
export const UV_GRID = 32;

export class MeshData {
  positions: number[] = [];
  colors: number[] = []; // linear RGBA 0..255
  normals: number[] | null = null;
  uvs: number[] | null = null;
  facade: number[] | null = null; // 0..255 x4
  indices: number[] = [];

  constructor(opts: { normals?: boolean; uvs?: boolean; facade?: boolean } = {}) {
    if (opts.normals) this.normals = [];
    if (opts.uvs) this.uvs = [];
    if (opts.facade) this.facade = [];
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, rgba: readonly number[], extra: { n?: readonly number[]; uv?: readonly number[]; f?: readonly number[] } = {}): number {
    this.positions.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100);
    this.colors.push(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3] ?? 255);
    if (this.normals) this.normals.push(...(extra.n ?? [0, 1, 0]));
    // Texture coordinates are metres (along a wall or road, up a wall, or x and z on a roof),
    // kept on a 1/32 m grid: a float with few significant bits compresses far better, and 3 cm is
    // finer than any window or lane line drawn from them.
    if (this.uvs) {
      const uv = extra.uv ?? [0, 0];
      this.uvs.push(Math.round(uv[0]! * UV_GRID) / UV_GRID, Math.round(uv[1]! * UV_GRID) / UV_GRID);
    }
    if (this.facade) this.facade.push(...(extra.f ?? [0, 0, 0, 0]));
    return this.vertexCount - 1;
  }

  /** Add triangle a,b,c wound so its geometric normal agrees with (nx, ny, nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.positions;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const ux = p[b * 3]! - ax, uy = p[b * 3 + 1]! - ay, uz = p[b * 3 + 2]! - az;
    const vx = p[c * 3]! - ax, vy = p[c * 3 + 1]! - ay, vz = p[c * 3 + 2]! - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz < 0) this.indices.push(a, c, b);
    else this.indices.push(a, b, c);
  }
}

// ---------------------------------------------------------------- colour

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex + brightness factor -> linear RGBA bytes (glTF vertex colours are linear). */
export function rgba(hex: string, k = 1): [number, number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number): number => {
    const srgb = Math.min(1, (((v >> s) & 255) / 255) * k);
    return Math.round(srgbToLinear(srgb) * 255);
  };
  return [ch(16), ch(8), ch(0), 255];
}

const PALETTE = {
  pastel: ["#e8dcc4", "#d9c7a7", "#c9d3d8", "#e3cfc4", "#d5dcc8", "#efe6d2", "#cfc2b0", "#bfcad3", "#e6d6b8", "#d8cfc9", "#f0ece4", "#c8d6cc"],
  masonry: ["#c7b39a", "#b89f83", "#a88c74", "#c9bba5", "#9c7e6a", "#bca88c"],
  concrete: ["#b8b6ae", "#a7a8a4", "#c4c0b5", "#8f9296", "#b0aba0"],
  glass: ["#8fa3b3", "#7d93a6", "#a2b2bd", "#6f8495", "#b4bfc4", "#91a0a8"],
  industrial: ["#a65f4c", "#8e8a83", "#b07a5a", "#9a9c97", "#7f7a70"],
  roof: ["#77746f", "#6b6964", "#83807a", "#5f5d5a", "#8a857c"],
};

export interface FacadeStyle {
  wall: string;
  roof: string;
  /** Storey height, metres. */
  storeyM: number;
  /** 0..1 rough share of glazing. */
  glazing: number;
  year: number | null;
}

export function facadeStyle(b: Building): FacadeStyle {
  const h = hash32(b.id);
  const pick = (arr: string[], salt: number): string => arr[(h >>> salt) % arr.length]!;
  const height = b.topY - b.baseY;
  const year = b.meta.year ?? null;
  const use = (b.meta.use ?? "").toLowerCase();
  let wall: string;
  let glazing: number;
  if (use.includes("industrial")) {
    wall = pick(PALETTE.industrial, 3);
    glazing = 0.15;
  } else if (height >= 60 || (year !== null && year >= 1980 && height >= 25)) {
    wall = pick(PALETTE.glass, 3);
    glazing = year !== null && year < 1970 ? 0.55 : 0.85;
  } else if (use.includes("residential") || (height < 16 && !use.includes("office"))) {
    wall = pick(PALETTE.pastel, 3);
    glazing = 0.25;
  } else if (year !== null && year < 1945) {
    wall = pick(PALETTE.masonry, 3);
    glazing = 0.35;
  } else {
    wall = pick(PALETTE.concrete, 3);
    glazing = 0.5;
  }
  let storeyM = use.includes("office") ? 4.0 : use.includes("residential") ? 3.2 : use.includes("industrial") ? 5.0 : 3.6;
  const stories = b.meta.stories;
  if (stories && stories > 0 && b.meta.heightSource === "lidar") {
    storeyM = Math.min(8, Math.max(2.6, b.meta.heightM / stories));
  }
  return { wall, roof: pick(PALETTE.roof, 11), storeyM, glazing, year };
}

function facadeBytes(s: FacadeStyle, roof: boolean): number[] {
  const yearN = s.year === null ? 0 : Math.min(1, Math.max(0.02, (s.year - 1840) / 190));
  return [Math.round((Math.min(8, s.storeyM) / 8) * 255), Math.round(s.glazing * 255), Math.round(yearN * 255), roof ? 255 : 0];
}

// ---------------------------------------------------------------- ground

const WATER = "#5f7a87";
const LAND = "#8f8b82";
const LAND_HIGH = "#8d8f7f";

/**
 * Ground mesh on the tile's 10 m lattice. Cells whose four corners are all water are flat at
 * y = 0, so they are merged greedily into rectangles (an all-bay tile is one quad); every
 * other cell is two triangles split along the (i+1, k)–(i, k+1) diagonal.
 */
export function groundMesh(field: Heightfield, ground: Ground): MeshData {
  const m = new MeshData({ normals: true });
  const { nx, nz, cellSizeM: c, x0, z0 } = field;
  const water = rgba(WATER);
  const cw = nx - 1;
  const ch = nz - 1;
  const isWaterCell = (i: number, k: number): boolean =>
    field.water[k * nx + i] === 1 &&
    field.water[k * nx + i + 1] === 1 &&
    field.water[(k + 1) * nx + i] === 1 &&
    field.water[(k + 1) * nx + i + 1] === 1;

  const vid = new Int32Array(nx * nz).fill(-1);
  const v = (i: number, k: number): number => {
    const key = k * nx + i;
    if (vid[key]! >= 0) return vid[key]!;
    const x = x0 + i * c;
    const z = z0 + k * c;
    const h = field.heights[key]!;
    // Central differences on the global lattice so normals match across tile seams.
    const hx0 = ground.heightAt(x - c, z) ?? h;
    const hx1 = ground.heightAt(x + c, z) ?? h;
    const hz0 = ground.heightAt(x, z - c) ?? h;
    const hz1 = ground.heightAt(x, z + c) ?? h;
    let n = [-(hx1 - hx0) / (2 * c), 1, -(hz1 - hz0) / (2 * c)];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    n = n.map((q) => Math.round((q / len) * 10000) / 10000);
    const col = field.water[key] === 1 ? water : rgba(h > 40 ? LAND_HIGH : LAND, 0.94 + Math.min(0.1, h / 600));
    vid[key] = m.vertex(x, h, z, col, { n });
    return vid[key]!;
  };

  const done = new Uint8Array(cw * ch);
  for (let k = 0; k < ch; k++) {
    for (let i = 0; i < cw; i++) {
      if (done[k * cw + i]) continue;
      if (!isWaterCell(i, k)) {
        done[k * cw + i] = 1;
        const v00 = v(i, k), v10 = v(i + 1, k), v01 = v(i, k + 1), v11 = v(i + 1, k + 1);
        m.tri(v00, v01, v10, 0, 1, 0);
        m.tri(v10, v01, v11, 0, 1, 0);
        continue;
      }
      // Greedy: widen along i, then grow along k while the whole span stays water.
      let w = 1;
      while (i + w < cw && !done[k * cw + i + w] && isWaterCell(i + w, k)) w++;
      let hgt = 1;
      grow: while (k + hgt < ch) {
        for (let q = 0; q < w; q++) if (done[(k + hgt) * cw + i + q] || !isWaterCell(i + q, k + hgt)) break grow;
        hgt++;
      }
      for (let kk = 0; kk < hgt; kk++) for (let q = 0; q < w; q++) done[(k + kk) * cw + i + q] = 1;
      const a = v(i, k), b = v(i + w, k), cc = v(i, k + hgt), d = v(i + w, k + hgt);
      m.tri(a, cc, b, 0, 1, 0);
      m.tri(b, cc, d, 0, 1, 0);
    }
  }
  return m;
}

// ---------------------------------------------------------------- roads

const ROAD_COLOR: Record<string, string> = {
  freeway: "#47494c",
  ramp: "#47494c",
  arterial: "#3a3c3f",
  collector: "#3d3f42",
  residential: "#404244",
  alley: "#4b4b49",
  other: "#57554f",
  pedestrian: "#8a8276",
};

const MAX_STEP_M = 8;

/** Densify a polyline so no segment is longer than MAX_STEP_M; returns points with distance along. */
function densify(points: readonly P2[], step = MAX_STEP_M): Array<{ p: P2; s: number }> {
  const out: Array<{ p: P2; s: number }> = [{ p: points[0]!, s: 0 }];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      out.push({ p: [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], s: s + (len * k) / n });
    }
    s += len;
  }
  return out;
}

/** Runs of the polyline inside the tile box (clipped exactly at the box edges). */
function clipRuns(pts: Array<{ p: P2; s: number }>, box: TileRef["bbox"]): Array<Array<{ p: P2; s: number }>> {
  const runs: Array<Array<{ p: P2; s: number }>> = [];
  let cur: Array<{ p: P2; s: number }> | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const r = clipSegment(a.p, b.p, box);
    if (!r) {
      cur = null;
      continue;
    }
    const at = (t: number): { p: P2; s: number } => ({
      p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t],
      s: a.s + (b.s - a.s) * t,
    });
    const start = at(r[0]);
    const end = at(r[1]);
    if (!cur || r[0] > 0) {
      cur = [start];
      runs.push(cur);
    }
    if (Math.hypot(end.p[0] - cur[cur.length - 1]!.p[0], end.p[1] - cur[cur.length - 1]!.p[1]) > 1e-6) cur.push(end);
    if (r[1] < 1) cur = null;
  }
  return runs.filter((r) => r.length >= 2);
}

/** Lift of a draped ribbon over the ground mesh (W-09: within 5 cm of the ground the sim drives on). */
export const DRAPE_LIFT_M = 0.02;
/** A ribbon triangle whose ground stays this close to one plane is drawn whole, not draped piece by piece. */
const DRAPE_FLAT_M = 0.015;
/** The glb position grid (glb.ts POSITION_STEP_M): draped vertices are placed on it. */
export const GLB_GRID_M = 1 / 64;
/** Station spacing of a draped ribbon. */
const DRAPE_STEP_M = 40;
/** Texture coordinates of a junction polygon: plain asphalt, no kerb strip or lane line. */
export const JUNCTION_UV: readonly [number, number] = [0.25, 0];

/**
 * Clip a convex polygon (x, z) to the ground mesh's triangles (each lattice cell split along its
 * (i+1, k)-(i, k+1) diagonal, as groundMesh draws it): every piece lies in one triangle, and its
 * vertices take that triangle's plane, so a ribbon drawn from the pieces lies on the mesh exactly.
 */
export function drapePolygon(poly: readonly P2[], ground: Ground, emit: (piece: Array<[number, number, number]>) => void): void {
  const c = GROUND_CELL_M;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const clip = (pts: P2[], ax: number, az: number, bx: number, bz: number): P2[] => {
    // Keep the left of a->b (the triangles below are wound so their inside is on the left).
    const side = (p: P2): number => (bx - ax) * (p[1] - az) - (bz - az) * (p[0] - ax);
    const out: P2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  };
  for (let gx = Math.floor(x0 / c); gx * c < x1; gx++) {
    for (let gz = Math.floor(z0 / c); gz * c < z1; gz++) {
      const ax = gx * c, az = gz * c;
      const h = (x: number, z: number): number => ground.meshHeightAt(x, z) ?? 0;
      const h00 = h(ax, az), h10 = h(ax + c, az), h01 = h(ax, az + c), h11 = h(ax + c, az + c);
      // The two triangles of the cell, each with its corners (counter-clockwise in x, z) and plane.
      const tris: Array<{ pts: Array<[number, number]>; y: (x: number, z: number) => number }> = [
        { pts: [[ax, az], [ax + c, az], [ax, az + c]], y: (x, z) => h00 + ((h10 - h00) * (x - ax)) / c + ((h01 - h00) * (z - az)) / c },
        { pts: [[ax + c, az], [ax + c, az + c], [ax, az + c]], y: (x, z) => h11 + ((h01 - h11) * (ax + c - x)) / c + ((h10 - h11) * (az + c - z)) / c },
      ];
      for (const t of tris) {
        let piece: P2[] = poly.map((p) => [p[0], p[1]] as P2);
        for (let e = 0; e < 3 && piece.length >= 3; e++) {
          const [pax, paz] = t.pts[e]!;
          const [pbx, pbz] = t.pts[(e + 1) % 3]!;
          piece = clip(piece, pax, paz, pbx, pbz);
        }
        // Drop slivers (all but collinear) and duplicate points.
        const clean: P2[] = [];
        for (const p of piece) {
          const last = clean[clean.length - 1];
          if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-4) clean.push(p);
        }
        while (clean.length > 1 && Math.hypot(clean[0]![0] - clean[clean.length - 1]![0], clean[0]![1] - clean[clean.length - 1]![1]) <= 1e-4) clean.pop();
        if (clean.length < 3) continue;
        let area = 0;
        for (let i = 0; i < clean.length; i++) {
          const a = clean[i]!, b = clean[(i + 1) % clean.length]!;
          area += a[0] * b[1] - b[0] * a[1];
        }
        if (Math.abs(area) < 1e-4) continue;
        emit(clean.map(([x, z]) => [x, t.y(x, z), z]));
      }
    }
  }
}

/** A ribbon is trimmed no further than this from its junction. */
const TRIM_MAX_M = 30;
/** How far out along each street the trims look for the other streets' ribbons, metres. */
const TRIM_REACH_M = 40;

/** One street end at a junction: its ribbon from the node, straight along its first metres. */
interface JunctionEnd {
  key: string;
  edge: RoadEdge;
  fromStart: boolean;
  /** Unit direction away from the node. */
  ux: number;
  uz: number;
  h: number;
  L: number;
  t: number;
}

/** True if two rectangles (four corners each, in order) overlap by more than 1 cm (separating axes). */
function rectsOverlap(a: readonly P2[], b: readonly P2[]): boolean {
  for (const r of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const p = r[i]!, q = r[i + 1]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const ax = (q[0] - p[0]) / len, az = (q[1] - p[1]) / len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of a) { const d = x * ax + z * az; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, z] of b) { const d = x * ax + z * az; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= 0.01) return false;
    }
  }
  return true;
}

/** A street end's ribbon from `t0` to `t1` along its first direction, the node at the origin. */
function endRect(q: { ux: number; uz: number; h: number }, t0: number, t1: number): P2[] {
  const nx = -q.uz * q.h, nz = q.ux * q.h;
  return [
    [q.ux * t0 + nx, q.uz * t0 + nz],
    [q.ux * t1 + nx, q.uz * t1 + nz],
    [q.ux * t1 - nx, q.uz * t1 - nz],
    [q.ux * t0 - nx, q.uz * t0 - nz],
  ];
}

/**
 * The kerb points of a street end's ribbon from the node to where its trimmed ribbon begins
 * (`t` along the street), every 2 m: the hull of these covers the trimmed-off ribbon even where
 * the street curves.
 */
function endKerbs(e: RoadEdge, fromStart: boolean, t: number): P2[] {
  const L = polylineLength(e.points);
  const hw = e.widthM / 2;
  const reach = Math.min(t, L / 2);
  const out: P2[] = [];
  const n = Math.max(1, Math.ceil(reach / 2));
  for (let i = 0; i <= n; i++) {
    const d = (reach * i) / n;
    const [x, z, dx, dz] = pointDirAt(e.points, fromStart ? d : L - d);
    out.push([x - dz * hw, z + dx * hw], [x + dz * hw, z - dx * hw]);
  }
  return out;
}

/** Street ends at each node where three or more streets meet, trimmed (junctionRadii). */
function junctionEnds(edges: readonly RoadEdge[]): Map<string, JunctionEnd[]> {
  const ends = new Map<string, JunctionEnd[]>();
  for (const e of edges) {
    if (e.kind === "freeway" || e.kind === "ramp") continue;
    const L = polylineLength(e.points);
    for (const [n, fromStart] of [[e.a, true], [e.b, false]] as const) {
      const [, , dx, dz] = pointDirAt(e.points, fromStart ? Math.min(2, L / 2) : Math.max(L - 2, L / 2));
      const l = ends.get(n) ?? ends.set(n, []).get(n)!;
      l.push({ key: `${e.id}|${fromStart ? "a" : "b"}`, edge: e, fromStart, ux: fromStart ? dx : -dx, uz: fromStart ? dz : -dz, h: e.widthM / 2, L, t: 0 });
    }
  }
  for (const [n, l] of [...ends]) {
    if (l.length < 3) {
      ends.delete(n);
      continue;
    }
    const node = l[0]!.fromStart ? l[0]!.edge.points[0]! : l[0]!.edge.points[l[0]!.edge.points.length - 1]!;
    const cap = (q: JunctionEnd): number => Math.min(TRIM_MAX_M, q.L / 2);
    // Each ribbon stops where it clears every other street's ribbon from the node out (two
    // rectangles along the streets' first directions), and no nearer than the widest street's
    // half width. Streets leaving all but parallel are left to ribbonHalfWidths.
    const base = Math.max(...l.map((q) => q.h));
    for (const q of l) {
      let t = base;
      for (const o of l) {
        if (o === q) continue;
        const cos = q.ux * o.ux + q.uz * o.uz;
        const sin = Math.abs(q.ux * o.uz - q.uz * o.ux);
        if (cos > 0 && sin < 0.05) continue;
        const other = endRect(o, 0, TRIM_REACH_M);
        if (!rectsOverlap(endRect(q, t, t + TRIM_REACH_M), other)) continue;
        let lo = t, hi = cap(q);
        if (rectsOverlap(endRect(q, hi, hi + TRIM_REACH_M), other)) {
          t = hi;
          continue;
        }
        for (let i = 0; i < 20 && hi - lo > 0.01; i++) {
          const mid = (lo + hi) / 2;
          if (rectsOverlap(endRect(q, mid, mid + TRIM_REACH_M), other)) lo = mid;
          else hi = mid;
        }
        t = hi;
      }
      q.t = Math.min(t, cap(q));
    }
    // The junction polygon is the hull of the trimmed ends' kerb points: a ribbon the hull
    // still reaches into stops where the hull ends instead.
    for (let pass = 0; pass < 4; pass++) {
      const hull = convexHull([...l.flatMap((q) => endKerbs(q.edge, q.fromStart, q.t)), node]);
      let moved = false;
      for (const q of l) {
        // The hull clipped to the ribbon's strip (just inside its kerbs), in the node's frame.
        let poly: P2[] = hull.map(([x, z]) => [x - node[0], z - node[1]]);
        const nx = -q.uz, nz = q.ux;
        const keep = (sign: number): void => {
          const side = (p: P2): number => q.h * 0.98 - sign * (p[0] * nx + p[1] * nz);
          const out: P2[] = [];
          for (let i = 0; i < poly.length; i++) {
            const p = poly[i]!, r = poly[(i + 1) % poly.length]!;
            const sp = side(p), sr = side(r);
            if (sp >= 0) out.push(p);
            if ((sp >= 0) !== (sr >= 0)) {
              const f = sp / (sp - sr);
              out.push([p[0] + (r[0] - p[0]) * f, p[1] + (r[1] - p[1]) * f]);
            }
          }
          poly = out;
        };
        keep(1);
        keep(-1);
        let reach = 0;
        for (const [x, z] of poly) reach = Math.max(reach, x * q.ux + z * q.uz);
        const t = Math.min(reach, cap(q));
        if (t > q.t + 0.05) {
          q.t = t;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  return ends;
}

/**
 * Where three or more streets meet (W-32), how far short of the node each ribbon stops, keyed
 * `<edge id>|a` or `<edge id>|b`: far enough that it clears every other street's ribbon and the
 * junction polygon (junctionEnds); at most TRIM_MAX_M, or half the edge.
 */
export function junctionRadii(edges: readonly RoadEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of junctionEnds(edges).values()) for (const q of l) out.set(q.key, r2(q.t));
  return out;
}

/**
 * Junction polygons (W-32): where three or more streets meet, the convex hull of the kerbs their
 * ribbons give up (junctionRadii from the node), drawn as one patch of plain asphalt. Keyed by
 * node id.
 */
export function junctionPolygons(edges: readonly RoadEdge[], radii: ReadonlyMap<string, number>, nodes: ReadonlyMap<string, { x: number; z: number }>): Map<string, P2[]> {
  const pts = new Map<string, P2[]>();
  for (const e of edges) {
    if (e.kind === "freeway" || e.kind === "ramp") continue;
    for (const [n, fromStart] of [[e.a, true], [e.b, false]] as const) {
      const r = radii.get(`${e.id}|${fromStart ? "a" : "b"}`);
      if (r === undefined) continue;
      const l = pts.get(n) ?? pts.set(n, []).get(n)!;
      l.push(...endKerbs(e, fromStart, r));
    }
  }
  const out = new Map<string, P2[]>();
  for (const [n, p] of [...pts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const node = nodes.get(n);
    if (node) p.push([node.x, node.z]);
    const hull = convexHull(p);
    if (hull.length >= 3) out.set(n, hull);
  }
  return out;
}

function polylineLength(pts: readonly P2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return L;
}

/** Point and unit direction at arc length s. */
function pointDirAt(pts: readonly P2[], s: number): [number, number, number, number] {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + L >= s || i === pts.length - 1) {
      const t = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, L > 0 ? (b[0] - a[0]) / L : 1, L > 0 ? (b[1] - a[1]) / L : 0];
    }
    acc += L;
  }
  return [pts[0]![0], pts[0]![1], 1, 0];
}

/** Convex hull (monotone chain), counter-clockwise in (x, z). */
function convexHull(points: readonly P2[]): P2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Where narrowed ribbons are sampled, metres. */
const NARROW_STEP_M = 4;
/** A ribbon is never narrowed under this half width. */
const NARROW_MIN_HALF_M = 1;

/**
 * Half widths for street ribbons that run beside another street's (W-32): where two centrelines
 * run within 30 degrees of parallel closer than their half widths together (a divided street's
 * carriageways, a frontage road), each ribbon gives up its share of the overlap so their kerbs
 * meet instead of z-fighting. Per edge, the half width every NARROW_STEP_M along it (absent: the
 * edge is never narrowed). Freeways (their own node) and stairs are left alone.
 */
export function ribbonHalfWidths(edges: readonly RoadEdge[], nodes: ReadonlyMap<string, { x: number; z: number }>): Map<string, number[]> {
  const drawn = edges.filter((e) => !(e.kind === "freeway" || e.kind === "ramp"));
  const CELL = 25;
  const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
  const grid = new Map<number, Array<[RoadEdge, number]>>();
  for (const e of drawn) {
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!, b = e.points[i]!;
      for (let cx = Math.floor(Math.min(a[0], b[0]) / CELL); cx <= Math.floor(Math.max(a[0], b[0]) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(a[1], b[1]) / CELL); cz <= Math.floor(Math.max(a[1], b[1]) / CELL); cz++) {
          (grid.get(key(cx, cz)) ?? grid.set(key(cx, cz), []).get(key(cx, cz))!).push([e, i]);
        }
      }
    }
  }
  const out = new Map<string, number[]>();
  for (const e of drawn) {
    const half = e.widthM / 2;
    const L = polylineLength(e.points);
    const n = Math.max(1, Math.ceil(L / NARROW_STEP_M));
    const halves: number[] = [];
    let narrowed = false;
    for (let k = 0; k <= n; k++) {
      const s = (L * k) / n;
      const [x, z, dx, dz] = pointDirAt(e.points, s);
      let h = half;
      const reach = half + 12;
      const seen = new Set<string>();
      for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) {
        for (let cz = Math.floor((z - reach) / CELL); cz <= Math.floor((z + reach) / CELL); cz++) {
          for (const [o, i] of grid.get(key(cx, cz)) ?? []) {
            if (o === e) continue;
            const id = `${o.id}#${i}`;
            if (seen.has(id)) continue;
            seen.add(id);
            // Near a node the two share, the overlap is the junction's (its polygon), not a
            // side-by-side street's.
            const shared = [e.a, e.b].filter((n) => n === o.a || n === o.b).map((n) => nodes.get(n)!);
            if (shared.some((n) => Math.hypot(n.x - x, n.z - z) < half + o.widthM / 2 + 2)) continue;
            const a = o.points[i - 1]!, b = o.points[i]!;
            const q = distToSegment(x, z, a, b);
            if (q.d >= half + o.widthM / 2) continue;
            const ox = b[0] - a[0], oz = b[1] - a[1];
            const ol = Math.hypot(ox, oz) || 1;
            if (Math.abs((ox * dx + oz * dz) / ol) < Math.cos(Math.PI / 6)) continue; // not side by side
            h = Math.min(h, Math.max(NARROW_MIN_HALF_M, (q.d * e.widthM) / (e.widthM + o.widthM)));
          }
        }
      }
      if (h < half - 0.01) narrowed = true;
      halves.push(r2(h));
    }
    if (narrowed) out.set(e.id, halves);
  }
  return out;
}

/**
 * Road ribbons for one tile.
 *   - On the ground, a ribbon is draped on the ground mesh (drapePolygon) DRAPE_LIFT_M over it,
 *     so the drawn road and the ground agree everywhere (W-09, W-10).
 *   - `surface(edge, s)` is the road's own surface where it is not the ground (a deck, a bore, an
 *     underpass: decks.ts): drawn level across at that height.
 *   - Where three or more streets meet, each ribbon stops its `radii` entry short of the node and the
 *     junction polygon (junctionPolygons) covers the crossing once (W-32): `junctions` are the
 *     polygons whose node lies in this tile.
 */
export function roadMeshes(
  edges: readonly RoadEdge[],
  tile: TileRef,
  ground: Ground,
  surface: (edge: string, s: number) => number | null = () => null,
  radii: ReadonlyMap<string, number> = new Map(),
  junctions: ReadonlyArray<readonly P2[]> = [],
  halves: ReadonlyMap<string, readonly number[]> = new Map(),
): { roads: MeshData; freeways: MeshData } {
  const roads = new MeshData({ uvs: true });
  const freeways = new MeshData({ uvs: true });
  // Draped pieces share their edges: one vertex per (position, colour, uv).
  const caches = new Map<MeshData, Map<string, number>>([[roads, new Map()], [freeways, new Map()]]);
  const shared = (m: MeshData, x0: number, y0: number, z0: number, col: readonly number[], uv: readonly [number, number]): number => {
    // The vertex goes where the tile's glb will put it (x and z on the position grid), and keeps
    // its height over the ground there: on a cliff a centimetre across is centimetres up.
    const x = Math.round(x0 / GLB_GRID_M) * GLB_GRID_M, z = Math.round(z0 / GLB_GRID_M) * GLB_GRID_M;
    const g0 = ground.meshHeightAt(x0, z0), g1 = ground.meshHeightAt(x, z);
    const y = g0 !== null && g1 !== null ? y0 + g1 - g0 : y0;
    const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)},${col.join(",")},${Math.round(uv[0] * 32)},${Math.round(uv[1] * 32)}`;
    const cache = caches.get(m)!;
    let id = cache.get(key);
    if (id === undefined) {
      id = m.vertex(x, y, z, col, { uv });
      cache.set(key, id);
    }
    return id;
  };
  const asphalt = rgba(ROAD_COLOR.residential!);
  for (const poly of junctions) {
    drapePolygon(poly, ground, (piece) => {
      const ids = piece.map(([x, y, z]) => shared(roads, x, y + DRAPE_LIFT_M, z, asphalt, JUNCTION_UV));
      for (let i = 1; i + 1 < ids.length; i++) roads.tri(ids[0]!, ids[i]!, ids[i + 1]!, 0, 1, 0);
    });
  }
  for (const e of edges) {
    const target = e.kind === "freeway" || e.kind === "ramp" ? freeways : roads;
    const col = rgba(ROAD_COLOR[e.pedestrian ? "pedestrian" : e.kind] ?? ROAD_COLOR.other!);
    const narrow = halves.get(e.id);
    const Ltot = narrow ? polylineLength(e.points) : 0;
    /** The ribbon's half width at arc length s: the edge's, or narrowed beside another street. */
    const halfAt = (s: number): number => {
      if (!narrow) return e.widthM / 2;
      const f = Math.max(0, Math.min(narrow.length - 1, (s / (Ltot || 1)) * (narrow.length - 1)));
      const i = Math.min(narrow.length - 2, Math.floor(f));
      if (narrow.length === 1) return narrow[0]!;
      return narrow[i]! + (narrow[i + 1]! - narrow[i]!) * (f - i);
    };
    const isFreeway = target === freeways;
    // Trim at junctions.
    const L = polylineLength(e.points);
    const s0 = isFreeway ? 0 : Math.min(radii.get(`${e.id}|a`) ?? 0, L / 2);
    const s1 = isFreeway ? L : Math.max(L - (radii.get(`${e.id}|b`) ?? 0), L / 2);
    if (s1 - s0 < 0.05) continue;
    // A draped ribbon follows the ground whatever its stations, so they need only follow the
    // centreline (DRAPE_STEP_M at most); a road with a structure keeps MAX_STEP_M stations.
    const dense = densify(e.points, narrow ? NARROW_STEP_M : e.deck || e.tunnel ? MAX_STEP_M : DRAPE_STEP_M).filter((q) => q.s > s0 && q.s < s1);
    const [ax, az] = pointDirAt(e.points, s0);
    const [bx, bz] = pointDirAt(e.points, s1);
    const trimmed = [{ p: [ax, az] as P2, s: s0 }, ...dense, { p: [bx, bz] as P2, s: s1 }];
    for (const clipped of clipRuns(trimmed, tile.bbox)) {
      // Freeways over the bay with no deck are bridges the world does not model: not drawn.
      // Split the run so skipped stretches emit no vertices either.
      const runs: Array<typeof clipped> = [];
      let cur: typeof clipped = [clipped[0]!];
      for (let i = 1; i < clipped.length; i++) {
        const a = clipped[i - 1]!.p;
        const b = clipped[i]!.p;
        if (isFreeway && ground.waterAt(a[0], a[1]) && ground.waterAt(b[0], b[1]) && (surface(e.id, clipped[i - 1]!.s) === null || surface(e.id, clipped[i]!.s) === null)) {
          if (cur.length >= 2) runs.push(cur);
          cur = [clipped[i]!];
        } else {
          cur.push(clipped[i]!);
        }
      }
      if (cur.length >= 2) runs.push(cur);
      for (const run of runs) {
        // Kerb points, the road's own surface where it has one, and texture coordinates.
        const K = run.map(({ p, s }, i) => {
          const prev = run[Math.max(0, i - 1)]!.p;
          const next = run[Math.min(run.length - 1, i + 1)]!.p;
          let dx = next[0] - prev[0];
          let dz = next[1] - prev[1];
          const len = Math.hypot(dx, dz) || 1;
          dx /= len;
          dz /= len;
          // Perpendicular (to the right of travel on a north-up map is (-dz, dx)).
          const px = -dz, pz = dx;
          const half = halfAt(s);
          return { l: [p[0] - px * half, p[1] - pz * half] as P2, r: [p[0] + px * half, p[1] + pz * half] as P2, s, own: surface(e.id, s), c: p };
        });
        const vOf = (s: number): number => Math.round(s * 100) / 100;
        for (let i = 1; i < K.length; i++) {
          const A = K[i - 1]!, B = K[i]!;
          // The road's own surface is drawn where it stands clear of the ground (a deck) or under
          // it (a bore, an underpass) at both ends; near the ground it is draped like any road.
          const off = (k: typeof A): number => {
            if (k.own === null) return 0;
            const g = [k.l, k.r, k.c].map(([x, z]) => ground.meshHeightAt(x, z) ?? 0);
            return k.own - Math.max(...g) > 0.2 ? 1 : k.own - Math.min(...g) < -0.2 ? -1 : 0;
          };
          const oa = off(A), ob = off(B);
          if (oa !== 0 && oa === ob) {
            // On a deck, in a bore or an underpass: level across, at the road's own height. A deck
            // low over a hump the samples straddle is lifted so the ground never shows through it.
            let ya = A.own ?? (ground.meshHeightAt(A.c[0], A.c[1]) ?? 0) + DRAPE_LIFT_M;
            let yb = B.own ?? (ground.meshHeightAt(B.c[0], B.c[1]) ?? 0) + DRAPE_LIFT_M;
            if (oa === 1) {
              const n = Math.max(1, Math.ceil(Math.hypot(B.c[0] - A.c[0], B.c[1] - A.c[1]) / 0.5));
              const m = Math.max(1, Math.ceil(Math.max(Math.hypot(A.r[0] - A.l[0], A.r[1] - A.l[1]), Math.hypot(B.r[0] - B.l[0], B.r[1] - B.l[1])) / 0.5));
              let poke = -Infinity;
              for (let q = 0; q <= n; q++) {
                const t = q / n;
                for (let w = 0; w <= m; w++) {
                  const u = w / m;
                  const x = A.l[0] + (A.r[0] - A.l[0]) * u + (B.l[0] + (B.r[0] - B.l[0]) * u - (A.l[0] + (A.r[0] - A.l[0]) * u)) * t;
                  const z = A.l[1] + (A.r[1] - A.l[1]) * u + (B.l[1] + (B.r[1] - B.l[1]) * u - (A.l[1] + (A.r[1] - A.l[1]) * u)) * t;
                  const g = ground.meshHeightAt(x, z);
                  if (g !== null) poke = Math.max(poke, g + DRAPE_LIFT_M - (ya + (yb - ya) * t));
                }
              }
              if (poke > 0) {
                ya += poke;
                yb += poke;
              }
            }
            const la = target.vertex(A.l[0], ya, A.l[1], col, { uv: [0, vOf(A.s)] });
            const ra = target.vertex(A.r[0], ya, A.r[1], col, { uv: [1, vOf(A.s)] });
            const lb = target.vertex(B.l[0], yb, B.l[1], col, { uv: [0, vOf(B.s)] });
            const rb = target.vertex(B.r[0], yb, B.r[1], col, { uv: [1, vOf(B.s)] });
            target.tri(la, ra, lb, 0, 1, 0);
            target.tri(ra, rb, lb, 0, 1, 0);
            continue;
          }
          // On the ground: the quad's two triangles, each draped on the mesh. Texture
          // coordinates come from the point's place across (u) and along (v) the quad.
          const ux = B.c[0] - A.c[0], uz = B.c[1] - A.c[1];
          const ul = Math.hypot(ux, uz) || 1;
          const uv = (x: number, z: number): [number, number] => {
            const t = Math.max(0, Math.min(1, ((x - A.c[0]) * ux + (z - A.c[1]) * uz) / (ul * ul)));
            // Across: interpolate the kerb line at t, then the fraction between the kerbs.
            const lx = A.l[0] + (B.l[0] - A.l[0]) * t, lz = A.l[1] + (B.l[1] - A.l[1]) * t;
            const rx = A.r[0] + (B.r[0] - A.r[0]) * t, rz = A.r[1] + (B.r[1] - A.r[1]) * t;
            const wx = rx - lx, wz = rz - lz;
            const w2 = wx * wx + wz * wz || 1;
            const u = Math.max(0, Math.min(1, ((x - lx) * wx + (z - lz) * wz) / w2));
            return [u, vOf(A.s + (B.s - A.s) * t)];
          };
          // Each of the quad's two triangles is drawn whole where the mesh under it is (all but)
          // one plane, else draped on the mesh's own triangles. Both the ribbon and the mesh are
          // linear between the overlay's vertices, so checking those is exact.
          for (const tri of [[A.l, A.r, B.l], [A.r, B.r, B.l]] as Array<[P2, P2, P2]>) {
            const pieces: Array<Array<[number, number, number]>> = [];
            drapePolygon(tri, ground, (piece) => pieces.push(piece));
            const ys = tri.map(([x, z]) => ground.meshHeightAt(x, z) ?? 0);
            const den = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
            const plane = (x: number, z: number): number => {
              if (Math.abs(den) < 1e-9) return ys[0]!;
              const u = ((x - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (z - tri[0][1])) / den;
              const v = ((tri[1][0] - tri[0][0]) * (z - tri[0][1]) - (x - tri[0][0]) * (tri[1][1] - tri[0][1])) / den;
              return ys[0]! + (ys[1]! - ys[0]!) * u + (ys[2]! - ys[0]!) * v;
            };
            if (pieces.every((pc) => pc.every(([x, y, z]) => Math.abs(plane(x, z) - y) <= DRAPE_FLAT_M))) {
              const ids = tri.map(([x, z], k) => shared(target, x, ys[k]! + DRAPE_LIFT_M, z, col, uv(x, z)));
              target.tri(ids[0]!, ids[1]!, ids[2]!, 0, 1, 0);
              continue;
            }
            for (const piece of pieces) {
              const ids = piece.map(([x, y, z]) => shared(target, x, y + DRAPE_LIFT_M, z, col, uv(x, z)));
              for (let q = 1; q + 1 < ids.length; q++) target.tri(ids[0]!, ids[q]!, ids[q + 1]!, 0, 1, 0);
            }
          }
        }
      }
    }
  }
  return { roads, freeways };
}

// ---------------------------------------------------------------- structures

const CONCRETE = "#9a978f";
/** Deck slab depth under the road surface. */
const DECK_DEPTH_M = 1.2;
/** Column spacing along an elevated deck, and the smallest gap under a deck that gets columns. */
const COLUMN_SPACING_M = 30;
const COLUMN_MIN_GAP_M = 2;
const COLUMN_HALF_M = 0.8;

/**
 * The structure of a tile's decks (decks.ts): each elevated deck's two side faces and underside,
 * DECK_DEPTH_M deep, and square columns down to the ground every COLUMN_SPACING_M (two side by
 * side under a wide deck). The road surface itself is the road ribbon (roadMeshes).
 */
export function deckMesh(decks: readonly Deck[], ground: Ground): MeshData {
  const m = new MeshData({ normals: true });
  const col = rgba(CONCRETE);
  for (const d of decks) {
    const p = d.path;
    if (p.length < 2) continue;
    const gnd = p.map(([x, , z]) => ground.meshHeightAt(x, z) ?? 0);
    const perp = p.map((_, i) => {
      const a = p[Math.max(0, i - 1)]!;
      const b = p[Math.min(p.length - 1, i + 1)]!;
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const L = Math.hypot(dx, dz) || 1;
      return [-dz / L, dx / L] as const;
    });
    // Sides and underside, between consecutive vertices that both stand clear of the ground.
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!, b = p[i]!;
      if (a[1] - DECK_DEPTH_M < gnd[i - 1]! + 0.3 && b[1] - DECK_DEPTH_M < gnd[i]! + 0.3) continue;
      const [pax, paz] = perp[i - 1]!, [pbx, pbz] = perp[i]!;
      const ha = a[3] / 2, hb = b[3] / 2;
      for (const side of [-1, 1]) {
        const ax = a[0] + side * pax * ha, az = a[2] + side * paz * ha;
        const bx = b[0] + side * pbx * hb, bz = b[2] + side * pbz * hb;
        const nl = Math.hypot(pax + pbx, paz + pbz) || 1;
        const nx = (side * (pax + pbx)) / nl, nz = (side * (paz + pbz)) / nl;
        const v0 = m.vertex(ax, a[1], az, col, { n: [nx, 0, nz] });
        const v1 = m.vertex(bx, b[1], bz, col, { n: [nx, 0, nz] });
        const v2 = m.vertex(ax, a[1] - DECK_DEPTH_M, az, col, { n: [nx, 0, nz] });
        const v3 = m.vertex(bx, b[1] - DECK_DEPTH_M, bz, col, { n: [nx, 0, nz] });
        m.tri(v0, v2, v1, nx, 0, nz);
        m.tri(v1, v2, v3, nx, 0, nz);
      }
      const l0 = m.vertex(a[0] - pax * ha, a[1] - DECK_DEPTH_M, a[2] - paz * ha, col, { n: [0, -1, 0] });
      const r0 = m.vertex(a[0] + pax * ha, a[1] - DECK_DEPTH_M, a[2] + paz * ha, col, { n: [0, -1, 0] });
      const l1 = m.vertex(b[0] - pbx * hb, b[1] - DECK_DEPTH_M, b[2] - pbz * hb, col, { n: [0, -1, 0] });
      const r1 = m.vertex(b[0] + pbx * hb, b[1] - DECK_DEPTH_M, b[2] + pbz * hb, col, { n: [0, -1, 0] });
      m.tri(l0, r0, l1, 0, -1, 0);
      m.tri(r0, r1, l1, 0, -1, 0);
    }
    // Columns.
    let s = 0;
    let next = COLUMN_SPACING_M / 2;
    for (let i = 0; i < p.length; i++) {
      if (i > 0) s += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![2] - p[i - 1]![2]);
      if (s < next) continue;
      next = s + COLUMN_SPACING_M;
      const [x, y, z, w] = p[i]!;
      const top = y - DECK_DEPTH_M;
      if (top - gnd[i]! < COLUMN_MIN_GAP_M) continue;
      const [px, pz] = perp[i]!;
      const offsets = w > 12 ? [-w / 4, w / 4] : [0];
      for (const o of offsets) {
        const cx = x + px * o, cz = z + pz * o;
        const foot = (ground.meshHeightAt(cx, cz) ?? gnd[i]!) - 0.5;
        const c: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let k = 0; k < 4; k++) {
          const [ux, uz] = c[k]!, [vx, vz] = c[(k + 1) % 4]!;
          const cl = Math.hypot(ux + vx, uz + vz) || 1;
          const nx = (ux + vx) / cl, nz = (uz + vz) / cl;
          const q0 = m.vertex(cx + ux * COLUMN_HALF_M, top, cz + uz * COLUMN_HALF_M, col, { n: [nx, 0, nz] });
          const q1 = m.vertex(cx + vx * COLUMN_HALF_M, top, cz + vz * COLUMN_HALF_M, col, { n: [nx, 0, nz] });
          const q2 = m.vertex(cx + ux * COLUMN_HALF_M, foot, cz + uz * COLUMN_HALF_M, col, { n: [nx, 0, nz] });
          const q3 = m.vertex(cx + vx * COLUMN_HALF_M, foot, cz + vz * COLUMN_HALF_M, col, { n: [nx, 0, nz] });
          m.tri(q0, q2, q1, nx, 0, nz);
          m.tri(q1, q2, q3, nx, 0, nz);
        }
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------- buildings

/**
 * Party walls (W-36): where two records share a wall exactly (the same two vertices, which
 * shared-walls.ts guarantees for walls that touch), the part of each one's wall that the other
 * covers can never be seen. Per record id, per edge index (edge i runs from vertex i to i + 1):
 * the [bottom, top] height spans the neighbours cover. Neighbours in other tiles count.
 */
export function partyWalls(buildings: readonly Building[]): Map<string, Array<Array<[number, number]>>> {
  const key = (a: P2, b: P2): string => {
    const p = `${a[0]},${a[1]}`;
    const q = `${b[0]},${b[1]}`;
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  const span = (b: Building): [number, number] => [wallBottom(b), b.topY];
  const edges = new Map<string, Array<{ id: string; i: number }>>();
  for (const b of buildings) {
    const f = b.footprint;
    for (let i = 0; i < f.length; i++) {
      const k = key(f[i]!, f[(i + 1) % f.length]!);
      const l = edges.get(k);
      if (l) l.push({ id: b.id, i });
      else edges.set(k, [{ id: b.id, i }]);
    }
  }
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const out = new Map<string, Array<Array<[number, number]>>>();
  for (const l of edges.values()) {
    if (l.length < 2) continue;
    for (const a of l) {
      for (const o of l) {
        if (o.id === a.id) continue;
        let arr = out.get(a.id);
        if (!arr) out.set(a.id, (arr = []));
        (arr[a.i] ??= []).push(span(byId.get(o.id)!));
      }
    }
  }
  return out;
}

/**
 * Where a record's walls start: a tower on its podium's roof, anything else at its foot (a span
 * over a street at its underside, which is its footY; a building over a tunnel bore stands on
 * the hill as drawn, its underside hidden in the ground).
 */
export function wallBottom(b: Building): number {
  if (b.meta.towerOf !== undefined && b.meta.podiumTopY !== undefined) return b.meta.podiumTopY;
  return b.meta.footY;
}

/** The parts of [y0, y1] that no span in `cover` hides, in order. */
function visibleSpans(y0: number, y1: number, cover: ReadonlyArray<readonly [number, number]> | undefined): Array<[number, number]> {
  let out: Array<[number, number]> = [[y0, y1]];
  for (const [c0, c1] of cover ?? []) {
    const next: Array<[number, number]> = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.01);
}

function prism(
  m: MeshData,
  ring: readonly P2[],
  y0: number,
  y1: number,
  baseY: number,
  wall: string,
  roof: string,
  style: FacadeStyle,
  cover?: ReadonlyArray<ReadonlyArray<readonly [number, number]> | undefined>,
  underside = false,
): void {
  const n = ring.length;
  const fw = facadeBytes(style, false);
  const fr = facadeBytes(style, true);
  const top = rgba(wall);
  const bottom = rgba(wall, 0.8);
  // Walls: one shared bottom/top vertex pair per ring vertex, plus a seam copy so u is continuous;
  // a wall a neighbour partly hides gets its own quads for the parts that show.
  const b: number[] = [];
  const t: number[] = [];
  const us: number[] = [];
  let u = 0;
  for (let i = 0; i <= n; i++) {
    const p = ring[i % n]!;
    if (i > 0) {
      const q = ring[i - 1]!;
      u += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    us.push(Math.round(u * 100) / 100);
  }
  const vAt = (y: number): number => Math.round((y - baseY) * 100) / 100;
  // Full-height wall vertices, made only for the walls drawn whole.
  const bt = (i: number): void => {
    if (b[i] !== undefined) return;
    const p = ring[i % n]!;
    b[i] = m.vertex(p[0], y0, p[1], bottom, { uv: [us[i]!, vAt(y0)], f: fw });
    t[i] = m.vertex(p[0], y1, p[1], top, { uv: [us[i]!, vAt(y1)], f: fw });
  };
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const c = ring[(i + 1) % n]!;
    // Outward normal of a ring that is counter-clockwise on a north-up map.
    const ox = -(c[1] - a[1]);
    const oz = c[0] - a[0];
    const hidden = cover?.[i];
    if (!hidden || hidden.length === 0) {
      bt(i);
      bt(i + 1);
      m.tri(b[i]!, b[i + 1]!, t[i + 1]!, ox, 0, oz);
      m.tri(b[i]!, t[i + 1]!, t[i]!, ox, 0, oz);
      continue;
    }
    for (const [s0, s1] of visibleSpans(y0, y1, hidden)) {
      const k = (y: number): number => (y - y0) / (y1 - y0 || 1);
      const col0 = rgba(wall, 0.8 + 0.2 * k(s0));
      const col1 = rgba(wall, 0.8 + 0.2 * k(s1));
      // A span that reaches the wall's foot or top reuses the full-height vertices there.
      let q0: number, q1: number, q2: number, q3: number;
      if (s0 === y0) {
        bt(i);
        bt(i + 1);
        q0 = b[i]!;
        q1 = b[i + 1]!;
      } else {
        q0 = m.vertex(a[0], s0, a[1], col0, { uv: [us[i]!, vAt(s0)], f: fw });
        q1 = m.vertex(c[0], s0, c[1], col0, { uv: [us[i + 1]!, vAt(s0)], f: fw });
      }
      if (s1 === y1) {
        bt(i);
        bt(i + 1);
        q2 = t[i + 1]!;
        q3 = t[i]!;
      } else {
        q2 = m.vertex(c[0], s1, c[1], col1, { uv: [us[i + 1]!, vAt(s1)], f: fw });
        q3 = m.vertex(a[0], s1, a[1], col1, { uv: [us[i]!, vAt(s1)], f: fw });
      }
      m.tri(q0, q1, q2, ox, 0, oz);
      m.tri(q0, q2, q3, ox, 0, oz);
    }
  }
  if (underside) {
    // The ceiling of a passage under a span, facing down.
    const under = rgba(wall, 0.6);
    const r0: number[] = ring.map((p) => m.vertex(p[0], y0, p[1], under, { uv: [p[0], p[1]], f: fw }));
    const tris0 = ShapeUtils.triangulateShape(ring.map(([x, z]) => new Vector2(x, z)), []);
    for (const [i0, i1, i2] of tris0) m.tri(r0[i0!]!, r0[i1!]!, r0[i2!]!, 0, -1, 0);
  }
  // Roof.
  const roofCol = rgba(roof);
  const r: number[] = ring.map((p) => m.vertex(p[0], y1, p[1], roofCol, { uv: [p[0], p[1]], f: fr }));
  const tris = ShapeUtils.triangulateShape(ring.map(([x, z]) => new Vector2(x, z)), []);
  for (const [i0, i1, i2] of tris) m.tri(r[i0!]!, r[i1!]!, r[i2!]!, 0, 1, 0);
}

export function buildingMesh(
  buildings: readonly Building[],
  party?: ReadonlyMap<string, ReadonlyArray<ReadonlyArray<readonly [number, number]> | undefined>>,
): { mesh: MeshData; ranges: Array<[string, number, number]> } {
  const m = new MeshData({ uvs: true, facade: true });
  const ranges: Array<[string, number, number]> = [];
  const styles = new Map<string, FacadeStyle>();
  for (const bl of buildings) {
    const first = m.indices.length;
    // A tower shares its podium's facade (the podium precedes it in id order).
    const style = (bl.meta.towerOf !== undefined ? styles.get(bl.meta.towerOf) : undefined) ?? facadeStyle(bl);
    styles.set(bl.id, style);
    // A tower record starts on its podium's roof, a span at its underside; everything else at the
    // lowest ground under it.
    prism(m, bl.footprint, wallBottom(bl), bl.topY, bl.baseY, style.wall, style.roof, style, party?.get(bl.id), bl.meta.piece === "span");
    ranges.push([bl.id, first, m.indices.length - first]);
  }
  return { mesh: m, ranges };
}
