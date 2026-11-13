// Polygon offset under the node renderer's reversed depth buffer (src/render/gpu-engine.ts
// flipDepthBiasForReversedDepth): a surface at -1/-1 (the turf, decals, contact shadows) must
// still be pulled toward the camera, on both backends. No browser.
import { describe, expect, it } from "vitest";
import { flipDepthBiasForReversedDepth } from "../../src/render/gpu-engine.ts";

const turf = () => ({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

describe("depth bias under reversed depth", () => {
  it("negates the offsets the WebGL2 fallback hands to gl.polygonOffset", () => {
    const calls: number[][] = [];
    const backend = { state: { setPolygonOffset: (_on: boolean, f: number, u: number) => { calls.push([f, u]); } } };
    flipDepthBiasForReversedDepth({ reversedDepthBuffer: true, backend });
    flipDepthBiasForReversedDepth({ reversedDepthBuffer: true, backend }); // twice is still once
    backend.state.setPolygonOffset(true, -1, -2);
    expect(calls).toEqual([[1, 2]]);
  });

  it("builds WebGPU pipelines with negated offsets and leaves the material as it was", () => {
    const seen: number[][] = [];
    const backend = { pipelineUtils: { createRenderPipeline: (o: { material: ReturnType<typeof turf> }) => { seen.push([o.material.polygonOffsetFactor, o.material.polygonOffsetUnits]); } } };
    flipDepthBiasForReversedDepth({ reversedDepthBuffer: true, backend });
    const material = turf(), plain = { ...turf(), polygonOffset: false };
    backend.pipelineUtils.createRenderPipeline({ material });
    backend.pipelineUtils.createRenderPipeline({ material: plain });
    expect(seen).toEqual([[1, 2], [-1, -2]]);
    expect(material).toEqual(turf());
  });

  it("changes nothing when the depth buffer is not reversed", () => {
    const calls: number[][] = [];
    const backend = { state: { setPolygonOffset: (_on: boolean, f: number, u: number) => { calls.push([f, u]); } } };
    flipDepthBiasForReversedDepth({ reversedDepthBuffer: false, backend });
    backend.state.setPolygonOffset(true, -1, -2);
    expect(calls).toEqual([[-1, -2]]);
  });
});
