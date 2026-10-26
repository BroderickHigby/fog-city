// Street detail placed by the pipeline (pipeline/build-street-detail.ts): junction patches,
// crosswalks and stop bars; traffic signals and stop signs; street-name blades, one-way and
// kerbside parking signs; real street trees to the foliage layer and palms here; icon-only
// storefront signs. Render-only: nothing here touches
// the sim (the signal lamps only read the sim tick).
//
// The world's street-detail.json lists the layer files. They load once, after boot, and never
// block it (a world or a build without them simply has no street detail). Records are
// bucketed into CELL_M cells; cells within NEAR_M of the camera are built (a few per frame)
// and cells beyond NEAR_M + HYSTERESIS_M are disposed.

import * as THREE from "three";
import { disposeRenderObjects } from "./gpu-instance-ownership.ts";
import type { SharedMaterials } from "./materials.ts";
import { geometryFromMeshData } from "./props.ts";
import { FurnitureCell, type SignalRecord, type StopSignRecord } from "./street-furniture.ts";
import { buildPalms, foliagePlacements, type TreePlacement, type TreeRecord } from "./street-trees.ts";
import { SignCell, type CornerRecord, type CurbRecord } from "./street-signs.ts";
import { StorefrontCell, type StorefrontRecord } from "./storefront-signs.ts";
import { STREET_DETAIL_INDEX, buildMarkingMeshes, decodeJunction, type MarkingJunction } from "./street-markings.ts";
import type { GroundFn } from "./types.ts";
import type { RoadGraph } from "./types.ts";
import type { TileCollider } from "../sim/world.ts";
import { GrassLayer } from "./grass.ts";

const CELL_M = 200;
const NEAR_M = 450;
const HYSTERESIS_M = 120;
const BUILDS_PER_UPDATE = 2;
const TREES_NEAR_M = 1300;
const TREES_PER_UPDATE = 6;

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
  treesPlaced: THREE.Group | null | false;
  built: Built | null;
}

export interface StreetDetailOptions {
  base: string;
  /** Reads a JSON file under the site root (the asset layer), rejecting when it is absent. */
  json: <T>(path: string) => Promise<T>;
  ground: GroundFn;
  materials: SharedMaterials;
  roads?: RoadGraph | null;
  colliders?: ReadonlyMap<string, TileCollider>;
  foliage?: {
    setPlacements(key: string, list: readonly TreePlacement[]): void;
    removePlacements(key: string): void;
  };
}

const isPlaced = (r: unknown): r is { id: string; x: number; z: number } =>
  !!r && typeof (r as { id?: unknown }).id === "string" && typeof (r as { x?: unknown }).x === "number" && typeof (r as { z?: unknown }).z === "number";

export class StreetDetailLayer {
  readonly group = new THREE.Group();
  readonly grass: GrassLayer;
  private readonly opts: StreetDetailOptions;
  private readonly cells = new Map<string, Cell>();
  private readonly paint: THREE.MeshStandardMaterial;
  private layers: string[] = [];
  private junctions = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private queue: Cell[] = [];
  private treeQueue: Cell[] = [];
  private treeClasses: string[] = [];

  constructor(opts: StreetDetailOptions) {
    this.opts = opts;
    this.group.name = "street-detail";
    this.grass = new GrassLayer(opts);
    this.group.add(this.grass.group);
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

  /** Build the cells near (x, z) a few at a time; drop the far ones; light the signals for `tick`. */
  update(x: number, z: number, tick = 0): void {
    this.grass.update(x, z);
    if (!(Math.abs(x - this.lastX) < 25 && Math.abs(z - this.lastZ) < 25)) {
      this.lastX = x;
      this.lastZ = z;
      const want: Array<{ cell: Cell; d: number }> = [];
      for (const cell of this.cells.values()) {
        const d = distToCell(cell, x, z);
        if (cell.built && d > NEAR_M + HYSTERESIS_M) this.drop(cell);
        else if (!cell.built && d <= NEAR_M) want.push({ cell, d });
      }
      want.sort((a, b) => a.d - b.d || (a.cell.key < b.cell.key ? -1 : 1));
      this.queue = want.map((w) => w.cell);
      const trees: Array<{ cell: Cell; d: number }> = [];
      for (const cell of this.cells.values()) {
        if (!cell.trees.length) continue;
        const d = distToCell(cell, x, z);
        if (cell.treesPlaced !== false && d > TREES_NEAR_M + HYSTERESIS_M) this.dropTrees(cell);
        else if (cell.treesPlaced === false && d <= TREES_NEAR_M) trees.push({ cell, d });
      }
      trees.sort((a, b) => a.d - b.d || (a.cell.key < b.cell.key ? -1 : 1));
      this.treeQueue = trees.map((w) => w.cell);
    }
    for (let k = 0; k < BUILDS_PER_UPDATE && this.queue.length; k++) this.build(this.queue.shift()!);
    for (let k = 0; k < TREES_PER_UPDATE && this.treeQueue.length; k++) this.placeTrees(this.treeQueue.shift()!);
    for (const cell of this.cells.values()) cell.built?.furniture?.update(tick);
  }

  /** True when every cell near the camera is built. */
  settled(): boolean {
    return this.queue.length === 0 && this.treeQueue.length === 0 && this.grass.settled();
  }

  info(): StreetDetailInfo {
    const out: StreetDetailInfo = { layers: [...this.layers], junctions: this.junctions, cellsBuilt: 0, patches: 0, crosswalks: 0, stopBars: 0, signals: 0, stopSigns: 0, signPosts: 0, blades: 0, curbSigns: 0, trees: 0, palms: 0, storefronts: 0 };
    for (const c of this.cells.values()) {
      if (c.treesPlaced === false) continue;
      out.trees += c.trees.length;
      if (c.treesPlaced) out.palms += (c.treesPlaced.children[0] as THREE.InstancedMesh).count;
    }
    for (const c of this.cells.values()) {
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

  dispose(): void {
    for (const c of this.cells.values()) { this.drop(c); this.dropTrees(c); }
    this.paint.dispose();
    this.grass.dispose();
  }

  private build(cell: Cell): void {
    if (cell.built) return;
    const built: Built = { meshes: [], furniture: null, signs: null, shops: null, crosswalks: 0, stopBars: 0 };
    if (cell.junctions.length) {
      const m = buildMarkingMeshes(cell.junctions, this.opts.ground);
      const patch = new THREE.Mesh(geometryFromMeshData(m.patch), this.opts.materials.road);
      patch.name = `junctions ${cell.key}`;
      const paint = new THREE.Mesh(geometryFromMeshData(m.paint), this.paint);
      paint.name = `road paint ${cell.key}`;
      for (const mesh of [patch, paint]) {
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        built.meshes.push(mesh);
      }
      built.crosswalks = m.crosswalks;
      built.stopBars = m.stopBars;
    }
    if (cell.signals.length || cell.stopSigns.length) {
      built.furniture = new FurnitureCell(cell.signals, cell.stopSigns, this.opts.ground);
      built.furniture.group.name = `street furniture ${cell.key}`;
      built.meshes.push(built.furniture.group);
    }
    if (cell.corners.length || cell.curb.length) {
      built.signs = new SignCell(cell.corners, cell.curb, this.opts.ground);
      built.signs.group.name = `street signs ${cell.key}`;
      built.meshes.push(built.signs.group);
    }
    if (cell.shops.length) {
      built.shops = new StorefrontCell(cell.shops, this.opts.ground);
      built.shops.group.name = `storefront signs ${cell.key}`;
      built.meshes.push(built.shops.group);
    }
    for (const o of built.meshes) this.group.add(o);
    cell.built = built;
  }

  private placeTrees(cell: Cell): void {
    if (cell.treesPlaced !== false) return;
    this.opts.foliage?.setPlacements(cell.key, foliagePlacements(cell.trees, this.treeClasses, this.opts.ground));
    const palms = buildPalms(cell.trees, this.treeClasses, this.opts.ground);
    if (palms) this.group.add(palms);
    cell.treesPlaced = palms;
  }

  private dropTrees(cell: Cell): void {
    if (cell.treesPlaced === false) return;
    this.opts.foliage?.removePlacements(cell.key);
    if (cell.treesPlaced) {
      this.group.remove(cell.treesPlaced);
      for (const o of cell.treesPlaced.children) (o as THREE.InstancedMesh).dispose();
    }
    cell.treesPlaced = false;
  }

  private drop(cell: Cell): void {
    if (!cell.built) return;
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
  }
}

function distToCell(c: { cx: number; cz: number }, x: number, z: number): number {
  const x0 = c.cx * CELL_M, z0 = c.cz * CELL_M;
  const dx = Math.max(x0 - x, 0, x - (x0 + CELL_M));
  const dz = Math.max(z0 - z, 0, z - (z0 + CELL_M));
  return Math.hypot(dx, dz);
}
