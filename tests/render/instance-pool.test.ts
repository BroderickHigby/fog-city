// The shared instance pool (src/render/instance-pool.ts): owners get blocks of one long-lived
// InstancedMesh per kind, releasing a block packs the later ones down, and only the changed
// instance range is uploaded. No browser.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { InstancePool, LocalInstances, POOL_MIN_CAPACITY } from "../../src/render/instance-pool.ts";

const at = (x: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, 0, 0);
const xs = (mesh: THREE.InstancedMesh): number[] => Array.from({ length: mesh.count }, (_, i) => mesh.instanceMatrix.array[i * 16 + 12]!);
const meshes = (root: THREE.Object3D): THREE.InstancedMesh[] => root.children.filter((o): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh);

describe("instance pool", () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial(), other = new THREE.MeshStandardMaterial();

  it("puts every owner of a kind in one mesh and keeps kinds apart", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1), at(2)], { name: "posts", castShadow: true })!;
    const b = pool.add(geometry, material, [at(3)], { name: "posts", castShadow: true })!;
    const c = pool.add(geometry, other, [at(4)], { name: "posts", castShadow: true })!;
    expect(a.mesh).toBe(b.mesh);
    expect(c.mesh).not.toBe(a.mesh);
    expect(meshes(pool.group)).toHaveLength(2);
    expect([a.offset, b.offset]).toEqual([0, 2]);
    expect(xs(a.mesh)).toEqual([1, 2, 3]);
    expect(a.mesh.castShadow).toBe(true);
    expect(a.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(POOL_MIN_CAPACITY);
    expect(pool.add(geometry, material, [], { name: "posts" })).toBeNull();
    pool.dispose();
  });

  it("packs later blocks down on release and uploads only the changed range", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1), at(2)], { name: "k" })!;
    const b = pool.add(geometry, material, [at(3), at(4), at(5)], { name: "k" })!;
    const c = pool.add(geometry, material, [at(6)], { name: "k" })!;
    pool.flush();
    const attr = a.mesh.instanceMatrix, version = attr.version;
    expect(attr.updateRanges).toEqual([{ start: 0, count: 6 * 16 }]);
    attr.clearUpdateRanges(); // as the renderer does once it uploads them
    pool.release(a);
    expect(xs(b.mesh)).toEqual([3, 4, 5, 6]);
    expect([b.offset, c.offset]).toEqual([0, 3]);
    pool.flush();
    expect(attr.version).toBeGreaterThan(version);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 4 * 16 }]);
    // Releasing the last block moves nothing: no upload.
    const v2 = attr.version;
    pool.release(c); pool.flush();
    expect(attr.version).toBe(v2);
    expect(b.mesh.count).toBe(3);
    pool.release(b); pool.release(b);
    expect(b.mesh.count).toBe(0);
    expect(b.mesh.visible).toBe(false);
    expect(pool.info()).toMatchObject({ meshes: 1, instances: 0 });
    pool.dispose();
  });

  it("keeps every range flushed before the renderer uploads (a frame not rendered loses none)", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1), at(2)], { name: "k" })!;
    pool.flush();
    pool.add(geometry, material, [at(3)], { name: "k" });
    pool.flush();
    expect(a.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 2 * 16 }, { start: 2 * 16, count: 16 }]);
    // The sort bounds are recomputed from the live instances, not kept from the first frame.
    expect(a.mesh.boundingSphere).toBeNull();
    a.mesh.computeBoundingSphere();
    expect(a.mesh.boundingSphere!.center.x).toBeCloseTo(2, 5);
    pool.dispose();
  });

  it("keeps per-instance colours with their block through packing", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1)], { name: "lens", colors: true })!;
    const b = pool.add(geometry, material, [at(2), at(3)], { name: "lens", colors: true })!;
    b.setColorAt(1, new THREE.Color(0, 1, 0)); b.commitColors();
    a.setColorAt(0, new THREE.Color(1, 0, 0)); a.setColorAt(5, new THREE.Color(1, 1, 1)); a.commitColors();
    pool.flush();
    pool.release(a);
    const c = new THREE.Color();
    b.mesh.getColorAt(b.offset + 1, c);
    expect(c.toArray()).toEqual([0, 1, 0]);
    b.mesh.getColorAt(b.offset, c);
    expect(c.toArray()).toEqual([0, 0, 0]);
    pool.dispose();
  });

  it("grows a full kind into a bigger mesh, keeping every block's data and offset", () => {
    const pool = new InstancePool();
    const first = pool.add(geometry, material, Array.from({ length: POOL_MIN_CAPACITY - 1 }, (_, i) => at(i)), { name: "k" })!;
    const old = first.mesh;
    const second = pool.add(geometry, material, [at(-1), at(-2)], { name: "k" })!;
    expect(second.mesh).not.toBe(old);
    expect(first.mesh).toBe(second.mesh);
    expect(meshes(pool.group)).toEqual([second.mesh]);
    expect(second.mesh.instanceMatrix.count).toBe(POOL_MIN_CAPACITY * 2);
    expect(xs(second.mesh).slice(-3)).toEqual([POOL_MIN_CAPACITY - 2, -1, -2]);
    expect(pool.info().grown).toBe(1);
    pool.dispose();
    expect(pool.group.children).toHaveLength(0);
  });

  it("gives standalone owners their own meshes with the same flags", () => {
    const group = new THREE.Group(), local = new LocalInstances(group);
    const block = local.add(geometry, material, [at(1), at(2)], { name: "own", castShadow: true, receiveShadow: true, colors: true })!;
    expect(group.children).toEqual([block.mesh]);
    expect(block.mesh.count).toBe(2);
    expect(block.mesh.castShadow && block.mesh.receiveShadow).toBe(true);
    const version = block.mesh.instanceColor!.version;
    block.setColorAt(1, new THREE.Color(1, 0, 0)); block.commitColors();
    expect(block.mesh.instanceColor!.version).toBeGreaterThan(version);
    local.release(block);
    expect(group.children).toHaveLength(0);
  });
});
