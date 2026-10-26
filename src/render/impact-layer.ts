import * as THREE from "three";
import { AGENTS_EXT_KEY, type AgentsExt } from "../sim/agents.ts";
import { CAR } from "../sim/car.ts";
import { ROBOTAXI_BODY } from "../sim/agents.ts";
import type { SimState } from "../sim/contract.ts";
import { impactsOf, type Dents, type ImpactEvent } from "../sim/impacts.ts";
import { createPortablePoints, type PortablePoints } from "./portable-points.ts";

// Impact presentation (src/sim/impacts.ts): a burst of sparks at every hit (more for a harder
// one), smoke from a battered car's bonnet, dark crumple scuffs on each dented side of the
// players' cars and the robotaxis near the camera, and a disabled robot fizzing where it lies
// (a knocked robot topples by its pitch, which the agent layer draws). Pooled and bounded;
// everything that decides where a hit was or how dented a body is comes from the sim snapshot.
// Sparks and smoke are cosmetic and live only here (seeded from the event id, never from the
// clock or Math.random).

const SPARKS = 384;
const SMOKE = 160;
const SCUFFS = 192;
const SPARK_LIFE_S = 0.55;
const SMOKE_LIFE_S = 1.6;
/** Robotaxis farther than this from the camera get no scuffs drawn. */
const SCUFF_RANGE_M = 90;
/** A car below this condition smokes, more as it drops. */
const SMOKE_BELOW = 45;

/** Borrow the exact displayed frame after the vehicle renderer has updated. */
export interface ImpactVehicleFrames {
  player(id: string, matrix: THREE.Matrix4, bounds: THREE.Box3): boolean;
  agent(id: number, matrix: THREE.Matrix4, bounds: THREE.Box3): boolean;
}

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
  private readonly sparkDraw: PortablePoints;
  private readonly smokeDraw: PortablePoints;
  private readonly scuffs: THREE.InstancedMesh;
  private readonly tmp = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly vehicleMatrix = new THREE.Matrix4();
  private readonly vehicleBounds = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly rotation = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly frames?: ImpactVehicleFrames;
  private lastEvent = 0;
  private smokeClock = 0;
  private puff = 0;
  /** Sparks burst so far (for tests and the debug handle). */
  bursts = 0;

  constructor(scene: THREE.Scene, frames?: ImpactVehicleFrames) {
    this.frames = frames;
    this.root.name = "impacts";
    this.sparkGeo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute("position", new THREE.BufferAttribute(this.smokePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkDraw = createPortablePoints(this.sparkGeo, { color: 0xffc46b, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.smokeDraw = createPortablePoints(this.smokeGeo, { color: 0x5a5753, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.45, depthWrite: false });
    const sparkPoints = this.sparkDraw.object, smokePoints = this.smokeDraw.object;
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
      if (this.frames) {
        if (!this.frames.player(id, this.vehicleMatrix, this.vehicleBounds)) continue;
      } else this.fallbackFrame(x, y, z, h, CAR.halfLength, CAR.halfWidth, CAR.bodyHeight);
      n = this.scuffBody(n, d);
      if (emit && d.condition < SMOKE_BELOW && rand(++this.puff, 1) < 0.35 + (SMOKE_BELOW - d.condition) / SMOKE_BELOW) {
        this.point.set(0, 1.1, this.vehicleBounds.min.z + .6).applyMatrix4(this.vehicleMatrix);
        this.spawn(this.smoke, SMOKE, this.point.x, this.point.y, this.point.z, 0.3 * (rand(this.puff, 2) - 0.5), 0.8, 0.3 * (rand(this.puff, 3) - 0.5), SMOKE_LIFE_S);
      }
    }
    const agents = (curr.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
    for (const a of agents) {
      if (!a.dents || n >= SCUFFS) continue;
      if ((a.x - camX) * (a.x - camX) + (a.z - camZ) * (a.z - camZ) > SCUFF_RANGE_M * SCUFF_RANGE_M) continue;
      if (a.kind !== "robotaxi") {
        // A robot knocked out (impacts.ts ROBOT.disableDv) fizzes while it lies there; it topples by its pitch (agent layer).
        if (a.knock?.disabled && emit && rand(++this.puff, 5) < 0.4) {
          for (let k = 0; k < 3; k++) this.spawn(this.sparks, SPARKS, a.x, a.y + 0.4, a.z, 1.5 * (rand(this.puff, 10 + k) - 0.5), 1.5 + rand(this.puff, 20 + k), 1.5 * (rand(this.puff, 30 + k) - 0.5), SPARK_LIFE_S * 0.7);
        }
        continue;
      }
      if (this.frames) {
        if (!this.frames.agent(a.id, this.vehicleMatrix, this.vehicleBounds)) continue;
      } else this.fallbackFrame(a.x, a.y, a.z, a.heading, a.halfLength ?? ROBOTAXI_BODY.halfLength, a.halfWidth ?? ROBOTAXI_BODY.halfWidth, a.height ?? ROBOTAXI_BODY.height);
      n = this.scuffBody(n, a.dents);
    }
    this.scuffs.count = n;
    this.scuffs.instanceMatrix.needsUpdate = true;
    if (this.scuffs.instanceColor) this.scuffs.instanceColor.needsUpdate = true;
    this.write(this.sparks, this.sparkPos, this.sparkGeo);
    this.write(this.smoke, this.smokePos, this.smokeGeo);
    this.sparkDraw.sync(); this.smokeDraw.sync();
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

  /** Snapshot-only callers may omit frames; game rendering always provides the displayed body. */
  private fallbackFrame(x: number, y: number, z: number, heading: number, hl: number, hw: number, height: number): void {
    this.vehicleMatrix.compose(this.point.set(x, y, z), this.quaternion.setFromEuler(this.rotation.set(0, -heading, 0)), this.unit);
    this.vehicleBounds.min.set(-hw, 0, -hl); this.vehicleBounds.max.set(hw, height, hl);
  }

  /** Small scuffs stay in the displayed model's frame, including pitch, roll and fit scale. */
  private scuffBody(n: number, d: Readonly<Dents>): number {
    const sides: Array<[number, number, number]> = [[d.front, 1, 0], [d.rear, -1, 0], [d.right, 0, 1], [d.left, 0, -1]];
    const b = this.vehicleBounds, width = b.max.x - b.min.x, length = b.max.z - b.min.z, height = b.max.y - b.min.y;
    for (const [amount, f, r] of sides) {
      if (amount < 0.05 || n >= SCUFFS) continue;
      this.tmp.position.set(r ? r > 0 ? b.max.x : b.min.x : (b.min.x + b.max.x) / 2,
        b.min.y + height * (f ? .35 : .42), f ? f > 0 ? b.min.z : b.max.z : (b.min.z + b.max.z) / 2);
      this.tmp.rotation.set(0, 0, 0);
      const span = Math.min((f ? width : length) * .7, .4 + amount * (f ? width * .7 : length * .48));
      this.tmp.scale.set(f ? span : .02, Math.min(height * .32, .15 + amount * .3), f ? .02 : span);
      this.tmp.updateMatrix();
      this.tmp.matrix.premultiply(this.vehicleMatrix);
      this.scuffs.setMatrixAt(n, this.tmp.matrix);
      this.color.setRGB(0.32 - amount * 0.22, 0.31 - amount * 0.22, 0.3 - amount * 0.21);
      this.scuffs.setColorAt(n, this.color);
      n++;
    }
    return n;
  }

  dispose(): void {
    this.sparkDraw.dispose(); this.smokeDraw.dispose();
    this.sparkGeo.dispose();
    this.smokeGeo.dispose();
    this.scuffs.geometry.dispose();
    (this.scuffs.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
