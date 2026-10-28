import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CameraRig, NO_FLY_INPUT, carChaseArm, type CameraTarget } from "../../src/render/cameras.ts";

function drive(intervals: readonly number[]): { offset: number; minimum: number; maximum: number } {
  const rig = new CameraRig(new THREE.PerspectiveCamera(60, 1.6, .5, 1000), () => 0);
  const target: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 30, onFoot: false };
  rig.update(1 / 60, target, NO_FLY_INPUT);
  let minimum = Infinity, maximum = -Infinity;
  for (let i = 0; i < 360; i++) {
    const dt = intervals[i % intervals.length]!; target.z -= target.speed * dt;
    rig.update(dt, target, NO_FLY_INPUT);
    const offset = rig.camera.position.z - target.z;
    minimum = Math.min(minimum, offset); maximum = Math.max(maximum, offset);
  }
  return { offset: rig.camera.position.z - target.z, minimum, maximum };
}
describe("vehicle-relative chase framing", () => {
  it("keeps steady driving in the same framing instead of adding a speed-dependent trail", () => {
    expect(drive([1 / 60]).offset).toBeCloseTo(carChaseArm(30).back, 6);
  });
  it("does not surge with uneven display frames while the car travels steadily", () => {
    const run = drive([1 / 30, 1 / 120, 1 / 24, 1 / 60]);
    expect(run.maximum - run.minimum).toBeLessThan(1e-6);
    expect(run.offset).toBeCloseTo(carChaseArm(30).back, 6);
  });
});
