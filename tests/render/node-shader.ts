// Builds a node material's fragment shader as WGSL or GLSL with three's own node builders on a stub
// renderer (no GPU, runs in Node), so tests can check the code the GPU would compile. Used by
// *-shader.test.ts. `target`: undefined draws to the canvas; null binds a plain render target (as
// the renderer's own output target does when there is no post pipeline); a node binds a render
// target with that scene MRT, as the scene pass renders.
import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";

export type ShaderLang = "wgsl" | "glsl";

type Builder = Record<string, unknown> & { build(): void; fragmentShader: string };
type BuilderClass = new (object: THREE.Object3D, renderer: unknown) => Builder;

export function fragmentShader(material: THREE.Material, geometry: THREE.BufferGeometry, lang: ShaderLang, target?: Node | null): string {
  (globalThis as { self?: unknown }).self ??= globalThis;
  const canvas = { getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {}, width: 1, height: 1 };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL: lang === "glsl" }) as THREE.WebGPURenderer & { hasFeature: () => boolean };
  renderer.hasFeature = () => false;
  if (target !== undefined) {
    renderer.setRenderTarget(new THREE.RenderTarget(1, 1, { count: target ? 3 : 1 }));
    renderer.setMRT(target as never);
  }
  const mesh = new THREE.Mesh(geometry, material), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  scene.add(mesh);
  const { WGSLNodeBuilder, GLSLNodeBuilder } = THREE as unknown as Record<string, BuilderClass>;
  const builder = new (lang === "glsl" ? GLSLNodeBuilder! : WGSLNodeBuilder!)(mesh, renderer);
  const lighting = (renderer as unknown as { lighting: { getNode(s: THREE.Scene, c: THREE.Camera): unknown } }).lighting;
  Object.assign(builder, { scene, camera, material, lightsNode: lighting.getNode(scene, camera) });
  builder.build();
  return builder.fragmentShader;
}

/** Each `if` block in the shader: its condition and body. */
export function ifBlocks(source: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const open = source.indexOf("{", match.index);
    const condition = source.slice(match.index + match[0].length, open);
    let depth = 0, end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    blocks.push({ condition, body: source.slice(open + 1, end) });
  }
  return blocks;
}

/** Derivatives and implicit-LOD texture samples: WGSL rejects them in non-uniform control flow. */
export const DERIVATIVE = /\b(fwidth|fwidthFine|fwidthCoarse|dpdx|dpdy|dpdxFine|dpdyFine|dpdxCoarse|dpdyCoarse|dFdx|dFdy|textureSample|textureSampleBias|texture)\s*\(/;

/**
 * Whether a branch condition reads only uniforms and constants: after removing uniform references
 * (WGSL `object.nodeUniformN`, `render.x`; GLSL `nodeUniformN`) and math built-ins, no identifier is left.
 */
export function isUniformCondition(condition: string): boolean {
  const rest = condition
    .replace(/\b(object|render)\.\w+/g, "")
    .replace(/\bnodeUniform\d+\b/g, "")
    .replace(/\b(max|min|clamp|abs|f32|float|vec[234]<f32>|vec[234])\s*(?=\()/g, "")
    .replace(/\b\d+(\.\d+)?(e[-+]?\d+)?\b/g, "");
  return !/[A-Za-z_]/.test(rest);
}
