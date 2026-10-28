// Road water (src/render/road-water.ts): the CPU reference of the shader math in node-materials.ts,
// and the guarantee that the time-of-day sheen is a look only. The shader graph itself is checked on
// a GPU (QA screenshots in the pull request), not here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daylightAt } from "../../src/render/daylight.ts";
import { GOLDEN, NIGHT, NOON, TWILIGHT } from "../../src/render/sky.ts";
import {
  PAINT_ROUGHNESS, PUDDLE_SCALES, REFLECT_MAX, WATER_SKIP_BELOW, paintAlbedo, paintRoughness, puddleField, waterFresnel, waterLevel,
  waterReflection, wetAlbedo, wetMasks, wetRoughness,
} from "../../src/render/road-water.ts";

/** A 400 m x 400 m street patch sampled every 2 m. */
const patch: [number, number][] = [];
for (let x = 0; x < 400; x += 2) for (let z = 0; z < 400; z += 2) patch.push([x + 0.37, z + 0.81]);
const fields = patch.map(([x, z]) => puddleField(x, z));
const share = (test: (field: number) => boolean): number => fields.filter(test).length / fields.length;

describe("puddle field", () => {
  it("has three scales whose weights sum to one, so it stays in 0..1", () => {
    expect(PUDDLE_SCALES).toHaveLength(3);
    expect(PUDDLE_SCALES.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1, 12);
    for (const f of fields) { expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThanOrEqual(1); }
  });

  it("settles the fine scales to their mean over a large pixel footprint (far roads do not shimmer)", () => {
    let near = 0, far = 0;
    for (const [x, z] of patch) {
      near += Math.abs(puddleField(x, z, 0) - puddleField(x + 0.05, z, 0));
      far += Math.abs(puddleField(x, z, 4) - puddleField(x + 0.05, z, 4));
    }
    expect(far).toBeLessThan(near * 0.4);
    // The coarse scale alone remains: weight 0.52 on noise plus 0.48 on the mean.
    for (const [x, z] of patch.slice(0, 50)) expect(puddleField(x, z, 4)).toBeGreaterThan(0.24 - 1e-9);
  });
});

describe("the water line", () => {
  it("sinks as wetness rises, from 0.86 dry to 0.56 fully wet", () => {
    expect(waterLevel(0)).toBeCloseTo(0.86, 12);
    expect(waterLevel(0.1)).toBeCloseTo(0.86, 12);
    expect(waterLevel(0.65)).toBeCloseTo(0.56, 12);
    expect(waterLevel(1)).toBeCloseTo(0.56, 12);
    let last = Infinity;
    for (let w = 0; w <= 1; w += 0.02) { const level = waterLevel(w); expect(level).toBeLessThanOrEqual(last + 1e-12); last = level; }
    expect(waterLevel(0.5, 0.05)).toBeCloseTo(waterLevel(0.5) + 0.05, 12);
  });

  it("grows pools without ever removing one: coverage rises monotonically with wetness", () => {
    let last = -1;
    const coverage: number[] = [];
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const c = share(f => wetMasks(f, w).puddle > 0.5);
      expect(c).toBeGreaterThanOrEqual(last - 1e-12);
      last = c; coverage.push(c);
    }
    expect(coverage[0]).toBe(0);
    expect(coverage[coverage.length - 1]!).toBeGreaterThan(0.15);
    // A pool present at lower wetness is still present at higher: the set only grows.
    for (const f of fields) if (wetMasks(f, 0.4).puddle > 0.5) expect(wetMasks(f, 0.7).puddle).toBeGreaterThan(0.5);
  });

  it("is dry at noon, damp at golden hour and slick at night, as the presets say", () => {
    const at = (preset: { roadSheen?: number }) => preset.roadSheen ?? 0;
    expect(share(f => wetMasks(f, at(NOON)).puddle > 0.05)).toBe(0);
    expect(wetMasks(0.5, at(NOON)).film).toBe(0);
    // Dry noon asphalt is untouched: no damp stains either, so it renders as it did before the sheen.
    expect(share(f => wetMasks(f, at(NOON)).damp > 0)).toBe(0);
    expect(share(f => wetMasks(f, at(GOLDEN)).puddle > 0.5)).toBeLessThan(0.02);
    const night = share(f => wetMasks(f, at(NIGHT)).puddle > 0.5);
    expect(night).toBeGreaterThan(0.03);
    expect(night).toBeLessThan(0.4);
    expect(wetMasks(0.5, at(NIGHT)).film).toBeGreaterThan(0.5);
  });

  it("darkens and smooths wet asphalt, never beyond the pool's albedo, and leaves dry asphalt alone", () => {
    const dry = { damp: 0, puddle: 0, film: 0 };
    expect(wetAlbedo(dry)).toBe(1);
    expect(wetRoughness(0.82, dry)).toBe(0.82);
    const pool = { damp: 1, puddle: 1, film: 1 };
    expect(wetAlbedo(pool)).toBeCloseTo(0.6 * 0.8, 12);
    expect(wetRoughness(0.82, pool)).toBeCloseTo(0.1, 12);
    for (const f of fields.slice(0, 500)) {
      const m = wetMasks(f, 0.62);
      expect(wetAlbedo(m)).toBeGreaterThanOrEqual(0.6 * 0.8 - 1e-12);
      expect(wetAlbedo(m)).toBeLessThanOrEqual(1);
      expect(wetRoughness(0.82, m)).toBeLessThanOrEqual(0.82);
    }
  });

  it("widens a pool's edge by the pixel footprint, so it is filtered and not aliased", () => {
    const edge = (softness: number): number => {
      let width = 0;
      for (let f = 0.3; f < 1; f += 0.0005) if (wetMasks(f, 0.62, 0, softness).puddle > 0.02 && wetMasks(f, 0.62, 0, softness).puddle < 0.98) width += 0.0005;
      return width;
    };
    expect(edge(0.05)).toBeGreaterThan(edge(0) * 2);
  });
});

describe("water's Fresnel (the reflection pass's weight; the lit surface stays dielectric)", () => {
  const pool = { damp: 1, puddle: 1, film: 1 }, film = { damp: 0, puddle: 0, film: 1 }, dry = { damp: 0, puddle: 0, film: 0 };
  it("does not reflect seen from above and mirrors at grazing angles", () => {
    expect(waterFresnel(1)).toBeCloseTo(0.02, 12);
    expect(waterFresnel(-1)).toBeCloseTo(0.02, 12);
    // From above a pool's weight (0.032) is under the cutoff (0.04), so the reflection pass skips it.
    expect(waterReflection(1, pool)).toBe(0);
    expect(waterReflection(0.05, pool)).toBeGreaterThan(0.7);
    expect(waterReflection(0.05, pool)).toBeLessThanOrEqual(REFLECT_MAX);
    let last = -1;
    for (let c = 1; c >= 0; c -= 0.02) { const m = waterReflection(c, pool); expect(m).toBeGreaterThanOrEqual(last - 1e-12); last = m; }
  });
  it("gives the film 60% of a pool's mirror at grazing angles and dry asphalt none", () => {
    expect(waterReflection(0.05, film)).toBeCloseTo(waterReflection(0.05, pool) * 0.6, 12);
    expect(waterReflection(0.05, dry)).toBe(0);
  });
  it("skips the film the camera looks down on: no reflection-pass cost on the road at the driver's feet", () => {
    // The night film, 10 m ahead of a camera 3 m up, is a ~17 degree grazing angle; 2 m ahead is steep.
    const night = wetMasks(0.3, 0.62);
    expect(waterReflection(Math.sin(Math.atan2(3, 2)), night)).toBe(0);
    expect(waterReflection(Math.sin(Math.atan2(3, 10)), night)).toBeGreaterThan(0.05);
  });
});

describe("the shader's skip", () => {
  it("skips the field only where every mask is exactly zero, so the skip never changes a pixel", () => {
    for (const w of [0, WATER_SKIP_BELOW / 2, WATER_SKIP_BELOW]) for (const f of fields.slice(0, 2000)) {
      expect(wetMasks(f, w, 0, 0.02)).toEqual({ damp: 0, puddle: 0, film: 0 });
    }
    // Noon is under it: the dry road pays nothing for the water.
    expect(NOON.roadSheen!).toBeLessThanOrEqual(WATER_SKIP_BELOW);
    expect(share(f => wetMasks(f, WATER_SKIP_BELOW + 0.05).damp > 0)).toBeGreaterThan(0);
  });
});

describe("lane paint in water", () => {
  it("darkens less than asphalt and turns glossy, and is untouched dry", () => {
    const dry = { damp: 0, puddle: 0, film: 0 }, pool = { damp: 1, puddle: 1, film: 1 };
    expect(paintAlbedo(dry)).toBe(1);
    expect(paintRoughness(dry)).toBe(PAINT_ROUGHNESS.dry);
    expect(paintAlbedo(pool)).toBeGreaterThan(wetAlbedo(pool));
    expect(paintRoughness(pool)).toBe(PAINT_ROUGHNESS.pool);
  });
});

describe("the time-of-day sheen", () => {
  it("is dry at noon and slick at night, following Slop New York's road wetness", () => {
    expect([NOON, GOLDEN, TWILIGHT, NIGHT].map(p => p.roadSheen)).toEqual([0.08, 0.28, 0.55, 0.62]);
  });

  it("follows the game clock smoothly and never leaves its keys' range", () => {
    expect(daylightAt(7, 1, 13).preset.roadSheen).toBe(0.08);
    expect(daylightAt(7, 1, 0.5).preset.roadSheen).toBe(0.62);
    let last = daylightAt(9, 15, 0).preset.roadSheen!, wettest = 0, driest = 1;
    for (let minute = 1; minute <= 24 * 60; minute++) {
      const w = daylightAt(9, 15, minute / 60).preset.roadSheen!;
      expect(w).toBeGreaterThanOrEqual(0.08 - 1e-9); expect(w).toBeLessThanOrEqual(0.62 + 1e-9);
      expect(Math.abs(w - last), `minute ${minute}`).toBeLessThan(0.03);
      last = w; wettest = Math.max(wettest, w); driest = Math.min(driest, w);
    }
    expect(wettest).toBeCloseTo(0.62, 2);
    expect(driest).toBeCloseTo(0.08, 2);
  });
});

describe("render only", () => {
  it("is never read by the simulation: no road sheen, render wetness uniform or road-water import appears under src/sim (the sim's own roadWetness(state) is a different thing)", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path); else if (/\.ts$/.test(name)) files.push(path);
      }
    };
    walk(join(import.meta.dirname, "../../src/sim"));
    expect(files.length).toBeGreaterThan(20);
    const banned = /roadSheen|road-water|gpuMaterialUniforms|\bsheen\b|fcWet|fcUniforms/;
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(banned);
  });
});
