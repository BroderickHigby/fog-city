// The car's chase camera after mrdoob's Slop New York (MIT): a low arm that eases back as the
// car speeds up and closes in as it slows, the same at any frame rate, and stays out of the car
// and the ground on SF's steepest streets (about 31%). Render only: nothing here touches the sim.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CHASE_BACK_M,
  CHASE_FOLLOW_RATE,
  CHASE_LOOK_AHEAD_M,
  CHASE_SPEED_EASE,
  CHASE_UP_M,
  CameraRig,
  NO_FLY_INPUT,
  carChaseArm,
  type CameraTarget,
} from "../../src/render/cameras.ts";

const rig = (ground: (x: number, z: number) => number = () => 0, occluded?: (x: number, y: number, z: number) => boolean): CameraRig =>
  new CameraRig(new THREE.PerspectiveCamera(62, 1.6, 0.5, 1000), ground, occluded);
/** The car's arm as the old camera drew it (src/render/cameras.ts before this change). */
const oldArm = (v: number): { back: number; up: number } => ({ back: 8.2 + Math.min(v, 30) * 0.09, up: 3.1 + Math.min(v, 30) * 0.02 });

describe("car chase arm", () => {
  it("is Slop's low arm at rest", () => {
    const a = carChaseArm(0);
    expect(a.back).toBe(CHASE_BACK_M);
    expect(a.up).toBe(CHASE_UP_M);
    expect(a.back).toBeCloseTo(6.9, 6);
    expect(a.up).toBeLessThan(2.5);
  });

  it("is lower than the old camera at every speed, and comes back further with speed", () => {
    let prev = -Infinity;
    for (const v of [0, 5, 10, 15, 20, 25, 30, 40, 54, 62]) {
      const a = carChaseArm(v);
      expect(a.up, `up at ${v} m/s`).toBeLessThan(oldArm(v).up);
      expect(a.back, `back at ${v} m/s`).toBeGreaterThan(prev);
      prev = a.back;
    }
    // Stronger pull-back than before: from rest to 30 m/s the arm grows by more than the old 2.7 m.
    expect(carChaseArm(30).back - carChaseArm(0).back).toBeGreaterThan(oldArm(30).back - oldArm(0).back);
  });

  it("stretches by 1% per m/s up to 25%, then adds 0.1 m back per m/s", () => {
    expect(carChaseArm(10).back).toBeCloseTo(6.9 * 1.1 + 1, 9);
    expect(carChaseArm(30).back).toBeCloseTo(6.9 * 1.25 + 3, 9);
    expect(carChaseArm(54).back).toBeCloseTo(6.9 * 1.25 + 5.4, 9);
  });

  it("ignores a negative or absurd speed", () => {
    expect(carChaseArm(-10)).toEqual(carChaseArm(0));
    expect(carChaseArm(1e6)).toEqual(carChaseArm(60));
  });
});

describe("chase camera follows an eased speed", () => {
  const car = (speed: number): CameraTarget => ({ x: 0, y: 0, z: 0, heading: 0, speed, onFoot: false });
  /** Camera distance behind the car (it faces -z), metres. */
  const behind = (r: CameraRig, t: CameraTarget): number => r.camera.position.z - t.z;

  it("starts at the arm for the speed it is first seen at", () => {
    const r = rig();
    const t = car(20);
    r.update(1 / 60, t, NO_FLY_INPUT);
    expect(behind(r, t)).toBeCloseTo(carChaseArm(20).back, 6);
  });

  it("drifts back as the car speeds up and closes in as it slows", () => {
    const r = rig();
    const t = car(0);
    r.update(1 / 60, t, NO_FLY_INPUT);
    const rest = behind(r, t);
    t.speed = 30;
    // The first frames after the jump in speed: the arm has barely moved.
    for (let i = 0; i < 6; i++) { t.z -= t.speed / 60; r.update(1 / 60, t, NO_FLY_INPUT); }
    const early = behind(r, t);
    expect(early).toBeGreaterThan(rest);
    expect(early).toBeLessThan(carChaseArm(30).back - 1);
    for (let i = 0; i < 300; i++) { t.z -= t.speed / 60; r.update(1 / 60, t, NO_FLY_INPUT); }
    expect(behind(r, t)).toBeCloseTo(carChaseArm(30).back, 3);
    t.speed = 0;
    for (let i = 0; i < 300; i++) r.update(1 / 60, t, NO_FLY_INPUT);
    expect(behind(r, t)).toBeCloseTo(rest, 3);
  });

  it("takes the same time to reach the arm at 30, 60 and 144 Hz (frame-rate independent)", () => {
    const result = (hz: number): number => {
      const r = rig();
      const t = car(0);
      r.update(1 / hz, t, NO_FLY_INPUT);
      t.speed = 30;
      const frames = Math.round(hz * 0.5);
      for (let i = 0; i < frames; i++) { t.z -= t.speed / hz; r.update(1 / hz, t, NO_FLY_INPUT); }
      return behind(r, t);
    };
    const a = result(30), b = result(60), c = result(144);
    // The arm moves about 1.6 m in this half second; sampling it 30 or 144 times differs by a few cm.
    expect(Math.abs(a - b)).toBeLessThan(0.06);
    expect(Math.abs(b - c)).toBeLessThan(0.06);
    // And half a second at rate 3 is neither instant nor stuck: 1 - e^-1.5 of the way (before the position follow).
    expect(b).toBeGreaterThan(carChaseArm(0).back + 0.3);
    expect(b).toBeLessThan(carChaseArm(30).back);
    expect(CHASE_SPEED_EASE).toBe(3);
    expect(CHASE_FOLLOW_RATE).toBe(8.5);
  });

  it("is the same in reverse as forward (it follows speed, not direction)", () => {
    const a = rig(), b = rig();
    const f = car(20), r = car(-20);
    a.update(1 / 60, f, NO_FLY_INPUT);
    b.update(1 / 60, r, NO_FLY_INPUT);
    expect(behind(b, r)).toBeCloseTo(behind(a, f), 9);
  });

  it("looks 5.2 m ahead of a car along its heading, a little above the roof line of the road", () => {
    const r = rig();
    const t = car(0);
    for (let i = 0; i < 120; i++) r.update(1 / 60, t, NO_FLY_INPUT);
    const dir = r.camera.getWorldDirection(new THREE.Vector3());
    const p = r.camera.position;
    // Where the view ray crosses z = -5.2 is the look point's height.
    const k = (-CHASE_LOOK_AHEAD_M - p.z) / dir.z;
    const lookY = p.y + dir.y * k;
    expect(lookY).toBeGreaterThan(1.2);
    expect(lookY).toBeLessThan(1.7);
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
  });

  it("leaves the on-foot chase as it was (4.4 m back, 2.0 up, no speed pull-back)", () => {
    const r = rig();
    const t: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 8, onFoot: true };
    for (let i = 0; i < 240; i++) r.update(1 / 60, t, NO_FLY_INPUT);
    expect(r.camera.position.z).toBeCloseTo(4.4, 6);
    expect(r.camera.position.y).toBeCloseTo(2.0, 6);
  });

  it("re-seeds the eased speed when the camera mode changes (no slow drift from a stale speed)", () => {
    const r = rig();
    const t = car(0);
    r.update(1 / 60, t, NO_FLY_INPUT);
    r.setMode("first-person");
    t.speed = 40;
    r.update(1 / 60, t, NO_FLY_INPUT);
    r.setMode("chase");
    r.update(1 / 60, t, NO_FLY_INPUT);
    expect(behind(r, t)).toBeCloseTo(carChaseArm(40).back, 6);
  });

  it("does not move the first-person or fly cameras", () => {
    const r = rig();
    const t = car(30);
    r.setMode("first-person");
    r.update(1 / 60, t, NO_FLY_INPUT);
    expect(r.camera.position.y).toBeCloseTo(1.3, 9);
    expect(r.camera.position.z).toBeCloseTo(-0.1, 9);
  });
});

describe("chase camera on SF's steepest streets", () => {
  const GRADE = 0.315; // Filbert Street between Hyde and Leavenworth
  const CAR = { hl: 2.2, hw: 0.95, top: 1.5 };

  /**
   * The camera in the car's own frame (x forward, y up along the tilted body, z across), after the
   * car's pitch, measured against the car's body grown by `grow` metres.
   */
  function insideBody(p: THREE.Vector3, t: CameraTarget, grow: number): boolean {
    const h = t.heading, pitch = t.pitch ?? 0;
    const fx = Math.sin(h), fz = -Math.cos(h);
    const dx = p.x - t.x, dz = p.z - t.z, dy = p.y - t.y;
    const along = dx * fx + dz * fz;
    const across = dx * -fz + dz * fx;
    // Rotate (along, up) by -pitch into the body frame.
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const bodyAlong = along * c + dy * s;
    const bodyUp = -along * s + dy * c;
    return Math.abs(bodyAlong) < CAR.hl + grow && Math.abs(across) < CAR.hw + grow && bodyUp > -grow && bodyUp < CAR.top + grow;
  }

  /** A hill of constant grade up to a crest at z = -150 then down the other side, north-bound. */
  const ridge = (_x: number, z: number): number => GRADE * (150 - Math.abs(z + 150));

  function run(speedAt: (i: number) => number, ticks: number, startZ = 0, dt = 1 / 60): { worstGround: number; worstBody: number; minBehind: number } {
    const r = rig(ridge);
    let z = startZ, worstGround = Infinity, worstBody = Infinity, minBehind = Infinity;
    for (let i = 0; i < ticks; i++) {
      const speed = speedAt(i);
      z -= speed * dt;
      const t: CameraTarget = { x: 0, y: ridge(0, z), z, heading: 0, speed, onFoot: false, pitch: Math.atan(z > -150 ? GRADE : -GRADE) };
      r.update(dt, t, NO_FLY_INPUT);
      const p = r.camera.position;
      worstGround = Math.min(worstGround, p.y - ridge(p.x, p.z));
      // Largest grow at which the camera is still outside the body.
      let grow = 1.5;
      while (grow > 0 && insideBody(p, t, grow)) grow -= 0.05;
      worstBody = Math.min(worstBody, grow);
      minBehind = Math.min(minBehind, Math.hypot(p.x - t.x, p.z - t.z));
    }
    return { worstGround, worstBody, minBehind };
  }

  it("stays above the ground and clear of the car climbing a 31.5% grade at 15 m/s and over the crest", () => {
    const m = run(() => 15, 60 * 20);
    expect(m.worstGround).toBeGreaterThanOrEqual(0.95);
    expect(m.worstBody).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(m.minBehind).toBeGreaterThan(CAR.hl + 2);
  });

  it("stays above the ground and clear of the car over the crest at top speed", () => {
    const m = run((i) => Math.min(54, i * 0.4), 60 * 8);
    expect(m.worstGround).toBeGreaterThanOrEqual(0.95);
    expect(m.worstBody).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it("stays above the ground and clear of the car braking hard on the way down", () => {
    // Start past the crest, fast, and brake to a stop on the descent.
    const r = rig(ridge);
    let z = -170, speed = 45;
    let worstGround = Infinity, worstBody = Infinity;
    for (let i = 0; i < 60 * 8; i++) {
      speed = Math.max(0, speed - 11 / 60);
      z -= speed / 60;
      const t: CameraTarget = { x: 0, y: ridge(0, z), z, heading: 0, speed, onFoot: false, pitch: Math.atan(-GRADE) };
      r.update(1 / 60, t, NO_FLY_INPUT);
      const p = r.camera.position;
      worstGround = Math.min(worstGround, p.y - ridge(p.x, p.z));
      let grow = 1.5;
      while (grow > 0 && insideBody(p, t, grow)) grow -= 0.05;
      worstBody = Math.min(worstBody, grow);
    }
    expect(worstGround).toBeGreaterThanOrEqual(0.95);
    expect(worstBody).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it("looks up the road on a climb and down it on a descent, compared with the flat", () => {
    const lookY = (pitch: number): number => {
      const r = rig();
      const t: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 8, onFoot: false, pitch };
      for (let i = 0; i < 240; i++) r.update(1 / 60, t, NO_FLY_INPUT);
      const dir = r.camera.getWorldDirection(new THREE.Vector3());
      const p = r.camera.position;
      return p.y + dir.y * ((-CHASE_LOOK_AHEAD_M - p.z) / dir.z);
    };
    const flat = lookY(0);
    expect(lookY(Math.atan(GRADE))).toBeGreaterThan(flat + 0.5);
    expect(lookY(-Math.atan(GRADE))).toBeLessThan(flat - 0.5);
  });

  it("still pulls in short of a building and rises over the car when even the shortest arm is blocked", () => {
    let carZ = 0;
    const occluded = (_x: number, _y: number, z: number): boolean => z - carZ > 2.5;
    const r = rig((_x, z) => -GRADE * z, occluded);
    for (let i = 0; i < 240; i++) {
      carZ -= 12 / 60;
      const t: CameraTarget = { x: 0, y: -GRADE * carZ, z: carZ, heading: 0, speed: 12, onFoot: false, pitch: Math.atan(GRADE) };
      r.update(1 / 60, t, NO_FLY_INPUT);
      expect(insideBody(r.camera.position, t, 0.4), `camera in the car at tick ${i}`).toBe(false);
    }
  });
});
