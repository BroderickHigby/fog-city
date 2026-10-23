// The water blaster in the player's hands (render-only): the toy garden sprayer from
// models/water-blaster.glb, its tank on the back and its wand in the right hand, shown while the
// player sprays and for a moment after. While spraying the right arm is posed toward the stream
// (a two-bone aim over the walk/idle clip), the wand points where the water goes and kicks back
// a little with each shot, and the stream starts at the nozzle (nozzle()).
//
// The sim decides where water goes; this only follows it. The prop is a plain toy (assets/blender
// README: no firearm shapes or words), carried like a garden sprayer.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const BLASTER_FILE = "models/water-blaster.glb";
/** The wand stays out this long after the player's last water has landed (seconds). */
export const BLASTER_HOLD_S = 1.5;
/** How far a shot kicks the wand back along the stream (metres), and how fast it settles (1/s). */
export const KICK_M = 0.045;
const KICK_RATE = 18;

/** What one player is doing with the blaster this frame: the stream's direction (unit, world), and whether a shot left on this frame. */
export interface SprayCue {
  dirX: number;
  dirY: number;
  dirZ: number;
  shot: boolean;
}

interface Held {
  tank: THREE.Object3D;
  wand: THREE.Object3D;
  nozzle: THREE.Object3D;
  sinceShotS: number;
  kick: number;
  dir: THREE.Vector3;
  seen: boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _want = new THREE.Vector3();
const _have = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _forward = new THREE.Vector3(0, 0, -1);

/** Turn `bone` (world space) so the direction to `child` becomes `want`, keeping its parent. */
function aimBone(bone: THREE.Object3D, child: THREE.Object3D, want: THREE.Vector3): void {
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  _have.subVectors(_b, _a);
  if (_have.lengthSq() < 1e-10) return;
  _have.normalize();
  _q.setFromUnitVectors(_have, want);
  bone.getWorldQuaternion(_wq);
  _wq.premultiply(_q);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_pq);
    bone.quaternion.copy(_pq.invert().multiply(_wq));
  } else bone.quaternion.copy(_wq);
  bone.updateMatrixWorld(true);
}

/** The right arm's bones in a Rocketbox (Bip01) rig, or null. */
function rightArm(root: THREE.Object3D): { upper: THREE.Object3D; fore: THREE.Object3D; hand: THREE.Object3D } | null {
  const upper = root.getObjectByName("Bip01_R_UpperArm");
  const fore = root.getObjectByName("Bip01_R_Forearm");
  const hand = root.getObjectByName("Bip01_R_Hand");
  return upper && fore && hand ? { upper, fore, hand } : null;
}

export class HeldBlasters {
  private readonly prototype: THREE.Object3D;
  private readonly held = new Map<string, Held>();

  private constructor(prototype: THREE.Object3D) {
    this.prototype = prototype;
  }

  static async load(bytes: (path: string) => Promise<Uint8Array>): Promise<HeldBlasters> {
    const buffer = await bytes(BLASTER_FILE);
    const gltf = await new GLTFLoader().parseAsync(buffer.slice().buffer as ArrayBuffer, "");
    if (!gltf.scene.getObjectByName("tank") || !gltf.scene.getObjectByName("wand")?.getObjectByName("nozzle")) {
      throw new Error(`${BLASTER_FILE} has no tank, wand or nozzle`);
    }
    return new HeldBlasters(gltf.scene);
  }

  private holder(id: string, body: THREE.Object3D, shadows: boolean): Held {
    let h = this.held.get(id);
    if (h && h.tank.parent === body) return h;
    const copy = this.prototype.clone(true);
    const tank = copy.getObjectByName("tank")!;
    const wand = copy.getObjectByName("wand")!;
    const nozzle = wand.getObjectByName("nozzle")!;
    // The hose was laid out for a fixed grip; with the wand following the hand it is left out.
    for (const o of [tank, wand]) {
      o.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = shadows; m.receiveShadow = shadows; } });
      body.add(o); // body space: the tank keeps its authored place on the back
    }
    h = { tank, wand, nozzle, sinceShotS: Infinity, kick: 0, dir: new THREE.Vector3(0, 0, -1), seen: false };
    this.held.set(id, h);
    return h;
  }

  /**
   * After the body's clip has posed it this frame: show or hide the blaster, aim the arm and the
   * wand down the stream. `spray` is null when the player has not just fired.
   */
  pose(id: string, body: THREE.Object3D, spray: SprayCue | null, dt: number, shadows = false): void {
    const h = this.holder(id, body, shadows);
    h.seen = true;
    if (spray) {
      h.dir.set(spray.dirX, spray.dirY, spray.dirZ);
      if (h.dir.lengthSq() < 1e-8) h.dir.set(0, 0, -1).applyQuaternion(body.getWorldQuaternion(_wq));
      h.dir.normalize();
      // Out while the player's water is in the air, and BLASTER_HOLD_S after the last of it.
      h.sinceShotS = 0;
      if (spray.shot) h.kick = 1;
    } else h.sinceShotS += Math.max(0, dt);
    h.kick *= Math.exp(-KICK_RATE * Math.max(0, dt));
    const out = h.sinceShotS < BLASTER_HOLD_S;
    h.tank.visible = out;
    h.wand.visible = out;
    if (!out) return;
    body.updateMatrixWorld(true);
    const arm = rightArm(body);
    // Upper arm forward and down, forearm along the stream: held at the hip like a garden sprayer.
    if (arm) {
      _want.copy(h.dir).multiplyScalar(0.55).add(_a.set(0, -0.85, 0)).normalize();
      aimBone(arm.upper, arm.fore, _want);
      aimBone(arm.fore, arm.hand, h.dir);
      arm.hand.getWorldPosition(_b);
    } else {
      body.getWorldPosition(_b).y += 1.05;
    }
    // The wand's grip at the hand, its -Z along the stream, kicked back after a shot.
    _b.addScaledVector(h.dir, -KICK_M * h.kick);
    _wq.setFromUnitVectors(_forward, h.dir);
    _m.compose(_b, _wq, _a.set(1, 1, 1)).premultiply(_inv.copy(body.matrixWorld).invert());
    _m.decompose(h.wand.position, h.wand.quaternion, h.wand.scale);
    h.wand.updateMatrixWorld(true);
  }

  /** Where player `id`'s stream leaves the nozzle (world), or null when the blaster is put away. */
  nozzle(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const h = this.held.get(id);
    if (!h || !h.wand.visible) return null;
    return h.nozzle.getWorldPosition(out);
  }

  /** Per frame before posing; after, end() drops the blasters of players no longer drawn. */
  begin(): void {
    for (const h of this.held.values()) h.seen = false;
  }

  end(): void {
    for (const [id, h] of this.held) {
      if (h.seen) continue;
      h.tank.removeFromParent();
      h.wand.removeFromParent();
      this.held.delete(id);
    }
  }

  dispose(): void {
    for (const h of this.held.values()) { h.tank.removeFromParent(); h.wand.removeFromParent(); }
    this.held.clear();
    this.prototype.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
  }
}

/**
 * Each player's spray this frame from the sim's water projectiles: the newest shot's direction,
 * and a shot flag the first frame a projectile is seen (so a kick plays once per shot, however
 * many frames fall between two sim ticks).
 */
export class SprayTracker {
  private seen = new Set<number>();

  update(projectiles: readonly { id: number; kind: string; ownerId: string; vx: number; vy: number; vz: number; bornTick: number }[] | undefined): Map<string, SprayCue> {
    const out = new Map<string, SprayCue & { born: number }>();
    const now = new Set<number>();
    for (const p of projectiles ?? []) {
      if (p.kind !== "water") continue;
      now.add(p.id);
      const len = Math.hypot(p.vx, p.vy, p.vz) || 1;
      const fresh = !this.seen.has(p.id);
      const had = out.get(p.ownerId);
      if (!had || p.bornTick >= had.born) out.set(p.ownerId, { dirX: p.vx / len, dirY: p.vy / len, dirZ: p.vz / len, shot: fresh || (had?.shot ?? false), born: p.bornTick });
      else if (fresh) had.shot = true;
    }
    this.seen = now;
    return out;
  }
}
