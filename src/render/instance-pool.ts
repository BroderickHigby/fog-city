// Shared instanced draws for many small owners (street-detail cells). Render-only.
//
// The pinned three r186 node renderer puts an InstancedMesh's uuid in its render-object cache
// key, so every new InstancedMesh builds its own shaders (one node build per pass). Cells that
// each made ~20 InstancedMeshes cost ~1000 node builds a kilometre of driving, all on the main
// thread. A pool keeps ONE long-lived InstancedMesh per (geometry, material, name, flags) and
// gives each owner a block of instances in it: a cell that streams in only writes instance
// data, and the shaders are built once per kind for the whole session.
//
// Blocks are packed in order. Releasing one shifts the later blocks down (a typed-array copy
// of at most a few hundred kilobytes), so a block's offset can change; owners read it through
// the block. Only the changed instance range is uploaded, once per flush().

import * as THREE from "three";
import { disposeRenderObjects } from "./gpu-instance-ownership.ts";

export interface InstanceOptions {
  name: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Give the block per-instance colours (setColorAt), initially black. */
  colors?: boolean;
}

/** One owner's instances: `count` consecutive instances of `mesh` from `offset`. */
export interface InstanceBlock {
  readonly mesh: THREE.InstancedMesh;
  readonly offset: number;
  readonly count: number;
  setColorAt(index: number, color: THREE.Color): void;
  /** Upload the colours set since the last commit. */
  commitColors(): void;
}

/** Where a cell puts its instances: its own InstancedMeshes, or a shared pool. */
export interface InstanceSink {
  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: readonly THREE.Matrix4[], opts: InstanceOptions): InstanceBlock | null;
  release(block: InstanceBlock): void;
}

function makeMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, opts: InstanceOptions): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = opts.name;
  mesh.castShadow = opts.castShadow ?? false;
  mesh.receiveShadow = opts.receiveShadow ?? false;
  mesh.matrixAutoUpdate = false;
  if (opts.colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  return mesh;
}

/** Each add() is its own InstancedMesh in `group` (standalone cells and tests). */
export class LocalInstances implements InstanceSink {
  private readonly group: THREE.Object3D;
  constructor(group: THREE.Object3D) { this.group = group; }

  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: readonly THREE.Matrix4[], opts: InstanceOptions): InstanceBlock | null {
    if (!matrices.length) return null;
    const mesh = makeMesh(geometry, material, matrices.length, opts);
    matrices.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return {
      mesh, offset: 0, count: matrices.length,
      setColorAt: (index, color) => mesh.setColorAt(index, color),
      commitColors: () => { if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; },
    };
  }

  release(block: InstanceBlock): void {
    block.mesh.removeFromParent();
    block.mesh.dispose();
  }
}

interface Batch {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  opts: InstanceOptions;
  mesh: THREE.InstancedMesh;
  capacity: number;
  used: number;
  blocks: PooledBlock[];
  /** Instance ranges [from, to) to upload at the next flush; to <= from when clean. */
  matrixFrom: number; matrixTo: number;
  colorFrom: number; colorTo: number;
}

class PooledBlock implements InstanceBlock {
  readonly batch: Batch;
  readonly count: number;
  offset: number;
  constructor(batch: Batch, offset: number, count: number) { this.batch = batch; this.offset = offset; this.count = count; }
  get mesh(): THREE.InstancedMesh { return this.batch.mesh; }
  setColorAt(index: number, color: THREE.Color): void {
    const colors = this.batch.mesh.instanceColor;
    if (!colors || index < 0 || index >= this.count) return;
    color.toArray(colors.array, (this.offset + index) * 3);
  }
  commitColors(): void { dirty(this.batch, "color", this.offset, this.offset + this.count); }
}

function dirty(b: Batch, what: "matrix" | "color", from: number, to: number): void {
  if (what === "matrix") {
    b.matrixFrom = b.matrixTo > b.matrixFrom ? Math.min(b.matrixFrom, from) : from;
    b.matrixTo = Math.max(b.matrixTo, to);
  } else {
    b.colorFrom = b.colorTo > b.colorFrom ? Math.min(b.colorFrom, from) : from;
    b.colorTo = Math.max(b.colorTo, to);
  }
}

/** First capacity of a batch: room for this block and a neighbourhood like it. */
export const POOL_MIN_CAPACITY = 1024;

export class InstancePool implements InstanceSink {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  /** How many times a batch had to be rebuilt bigger (each is a new node build). */
  grown = 0;

  constructor(name = "instance-pool") {
    this.group.name = name;
  }

  private id(o: object): number {
    let id = this.ids.get(o);
    if (id === undefined) this.ids.set(o, (id = this.nextId++));
    return id;
  }

  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: readonly THREE.Matrix4[], opts: InstanceOptions): InstanceBlock | null {
    const n = matrices.length;
    if (!n) return null;
    const key = `${this.id(geometry)}:${this.id(material)}:${opts.name}:${opts.castShadow ? 1 : 0}${opts.receiveShadow ? 1 : 0}${opts.colors ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) {
      const capacity = Math.max(POOL_MIN_CAPACITY, THREE.MathUtils.ceilPowerOfTwo(n));
      b = { key, geometry, material, opts, mesh: makeMesh(geometry, material, capacity, opts), capacity, used: 0, blocks: [], matrixFrom: 0, matrixTo: 0, colorFrom: 0, colorTo: 0 };
      b.mesh.count = 0;
      b.mesh.visible = false;
      // One draw spans the whole neighbourhood: per-batch bounds would almost never cull it.
      b.mesh.frustumCulled = false;
      this.batches.set(key, b);
      this.group.add(b.mesh);
    } else if (b.used + n > b.capacity) this.grow(b, b.used + n);
    const block = new PooledBlock(b, b.used, n);
    const array = b.mesh.instanceMatrix.array as Float32Array;
    for (let k = 0; k < n; k++) matrices[k]!.toArray(array, (b.used + k) * 16);
    b.blocks.push(block);
    dirty(b, "matrix", b.used, b.used + n);
    if (b.mesh.instanceColor) {
      (b.mesh.instanceColor.array as Float32Array).fill(0, b.used * 3, (b.used + n) * 3);
      dirty(b, "color", b.used, b.used + n);
    }
    b.used += n;
    b.mesh.count = b.used;
    b.mesh.visible = true;
    return block;
  }

  release(block: InstanceBlock): void {
    if (!(block instanceof PooledBlock)) return;
    const b = block.batch, at = b.blocks.indexOf(block);
    if (at < 0) return;
    b.blocks.splice(at, 1);
    const from = block.offset, n = block.count, end = b.used;
    const matrices = b.mesh.instanceMatrix.array as Float32Array;
    matrices.copyWithin(from * 16, (from + n) * 16, end * 16);
    const colors = b.mesh.instanceColor?.array as Float32Array | undefined;
    colors?.copyWithin(from * 3, (from + n) * 3, end * 3);
    for (let k = at; k < b.blocks.length; k++) b.blocks[k]!.offset -= n;
    b.used -= n;
    b.mesh.count = b.used;
    b.mesh.visible = b.used > 0;
    if (b.used > from) {
      dirty(b, "matrix", from, b.used);
      if (colors) dirty(b, "color", from, b.used);
    }
  }

  /** A bigger mesh for a batch that is full; the shaders are built again once for it. */
  private grow(b: Batch, need: number): void {
    const capacity = Math.max(b.capacity * 2, THREE.MathUtils.ceilPowerOfTwo(need));
    const old = b.mesh, mesh = makeMesh(b.geometry, b.material, capacity, b.opts);
    (mesh.instanceMatrix.array as Float32Array).set((old.instanceMatrix.array as Float32Array).subarray(0, b.used * 16));
    if (old.instanceColor && mesh.instanceColor) (mesh.instanceColor.array as Float32Array).set((old.instanceColor.array as Float32Array).subarray(0, b.used * 3));
    mesh.count = b.used;
    mesh.frustumCulled = false;
    b.mesh = mesh;
    b.capacity = capacity;
    // The new buffers upload whole on first use.
    b.matrixFrom = b.matrixTo = b.colorFrom = b.colorTo = 0;
    this.group.remove(old);
    disposeRenderObjects(old);
    this.group.add(mesh);
    this.grown++;
  }

  /**
   * Upload the instance ranges changed since the last flush. Call once per frame. Ranges add up
   * until the renderer uploads them (and clears them): a frame flushed but not rendered (a lost
   * context) must not lose its range.
   */
  flush(): void {
    for (const b of this.batches.values()) {
      if (b.matrixTo > b.matrixFrom) {
        const a = b.mesh.instanceMatrix;
        a.addUpdateRange(b.matrixFrom * 16, (b.matrixTo - b.matrixFrom) * 16);
        a.needsUpdate = true;
        b.matrixFrom = b.matrixTo = 0;
        // Not for culling (frustumCulled is off): the renderer sorts by it, and computes it again when null.
        b.mesh.boundingSphere = null;
      }
      const c = b.mesh.instanceColor;
      if (c && b.colorTo > b.colorFrom) {
        c.addUpdateRange(b.colorFrom * 3, (b.colorTo - b.colorFrom) * 3);
        c.needsUpdate = true;
        b.colorFrom = b.colorTo = 0;
      }
    }
  }

  info(): { meshes: number; instances: number; capacity: number; grown: number } {
    let instances = 0, capacity = 0;
    for (const b of this.batches.values()) { instances += b.used; capacity += b.capacity; }
    return { meshes: this.batches.size, instances, capacity, grown: this.grown };
  }

  dispose(): void {
    for (const b of this.batches.values()) { b.mesh.removeFromParent(); disposeRenderObjects(b.mesh); }
    this.batches.clear();
    this.group.removeFromParent();
  }
}
