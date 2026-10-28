// Real street trees from the pipeline's street-trees.json (pipeline/lib/street-trees.ts).
// Broadleaf and conifer trees are handed to the foliage layer (foliage.ts owns their look: leaf
// cards, bark, wind, distance tiers); palms, which it has no prototype for, are drawn here as
// instanced trunks and frond crowns. Render-only. Ids are `tree:<treeid>`.

import * as THREE from "three";
import type { Species } from "./foliage.ts";
import { LocalInstances, type InstanceBlock, type InstanceSink } from "./instance-pool.ts";
import { hashId } from "./street-furniture.ts";

/** [treeid, x, z, class index, height] as the file stores it. */
export type TreeRecord = [number, number, number, number, number];

/** Heights of foliage.ts's prototypes: broadleaf 6.6 m, cypress 10.5 m. */
const PROTO_H: Record<Species, number> = { 0: 6.6, 1: 10.5 };

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  heading: number;
  scale: number;
  species: Species;
  tint: THREE.Color;
}

/** Foliage-layer placements for the broadleaf (class 0) and conifer (class 1) trees. */
export function foliagePlacements(trees: readonly TreeRecord[], classes: readonly string[], ground: (x: number, z: number) => number): TreePlacement[] {
  const out: TreePlacement[] = [];
  for (const [id, x, z, cls, h] of trees) {
    const name = classes[cls];
    if (name !== "broadleaf" && name !== "conifer") continue;
    const species: Species = name === "conifer" ? 1 : 0;
    const v = (hashId(`tree:${id}`) % 1000) / 1000;
    out.push({
      x, y: ground(x, z), z,
      heading: v * Math.PI * 2,
      scale: Math.max(0.35, h / PROTO_H[species]),
      species,
      // The same light tint range the procedural trees used, so neighbours differ.
      tint: new THREE.Color(0.78 + v * 0.35, 0.86 + v * 0.2, 0.74 + (1 - v) * 0.22),
    });
  }
  return out;
}

interface PalmProtos {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  trunkMat: THREE.MeshStandardMaterial;
  crownMat: THREE.MeshStandardMaterial;
}

let palms: PalmProtos | null = null;

/** A crown of drooping fronds around the origin (the trunk top), about 2.6 m across each way. */
function crownGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const fronds = 14;
  const green = new THREE.Color(0x4f6f2c), dry = new THREE.Color(0x8a8a46);
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.2;
    const ux = Math.cos(a), uz = Math.sin(a);
    const lift = f % 3 === 0 ? 0.55 : f % 3 === 1 ? 0.15 : -0.25;
    const c = f % 5 === 0 ? dry : green;
    const steps = 6;
    const base = pos.length / 3;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const r = 2.6 * t;
      // Rises, then droops toward the tip.
      const y = lift * t * 2.2 - 1.6 * t * t;
      const w = 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.05));
      const px = -uz * w, pz = ux * w;
      pos.push(ux * r + px, y, uz * r + pz, ux * r - px, y - 0.06, uz * r - pz);
      const shade = 0.8 + 0.2 * t;
      col.push(c.r * shade, c.g * shade, c.b * shade, c.r * shade * 0.85, c.g * shade * 0.85, c.b * shade * 0.85);
    }
    for (let k = 0; k < steps; k++) {
      const i = base + k * 2;
      idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function getPalms(): PalmProtos {
  if (palms) return palms;
  palms = {
    trunk: new THREE.CylinderGeometry(0.17, 0.27, 1, 8, 4).translate(0, 0.5, 0),
    crown: crownGeometry(),
    trunkMat: new THREE.MeshStandardMaterial({ color: 0x7b6b58, roughness: 0.95, name: "fc:palm-trunk" }),
    crownMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, name: "fc:palm-fronds" }),
  };
  return palms;
}

/** The palm trunk and crown placements of one cell. */
function palmMatrices(trees: readonly TreeRecord[], classes: readonly string[], ground: (x: number, z: number) => number): { trunks: THREE.Matrix4[]; crowns: THREE.Matrix4[] } {
  const trunks: THREE.Matrix4[] = [], crowns: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion(), lean = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0), pos = new THREE.Vector3(), s = new THREE.Vector3(), top = new THREE.Vector3();
  for (const [id, x, z, cls, h] of trees) {
    if (classes[cls] !== "palm") continue;
    const v = (hashId(`tree:${id}`) % 1000) / 1000;
    const y = ground(x, z);
    // A slight lean, the same way up the trunk.
    q.setFromAxisAngle(up, v * Math.PI * 2).multiply(lean.setFromAxisAngle(side, (v - 0.5) * 0.12));
    const girth = 0.8 + Math.min(1.6, h / 12);
    trunks.push(new THREE.Matrix4().compose(pos.set(x, y - 0.1, z), q, s.set(girth, h, girth)));
    top.set(0, h - 0.1, 0).applyQuaternion(q);
    const k = 0.75 + Math.min(0.7, h / 20);
    crowns.push(new THREE.Matrix4().compose(pos.set(x + top.x, y + top.y, z + top.z), q, s.set(k, k, k)));
  }
  return { trunks, crowns };
}

/** One cell's palms as instances in `sink` (trunks, then crowns); empty when it has none. */
export function addPalms(trees: readonly TreeRecord[], classes: readonly string[], ground: (x: number, z: number) => number, sink: InstanceSink): InstanceBlock[] {
  const { trunks, crowns } = palmMatrices(trees, classes, ground);
  if (!trunks.length) return [];
  const p = getPalms();
  return [
    sink.add(p.trunk, p.trunkMat, trunks, { name: "palm trunks", castShadow: true, receiveShadow: true })!,
    sink.add(p.crown, p.crownMat, crowns, { name: "palm crowns", castShadow: true, receiveShadow: true })!,
  ];
}

/** Instanced palms for one cell in their own group; null when it has none. */
export function buildPalms(trees: readonly TreeRecord[], classes: readonly string[], ground: (x: number, z: number) => number): THREE.Group | null {
  const g = new THREE.Group();
  if (!addPalms(trees, classes, ground, new LocalInstances(g)).length) return null;
  g.name = "palms";
  return g;
}
