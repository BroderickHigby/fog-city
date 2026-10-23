// Types for n8ao (it ships none): the parts post.ts uses.
declare module "n8ao" {
  import type * as THREE from "three";
  import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
  export class N8AOPass extends Pass {
    constructor(scene: THREE.Scene, camera: THREE.Camera, width?: number, height?: number);
    configuration: {
      aoSamples: number;
      aoRadius: number;
      denoiseSamples: number;
      denoiseRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: THREE.Color;
      gammaCorrection: boolean;
      screenSpaceRadius: boolean;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
      transparencyAware: boolean;
      accumulate: boolean;
    };
    beautyRenderTarget: THREE.WebGLRenderTarget;
    setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
    setSize(width: number, height: number): void;
    dispose(): void;
  }
}
