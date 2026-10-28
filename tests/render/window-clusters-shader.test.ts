// The distant-window cluster branch (node-materials.ts, gpu-special.ts) as the GPU sees it: the
// far-cell and building materials are built to WGSL and GLSL with three's own node builders on a
// stub renderer (no GPU). WGSL rejects derivatives and implicit-LOD texture samples in non-uniform
// control flow, and the building's branch condition is per pixel, so a derivative that drifted into
// it would compile on WebGL and fail only on WebGPU. Nothing here draws.
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { createFarNodeMaterial } from "../../src/render/gpu-special.ts";
import { prepareGpuScene, setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";

type Lang = "wgsl" | "glsl";

function fragmentShader(material: THREE.Material, geometry: THREE.BufferGeometry, lang: Lang): string {
  (globalThis as { self?: unknown }).self ??= globalThis;
  const canvas = { getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {}, width: 1, height: 1 };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL: lang === "glsl" }) as THREE.WebGPURenderer & { hasFeature: () => boolean };
  renderer.hasFeature = () => false;
  const mesh = new THREE.Mesh(geometry, material), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  scene.add(mesh);
  const { WGSLNodeBuilder, GLSLNodeBuilder } = THREE as unknown as Record<string, new (o: THREE.Object3D, r: unknown) => Record<string, unknown> & { build(): void; fragmentShader: string }>;
  const builder = new (lang === "glsl" ? GLSLNodeBuilder! : WGSLNodeBuilder!)(mesh, renderer);
  Object.assign(builder, { scene, camera, material, lightsNode: (renderer as unknown as { lighting: { getNode(s: THREE.Scene, c: THREE.Camera): unknown } }).lighting.getNode(scene, camera) });
  builder.build();
  return builder.fragmentShader;
}

function farMaterial(): [THREE.Material, THREE.BufferGeometry] {
  return [createFarNodeMaterial(new THREE.DataTexture(new Uint8Array(4), 1, 1), new THREE.Vector4(0, 0, 1, 1)), new THREE.BoxGeometry()];
}

function buildingMaterial(): [THREE.Material, THREE.BufferGeometry] {
  setGpuMaterialsEnabled(true);
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("_building", new THREE.BufferAttribute(new Float32Array(24 * 4), 4));
  geometry.setAttribute("_facade", new THREE.BufferAttribute(new Float32Array(24 * 4), 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
  const source = new THREE.MeshStandardMaterial({ name: "fc:building" });
  source.userData.fcKind = "building";
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, source));
  prepareGpuScene(group);
  const material = (group.children[0] as THREE.Mesh).material as THREE.Material;
  expect(material.userData.fcGpuKind).toBe("building");
  return [material, geometry];
}

/** Bodies of every `if` block whose body runs the cluster octaves (the only log2 in these shaders' branches). */
function clusterBranches(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const open = source.indexOf("{", match.index);
    let depth = 0, end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    const body = source.slice(open + 1, end);
    if (/\blog2\s*\(/.test(body)) bodies.push(body);
  }
  return bodies;
}

const DERIVATIVE = /\b(fwidth|fwidthFine|fwidthCoarse|dpdx|dpdy|dpdxFine|dpdyFine|dpdxCoarse|dpdyCoarse|dFdx|dFdy|textureSample|textureSampleBias|texture)\s*\(/;

describe.each(["wgsl", "glsl"] as const)("distant window clusters in %s", lang => {
  it.each([["far skyline cells", farMaterial], ["tile buildings", buildingMaterial]] as const)("%s run the cluster work in a branch with no derivative inside", (_name, make) => {
    const [material, geometry] = make();
    const source = fragmentShader(material, geometry, lang);
    const branches = clusterBranches(source);
    // The innermost block holding log2 is the cluster branch; an outer one may wrap it (none today).
    expect(branches.length).toBeGreaterThan(0);
    for (const body of branches) expect(body.match(DERIVATIVE)?.[0] ?? null).toBeNull();
    // The footprint it reads is a derivative taken before the branch.
    expect(source.slice(0, source.indexOf(branches[0]!))).toMatch(/\bfwidth\s*\(/);
  });
});
