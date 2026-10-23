// The high tier's street trees in the Ferry Building showcase: ez-tree (Daniel Greenheck, MIT,
// npm @dgreenheck/ez-tree 1.1.0; bark and leaf textures ship inside its bundle) generates a few
// trees once, seeded and lightened (fewer branch sections and segments: about 6-9k triangles a
// tree), and each variant is drawn as two instanced meshes (bark, leaves) at the street-tree
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

/** Trees drawn per variant: the nearest to the camera (three variants: 90 trees, about 1M triangles). */
export const NEAR_PER_VARIANT = 30;
const REPICK_M = 15;

interface Variant {
  bark: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  scale: number;
  triangles: number;
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
    for (const v of variants) this.group.add(v.bark, v.leaves);
  }

  /** Generate the variants; `capacity` trees per variant at most. */
  static async load(shadows: boolean, capacity = NEAR_PER_VARIANT): Promise<StreetTrees> {
    const { Tree } = await import("@dgreenheck/ez-tree");
    const variants: Variant[] = [];
    for (const v of VARIANTS) {
      const tree = new Tree();
      tree.loadPreset(v.preset);
      tree.options.seed = v.seed;
      // Lighter than the presets: street trees are seen at 10-150 m, not in close-up.
      const b = tree.options.branch as unknown as { sections: Record<string, number>; segments: Record<string, number> };
      for (const k of Object.keys(b.sections)) b.sections[k] = Math.max(1, Math.round(b.sections[k]! * 0.6));
      for (const k of Object.keys(b.segments)) b.segments[k] = Math.max(3, Math.round(b.segments[k]! * 0.7));
      const leaves = tree.options.leaves as unknown as { count: number; size: number };
      leaves.count = Math.max(4, Math.round(leaves.count * 0.55));
      leaves.size *= 1.25;
      tree.generate();
      const parts = [tree.branchesMesh, tree.leavesMesh].map((m) => {
        const im = new THREE.InstancedMesh(m.geometry, m.material, capacity);
        im.count = 0;
        im.castShadow = shadows;
        im.receiveShadow = shadows;
        im.frustumCulled = false;
        return im;
      });
      parts[0]!.name = `showcase:trees:${v.preset}:bark`;
      parts[1]!.name = `showcase:trees:${v.preset}:leaves`;
      variants.push({ bark: parts[0]!, leaves: parts[1]!, scale: v.scale, triangles: tree.triangleCount });
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
      v.bark.setMatrixAt(counts[k]!, m);
      v.leaves.setMatrixAt(counts[k]!, m);
      counts[k]!++;
    }
    this.variants.forEach((v, k) => {
      v.bark.count = counts[k]!;
      v.leaves.count = counts[k]!;
      v.bark.instanceMatrix.needsUpdate = true;
      v.leaves.instanceMatrix.needsUpdate = true;
    });
  }

  get count(): number {
    return this.spots.size;
  }

  dispose(): void {
    for (const v of this.variants) {
      v.bark.dispose();
      v.leaves.dispose();
    }
  }
}
