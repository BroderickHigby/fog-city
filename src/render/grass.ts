// DataSF lawn polygons, draped on the actual terrain triangles, with bounded short grass.
// The polygon, road and building work is render-only; no simulation/world data is changed.
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
export interface GrassInfo {
  loaded: boolean; areas: number; patches: number; blades: number;
  surfaceTriangles: number; bladeTriangles: number; drawCalls: number; pending: boolean;
}
export interface GrassOptions { ground: GroundFn; roads?: RoadGraph | null; colliders?: ReadonlyMap<string, TileCollider> }

const bounds = (p: readonly P[]): Box => [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])), Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))];
const overlaps = (a: Box, b: Box): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const key = (x: number, z: number): string => `${x},${z}`;
const cross = (a: P, b: P, p: P): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const area2 = (p: readonly P[]): number => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
function cells(b: Box): string[] {
  const out: string[] = [];
  for (let x = Math.floor(b[0] / 100); x <= Math.floor(b[2] / 100); x++) for (let z = Math.floor(b[1] / 100); z <= Math.floor(b[3] / 100); z++) out.push(key(x, z));
  return out;
}

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

class MaskIndex {
  private readonly buckets = new Map<string, Mask[]>();
  private readonly cover: Set<string>;
  constructor(lawns: readonly Lawn[]) { this.cover = new Set(lawns.flatMap(l => cells(l.bbox))); }
  add(polygon: P[]): void {
    const bbox = bounds(polygon), keys = cells(bbox).filter(k => this.cover.has(k));
    if (!keys.length) return;
    const mask = { polygon, bbox };
    for (const k of keys) { const list = this.buckets.get(k); if (list) list.push(mask); else this.buckets.set(k, [mask]); }
  }
  intersects(bbox: Box): boolean { return cells(bbox).some(k => this.cover.has(k)); }
  get(bbox: Box): Mask[] { return [...new Set(cells(bbox).flatMap(k => this.buckets.get(k) ?? []))].filter(m => overlaps(m.bbox, bbox)); }
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
      index.add([[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]);
      if (++n % 128 === 0) yield;
    }
  }
  for (const tile of opts.colliders?.values() ?? []) {
    for (const b of tile.buildings) {
      if (b.footprint.length < 3 || !index.intersects(bounds(b.footprint))) continue;
      for (const triangle of triangles([b.footprint])) index.add(triangle);
    }
    yield;
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

const GREEN = new THREE.Color(0x3d642b), DRY = new THREE.Color(0x77713e), DARK = new THREE.Color(0x334c24);
function lawnColor(x: number, z: number): THREE.Color {
  const moisture = .5 + .25 * Math.sin(x * .027 + z * .013) + .25 * Math.cos(z * .035 - x * .011);
  return GREEN.clone().lerp(DRY, Math.max(0, moisture - .48) * .65).multiplyScalar(.90 + .08 * Math.sin(x * .11 + z * .04));
}
interface Arrays { position: number[]; color: number[]; roots?: number[] }
const append = (a: Arrays, p: P, y: number, c: THREE.Color, root = y): void => { a.position.push(p[0], y, p[1]); a.color.push(c.r, c.g, c.b); a.roots?.push(root); };
function geometry(a: Arrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(a.position, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(a.color, 3));
  if (a.roots) g.setAttribute("_grassRoot", new THREE.Float32BufferAttribute(a.roots, 1));
  g.computeVertexNormals(); g.computeBoundingSphere(); return g;
}
interface Result { surface: Arrays; blades: Arrays; patches: number; leaves: number }

/** Pure bounded geometry builder exposed for shape, mask and terrain tests. */
export function* buildGrass(lawns: readonly Lawn[], opts: GrassOptions, index: MaskIndex, x: number, z: number): Generator<void, Result> {
  const surface: Arrays = { position: [], color: [] }, blades: Arrays = { position: [], color: [], roots: [] };
  let patches = 0, leaves = 0;
  const nearest = lawns.map(l => ({ l, d: Math.hypot(Math.max(l.bbox[0] - x, 0, x - l.bbox[2]), Math.max(l.bbox[1] - z, 0, z - l.bbox[3])) })).filter(v => v.d <= GRASS_RADIUS).sort((a, b) => a.d - b.d || a.l.id.localeCompare(b.l.id)).slice(0, GRASS_PATCH_CAP);
  for (const { l: lawn } of nearest) {
    const start = surface.position.length, terrain = terrainAt(opts, lawn), obstacles = index.get(lawn.bbox), seed = hashString(lawn.id);
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
          if (surface.position.length / 9 >= GRASS_SURFACE_CAP) break;
          if (Math.abs(cross(piece[0]!, piece[i]!, piece[i + 1]!)) < 1e-6) continue;
          const order = area2(piece) > 0 ? [0, i + 1, i] : [0, i, i + 1];
          for (const j of order) append(surface, piece[j]!, h[j]! + .018, lawnColor(...piece[j]!));
        }
      }
      if (++processed % 16 === 0) yield;
    }
    if (surface.position.length > start) patches++;
    // Small three-leaf tufts: each narrow, bent leaf is two tapered triangles rather than a
    // broad upright spike. Stable world-grid samples thin at distance before the GPU fade.
    const step = .9;
    const b = lawn.bbox;
    for (let gx = Math.floor(Math.max(b[0], x - GRASS_BLADE_RADIUS) / step); gx <= Math.floor(Math.min(b[2], x + GRASS_BLADE_RADIUS) / step); gx++) for (let gz = Math.floor(Math.max(b[1], z - GRASS_BLADE_RADIUS) / step); gz <= Math.floor(Math.min(b[3], z + GRASS_BLADE_RADIUS) / step); gz++) {
      if (++processed % 256 === 0) yield;
      if (blades.position.length / 9 + 6 > GRASS_BLADE_CAP) break;
      const r = mix32(mix32(seed, gx), gz), u = unit(r), v = unit(mix32(r, 3));
      const px = (gx + .18 + u * .64) * step, pz = (gz + .18 + v * .64) * step;
      const distance = Math.hypot(px - x, pz - z);
      if (distance > GRASS_BLADE_RADIUS || unit(mix32(r, 7)) > Math.max(.08, 1 - distance / GRASS_BLADE_RADIUS)) continue;
      const inside = (p: P): boolean => inRing(p, lawn.rings[0]!) && !lawn.rings.slice(1).some(ring => inRing(p, ring)) && !obstacles.some(m => inRing(p, m.polygon));
      if (!inside([px, pz])) continue;
      const y = terrain.ground(px, pz) + .018;
      if (!Number.isFinite(y) || y < 1.218) continue;
      const base = lawnColor(px, pz).lerp(DARK, .18), tip = lawnColor(px, pz).multiplyScalar(1.08);
      for (let leaf = 0; leaf < 3; leaf++) {
        const variation = unit(mix32(r, leaf + 11)), height = .045 + variation * .055;
        const heading = u * Math.PI * 2 + leaf * Math.PI * 2 / 3;
        const tx = Math.cos(heading), tz = Math.sin(heading), width = .003 + v * .003;
        const bend = height * (.18 + variation * .16);
        const a: P = [px - tx * width, pz - tz * width], b: P = [px + tx * width, pz + tz * width];
        const c: P = [px + tx * (bend * .45 - width * .45), pz + tz * (bend * .45 - width * .45)];
        const d: P = [px + tx * bend, pz + tz * bend];
        if (![a, b, c, d].every(inside)) continue;
        const ay = terrain.ground(...a) + .015, by = terrain.ground(...b) + .015;
        append(blades, a, ay, base, y); append(blades, b, by, base, y); append(blades, c, y + height * .55, tip, y);
        append(blades, b, by, base, y); append(blades, d, y + height, tip, y); append(blades, c, y + height * .55, tip, y);
        leaves++;
      }
    }
    yield;
  }
  return { surface, blades, patches, leaves };
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
  private pending: Generator<void, Result> | null = null;
  private x = Infinity; private z = Infinity; private patches = 0; private leaves = 0; private loaded = false; private dirty = false;
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
    this.x = Infinity; this.pending = null; this.dirty = false; this.clear();
  }
  update(x: number, z: number, budgetMs = 3): void {
    if (!this.loaded) return;
    if (!this.lawns.length) { this.x = x; this.z = z; this.pending = null; this.dirty = false; return; }
    if (Math.hypot(x - this.x, z - this.z) >= 20) {
      this.x = x; this.z = z;
      this.pending = null; this.dirty = true;
    }
    const start = performance.now();
    // The citywide obstacle index is independent of the camera. Moving while it builds
    // must not restart it; only the later camera-dependent geometry task may be replaced.
    while (this.indexPending) {
      const next = this.indexPending.next();
      if (next.done) { this.index = next.value; this.indexPending = null; break; }
      if (performance.now() - start >= budgetMs) return;
    }
    if (this.index && this.dirty) { this.pending = buildGrass(this.lawns, this.opts, this.index, this.x, this.z); this.dirty = false; }
    while (this.pending) {
      const next = this.pending.next();
      if (next.done) {
        this.surface.geometry.dispose(); this.blades.geometry.dispose();
        this.surface.geometry = geometry(next.value.surface); this.blades.geometry = geometry(next.value.blades); this.patches = next.value.patches; this.leaves = next.value.leaves; this.pending = null;
        this.surface.visible = this.surface.geometry.getAttribute("position").count > 0; this.blades.visible = this.blades.geometry.getAttribute("position").count > 0; break;
      }
      if (performance.now() - start >= budgetMs) break;
    }
  }
  settled(): boolean { return !this.indexPending && !this.pending && !this.dirty && (!this.loaded || Number.isFinite(this.x)); }
  info(): GrassInfo {
    const surfaceTriangles = (this.surface.geometry.getAttribute("position")?.count ?? 0) / 3, bladeTriangles = (this.blades.geometry.getAttribute("position")?.count ?? 0) / 3;
    return { loaded: this.loaded, areas: this.lawns.length, patches: this.patches, blades: this.leaves, surfaceTriangles, bladeTriangles, drawCalls: Number(surfaceTriangles > 0) + Number(bladeTriangles > 0), pending: !this.settled() };
  }
  private clear(): void { this.surface.geometry.dispose(); this.blades.geometry.dispose(); this.surface.geometry = new THREE.BufferGeometry(); this.blades.geometry = new THREE.BufferGeometry(); this.surface.visible = false; this.blades.visible = false; this.patches = 0; this.leaves = 0; }
  dispose(): void { this.pending = null; this.indexPending = null; this.dirty = false; this.lawns = []; this.index = null; this.clear(); this.surface.geometry.dispose(); this.blades.geometry.dispose(); this.surfaceMaterial.dispose(); this.bladeMaterial.dispose(); this.group.removeFromParent(); }
}
