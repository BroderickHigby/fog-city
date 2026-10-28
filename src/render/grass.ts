// DataSF lawn polygons, draped on the actual terrain triangles, with bounded short grass.
// The polygon, road and building work is render-only; no simulation/world data is changed.
//
// The expensive work is done once per lawn, nearest first, under the per-frame budget, and
// kept while the lawn is within reach; a camera move only re-selects and re-assembles:
//  - The obstacle index (the paved road footprint and the buildings that cut lawns) is cheap
//    to build: building footprints are triangulated only when a lawn next to them is built.
//  - A lawn's turf triangles and tuft samples do not depend on the camera, so they are built
//    once (LawnCache). Before, every 20 m of camera travel rebuilt every lawn within 550 m
//    (130-280 ms of main thread), and a moving camera restarted that work before it finished.
//  - assemble() copies the cached pieces of the selected lawns into the two meshes; the
//    blades' distance thinning, the only camera-dependent part, is applied there.
// The selection, caps, order, thinning and geometry are those of the single-pass builder this
// replaces: once settled, the meshes hold the same triangles.
import * as THREE from "three";
import { heightOnField, type Heightfield, type TileCollider } from "../sim/world.ts";
import { hashString, mix32, unit } from "./hash.ts";
import { roadHalfWidth, sidewalkWidth } from "./roads.ts";
import { fcUniforms, injectUniforms } from "./materials.ts";
import { createGpuGrassMaterial, isGpuMaterialsEnabled } from "./node-materials.ts";
import type { GroundFn, RoadGraph } from "./types.ts";

type P = [number, number];
type Box = [number, number, number, number];
interface Lawn { id: string; rings: P[][]; bbox: Box }
interface Mask { polygon: P[]; bbox: Box }
export const GRASS_RADIUS = 550;
export const GRASS_PATCH_CAP = 96;
export const GRASS_SURFACE_CAP = 60000;
export const GRASS_BLADE_CAP = 18000;
export const GRASS_BLADE_RADIUS = 140;
export const GRASS_FADE_START = 70;
export const GRASS_FADE_END = 110;
/** The camera moves this far before the lawns are re-selected and re-assembled. */
export const GRASS_REBUILD_M = 20;
/** Cached turf is dropped this far beyond the grass radius, cached tufts this far beyond the blade radius. */
const SURFACE_KEEP_M = 300;
const TUFT_KEEP_M = 120;
/** While lawns are still being built, re-assemble at most this often (ms) to show progress. */
const PROGRESS_MS = 250;
const TUFT_STEP = .9;
export interface GrassInfo {
  loaded: boolean; areas: number; patches: number; blades: number;
  surfaceTriangles: number; bladeTriangles: number; drawCalls: number; pending: boolean;
  /** Lawns with cached turf or tufts now. */
  cachedLawns?: number;
}
export interface GrassOptions { ground: GroundFn; roads?: RoadGraph | null; colliders?: ReadonlyMap<string, TileCollider> }

function bounds(p: readonly P[]): Box {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p) { if (x < x0) x0 = x; if (z < z0) z0 = z; if (x > x1) x1 = x; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
const overlaps = (a: Box, b: Box): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const cross = (a: P, b: P, p: P): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const area2 = (p: readonly P[]): number => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
/** A 100 m index cell as a number. */
const cellKey = (x: number, z: number): number => (x + 4096) * 8192 + (z + 4096);
/** The 100 m cells a box touches, x-major. */
function cells(b: Box): number[] {
  const out: number[] = [];
  for (let x = Math.floor(b[0] / 100); x <= Math.floor(b[2] / 100); x++) for (let z = Math.floor(b[1] / 100); z <= Math.floor(b[3] / 100); z++) out.push(cellKey(x, z));
  return out;
}
/** Distance from (x, z) to a box; 0 inside it. */
const boxDistance = (b: Box, x: number, z: number): number => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]));

/** Decode only finite, bounded, literal lawn polygons. Rings keep the producer's holes. */
export function grassShapes(doc: unknown): Lawn[] {
  const raw = (doc as { grass?: unknown } | null)?.grass;
  if (!Array.isArray(raw)) return [];
  const out: Lawn[] = [];
  for (const row of raw) {
    const r = row as { id?: unknown; kind?: unknown; rings?: unknown };
    if (typeof r?.id !== "string" || r.kind !== "lawn" || !Array.isArray(r.rings) || !r.rings.length) continue;
    const rings: P[][] = [];
    for (const ring of r.rings) {
      if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 || ring.length > 20000 || !ring.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000)) break;
      const pts: P[] = [];
      for (let i = 0; i < ring.length; i += 2) pts.push([ring[i] as number, ring[i + 1] as number]);
      if (pts.length > 3 && pts[0]![0] === pts.at(-1)![0] && pts[0]![1] === pts.at(-1)![1]) pts.pop();
      if (Math.abs(area2(pts)) < .01) break;
      rings.push(pts);
    }
    if (rings.length !== r.rings.length) continue;
    const bbox = bounds(rings[0]!);
    // Pipeline pieces are 100 m cells; reject unexpectedly huge/corrupt input before work.
    if (bbox[2] - bbox[0] > 200 || bbox[3] - bbox[1] > 200) continue;
    out.push({ id: r.id, rings, bbox });
  }
  return out;
}

function triangles(rings: readonly P[][]): P[][] {
  const contour = rings[0]!.map(p => new THREE.Vector2(...p));
  const holes = rings.slice(1).map(r => r.map(p => new THREE.Vector2(...p)));
  const points = rings.flat();
  return THREE.ShapeUtils.triangulateShape(contour, holes).map(t => t.map(i => points[i]!));
}

function inRing(p: P, ring: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * inRing() for many points against one ring: the ring's edges bucketed by z band. Only an edge
 * whose z range holds the point's z can flip the crossing parity, so the answer is exactly
 * inRing()'s, from a few edges instead of thousands (park lawns can have very long rings).
 */
function ringTest(ring: readonly P[]): (p: P) => boolean {
  if (ring.length < 24) return p => inRing(p, ring);
  let z0 = Infinity, z1 = -Infinity;
  for (const [, z] of ring) { if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const n = Math.min(1024, Math.ceil(ring.length / 4)), size = (z1 - z0) / n || 1;
  const band = (z: number): number => Math.min(n - 1, Math.floor((z - z0) / size));
  const bands: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]![1], b = ring[j]![1];
    for (let k = band(Math.min(a, b)); k <= band(Math.max(a, b)); k++) bands[k]!.push(i);
  }
  return p => {
    if (p[1] < z0 || p[1] > z1) return false;
    let inside = false;
    for (const i of bands[band(p[1])]!) {
      const a = ring[i]!, b = ring[i === 0 ? ring.length - 1 : i - 1]!;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
}
/** A point outside a mask's box is outside the mask: inRing() would find even crossings. */
const inMask = (p: P, m: Mask): boolean => p[0] >= m.bbox[0] && p[0] <= m.bbox[2] && p[1] >= m.bbox[1] && p[1] <= m.bbox[3] && inRing(p, m.polygon);

/** Clip a convex polygon to one side of a line. */
function half(poly: readonly P[], a: P, b: P, side: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const dp = cross(a, b, p) * side, dq = cross(a, b, q) * side;
    if (dp >= -1e-7) out.push(p);
    if ((dp > 1e-7 && dq < -1e-7) || (dp < -1e-7 && dq > 1e-7)) {
      const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}
/** Disjoint convex pieces outside a convex obstacle; either winding is supported. */
export function subtractGrassMask(poly: P[], mask: readonly P[]): P[][] {
  const outside: P[][] = [];
  const side = area2(mask) >= 0 ? 1 : -1;
  let remaining = poly;
  for (let i = 0; i < mask.length && remaining.length >= 3; i++) {
    const a = mask[i]!, b = mask[(i + 1) % mask.length]!;
    const piece = half(remaining, a, b, -side);
    if (piece.length >= 3 && Math.abs(area2(piece)) > 1e-5) outside.push(piece);
    remaining = half(remaining, a, b, side);
  }
  return outside;
}

/** A building footprint in the index, triangulated (convex masks) only when a lawn needs it. */
interface Footprint { footprint: P[]; bbox: Box; tris: Mask[] | null }
type Entry = Mask | Footprint;
const isFootprint = (e: Entry): e is Footprint => "footprint" in e;
const triangulate = (f: Footprint): Mask[] => (f.tris ??= triangles([f.footprint]).map(polygon => ({ polygon, bbox: bounds(polygon) })));

/**
 * Convex obstacles by 100 m cell, only in cells that hold lawn. get() returns, for a box, the
 * masks that overlap it in cell order and then insertion order (roads, then each building's
 * triangles), each once: the order the lawn subtraction has always used.
 */
class MaskIndex {
  private readonly buckets = new Map<number, Entry[]>();
  private readonly cover: Set<number>;
  constructor(lawns: readonly Lawn[]) { this.cover = new Set(lawns.flatMap(l => cells(l.bbox))); }
  private put(entry: Entry): void {
    for (const k of cells(entry.bbox)) {
      if (!this.cover.has(k)) continue;
      const list = this.buckets.get(k);
      if (list) list.push(entry); else this.buckets.set(k, [entry]);
    }
  }
  private intersects(bbox: Box): boolean { return cells(bbox).some(k => this.cover.has(k)); }
  addMask(polygon: P[]): void { const bbox = bounds(polygon); if (this.intersects(bbox)) this.put({ polygon, bbox }); }
  addFootprint(footprint: P[]): void { const bbox = bounds(footprint); if (this.intersects(bbox)) this.put({ footprint, bbox, tris: null }); }
  /** Triangulate the footprints in a box's cells, a few per step, so one lawn never stalls a frame. */
  *prepare(bbox: Box): Generator<void> {
    let n = 0;
    for (const k of cells(bbox)) for (const e of this.buckets.get(k) ?? []) {
      if (!isFootprint(e) || e.tris) continue;
      triangulate(e);
      if (++n % 16 === 0) yield;
    }
  }
  get(bbox: Box): Mask[] {
    const out: Mask[] = [], seen = new Set<Mask>();
    for (let x = Math.floor(bbox[0] / 100); x <= Math.floor(bbox[2] / 100); x++) for (let z = Math.floor(bbox[1] / 100); z <= Math.floor(bbox[3] / 100); z++) {
      for (const e of this.buckets.get(cellKey(x, z)) ?? []) {
        if (!isFootprint(e)) { if (!seen.has(e)) { seen.add(e); out.push(e); } continue; }
        // Each triangle belongs to the cells its own box touches.
        for (const t of triangulate(e)) {
          if (seen.has(t) || Math.floor(t.bbox[0] / 100) > x || Math.floor(t.bbox[2] / 100) < x || Math.floor(t.bbox[1] / 100) > z || Math.floor(t.bbox[3] / 100) < z) continue;
          seen.add(t); out.push(t);
        }
      }
    }
    return out.filter(m => overlaps(m.bbox, bbox));
  }
}

function* masks(lawns: readonly Lawn[], opts: GrassOptions): Generator<void, MaskIndex> {
  const index = new MaskIndex(lawns);
  let n = 0;
  for (const e of opts.roads?.edges ?? []) {
    // The rendered road includes raised sidewalks, not just its carriageway. Keep short
    // foliage outside that whole paved footprint so its tips cannot poke through paving.
    const w = roadHalfWidth(e) + sidewalkWidth(e) + .25;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!, b = e.points[i]!, dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      if (len < .01) continue;
      const tx = dx / len, tz = dz / len, nx = -tz * w, nz = tx * w;
      const ax = a[0] - tx * w, az = a[1] - tz * w, bx = b[0] + tx * w, bz = b[1] + tz * w;
      index.addMask([[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]);
      if (++n % 128 === 0) yield;
    }
  }
  for (const tile of opts.colliders?.values() ?? []) {
    for (const b of tile.buildings) {
      if (b.footprint.length >= 3) index.addFootprint(b.footprint);
      if (++n % 512 === 0) yield;
    }
  }
  return index;
}

interface Terrain { ground: GroundFn; x0: number; z0: number; step: number }
function terrainAt(opts: GrassOptions, lawn: Lawn): Terrain {
  const x = (lawn.bbox[0] + lawn.bbox[2]) / 2, z = (lawn.bbox[1] + lawn.bbox[3]) / 2;
  const fields: Heightfield[] = [];
  for (const tile of opts.colliders?.values() ?? []) {
    const g = tile.ground;
    if (g && g.nx >= 2 && g.nz >= 2 && overlaps(lawn.bbox, [g.x0, g.z0, g.x0 + (g.nx - 1) * g.cellSizeM, g.z0 + (g.nz - 1) * g.cellSizeM])) fields.push(g);
  }
  const ref = fields.find(g => x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.nx - 1) * g.cellSizeM && z <= g.z0 + (g.nz - 1) * g.cellSizeM) ?? fields[0];
  return { x0: ref?.x0 ?? 0, z0: ref?.z0 ?? 0, step: ref?.cellSizeM ?? 10,
    ground: (px, pz) => { const g = fields.find(f => px >= f.x0 - 1e-5 && pz >= f.z0 - 1e-5 && px <= f.x0 + (f.nx - 1) * f.cellSizeM + 1e-5 && pz <= f.z0 + (f.nz - 1) * f.cellSizeM + 1e-5); return g ? heightOnField(g, px, pz) : opts.ground(px, pz); } };
}

/** Split at the heightfield lattice and diagonal: every resulting face lies on the drawn floor. */
function* terrainPieces(poly: P[], terrain: Terrain): Generator<P[]> {
  const b = bounds(poly), s = terrain.step;
  for (let ix = Math.floor((b[0] - terrain.x0) / s); ix <= Math.floor((b[2] - terrain.x0) / s); ix++) for (let iz = Math.floor((b[1] - terrain.z0) / s); iz <= Math.floor((b[3] - terrain.z0) / s); iz++) {
    const x = terrain.x0 + ix * s, z = terrain.z0 + iz * s;
    let p = half(poly, [x, z + s], [x, z], 1);
    p = half(p, [x + s, z], [x + s, z + s], 1);
    p = half(p, [x, z], [x + s, z], 1);
    p = half(p, [x + s, z + s], [x, z + s], 1);
    if (p.length < 3) continue;
    for (const side of [-1, 1]) { const q = half(p, [x + s, z], [x, z + s], side); if (q.length >= 3 && Math.abs(area2(q)) > 1e-5) yield q; }
  }
}

const GREEN = new THREE.Color(0x3d642b), DRY = new THREE.Color(0x77713e), DARK = new THREE.Color(0x334c24).toArray();
/** The lawn colour at (x, z) into out[at..at+2], by the same operations as Color.lerp and multiplyScalar. */
function lawnColor(x: number, z: number, out: number[], at: number): void {
  const moisture = .5 + .25 * Math.sin(x * .027 + z * .013) + .25 * Math.cos(z * .035 - x * .011);
  const t = Math.max(0, moisture - .48) * .65, k = .90 + .08 * Math.sin(x * .11 + z * .04);
  let r = GREEN.r, g = GREEN.g, b = GREEN.b;
  r += (DRY.r - r) * t; g += (DRY.g - g) * t; b += (DRY.b - b) * t;
  out[at] = r * k; out[at + 1] = g * k; out[at + 2] = b * k;
}

/** Face normals of non-indexed triangles, as BufferGeometry.computeVertexNormals() gives them. */
function faceNormals(position: Float32Array, normal: Float32Array, count: number): void {
  for (let i = 0; i < count * 9; i += 9) {
    const ax = position[i]!, ay = position[i + 1]!, az = position[i + 2]!, bx = position[i + 3]!, by = position[i + 4]!, bz = position[i + 5]!;
    const cbx = position[i + 6]! - bx, cby = position[i + 7]! - by, cbz = position[i + 8]! - bz, abx = ax - bx, aby = ay - by, abz = az - bz;
    const nx = Math.fround(cby * abz - cbz * aby), ny = Math.fround(cbz * abx - cbx * abz), nz = Math.fround(cbx * aby - cby * abx);
    const s = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    for (let v = 0; v < 9; v += 3) { normal[i + v] = nx * s; normal[i + v + 1] = ny * s; normal[i + v + 2] = nz * s; }
  }
}

/** A lawn's camera-independent pieces; null until built. */
interface LawnCache {
  /** Turf triangles, three vertices each: positions, colours and face normals. */
  surface: { position: Float32Array; color: Float32Array; normal: Float32Array; triangles: number } | null;
  /** Tuft samples on the turf, in grid order, TUFT values each (see buildTufts). */
  tufts: Float64Array | null;
  minY: number; maxY: number;
}
const TUFT = 12;

/** The lawn's turf: its triangles minus the obstacles, split on the terrain lattice. */
function* buildSurface(lawn: Lawn, index: MaskIndex, terrain: Terrain, out: LawnCache): Generator<void> {
  yield* index.prepare(lawn.bbox);
  const obstacles = index.get(lawn.bbox), position: number[] = [], color: number[] = [];
  let processed = 0;
  for (const triangle of triangles(lawn.rings)) {
    let parts = [triangle];
    for (const obstacle of obstacles) {
      parts = parts.flatMap(p => overlaps(bounds(p), obstacle.bbox) ? subtractGrassMask(p, obstacle.polygon) : [p]);
      if (!parts.length) break;
    }
    for (const p of parts) for (const piece of terrainPieces(p, terrain)) {
      const h = piece.map(v => terrain.ground(...v));
      if (h.some(y => !Number.isFinite(y) || y < 1.2)) continue;
      for (let i = 1; i + 1 < piece.length; i++) {
        if (Math.abs(cross(piece[0]!, piece[i]!, piece[i + 1]!)) < 1e-6) continue;
        const order = area2(piece) > 0 ? [0, i + 1, i] : [0, i, i + 1];
        for (const j of order) {
          const v = piece[j]!, y = h[j]! + .018;
          position.push(v[0], y, v[1]);
          lawnColor(v[0], v[1], color, color.length);
          out.minY = Math.min(out.minY, y); out.maxY = Math.max(out.maxY, y);
        }
      }
    }
    if (++processed % 4 === 0) yield;
  }
  const p = new Float32Array(position), normal = new Float32Array(position.length);
  faceNormals(p, normal, position.length / 9);
  out.surface = { position: p, color: new Float32Array(color), normal, triangles: position.length / 9 };
}

/**
 * Small three-leaf tufts: each narrow, bent leaf is two tapered triangles rather than a broad
 * upright spike. The corners a, b, c, d of leaf `leaf` of the tuft hashed `r` at (px, pz) go
 * to `out` as x/z pairs; returns the leaf's height.
 */
function leafShape(r: number, u: number, v: number, px: number, pz: number, leaf: number, out: number[]): number {
  const variation = unit(mix32(r, leaf + 11)), height = .045 + variation * .055;
  const heading = u * Math.PI * 2 + leaf * Math.PI * 2 / 3;
  const tx = Math.cos(heading), tz = Math.sin(heading), width = .003 + v * .003;
  const bend = height * (.18 + variation * .16);
  out[0] = px - tx * width; out[1] = pz - tz * width; out[2] = px + tx * width; out[3] = pz + tz * width;
  out[4] = px + tx * (bend * .45 - width * .45); out[5] = pz + tz * (bend * .45 - width * .45);
  out[6] = px + tx * bend; out[7] = pz + tz * bend;
  return height;
}

/**
 * Every sample of the lawn's 0.9 m tuft grid whose centre is on the turf, at full density and
 * in the grid order the blades are laid in: gx, gz, px, pz, root y, leaf mask, and each leaf's
 * two base heights. Thinning by distance happens in assemble().
 */
function* buildTufts(lawn: Lawn, index: MaskIndex, terrain: Terrain, out: LawnCache): Generator<void> {
  yield* index.prepare(lawn.bbox);
  const obstacles = index.get(lawn.bbox), seed = hashString(lawn.id), b = lawn.bbox, data: number[] = [], k: number[] = [];
  const outer = ringTest(lawn.rings[0]!), holes = lawn.rings.slice(1).map(ringTest);
  const inside = (p: P): boolean => outer(p) && !holes.some(hole => hole(p)) && !obstacles.some(m => inMask(p, m));
  let processed = 0;
  for (let gx = Math.floor(b[0] / TUFT_STEP); gx <= Math.floor(b[2] / TUFT_STEP); gx++) for (let gz = Math.floor(b[1] / TUFT_STEP); gz <= Math.floor(b[3] / TUFT_STEP); gz++) {
    if (++processed % 64 === 0) yield;
    const r = mix32(mix32(seed, gx), gz), u = unit(r), v = unit(mix32(r, 3));
    const px = (gx + .18 + u * .64) * TUFT_STEP, pz = (gz + .18 + v * .64) * TUFT_STEP;
    if (!inside([px, pz])) continue;
    const y = terrain.ground(px, pz) + .018;
    if (!Number.isFinite(y) || y < 1.218) continue;
    const at = data.length;
    data.push(gx, gz, px, pz, y, 0, 0, 0, 0, 0, 0, 0);
    let mask = 0;
    for (let leaf = 0; leaf < 3; leaf++) {
      leafShape(r, u, v, px, pz, leaf, k);
      const a: P = [k[0]!, k[1]!], bb: P = [k[2]!, k[3]!];
      if (![a, bb, [k[4]!, k[5]!] as P, [k[6]!, k[7]!] as P].every(inside)) continue;
      mask |= 1 << leaf;
      data[at + 6 + leaf * 2] = terrain.ground(...a) + .015;
      data[at + 7 + leaf * 2] = terrain.ground(...bb) + .015;
    }
    data[at + 5] = mask;
    out.minY = Math.min(out.minY, y - .01); out.maxY = Math.max(out.maxY, y + .1);
  }
  out.tufts = new Float64Array(data);
}

export class GrassLayer {
  readonly group = new THREE.Group();
  private readonly opts: GrassOptions;
  private readonly surfaceMaterial = isGpuMaterialsEnabled() ? createGpuGrassMaterial(false) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, name: "fc:grass-surface", side: THREE.DoubleSide });
  private readonly bladeMaterial = isGpuMaterialsEnabled() ? createGpuGrassMaterial(true) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, name: "fc:grass-blades", side: THREE.DoubleSide });
  private readonly surface = new THREE.Mesh(new THREE.BufferGeometry(), this.surfaceMaterial);
  private readonly blades = new THREE.Mesh(new THREE.BufferGeometry(), this.bladeMaterial);
  private lawns: Lawn[] = [];
  private index: MaskIndex | null = null;
  private indexPending: Generator<void, MaskIndex> | null = null;
  private readonly cache = new Map<number, LawnCache>();
  private readonly terrains = new Map<number, Terrain>();
  /** The lawn piece being built now, and the queue behind it (nearest first). */
  private job: { lawn: number; tufts: boolean; gen: Generator<void> } | null = null;
  private todo: Array<{ lawn: number; tufts: boolean }> = [];
  /** The lawns selected for (x, z), nearest first. */
  private selected: number[] = [];
  private surfaceKey = "";
  private assembledAt = -Infinity;
  private needsAssembly = false;
  /** Scratch for the blade assembly, reused: no garbage per re-assembly. */
  private readonly scratch = { position: new Float32Array(GRASS_BLADE_CAP * 9), color: new Float32Array(GRASS_BLADE_CAP * 9), root: new Float32Array(GRASS_BLADE_CAP * 3) };
  private x = Infinity; private z = Infinity; private patches = 0; private leaves = 0; private loaded = false;
  constructor(opts: GrassOptions) {
    this.opts = opts; this.group.name = "grass"; this.surface.name = "grass-surface"; this.blades.name = "grass-blades";
    this.surface.visible = false; this.blades.visible = false;
    this.surface.receiveShadow = true; this.blades.receiveShadow = true; this.group.add(this.surface, this.blades);
    this.surfaceMaterial.polygonOffset = true; this.surfaceMaterial.polygonOffsetFactor = -1; this.surfaceMaterial.polygonOffsetUnits = -1;
    if (!isGpuMaterialsEnabled()) this.surfaceMaterial.onBeforeCompile = shader => {
      injectUniforms(shader);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vGrassXZ;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvGrassXZ = position.xz;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 vGrassXZ;").replace("#include <color_fragment>", `#include <color_fragment>
        float grassFilter = max(length(dFdx(vGrassXZ)),length(dFdy(vGrassXZ)));
        float grassFine = sin(vGrassXZ.x * 19.0 + sin(vGrassXZ.y * 11.0)) * sin(vGrassXZ.y * 23.0);
        float grassMow = 0.5 + 0.5 * sin((vGrassXZ.x + vGrassXZ.y * 0.18) * 0.44);
        diffuseColor.rgb *= 0.94 + grassMow * 0.055 + grassFine * (1.0 - smoothstep(0.025,0.12,grassFilter)) * 0.045;`);
    };
    if (!isGpuMaterialsEnabled()) this.surfaceMaterial.customProgramCacheKey = () => "fc:grass-surface:v2";
    if (!isGpuMaterialsEnabled()) this.bladeMaterial.onBeforeCompile = shader => {
      injectUniforms(shader);
      shader.uniforms.fcGrassTime = fcUniforms.fcTime;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float _grassRoot;\nuniform float fcGrassTime;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          float grassDistance = length(position.xz - cameraPosition.xz);
          float grassFade = 1.0 - smoothstep(${GRASS_FADE_START}.0,${GRASS_FADE_END}.0,grassDistance);
          float grassHeight = max(position.y - _grassRoot,0.0);
          transformed.y = _grassRoot + (position.y - _grassRoot) * grassFade;
          transformed.x += sin(fcGrassTime * 1.4 + position.x * 0.23 + position.z * 0.17) * grassHeight * 0.12 * grassFade;`);
    };
    if (!isGpuMaterialsEnabled()) this.bladeMaterial.customProgramCacheKey = () => "fc:grass-blades:v2";
  }
  setData(doc: unknown): void {
    this.lawns = grassShapes(doc); this.loaded = true; this.index = null;
    this.indexPending = this.lawns.length ? masks(this.lawns, this.opts) : null;
    this.cache.clear(); this.terrains.clear(); this.job = null; this.todo = []; this.selected = [];
    this.x = Infinity; this.needsAssembly = false; this.surfaceKey = ""; this.clear();
  }
  /** Re-select near (x, z), build what is missing nearest first and re-assemble, within `budgetMs`. */
  update(x: number, z: number, budgetMs = 3): void {
    if (!this.loaded) return;
    if (!this.lawns.length) { this.x = x; this.z = z; return; }
    const start = performance.now();
    if (Math.hypot(x - this.x, z - this.z) >= GRASS_REBUILD_M) { this.x = x; this.z = z; if (this.index) this.select(); }
    // The citywide obstacle index is independent of the camera; moving never restarts it.
    // Every call makes at least one step, so even a zero budget finishes.
    let stepped = false;
    while (this.indexPending) {
      const next = this.indexPending.next();
      stepped = true;
      if (next.done) { this.index = next.value; this.indexPending = null; this.select(); break; }
      if (performance.now() - start >= budgetMs) return;
    }
    const index = this.index;
    if (!index) return;
    for (;;) {
      if (!this.job) {
        const next = this.todo.shift();
        if (!next) break;
        const entry = this.cacheFor(next.lawn);
        if (next.tufts ? entry.tufts : entry.surface) continue;
        const lawn = this.lawns[next.lawn]!, terrain = this.terrainFor(next.lawn);
        this.job = { ...next, gen: next.tufts ? buildTufts(lawn, index, terrain, entry) : buildSurface(lawn, index, terrain, entry) };
      }
      if (stepped && performance.now() - start >= budgetMs) break;
      stepped = true;
      if (this.job.gen.next().done) { this.job = null; this.needsAssembly = true; }
    }
    // Show finished lawns as they come, without re-assembling every frame while many build.
    const now = performance.now();
    if (this.needsAssembly && ((!this.job && !this.todo.length) || now - this.assembledAt >= PROGRESS_MS)) this.assemble(now);
  }
  settled(): boolean { return !this.loaded || (Number.isFinite(this.x) && !this.indexPending && !this.job && !this.todo.length && !this.needsAssembly); }
  info(): GrassInfo {
    const surfaceTriangles = (this.surface.geometry.getAttribute("position")?.count ?? 0) / 3, bladeTriangles = (this.blades.geometry.getAttribute("position")?.count ?? 0) / 3;
    return { loaded: this.loaded, areas: this.lawns.length, patches: this.patches, blades: this.leaves, surfaceTriangles, bladeTriangles, drawCalls: Number(surfaceTriangles > 0) + Number(bladeTriangles > 0), pending: !this.settled(), cachedLawns: this.cache.size };
  }

  private cacheFor(lawn: number): LawnCache {
    let entry = this.cache.get(lawn);
    if (!entry) this.cache.set(lawn, (entry = { surface: null, tufts: null, minY: Infinity, maxY: -Infinity }));
    return entry;
  }
  private terrainFor(lawn: number): Terrain {
    let t = this.terrains.get(lawn);
    if (!t) this.terrains.set(lawn, (t = terrainAt(this.opts, this.lawns[lawn]!)));
    return t;
  }

  /** The nearest lawns of (x, z); queue what they lack, nearest first; drop caches out of reach. */
  private select(): void {
    const { x, z } = this;
    if (!Number.isFinite(x)) return;
    const near: Array<{ i: number; d: number }> = [];
    this.lawns.forEach((l, i) => { const d = boxDistance(l.bbox, x, z); if (d <= GRASS_RADIUS) near.push({ i, d }); });
    near.sort((a, b) => a.d - b.d || this.lawns[a.i]!.id.localeCompare(this.lawns[b.i]!.id));
    const chosen = near.slice(0, GRASS_PATCH_CAP);
    this.selected = chosen.map(n => n.i);
    // Turf for every selected lawn and tufts for those in blade reach. The near lawns' tufts
    // come before far turf: near grass is what the eye sees first.
    const want: Array<{ lawn: number; tufts: boolean; d: number }> = [];
    for (const n of chosen) {
      const entry = this.cache.get(n.i);
      if (!entry?.surface) want.push({ lawn: n.i, tufts: false, d: n.d });
      if (n.d <= GRASS_BLADE_RADIUS && !entry?.tufts) want.push({ lawn: n.i, tufts: true, d: n.d + (n.d > 40 ? 60 : 0) });
    }
    want.sort((a, b) => a.d - b.d || a.lawn - b.lawn || Number(a.tufts) - Number(b.tufts));
    this.todo = want.map(({ lawn, tufts }) => ({ lawn, tufts }));
    // A piece no longer wanted is abandoned; a piece writes its cache only when it completes.
    const job = this.job;
    if (job && !this.todo.some(t => t.lawn === job.lawn && t.tufts === job.tufts)) this.job = null;
    for (const [i, entry] of this.cache) {
      const d = boxDistance(this.lawns[i]!.bbox, x, z);
      if (d > GRASS_RADIUS + SURFACE_KEEP_M) { this.cache.delete(i); this.terrains.delete(i); }
      else if (entry.tufts && d > GRASS_BLADE_RADIUS + TUFT_KEEP_M) entry.tufts = null;
    }
    this.needsAssembly = true;
  }

  /** Copy the selected lawns' cached pieces into the two meshes, thinning the blades by distance. */
  private assemble(now: number): void {
    this.assembledAt = now;
    this.needsAssembly = false;
    const { x, z } = this;
    // Turf: the selected lawns' triangles in order, up to the cap. Same lawns, same mesh.
    const parts: number[] = [];
    let tris = 0;
    for (const i of this.selected) {
      const s = this.cache.get(i)?.surface;
      if (!s || tris >= GRASS_SURFACE_CAP) continue;
      parts.push(i);
      tris += Math.min(s.triangles, GRASS_SURFACE_CAP - tris);
    }
    const key = parts.join(",");
    if (key !== this.surfaceKey) {
      this.surfaceKey = key;
      const position = new Float32Array(tris * 9), color = new Float32Array(tris * 9), normal = new Float32Array(tris * 9);
      let at = 0, patches = 0;
      for (const i of parts) {
        const s = this.cache.get(i)!.surface!, n = Math.min(s.triangles * 9, position.length - at);
        if (n <= 0) continue;
        position.set(s.position.subarray(0, n), at); color.set(s.color.subarray(0, n), at); normal.set(s.normal.subarray(0, n), at);
        at += n;
        patches++;
      }
      this.patches = patches;
      this.replace(this.surface, { position, color, normal }, parts);
    }
    // Blades: each selected lawn's tufts inside the blade window, thinned with distance, up to the cap.
    const R = GRASS_BLADE_RADIUS, { position, color, root } = this.scratch;
    const base = [0, 0, 0], tip = [0, 0, 0], corner = [0, 0, 0, 0, 0, 0, 0, 0], used: number[] = [];
    let vertices = 0, leaves = 0, full = false;
    const vertex = (vx: number, vy: number, vz: number, c: readonly number[], y: number): void => {
      const k = vertices * 3;
      position[k] = vx; position[k + 1] = vy; position[k + 2] = vz;
      color[k] = c[0]!; color[k + 1] = c[1]!; color[k + 2] = c[2]!;
      root[vertices++] = y;
    };
    for (const i of this.selected) {
      if (full) break;
      const t = this.cache.get(i)?.tufts, lawn = this.lawns[i]!, b = lawn.bbox;
      if (!t) continue;
      const gx0 = Math.floor(Math.max(b[0], x - R) / TUFT_STEP), gx1 = Math.floor(Math.min(b[2], x + R) / TUFT_STEP);
      const gz0 = Math.floor(Math.max(b[1], z - R) / TUFT_STEP), gz1 = Math.floor(Math.min(b[3], z + R) / TUFT_STEP);
      if (gx0 > gx1 || gz0 > gz1) continue;
      const seed = hashString(lawn.id), before = leaves;
      for (let k = 0; k < t.length; k += TUFT) {
        const gx = t[k]!, gz = t[k + 1]!;
        if (gx < gx0 || gx > gx1 || gz < gz0 || gz > gz1) continue;
        if (vertices / 3 + 6 > GRASS_BLADE_CAP) { full = true; break; }
        const r = mix32(mix32(seed, gx), gz), px = t[k + 2]!, pz = t[k + 3]!, distance = Math.hypot(px - x, pz - z);
        if (distance > R || unit(mix32(r, 7)) > Math.max(.08, 1 - distance / R)) continue;
        const y = t[k + 4]!, mask = t[k + 5]!, u = unit(r), v = unit(mix32(r, 3));
        lawnColor(px, pz, tip, 0);
        for (let c = 0; c < 3; c++) { base[c] = tip[c]! + (DARK[c]! - tip[c]!) * .18; tip[c] = tip[c]! * 1.08; }
        for (let leaf = 0; leaf < 3; leaf++) {
          if (!(mask & (1 << leaf))) continue;
          const height = leafShape(r, u, v, px, pz, leaf, corner), ay = t[k + 6 + leaf * 2]!, by = t[k + 7 + leaf * 2]!;
          vertex(corner[0]!, ay, corner[1]!, base, y); vertex(corner[2]!, by, corner[3]!, base, y); vertex(corner[4]!, y + height * .55, corner[5]!, tip, y);
          vertex(corner[2]!, by, corner[3]!, base, y); vertex(corner[6]!, y + height, corner[7]!, tip, y); vertex(corner[4]!, y + height * .55, corner[5]!, tip, y);
          leaves++;
        }
      }
      if (leaves > before) used.push(i);
    }
    this.leaves = leaves;
    const p = position.slice(0, vertices * 3), normal = new Float32Array(vertices * 3);
    faceNormals(p, normal, vertices / 3);
    this.replace(this.blades, { position: p, color: color.slice(0, vertices * 3), normal, root: root.slice(0, vertices) }, used);
  }

  /** A new, exactly sized geometry for `mesh` (the old one is disposed), bounded by its lawns' boxes. */
  private replace(mesh: THREE.Mesh, a: { position: Float32Array; color: Float32Array; normal: Float32Array; root?: Float32Array }, lawns: readonly number[]): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(a.position, 3));
    g.setAttribute("color", new THREE.BufferAttribute(a.color, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(a.normal, 3));
    if (a.root) g.setAttribute("_grassRoot", new THREE.BufferAttribute(a.root, 1));
    // Bounds from the lawns' boxes and heights, without a pass over every vertex.
    const box = new THREE.Box3(), corner = new THREE.Vector3();
    for (const i of lawns) {
      const l = this.lawns[i]!, e = this.cache.get(i);
      if (!e || !(e.maxY >= e.minY)) continue;
      box.expandByPoint(corner.set(l.bbox[0], e.minY - .05, l.bbox[1])).expandByPoint(corner.set(l.bbox[2], e.maxY + .15, l.bbox[3]));
    }
    if (box.isEmpty()) g.computeBoundingBox(); else g.boundingBox = box;
    g.boundingSphere = g.boundingBox!.isEmpty() ? new THREE.Sphere() : g.boundingBox!.getBoundingSphere(new THREE.Sphere());
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = a.position.length > 0;
  }
  private clear(): void { this.surface.geometry.dispose(); this.blades.geometry.dispose(); this.surface.geometry = new THREE.BufferGeometry(); this.blades.geometry = new THREE.BufferGeometry(); this.surface.visible = false; this.blades.visible = false; this.patches = 0; this.leaves = 0; }
  dispose(): void { this.job = null; this.todo = []; this.indexPending = null; this.lawns = []; this.index = null; this.cache.clear(); this.terrains.clear(); this.clear(); this.surface.geometry.dispose(); this.blades.geometry.dispose(); this.surfaceMaterial.dispose(); this.bladeMaterial.dispose(); this.group.removeFromParent(); }
}
