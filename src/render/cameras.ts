// Cameras: smoothed chase (with ground clamp and a pull-in when a building is in the way, and
// a player orbit: drag the mouse, drag a finger on the view or push the pad's right stick to
// swing the camera round the player or car; it eases back behind them once they move on),
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
  /** Occupied ambient taxi; the player's own parked car stays visible. */
  robotaxiId?: number;
  /** The car's pitch on a hill, radians, + = nose up (0 or absent on foot). */
  pitch?: number;
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
/**
 * The chase arm never pulls in closer than this to the target (metres): a car's half-length plus
 * a margin, so a building behind never puts the camera in the car; on foot, a step behind.
 */
const MIN_ARM_CAR_M = 3.6;
const MIN_ARM_FOOT_M = 1.2;
/** A car's body as the camera keeps clear of it: half-length, half-width, roof height, metres. */
const CAR_BODY = { hl: 2.2, hw: 0.95, top: 1.5 } as const;
/** How far the camera keeps off the car's body (near plane and a little more), metres. */
const BODY_CLEAR_M = 0.6;
/** How much of a hill's slope the arm follows: lower behind a car climbing, higher behind one descending. */
const SLOPE_FOLLOW = 0.6;
/** Chase orbit: how far the camera may tip above / below its usual elevation, radians. */
export const ORBIT_PITCH_UP = 1.0;
export const ORBIT_PITCH_DOWN = -0.3;
/** Seconds without orbit input, while the target moves, before the camera swings back behind it. */
export const ORBIT_RETURN_DELAY_S = 1.2;
/** Above this speed (m/s) the target counts as moving for the swing back. */
export const ORBIT_RETURN_SPEED = 0.8;

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
  private targetX = Number.NaN;
  private targetZ = Number.NaN;
  private targetOnFoot = false;
  private targetTaxi: number | undefined;
  /** Chase orbit offsets (render only): yaw from behind the target and pitch above the usual arm, radians. */
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitIdle = Infinity;
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

  /**
   * Swing the chase camera round its target: + yaw turns the view clockwise (to the right),
   * + pitch raises the camera to look down more. Ignored outside the chase camera.
   */
  orbit(dyaw: number, dpitch: number): void {
    if (this.mode !== "chase" || (!dyaw && !dpitch) || !Number.isFinite(dyaw) || !Number.isFinite(dpitch)) return;
    this.orbitYaw = Math.atan2(Math.sin(this.orbitYaw + dyaw), Math.cos(this.orbitYaw + dyaw));
    this.orbitPitch = Math.max(ORBIT_PITCH_DOWN, Math.min(ORBIT_PITCH_UP, this.orbitPitch + dpitch));
    this.orbitIdle = 0;
  }

  /** The current chase orbit offsets, radians (for tests and debugging). */
  orbitOffset(): { yaw: number; pitch: number } {
    return { yaw: this.orbitYaw, pitch: this.orbitPitch };
  }

  /** Compass bearing the camera looks along (radians, clockwise from north). */
  viewHeading(): number {
    this.camera.getWorldDirection(_dir);
    return Math.atan2(_dir.x, -_dir.z);
  }

  update(dt: number, t: CameraTarget, input: Readonly<FlyInput>): void {
    const fx = Math.sin(t.heading);
    const fz = -Math.cos(t.heading);
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
      this.init = false;
      return;
    }
    // Chase.
    const speed = Math.abs(t.speed);
    // The orbit swings back behind a moving target once the player stops steering the camera.
    this.orbitIdle += dt;
    if (this.orbitIdle > ORBIT_RETURN_DELAY_S && speed > ORBIT_RETURN_SPEED) {
      const k = Math.exp(-dt * 2.5);
      this.orbitYaw *= k;
      this.orbitPitch *= k;
      if (Math.abs(this.orbitYaw) < 1e-4) this.orbitYaw = 0;
      if (Math.abs(this.orbitPitch) < 1e-4) this.orbitPitch = 0;
    }
    const ox = Math.sin(t.heading + this.orbitYaw);
    const oz = -Math.cos(t.heading + this.orbitYaw);
    const dist0 = t.onFoot ? 4.4 : 8.2 + Math.min(speed, 30) * 0.09;
    const height0 = t.onFoot ? 2.0 : 3.1 + Math.min(speed, 30) * 0.02;
    // Tip the arm about the target, keeping its length.
    const arm = Math.hypot(dist0, height0);
    const elevation = Math.atan2(height0, dist0) + this.orbitPitch;
    const dist = arm * Math.cos(elevation);
    // Follow the hill: the ground behind a climbing car is lower, behind a descending one higher.
    const slope = t.onFoot ? 0 : Math.tan(Math.max(-0.6, Math.min(0.6, t.pitch ?? 0))) * Math.cos(this.orbitYaw);
    const height = arm * Math.sin(elevation) - dist * slope * SLOPE_FOLLOW;
    _desired.set(t.x - ox * dist, t.y + height, t.z - oz * dist);
    // Pull in towards the target when the arm would end inside a building, but never into the
    // body: when even the shortest arm is blocked, rise above the target instead.
    if (this.occluded(_desired.x, _desired.y, _desired.z)) {
      const minK = Math.min(1, (t.onFoot ? MIN_ARM_FOOT_M : MIN_ARM_CAR_M) / Math.max(dist, 1e-6));
      let clear = false;
      for (const k0 of PULL_IN) {
        const k = Math.max(k0, minK);
        const x = t.x - ox * dist * k;
        const z = t.z - oz * dist * k;
        const y = t.y + height * (0.6 + 0.4 * k);
        _desired.set(x, y, z);
        if (!this.occluded(x, y, z)) {
          clear = true;
          break;
        }
      }
      if (!clear) _desired.y = t.y + Math.max(height, 0) + (t.onFoot ? 1.5 : 3);
    }
    _look.set(t.x + ox * 5, t.y + (t.onFoot ? 1.4 : 1.25), t.z + oz * 5);
    // Slop New York's entity-relative follow: carry horizontal target travel before
    // easing the framing. World-space lerp adds a speed/frame-time-dependent trail.
    // Keep height in world space so SF curbs, hills and jumps still ease and clamp.
    if (this.init && this.targetOnFoot === t.onFoot && this.targetTaxi === t.robotaxiId) {
      const dx = t.x - this.targetX, dz = t.z - this.targetZ;
      if (dx * dx + dz * dz > 40 * 40) this.init = false;
      else {
        this.pos.x += dx; this.pos.z += dz;
        this.lookAt.x += dx; this.lookAt.z += dz;
      }
    }
    this.targetX = t.x; this.targetZ = t.z;
    this.targetOnFoot = t.onFoot; this.targetTaxi = t.robotaxiId;
    if (!this.init) {
      this.pos.copy(_desired);
      this.lookAt.copy(_look);
      this.init = true;
    } else {
      // Follow the player's own orbit input closely; otherwise trail smoothly.
      this.pos.lerp(_desired, 1 - Math.exp(-dt * (this.orbitIdle < 0.25 ? 14 : 5.5)));
      this.lookAt.lerp(_look, 1 - Math.exp(-dt * 12));
    }
    const minY = this.ground(this.pos.x, this.pos.z) + 1.0;
    if (this.pos.y < minY) this.pos.y = minY;
    // Never inside the car (a lagging camera on a steep hill, a tight pull-in): over its roof.
    if (!t.onFoot) {
      const hx = Math.sin(t.heading), hz = -Math.cos(t.heading);
      const rx = this.pos.x - t.x, rz = this.pos.z - t.z;
      const along = rx * hx + rz * hz, across = rx * -hz + rz * hx;
      const roof = t.y + CAR_BODY.top + BODY_CLEAR_M;
      if (Math.abs(along) < CAR_BODY.hl + BODY_CLEAR_M && Math.abs(across) < CAR_BODY.hw + BODY_CLEAR_M && this.pos.y < roof) this.pos.y = roof;
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.lookAt);
  }
}
