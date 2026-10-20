// Triangle meshes for one tile: ground, road ribbons, freeways, buildings.
// Positions are in the world frame (local metres, y up), the same frame as the colliders.

import { ShapeUtils, Vector2 } from "three";
import type { Building } from "./buildings.ts";
import type { TileRef } from "./config.ts";
import { clipSegment, hash32, type P2 } from "./geom.ts";
import type { RoadEdge } from "./roads.ts";
import type { Ground, Heightfield } from "./terrain.ts";

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
    if (this.uvs) this.uvs.push(...(extra.uv ?? [0, 0]));
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

/** Lift above the ground mesh so ribbons never z-fight with it. */
const ROAD_LIFT_M = 0.15;
const MAX_STEP_M = 8;

/** Densify a polyline so no segment is longer than MAX_STEP_M; returns points with distance along. */
function densify(points: readonly P2[]): Array<{ p: P2; s: number }> {
  const out: Array<{ p: P2; s: number }> = [{ p: points[0]!, s: 0 }];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / MAX_STEP_M));
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

export function roadMeshes(edges: readonly RoadEdge[], tile: TileRef, ground: Ground): { roads: MeshData; freeways: MeshData } {
  const roads = new MeshData({ uvs: true });
  const freeways = new MeshData({ uvs: true });
  for (const e of edges) {
    const target = e.kind === "freeway" || e.kind === "ramp" ? freeways : roads;
    const col = rgba(ROAD_COLOR[e.pedestrian ? "pedestrian" : e.kind] ?? ROAD_COLOR.other!);
    const half = e.widthM / 2;
    const dense = densify(e.points);
    const isFreeway = target === freeways;
    for (const clipped of clipRuns(dense, tile.bbox)) {
      // Freeways over the bay are bridge decks the source gives no height for: not drawn.
      // Split the run so skipped stretches emit no vertices either.
      const runs: Array<typeof clipped> = [];
      let cur: typeof clipped = [clipped[0]!];
      for (let i = 1; i < clipped.length; i++) {
        const a = clipped[i - 1]!.p;
        const b = clipped[i]!.p;
        if (isFreeway && ground.waterAt(a[0], a[1]) && ground.waterAt(b[0], b[1])) {
          if (cur.length >= 2) runs.push(cur);
          cur = [clipped[i]!];
        } else {
          cur.push(clipped[i]!);
        }
      }
      if (cur.length >= 2) runs.push(cur);
      for (const run of runs) {
        const left: number[] = [];
        const right: number[] = [];
        for (let i = 0; i < run.length; i++) {
          const prev = run[Math.max(0, i - 1)]!.p;
          const next = run[Math.min(run.length - 1, i + 1)]!.p;
          let dx = next[0] - prev[0];
          let dz = next[1] - prev[1];
          const len = Math.hypot(dx, dz) || 1;
          dx /= len;
          dz /= len;
          // Perpendicular (to the right of travel on a north-up map is (-dz, dx)).
          const px = -dz;
          const pz = dx;
          const { p, s } = run[i]!;
          const lx = p[0] - px * half, lz = p[1] - pz * half;
          const rx = p[0] + px * half, rz = p[1] + pz * half;
          const ly = (ground.meshHeightAt(lx, lz) ?? ground.meshHeightAt(p[0], p[1]) ?? 0) + ROAD_LIFT_M;
          const ry = (ground.meshHeightAt(rx, rz) ?? ground.meshHeightAt(p[0], p[1]) ?? 0) + ROAD_LIFT_M;
          left.push(target.vertex(lx, ly, lz, col, { uv: [0, Math.round(s * 100) / 100] }));
          right.push(target.vertex(rx, ry, rz, col, { uv: [1, Math.round(s * 100) / 100] }));
        }
        for (let i = 1; i < run.length; i++) {
          target.tri(left[i - 1]!, right[i - 1]!, left[i]!, 0, 1, 0);
          target.tri(right[i - 1]!, right[i]!, left[i]!, 0, 1, 0);
        }
      }
    }
  }
  return { roads, freeways };
}

// ---------------------------------------------------------------- buildings

function prism(m: MeshData, ring: readonly P2[], y0: number, y1: number, baseY: number, wall: string, roof: string, style: FacadeStyle): void {
  const n = ring.length;
  const fw = facadeBytes(style, false);
  const fr = facadeBytes(style, true);
  const top = rgba(wall);
  const bottom = rgba(wall, 0.8);
  // Walls: one shared bottom/top vertex pair per ring vertex, plus a seam copy so u is continuous.
  const b: number[] = [];
  const t: number[] = [];
  let u = 0;
  for (let i = 0; i <= n; i++) {
    const p = ring[i % n]!;
    if (i > 0) {
      const q = ring[i - 1]!;
      u += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    const uu = Math.round(u * 100) / 100;
    b.push(m.vertex(p[0], y0, p[1], bottom, { uv: [uu, Math.round((y0 - baseY) * 100) / 100], f: fw }));
    t.push(m.vertex(p[0], y1, p[1], top, { uv: [uu, Math.round((y1 - baseY) * 100) / 100], f: fw }));
  }
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const c = ring[(i + 1) % n]!;
    // Outward normal of a ring that is counter-clockwise on a north-up map.
    const ox = -(c[1] - a[1]);
    const oz = c[0] - a[0];
    m.tri(b[i]!, b[i + 1]!, t[i + 1]!, ox, 0, oz);
    m.tri(b[i]!, t[i + 1]!, t[i]!, ox, 0, oz);
  }
  // Roof.
  const roofCol = rgba(roof);
  const r: number[] = ring.map((p) => m.vertex(p[0], y1, p[1], roofCol, { uv: [p[0], p[1]], f: fr }));
  const tris = ShapeUtils.triangulateShape(ring.map(([x, z]) => new Vector2(x, z)), []);
  for (const [i0, i1, i2] of tris) m.tri(r[i0!]!, r[i1!]!, r[i2!]!, 0, 1, 0);
}

export function buildingMesh(buildings: readonly Building[]): { mesh: MeshData; ranges: Array<[string, number, number]> } {
  const m = new MeshData({ uvs: true, facade: true });
  const ranges: Array<[string, number, number]> = [];
  const styles = new Map<string, FacadeStyle>();
  for (const bl of buildings) {
    const first = m.indices.length;
    // A tower shares its podium's facade (the podium precedes it in id order).
    const style = (bl.meta.towerOf !== undefined ? styles.get(bl.meta.towerOf) : undefined) ?? facadeStyle(bl);
    styles.set(bl.id, style);
    // A tower record starts on its podium's roof; everything else at the lowest ground under it.
    const y0 = bl.meta.towerOf !== undefined && bl.meta.podiumTopY !== undefined ? bl.meta.podiumTopY : bl.meta.footY;
    prism(m, bl.footprint, y0, bl.topY, bl.baseY, style.wall, style.roof, style);
    ranges.push([bl.id, first, m.indices.length - first]);
  }
  return { mesh: m, ranges };
}
