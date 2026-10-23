// Cameras: smoothed chase (with ground clamp and a pull-in when a building is in the way),
// first-person (driver's eye or pedestrian eye height), and a free debug fly camera for
// screenshots. No allocation per frame: everything works on scratch vectors.

import * as THREE from "three";
import type { GroundFn } from "./types.ts";

export type CameraMode = "chase" | "first-person" | "fly";

export interface CameraTarget {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  onFoot: boolean;
  /** Explicit recorded weapon aim, when the player controls the view. */
  lookYaw?:number;
  lookPitch?:number;
}

export interface FlyInput {
  forward: number;
  right: number;
  up: number;
  /** Radians to add this frame. */
  yaw: number;
  pitch: number;
  boost: boolean;
}

export const NO_FLY_INPUT: Readonly<FlyInput> = Object.freeze({ forward: 0, right: 0, up: 0, yaw: 0, pitch: 0, boost: false });

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** Fractions of the chase arm tried, longest first, when the camera would sit in a building. */
const PULL_IN = [0.8, 0.62, 0.45, 0.3, 0.18] as const;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = "chase";
  /** The mode to return to when leaving fly. */
  private ground: GroundFn;
  private occluded: (x: number, y: number, z: number) => boolean;
  private beforeFly: Exclude<CameraMode, "fly"> = "chase";
  private pos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private init = false;
  readonly fly = { x: 0, y: 30, z: 0, yaw: 0, pitch: -0.2, speed: 45 };

  constructor(camera: THREE.PerspectiveCamera, ground: GroundFn, occluded: (x: number, y: number, z: number) => boolean = () => false) {
    this.camera = camera;
    this.ground = ground;
    this.occluded = occluded;
  }

  /** KeyC: chase <-> first-person (from fly, back to chase). */
  cycle(): void {
    if (this.mode === "fly") this.mode = "chase";
    else this.mode = this.mode === "chase" ? "first-person" : "chase";
    this.init = false;
  }

  /** KeyV: into the fly camera from the current view, or back out of it. */
  toggleFly(): void {
    if (this.mode === "fly") {
      this.mode = this.beforeFly;
      this.init = false;
      return;
    }
    this.beforeFly = this.mode;
    this.camera.getWorldDirection(_dir);
    this.fly.x = this.camera.position.x;
    this.fly.y = this.camera.position.y;
    this.fly.z = this.camera.position.z;
    this.fly.yaw = Math.atan2(_dir.x, -_dir.z);
    this.fly.pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
    this.mode = "fly";
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    if (m === "fly") this.toggleFly();
    else {
      this.mode = m;
      this.init = false;
    }
  }

  setFlyPose(x: number, y: number, z: number, yawRad: number, pitchRad: number): void {
    if (this.mode !== "fly") this.toggleFly();
    this.fly.x = x;
    this.fly.y = y;
    this.fly.z = z;
    this.fly.yaw = yawRad;
    this.fly.pitch = Math.max(-1.55, Math.min(1.55, pitchRad));
  }

  /** Compass bearing the camera looks along (radians, clockwise from north). */
  viewHeading(): number {
    this.camera.getWorldDirection(_dir);
    return Math.atan2(_dir.x, -_dir.z);
  }

  update(dt: number, t: CameraTarget, input: Readonly<FlyInput>): void {
    const fx = Math.sin(t.heading);
    const fz = -Math.cos(t.heading);
    const aiming=Number.isFinite(t.lookYaw)&&Number.isFinite(t.lookPitch);
    const yaw=aiming?t.lookYaw!:t.heading,pitch=aiming?t.lookPitch!:0;
    const lx=Math.sin(yaw),lz=-Math.cos(yaw),cp=Math.cos(pitch),sy=Math.sin(pitch);
    if (this.mode === "fly") {
      const f = this.fly;
      f.yaw += input.yaw;
      f.pitch = Math.max(-1.55, Math.min(1.55, f.pitch + input.pitch));
      const cp = Math.cos(f.pitch);
      const dx = Math.sin(f.yaw) * cp;
      const dy = Math.sin(f.pitch);
      const dz = -Math.cos(f.yaw) * cp;
      const v = f.speed * (input.boost ? 4 : 1) * dt;
      // Move along the view (forward), the horizontal right vector, and world up.
      const rx = Math.cos(f.yaw);
      const rz = Math.sin(f.yaw);
      f.x += (dx * input.forward + rx * input.right) * v;
      f.y += (dy * input.forward + input.up) * v;
      f.z += (dz * input.forward + rz * input.right) * v;
      f.y = Math.max(f.y, this.ground(f.x, f.z) + 0.5);
      this.camera.position.set(f.x, f.y, f.z);
      this.camera.lookAt(f.x + dx, f.y + dy, f.z + dz);
      this.init = false;
      return;
    }
    if (this.mode === "first-person") {
      if (t.onFoot) {
        this.camera.position.set(t.x + fx * 0.12, t.y + 1.62, t.z + fz * 0.12);
        this.camera.lookAt(t.x + fx * 20, t.y + 1.3, t.z + fz * 20);
      } else {
        // Driver's eye: left seat, behind the windscreen.
        const rx = -fz;
        const rz = fx;
        this.camera.position.set(t.x - rx * 0.36 + fx * 0.1, t.y + 1.3, t.z - rz * 0.36 + fz * 0.1);
        this.camera.lookAt(this.camera.position.x + fx * 30, t.y + 0.4, this.camera.position.z + fz * 30);
      }
      if(aiming)this.camera.lookAt(this.camera.position.x+lx*cp*30,this.camera.position.y+sy*30,this.camera.position.z+lz*cp*30);
      this.init = false;
      return;
    }
    // Chase.
    const speed = Math.abs(t.speed);
    const dist = t.onFoot ? 4.4 : 8.2 + Math.min(speed, 30) * 0.09;
    const height = t.onFoot ? 2.0 : 3.1 + Math.min(speed, 30) * 0.02;
    _desired.set(t.x - lx * dist, t.y + height - (aiming?sy*dist:0), t.z - lz * dist);
    // Pull in towards the target when the arm would end inside a building.
    if (this.occluded(_desired.x, _desired.y, _desired.z)) {
      for (const k of PULL_IN) {
        const x = t.x - lx * dist * k;
        const z = t.z - lz * dist * k;
        const y = t.y + height * (0.6 + 0.4 * k);
        _desired.set(x, y, z);
        if (!this.occluded(x, y, z)) break;
      }
    }
    if(aiming)_look.set(t.x+lx*cp*30,t.y+1.2+sy*30,t.z+lz*cp*30);
    else _look.set(t.x + fx * 5, t.y + (t.onFoot ? 1.4 : 1.25), t.z + fz * 5);
    if (!this.init) {
      this.pos.copy(_desired);
      this.lookAt.copy(_look);
      this.init = true;
    } else {
      this.pos.lerp(_desired, 1 - Math.exp(-dt * 5.5));
      this.lookAt.lerp(_look, 1 - Math.exp(-dt * 12));
    }
    const minY = this.ground(this.pos.x, this.pos.z) + 1.0;
    if (this.pos.y < minY) this.pos.y = minY;
    this.camera.position.copy(this.pos);
    // Position may ease or be clamped by terrain; the visible aiming ray must still
    // match this tick's recorded weapon angles, including an abrupt turn.
    if(aiming)this.camera.lookAt(this.pos.x+lx*cp*30,this.pos.y+sy*30,this.pos.z+lz*cp*30);
    else this.camera.lookAt(this.lookAt);
  }
}
