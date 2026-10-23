import * as THREE from "three";
import { AGENTS_EXT_KEY, type AgentsExt } from "../sim/agents.ts";
import { CAR } from "../sim/car.ts";
import { ROBOTAXI_BODY } from "../sim/agents.ts";
import type { SimState } from "../sim/contract.ts";
import { impactsOf, type Dents, type ImpactEvent } from "../sim/impacts.ts";

// Impact presentation (src/sim/impacts.ts): a burst of sparks at every hit (more for a harder
// one), smoke from a battered car's bonnet, and dark crumple scuffs on each dented side of the
// players' cars and the robotaxis near the camera. Pooled and bounded; everything that decides
// where a hit was or how dented a body is comes from the sim snapshot. Sparks and smoke are
// cosmetic and live only here (seeded from the event id, never from the clock or Math.random).

const SPARKS = 384;
const SMOKE = 160;
const SCUFFS = 192;
const SPARK_LIFE_S = 0.55;
const SMOKE_LIFE_S = 1.6;
/** Robotaxis farther than this from the camera get no scuffs drawn. */
const SCUFF_RANGE_M = 90;
/** A car below this condition smokes, more as it drops. */
const SMOKE_BELOW = 45;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
}

/** A small deterministic hash -> [0, 1). */
function rand(seed: number, k: number): number {
  let h = (seed * 374761393 + k * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class ImpactLayer {
  readonly root = new THREE.Group();
  private readonly sparks: Particle[] = [];
  private readonly smoke: Particle[] = [];
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly smokeGeo = new THREE.BufferGeometry();
  private readonly sparkPos = new Float32Array(SPARKS * 3);
  private readonly smokePos = new Float32Array(SMOKE * 3);
  private readonly scuffs: THREE.InstancedMesh;
  private readonly tmp = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private lastEvent = 0;
  private smokeClock = 0;
  private puff = 0;
  /** Sparks burst so far (for tests and the debug handle). */
  bursts = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = "impacts";
    this.sparkGeo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute("position", new THREE.BufferAttribute(this.smokePos, 3).setUsage(THREE.DynamicDrawUsage));
    const sparkPoints = new THREE.Points(this.sparkGeo, new THREE.PointsMaterial({ color: 0xffc46b, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    const smokePoints = new THREE.Points(this.smokeGeo, new THREE.PointsMaterial({ color: 0x5a5753, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.45, depthWrite: false }));
    sparkPoints.name = "impact-sparks";
    smokePoints.name = "impact-smoke";
    for (const p of [sparkPoints, smokePoints]) p.frustumCulled = false;
    this.scuffs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.2 }), SCUFFS);
    this.scuffs.name = "impact-scuffs";
    this.scuffs.count = 0;
    this.scuffs.frustumCulled = false;
    this.scuffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(sparkPoints, smokePoints, this.scuffs);
    scene.add(this.root);
  }

  /** Per frame: new hits burst into sparks; damaged bodies smoke and show their dents. */
  update(prev: SimState, curr: SimState, alpha: number, dt: number, camX: number, camZ: number): void {
    const imp = impactsOf(curr);
    for (const e of imp?.events ?? []) {
      if (e.id <= this.lastEvent) continue;
      this.lastEvent = e.id;
      this.burst(e);
    }
    // A save loaded with older events, or a reset: never replay them.
    if (imp && imp.nextId - 1 < this.lastEvent) this.lastEvent = imp.nextId - 1;
    this.advance(this.sparks, dt, -9.8, 0.4);
    this.advance(this.smoke, dt, 0.9, 1.2);

    let n = 0;
    const lerp = (a: number, b: number): number => a + (b - a) * alpha;
    this.smokeClock += dt;
    const emit = this.smokeClock >= 0.08;
    if (emit) this.smokeClock = 0;
    for (const id of Object.keys(curr.players).sort()) {
      const c = curr.players[id]!.car;
      const p = prev.players[id]?.car ?? c;
      const x = lerp(p.x, c.x), y = lerp(p.y, c.y), z = lerp(p.z, c.z), h = c.heading;
      const d = imp?.cars[id];
      if (!d) continue;
      n = this.scuffBody(n, x, y, z, h, CAR.halfLength, CAR.halfWidth, CAR.bodyHeight * 0.7, d);
      if (emit && d.condition < SMOKE_BELOW && rand(++this.puff, 1) < 0.35 + (SMOKE_BELOW - d.condition) / SMOKE_BELOW) {
        this.spawn(this.smoke, SMOKE, x + Math.sin(h) * (CAR.halfLength - 0.6), y + 1.1, z - Math.cos(h) * (CAR.halfLength - 0.6), 0.3 * (rand(this.puff, 2) - 0.5), 0.8, 0.3 * (rand(this.puff, 3) - 0.5), SMOKE_LIFE_S);
      }
    }
    const agents = (curr.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
    for (const a of agents) {
      if (!a.dents || n >= SCUFFS) continue;
      if ((a.x - camX) * (a.x - camX) + (a.z - camZ) * (a.z - camZ) > SCUFF_RANGE_M * SCUFF_RANGE_M) continue;
      n = this.scuffBody(n, a.x, a.y, a.z, a.heading, a.halfLength ?? ROBOTAXI_BODY.halfLength, a.halfWidth ?? ROBOTAXI_BODY.halfWidth, (a.height ?? ROBOTAXI_BODY.height) * 0.65, a.dents);
    }
    this.scuffs.count = n;
    this.scuffs.instanceMatrix.needsUpdate = true;
    if (this.scuffs.instanceColor) this.scuffs.instanceColor.needsUpdate = true;
    this.write(this.sparks, this.sparkPos, this.sparkGeo);
    this.write(this.smoke, this.smokePos, this.smokeGeo);
  }

  /** Sparks alive now (for tests). */
  sparkCount(): number {
    return this.sparks.length;
  }

  private burst(e: ImpactEvent): void {
    this.bursts++;
    const count = Math.min(48, 6 + Math.round(e.dv * 4));
    for (let k = 0; k < count; k++) {
      const a = rand(e.id, k * 3) * Math.PI * 2;
      const up = 1.5 + rand(e.id, k * 3 + 1) * 3.5;
      const out = (1 + rand(e.id, k * 3 + 2) * 3) * Math.min(2, 0.4 + e.dv / 6);
      this.spawn(this.sparks, SPARKS, e.x, e.y + 0.5, e.z, Math.cos(a) * out, up, Math.sin(a) * out, SPARK_LIFE_S * (0.6 + 0.8 * rand(e.id, k + 99)));
    }
  }

  private spawn(list: Particle[], cap: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    if (list.length >= cap) list.shift();
    list.push({ x, y, z, vx, vy, vz, age: 0, life });
  }

  private advance(list: Particle[], dt: number, gravity: number, drag: number): void {
    let w = 0;
    for (const p of list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += gravity * dt;
      const k = Math.max(0, 1 - drag * dt);
      p.vx *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      list[w++] = p;
    }
    list.length = w;
  }

  private write(list: readonly Particle[], buf: Float32Array, geo: THREE.BufferGeometry): void {
    for (let i = 0; i < list.length; i++) {
      buf[i * 3] = list[i]!.x; buf[i * 3 + 1] = list[i]!.y; buf[i * 3 + 2] = list[i]!.z;
    }
    geo.setDrawRange(0, list.length);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Crumple scuffs on the dented sides of one body: dark, a little proud of the panel, bigger for a deeper dent. */
  private scuffBody(n: number, x: number, y: number, z: number, heading: number, hl: number, hw: number, midY: number, d: Readonly<Dents>): number {
    const sides: Array<[number, number, number]> = [[d.front, 1, 0], [d.rear, -1, 0], [d.right, 0, 1], [d.left, 0, -1]];
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    for (const [amount, f, r] of sides) {
      if (amount < 0.05 || n >= SCUFFS) continue;
      const ox = f * (hl + 0.01) , or = r * (hw + 0.01);
      const lx = fx * ox - fz * or, lz = fz * ox + fx * or;
      this.tmp.position.set(x + lx, y + midY * (f !== 0 ? 0.75 : 1), z + lz);
      this.tmp.rotation.set(0, -heading, 0);
      const span = 0.5 + amount * (f !== 0 ? 1.4 * hw : 1.6 * hl * 0.6);
      this.tmp.scale.set(f !== 0 ? span : 0.04, 0.25 + amount * 0.45, f !== 0 ? 0.04 : span);
      this.tmp.updateMatrix();
      this.scuffs.setMatrixAt(n, this.tmp.matrix);
      this.color.setRGB(0.32 - amount * 0.22, 0.31 - amount * 0.22, 0.3 - amount * 0.21);
      this.scuffs.setColorAt(n, this.color);
      n++;
    }
    return n;
  }

  dispose(): void {
    this.sparkGeo.dispose();
    this.smokeGeo.dispose();
    this.scuffs.geometry.dispose();
    (this.scuffs.material as THREE.Material).dispose();
    for (const c of this.root.children) if (c instanceof THREE.Points) (c.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
