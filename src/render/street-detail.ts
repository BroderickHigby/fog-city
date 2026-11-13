// Street detail placed by the pipeline (pipeline/build-street-detail.ts): junction patches,
// crosswalks and stop bars; traffic signals and stop signs; street-name blades, one-way and
// kerbside parking signs; real street trees to the foliage layer and palms here; icon-only
// storefront signs. Render-only: nothing here touches
// the sim (the signal lamps only read the sim tick).
//
// The world's street-detail.json lists the layer files. They load once, after boot, and never
// block it (a world or a build without them simply has no street detail). Records are
// bucketed into CELL_M cells; cells within NEAR_M of the camera are built, nearest first,
// under a per-frame time budget, and cells beyond NEAR_M + HYSTERESIS_M are disposed.
//
// Every cell's instanced furniture, signs, storefront parts and palms go into one shared
// instance pool (instance-pool.ts): one draw per kind for the whole layer, whose shaders are
// built once, instead of ~20 new InstancedMeshes (each its own shader build) per cell. The pool
// culls per cell block to the view set with setView() (and to where its shadows can reach), so
// a pooled draw holds only what is in view, as the per-cell meshes' frustum culling did.

import * as THREE from "three";
import { disposeRenderObjects } from "./gpu-instance-ownership.ts";
import type { SharedMaterials } from "./materials.ts";
import { InstancePool, poolView, type InstanceBlock, type PoolView } from "./instance-pool.ts";
import { geometryFromMeshData } from "./props.ts";
import { FurnitureCell, type SignalRecord, type StopSignRecord } from "./street-furniture.ts";
import { addPalms, foliagePlacements, type TreePlacement, type TreeRecord } from "./street-trees.ts";
import { BladeAtlas, SignCell, type CornerRecord, type CurbRecord } from "./street-signs.ts";
import { StorefrontCell, type StorefrontRecord } from "./storefront-signs.ts";
import { STREET_DETAIL_INDEX, buildMarkingMeshes, decodeJunction, type MarkingJunction } from "./street-markings.ts";
import type { GroundFn } from "./types.ts";
import type { RoadGraph } from "./types.ts";
import type { TileCollider } from "../sim/world.ts";
import { GrassLayer } from "./grass.ts";
import type { TrafficSignalControls } from "../sim/traffic-signals.ts";
import { supplementalSignals } from "./signal-placement.ts";

const CELL_M = 200;
const NEAR_M = 450;
const HYSTERESIS_M = 120;
const TREES_NEAR_M = 1300;
/**
 * Main-thread time per frame for the whole layer: building cells (a part at a time), placing
 * trees, then the grass with what is left, but never less than GRASS_MIN_BUDGET_MS. Each starts
 * at most one piece of work after the budget is spent (one cell part, one tree cell, one grass
 * step), so a slow device still makes progress and no frame does more than the budget, the grass
 * floor and those pieces.
 */
export const STREET_DETAIL_BUDGET_MS = 4;
/**
 * The grass's own share of each frame. Its citywide obstacle index is about 1,200 small steps;
 * with only the cells' leftovers (none while streets stream in) it got one step a frame and the
 * lawns took twenty seconds or more to appear. 1.5 ms brings that to about 150 frames.
 */
export const GRASS_MIN_BUDGET_MS = 1.5;

export interface StreetDetailInfo {
  /** Layers loaded from street-detail.json. */
  layers: string[];
  junctions: number;
  cellsBuilt: number;
  /** Junction patches, crosswalks, stop bars, signal poles and stop signs in the built cells. */
  patches: number;
  crosswalks: number;
  stopBars: number;
  signals: number;
  stopSigns: number;
  signPosts: number;
  blades: number;
  curbSigns: number;
  trees: number;
  palms: number;
  storefronts: number;
}

interface Built {
  meshes: THREE.Object3D[];
  furniture: FurnitureCell | null;
  signs: SignCell | null;
  shops: StorefrontCell | null;
  crosswalks: number;
  stopBars: number;
  /** The id its junction asphalt and paint are registered under with opts.surfaces, if they were. */
  surface?: string;
}

interface Cell {
  key: string;
  cx: number;
  cz: number;
  junctions: MarkingJunction[];
  signals: SignalRecord[];
  stopSigns: StopSignRecord[];
  corners: CornerRecord[];
  curb: CurbRecord[];
  trees: TreeRecord[];
  shops: StorefrontRecord[];
  /** The cell's palm instances once its trees are placed (empty without palms); false before. */
  treesPlaced: InstanceBlock[] | false;
  built: Built | null;
}

export interface StreetDetailOptions {
  base: string;
  /** Reads a JSON file under the site root (the asset layer), rejecting when it is absent. */
  json: <T>(path: string) => Promise<T>;
  ground: GroundFn;
  materials: SharedMaterials;
  roads?: RoadGraph | null;
  signals?: TrafficSignalControls;
  colliders?: ReadonlyMap<string, TileCollider>;
  foliage?: {
    setPlacements(key: string, list: readonly TreePlacement[]): void;
    removePlacements(key: string): void;
  };
  /** Told about each cell's junction asphalt and paint, which people stand on (avatar-ground.ts). */
  surfaces?: {
    add(id: string, roots: readonly THREE.Object3D[]): void;
    remove(id: string): void;
  };
}

const isPlaced = (r: unknown): r is { id: string; x: number; z: number } =>
  !!r && typeof (r as { id?: unknown }).id === "string" && typeof (r as { x?: unknown }).x === "number" && typeof (r as { z?: unknown }).z === "number";

export class StreetDetailLayer {
  readonly group = new THREE.Group();
  readonly grass: GrassLayer;
  private readonly opts: StreetDetailOptions;
  private readonly cells = new Map<string, Cell>();
  /** Cells built now, and cells whose trees are placed: the only ones a frame has to visit. */
  private readonly builtCells = new Set<Cell>();
  private readonly treeCells = new Set<Cell>();
  private readonly pool = new InstancePool("street-detail instances");
  /** The street-name rows every sign cell of this layer shares; disposed with the layer. */
  private readonly atlas = new BladeAtlas();
  /** The cell being built now, a part per step; its parts show as they are made. */
  private job: { cell: Cell; steps: Generator<void> } | null = null;
  private readonly paint: THREE.MeshStandardMaterial;
  private layers: string[] = [];
  private junctions = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private queue: Cell[] = [];
  private treeQueue: Cell[] = [];
  private treeClasses: string[] = [];
  private view: PoolView | null = null;

  constructor(opts: StreetDetailOptions) {
    this.opts = opts;
    this.group.name = "street-detail";
    this.grass = new GrassLayer(opts);
    this.group.add(this.grass.group, this.pool.group);
    this.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, name: "fc:road-paint" });
    this.paint.polygonOffset = true;
    this.paint.polygonOffsetFactor = -2;
    this.paint.polygonOffsetUnits = -4;
  }

  private cellAt(x: number, z: number): Cell {
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M);
    const key = `${cx},${cz}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = { key, cx, cz, junctions: [], signals: [], stopSigns: [], corners: [], curb: [], trees: [], shops: [], treesPlaced: false, built: null }));
    return cell;
  }

  /** Load the layers; resolves when done (or when there are none). Never rejects. */
  async load(): Promise<void> {
    const { base, json } = this.opts;
    let index: { layers?: Record<string, string> };
    try {
      index = await json<{ layers?: Record<string, string> }>(base + STREET_DETAIL_INDEX);
    } catch {
      this.addMissingSignals();
      return;
    }
    const layer = async (name: string, read: (doc: Record<string, unknown>) => void): Promise<void> => {
      const file = index.layers?.[name];
      if (!file) return;
      try {
        read(await json<Record<string, unknown>>(base + file));
        this.layers.push(name);
      } catch (err) {
        console.warn(`[fog-city] street detail ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await layer("markings", (doc) => {
      for (const r of (doc.junctions as unknown[] | undefined) ?? []) {
        const j = decodeJunction(r);
        if (!j) continue;
        this.cellAt(j.x, j.z).junctions.push(j);
        this.junctions++;
      }
    });
    await layer("furniture", (doc) => {
      for (const r of (doc.signals as unknown[] | undefined) ?? []) if (isPlaced(r)) this.cellAt(r.x, r.z).signals.push(r as SignalRecord);
      for (const r of (doc.stopSigns as unknown[] | undefined) ?? []) if (isPlaced(r)) this.cellAt(r.x, r.z).stopSigns.push(r as StopSignRecord);
    });
    this.addMissingSignals();
    await layer("signs", (doc) => {
      for (const r of (doc.corners as unknown[] | undefined) ?? []) if (isPlaced(r) && Array.isArray((r as CornerRecord).blades)) this.cellAt(r.x, r.z).corners.push(r as CornerRecord);
      for (const r of (doc.curb as unknown[] | undefined) ?? []) if (isPlaced(r)) this.cellAt(r.x, r.z).curb.push(r as CurbRecord);
    });
    await layer("trees", (doc) => {
      this.treeClasses = Array.isArray(doc.classes) ? (doc.classes as string[]) : [];
      for (const t of (doc.trees as TreeRecord[] | undefined) ?? []) if (Array.isArray(t) && t.length >= 5) this.cellAt(t[1], t[2]).trees.push(t);
    });
    await layer("storefronts", (doc) => {
      for (const r of (doc.storefronts as unknown[] | undefined) ?? []) {
        if (isPlaced(r) && typeof (r as StorefrontRecord).heading === "number") this.cellAt(r.x, r.z).shops.push(r as StorefrontRecord);
      }
    });
    await layer("grass", doc => this.grass.setData(doc));
    this.lastX = Number.NaN;
  }

  private addMissingSignals(): void {
    const existing = [...this.cells.values()].flatMap(cell => cell.signals);
    const result = supplementalSignals(existing, { roads: this.opts.roads, controls: this.opts.signals,
      ground: this.opts.ground, colliders: this.opts.colliders });
    for (const signal of result.signals) this.cellAt(signal.x, signal.z).signals.push(signal);
    if (result.signals.length && !this.layers.includes("furniture")) this.layers.push("furniture");
    if (result.unplaced.length) console.warn(`[fog-city] ${result.unplaced.length} signal approaches have no safe supplemental pole: ` +
      result.unplaced.slice(0, 8).map(p => `${p.node}/${p.edge} (${p.reason})`).join(", "));
    this.lastX = Number.NaN;
  }

  /**
   * Cull the pooled draws to this camera from the next update() on (null: draw everything).
   * `sunDir` points toward the sun; give it when the instances cast shadows, so a block out of
   * view whose shadow falls in view is still drawn.
   */
  setView(camera: THREE.Camera | null, sunDir: THREE.Vector3 | null = null): void {
    this.view = camera ? poolView(camera, sunDir, this.view ?? undefined) : null;
  }

  /** Build the cells near (x, z) under a time budget; drop the far ones; light the signals for `tick`. */
  update(x: number, z: number, tick = 0, budgetMs = STREET_DETAIL_BUDGET_MS): void {
    const start = performance.now();
    if (!(Math.abs(x - this.lastX) < 25 && Math.abs(z - this.lastZ) < 25)) {
      this.lastX = x;
      this.lastZ = z;
      for (const cell of [...this.builtCells]) if (distToCell(cell, x, z) > NEAR_M + HYSTERESIS_M) this.drop(cell);
      this.queue = this.near(x, z, NEAR_M, (cell) => !cell.built);
      for (const cell of [...this.treeCells]) if (distToCell(cell, x, z) > TREES_NEAR_M + HYSTERESIS_M) this.dropTrees(cell);
      this.treeQueue = this.near(x, z, TREES_NEAR_M, (cell) => cell.trees.length > 0 && cell.treesPlaced === false);
    }
    // Nearest first; at least one step of each per frame, then only while the budget lasts.
    for (let k = 0; (this.job || this.queue.length) && (k === 0 || performance.now() - start < budgetMs); k++) {
      if (!this.job) {
        const cell = this.queue.shift()!;
        if (cell.built) continue;
        this.job = { cell, steps: this.build(cell) };
      }
      if (this.job.steps.next().done) this.job = null;
    }
    for (let k = 0; this.treeQueue.length && (k === 0 || performance.now() - start < budgetMs); k++) this.placeTrees(this.treeQueue.shift()!);
    this.grass.update(x, z, Math.max(Math.min(GRASS_MIN_BUDGET_MS, budgetMs), budgetMs - (performance.now() - start)));
    for (const cell of this.builtCells) cell.built?.furniture?.update(tick);
    this.pool.flush(this.view);
  }

  /** The loaded cells within `radius` of (x, z) that pass `keep`, nearest first. */
  private near(x: number, z: number, radius: number, keep: (cell: Cell) => boolean): Cell[] {
    const want: Array<{ cell: Cell; d: number }> = [];
    // A cell whose far edge is exactly `radius` away is in reach (distance <= radius), so the
    // low end is ceil(..) - 1: floor(..) would miss it when (x - radius) lands on a cell edge.
    const x0 = Math.ceil((x - radius) / CELL_M) - 1, x1 = Math.floor((x + radius) / CELL_M);
    const z0 = Math.ceil((z - radius) / CELL_M) - 1, z1 = Math.floor((z + radius) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const cell = this.cells.get(`${cx},${cz}`);
      if (!cell || !keep(cell)) continue;
      const d = distToCell(cell, x, z);
      if (d <= radius) want.push({ cell, d });
    }
    want.sort((a, b) => a.d - b.d || (a.cell.key < b.cell.key ? -1 : 1));
    return want.map((w) => w.cell);
  }

  /** True when every cell near the camera is built. */
  settled(): boolean {
    return !this.job && this.queue.length === 0 && this.treeQueue.length === 0 && this.grass.settled();
  }

  info(): StreetDetailInfo {
    const out: StreetDetailInfo = { layers: [...this.layers], junctions: this.junctions, cellsBuilt: 0, patches: 0, crosswalks: 0, stopBars: 0, signals: 0, stopSigns: 0, signPosts: 0, blades: 0, curbSigns: 0, trees: 0, palms: 0, storefronts: 0 };
    for (const c of this.treeCells) {
      if (c.treesPlaced === false) continue;
      out.trees += c.trees.length;
      out.palms += c.treesPlaced[0]?.count ?? 0;
    }
    for (const c of this.builtCells) {
      if (!c.built) continue;
      out.cellsBuilt++;
      out.patches += c.junctions.length;
      out.crosswalks += c.built.crosswalks;
      out.stopBars += c.built.stopBars;
      out.signals += c.built.furniture?.signals ?? 0;
      out.stopSigns += c.built.furniture?.stopSigns ?? 0;
      out.signPosts += c.built.signs?.posts ?? 0;
      out.blades += c.built.signs?.blades ?? 0;
      out.curbSigns += c.built.signs?.curbSigns ?? 0;
      out.storefronts += c.built.shops?.signs ?? 0;
    }
    return out;
  }

  /** The shared instance pool's draws and instances (instance-pool.ts). */
  poolInfo(): ReturnType<InstancePool["info"]> {
    return this.pool.info();
  }

  dispose(): void {
    for (const c of this.cells.values()) { this.drop(c); this.dropTrees(c); }
    this.pool.dispose();
    this.atlas.dispose();
    this.paint.dispose();
    this.grass.dispose();
  }

  /**
   * Build a cell a part per step (paint, furniture, signs, storefronts). The cell counts as built
   * from the first step, so dropping it mid-build retires the parts made so far.
   */
  private *build(cell: Cell): Generator<void> {
    if (cell.built) return;
    const built: Built = { meshes: [], furniture: null, signs: null, shops: null, crosswalks: 0, stopBars: 0 };
    cell.built = built;
    this.builtCells.add(cell);
    const show = (o: THREE.Object3D): void => { built.meshes.push(o); this.group.add(o); };
    if (cell.junctions.length) {
      const floor: THREE.Mesh[] = [];
      const m = buildMarkingMeshes(cell.junctions, this.opts.ground);
      const patch = new THREE.Mesh(geometryFromMeshData(m.patch), this.opts.materials.road);
      patch.name = `junctions ${cell.key}`;
      const paint = new THREE.Mesh(geometryFromMeshData(m.paint), this.paint);
      paint.name = `road paint ${cell.key}`;
      floor.push(patch, paint);
      for (const mesh of floor) {
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        show(mesh);
      }
      built.crosswalks = m.crosswalks;
      built.stopBars = m.stopBars;
      if (this.opts.surfaces) {
        built.surface = surfaceId(cell);
        this.opts.surfaces.add(built.surface, floor);
      }
      yield;
    }
    if (cell.signals.length || cell.stopSigns.length) {
      built.furniture = new FurnitureCell(cell.signals, cell.stopSigns, this.opts.ground, this.opts.signals, this.pool);
      built.furniture.group.name = `street furniture ${cell.key}`;
      show(built.furniture.group);
      yield;
    }
    if (cell.corners.length || cell.curb.length) {
      built.signs = new SignCell(cell.corners, cell.curb, this.opts.ground, this.pool, this.atlas);
      built.signs.group.name = `street signs ${cell.key}`;
      show(built.signs.group);
      yield;
    }
    if (cell.shops.length) {
      built.shops = new StorefrontCell(cell.shops, this.opts.ground, this.pool);
      built.shops.group.name = `storefront signs ${cell.key}`;
      show(built.shops.group);
    }
  }

  private placeTrees(cell: Cell): void {
    if (cell.treesPlaced !== false) return;
    this.opts.foliage?.setPlacements(cell.key, foliagePlacements(cell.trees, this.treeClasses, this.opts.ground));
    cell.treesPlaced = addPalms(cell.trees, this.treeClasses, this.opts.ground, this.pool);
    this.treeCells.add(cell);
  }

  private dropTrees(cell: Cell): void {
    if (cell.treesPlaced === false) return;
    this.opts.foliage?.removePlacements(cell.key);
    for (const block of cell.treesPlaced) this.pool.release(block);
    cell.treesPlaced = false;
    this.treeCells.delete(cell);
  }

  private drop(cell: Cell): void {
    if (!cell.built) return;
    // A cell dropped mid-build stops building: its later parts are never made.
    if (this.job?.cell === cell) this.job = null;
    if (cell.built.surface) this.opts.surfaces?.remove(cell.built.surface);
    // Owner groups currently also appear in meshes. Make their retirement explicit
    // without dispatching duplicate disposal events on the same subtree.
    const roots = new Set(cell.built.meshes);
    for (const owner of [cell.built.furniture, cell.built.signs, cell.built.shops]) if (owner) roots.add(owner.group);
    for (const o of roots) {
      this.group.remove(o);
      disposeRenderObjects(o);
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    }
    cell.built.furniture?.dispose();
    cell.built.signs?.dispose();
    cell.built.shops?.dispose();
    cell.built = null;
    this.builtCells?.delete(cell);
  }
}

const surfaceId = (cell: Cell): string => `street-detail:${cell.key}`;

function distToCell(c: { cx: number; cz: number }, x: number, z: number): number {
  const x0 = c.cx * CELL_M, z0 = c.cz * CELL_M;
  const dx = Math.max(x0 - x, 0, x - (x0 + CELL_M));
  const dz = Math.max(z0 - z, 0, z - (z0 + CELL_M));
  return Math.hypot(dx, dz);
}
