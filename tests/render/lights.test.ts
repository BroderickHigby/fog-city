// Night lights: every light_* material (assets/blender/README.md) is near 0 by day and up at
// night; nightLight-only nodes are hidden by day; the agent shader's channels follow the same table.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  LIGHT_NIGHT_INTENSITY,
  NightLights,
  channelIntensities,
  channelRatio,
  isLightMaterial,
  lightBaseName,
  lightChannel,
  lightIntensity,
  nightNodeVisible,
} from "../../src/render/lights.ts";
import { ROOT } from "../helpers.ts";

/** Material names of a .glb, from its JSON chunk (no three.js, no decoder). */
function glbMaterials(file: string): string[] {
  const buf = readFileSync(file);
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file}: first chunk is not JSON`);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString("utf8")) as { materials?: Array<{ name?: string }> };
  return (json.materials ?? []).map((m) => m.name ?? "");
}

/** Every light material base name the committed models use, by file (assets/blender/README.md). */
const MODEL_DIR = join(ROOT, "public/models");
const LIGHTS_BY_MODEL = new Map(
  readdirSync(MODEL_DIR)
    .filter((f) => f.endsWith(".glb"))
    .sort()
    .map((f) => [f, [...new Set(glbMaterials(join(MODEL_DIR, f)).filter(isLightMaterial).map(lightBaseName))].sort()] as const),
);
const MODEL_LIGHTS = [...new Set([...LIGHTS_BY_MODEL.values()].flat())].sort();

describe("light scaling", () => {
  it("has a night level for exactly the light materials the committed models use", () => {
    // Read from public/models, so a remodel that renames a light (wave 2: the Trundle's
    // light_eyes became light_face) or adds one (light_accent, the kiosk lights) shows here.
    expect(MODEL_LIGHTS.length).toBeGreaterThan(8);
    for (const name of MODEL_LIGHTS) expect(LIGHT_NIGHT_INTENSITY[name], `${name} has no night level`).toBeGreaterThan(0);
    for (const name of Object.keys(LIGHT_NIGHT_INTENSITY)) expect(MODEL_LIGHTS, `${name}: no committed model uses it`).toContain(name);
    expect(LIGHTS_BY_MODEL.get("sidewalk-bot.glb")).toEqual(["light_face"]);
    expect(LIGHTS_BY_MODEL.get("robotaxi.glb")).toEqual(["light_headlight", "light_status", "light_taillight"]);
  });

  it("knows every light material the models use", () => {
    for (const name of MODEL_LIGHTS) {
      expect(isLightMaterial(name), name).toBe(true);
      expect(LIGHT_NIGHT_INTENSITY[name], name).toBeGreaterThan(0);
    }
    expect(isLightMaterial("paint_white")).toBe(false);
    expect(isLightMaterial("light_headlight.001")).toBe(true);
    expect(lightBaseName("light_face.002")).toBe("light_face");
  });

  it("is near 0 by day and well up at night, for every light", () => {
    for (const name of MODEL_LIGHTS) {
      expect(lightIntensity(name, 0), name).toBeLessThanOrEqual(0.05);
      expect(lightIntensity(name, 1), name).toBeGreaterThanOrEqual(0.5);
      expect(lightIntensity(name, 0.5)).toBeGreaterThan(lightIntensity(name, 0));
      expect(lightIntensity(name, 0.5)).toBeLessThan(lightIntensity(name, 1));
    }
  });

  it("never lights a material that is not a light, and clamps the night factor", () => {
    expect(lightIntensity("paint", 1)).toBe(0);
    expect(lightIntensity("light_headlight", 7)).toBe(lightIntensity("light_headlight", 1));
    expect(lightIntensity("light_headlight", -3)).toBe(lightIntensity("light_headlight", 0));
    expect(lightIntensity("light_headlight", Number.NaN)).toBe(lightIntensity("light_headlight", 0));
  });

  it("shows nightLight nodes only at night", () => {
    expect(nightNodeVisible(0)).toBe(false);
    expect(nightNodeVisible(1)).toBe(true);
  });

  it("sorts lights into the agent shader's channels: head, tail (brake), status", () => {
    expect(lightChannel("paint")).toBe(0);
    expect(lightChannel("light_headlight")).toBe(1);
    expect(lightChannel("light_taillight")).toBe(2);
    for (const n of ["light_status", "light_face", "light_destination_sign", "light_accent", "light_kiosk_screen", "light_kiosk_status"]) expect(lightChannel(n), n).toBe(3);
    expect(channelIntensities(0)).toEqual([0, 0, 0]);
    expect(channelIntensities(1)).toEqual([lightIntensity("light_headlight", 1), lightIntensity("light_taillight", 1), lightIntensity("light_status", 1)]);
  });
});

describe("agent light channels", () => {
  it("keep each light material's own night level through its channel ratio", () => {
    for (const name of MODEL_LIGHTS) {
      const ch = lightChannel(name);
      if (ch === 0) continue;
      for (const night of [0, 0.25, 0.5, 1]) {
        expect(channelRatio(name) * channelIntensities(night)[ch - 1]!, `${name} at ${night}`).toBeCloseTo(lightIntensity(name, night), 9);
      }
    }
    // The status channel runs at light_status's level; faces and signs keep theirs.
    expect(channelRatio("light_status")).toBe(1);
    expect(channelRatio("light_face")).toBeCloseTo(LIGHT_NIGHT_INTENSITY.light_face! / LIGHT_NIGHT_INTENSITY.light_status!, 12);
    expect(channelRatio("light_destination_sign")).toBeGreaterThan(1);
    expect(channelRatio("paint")).toBe(0);
  });
});

describe("NightLights", () => {
  function model(): { root: THREE.Group; head: THREE.MeshStandardMaterial; paint: THREE.MeshStandardMaterial; glow: THREE.Mesh } {
    const head = new THREE.MeshStandardMaterial({ name: "light_headlight", emissive: 0xffffff, emissiveIntensity: 1 });
    const paint = new THREE.MeshStandardMaterial({ name: "paint", emissive: 0x000000, emissiveIntensity: 1 });
    const glowMat = new THREE.MeshStandardMaterial({ name: "light_sculpture_glow", emissive: 0xaa88ff, emissiveIntensity: 1 });
    const root = new THREE.Group();
    const g = new THREE.BoxGeometry();
    const glow = new THREE.Mesh(g, glowMat);
    glow.userData = { nightLight: true };
    root.add(new THREE.Mesh(g, head), new THREE.Mesh(g, paint), glow);
    return { root, head, paint, glow };
  }

  it("scales tracked light materials and nightLight nodes, and leaves the rest alone", () => {
    const lights = new NightLights();
    const m = model();
    lights.track(m.root);
    expect(lights.count).toBe(2);
    expect(m.head.emissiveIntensity).toBe(lightIntensity("light_headlight", 0));
    expect(m.glow.visible).toBe(false);
    lights.setNight(1);
    expect(m.head.emissiveIntensity).toBe(lightIntensity("light_headlight", 1));
    expect(m.paint.emissiveIntensity).toBe(1);
    expect(m.glow.visible).toBe(true);
    lights.setNight(0);
    expect(m.head.emissiveIntensity).toBeLessThanOrEqual(0.05);
    expect(m.glow.visible).toBe(false);
  });

  it("applies the current night to models tracked later, and forgets untracked ones", () => {
    const lights = new NightLights();
    lights.setNight(1);
    const m = model();
    lights.track(m.root);
    expect(m.head.emissiveIntensity).toBe(lightIntensity("light_headlight", 1));
    lights.untrack(m.root);
    expect(lights.count).toBe(0);
    lights.setNight(0);
    expect(m.head.emissiveIntensity).toBe(lightIntensity("light_headlight", 1));
  });
});
