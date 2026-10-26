import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { windowProfileRect } from "../../src/render/building-window-profile.ts";
import { createSharedMaterials, fcUniforms } from "../../src/render/materials.ts";
import { facadeGrid } from "../../src/render/tile-geometry.ts";

describe("architectural openings shared by geometry and the building material", () => {
  it("keeps all five families' openings finite, inside their source cells and above their sills", () => {
    for (const storey of [2.6, 3.3, 4, 8]) for (const glazing of [0.05, 0.15, 0.25, 0.5, 0.85, 1]) {
      const grid = facadeGrid(storey, glazing), original = [...grid.win];
      for (let family = 0; family < 5; family++) for (const seed of [0, 0.33, 1]) {
        const win = windowProfileRect(Object.freeze(grid.win), family, seed);
        expect(win.every(Number.isFinite)).toBe(true);
        expect(win[0]).toBeGreaterThanOrEqual(0);
        expect(win[1]).toBeLessThanOrEqual(1);
        expect(win[1] - win[0]).toBeGreaterThan(0.1);
        expect(win[2]).toBeGreaterThanOrEqual(0);
        expect(win[3]).toBeLessThanOrEqual(1);
        expect(win[3] - win[2]).toBeGreaterThanOrEqual(0.12);
        // Floor/column spacing and the original source rectangle are never changed.
        expect(grid.win).toEqual(original);
        expect(grid.floorH).toBe(storey);
      }
    }
  });

  it("gives neighboring architectural families distinct repeatable openings without altering legacy cells", () => {
    const base = Object.freeze(facadeGrid(3.8, 0.5).win);
    const profiles = Array.from({ length: 5 }, (_, family) => windowProfileRect(base, family, 0.37));
    expect(new Set(profiles.map(win => win.map(v => v.toFixed(4)).join(","))).size).toBe(5);
    for (let family = 0; family < 5; family++) expect(windowProfileRect(base, family, 0.37)).toEqual(profiles[family]);
    const legacy = windowProfileRect(base, -1, 0.37);
    expect(legacy).toEqual(base);
    expect(legacy).not.toBe(base);
    expect(windowProfileRect(base, 7, 0.37)).toEqual(base);
  });

  it("keeps old geometry's missing attributes safe and night updates uniform-driven for both normal paths", () => {
    const materials = createSharedMaterials();
    try {
      const keys = [];
      for (const material of [materials.building, materials.buildingFlat]) {
        const defaults = (material as THREE.MeshStandardMaterial & { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues;
        expect(defaults._building).toEqual([-1, 0, 0, -1]);
        expect(defaults._facade).toEqual([0, 0, 0, 1]);
        const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
          fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
        material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
        expect(shader.uniforms.fcNight).toBe(fcUniforms.fcNight);
        const version = material.version, key = material.customProgramCacheKey();
        const old = fcUniforms.fcNight.value;
        fcUniforms.fcNight.value = 1;
        expect(shader.uniforms.fcNight!.value).toBe(1);
        expect(material.version).toBe(version);
        expect(material.customProgramCacheKey()).toBe(key);
        fcUniforms.fcNight.value = old;
        expect(material.map).toBeNull();
        keys.push(key);
      }
      // Families travel as vertex data through one shared program, not one material per building.
      expect(keys[0]).toBe(keys[1]);
    } finally {
      for (const material of materials.all) material.dispose();
    }
  });
});
