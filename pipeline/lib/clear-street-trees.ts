// Filter the source inventory before it feeds both drawn trees and solid simulation props.
// The render prototypes are CPU geometry here; no renderer, scene or texture is created.
import * as THREE from "three";
import { createFoliagePrototype, type Species } from "../../src/render/foliage.ts";
import { buildPalms, foliagePlacements, type TreeRecord } from "../../src/render/street-trees.ts";
import type { GroundFn, RoadGraph } from "../../src/render/types.ts";
import { TreeClearance } from "./tree-clearance.ts";
import { treeProfile } from "./tree-profile.ts";

export const TREE_DESCRIPTION = "Street trees, one per line: [treeid, x, z, class, height m]. class indexes `classes`. Placed from San Francisco Public Works' Street Tree Inventory; height from trunk diameter (pipeline/lib/street-trees.ts). Trees whose trunks or low branches overlap rendered roads are omitted for both drawing and solid props. Ids for knockable props: tree:<treeid>.";

export function filterStreetTrees(trees: readonly TreeRecord[], classes: readonly string[], roads: RoadGraph, ground: GroundFn,
  junctions: readonly { ring: readonly number[]; x: number; z: number }[] = []): TreeRecord[] {
  const clearance = new TreeClearance(roads, ground);
  for (const j of junctions) clearance.addJunction(j.ring, j.x, j.z);
  const rejected = new Set<number>();
  const matrix = new THREE.Matrix4(), shape = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scale = new THREE.Vector3();
  for (const species of [0, 1] as Species[]) {
    const models = [createFoliagePrototype(species, false), createFoliagePrototype(species, true)];
    const geometries = models.flatMap(p => [p.bark, p.leaves]);
    const profile = treeProfile(geometries);
    for (const geometry of geometries) geometry.dispose();
    for (const t of trees) {
      if (classes[t[3]] !== (species === 0 ? "broadleaf" : "conifer")) continue;
      const p = foliagePlacements([t], classes, ground)[0]!;
      const crown = .5 + .5 * Math.sin(p.x * .17 + p.z * .31);
      matrix.compose(pos.set(p.x, p.y, p.z), q.setFromAxisAngle(up, p.heading), scale.setScalar(p.scale));
      matrix.multiply(shape.makeScale(.88 + crown * .24, 1, 1.10 - crown * .20));
      if (!clearance.allows(profile, matrix)) rejected.add(t[0]);
    }
  }
  // Use the same matrices as the palm renderer, including its trunk lean and frond scale.
  const palmRecords = trees.filter(t => classes[t[3]] === "palm");
  const palms = buildPalms(palmRecords, classes, ground);
  if (palms) {
    for (const mesh of palms.children as THREE.InstancedMesh[]) {
      const profile = treeProfile([mesh.geometry]);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        if (!clearance.allows(profile, matrix)) rejected.add(palmRecords[i]![0]);
      }
      mesh.dispose();
    }
  }
  return trees.filter(t => !rejected.has(t[0]));
}
