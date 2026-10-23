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
//  - A glb that fails to load is fetched once more after a short backoff (a transient network
//    error); if that fails too, the tile is built from its collider. A tile with nothing to
//    show (no glb, or its glb failed twice, and no collider) ends "failed", never "ready", so
//    renderInfo().tilesFailed counts it. It stays failed until the camera leaves and returns.
//  - Every tile also gets runtime street props (lamps, trees) from the road graph.
//  - Unload disposes every per-tile geometry, texture and instance buffer.

import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { createTileLoader } from "./gltf-loader.ts";
import { groundSkirt, lakeSurface, type SimpleMesh } from "./ground-extras.ts";
import type { TileCollider } from "../sim/world.ts";
import { groundCutMaterial, materialFor, tileLayer, type SharedMaterials } from "./materials.ts";
import { buildTileProps, geometryFromMeshData, type NightMaterials, type TileProps } from "./props.ts";
import {
  assignEdgesToTiles,
  nodeClearance,
  nodeDegrees,
  nodeElevations,
  nodeHalfWidth,
  streetTreeSpots,
  streetlightSpots,
  type Spot,
} from "./roads.ts";
import { PropClearance } from "./prop-clearance.ts";
import { boreCuts, boreMesh, quayFaces, shoreByTile, type ShoreSegment, type TunnelLike } from "./structures.ts";
import { sidewalkMesh, sidewalksByTile, type SidewalkGraph, type SidewalkLine } from "./sidewalks.ts";
import { buildTileMeshes, type TileMeshes } from "./tile-build.ts";
import { decodeFronts, type FacadeMeshOut, type FrontRow, type LookFn } from "./house-kit.ts";
import { applyHouseKit, kitGeometry } from "./house-kit-mesh.ts";
import { buildShopfronts, mergePlacements, planHouseKit, type KitDoc, type ProtoLib, type ShopPlan, type StorefrontAnchor } from "./house-kit-props.ts";
import { shopfrontFor } from "../content/storefronts.ts";
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
  /**
   * The ground as the tiles draw it (ground.ts makeDrawnGroundFn: each lattice cell's two
   * triangles), for what the renderer stands on it itself (street props). Default: `ground`.
   */
  drawnGround?: GroundFn;
  materials: SharedMaterials;
  night: NightMaterials;
  radius?: number;
  hysteresis?: number;
  /** glb downloads in flight at once. */
  maxConcurrent?: number;
  /** A failed glb is fetched once more after this many ms; 0 = no retry. Default GLB_RETRY_MS. */
  glbRetryMs?: number;
  /** Test seam: replaces the tile loader (createTileLoader().loadAsync). */
  loadGltf?: (url: string) => Promise<GLTF>;
  /** Called with each tile's group when it becomes visible (e.g. to set shadow flags). */
  onReady?: (group: THREE.Group) => void;
  /** Called with each ground material a tile makes for itself (bores cut out), so it can wear the shared ground's detail. */
  onGroundMaterial?: (m: THREE.MeshStandardMaterial) => void;
  /** Called when a tile enters (true) or leaves (false) the scene, e.g. to hide the far layer under it. */
  onTileVisible?: (id: string, visible: boolean) => void;
  /**
   * The inland lakes' water (W-11; Water.lakeMaterial). With it, every tile whose heightfield has
   * lake samples gets a "lakes" mesh at their level (ground-extras.ts lakeSurface). The ground's
   * own colours are the pipeline's ground classes and are never changed here.
   */
  lakeMaterial?: THREE.Material;
  /** boundary.json's shore lines: quay faces where the land stands over the sea (structures.ts). */
  shore?: ReadonlyArray<{ closed: boolean; lake?: unknown; points: ReadonlyArray<readonly number[]> }>;
  /**
   * When a tile's glb fails for good: that tile's own collider, fetched lazily, with the
   * building meta (use, year, stories) the fallback look reads; null when there is none (the
   * hosted build ships no per-tile colliders), and the tile is built from `colliders`.
   */
  fallbackCollider?: (id: string) => Promise<TileCollider | null>;
  /**
   * The house kit's colours and materials per building (house-colours.ts houseLookFn: palettes by
   * era and district, K3; landmarks, K10). Default: the tile's own colours.
   */
  houseLook?: LookFn;
  /** The world's storefront anchors (storefronts.json, K5): shop glazing on their walls and a shopfront each. */
  storefronts?: readonly StorefrontAnchor[] | null;
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
  glbAttempts: number;
  /** The backoff before the glb's second fetch; cleared on unload. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** The tile's own collider (fallbackCollider), preferred over `colliders` for the fallback build. */
  collider?: TileCollider;
  error?: string;
  /** Roads built here from the graph (they bring their own sidewalks), not from the glb. */
  builtRoads: boolean;
  /** The sidewalk bands are in the group. */
  sidewalks: boolean;
  /** What the house kit's geometry is built from (the glb's fronts and the facade pass). */
  kitSrc?: { fronts: FrontRow[]; prep: FacadeMeshOut };
  /** The house kit's meshes while the tile is near the camera (bays, stoops, mouldings, roof props, shopfronts). */
  kit: THREE.Mesh[] | null;
}

/** The house kit's geometry is built for tiles this near the camera and dropped beyond KIT_DROP_M. */
export const KIT_NEAR_M = 400;
export const KIT_DROP_M = 600;

export interface HouseKitStats {
  /** Tiles with their kit built. */
  tiles: number;
  bays: number;
  stoops: number;
  rooflines: number;
  roofProps: number;
  shopfronts: number;
  triangles: number;
  drawCalls: number;
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
/** Backoff before a failed glb's one retry. */
export const GLB_RETRY_MS = 1500;

export class TileStreamer {
  readonly bounds: TileBounds[];
  private readonly opts: StreamerOptions;
  private readonly specs = new Map<string, ManifestTile>();
  private readonly roadsByTile: Map<string, RoadEdge[]>;
  private readonly roadCtx: RoadContext | null;
  private readonly clearance: Map<string, number>;
  private readonly propClearance: PropClearance;
  private readonly roadById: Map<string, RoadEdge>;
  private sidewalksByTile: Map<string, SidewalkLine[]> | null = null;
  private readonly shoreByTile: Map<string, ShoreSegment[]> | null;
  private readonly records = new Map<string, TileRecord>();
  private queue: string[] = [];
  private inFlight = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private dirty = true;
  private hiddenBuildings = new Set<string>();
  private loader: (url: string) => Promise<GLTF>;
  private nightVisible = false;
  private kitLib: ProtoLib | null = null;
  private kitDoc: KitDoc | null = null;
  private shopsByTile: Map<string, Array<{ anchor: StorefrontAnchor; plan: ShopPlan }>> | null = null;
  /** Every anchor by the tile its building's glb is in (an anchor across a border goes to both). */
  private anchorsByTile: Map<string, StorefrontAnchor[]> | null = null;
  private camX = NaN;
  private camZ = NaN;
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
    this.propClearance = new PropClearance(edges, opts.colliders.values());
    this.roadById = new Map(edges.map((e) => [e.id, e]));
    this.shoreByTile = opts.shore ? shoreByTile(opts.shore, opts.manifest.tileSizeM ?? 500) : null;
    if (opts.storefronts) this.indexStorefronts(opts.storefronts);
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
    this.camX = x;
    this.camZ = z;
    if (this.dirty || !(Math.abs(x - this.lastX) < RESELECT_M && Math.abs(z - this.lastZ) < RESELECT_M)) {
      this.reselect(x, z);
    }
    this.startLoads();
    this.pump(budgetMs);
    this.updateKits(x, z);
  }

  /** The house-kit prototypes (house-kit-mesh.ts loadKitLib); near tiles get their kit from then on. */
  setKitLib(lib: ProtoLib, doc: KitDoc): void {
    this.kitLib = lib;
    this.kitDoc = doc;
    for (const r of this.records.values()) this.dropKit(r);
  }

  /** Group the storefront anchors by tile (called once, from the constructor). */
  private indexStorefronts(anchors: readonly StorefrontAnchor[]): void {
    const size = this.opts.manifest.tileSizeM ?? 500;
    const shops = new Map<string, Array<{ anchor: StorefrontAnchor; plan: ShopPlan }>>();
    const all = new Map<string, StorefrontAnchor[]>();
    const tileAt = new Map(this.bounds.map((b) => [`${Math.floor((b.minX + 1) / size)},${Math.floor((b.minZ + 1) / size)}`, b.id]));
    for (const a of anchors) {
      const tx = Math.floor(a.x / size), tz = Math.floor(a.z / size);
      const id = tileAt.get(`${tx},${tz}`);
      // The anchor's wall may be in the neighbouring tile's glb: offer it to every tile within 2 m.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const near = tileAt.get(`${tx + dx},${tz + dz}`);
          if (!near) continue;
          const b = this.bounds.find((t) => t.id === near)!;
          if (a.x < b.minX - 2 || a.x > b.maxX + 2 || a.z < b.minZ - 2 || a.z > b.maxZ + 2) continue;
          (all.get(near) ?? all.set(near, []).get(near)!).push(a);
        }
      }
      if (!id) continue;
      const plan = shopfrontFor(a);
      if (!plan) continue;
      (shops.get(id) ?? shops.set(id, []).get(id)!).push({ anchor: a, plan });
    }
    this.shopsByTile = shops;
    this.anchorsByTile = all;
  }

  /** The house kit's totals over the tiles that have it built. */
  houseKitStats(): HouseKitStats {
    const st: HouseKitStats = { tiles: 0, bays: 0, stoops: 0, rooflines: 0, roofProps: 0, shopfronts: 0, triangles: 0, drawCalls: 0 };
    for (const r of this.records.values()) {
      if (!r.kit) continue;
      st.tiles++;
      for (const m of r.kit) {
        const k = m.userData.kit as { bays?: number; stoops?: number; rooflines?: number; roofProps?: number; shopfronts?: number; triangles: number };
        st.bays += k.bays ?? 0;
        st.stoops += k.stoops ?? 0;
        st.rooflines += k.rooflines ?? 0;
        st.roofProps += k.roofProps ?? 0;
        st.shopfronts += k.shopfronts ?? 0;
        st.triangles += k.triangles;
        st.drawCalls++;
      }
    }
    return st;
  }

  /** Storefront anchors whose shopfront is built (for tests): id, x, z. */
  shopfrontsBuilt(): Array<{ id: string; x: number; z: number }> {
    const out: Array<{ id: string; x: number; z: number }> = [];
    for (const r of this.records.values()) {
      if (!r.kit || !this.shopsByTile) continue;
      if (!r.kit.some((m) => m.name === "shopfronts")) continue;
      for (const s of this.shopsByTile.get(r.id) ?? []) out.push({ id: s.anchor.id, x: s.anchor.x, z: s.anchor.z });
    }
    return out;
  }

  private tileDistance(id: string, x: number, z: number): number {
    const b = this.bounds.find((t) => t.id === id);
    if (!b) return Infinity;
    return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
  }

  /** Build the kit of at most one near tile per call; drop the kits of tiles that went far. */
  private updateKits(x: number, z: number): void {
    if (!this.kitLib && !this.shopsByTile) return;
    let built = false;
    for (const r of this.records.values()) {
      if (r.state !== "ready") continue;
      const d = this.tileDistance(r.id, x, z);
      if (r.kit && d > KIT_DROP_M) this.dropKit(r);
      else if (!r.kit && !built && d <= KIT_NEAR_M) {
        this.buildKit(r);
        built = true;
      }
    }
  }

  /** True when every tile within KIT_NEAR_M of the camera has its kit (or the kit is off). */
  kitsSettled(): boolean {
    if (!this.kitLib && !this.shopsByTile) return true;
    for (const r of this.records.values()) if (r.state === "ready" && !r.kit && this.tileDistance(r.id, this.camX, this.camZ) <= KIT_NEAR_M) return false;
    return true;
  }

  private buildKit(rec: TileRecord): void {
    rec.kit = [];
    const mat = this.opts.materials.houseKit;
    if (this.kitLib && this.kitDoc && rec.kitSrc) {
      const collider = rec.collider ?? this.opts.colliders.get(rec.id);
      const roofs = new Map((collider?.buildings ?? []).map((b) => [b.id, { footprint: b.footprint, topY: b.topY, baseY: b.baseY }]));
      const { placements, stats } = planHouseKit(this.kitDoc, rec.kitSrc.fronts, rec.kitSrc.prep.frontWalls, rec.kitSrc.prep.frontDoors, rec.kitSrc.prep.buildings, roofs);
      const merged = mergePlacements(this.kitLib, placements);
      if (merged.triangles > 0) {
        const mesh = new THREE.Mesh(kitGeometry(merged), mat);
        mesh.name = "house-kit";
        mesh.matrixAutoUpdate = false;
        mesh.userData.kit = { ...stats, triangles: merged.triangles };
        rec.kit.push(mesh);
      }
    }
    const shops = this.shopsByTile?.get(rec.id);
    if (shops && shops.length > 0) {
      const { mesh: sm, count } = buildShopfronts(shops);
      if (sm.triangles > 0) {
        const mesh = new THREE.Mesh(kitGeometry(sm), mat);
        mesh.name = "shopfronts";
        mesh.matrixAutoUpdate = false;
        mesh.userData.kit = { shopfronts: count, triangles: sm.triangles };
        rec.kit.push(mesh);
      }
    }
    for (const m of rec.kit) {
      rec.group.add(m);
      m.updateMatrixWorld(true);
    }
  }

  private dropKit(rec: TileRecord): void {
    if (!rec.kit) return;
    for (const m of rec.kit) {
      rec.group.remove(m);
      m.geometry.dispose();
    }
    rec.kit = null;
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
        glbAttempts: 0,
        retryTimer: null,
        builtRoads: false,
        sidewalks: false,
        kit: null,
      };
      rec.group.name = `tile:${id}`;
      rec.group.matrixAutoUpdate = false;
      this.records.set(id, rec);
      if (spec.glb) {
        this.loadGlb(rec, spec.glb);
      } else {
        this.startBuild(rec, { buildings: true, ground: true, roads: true });
      }
    }
  }

  private loadGlb(rec: TileRecord, glb: string): void {
    const url = this.opts.base + glb;
    rec.glbAttempts++;
    this.inFlight++;
    this.loader(url).then(
      (gltf) => {
        this.inFlight--;
        this.onGltf(rec, gltf);
      },
      (err: unknown) => {
        this.inFlight--;
        if (rec.dropped) return;
        rec.error = `${url}: ${err instanceof Error ? err.message : String(err)}`;
        const retryMs = this.opts.glbRetryMs ?? GLB_RETRY_MS;
        if (rec.glbAttempts < 2 && retryMs > 0) {
          // Once more after a backoff: a dropped connection or a server hiccup is not a broken tile.
          rec.retryTimer = setTimeout(() => {
            rec.retryTimer = null;
            if (!rec.dropped) this.loadGlb(rec, glb);
          }, retryMs);
          return;
        }
        // A broken glb falls back to building the whole tile from collider data: the tile's
        // own collider when it can be fetched (it carries the building meta), else the one
        // the streamer was given; with neither, the tile fails.
        const fallback = (): void => {
          if (rec.dropped) return;
          if (rec.collider || this.opts.colliders.has(rec.id)) console.warn(`[fog-city] tile ${rec.id}: glb failed, building from collider. ${rec.error}`);
          this.startBuild(rec, { buildings: true, ground: true, roads: true });
        };
        if (!this.opts.fallbackCollider) {
          fallback();
          return;
        }
        this.opts.fallbackCollider(rec.id).then(
          (c) => {
            if (c) rec.collider = c;
            fallback();
          },
          () => fallback(),
        );
      },
    );
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
        if (layer === "ground") {
          const cut = this.groundCut(rec);
          if (cut) return cut;
        }
        return materialFor(this.opts.materials, layer, { hasNormals: !!geo.getAttribute("normal"), hasUv: !!geo.getAttribute("uv") });
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
      // Building ranges: primitive extras (this repo) or node extras (pipeline).
      const ud = mesh.userData as { buildings?: unknown; scenery?: unknown; fronts?: unknown };
      const nodeRanges = ud.buildings ?? ud.scenery;
      if (!geo.userData.fcBuildings && Array.isArray(nodeRanges)) geo.userData.fcBuildings = nodeRanges;
      if (Array.isArray(geo.userData.fcBuildings)) rec.hideable.push(geo);
      if (mats.some((m) => tileLayer(m.name, mesh.name) === "building")) {
        // The house kit: per-wall frames, doors and garages, palette colours (house-kit.ts).
        const bbox = rec.spec.bbox;
        const fronts = bbox ? decodeFronts(ud.fronts, bbox[0], bbox[1]) : [];
        const prep = applyHouseKit(geo, mesh.matrixWorld, (geo.userData.fcBuildings as Array<[string, number, number]> | undefined) ?? [], fronts, this.opts.houseLook, this.anchorsByTile?.get(rec.id));
        if (prep && mesh.name === "buildings") rec.kitSrc = { fronts, prep };
      }
    });
    root.traverse((o) => (o.matrixAutoUpdate = false));
    rec.group.add(root);
    // Build whatever the glb did not provide.
    this.startBuild(rec, { buildings: !layers.buildings, ground: !layers.ground, roads: !layers.roads });
  }

  private startBuild(rec: TileRecord, layers: { buildings: boolean; ground: boolean; roads: boolean }): void {
    const collider = rec.collider ?? this.opts.colliders.get(rec.id);
    if (!collider && !rec.glbLoaded) {
      this.fail(rec, rec.error ?? "no glb and no collider");
      return;
    }
    if (!collider || (!layers.buildings && !layers.ground && !layers.roads)) {
      this.finish(rec, null);
      return;
    }
    rec.state = "building";
    rec.builtRoads = layers.roads;
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
      if (meshes.buildings) {
        const before = rec.geometries.length;
        add(meshes.buildings, m.building, "buildings");
        const g = rec.geometries[before];
        if (g) applyHouseKit(g, new THREE.Matrix4(), meshes.buildings.ranges, [], this.opts.houseLook);
      }
      add(meshes.roads, m.road, "roads");
    }
    this.addGroundExtras(rec);
    this.addSidewalks(rec);
    // Street props from the road graph: on the ground, clear of every carriageway, building and
    // water (W-44), never along a structure (a deck's or a bore's ground is not its surface).
    const edges = this.roadsByTile.get(rec.id) ?? [];
    if (edges.length > 0) {
      const spots = tilePropSpots(edges, this.clearance, this.propClearance);
      const props = buildTileProps(spots.lamps, spots.trees, this.opts.drawnGround ?? this.opts.ground, m, this.opts.night);
      for (const o of props.nightOnly) o.visible = this.nightVisible;
      rec.props = props;
      rec.group.add(props.group);
    }
    this.applyHidden(rec);
    rec.group.updateMatrixWorld(true);
    rec.state = "ready";
    this.opts.onReady?.(rec.group);
    this.opts.parent.add(rec.group);
    this.opts.onTileVisible?.(rec.id, true);
    this.dirty = true;
  }

  /**
   * The world's sidewalk graph (sidewalks.json; W-45): every tile whose roads came from its glb
   * gets the bands of the sidewalks whose midpoint lies in it, now and when it loads later.
   */
  setSidewalks(graph: SidewalkGraph | null): void {
    this.sidewalksByTile = graph ? sidewalksByTile(graph, this.opts.manifest.tileSizeM ?? 500) : null;
    for (const r of this.records.values()) if (r.state === "ready") this.addSidewalks(r);
  }

  private addSidewalks(rec: TileRecord): void {
    if (rec.sidewalks || rec.builtRoads || !this.sidewalksByTile) return;
    rec.sidewalks = true;
    const lines = this.sidewalksByTile.get(rec.id);
    if (!lines || lines.length === 0) return;
    const data = sidewalkMesh(lines, this.roadById, this.opts.drawnGround ?? this.opts.ground);
    if (!data) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    rec.geometries.push(g);
    const mesh = new THREE.Mesh(g, this.opts.materials.sidewalk);
    mesh.name = "sidewalks";
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    rec.group.add(mesh);
  }

  /** The tile's bores (the collider's tunnels), or none. */
  private tunnelsOf(rec: TileRecord): TunnelLike[] {
    const c = (rec.collider ?? this.opts.colliders.get(rec.id)) as (TileCollider & { tunnels?: TunnelLike[] }) | undefined;
    return c?.tunnels ?? [];
  }

  /** A ground material with the tile's bores cut out (structures.ts), owned by the tile; null when it has none. */
  private groundCut(rec: TileRecord): THREE.Material | null {
    const cuts = boreCuts(this.tunnelsOf(rec));
    if (cuts.length === 0) return null;
    const data = new Float32Array(cuts.length * 8);
    cuts.forEach((c, i) => data.set([c.ax, c.az, c.bx, c.bz, c.halfW, c.ya, c.yb, 0], 8 * i));
    const m = groundCutMaterial(data, cuts.length);
    this.opts.onGroundMaterial?.(m);
    rec.ownedMaterials.push(m);
    return m;
  }

  /** Lakes at their level and the skirts under the ground's borders (ground-extras.ts), from the tile's heightfield. */
  private addGroundExtras(rec: TileRecord): void {
    const ground = (rec.collider ?? this.opts.colliders.get(rec.id))?.ground;
    if (!ground) return;
    const add = (name: string, data: SimpleMesh & { colors?: Float32Array }, mat: THREE.Material): void => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      if (data.colors) g.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
      g.setIndex(new THREE.BufferAttribute(data.indices, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      rec.geometries.push(g);
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = name;
      mesh.matrixAutoUpdate = false;
      rec.group.add(mesh);
    };
    const lakes = this.opts.lakeMaterial ? lakeSurface(ground) : null;
    if (lakes) add("lakes", lakes, this.opts.lakeMaterial!);
    const skirt = groundSkirt(ground);
    if (skirt) add("ground-skirt", skirt, this.opts.materials.groundSkirt);
    const tunnels = this.tunnelsOf(rec);
    const bores = tunnels.length > 0 ? boreMesh(tunnels, this.opts.drawnGround ?? this.opts.ground) : null;
    if (bores) add("tunnels", bores, this.opts.materials.tunnel);
    const shore = this.shoreByTile?.get(rec.id);
    const quays = shore ? quayFaces(shore, this.opts.drawnGround ?? this.opts.ground) : null;
    if (quays) add("quays", quays, this.opts.materials.tunnel);
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
    if (rec.state === "ready") this.opts.onTileVisible?.(id, false);
    rec.dropped = true;
    rec.gen = null;
    if (rec.retryTimer !== null) clearTimeout(rec.retryTimer);
    rec.retryTimer = null;
    rec.group.removeFromParent();
    for (const g of rec.geometries) g.dispose();
    for (const mat of rec.ownedMaterials) mat.dispose();
    for (const t of rec.textures) t.dispose();
    rec.props?.dispose();
    this.dropKit(rec);
    this.dirty = true;
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.unload(id);
    this.queue = [];
  }
}

/** A street whose whole length lies on the ground and carries traffic: props line it. */
export function onGroundStreet(e: RoadEdge): boolean {
  return !e.deck && !e.tunnel && !e.stairs && !e.pedestrian && !e.gradeSeparated;
}

/** A tile's lamps and street trees: along its streets on the ground, each spot clear of every carriageway, building and water. */
export function tilePropSpots(edges: readonly RoadEdge[], nodeClear: ReadonlyMap<string, number>, clearance: PropClearance): { lamps: Spot[]; trees: Spot[] } {
  const streets = edges.filter(onGroundStreet);
  const ok = (s: Spot): boolean => clearance.clear(s.x, s.z);
  return { lamps: streetlightSpots(streets, nodeClear).filter(ok), trees: streetTreeSpots(streets, nodeClear).filter(ok) };
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
