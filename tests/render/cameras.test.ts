import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, NO_FLY_INPUT, type CameraTarget } from "../../src/render/cameras.ts";

const target: CameraTarget = { x: 0, y: 8, z: 0, heading: 0, speed: 0, onFoot: false };

describe("camera support surfaces", () => {
  it("keeps a chase or fly camera in a bore while retaining terrain above it", () => {
    const camera = new THREE.PerspectiveCamera();
    const queries: number[] = [];
    const rig = new CameraRig(camera, () => 40, () => false, (_x, _z, nearY) => {
      queries.push(nearY);
      return nearY < 15 ? 8 : 40;
    });
    rig.update(0, target, NO_FLY_INPUT);
    expect(camera.position.y).toBeCloseTo(11.1);
    expect(queries.at(-1)).toBeCloseTo(11.1);

    rig.setFlyPose(2, 10, 3, 0, 0);
    rig.update(0, target, NO_FLY_INPUT);
    expect(camera.position.toArray()).toEqual([2, 10, 3]);
    rig.setFlyPose(2, 40, 3, 0, 0);
    rig.update(0, target, NO_FLY_INPUT);
    expect(camera.position.y).toBe(40.5);
  });

  it("retains the terrain clamp when a legacy world supplies no height-aware query", () => {
    const camera = new THREE.PerspectiveCamera();
    const rig = new CameraRig(camera, () => 40);
    rig.setFlyPose(2, 10, 3, 0, 0);
    rig.update(0, target, NO_FLY_INPUT);
    expect(camera.position.y).toBe(40.5);
    rig.setMode("chase");
    rig.update(0, target, NO_FLY_INPUT);
    expect(camera.position.y).toBe(41);
  });
});
