// Optional WebGL presentation pass, inspired by Slop New York's restrained HDR grade.
// Lighting and presentation only: this module never reads or writes simulation state.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { fcUniforms } from "./materials.ts";
import type { LightingPreset } from "./sky.ts";

export interface PresentationLook {
  contrast: number;
  saturation: number;
  balance: readonly [number, number, number];
  bloom: number;
  bloomThreshold: number;
}

const LOOKS: Readonly<Record<string, PresentationLook>> = Object.freeze({
  day: { contrast: 1.12, saturation: 1.08, balance: [1.045, 1, 0.955], bloom: 0.24, bloomThreshold: 1.2 },
  golden: { contrast: 1.12, saturation: 1.08, balance: [1.045, 1, 0.955], bloom: 0.24, bloomThreshold: 1.2 },
  noon: { contrast: 1.1, saturation: 1.06, balance: [1.015, 1, 0.985], bloom: 0.18, bloomThreshold: 1.35 },
  twilight: { contrast: 1.1, saturation: 1.08, balance: [1.025, 0.995, 1.015], bloom: 0.28, bloomThreshold: 1.05 },
  night: { contrast: 1.08, saturation: 1.06, balance: [0.985, 1, 1.035], bloom: 0.3, bloomThreshold: 1.0 },
});
export function presentationLook(name: LightingPreset["name"]): PresentationLook { return LOOKS[name]!; }

const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.08 },
    saturation: { value: 1.04 },
    balance: { value: new THREE.Vector3(1.025, 1, 0.98) },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 balance;
    uniform float aspect;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = max(texel.rgb * balance, vec3(0.0));
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, saturation);
      c *= pow(max(luma, 0.0001) / 0.18, contrast - 1.0);
      float radius = length((vUv - 0.5) * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
      c *= 1.0 - 0.06 * smoothstep(0.4, 1.0, radius);
      gl_FragColor = vec4(max(c, vec3(0.0)), texel.a);
    }
  `,
};

/**
 * Render the scene to a linear target, grade and bloom it, then apply ACES/output transfer
 * exactly once through OutputPass. FXAA runs after output because it expects display RGB.
 * The normal direct renderer remains valid when this class is not instantiated.
 */
export class VisualQuality {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scenePass: RenderPass;
  private readonly grade: ShaderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly output: OutputPass;
  private readonly fxaa: ShaderPass;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    const floatColor = renderer.extensions.has("EXT_color_buffer_float");
    const target = new THREE.WebGLRenderTarget(1, 1, { type: floatColor ? THREE.HalfFloatType : THREE.UnsignedByteType });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.composer = new EffectComposer(renderer, target);
    this.scenePass = new RenderPass(scene, camera);
    this.grade = new ShaderPass(GRADE);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.15, 0.35, 1.3);
    this.bloom.enabled = floatColor;
    this.output = new OutputPass();
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.fxaa);
    const size = renderer.getSize(new THREE.Vector2());
    this.resize(size.x, size.y);
  }

  setPreset(preset: LightingPreset, look: PresentationLook = presentationLook(preset.name)): void {
    this.grade.uniforms.contrast!.value = look.contrast;
    this.grade.uniforms.saturation!.value = look.saturation;
    (this.grade.uniforms.balance!.value as THREE.Vector3).set(...look.balance);
    this.bloom.strength = look.bloom;
    this.bloom.threshold = look.bloomThreshold;
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    const w = Math.max(1, width), h = Math.max(1, height);
    const ratio = Math.min(2, this.renderer.getPixelRatio());
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.grade.uniforms.aspect!.value = w / h;
    (this.fxaa.uniforms.resolution!.value as THREE.Vector2).set(1 / (w * ratio), 1 / (h * ratio));
  }

  render(deltaSeconds: number): void {
    if (this.disposed) return;
    const previousLinear = fcUniforms.fcLinearOutput.value;
    const previousReset = this.renderer.info.autoReset;
    fcUniforms.fcLinearOutput.value = 1;
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    try { this.composer.render(Math.max(0, deltaSeconds)); }
    finally {
      fcUniforms.fcLinearOutput.value = previousLinear;
      this.renderer.info.autoReset = previousReset;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scenePass.dispose();
    this.grade.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.fxaa.dispose();
    this.composer.dispose();
  }
}
