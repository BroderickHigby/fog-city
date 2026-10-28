// The GPU sky's haze follows the time of day (src/render/sky.ts presets, blended by sun elevation
// in daylight.ts), as in Slop New York's per-preset turbidity/Rayleigh/Mie settings.
import { describe, expect, it } from "vitest";
import { DAYLIGHT_KEYS, blendPresets, daylightAt, sunPosition } from "../../src/render/daylight.ts";
import { DAY, GOLDEN, NIGHT, NOON, TWILIGHT, skyHaze, type LightingPreset } from "../../src/render/sky.ts";

const presets = [DAY, GOLDEN, NOON, TWILIGHT, NIGHT];
const channels = ["turbidity", "rayleigh", "mie", "mieG", "exposure"] as const;

describe("skyHaze", () => {
  it("gives every preset finite, positive sky settings", () => {
    for (const preset of presets) {
      const haze = skyHaze(preset);
      for (const channel of channels) { expect(Number.isFinite(haze[channel]), `${preset.name} ${channel}`).toBe(true); expect(haze[channel]).toBeGreaterThan(0); }
      expect(haze.mieG).toBeLessThan(1);
      expect(Number.isInteger(haze.nightColor)).toBe(true);
    }
  });

  it("keeps the golden hour's old fixed settings, and uses them for a preset that sets none", () => {
    const bare = { ...NIGHT } as Partial<LightingPreset>;
    for (const key of ["skyTurbidity", "skyRayleigh", "skyMie", "skyMieG", "skyExposure", "skyNightColor"] as const) delete bare[key];
    expect(skyHaze(bare as LightingPreset)).toMatchObject({ turbidity: 8, rayleigh: 2.8, mie: 0.008, mieG: 0.88, exposure: 0.148 });
    expect(skyHaze(GOLDEN)).toMatchObject({ turbidity: 8, rayleigh: 2.8, mie: 0.008, mieG: 0.88, exposure: 0.148 });
  });

  it("differs by time of day: clear at noon, hazier and bluer at dusk, thin at night", () => {
    const [noon, golden, twilight, night] = [NOON, GOLDEN, TWILIGHT, NIGHT].map(skyHaze) as [ReturnType<typeof skyHaze>, ReturnType<typeof skyHaze>, ReturnType<typeof skyHaze>, ReturnType<typeof skyHaze>];
    expect(noon.turbidity).toBeLessThan(golden.turbidity);
    expect(golden.turbidity).toBeLessThan(twilight.turbidity);
    expect(night.turbidity).toBeLessThan(noon.turbidity);
    expect(twilight.rayleigh).toBeGreaterThan(golden.rayleigh);
    expect(night.rayleigh).toBeLessThan(noon.rayleigh);
    expect(night.exposure).toBeLessThan(twilight.exposure);
    // Night keeps the flat sky the engine always used (0x101723, about 0.005/0.009/0.018 linear).
    expect(night.nightColor).toBe(0x101723);
  });
});

describe("haze through the day", () => {
  it("is each preset's own at its key and the straight mix between two keys", () => {
    expect(skyHaze(blendPresets(GOLDEN, NOON, 0)).turbidity).toBe(8);
    expect(skyHaze(blendPresets(GOLDEN, NOON, 1)).turbidity).toBe(6.5);
    const mid = skyHaze(blendPresets(TWILIGHT, GOLDEN, 0.5));
    expect(mid.turbidity).toBeCloseTo((9.5 + 8) / 2, 12);
    expect(mid.rayleigh).toBeCloseTo((3.4 + 2.8) / 2, 12);
    expect(mid.mieG).toBeCloseTo((0.9 + 0.88) / 2, 12);
    // The night sky colour blends in linear colour, not as a number: between the two it is neither.
    const colour = skyHaze(blendPresets(NIGHT, TWILIGHT, 0.5)).nightColor;
    expect(colour).not.toBe(NIGHT.skyNightColor);
    expect(colour).not.toBe(TWILIGHT.skyNightColor);
  });

  it("follows the game clock at the keys: night preset at midnight, noon preset at midday", () => {
    expect(skyHaze(daylightAt(7, 1, 0.5).preset)).toEqual(skyHaze(NIGHT));
    const noon = daylightAt(7, 1, 13);
    expect(sunPosition(7, 1, 13).elevationDeg).toBeGreaterThan(DAYLIGHT_KEYS[3]![0]);
    expect(skyHaze(noon.preset)).toEqual(skyHaze(NOON));
  });

  it("never jumps and never leaves the range of the keys across a whole day", () => {
    const all = presets.map(skyHaze);
    const lo = Object.fromEntries(channels.map(c => [c, Math.min(...all.map(h => h[c]))]));
    const hi = Object.fromEntries(channels.map(c => [c, Math.max(...all.map(h => h[c]))]));
    for (const [month, day] of [[1, 15], [6, 21], [9, 15]] as const) {
      let last = skyHaze(daylightAt(month, day, 0).preset);
      for (let minute = 1; minute <= 24 * 60; minute++) {
        const haze = skyHaze(daylightAt(month, day, minute / 60).preset);
        for (const channel of channels) {
          expect(haze[channel], `${channel} at ${month}/${day} minute ${minute}`).toBeGreaterThanOrEqual(lo[channel]! - 1e-9);
          expect(haze[channel]).toBeLessThanOrEqual(hi[channel]! + 1e-9);
          // A game minute is a quarter of a degree of sun at most: a few percent of the full range.
          expect(Math.abs(haze[channel] - last[channel]), `${channel} jumps at ${month}/${day} minute ${minute}`).toBeLessThan((hi[channel]! - lo[channel]!) * 0.12);
        }
        last = haze;
      }
    }
  });
});
