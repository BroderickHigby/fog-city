import { describe, expect, it } from "vitest";
import { FloatType, HalfFloatType, PerspectiveCamera, Scene } from "three";
import { createGpuScenePass } from "../../src/render/gpu-engine.ts";

const renderer = { samples: 4, reversedDepthBuffer: true, getOutputBufferType: () => HalfFloatType };

describe("sampled scene depth on node renderer backends", () => {
  it("keeps WebGL scene depth single-sampled after PassNode setup so SSR needs no incompatible depth blit", () => {
    const scenePass = createGpuScenePass(new Scene(), new PerspectiveCamera(), "webgl-node");
    scenePass.setup({ renderer } as never);
    expect(scenePass.renderTarget.samples).toBe(0);
    expect(scenePass.renderTarget.depthBuffer).toBe(true);
    expect(scenePass.renderTarget.depthTexture?.type).toBe(FloatType);
    expect(scenePass.getTextureNode("depth").value).toBe(scenePass.renderTarget.depthTexture);
    // A resize/rebuild must not silently restore renderer-wide MSAA on this target.
    scenePass.setSize(800, 450);
    scenePass.setup({ renderer } as never);
    expect(scenePass.renderTarget.samples).toBe(0);
    expect(scenePass.renderTarget.resolveDepthBuffer).toBe(true);
    scenePass.dispose();
  });

  it("preserves native WebGPU MSAA and the sampled reversed-depth texture", () => {
    const scenePass = createGpuScenePass(new Scene(), new PerspectiveCamera(), "webgpu");
    scenePass.setup({ renderer } as never);
    expect(scenePass.renderTarget.samples).toBe(4);
    expect(scenePass.renderTarget.depthTexture?.type).toBe(FloatType);
    expect(scenePass.renderTarget.resolveDepthBuffer).toBe(true);
    scenePass.setup({ renderer: { ...renderer, samples: 8 } } as never);
    expect(scenePass.renderTarget.samples).toBe(8);
    scenePass.dispose();
  });
});
