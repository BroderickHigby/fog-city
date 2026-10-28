// The wet road and lane paint (node-materials.ts) as the GPU sees them: built to WGSL and GLSL with
// three's node builders on a stub renderer (tests/render/node-shader.ts). The water work sits in a
// branch on uniforms only, so the dry road skips it and its fwidth stays legal on WebGPU; the lit road
// is dielectric and the water's Fresnel goes to the reflection pass's metalRough output instead.
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { mrt, normalView, output } from "three/tsl";
import { prepareGpuScene, sceneMetalRough, setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";
import { DERIVATIVE, fragmentShader, ifBlocks, isUniformCondition } from "./node-shader.ts";

function cityMaterial(name: string): [THREE.Material, THREE.BufferGeometry] {
  setGpuMaterialsEnabled(true);
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name })));
  prepareGpuScene(group);
  return [(group.children[0] as THREE.Mesh).material as THREE.Material, geometry];
}

describe.each(["wgsl", "glsl"] as const)("wet road shaders in %s", lang => {
  it.each(["fc:road", "fc:road-paint"])("%s: the water work is skipped on uniforms only, with no derivative under a per-pixel branch", name => {
    const [material, geometry] = cityMaterial(name);
    const source = fragmentShader(material, geometry, lang);
    const blocks = ifBlocks(source);
    for (const block of blocks) if (DERIVATIVE.test(block.body)) expect(isUniformCondition(block.condition), `if (${block.condition}) holds a derivative`).toBe(true);
    // The skip itself: a uniform branch that holds the field's fwidth (rain or sheen above its first ramp).
    expect(blocks.some(b => isUniformCondition(b.condition) && /\bfwidth\s*\(/.test(b.body) && /0\.08\b/.test(b.condition))).toBe(true);
  });

  it("fc:road: the lit surface is dielectric (no metalness), so lamps and headlights still light wet asphalt", () => {
    const [material, geometry] = cityMaterial("fc:road");
    expect(fragmentShader(material, geometry, lang)).toMatch(/\bMetalness = 0\.0;/);
  });
});

describe("the wet road's reflection weight", () => {
  type WithMrt = { mrtNode: { outputNodes: Record<string, unknown> } | null };
  it("goes to the scene pass's metalRough output when the scene MRT is bound", () => {
    const [material, geometry] = cityMaterial("fc:road");
    fragmentShader(material, geometry, "wgsl", mrt({ output, normal: normalView, metalRough: sceneMetalRough() }));
    expect(Object.keys((material as unknown as WithMrt).mrtNode!.outputNodes)).toEqual(["metalRough"]);
  });
  it("adds no MRT of its own without one, so a plain render target still gets the road's colour", () => {
    // three uses a material's MRT alone when a render target is bound with no scene MRT, which drew no road.
    for (const target of [null, undefined]) {
      const [material, geometry] = cityMaterial("fc:road");
      fragmentShader(material, geometry, "glsl", target);
      expect((material as unknown as WithMrt).mrtNode).toBeNull();
    }
  });
});

describe("the uniform-condition check", () => {
  it("accepts uniforms and constants and rejects anything per pixel", () => {
    expect(isUniformCondition(" ( max( object.nodeUniform2, object.nodeUniform3 ) > 0.08 ) ")).toBe(true);
    expect(isUniformCondition(" ( max( nodeUniform2, nodeUniform3 ) > 0.08 ) ")).toBe(true);
    expect(isUniformCondition(" ( nodeVar140 > 0.0 ) && ( object.nodeUniform4 > 0.0 ) ")).toBe(false);
    expect(isUniformCondition(" ( v_positionWorld.y > 2.0 ) ")).toBe(false);
  });
});
