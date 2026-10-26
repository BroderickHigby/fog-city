// Daylight from the sim's game clock (src/render/daylight.ts): the sun's path over San
// Francisco and the lighting presets blended by its elevation.
import { describe, expect, it } from "vitest";
import { DAYLIGHT_KEYS, blendPresets, daylightAt, sunPosition } from "../../src/render/daylight.ts";
import { GOLDEN, NIGHT, NOON } from "../../src/render/sky.ts";

describe("sunPosition", () => {
  it("rises in the east, peaks in the south near 13:10 in summer, sets in the west", () => {
    const morning = sunPosition(6, 21, 7), noon = sunPosition(6, 21, 13.17), evening = sunPosition(6, 21, 19);
    expect(morning.azimuthDeg).toBeGreaterThan(50);
    expect(morning.azimuthDeg).toBeLessThan(110);
    expect(noon.azimuthDeg).toBeCloseTo(180, 0);
    // Midsummer noon at 37.8 N: 90 - 37.8 + 23.4.
    expect(noon.elevationDeg).toBeCloseTo(75.6, 0);
    expect(evening.azimuthDeg).toBeGreaterThan(250);
    expect(evening.azimuthDeg).toBeLessThan(310);
    expect(sunPosition(12, 21, 1).elevationDeg).toBeLessThan(-40);
    // Midwinter noon is low.
    expect(sunPosition(12, 21, 12.17).elevationDeg).toBeCloseTo(28.8, 0);
  });
});

describe("daylightAt", () => {
  it("is the night preset at midnight and the noon preset at midday, with the sun's own direction by day", () => {
    const night = daylightAt(7, 1, 0.5);
    expect(night.preset.nightFactor).toBe(1);
    expect(night.preset.sunAzimuthDeg).toBeCloseTo(NIGHT.sunAzimuthDeg, 3);
    expect(night.preset.sunElevationDeg).toBeCloseTo(NIGHT.sunElevationDeg, 3);
    const noon = daylightAt(7, 1, 13);
    expect(noon.preset.sunIntensity).toBe(NOON.sunIntensity);
    expect(noon.preset.nightFactor).toBe(0);
    const sun = sunPosition(7, 1, 13);
    expect(noon.preset.sunElevationDeg).toBeCloseTo(sun.elevationDeg, 3);
    expect(noon.preset.sunAzimuthDeg).toBeCloseTo(sun.azimuthDeg, 3);
  });

  it("changes continuously through the day: no jump between frames a game minute apart", () => {
    let last = daylightAt(9, 15, 0);
    for (let minute = 1; minute <= 24 * 60; minute++) {
      const d = daylightAt(9, 15, minute / 60);
      expect(Math.abs(d.preset.sunIntensity - last.preset.sunIntensity), `minute ${minute}`).toBeLessThan(0.12);
      expect(Math.abs((d.preset.nightFactor ?? 0) - (last.preset.nightFactor ?? 0))).toBeLessThan(0.03);
      expect(Math.abs(d.preset.exposure - last.preset.exposure)).toBeLessThan(0.01);
      expect(Math.abs(d.look.bloom - last.look.bloom)).toBeLessThan(0.01);
      last = d;
    }
  });

  it("asks for a new environment map only every few degrees of sun", () => {
    const keys = new Set<string>();
    for (let minute = 0; minute < 24 * 60; minute++) keys.add(daylightAt(9, 15, minute / 60).envKey);
    expect(keys.size).toBeGreaterThan(20);
    expect(keys.size).toBeLessThan(200);
  });

  it("orders its keys by elevation", () => {
    for (let i = 1; i < DAYLIGHT_KEYS.length; i++) expect(DAYLIGHT_KEYS[i]![0]).toBeGreaterThan(DAYLIGHT_KEYS[i - 1]![0]);
  });
});

describe("blendPresets", () => {
  it("returns either end at t = 0 and 1 and mixes colours between", () => {
    expect(blendPresets(GOLDEN, NOON, 0).sunColor).toBe(GOLDEN.sunColor);
    expect(blendPresets(GOLDEN, NOON, 1).zenith).toBe(NOON.zenith);
    const mid = blendPresets(GOLDEN, NOON, 0.5);
    expect(mid.sunIntensity).toBeCloseTo((GOLDEN.sunIntensity + NOON.sunIntensity) / 2);
    expect(mid.fog.density).toBeCloseTo((GOLDEN.fog.density + NOON.fog.density) / 2);
    expect(mid.zenith).not.toBe(GOLDEN.zenith);
    expect(mid.zenith).not.toBe(NOON.zenith);
  });
});
