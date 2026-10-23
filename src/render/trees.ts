// The high tier's street trees in the Ferry Building showcase: ez-tree (Daniel Greenheck, MIT,
// npm @dgreenheck/ez-tree 1.1.0; bark and leaf textures ship inside its bundle) generates a few
// trees once, seeded and lightened (fewer branch sections and segments: about 6-9k triangles a
// tree), and each variant is drawn as two instanced meshes (bark, leaves) in a near and a far build at the street-tree
// spots the tile props would have filled with their low-poly stand-ins (tile-streamer.ts
// treeSpots), the NEAR_PER_VARIANT nearest the camera; re-picked when the camera moves REPICK_M. Loaded with a dynamic import, so the default tier's bundle never
// carries it. Render-only: trees have no collider, as before.

import * as THREE from "three";
import type { Spot } from "./roads.ts";

/** ez-tree presets used for the city's street trees (London plane and ash read alike at street scale). */
const VARIANTS: ReadonlyArray<{ preset: string; seed: number; scale: number }> = [
  { preset: "Ash Medium", seed: 11, scale: 0.5 },
  { preset: "Oak Medium", seed: 23, scale: 0.48 },
  { preset: "Aspen Medium", seed: 37, scale: 0.55 },
];

/** Trees drawn per variant: the nearest to the camera. */
export const NEAR_PER_VARIANT = 30;
/** Of those, the nearest this many get the full tree; the rest a far build (a third of the leaves, half the branch detail). */
export const FULL_PER_VARIANT = 10;
const REPICK_M = 15;

interface Build {
  bark: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  triangles: number;
}

interface Variant {
  near: Build;
  far: Build;
  scale: number;
}

export class StreetTrees {
  readonly group = new THREE.Group();
  private readonly variants: Variant[];
  private readonly spots = new Map<string, Spot & { y: number }>();
  private dirty = false;
  private readonly capacity: number;

  private constructor(variants: Variant[], capacity: number) {
    this.variants = variants;
    this.capacity = capacity;
    this.group.name = "showcase:trees";
    for (const v of variants) this.group.add(v.near.bark, v.near.leaves, v.far.bark, v.far.leaves);
  }

  /** Generate the variants; `capacity` trees per variant at most. */
  static async load(shadows: boolean, capacity = NEAR_PER_VARIANT): Promise<StreetTrees> {
    const { Tree } = await import("@dgreenheck/ez-tree");
    const variants: Variant[] = [];
    const build = (v: (typeof VARIANTS)[number], lod: "near" | "far", count: number): Build => {
      const tree = new Tree();
      tree.loadPreset(v.preset);
      tree.options.seed = v.seed;
      // Lighter than the presets: street trees are seen at 10-150 m, not in close-up; the far
      // build lighter again, its leaves fewer and larger so the crown keeps its mass.
      const branch = lod === "near" ? 0.6 : 0.35;
      const leafCount = lod === "near" ? 0.55 : 0.18;
      const leafSize = lod === "near" ? 1.25 : 2;
      const b = tree.options.branch as unknown as { sections: Record<string, number>; segments: Record<string, number> };
      for (const k of Object.keys(b.sections)) b.sections[k] = Math.max(1, Math.round(b.sections[k]! * branch));
      for (const k of Object.keys(b.segments)) b.segments[k] = Math.max(3, Math.round(b.segments[k]! * (lod === "near" ? 0.7 : 0.5)));
      const leaves = tree.options.leaves as unknown as { count: number; size: number };
      leaves.count = Math.max(3, Math.round(leaves.count * leafCount));
      leaves.size *= leafSize;
      tree.generate();
      // ez-tree's leaf material bends its vertices for wind in a shader that ignores instancing
      // (every instance's leaves would draw at the origin): the leaves get a standard material with
      // the same texture instead, alpha-tested and two-sided. The bark keeps its material.
      const src = (Array.isArray(tree.leavesMesh.material) ? tree.leavesMesh.material[0] : tree.leavesMesh.material) as THREE.MeshStandardMaterial;
      const leafMat = new THREE.MeshStandardMaterial({
        name: `fc:tree-leaves:${v.preset}:${lod}`,
        map: src.map ?? null,
        color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.8,
        metalness: 0,
      });
      const parts = [
        { geometry: tree.branchesMesh.geometry, material: tree.branchesMesh.material },
        { geometry: tree.leavesMesh.geometry, material: leafMat },
      ].map((m) => {
        const im = new THREE.InstancedMesh(m.geometry, m.material, count);
        im.count = 0;
        im.castShadow = shadows;
        im.receiveShadow = shadows;
        im.frustumCulled = false;
        return im;
      });
      parts[0]!.name = `showcase:trees:${v.preset}:${lod}:bark`;
      parts[1]!.name = `showcase:trees:${v.preset}:${lod}:leaves`;
      return { bark: parts[0]!, leaves: parts[1]!, triangles: tree.triangleCount };
    };
    const full = Math.min(FULL_PER_VARIANT, capacity);
    for (const v of VARIANTS) {
      variants.push({ near: build(v, "near", Math.max(1, full)), far: build(v, "far", Math.max(1, capacity - full)), scale: v.scale });
    }
    return new StreetTrees(variants, capacity);
  }

  /** Street-tree spots (with their ground height) to draw; the same spot added twice counts once. */
  add(spots: ReadonlyArray<Spot & { y: number }>): void {
    for (const s of spots) {
      const key = `${s.x.toFixed(1)},${s.z.toFixed(1)}`;
      if (!this.spots.has(key)) {
        this.spots.set(key, s);
        this.dirty = true;
      }
    }
  }

  private lastX = Infinity;
  private lastZ = Infinity;

  /** Rebuild the instance lists when spots were added or the camera moved REPICK_M (once a frame at most). */
  update(camX: number, camZ: number): void {
    if (!this.dirty && Math.hypot(camX - this.lastX, camZ - this.lastZ) < REPICK_M) return;
    this.dirty = false;
    this.lastX = camX;
    this.lastZ = camZ;
    const byDistance = [...this.spots.values()].sort((a, b) => Math.hypot(a.x - camX, a.z - camZ) - Math.hypot(b.x - camX, b.z - camZ));
    const n = this.variants.length;
    const counts = new Array<number>(n).fill(0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const s of byDistance) {
      const k = Math.floor(s.v * n) % n;
      const v = this.variants[k]!;
      if (counts[k]! >= this.capacity) continue;
      const scale = v.scale * (0.85 + 0.3 * ((s.v * 7.3) % 1));
      q.setFromAxisAngle(up, s.v * Math.PI * 2 * 13);
      m.compose(p.set(s.x, s.y - 0.05, s.z), q, sc.set(scale, scale, scale));
      const full = v.near.bark.instanceMatrix.count;
      const [b, i] = counts[k]! < full ? [v.near, counts[k]!] : [v.far, counts[k]! - full];
      b.bark.setMatrixAt(i, m);
      b.leaves.setMatrixAt(i, m);
      counts[k]!++;
    }
    this.variants.forEach((v, k) => {
      const full = v.near.bark.instanceMatrix.count;
      const n = [Math.min(counts[k]!, full), Math.max(0, counts[k]! - full)] as const;
      [v.near, v.far].forEach((b, j) => {
        b.bark.count = n[j]!;
        b.leaves.count = n[j]!;
        b.bark.instanceMatrix.needsUpdate = true;
        b.leaves.instanceMatrix.needsUpdate = true;
      });
    });
  }

  get count(): number {
    return this.spots.size;
  }

  /** Triangles drawn now (bark and leaves, both builds). */
  get triangles(): number {
    return this.variants.reduce((n, v) => n + v.near.bark.count * v.near.triangles + v.far.bark.count * v.far.triangles, 0);
  }

  dispose(): void {
    for (const v of this.variants) for (const b of [v.near, v.far]) {
      b.bark.dispose();
      b.leaves.dispose();
    }
  }
}
