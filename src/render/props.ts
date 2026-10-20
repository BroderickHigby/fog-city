// Street furniture generated at runtime from the road graph, per tile, as instanced meshes:
// streetlights (pole, lamp head, a glow sprite and a light pool on the road at night) and
// street trees. Prototype geometries are shared and never disposed with a tile; the
// per-tile instance buffers are.

import * as THREE from "three";
import type { SharedMaterials } from "./materials.ts";
import type { Spot } from "./roads.ts";
import { MeshBuilder, addTree, type MeshData } from "./tile-geometry.ts";
import type { GroundFn } from "./types.ts";

export function geometryFromMeshData(d: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(d.normals, 3));
  g.setAttribute("color", new THREE.BufferAttribute(d.colors, 3, true));
  if (d.uvs) g.setAttribute("uv", new THREE.BufferAttribute(d.uvs, 2));
  if (d.facade) g.setAttribute("_facade", new THREE.BufferAttribute(d.facade, 4, true));
  const vcount = d.positions.length / 3;
  g.setIndex(new THREE.BufferAttribute(vcount < 65536 ? new Uint16Array(d.indices) : d.indices, 1));
  g.userData.fcBuildings = d.ranges;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

interface Protos {
  pole: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  pool: THREE.BufferGeometry;
  trees: THREE.BufferGeometry[];
  glowTex: THREE.Texture | null;
  poolTex: THREE.Texture | null;
}

let protos: Protos | null = null;

function radialTexture(inner: string, outer: string): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function getProtos(): Protos {
  if (protos) return protos;
  // Pole: a slim column with an arm reaching towards the road (local -z).
  const poleParts = [
    new THREE.CylinderGeometry(0.07, 0.11, 7.2, 6).translate(0, 3.6, 0),
    new THREE.BoxGeometry(0.09, 0.09, 1.9).translate(0, 7.05, -0.9),
  ].map((g) => g.toNonIndexed());
  const pole = mergeNonIndexed(poleParts);
  const head = new THREE.BoxGeometry(0.34, 0.14, 0.62).translate(0, 6.95, -1.75);
  const pool = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const trees = [0, 1].map((variant) => {
    const mb = new MeshBuilder();
    addTree(mb, 0, 0, 0, 1, 0, variant, 0.5);
    return geometryFromMeshData(mb.build());
  });
  protos = {
    pole,
    head,
    pool,
    trees,
    glowTex: radialTexture("rgba(255,236,200,1)", "rgba(255,170,90,0.35)"),
    poolTex: radialTexture("rgba(255,205,150,0.55)", "rgba(255,170,100,0.18)"),
  };
  return protos;
}

function mergeNonIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    nor.set(p.getAttribute("normal").array as Float32Array, o * 3);
    o += p.getAttribute("position").count;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}

export interface NightMaterials {
  glow: THREE.PointsMaterial;
  pool: THREE.MeshBasicMaterial;
}

export function createNightMaterials(): NightMaterials {
  const p = getProtos();
  const glow = new THREE.PointsMaterial({
    name: "fc:lamp-glow",
    size: 7,
    sizeAttenuation: true,
    map: p.glowTex,
    color: 0xffd9a8,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const pool = new THREE.MeshBasicMaterial({
    name: "fc:lamp-pool",
    map: p.poolTex,
    color: 0xffc890,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    fog: true,
  });
  return { glow, pool };
}

export interface TileProps {
  group: THREE.Group;
  /** Objects shown only at night. */
  nightOnly: THREE.Object3D[];
  lamps: number;
  trees: number;
  dispose(): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

export function buildTileProps(
  lamps: readonly Spot[],
  trees: readonly Spot[],
  ground: GroundFn,
  mats: SharedMaterials,
  night: NightMaterials,
): TileProps {
  const P = getProtos();
  const group = new THREE.Group();
  group.name = "props";
  const nightOnly: THREE.Object3D[] = [];
  const owned: Array<{ dispose(): void }> = [];

  if (lamps.length > 0) {
    const poles = new THREE.InstancedMesh(P.pole, mats.lampPole, lamps.length);
    const heads = new THREE.InstancedMesh(P.head, mats.lampHead, lamps.length);
    const pools = new THREE.InstancedMesh(P.pool, night.pool, lamps.length);
    const glowPos = new Float32Array(lamps.length * 3);
    lamps.forEach((l, i) => {
      const y = ground(l.x, l.z);
      _q.setFromAxisAngle(_up, -l.heading);
      _m.compose(_p.set(l.x, y, l.z), _q, _s.set(1, 1, 1));
      poles.setMatrixAt(i, _m);
      heads.setMatrixAt(i, _m);
      // Head position in world: local (0, 6.95, -1.75) rotated by heading.
      const hx = l.x + Math.sin(l.heading) * 1.75;
      const hz = l.z - Math.cos(l.heading) * 1.75;
      glowPos[i * 3] = hx;
      glowPos[i * 3 + 1] = y + 6.8;
      glowPos[i * 3 + 2] = hz;
      _m.compose(_p.set(hx, ground(hx, hz) + 0.3, hz), _q, _s.set(13, 1, 13));
      pools.setMatrixAt(i, _m);
    });
    for (const m of [poles, heads, pools]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      m.matrixAutoUpdate = false;
      group.add(m);
      owned.push(m);
    }
    poles.name = "lamp-poles";
    heads.name = "lamp-heads";
    pools.name = "lamp-pools";
    pools.renderOrder = 2;
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3));
    glowGeo.computeBoundingSphere();
    const glow = new THREE.Points(glowGeo, night.glow);
    glow.name = "lamp-glow";
    glow.renderOrder = 3;
    glow.matrixAutoUpdate = false;
    group.add(glow);
    owned.push(glowGeo);
    nightOnly.push(pools, glow);
  }

  const byVariant: Spot[][] = [[], []];
  for (const t of trees) byVariant[t.v < 0.12 ? 1 : 0]!.push(t);
  let treeCount = 0;
  byVariant.forEach((list, variant) => {
    if (list.length === 0) return;
    const mesh = new THREE.InstancedMesh(P.trees[variant]!, mats.foliage, list.length);
    list.forEach((t, i) => {
      const s = 0.75 + t.v * 0.55;
      _q.setFromAxisAngle(_up, t.heading);
      _m.compose(_p.set(t.x, ground(t.x, t.z), t.z), _q, _s.set(s, s * (0.9 + t.v * 0.2), s));
      mesh.setMatrixAt(i, _m);
      // A light tint over the baked trunk/leaf colours so neighbours differ.
      _c.setRGB(0.78 + t.v * 0.35, 0.86 + t.v * 0.2, 0.74 + (1 - t.v) * 0.22);
      mesh.setColorAt(i, _c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    mesh.name = `street-trees-${variant}`;
    group.add(mesh);
    owned.push(mesh);
    treeCount += list.length;
  });

  group.matrixAutoUpdate = false;
  return {
    group,
    nightOnly,
    lamps: lamps.length,
    trees: treeCount,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
