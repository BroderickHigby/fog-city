// The shared instance pool (src/render/instance-pool.ts): owners get blocks of one long-lived
// InstancedMesh per kind, releasing a block packs the later ones down, flush() culls per block
// to the view, and only the changed instance range is uploaded. No browser.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { InstancePool, LocalInstances, POOL_MIN_CAPACITY, poolView } from "../../src/render/instance-pool.ts";

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
    pool.flush();
    expect(a.mesh).toBe(b.mesh);
    expect(c.mesh).not.toBe(a.mesh);
    expect(meshes(pool.group)).toHaveLength(2);
    expect([a.offset, b.offset]).toEqual([0, 2]);
    expect(xs(a.mesh)).toEqual([1, 2, 3]);
    expect(a.mesh.castShadow).toBe(true);
    // Past the default 64 KiB uniform-buffer limit (1024 matrices): the node renderer keeps the
    // instances in a vertex buffer instead of re-uploading all of them for every draw.
    expect(a.mesh.instanceMatrix.count).toBeGreaterThanOrEqual(POOL_MIN_CAPACITY);
    expect(POOL_MIN_CAPACITY * 64).toBeGreaterThan(65536);
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
    expect([b.offset, c.offset]).toEqual([0, 3]);
    pool.flush();
    expect(xs(b.mesh)).toEqual([3, 4, 5, 6]);
    expect(attr.version).toBeGreaterThan(version);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 4 * 16 }]);
    // Nothing changed: no upload.
    const v1 = attr.version;
    pool.flush();
    expect(attr.version).toBe(v1);
    // Releasing the last block moves nothing: no upload, one fewer drawn.
    const v2 = attr.version;
    pool.release(c); pool.flush();
    expect(attr.version).toBe(v2);
    expect(b.mesh.count).toBe(3);
    pool.release(b); pool.release(b); pool.flush();
    expect(b.mesh.count).toBe(0);
    expect(b.mesh.visible).toBe(false);
    expect(pool.info()).toMatchObject({ meshes: 1, instances: 0, drawn: 0 });
    pool.dispose();
  });

  it("invalidates a released block: its colour calls write nothing and its offset is gone", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1)], { name: "lens", colors: true })!;
    const b = pool.add(geometry, material, [at(2)], { name: "lens", colors: true })!;
    pool.flush();
    pool.release(a);
    expect(a.offset).toBe(-1);
    // b now sits where a was: a stale handle must not paint it.
    a.setColorAt(0, new THREE.Color(1, 0, 0)); a.commitColors();
    pool.flush();
    const c = new THREE.Color();
    b.mesh.getColorAt(0, c);
    expect(c.toArray()).toEqual([0, 0, 0]);
    pool.release(a);
    expect(pool.info()).toMatchObject({ instances: 1 });
    pool.dispose();
  });

  it("widens the range flushed before the renderer uploads (a frame not rendered loses none, none pile up)", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1), at(2)], { name: "k" })!;
    pool.flush();
    pool.add(geometry, material, [at(3)], { name: "k" });
    pool.flush();
    expect(a.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 3 * 16 }]);
    // The bounds are the drawn blocks' union, kept current (three culls and sorts with them).
    const s = a.mesh.boundingSphere!;
    for (const x of [0.5, 3.5]) expect(s.containsPoint(new THREE.Vector3(x, 0.5, 0.5))).toBe(true);
    expect(s.radius).toBeLessThan(4);
    // A backend that never clears them: still one range after many flushes.
    for (let k = 0; k < 50; k++) { pool.add(geometry, material, [at(10 + k)], { name: "k" }); pool.flush(); }
    expect(a.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 53 * 16 }]);
    pool.dispose();
  });

  it("uploads committed colours: the colour attribute's version and range change at flush", () => {
    const pool = new InstancePool();
    const a = pool.add(geometry, material, [at(1), at(2)], { name: "lens", colors: true })!;
    const b = pool.add(geometry, material, [at(3), at(4)], { name: "lens", colors: true })!;
    pool.flush();
    const colors = a.mesh.instanceColor!;
    colors.clearUpdateRanges();
    const version = colors.version;
    b.setColorAt(1, new THREE.Color(0, 1, 0));
    // Set but not committed: nothing goes up yet.
    pool.flush();
    expect(colors.version).toBe(version);
    b.commitColors();
    pool.flush();
    expect(colors.version).toBeGreaterThan(version);
    expect(colors.updateRanges).toEqual([{ start: 2 * 3, count: 2 * 3 }]);
    const c = new THREE.Color();
    a.mesh.getColorAt(3, c);
    expect(c.toArray()).toEqual([0, 1, 0]);
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
    pool.flush();
    const c = new THREE.Color();
    b.mesh.getColorAt(b.offset + 1, c);
    expect(c.toArray()).toEqual([0, 1, 0]);
    b.mesh.getColorAt(b.offset, c);
    expect(c.toArray()).toEqual([0, 0, 0]);
    pool.dispose();
  });

  it("draws only the blocks in view, or whose shadow reaches it, and uploads nothing while that holds", () => {
    const pool = new InstancePool();
    // A camera at the origin looking down -z: blocks at z = -50 are in view, z = +50 behind it.
    const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 1000);
    const atZ = (z: number, y = 0): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(0, y, z);
    const ahead = pool.add(geometry, material, [atZ(-50), atZ(-55)], { name: "k" })!;
    const behind = pool.add(geometry, material, [atZ(50)], { name: "k" })!;
    const ahead2 = pool.add(geometry, material, [atZ(-60)], { name: "k" })!;
    const view = poolView(camera, null);
    pool.flush(view);
    const mesh = ahead.mesh, zs = (): number[] => Array.from({ length: mesh.count }, (_, i) => mesh.instanceMatrix.array[i * 16 + 14]!);
    expect(zs()).toEqual([-50, -55, -60]);
    expect(pool.info()).toMatchObject({ instances: 4, drawn: 3 });
    expect(mesh.boundingSphere!.center.z).toBeLessThan(0);
    // Same view: nothing rewritten.
    const version = mesh.instanceMatrix.version;
    pool.flush(view);
    expect(mesh.instanceMatrix.version).toBe(version);
    // Turn round: the block behind is now the one drawn.
    camera.rotation.y = Math.PI;
    pool.flush(poolView(camera, null));
    expect(zs()).toEqual([50]);
    // No view: everything, in block order.
    pool.flush(null);
    expect(zs()).toEqual([-50, -55, 50, -60]);
    void behind; void ahead2;
    pool.dispose();
  });

  it("keeps a caster out of view whose shadow falls in view, if the kind casts shadows", () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 1000);
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 0, -20);
    // A tall pole (10 m) 30 m behind the camera, the sun low behind it too: its shadow runs forward.
    const pole = new THREE.Matrix4().compose(new THREE.Vector3(0, 5, 30), new THREE.Quaternion(), new THREE.Vector3(0.3, 10, 0.3));
    const sun = new THREE.Vector3(0, 0.3, 1).normalize();
    for (const castShadow of [true, false]) {
      const pool = new InstancePool();
      const block = pool.add(geometry, material, [pole], { name: "pole", castShadow })!;
      pool.flush(poolView(camera, sun));
      expect(block.mesh.count, `castShadow ${castShadow}`).toBe(castShadow ? 1 : 0);
      // Sun overhead: the shadow stays under the pole, out of view.
      pool.flush(poolView(camera, new THREE.Vector3(0, 1, 0)));
      expect(block.mesh.count).toBe(0);
      pool.dispose();
    }
  });

  it("grows a full kind into a bigger mesh, keeping every block's data and offset", () => {
    const pool = new InstancePool();
    const first = pool.add(geometry, material, Array.from({ length: POOL_MIN_CAPACITY - 1 }, (_, i) => at(i)), { name: "k" })!;
    pool.flush();
    const old = first.mesh;
    const second = pool.add(geometry, material, [at(-1), at(-2)], { name: "k" })!;
    pool.flush();
    expect(second.mesh).not.toBe(old);
    expect(first.mesh).toBe(second.mesh);
    expect(meshes(pool.group)).toEqual([second.mesh]);
    expect(second.mesh.instanceMatrix.count).toBe(POOL_MIN_CAPACITY * 2);
    expect(xs(second.mesh).slice(-3)).toEqual([POOL_MIN_CAPACITY - 2, -1, -2]);
    expect(second.offset).toBe(POOL_MIN_CAPACITY - 1);
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
