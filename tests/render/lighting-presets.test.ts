import { describe, expect, it } from "vitest";
import { DAY, GOLDEN, NIGHT, NOON, TWILIGHT, applySkyPreset, skyUniforms, sunDirection } from "../../src/render/sky.ts";
import { presentationLook } from "../../src/render/quality.ts";

describe("SF lighting presets", () => {
  it("provides distinct camera-keyed skies with finite, normalized lighting directions", () => {
    const presets = [DAY, GOLDEN, NOON, TWILIGHT, NIGHT];
    expect(new Set(presets.map(preset => preset.name)).size).toBe(presets.length);
    expect(NOON.sunElevationDeg).toBeGreaterThan(GOLDEN.sunElevationDeg);
    expect(GOLDEN.sunElevationDeg).toBeGreaterThan(TWILIGHT.sunElevationDeg);
    for (const preset of presets) {
      const direction = sunDirection(preset);
      expect(direction.toArray().every(Number.isFinite)).toBe(true);
      expect(direction.length()).toBeCloseTo(1, 12);
      expect(preset.sunIntensity).toBeGreaterThan(0);
      expect(preset.exposure).toBeGreaterThan(0);
      expect(preset.envIntensity).toBeGreaterThan(0);
      expect(preset.cloudCoverage).toBeGreaterThanOrEqual(0);
      expect(preset.cloudCoverage).toBeLessThanOrEqual(1);
      const look = presentationLook(preset.name);
      expect(look.balance.every(value => value > 0 && Number.isFinite(value))).toBe(true);
      expect(look.bloom).toBeLessThan(0.3);
      expect(look.bloomThreshold).toBeGreaterThanOrEqual(1);
    }
  });

  it("applies the same atmosphere to sky and water uniforms without retaining old clouds", () => {
    applySkyPreset(NOON);
    expect(skyUniforms.uSunDirSky.value.toArray()).toEqual(sunDirection(NOON).toArray());
    expect(skyUniforms.uCloudCoverage.value).toBe(NOON.cloudCoverage);
    applySkyPreset({ ...NIGHT, cloudCoverage: undefined, cloudOpacity: undefined });
    expect(skyUniforms.uCloudCoverage.value).toBe(0);
    expect(skyUniforms.uCloudOpacity.value).toBe(0);
    expect(skyUniforms.uStars.value).toBe(1);
    applySkyPreset(DAY);
  });
});
