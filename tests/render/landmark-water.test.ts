import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { heightOnField, type TileCollider } from "../../src/sim/world.ts";
import { createLandmarkWater, PALACE_LAGOON } from "../../src/render/landmark-water.ts";

describe("Palace lagoon", () => {
  it("shares the legacy sea's changing sky and clock, with its own shoreline depth bias", () => {
    const sea = new THREE.ShaderMaterial({ uniforms: {
      uTime: { value: 0 }, uSun: { value: 1 }, uBodyLight: { value: 1 }, uDepthDrop: { value: .12 },
    } });
    const lagoon = createLandmarkWater("sf", sea)!;
    const material = lagoon.material as THREE.ShaderMaterial;
    try {
      for (const name of ["uTime", "uSun", "uBodyLight"]) expect(material.uniforms[name]).toBe(sea.uniforms[name]);
      expect(material.uniforms.uDepthDrop).not.toBe(sea.uniforms.uDepthDrop);
      expect(material.uniforms.uDepthDrop!.value).toBe(.005);
      sea.uniforms.uTime!.value = 42;
      expect(material.uniforms.uTime!.value).toBe(42);
    } finally { lagoon.geometry.dispose(); material.dispose(); sea.dispose(); }
  });
  it("follows the existing low basin without painting over raised surrounding paths", () => {
    const tile = JSON.parse(readFileSync("public/tiles/sf/t-10_-2.collider.json", "utf8")) as TileCollider;
    const field = tile.ground!;
    for (const [x, z] of PALACE_LAGOON.ring) {
      expect(heightOnField(field, x!, z!)).toBeCloseTo(PALACE_LAGOON.shoreContourM, 4);
      expect(x!).toBeGreaterThan(-4840); expect(x!).toBeLessThan(-4700);
      expect(z!).toBeGreaterThan(-960); expect(z!).toBeLessThan(-720);
    }
    const source = new THREE.MeshStandardMaterial();
    const mesh = createLandmarkWater("sf", source)!;
    try {
      mesh.updateMatrixWorld(true);
      const hit = (x: number, z: number) => new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0)).intersectObject(mesh);
      expect(hit(-4750, -821)[0]?.point.y).toBeCloseTo(1.5);
      expect(hit(-4818.56, -823.93)).toHaveLength(0); // Open rotunda stays dry.
      expect(hit(-4690, -821)).toHaveLength(0); // Baker Street side stays dry.
      expect(mesh.geometry.getAttribute("position").count).toBeLessThan(200);
      expect(mesh.geometry.index!.count / 3).toBeLessThan(200);
      expect(source.version).toBe(0);
      expect(mesh.material).not.toBe(source);
      expect(createLandmarkWater("test", source)).toBeNull();
    } finally { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); source.dispose(); }
  });
});
