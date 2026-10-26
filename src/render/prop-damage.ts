import * as THREE from "three";
import type { SimState } from "../sim/contract.ts";
import { impactsOf, type PropKnock } from "../sim/impacts.ts";
import type { Prop } from "../sim/props.ts";

// Broken street props (src/sim/impacts.ts, src/sim/props.ts): street trees topple (or lean, or
// snap), lamp posts keel over, and fire hydrants, drawn here at their refill points, are knocked
// off their base and gush a geyser until the city puts them back. Trees go through the foliage
// layer's pose override (SceneRenderer.setFoliageOverride); lamp posts and any street-tree meshes
// still drawn by their tiles are re-posed in place (and restored when the prop comes back). The
// fall animates over FALL_S from the tick it broke. Cosmetic: which prop broke, which way and when
// all come from the sim snapshot.

const FALL_S = 0.9;
const TICK_S = 1 / 60;
const HYDRANTS = 96;
const HYDRANT_RANGE_M = 140;
const GEYSER = 320;
/** Rescan the scene's tile meshes for broken props this often while any are broken, seconds. */
const RESCAN_S = 1;
/** A drawn prop is the sim's prop when its base is this close, metres. */
const MATCH_M = 0.05;

/** Final tilt by state, radians. */
function tiltOf(k: Readonly<PropKnock>): number {
  return k.state === "leaning" ? 0.38 : k.state === "fallen" ? 1.48 : k.state === "snapped" ? 1.35 : 1.3;
}

export interface PropDamageOptions {
  /** A sim prop by id (props.ts propIndex(world).byId). */
  prop: (id: string) => Prop | undefined;
  /** Hydrants to draw (the world's hydrant refill points, id "hydrant:<refill id>"). */
  hydrants: ReadonlyArray<{ id: string; x: number; z: number }>;
  ground: (x: number, z: number) => number;
  /** SceneRenderer.setFoliageOverride. */
  setFoliageOverride: (fn: ((x: number, z: number, matrix: THREE.Matrix4) => THREE.Matrix4 | null) | null) => void;
}

interface Water { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number }

export class PropDamage {
  readonly root = new THREE.Group();
  private readonly hydrants: THREE.InstancedMesh;
  private readonly geyserGeo = new THREE.BufferGeometry();
  private readonly geyserPos = new Float32Array(GEYSER * 3);
  private readonly water: Water[] = [];
  private readonly tmp = new THREE.Object3D();
  private readonly m1 = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  /** Knocked props as of the last update, and the tick of that update. */
  private knocked: Record<string, PropKnock> = {};
  private tick = 0;
  private signature = "";
  /** Broken trees and lamps by 1 m cell, for matching drawn instances. */
  private cells = new Map<string, Array<{ id: string; x: number; z: number; k: PropKnock; height: number }>>();
  /** Tile instances re-posed in place: their original matrices. */
  private readonly moved = new Map<THREE.InstancedMesh, Map<number, THREE.Matrix4>>();
  private rescan = 0;
  private puff = 0;

  private readonly scene: THREE.Scene;
  private readonly opts: PropDamageOptions;

  constructor(scene: THREE.Scene, opts: PropDamageOptions) {
    this.scene = scene;
    this.opts = opts;
    this.root.name = "prop-damage";
    const body = new THREE.CylinderGeometry(0.16, 0.2, 0.62, 10).translate(0, 0.31, 0);
    const cap = new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.62, 0);
    const nozzles = new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6).rotateZ(Math.PI / 2).translate(0, 0.42, 0);
    const merged = mergeGeometries([body, cap, nozzles]);
    this.hydrants = new THREE.InstancedMesh(merged, new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.55, metalness: 0.2 }), HYDRANTS);
    this.hydrants.name = "hydrants";
    this.hydrants.count = 0;
    this.hydrants.frustumCulled = false;
    this.hydrants.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.geyserGeo.setAttribute("position", new THREE.BufferAttribute(this.geyserPos, 3).setUsage(THREE.DynamicDrawUsage));
    const geyser = new THREE.Points(this.geyserGeo, new THREE.PointsMaterial({ color: 0xbfe6ff, size: 0.22, transparent: true, opacity: 0.8, depthWrite: false }));
    geyser.name = "hydrant-geyser";
    geyser.frustumCulled = false;
    this.root.add(this.hydrants, geyser);
    scene.add(this.root);
  }

  /** Broken props drawn so far (for tests): trees and lamps re-posed, hydrants knocked. */
  info(): { knocked: number; reposed: number; geyser: number } {
    let reposed = 0;
    for (const m of this.moved.values()) reposed += m.size;
    return { knocked: Object.keys(this.knocked).length, reposed, geyser: this.water.length };
  }

  update(curr: SimState, dt: number, camX: number, camZ: number): void {
    this.tick = curr.tick;
    const props = impactsOf(curr)?.props ?? {};
    const ids = Object.keys(props).sort();
    const signature = ids.map((id) => `${id}:${props[id]!.state}:${props[id]!.tick}`).join("|");
    const falling = ids.some((id) => (curr.tick - props[id]!.tick) * TICK_S < FALL_S + 0.1);
    if (signature !== this.signature || falling) {
      const changed = signature !== this.signature;
      this.signature = signature;
      this.knocked = props;
      this.cells.clear();
      for (const id of ids) {
        const p = this.opts.prop(id);
        if (!p || p.kind === "hydrant") continue;
        const key = `${Math.round(p.x)},${Math.round(p.z)}`;
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push({ id, x: p.x, z: p.z, k: props[id]!, height: p.height });
      }
      this.opts.setFoliageOverride(ids.length > 0 ? (x, z, m) => this.pose(x, z, m) : null);
      if (changed || falling) this.rescan = 0;
    }
    this.rescan -= dt;
    if (this.rescan <= 0 && (ids.length > 0 || this.moved.size > 0)) {
      this.rescan = RESCAN_S;
      this.reposeTiles();
    }
    this.drawHydrants(dt, camX, camZ);
  }

  /** The pose of a drawn tree or lamp at (x, z) when it is broken, else null. */
  private pose(x: number, z: number, m: THREE.Matrix4): THREE.Matrix4 | null {
    const l = this.cells.get(`${Math.round(x)},${Math.round(z)}`);
    if (!l) return null;
    const hit = l.find((c) => Math.abs(c.x - x) < MATCH_M && Math.abs(c.z - z) < MATCH_M);
    if (!hit) return null;
    const t = Math.min(1, ((this.tick - hit.k.tick) * TICK_S) / FALL_S);
    // Eased like a fall: slow to start, fast at the end, a small bounce.
    const e = t < 1 ? t * t * t : 1;
    const angle = tiltOf(hit.k) * e;
    const dx = Math.sin(hit.k.dir);
    const dz = -Math.cos(hit.k.dir);
    // Rotating up toward (dx, dz) is a turn about (dz, 0, -dx).
    this.axis.set(dz, 0, -dx).normalize();
    this.q.setFromAxisAngle(this.axis, angle);
    const bx = m.elements[12]!, by = m.elements[13]!, bz = m.elements[14]!;
    this.m1.makeTranslation(-bx, -by, -bz).premultiply(this.m2.makeRotationFromQuaternion(this.q)).premultiply(new THREE.Matrix4().makeTranslation(bx, by, bz));
    return this.m1.clone().multiply(m);
  }

  /** Lamp posts and street trees still drawn by their tiles: re-pose broken ones, restore mended ones. */
  private reposeTiles(): void {
    const seen = new Set<THREE.InstancedMesh>();
    this.scene.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !/^(lamp-poles|lamp-heads|street-trees-[01])$/.test(mesh.name)) return;
      seen.add(mesh);
      const moved = this.moved.get(mesh) ?? new Map<number, THREE.Matrix4>();
      let dirty = false;
      for (let i = 0; i < mesh.count; i++) {
        const original = moved.get(i);
        const current = new THREE.Matrix4();
        mesh.getMatrixAt(i, current);
        const base = original ?? current;
        const posed = this.pose(base.elements[12]!, base.elements[14]!, base);
        if (posed) {
          if (!original) moved.set(i, current);
          mesh.setMatrixAt(i, posed);
          dirty = true;
        } else if (original) {
          mesh.setMatrixAt(i, original);
          moved.delete(i);
          dirty = true;
        }
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
      if (moved.size > 0) this.moved.set(mesh, moved);
      else this.moved.delete(mesh);
    });
    for (const mesh of [...this.moved.keys()]) if (!seen.has(mesh)) this.moved.delete(mesh);
  }

  private drawHydrants(dt: number, camX: number, camZ: number): void {
    let n = 0;
    for (const h of this.opts.hydrants) {
      if (n >= HYDRANTS) break;
      if (Math.abs(h.x - camX) > HYDRANT_RANGE_M || Math.abs(h.z - camZ) > HYDRANT_RANGE_M) continue;
      const y = this.opts.ground(h.x, h.z);
      const k = this.knocked[h.id];
      this.tmp.position.set(h.x, y, h.z);
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.set(1, 1, 1);
      if (k) {
        // Knocked off its base: lying a little way off, the water pipe gushing.
        const t = Math.min(1, ((this.tick - k.tick) * TICK_S) / 0.5);
        const dx = Math.sin(k.dir), dz = -Math.cos(k.dir);
        this.tmp.position.set(h.x + dx * 0.9 * t, y, h.z + dz * 0.9 * t);
        this.axis.set(dz, 0, -dx).normalize();
        this.tmp.quaternion.setFromAxisAngle(this.axis, 1.4 * t);
        if (this.water.length < GEYSER) {
          for (let j = 0; j < 4; j++) {
            const a = (++this.puff * 2.399) % (Math.PI * 2);
            this.water.push({ x: h.x, y: y + 0.2, z: h.z, vx: Math.cos(a) * 0.7, vy: 7.5 + (this.puff % 7) * 0.25, vz: Math.sin(a) * 0.7, age: 0 });
          }
        }
      }
      this.tmp.updateMatrix();
      this.hydrants.setMatrixAt(n++, this.tmp.matrix);
    }
    this.hydrants.count = n;
    this.hydrants.instanceMatrix.needsUpdate = true;
    let w = 0;
    for (const p of this.water) {
      p.age += dt;
      p.vy -= 9.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.age > 1.8 || p.y < this.opts.ground(p.x, p.z) - 0.1) continue;
      this.water[w++] = p;
    }
    this.water.length = w;
    for (let i = 0; i < w; i++) {
      this.geyserPos[i * 3] = this.water[i]!.x; this.geyserPos[i * 3 + 1] = this.water[i]!.y; this.geyserPos[i * 3 + 2] = this.water[i]!.z;
    }
    this.geyserGeo.setDrawRange(0, w);
    (this.geyserGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.opts.setFoliageOverride(null);
    this.hydrants.geometry.dispose();
    (this.hydrants.material as THREE.Material).dispose();
    this.geyserGeo.dispose();
    this.root.removeFromParent();
  }
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => g.index ? g.toNonIndexed() : g);
  const count = flat.reduce((n, g) => n + g.getAttribute("position").count, 0);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.getAttribute("position").array as Float32Array, o * 3);
    nor.set(g.getAttribute("normal").array as Float32Array, o * 3);
    o += g.getAttribute("position").count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return out;
}
