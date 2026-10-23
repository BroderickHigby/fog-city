import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { packGeometry, packedMaterial, surfaceOf } from "../../src/render/agent-packing.ts";
import { installRuntimeRigging, mergeRuntimeAnimatedParts } from "../../src/render/runtime-rigging.ts";

describe("runtime shared-draw animation", () => {
  it("retains every triangle and the exact joint origins in a single animated geometry", () => {
    const source = new THREE.BoxGeometry(1, 2, 3), paint = new THREE.MeshStandardMaterial({ color: 0x557799 });
    const left = packGeometry(source, surfaceOf(paint), null, false), right = left.clone();
    const parts = mergeRuntimeAnimatedParts([
      { geometry: left, pivot: [-2, 3, 0], animation: "left-leg" },
      { geometry: right, pivot: [2, 3, 0], animation: "right-leg" },
    ]);
    expect(parts).toHaveLength(1); expect(parts[0]!.geometry.index!.count).toBe(source.index!.count * 2);
    const count = source.getAttribute("position").count, joints = parts[0]!.geometry.getAttribute("fcJoint");
    expect([joints.getX(0), joints.getY(0), joints.getZ(0), joints.getW(0)]).toEqual([-2, 3, 0, 1]);
    expect([joints.getX(count), joints.getY(count), joints.getZ(count), joints.getW(count)]).toEqual([2, 3, 0, 2]);
    expect(Array.from(parts[0]!.geometry.getAttribute("position").array).slice(0, count * 3)).toEqual(Array.from(left.getAttribute("position").array));
    expect(left.getAttribute("fcJoint")).toBeUndefined();
    parts[0]!.geometry.dispose(); left.dispose(); right.dispose(); source.dispose(); paint.dispose();
  });

  it("keeps a texture-bearing panel on its own material and unchanged UVs", () => {
    const shape = new THREE.PlaneGeometry(2, 1), texture = new THREE.Texture(), panel = new THREE.MeshStandardMaterial({ map: texture });
    const part = { geometry: shape, pivot: [1, 2, 3] as const, animation: "fixed" as const, material: panel };
    const merged = mergeRuntimeAnimatedParts([part]);
    expect(merged).toEqual([part]); expect(merged[0]!.geometry.getAttribute("uv")).toBe(shape.getAttribute("uv"));
    shape.dispose(); panel.dispose(); texture.dispose();
  });

  it("installs the same deformation and live tick uniform on visible and shadow materials", () => {
    const time = { value: 0 }, materials = [packedMaterial(false), new THREE.MeshDepthMaterial(), new THREE.MeshDistanceMaterial()];
    const libraries = [THREE.ShaderLib.standard, THREE.ShaderLib.depth, THREE.ShaderLib.distance];
    for (let index = 0; index < materials.length; index++) {
      const material = materials[index]!, library = libraries[index]!;
      installRuntimeRigging(material, time);
      expect(library.vertexShader).toContain("#include <common>");
      expect(library.vertexShader).toContain("#include <beginnormal_vertex>");
      expect(library.vertexShader).toContain("#include <begin_vertex>");
      const shader = { uniforms: THREE.UniformsUtils.clone(library.uniforms), vertexShader: library.vertexShader,
        fragmentShader: library.fragmentShader, defines: {} } as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.uniforms.fcRuntimeTime).toBe(time);
      expect(shader.vertexShader).toContain("objectNormal = fcJointRotation() * objectNormal;");
      expect(shader.vertexShader).toContain("transformed = fcJoint.xyz + fcJointRotation() * transformed;");
      expect(material.customProgramCacheKey()).toContain("fc-runtime-rig:v1");
      material.dispose();
    }
  });
});
