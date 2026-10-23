// Street detail placed by the pipeline (pipeline/build-street-detail.ts): junction patches,
// crosswalks and stop bars for now. Render-only: nothing here touches the sim.
//
// The world's street-detail.json lists the layer files. They load once, after boot, and never
// block it (a world or a build without them simply has no street detail). Junctions are
// bucketed into CELL_M cells; cells within NEAR_M of the camera are built (a few per frame)
// and cells beyond NEAR_M + HYSTERESIS_M are disposed.

import * as THREE from "three";
import type { SharedMaterials } from "./materials.ts";
import { geometryFromMeshData } from "./props.ts";
import { STREET_DETAIL_INDEX, buildMarkingMeshes, decodeJunction, type MarkingJunction } from "./street-markings.ts";
import type { GroundFn } from "./types.ts";

const CELL_M = 200;
const NEAR_M = 450;
const HYSTERESIS_M = 120;
const BUILDS_PER_UPDATE = 2;

export interface StreetDetailInfo {
  /** Layers loaded from street-detail.json. */
  layers: string[];
  junctions: number;
  cellsBuilt: number;
  /** Junction patches, crosswalks and stop bars in the built cells. */
  patches: number;
  crosswalks: number;
  stopBars: number;
}

interface Cell {
  key: string;
  cx: number;
  cz: number;
  junctions: MarkingJunction[];
  meshes: THREE.Mesh[] | null;
  crosswalks: number;
  stopBars: number;
}

export interface StreetDetailOptions {
  base: string;
  /** Reads a JSON file under the site root (the asset layer), rejecting when it is absent. */
  json: <T>(path: string) => Promise<T>;
  ground: GroundFn;
  materials: SharedMaterials;
}

export class StreetDetailLayer {
  readonly group = new THREE.Group();
  private readonly opts: StreetDetailOptions;
  private readonly cells = new Map<string, Cell>();
  private readonly paint: THREE.MeshStandardMaterial;
  private layers: string[] = [];
  private junctions = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private queue: Cell[] = [];

  constructor(opts: StreetDetailOptions) {
    this.opts = opts;
    this.group.name = "street-detail";
    this.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, name: "fc:road-paint" });
    this.paint.polygonOffset = true;
    this.paint.polygonOffsetFactor = -2;
    this.paint.polygonOffsetUnits = -4;
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
    const file = index.layers?.markings;
    if (!file) return;
    try {
      const doc = await json<{ junctions?: unknown[] }>(base + file);
      for (const r of doc.junctions ?? []) {
        const j = decodeJunction(r);
        if (!j) continue;
        const cx = Math.floor(j.x / CELL_M), cz = Math.floor(j.z / CELL_M);
        const key = `${cx},${cz}`;
        let cell = this.cells.get(key);
        if (!cell) this.cells.set(key, (cell = { key, cx, cz, junctions: [], meshes: null, crosswalks: 0, stopBars: 0 }));
        cell.junctions.push(j);
        this.junctions++;
      }
      this.layers.push("markings");
      this.lastX = Number.NaN;
    } catch (err) {
      console.warn(`[fog-city] street detail ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Build the cells near (x, z) a few at a time; drop the far ones. */
  update(x: number, z: number): void {
    if (!(Math.abs(x - this.lastX) < 25 && Math.abs(z - this.lastZ) < 25)) {
      this.lastX = x;
      this.lastZ = z;
      const want: Array<{ cell: Cell; d: number }> = [];
      for (const cell of this.cells.values()) {
        const d = distToCell(cell, x, z);
        if (cell.meshes && d > NEAR_M + HYSTERESIS_M) this.drop(cell);
        else if (!cell.meshes && d <= NEAR_M) want.push({ cell, d });
      }
      want.sort((a, b) => a.d - b.d || (a.cell.key < b.cell.key ? -1 : 1));
      this.queue = want.map((w) => w.cell);
    }
    for (let k = 0; k < BUILDS_PER_UPDATE && this.queue.length; k++) this.build(this.queue.shift()!);
  }

  /** True when every cell near the camera is built. */
  settled(): boolean {
    return this.queue.length === 0;
  }

  info(): StreetDetailInfo {
    let cellsBuilt = 0, patches = 0, crosswalks = 0, stopBars = 0;
    for (const c of this.cells.values()) {
      if (!c.meshes) continue;
      cellsBuilt++;
      patches += c.junctions.length;
      crosswalks += c.crosswalks;
      stopBars += c.stopBars;
    }
    return { layers: [...this.layers], junctions: this.junctions, cellsBuilt, patches, crosswalks, stopBars };
  }

  dispose(): void {
    for (const c of this.cells.values()) this.drop(c);
    this.paint.dispose();
  }

  private build(cell: Cell): void {
    if (cell.meshes) return;
    const m = buildMarkingMeshes(cell.junctions, this.opts.ground);
    const patch = new THREE.Mesh(geometryFromMeshData(m.patch), this.opts.materials.road);
    patch.name = `junctions ${cell.key}`;
    const paint = new THREE.Mesh(geometryFromMeshData(m.paint), this.paint);
    paint.name = `road paint ${cell.key}`;
    for (const mesh of [patch, paint]) {
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    cell.meshes = [patch, paint];
    cell.crosswalks = m.crosswalks;
    cell.stopBars = m.stopBars;
  }

  private drop(cell: Cell): void {
    if (!cell.meshes) return;
    for (const mesh of cell.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    cell.meshes = null;
  }
}

function distToCell(c: { cx: number; cz: number }, x: number, z: number): number {
  const x0 = c.cx * CELL_M, z0 = c.cz * CELL_M;
  const dx = Math.max(x0 - x, 0, x - (x0 + CELL_M));
  const dz = Math.max(z0 - z, 0, z - (z0 + CELL_M));
  return Math.hypot(dx, dz);
}
