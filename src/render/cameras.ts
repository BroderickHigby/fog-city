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
/**
 * How much of a hill's slope the arm follows: lower behind a car climbing, higher behind one
 * descending. Climbing keeps 0.6 (the camera then sits a little above the car's own plane, clear of
 * the roof); descending follows the whole slope, so the lower arm does not end up level with the
 * road that rises behind the car.
 */
const SLOPE_FOLLOW_UP = 0.6;
const SLOPE_FOLLOW_DOWN = 1.0;
/** How much of the road's rise over the look-ahead the look point follows, so a climb still shows road. */
const LOOK_SLOPE_FOLLOW = 0.6;

// The car's chase arm, after mrdoob's Slop New York (MIT): a low arm that drifts back as the car speeds up and closes in as it slows.
/**
 * The car's arm at rest: metres back and up. Back is Slop's 6.9 (js/controllers.js:585). Up is 2.2,
 * not Slop's 2.12 (:586): Fog City's car roof is 1.5 m (CAR_BODY.top) and the body clamp holds the
 * camera 0.6 m (BODY_CLEAR_M) above it, 2.1 m, so 2.2 sits just over that line at rest instead of
 * on it.
 */
export const CHASE_BACK_M = 6.9;
export const CHASE_UP_M = 2.2;
/** The arm grows by this fraction per m/s of eased speed, up to the cap (Slop js/cameras.js:192). */
export const CHASE_STRETCH_PER_MS = 0.01;
export const CHASE_STRETCH_MAX = 0.25;
/** On top of that, this many metres back per m/s of eased speed (Slop js/cameras.js:186, `speedLag`). */
export const CHASE_LAG_M_PER_MS = 0.1;
/** The speed the arm follows eases at this rate, 1/s (Slop js/cameras.js:185). Frame-rate independent. */
export const CHASE_SPEED_EASE = 3;
/** The arm never reads a speed above this, m/s (the car's hard cap is 62). */
export const CHASE_SPEED_CAP = 60;
/** The car chase camera follows its target at this rate, 1/s (Slop js/cameras.js:346). */
export const CHASE_FOLLOW_RATE = 8.5;
/** The look point's follow rate on foot and while the player drags the orbit, 1/s: quicker than the car's own. */
const LOOK_FOLLOW_RATE = 12;
/**
 * The hill pitch the arm and the look point follow is the car's pitch eased at this rate, 1/s. The
 * sim's pitch is a two-point slope over 2.7 m of road, so a kerb or a patch of rough ground is a
 * short spike in it; the longer the arm, the more a spike moves the camera. A hill is slow, so it
 * is followed. The roof clamp reads the car's real pitch.
 */
export const CHASE_PITCH_EASE = 6;
/** Where a car's chase camera looks: this far ahead (Slop js/cameras.js:203-207), and this high, metres. */
export const CHASE_LOOK_AHEAD_M = 5.2;
const CHASE_LOOK_HEIGHT_M = 1.4;

/** The car chase arm for an eased speed (m/s): how far back and how high the camera sits, metres. */
export function carChaseArm(easedSpeed: number): { back: number; up: number } {
  const v = Math.max(0, Math.min(CHASE_SPEED_CAP, easedSpeed));
  return { back: CHASE_BACK_M * (1 + Math.min(CHASE_STRETCH_MAX, v * CHASE_STRETCH_PER_MS)) + v * CHASE_LAG_M_PER_MS, up: CHASE_UP_M };
}
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
  /** The speed the car's chase arm follows: the target's speed, eased (render only). */
  private easedSpeed = 0;
  /** The car's pitch, eased (render only): what the arm and the look point follow on a hill. */
  private easedPitch = 0;
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
    // A non-finite speed or pitch must not reach the easing below, where it would never wash out.
    const rawSpeed = Math.abs(t.speed);
    const speed = Number.isFinite(rawSpeed) ? rawSpeed : this.init ? this.easedSpeed : 0;
    const rawPitch = t.pitch ?? 0;
    const pitch = Number.isFinite(rawPitch) ? rawPitch : this.init ? this.easedPitch : 0;
    // A jump of more than 40 m (a teleport, a respawn) re-seeds the whole framing, the arm and the
    // eased speed and pitch included, the way a mode switch does. This comes before any easing.
    const sameBody = this.targetOnFoot === t.onFoot && this.targetTaxi === t.robotaxiId;
    const dxT = t.x - this.targetX, dzT = t.z - this.targetZ;
    if (this.init && sameBody && dxT * dxT + dzT * dzT > 40 * 40) this.init = false;
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
    // The car's arm follows an eased speed, not the raw one: it drifts back as the car speeds up and
    // closes in as it slows, the same over a fast or a slow display (exp, not a per-frame factor).
    this.easedSpeed = this.init ? this.easedSpeed + (speed - this.easedSpeed) * (1 - Math.exp(-dt * CHASE_SPEED_EASE)) : speed;
    this.easedPitch = this.init ? this.easedPitch + (pitch - this.easedPitch) * (1 - Math.exp(-dt * CHASE_PITCH_EASE)) : pitch;
    const carArm = carChaseArm(this.easedSpeed);
    const dist0 = t.onFoot ? 4.4 : carArm.back;
    const height0 = t.onFoot ? 2.0 : carArm.up;
    // Tip the arm about the target, keeping its length.
    const arm = Math.hypot(dist0, height0);
    const elevation = Math.atan2(height0, dist0) + this.orbitPitch;
    const dist = arm * Math.cos(elevation);
    // Follow the hill: the ground behind a climbing car is lower, behind a descending one higher.
    const slope = t.onFoot ? 0 : Math.tan(Math.max(-0.6, Math.min(0.6, this.easedPitch))) * Math.cos(this.orbitYaw);
    const height = arm * Math.sin(elevation) - dist * slope * (slope > 0 ? SLOPE_FOLLOW_UP : SLOPE_FOLLOW_DOWN);
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
    // Look ahead of the car, and up the road when it climbs (down it when it descends).
    if (t.onFoot) _look.set(t.x + ox * 5, t.y + 1.4, t.z + oz * 5);
    else _look.set(t.x + ox * CHASE_LOOK_AHEAD_M, t.y + CHASE_LOOK_HEIGHT_M + CHASE_LOOK_AHEAD_M * slope * LOOK_SLOPE_FOLLOW, t.z + oz * CHASE_LOOK_AHEAD_M);
    // Slop New York's entity-relative follow: carry horizontal target travel before
    // easing the framing. World-space lerp adds a speed/frame-time-dependent trail.
    // Keep height in world space so SF curbs, hills and jumps still ease and clamp.
    if (this.init && sameBody) {
      this.pos.x += dxT; this.pos.z += dzT;
      this.lookAt.x += dxT; this.lookAt.z += dzT;
    }
    this.targetX = t.x; this.targetZ = t.z;
    this.targetOnFoot = t.onFoot; this.targetTaxi = t.robotaxiId;
    if (!this.init) {
      this.pos.copy(_desired);
      this.lookAt.copy(_look);
      this.init = true;
    } else {
      // Follow the player's own orbit input closely; otherwise trail smoothly.
      this.pos.lerp(_desired, 1 - Math.exp(-dt * (this.orbitIdle < 0.25 ? 14 : t.onFoot ? 5.5 : CHASE_FOLLOW_RATE)));
      this.lookAt.lerp(_look, 1 - Math.exp(-dt * (t.onFoot || this.orbitIdle < 0.25 ? LOOK_FOLLOW_RATE : CHASE_FOLLOW_RATE)));
    }
    const minY = this.ground(this.pos.x, this.pos.z) + 1.0;
    if (this.pos.y < minY) this.pos.y = minY;
    // Never inside the car (a lagging camera on a steep hill, a tight pull-in): over its roof.
    if (!t.onFoot) {
      const hx = Math.sin(t.heading), hz = -Math.cos(t.heading);
      const rx = this.pos.x - t.x, rz = this.pos.z - t.z;
      const along = rx * hx + rz * hz, across = rx * -hz + rz * hx;
      // On a hill the roof line tilts with the car: behind a descending car it rises towards the tail.
      const tilt = Math.tan(Math.max(-0.6, Math.min(0.6, pitch)));
      const roof = t.y + CAR_BODY.top + BODY_CLEAR_M + Math.max(0, along * tilt);
      if (Math.abs(along) < CAR_BODY.hl + BODY_CLEAR_M && Math.abs(across) < CAR_BODY.hw + BODY_CLEAR_M && this.pos.y < roof) this.pos.y = roof;
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.lookAt);
  }
}
