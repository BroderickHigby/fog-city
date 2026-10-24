// The chase camera's player orbit (owner playtest: "click and hold and drag around"): drag
// swings the camera round the player, the pitch is clamped, it stays put while the player
// stands still, and it eases back behind a moving player after a short idle. Render only.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CameraRig, ORBIT_PITCH_DOWN, ORBIT_PITCH_UP, ORBIT_RETURN_DELAY_S, type CameraTarget } from "../../src/render/cameras.ts";
import { NO_FLY_INPUT } from "../../src/render/cameras.ts";

const rig = (): CameraRig => new CameraRig(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000), () => 0);
const target = (speed = 0): CameraTarget => ({ x: 0, y: 0, z: 0, heading: 0, speed, onFoot: true });
const settle = (r: CameraRig, t: CameraTarget, seconds: number): void => {
  for (let i = 0; i < seconds * 60; i++) r.update(1 / 60, t, NO_FLY_INPUT);
};

describe("chase camera orbit", () => {
  it("starts behind the player (south of a player facing north)", () => {
    const r = rig();
    settle(r, target(), 1);
    expect(r.camera.position.z).toBeGreaterThan(3);
    expect(Math.abs(r.camera.position.x)).toBeLessThan(1e-6);
    expect(r.viewHeading()).toBeCloseTo(0, 3);
  });

  it("a drag swings the camera round to the player's side and turns the view", () => {
    const r = rig();
    settle(r, target(), 0.5);
    r.orbit(Math.PI / 2, 0);
    settle(r, target(), 1);
    // Looking east now: the camera sits west of the player.
    expect(r.camera.position.x).toBeLessThan(-3);
    expect(Math.abs(r.camera.position.z)).toBeLessThan(0.5);
    expect(r.viewHeading()).toBeCloseTo(Math.PI / 2, 1);
  });

  it("stays where it was dragged while the player stands still", () => {
    const r = rig();
    r.orbit(1, 0.3);
    settle(r, target(0), ORBIT_RETURN_DELAY_S + 3);
    expect(r.orbitOffset()).toEqual({ yaw: 1, pitch: 0.3 });
  });

  it("eases back behind a moving player once the drag stops, not before", () => {
    const r = rig();
    r.orbit(1.2, 0.4);
    settle(r, target(3), ORBIT_RETURN_DELAY_S * 0.8);
    expect(r.orbitOffset().yaw).toBe(1.2);
    settle(r, target(3), 3);
    expect(Math.abs(r.orbitOffset().yaw)).toBeLessThan(0.01);
    expect(Math.abs(r.orbitOffset().pitch)).toBeLessThan(0.01);
  });

  it("clamps the pitch and ignores drags outside the chase camera", () => {
    const r = rig();
    r.orbit(0, 10);
    expect(r.orbitOffset().pitch).toBe(ORBIT_PITCH_UP);
    r.orbit(0, -10);
    expect(r.orbitOffset().pitch).toBe(ORBIT_PITCH_DOWN);
    settle(r, target(), 1);
    expect(r.camera.position.y).toBeGreaterThanOrEqual(1);
    r.setMode("first-person");
    r.orbit(1, 0);
    expect(r.orbitOffset().yaw).toBe(0);
  });
});

describe("chase camera on steep hills", () => {
  /** A 30% ridge: up to the crest at z = -150, then down; heading north (-z). */
  const ridge = (x: number, z: number): number => 0.3 * (150 - Math.abs(z + 150)) + 0 * x;
  const CAR_HL = 2.2, CAR_HW = 0.95, CAR_H = 1.5;

  it("never puts the camera inside the car body or under the ground over a crest at speed", () => {
    const r = new CameraRig(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000), ridge);
    let z = 0, speed = 0, worst = Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      speed = Math.min(30, speed + 6 / 60);
      z -= speed / 60;
      const y = ridge(0, z);
      const pitch = Math.atan(z > -150 ? 0.3 : -0.3);
      r.update(1 / 60, { x: 0, y, z, heading: 0, speed, onFoot: false, pitch }, NO_FLY_INPUT);
      const p = r.camera.position;
      expect(p.y).toBeGreaterThanOrEqual(ridge(p.x, p.z) + 0.9);
      // In the car's frame (forward is -z): outside its body grown by 0.5 m.
      const forward = -(p.z - z), lateral = p.x, up = p.y - y;
      const inside = Math.abs(forward) < CAR_HL + 0.5 && Math.abs(lateral) < CAR_HW + 0.5 && up > -0.5 && up < CAR_H + 0.5;
      expect(inside, `camera inside the car at tick ${i}`).toBe(false);
      worst = Math.min(worst, Math.hypot(p.x, p.z - z));
    }
    expect(worst).toBeGreaterThan(CAR_HL + 1);
  });
});

describe("chase camera pulled in by a building behind the car", () => {
  it("stops short of the car body and rises over it instead (the owner's hill clip)", () => {
    let carZ = 0;
    // Everything more than 2.5 m behind the car is inside a building (a steep street walled in
    // behind), so every pull-in step is occluded.
    const occluded = (_x: number, _y: number, z: number): boolean => z - carZ > 2.5;
    const r = new CameraRig(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000), (_x, z) => -0.3 * z, occluded);
    for (let i = 0; i < 240; i++) {
      carZ -= 10 / 60;
      const y = -0.3 * carZ;
      r.update(1 / 60, { x: 0, y, z: carZ, heading: 0, speed: 10, onFoot: false, pitch: Math.atan(0.3) }, NO_FLY_INPUT);
      const p = r.camera.position;
      const behind = p.z - carZ, up = p.y - y;
      const inside = Math.abs(behind) < 2.2 + 0.5 && Math.abs(p.x) < 0.95 + 0.5 && up < 1.5 + 0.5;
      expect(inside, `camera in the car at tick ${i}: behind ${behind.toFixed(2)} up ${up.toFixed(2)}`).toBe(false);
    }
  });
});
