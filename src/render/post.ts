// The high tier's post-processing (gfx.ts): the scene renders into a multisampled half-float
// target with a depth texture; N8AO (screen-space ambient occlusion from that depth alone, half
// resolution, depth-aware upsampling, denoised) darkens contact and corners; bloom lifts what is
// brighter than the sky (lit windows, lamps, the sun's glint on the Bay); and the output pass
// applies the renderer's tone mapping and sRGB once at the end. The default tier never builds
// this: it renders straight to the canvas as before.
//
// N8AO replaces three's GTAOPass, which rendered the whole frame black under this city's 0.5 m to
// 20 km depth range and needs a second render of the scene for normals; N8AO reconstructs normals
// from depth, so it costs no extra draw calls. The governor (gfx.ts) still drops the chain first.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { N8AOPass } from "n8ao";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/** Bloom by day and by night: night lets lit windows and lamps glow. */
const BLOOM = {
  day: { strength: 0.18, radius: 0.35, threshold: 0.92 },
  night: { strength: 0.75, radius: 0.55, threshold: 0.55 },
};

export class PostChain {
  readonly composer: EffectComposer;
  private readonly ao: N8AOPass | null;
  private readonly bloom: UnrealBloomPass | null;
  private readonly renderer: THREE.WebGLRenderer;

  /** `off`: passes to leave out ("ao", "bloom"), for A/B comparisons. */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, off: readonly string[] = []) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    target.texture.name = "fc:post";
    this.composer = new EffectComposer(renderer, target);
    if (off.includes("ao")) {
      this.ao = null;
      this.composer.addPass(new RenderPass(scene, camera));
    } else {
      // N8AO renders the scene itself (it replaces the render pass), into a multisampled target
      // of ours that carries the depth texture it reads.
      this.ao = new N8AOPass(scene, camera, size.x, size.y);
      const beauty = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      beauty.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
      beauty.texture.name = "fc:post-beauty";
      this.ao.beautyRenderTarget.dispose();
      this.ao.beautyRenderTarget = beauty;
      this.ao.setQualityMode("Medium");
      const c = this.ao.configuration;
      // Metres: contact shadows under cars, kerbs and benches, in corners and the arcades.
      c.aoRadius = 2.2;
      c.distanceFalloff = 1.0;
      c.intensity = 2.2;
      c.halfRes = true;
      c.depthAwareUpsampling = true;
      // The output pass applies tone mapping and sRGB once, at the end.
      c.gammaCorrection = false;
      this.composer.addPass(this.ao);
    }
    this.bloom = off.includes("bloom") ? null : new UnrealBloomPass(new THREE.Vector2(size.x >> 1, size.y >> 1), BLOOM.day.strength, BLOOM.day.radius, BLOOM.day.threshold);
    if (this.bloom) this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setNight(on: boolean): void {
    const b = on ? BLOOM.night : BLOOM.day;
    if (!this.bloom) return;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
    this.bloom.threshold = b.threshold;
  }

  setSize(width: number, height: number): void {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.ao?.dispose();
    this.bloom?.dispose();
  }
}
