// Shared instanced draws for many small owners (street-detail cells). Render-only.
//
// The pinned three r186 node renderer puts an InstancedMesh's uuid in its render-object cache
// key, so every new InstancedMesh builds its own shaders (one node build per pass). Cells that
// each made ~20 InstancedMeshes cost ~1000 node builds a kilometre of driving, all on the main
// thread. A pool keeps ONE long-lived InstancedMesh per (geometry, material, name, flags) and
// gives each owner a block of instances in it: a cell that streams in only writes instance
// data, and the shaders are built once per kind for the whole session.
//
// Blocks are packed in order in a CPU copy. Releasing one shifts the later blocks down (a
// typed-array copy of at most a few hundred kilobytes), so a block's offset can change; owners
// read it through the block.
//
// Culling: a pooled mesh spans the whole neighbourhood, so three's per-object frustum test would
// never cull it. flush(view) culls per block instead (a block is one cell's instances of one
// kind, with its own bounding sphere): only the blocks in view, or whose shadow can reach the
// view, are copied, in order, to the front of the mesh's instance arrays, and mesh.count draws
// just those. The copy is rewritten from the first block that changed, so a frame whose drawn
// set did not change uploads nothing. The mesh's bounding sphere is the union of its drawn
// blocks, so three's own test (main and shadow cameras) works on it too.
//
// Capacity is at least POOL_MIN_CAPACITY: three's node renderer reads an instance array of at
// most maxUniformBufferBindingSize bytes (64 KiB by default: 1024 matrices) as a uniform buffer
// and uploads ALL of it for every draw of every pass, every frame. A bigger array is a vertex
// buffer, uploaded only when it changed and only the changed range.

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
  /** Every block's instances, packed in block order (CPU only); the mesh draws a copy of the visible ones. */
  matrices: Float32Array;
  colors: Float32Array | null;
  /** The blocks the mesh's arrays hold now, in order, and how many instances that is. */
  drawn: PooledBlock[];
  drawnCount: number;
  /** Instance ranges [from, to) of the mesh's arrays to upload at the next flush; to <= from when clean. */
  matrixFrom: number; matrixTo: number;
  colorFrom: number; colorTo: number;
}

class PooledBlock implements InstanceBlock {
  batch: Batch | null;
  readonly count: number;
  /** Where its instances start in the batch's packed CPU copy; -1 once released. */
  offset: number;
  /** Where they start in the mesh's arrays; -1 when not drawn. */
  drawOffset = -1;
  /** Colours set since the last flush. */
  colorDirty = false;
  /** Bounds of its instances (each instance's transformed geometry bounding sphere). */
  readonly sphere = new THREE.Sphere();
  /** Height of the bounds, for how far their shadow can reach. */
  height = 0;
  private readonly mesh0: THREE.InstancedMesh;
  constructor(batch: Batch, offset: number, count: number) { this.batch = batch; this.offset = offset; this.count = count; this.mesh0 = batch.mesh; }
  get mesh(): THREE.InstancedMesh { return this.batch?.mesh ?? this.mesh0; }
  setColorAt(index: number, color: THREE.Color): void {
    const colors = this.batch?.colors;
    if (!colors || index < 0 || index >= this.count) return;
    color.toArray(colors, (this.offset + index) * 3);
  }
  commitColors(): void { if (this.batch?.colors) this.colorDirty = true; }
}

function dirty(b: Batch, what: "matrix" | "color", from: number, to: number): void {
  if (to <= from) return;
  if (what === "matrix") {
    b.matrixFrom = b.matrixTo > b.matrixFrom ? Math.min(b.matrixFrom, from) : from;
    b.matrixTo = Math.max(b.matrixTo, to);
  } else {
    b.colorFrom = b.colorTo > b.colorFrom ? Math.min(b.colorFrom, from) : from;
    b.colorTo = Math.max(b.colorTo, to);
  }
}

/** Add [from, to) to the attribute's pending update range, keeping a single range. */
function widen(a: THREE.BufferAttribute, from: number, to: number): void {
  const r = a.updateRanges[0];
  if (!r) { a.addUpdateRange(from, to - from); return; }
  const end = Math.max(to, ...a.updateRanges.map(u => u.start + u.count));
  r.start = Math.min(from, ...a.updateRanges.map(u => u.start));
  r.count = end - r.start;
  a.updateRanges.length = 1;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _min = new THREE.Vector3(), _max = new THREE.Vector3(), _s = new THREE.Sphere();

/** The block's bounds: every instance's transformed geometry bounding sphere, boxed. */
function blockBounds(block: PooledBlock, geometry: THREE.BufferGeometry, matrices: Float32Array): void {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const g = geometry.boundingSphere!;
  _min.set(Infinity, Infinity, Infinity); _max.set(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < block.count; k++) {
    _m.fromArray(matrices, (block.offset + k) * 16);
    _p.copy(g.center).applyMatrix4(_m);
    const r = g.radius * _m.getMaxScaleOnAxis();
    _min.set(Math.min(_min.x, _p.x - r), Math.min(_min.y, _p.y - r), Math.min(_min.z, _p.z - r));
    _max.set(Math.max(_max.x, _p.x + r), Math.max(_max.y, _p.y + r), Math.max(_max.z, _p.z + r));
  }
  block.sphere.center.addVectors(_min, _max).multiplyScalar(0.5);
  block.sphere.radius = _min.distanceTo(_max) / 2;
  block.height = _max.y - _min.y;
}

/**
 * What the next frame draws: the camera's frustum, and the direction toward the sun (or null
 * without shadows). A block is drawn when it, or the ground its shadow can reach, is in view.
 */
export interface PoolView {
  frustum: THREE.Frustum;
  sunDir: THREE.Vector3 | null;
}

/** The farthest a block's shadow is followed along the ground, metres. */
export const POOL_SHADOW_REACH_M = 150;

/** A view for `camera` now (its matrices updated first). `out` is reused when given. */
export function poolView(camera: THREE.Camera, sunDir: THREE.Vector3 | null, out?: PoolView): PoolView {
  camera.updateMatrixWorld();
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const view = out ?? { frustum: new THREE.Frustum(), sunDir: null };
  view.frustum.setFromProjectionMatrix(_m, camera.coordinateSystem, (camera as { reversedDepth?: boolean }).reversedDepth);
  view.sunDir = sunDir;
  return view;
}

function inView(block: PooledBlock, view: PoolView, shadows: boolean): boolean {
  if (view.frustum.intersectsSphere(block.sphere)) return true;
  const sun = view.sunDir;
  if (!shadows || !sun || sun.y <= 0.02) return false;
  // Its shadow falls away from the sun, at most height / sun.y along it: test the sphere
  // around that whole stretch.
  const reach = Math.min(POOL_SHADOW_REACH_M, block.height / sun.y);
  _s.center.copy(block.sphere.center).addScaledVector(sun, -reach / 2);
  _s.radius = block.sphere.radius + reach / 2;
  return view.frustum.intersectsSphere(_s);
}

/**
 * First capacity of a batch. Above 1024 matrices (64 KiB, the default uniform-buffer limit) so
 * the node renderer keeps the instances in a vertex buffer, uploaded only when they change.
 */
export const POOL_MIN_CAPACITY = 2048;

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
      const mesh = makeMesh(geometry, material, capacity, opts);
      b = { key, geometry, material, opts, mesh, capacity, used: 0, blocks: [],
        matrices: new Float32Array(capacity * 16), colors: opts.colors ? new Float32Array(capacity * 3) : null,
        drawn: [], drawnCount: 0, matrixFrom: 0, matrixTo: 0, colorFrom: 0, colorTo: 0 };
      initMesh(mesh);
      this.batches.set(key, b);
      this.group.add(mesh);
    } else if (b.used + n > b.capacity) this.grow(b, b.used + n);
    const block = new PooledBlock(b, b.used, n);
    for (let k = 0; k < n; k++) matrices[k]!.toArray(b.matrices, (b.used + k) * 16);
    b.colors?.fill(0, b.used * 3, (b.used + n) * 3);
    blockBounds(block, geometry, b.matrices);
    b.blocks.push(block);
    b.used += n;
    return block;
  }

  release(block: InstanceBlock): void {
    if (!(block instanceof PooledBlock) || !block.batch) return;
    const b = block.batch, at = b.blocks.indexOf(block);
    block.batch = null;
    if (at < 0) return;
    b.blocks.splice(at, 1);
    const from = block.offset, n = block.count, end = b.used;
    b.matrices.copyWithin(from * 16, (from + n) * 16, end * 16);
    b.colors?.copyWithin(from * 3, (from + n) * 3, end * 3);
    for (let k = at; k < b.blocks.length; k++) b.blocks[k]!.offset -= n;
    b.used -= n;
    block.offset = -1;
    block.drawOffset = -1;
  }

  /** A bigger mesh for a batch that is full; the shaders are built again once for it. */
  private grow(b: Batch, need: number): void {
    const capacity = Math.max(b.capacity * 2, THREE.MathUtils.ceilPowerOfTwo(need));
    const old = b.mesh, mesh = makeMesh(b.geometry, b.material, capacity, b.opts);
    const matrices = new Float32Array(capacity * 16);
    matrices.set(b.matrices.subarray(0, b.used * 16));
    b.matrices = matrices;
    if (b.colors) { const colors = new Float32Array(capacity * 3); colors.set(b.colors.subarray(0, b.used * 3)); b.colors = colors; }
    initMesh(mesh);
    b.mesh = mesh;
    b.capacity = capacity;
    // The new mesh's arrays are rewritten whole at the next flush (and upload whole on first use).
    for (const block of b.drawn) block.drawOffset = -1;
    b.drawn = []; b.drawnCount = 0;
    b.matrixFrom = b.matrixTo = b.colorFrom = b.colorTo = 0;
    this.group.remove(old);
    disposeRenderObjects(old);
    this.group.add(mesh);
    this.grown++;
  }

  /**
   * Cull and upload; call once per frame, before rendering. Without a view every block is drawn.
   * Only the changed instance range is uploaded. A range not yet uploaded is widened, not
   * replaced: a frame flushed but not rendered (a lost context) must not lose its range, and a
   * backend that never clears ranges must not pile them up.
   */
  flush(view?: PoolView | null): void {
    for (const b of this.batches.values()) {
      const shadows = b.mesh.castShadow;
      // The first block whose drawn place changes: everything from it on is rewritten.
      let k = 0, at = 0;
      const blocks = b.blocks, drawn = b.drawn;
      let i = 0;
      for (; i < blocks.length; i++) {
        const block = blocks[i]!;
        if (view && !inView(block, view, shadows)) continue;
        if (drawn[k] !== block || block.drawOffset !== at) break;
        if (block.colorDirty && b.colors) {
          b.mesh.instanceColor!.array.set(b.colors.subarray(block.offset * 3, (block.offset + block.count) * 3), at * 3);
          dirty(b, "color", at, at + block.count);
        }
        block.colorDirty = false;
        at += block.count; k++;
      }
      if (i < blocks.length || k < drawn.length) {
        const start = at;
        for (let d = k; d < drawn.length; d++) if (drawn[d]!.drawOffset >= start) drawn[d]!.drawOffset = -1;
        drawn.length = k;
        const mats = b.mesh.instanceMatrix.array as Float32Array, cols = b.mesh.instanceColor?.array as Float32Array | undefined;
        for (; i < blocks.length; i++) {
          const block = blocks[i]!;
          if (view && !inView(block, view, shadows)) { block.drawOffset = -1; continue; }
          mats.set(b.matrices.subarray(block.offset * 16, (block.offset + block.count) * 16), at * 16);
          if (cols && b.colors) cols.set(b.colors.subarray(block.offset * 3, (block.offset + block.count) * 3), at * 3);
          block.drawOffset = at; block.colorDirty = false;
          drawn.push(block);
          at += block.count;
        }
        dirty(b, "matrix", start, at);
        if (cols) dirty(b, "color", start, at);
        b.drawnCount = at;
        b.mesh.count = at;
        b.mesh.visible = at > 0;
        drawnBounds(b);
      }
      if (b.matrixTo > b.matrixFrom) {
        const a = b.mesh.instanceMatrix;
        widen(a, b.matrixFrom * 16, b.matrixTo * 16);
        a.needsUpdate = true;
        b.matrixFrom = b.matrixTo = 0;
      }
      const c = b.mesh.instanceColor;
      if (c && b.colorTo > b.colorFrom) {
        widen(c, b.colorFrom * 3, b.colorTo * 3);
        c.needsUpdate = true;
        b.colorFrom = b.colorTo = 0;
      }
    }
  }

  info(): { meshes: number; instances: number; capacity: number; grown: number; drawn: number } {
    let instances = 0, capacity = 0, drawn = 0;
    for (const b of this.batches.values()) { instances += b.used; capacity += b.capacity; drawn += b.drawnCount; }
    return { meshes: this.batches.size, instances, capacity, grown: this.grown, drawn };
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      for (const block of b.blocks) { block.batch = null; block.offset = block.drawOffset = -1; }
      b.mesh.removeFromParent(); disposeRenderObjects(b.mesh);
    }
    this.batches.clear();
    this.group.removeFromParent();
  }
}

function initMesh(mesh: THREE.InstancedMesh): void {
  mesh.count = 0;
  mesh.visible = false;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
}

/** The mesh's bounds: the union of the blocks it draws (three's own frustum test uses it). */
function drawnBounds(b: Batch): void {
  const s = b.mesh.boundingSphere ?? (b.mesh.boundingSphere = new THREE.Sphere());
  s.makeEmpty();
  for (const block of b.drawn) s.union(block.sphere);
  if (s.isEmpty()) s.set(s.center.set(0, 0, 0), 0);
}
