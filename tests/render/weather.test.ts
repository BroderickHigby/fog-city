// Weather presentation (src/render/weather.ts): the light the sim's weather makes, the King
// tide's water sheet, and the rain, puddles and wetness the layer draws.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { fcUniforms } from "../../src/render/materials.ts";
import { GOLDEN, NIGHT } from "../../src/render/sky.ts";
import { CLEAR_WEATHER, FOG_THICK, PUDDLES_MAX, WeatherLayer, tideGeometry, weatherKey, weatherLight, type TideStrip } from "../../src/render/weather.ts";

describe("weatherLight", () => {
  it("is the preset itself in clear weather", () => {
    expect(weatherLight(GOLDEN, { fog: 0, rain: 0 })).toBe(GOLDEN);
  });

  it("thickens and greys the fog with the marine layer, and dims the sun", () => {
    const fog = weatherLight(GOLDEN, { fog: 1, rain: 0 });
    expect(fog.fog.density).toBeCloseTo(GOLDEN.fog.density * FOG_THICK);
    expect(fog.sunIntensity).toBeLessThan(GOLDEN.sunIntensity * 0.5);
    const c = new THREE.Color(fog.fogColor), base = new THREE.Color(GOLDEN.fogColor);
    // Greyer: the channels closer together.
    expect(Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)).toBeLessThan(Math.max(base.r, base.g, base.b) - Math.min(base.r, base.g, base.b));
  });

  it("flattens the sky in rain: no sun disc, heavy cloud, lower exposure", () => {
    const rain = weatherLight(GOLDEN, { fog: 0, rain: 1 });
    expect(rain.sunDisc).toBe(0);
    expect(rain.cloudCoverage).toBeCloseTo(0.95);
    expect(rain.exposure).toBeLessThan(GOLDEN.exposure);
    expect(rain.fog.density).toBeGreaterThan(GOLDEN.fog.density);
  });

  it("keeps the night dark: fog greys only toward a dim marine layer", () => {
    const night = weatherLight(NIGHT, { fog: 1, rain: 0 });
    expect(new THREE.Color(night.fogColor).getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(0.3);
  });

  it("keys environment maps in quarter steps", () => {
    expect(weatherKey({ fog: 0, rain: 0 })).toBe(weatherKey({ fog: 0.1, rain: 0.05 }));
    expect(weatherKey({ fog: 0.5, rain: 0 })).not.toBe(weatherKey({ fog: 0, rain: 0 }));
  });
});

const strip: TideStrip = { line: [[0, 0], [0, -100]], nearM: 8, farM: 34, floods: (x, z) => !(z < -40 && z > -60) };

describe("tideGeometry", () => {
  it("lies left of travel between the near and far offsets, on the ground, skipping piers", () => {
    const g = tideGeometry(strip, (x) => 2 + x * 0.01);
    const p = g.getAttribute("position");
    expect(p.count).toBeGreaterThan(0);
    for (let i = 0; i < p.count; i++) {
      // Travelling north (-z), left is west (-x).
      expect(p.getX(i)).toBeLessThanOrEqual(-8 + 1e-6);
      expect(p.getX(i)).toBeGreaterThanOrEqual(-34 - 1e-6);
      expect(p.getY(i)).toBeCloseTo(2 + p.getX(i) * 0.01);
    }
    let inPier = 0;
    for (let i = 0; i < p.count; i += 3) {
      const cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
      if (cz < -42 && cz > -58) inPier++;
    }
    expect(inPier).toBe(0);
  });
});

describe("WeatherLayer", () => {
  const camera = new THREE.PerspectiveCamera();

  it("draws nothing in clear weather", () => {
    const layer = new WeatherLayer(strip, () => 0);
    layer.update(CLEAR_WEATHER, camera, 0, 0);
    expect(layer.info).toEqual({ rain: false, puddles: 0, tideM: 0 });
    expect(fcUniforms.fcWet.value).toBe(0);
    layer.dispose();
  });

  it("rains except under shelter, wets the ground and shows puddles only on a wet road", () => {
    const layer = new WeatherLayer(null, () => 0);
    const puddles = Array.from({ length: PUDDLES_MAX + 5 }, (_, i) => ({ id: `p${i}`, x: i, y: 0, z: 0, radius: 1.2 }));
    layer.update({ ...CLEAR_WEATHER, rain: 1, wetness: 0.8, puddles }, camera, 1, 0);
    expect(layer.info.rain).toBe(true);
    expect(layer.info.puddles).toBe(PUDDLES_MAX);
    expect(fcUniforms.fcWet.value).toBeCloseTo(0.8);
    layer.update({ ...CLEAR_WEATHER, rain: 1, wetness: 0.8, sheltered: true, puddles }, camera, 1, 0);
    expect(layer.info.rain).toBe(false);
    layer.update({ ...CLEAR_WEATHER, wetness: 0.2, puddles }, camera, 1, 0);
    expect(layer.info.puddles).toBe(0);
    layer.update(CLEAR_WEATHER, camera, 1, 0);
    expect(fcUniforms.fcWet.value).toBe(0);
    layer.dispose();
  });

  it("raises the tide sheet by the depth and hides it when the tide is out", () => {
    const layer = new WeatherLayer(strip, () => 0);
    layer.update({ ...CLEAR_WEATHER, tide: 0.1 }, camera, 0, 0);
    expect(layer.info.tideM).toBeCloseTo(0.1);
    const sheet = layer.root.getObjectByName("weather:tide")!;
    expect(sheet.position.y).toBeCloseTo(0.1);
    layer.update({ ...CLEAR_WEATHER, tide: 0.105 }, camera, 0, 0);
    expect(sheet.position.y).toBeCloseTo(0.1); // under a centimetre: not moved
    layer.update(CLEAR_WEATHER, camera, 0, 0);
    expect(layer.info.tideM).toBe(0);
    expect(sheet.visible).toBe(false);
    layer.dispose();
  });
});
