// Night (render-only): the street-light rig that lights the lamps nearest the camera, and night
// clouds that are dim and underlit rather than daylight white.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DAY, NIGHT, TWILIGHT, applySkyPreset, skyUniforms } from "../../src/render/sky.ts";
import { STREET_LIGHTS, STREET_LIGHT_RANGE_M, StreetLightRig } from "../../src/render/street-lights.ts";

const heads = (pts: [number, number][]): Float32Array => new Float32Array(pts.flatMap(([x, z]) => [x, 7, z]));

describe("StreetLightRig", () => {
  it("is dark by day and lights the nearest lamps at night, at most STREET_LIGHTS of them", () => {
    const rig = new StreetLightRig();
    const lamps = heads(Array.from({ length: 30 }, (_, i) => [i * 10, 0] as [number, number]));
    rig.update(0, 0, 1, [lamps]);
    expect(rig.lit).toBe(0);
    rig.setNight(1);
    rig.update(0, 0, 1, [lamps]);
    expect(rig.lit).toBe(STREET_LIGHTS);
    const xs = rig.lights.filter(l => l.intensity > 0).map(l => l.position.x).sort((a, b) => a - b);
    expect(xs).toEqual(Array.from({ length: STREET_LIGHTS }, (_, i) => i * 10));
    expect(rig.lights[0]!.position.y).toBeCloseTo(6.7);
    rig.dispose();
  });

  it("follows the camera across tiles and ignores lamps out of range", () => {
    const rig = new StreetLightRig();
    rig.setNight(1);
    rig.update(1000, 0, 1, [heads([[0, 0], [5, 5]]), heads([[1000, 3], [1004, -2]])]);
    expect(rig.lit).toBe(2);
    expect(rig.lights.filter(l => l.intensity > 0).every(l => l.position.x >= 1000)).toBe(true);
    rig.update(0, 5000, 1, [heads([[0, 5000 + STREET_LIGHT_RANGE_M + 1]])]);
    expect(rig.lit).toBe(0);
    rig.dispose();
  });

  it("keeps a fixed number of lights, so turning night on never changes the scene's light count", () => {
    const rig = new StreetLightRig();
    const before = rig.group.children.length;
    rig.setNight(1);
    rig.update(0, 0, 1, [heads([[1, 1]])]);
    expect(rig.group.children.length).toBe(before);
    expect(rig.group.children.every(c => (c as THREE.PointLight).isPointLight)).toBe(true);
    rig.dispose();
  });
});

describe("night clouds", () => {
  const luma = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it("are lit like the sky: white by day, dim and warm-underlit at night, between at twilight", () => {
    applySkyPreset(DAY);
    const day = luma(skyUniforms.uCloudLight.value);
    expect(day).toBeGreaterThan(0.8);
    expect(luma(skyUniforms.uCloudGlow.value)).toBe(0);
    applySkyPreset(TWILIGHT);
    const dusk = luma(skyUniforms.uCloudLight.value);
    applySkyPreset(NIGHT);
    const night = luma(skyUniforms.uCloudLight.value);
    expect(night).toBeLessThan(0.05);
    expect(dusk).toBeLessThan(day);
    expect(dusk).toBeGreaterThan(night);
    const glow = skyUniforms.uCloudGlow.value;
    expect(glow.r).toBeGreaterThan(glow.b);
    // Never brighter than the lit sky band they sit in by more than a little: no photo negative.
    expect(night).toBeLessThan(luma(new THREE.Color(NIGHT.horizonCool)) * 2);
    applySkyPreset(DAY);
  });
});
