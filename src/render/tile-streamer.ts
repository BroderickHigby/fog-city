// Streams world tiles in and out around the camera.
//
//  - Which tiles: tile-select.ts (distance from the camera to each tile's rectangle, with
//    hysteresis). Re-evaluated when the camera has moved 20 m or a load finished.
//  - glb tiles load with the tile loader (gltf-loader.ts: GLTFLoader with the meshopt decoder,
//    since the pipeline's tiles are meshopt-compressed and quantised), a few at a time. Meshes
//    are classified by material or
//    node name (materials.ts: tileLayer) and get the shared materials; unknown meshes keep
//    their own. Layers the glb lacks (e.g. roads) are built from collider data and the road
//    graph. Ground triangles lying on the water plane are dropped so the Bay shows through.
//  - glb: null tiles are built from collider data by a generator pumped under a per-frame
//    time budget, so a big tile never stalls the sim loop.
//  - A tile with nothing to show (no glb, or its glb failed, and no collider) ends "failed",
//    never "ready", so renderInfo().tilesFailed counts it.
//  - Every tile also gets runtime street props (lamps, trees) from the road graph.
//  - Unload disposes every per-tile geometry, texture and instance buffer.

import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { createTileLoader } from "./gltf-loader.ts";
import type { TileCollider } from "../sim/world.ts";
import { materialFor, tileLayer, type SharedMaterials } from "./materials.ts";
import { buildTileProps, geometryFromMeshData, type NightMaterials, type TileProps } from "./props.ts";
import {
  assignEdgesToTiles,
  nodeClearance,
  nodeDegrees,
  nodeElevations,
  nodeHalfWidth,
  streetTreeSpots,
  streetlightSpots,
} from "./roads.ts";
import { buildTileMeshes, type TileMeshes } from "./tile-build.ts";
import type { RoadContext } from "./tile-geometry.ts";
import { DEFAULT_HYSTERESIS_M, DEFAULT_RADIUS_M, selectTiles, tileBounds, type TileBounds } from "./tile-select.ts";
import type { GroundFn, Manifest, ManifestTile, RoadEdge, RoadGraph } from "./types.ts";

export interface StreamerOptions {
  parent: THREE.Object3D;
  manifest: Manifest;
  /** URL prefix of the world directory, ending in "/". */
  base: string;
  colliders: ReadonlyMap<string, TileCollider>;
  roads: RoadGraph | null;
  ground: GroundFn;
  materials: SharedMaterials;
  night: NightMaterials;
  radius?: number;
  hysteresis?: number;
  /** glb downloads in flight at once. */
  maxConcurrent?: number;
  /** Test seam: replaces the tile loader (createTileLoader().loadAsync). */
  loadGltf?: (url: string) => Promise<GLTF>;
  /** Called with each tile's group when it becomes visible (e.g. to set shadow flags). */
  onReady?: (group: THREE.Group) => void;
}

type TileState = "loading" | "building" | "ready" | "failed";

interface TileRecord {
  id: string;
  spec: ManifestTile;
  state: TileState;
  group: THREE.Group;
  gen: Generator<void, TileMeshes, void> | null;
  props: TileProps | null;
  geometries: THREE.BufferGeometry[];
  ownedMaterials: THREE.Material[];
  textures: THREE.Texture[];
  /** Index buffers whose building ranges can be hidden. */
  hideable: THREE.BufferGeometry[];
  hidden: Set<string>;
  dropped: boolean;
  /** The glb loaded: the tile has something to show even without a collider. */
  glbLoaded: boolean;
  error?: string;
}

export interface StreamerStats {
  total: number;
  ready: number;
  pending: number;
  failed: number;
  glbReady: number;
  builtReady: number;
}

const RESELECT_M = 20;

export class TileStreamer {
  readonly bounds: TileBounds[];
  private readonly opts: StreamerOptions;
  private readonly specs = new Map<string, ManifestTile>();
  private readonly roadsByTile: Map<string, RoadEdge[]>;
  private readonly roadCtx: RoadContext | null;
  private readonly clearance: Map<string, number>;
  private readonly records = new Map<string, TileRecord>();
  private queue: string[] = [];
  private inFlight = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private dirty = true;
  private hiddenBuildings = new Set<string>();
  private loader: (url: string) => Promise<GLTF>;
  private nightVisible = false;
  radius: number;
  hysteresis: number;

  constructor(opts: StreamerOptions) {
    this.opts = opts;
    this.radius = opts.radius ?? DEFAULT_RADIUS_M;
    this.hysteresis = opts.hysteresis ?? DEFAULT_HYSTERESIS_M;
    const size = opts.manifest.tileSizeM ?? 500;
    this.bounds = opts.manifest.tiles.map((t) => {
      this.specs.set(t.id, t);
      return tileBounds(t, size, opts.colliders.get(t.id) ?? null);
    });
    const edges = opts.roads?.edges ?? [];
    this.roadsByTile = assignEdgesToTiles(edges, this.bounds);
    this.clearance = opts.roads ? nodeClearance(opts.roads) : new Map();
    this.roadCtx = opts.roads
      ? {
          ground: opts.ground,
          degrees: nodeDegrees(opts.roads),
          nodeHalfWidth: nodeHalfWidth(opts.roads),
          nodeOuter: this.clearance,
          nodeY: nodeElevations(opts.roads),
        }
      : null;
    if (opts.loadGltf) {
      this.loader = opts.loadGltf;
    } else {
      const gltf = createTileLoader();
      this.loader = (url) => gltf.loadAsync(url);
    }
  }

  stats(out?: StreamerStats): StreamerStats {
    let ready = 0;
    let pending = 0;
    let failed = 0;
    let glbReady = 0;
    for (const r of this.records.values()) {
      if (r.state === "ready") {
        ready++;
        if (r.spec.glb) glbReady++;
      } else if (r.state === "failed") failed++;
      else pending++;
    }
    const r = out ?? { total: 0, ready: 0, pending: 0, failed: 0, glbReady: 0, builtReady: 0 };
    r.total = this.bounds.length;
    r.ready = ready;
    r.pending = pending + this.queue.length;
    r.failed = failed;
    r.glbReady = glbReady;
    r.builtReady = ready - glbReady;
    return r;
  }

  /** True when nothing is queued, loading or building. */
  settled(): boolean {
    if (this.dirty || this.queue.length > 0 || this.inFlight > 0) return false;
    for (const r of this.records.values()) if (r.state === "loading" || r.state === "building") return false;
    return true;
  }

  /** Buildings replaced by landmarks: hidden in present tiles now and in tiles loaded later. */
  hideBuildings(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) {
      if (!this.hiddenBuildings.has(id)) {
        this.hiddenBuildings.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    for (const r of this.records.values()) if (r.state === "ready") this.applyHidden(r);
  }

  setNight(on: boolean): void {
    this.nightVisible = on;
    for (const r of this.records.values()) if (r.props) for (const o of r.props.nightOnly) o.visible = on;
  }

  /** Call once per frame with the camera's ground position and a time budget for building work. */
  update(x: number, z: number, budgetMs = 4): void {
    if (this.dirty || !(Math.abs(x - this.lastX) < RESELECT_M && Math.abs(z - this.lastZ) < RESELECT_M)) {
      this.reselect(x, z);
    }
    this.startLoads();
    this.pump(budgetMs);
  }

  private reselect(x: number, z: number): void {
    this.lastX = x;
    this.lastZ = z;
    this.dirty = false;
    const present = new Set<string>([...this.records.keys(), ...this.queue]);
    const sel = selectTiles(this.bounds, x, z, present, { radius: this.radius, hysteresis: this.hysteresis });
    for (const id of sel.unload) this.unload(id);
    // Re-sort the queue nearest first with the new wants.
    const want = new Set(sel.load);
    const kept = this.queue.filter((id) => !sel.unload.includes(id));
    this.queue = [...sel.load, ...kept.filter((id) => !want.has(id))];
    if (this.queue.length > 1) {
      const d = new Map(this.bounds.map((b) => [b.id, Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ))]));
      this.queue.sort((a, b) => (d.get(a) ?? 0) - (d.get(b) ?? 0) || (a < b ? -1 : 1));
    }
  }

  private startLoads(): void {
    const max = this.opts.maxConcurrent ?? 3;
    while (this.queue.length > 0 && this.inFlight < max) {
      const id = this.queue.shift()!;
      if (this.records.has(id)) continue;
      const spec = this.specs.get(id);
      if (!spec) continue;
      const rec: TileRecord = {
        id,
        spec,
        state: "loading",
        group: new THREE.Group(),
        gen: null,
        props: null,
        geometries: [],
        ownedMaterials: [],
        textures: [],
        hideable: [],
        hidden: new Set(),
        dropped: false,
        glbLoaded: false,
      };
      rec.group.name = `tile:${id}`;
      rec.group.matrixAutoUpdate = false;
      this.records.set(id, rec);
      if (spec.glb) {
        this.inFlight++;
        const url = this.opts.base + spec.glb;
        this.loader(url).then(
          (gltf) => {
            this.inFlight--;
            this.onGltf(rec, gltf);
          },
          (err: unknown) => {
            this.inFlight--;
            if (rec.dropped) return;
            // A broken glb falls back to building the whole tile from collider data (and with
            // no collider either, the tile fails).
            rec.error = `${url}: ${err instanceof Error ? err.message : String(err)}`;
            if (this.opts.colliders.has(id)) console.warn(`[fog-city] tile ${id}: glb failed, building from collider. ${rec.error}`);
            this.startBuild(rec, { buildings: true, ground: true, roads: true });
          },
        );
      } else {
        this.startBuild(rec, { buildings: true, ground: true, roads: true });
      }
    }
  }

  private onGltf(rec: TileRecord, gltf: GLTF): void {
    const root = gltf.scene;
    if (rec.dropped) {
      disposeObject(root);
      return;
    }
    rec.glbLoaded = true;
    root.updateMatrixWorld(true);
    const layers = { buildings: false, ground: false, roads: false };
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry;
      rec.geometries.push(geo);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const next = mats.map((m) => {
        const layer = tileLayer(m.name, mesh.name);
        if (!layer) {
          rec.ownedMaterials.push(m);
          for (const t of materialTextures(m)) rec.textures.push(t);
          return m;
        }
        if (layer === "building") layers.buildings = true;
        else if (layer === "ground") {
          layers.ground = true;
          dropWaterTriangles(geo, mesh.matrixWorld);
        } else if (layer === "road" || layer === "freeway") layers.roads = true;
        disposeMaterial(m);
        return materialFor(this.opts.materials, layer, { hasNormals: !!geo.getAttribute("normal"), hasUv: !!geo.getAttribute("uv") });
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
      // Building ranges: primitive extras (this repo) or node extras (pipeline).
      const nodeRanges = (mesh.userData as { buildings?: unknown }).buildings;
      if (!geo.userData.fcBuildings && Array.isArray(nodeRanges)) geo.userData.fcBuildings = nodeRanges;
      if (Array.isArray(geo.userData.fcBuildings)) rec.hideable.push(geo);
    });
    root.traverse((o) => (o.matrixAutoUpdate = false));
    rec.group.add(root);
    // Build whatever the glb did not provide.
    this.startBuild(rec, { buildings: !layers.buildings, ground: !layers.ground, roads: !layers.roads });
  }

  private startBuild(rec: TileRecord, layers: { buildings: boolean; ground: boolean; roads: boolean }): void {
    const collider = this.opts.colliders.get(rec.id);
    if (!collider && !rec.glbLoaded) {
      this.fail(rec, rec.error ?? "no glb and no collider");
      return;
    }
    if (!collider || (!layers.buildings && !layers.ground && !layers.roads)) {
      this.finish(rec, null);
      return;
    }
    rec.state = "building";
    rec.gen = buildTileMeshes({
      collider,
      bounds: this.bounds.find((b) => b.id === rec.id)!,
      roads: this.roadsByTile.get(rec.id) ?? [],
      roadCtx: this.roadCtx,
      layers,
    });
  }

  /** Nothing to show for this tile: it stays out of the scene and counts as failed until unloaded. */
  private fail(rec: TileRecord, why: string): void {
    if (rec.dropped) return;
    rec.state = "failed";
    rec.error = why;
    console.warn(`[fog-city] tile ${rec.id}: failed (${why})`);
    this.dirty = true;
  }

  private pump(budgetMs: number): void {
    const t0 = performance.now();
    for (const rec of this.records.values()) {
      if (rec.state !== "building" || !rec.gen) continue;
      for (;;) {
        const r = rec.gen.next();
        if (r.done) {
          rec.gen = null;
          this.finish(rec, r.value);
          break;
        }
        if (performance.now() - t0 > budgetMs) return;
      }
      if (performance.now() - t0 > budgetMs) return;
    }
  }

  private finish(rec: TileRecord, meshes: TileMeshes | null): void {
    if (rec.dropped) return;
    const m = this.opts.materials;
    if (meshes) {
      const add = (data: TileMeshes["ground"], mat: THREE.Material, name: string): void => {
        if (!data) return;
        const g = geometryFromMeshData(data);
        rec.geometries.push(g);
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = name;
        mesh.matrixAutoUpdate = false;
        rec.group.add(mesh);
        if (data.ranges.length > 0) rec.hideable.push(g);
      };
      add(meshes.ground, m.ground, "ground");
      add(meshes.buildings, m.building, "buildings");
      add(meshes.roads, m.road, "roads");
    }
    // Street props from the road graph.
    const edges = this.roadsByTile.get(rec.id) ?? [];
    if (edges.length > 0) {
      const props = buildTileProps(streetlightSpots(edges, this.clearance), streetTreeSpots(edges, this.clearance), this.opts.ground, m, this.opts.night);
      for (const o of props.nightOnly) o.visible = this.nightVisible;
      rec.props = props;
      rec.group.add(props.group);
    }
    this.applyHidden(rec);
    rec.group.updateMatrixWorld(true);
    rec.state = "ready";
    this.opts.onReady?.(rec.group);
    this.opts.parent.add(rec.group);
    this.dirty = true;
  }

  private applyHidden(rec: TileRecord): void {
    for (const g of rec.hideable) {
      const ranges = g.userData.fcBuildings as Array<[string, number, number]> | undefined;
      const index = g.getIndex();
      if (!ranges || !index) continue;
      let touched = false;
      for (const [id, first, count] of ranges) {
        if (!this.hiddenBuildings.has(id) || rec.hidden.has(id)) continue;
        const arr = index.array as Uint16Array | Uint32Array;
        const v = arr[first] ?? 0;
        for (let i = first; i < first + count && i < arr.length; i++) arr[i] = v;
        rec.hidden.add(id);
        touched = true;
      }
      if (touched) index.needsUpdate = true;
    }
  }

  private unload(id: string): void {
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    rec.dropped = true;
    rec.gen = null;
    rec.group.removeFromParent();
    for (const g of rec.geometries) g.dispose();
    for (const mat of rec.ownedMaterials) mat.dispose();
    for (const t of rec.textures) t.dispose();
    rec.props?.dispose();
    this.dirty = true;
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.unload(id);
    this.queue = [];
  }
}

const _v = new THREE.Vector3();

/**
 * Remove triangles whose three corners all lie on or below the water plane (y <= 0.02 in
 * world space): flat "water" cells in a ground mesh would otherwise cover the Bay.
 */
export function dropWaterTriangles(geo: THREE.BufferGeometry, matrixWorld: THREE.Matrix4, waterY = 0.02): number {
  const index = geo.getIndex();
  const pos = geo.getAttribute("position");
  if (!index || !pos) return 0;
  const n = pos.count;
  const wet = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
    wet[i] = _v.y <= waterY ? 1 : 0;
  }
  const src = index.array;
  const keep: number[] = [];
  let dropped = 0;
  for (let t = 0; t + 2 < src.length; t += 3) {
    const a = src[t]!;
    const b = src[t + 1]!;
    const c = src[t + 2]!;
    if (wet[a] && wet[b] && wet[c]) {
      dropped++;
      continue;
    }
    keep.push(a, b, c);
  }
  if (dropped > 0) {
    geo.setIndex(new THREE.BufferAttribute(n < 65536 ? new Uint16Array(keep) : new Uint32Array(keep), 1));
    geo.clearGroups();
  }
  return dropped;
}

function materialTextures(m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture);
  return out;
}

function disposeMaterial(m: THREE.Material): void {
  for (const t of materialTextures(m)) t.dispose();
  m.dispose();
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) disposeMaterial(m);
  });
}
