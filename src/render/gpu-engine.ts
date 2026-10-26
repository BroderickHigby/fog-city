// Renderer backbone adapted from Slop New York (MIT, copyright 2026 Mr.doob).
// See assets/imports/slop-new-york/LICENSE.md for the retained license.
// Geometry and gameplay remain Fog City's; these are the renderer/lighting procedures.
import * as THREE from "three";
import { WebGPURenderer, RenderPipeline, PMREMGenerator, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, BlendMode, MaterialBlending, type RenderTarget, type Node } from "three/webgpu";
import { Fn, uniform, float, vec2, vec3, vec4, dot, mix, min, max, pow, smoothstep, length, screenUV, screenSize,
  pass, mrt, output, normalView, roughness, metalness, positionView, positionWorld, cameraPosition,
  normalize, exp, abs, select, fog, pmremTexture, sin, cos, transformNormalToView } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { SunLight } from "three/addons/lights/SunLight.js";
import { SunLightNode } from "three/addons/lights/SunLightNode.js";
import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js";
import { sunDirection, type LightingPreset } from "./sky.ts";
import { presentationLook, type PresentationLook } from "./quality.ts";
import { RendererWarmup, compileForTarget, type WarmupStats } from "./renderer-warmup.ts";

export type RendererBackendRequest = "auto" | "webgpu" | "webgl" | "legacy";
export interface GpuEngineOptions { backend?: RendererBackendRequest; shadows: boolean; quality: boolean; high: boolean }
export interface PostProcessingInfo { enabled: boolean; ssr: boolean; bloom: boolean; framesRendered: number }
type ThreeConsole = (type: "log" | "warn" | "error", message: string, ...parameters: unknown[]) => void;
const normalThreeConsole: ThreeConsole = (type, message, ...parameters) => console[type](message, ...parameters);

/** Keep the sampled scene depth valid on the r186 WebGL node backend. */
export function createGpuScenePass(scene: THREE.Scene, camera: THREE.Camera, backend: "webgpu" | "webgl-node"): ReturnType<typeof pass> {
  // PassNode upgrades reversed depth to FloatType. The pinned WebGL fallback's
  // multisample renderbuffer stays DEPTH_COMPONENT24, so resolving it into that
  // DEPTH_COMPONENT32F texture is invalid. Render directly into the depth texture
  // on this backend; disabling depth resolve would instead leave SSR stale depth.
  // Set the option because PassNode.setup overwrites renderTarget.samples.
  const scenePass = pass(scene, camera, backend === "webgl-node" ? { samples: 0 } : undefined);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  return scenePass;
}

/** WebGPU forwards structured GPUErrorEvent objects despite its legacy string type. */
export function graphicsErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const error = value as { message?: unknown; error?: unknown; reason?: unknown };
    if (typeof error.message === "string") return error.message;
    if (error.error) return graphicsErrorMessage(error.error);
    if (typeof error.reason === "string") return error.reason;
    try { return JSON.stringify(value).slice(0, 4000); } catch { /* Unknown opaque browser error. */ }
  }
  return "Unknown graphics backend error";
}

/** Initialized node renderer: WebGPU where available, WebGL2 node backend otherwise. */
export async function createGpuEngine(options: GpuEngineOptions): Promise<GpuEngine> {
  const renderer = new WebGPURenderer({ antialias: true, samples: 4, powerPreference: "high-performance", reversedDepthBuffer: true, forceWebGL: options.backend === "webgl" });
  try { await renderer.init(); }
  catch (error) { await renderer.dispose(); throw error; }
  return new GpuEngine(renderer, options);
}

export class GpuEngine {
  readonly renderer: WebGPURenderer;
  readonly backend: "webgpu" | "webgl-node";
  readonly sun = new SunLight(0xffca92, 5.8);
  readonly sky = new SkyMesh();
  readonly water: THREE.Mesh;
  private readonly options: GpuEngineOptions;
  private readonly pmrem: PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private environment: RenderTarget | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private pipeline: RenderPipeline | null = null;
  private postEnabled: boolean;
  private envKey = "";
  private seaLevel = 0;
  private readonly skyExposure = uniform(0.148);
  private readonly night = uniform(0);
  private readonly fogDensity = uniform(0.0002);
  private readonly time = uniform(0);
  private readonly waterLight = uniform(1);
  private readonly waterColor = uniform(new THREE.Color(0x183a42));
  private readonly exposure = uniform(1);
  private readonly contrast = uniform(1.12);
  private readonly saturation = uniform(1.08);
  private readonly balance = uniform(new THREE.Vector3(1.045, 1, 0.955));
  private bloomPass: ReturnType<typeof bloom> | null = null;
  private scenePass: ReturnType<typeof pass> | null = null;
  private reflections: ReturnType<typeof ssr> | null = null;
  private readonly postInfo: PostProcessingInfo = { enabled: false, ssr: false, bloom: false, framesRendered: 0 };
  private error: string | null = null;
  private failureMessage: string | null = null;
  private readonly loggedErrors = new Set<string>();
  private readonly previousConsole = THREE.getConsoleFunction() as ThreeConsole | null;
  private readonly reportConsole: ThreeConsole = (type, message, ...parameters) => {
    if (type === "error" && !this.disposed) {
      const details = parameters.filter(parameter => parameter instanceof Error || (parameter && typeof parameter === "object" && "message" in parameter));
      this.captureError([message, ...details.map(graphicsErrorMessage)].join(" "));
    } else (this.previousConsole ?? normalThreeConsole)(type, message, ...parameters);
  };
  private disposed = false;
  private warmupQueue: RendererWarmup | null = null;
  private warmTargetReady = false;
  private disposal: Promise<void> | null = null;

  constructor(renderer: WebGPURenderer, options: GpuEngineOptions) {
    this.renderer = renderer; this.options = options; this.postEnabled = options.quality;
    this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl-node";
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = options.shadows;
    if (this.backend === "webgpu") renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
    renderer.library.addLight(SunLightNode, SunLight);
    renderer.onDeviceLost = info => this.captureError(`Graphics device lost: ${info.message || info.reason}`);
    renderer.onError = message => this.captureError(message);
    // Some TSL graph-construction failures are reported through Three's logger rather
    // than a backend exception. Latch those too, so an invalid pass cannot look ready.
    THREE.setConsoleFunction(this.reportConsole);
    this.sun.name = "slop-sun-cascades";
    this.sun.castShadow = options.shadows;
    // Two 2048px cascades at high tier; avoid the reference's 3072 atlas on smaller GPUs.
    const size = options.high ? 2048 : 1024;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.camera.near = .5;
    this.sun.shadow.camera.far = 300;
    this.sun.shadow.normalBias = .05;
    this.sky.name = "physical-atmosphere";
    this.sky.scale.setScalar(200000);
    this.sky.cloudScale.value = .00018;
    this.sky.cloudSpeed.value = .000015;
    this.sky.cloudElevation.value = .52;
    const rawSky = this.sky.material.colorNode! as Node<"vec4">;
    this.sky.material.colorNode = Fn(() => vec4(mix(rawSky.rgb.mul(this.skyExposure), vec3(.005, .009, .018), this.night), 1))();
    const rawVertex = this.sky.material.vertexNode! as Node<"vec4">;
    if (renderer.reversedDepthBuffer) this.sky.material.vertexNode = Fn(() => { const p = rawVertex.toVar(); p.z.assign(0); return p; })();
    this.sky.material.userData.skipGpuAdapter = true;
    this.pmrem = new PMREMGenerator(renderer);

    const water = new MeshPhysicalNodeMaterial({ color: 0x183a42, roughness: .18, metalness: .22, clearcoat: .8, clearcoatRoughness: .13 });
    water.name = "fc:node-water"; water.userData.skipGpuAdapter = true;
    const p = positionWorld.xz;
    const waveX = sin(p.x.mul(.034).add(p.y.mul(.021)).add(this.time.mul(.55))).mul(.022)
      .add(sin(p.x.mul(.11).sub(p.y.mul(.07)).add(this.time.mul(.9))).mul(.014));
    const waveZ = cos(p.x.mul(-.031).add(p.y.mul(.082)).add(this.time.mul(.7))).mul(.026)
      .add(cos(p.y.mul(.21).add(this.time.mul(.8))).mul(.008));
    const waveFade = float(1).sub(smoothstep(300, 2400, length(positionWorld.sub(cameraPosition))));
    water.normalNode = transformNormalToView(normalize(vec3(waveX.mul(waveFade).negate(), 1, waveZ.mul(waveFade).negate())));
    water.colorNode = this.waterColor.mul(this.waterLight.mul(.6).add(.4));
    const geometry = new THREE.PlaneGeometry(42000, 42000).rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geometry, water); this.water.name = "bay:physical"; this.water.frustumCulled = false;
  }

  private captureError(value: unknown): void {
    if (this.disposed) return;
    const message = graphicsErrorMessage(value);
    this.error ??= message; this.failureMessage ??= message;
    const fingerprint = message.replace(/\b(?:0x[\da-f]+|\d+)\b/gi, "#");
    if (!this.loggedErrors.has(fingerprint) && this.loggedErrors.size < 8) {
      this.loggedErrors.add(fingerprint); console.error(`[fog-city] ${message}`);
    }
  }

  private warmup(): RendererWarmup {
    return this.warmupQueue ??= new RendererWarmup(mesh => {
      if (!this.scene || !this.camera) return Promise.resolve();
      return compileForTarget(this.renderer, this.postEnabled ? this.scenePass : null, mesh, this.camera, this.scene);
    }, { onError: error => this.captureError(error) });
  }
  /** Configure exactly the post pass formats before capturing shader contexts. */
  async prewarm(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    this.scene = scene; this.camera = camera;
    if (this.pipeline && !this.warmTargetReady) {
      const visible = scene.visible;
      try { scene.visible = false; this.pipeline.render(); this.warmTargetReady = true; }
      finally { scene.visible = visible; }
    }
    const queue = this.warmup(); queue.admit(scene); await queue.drain();
    if (this.failureMessage) throw new Error(this.failureMessage);
  }
  admit(root: THREE.Object3D): void { if (!this.disposed) this.warmup().admit(root); }
  retire(root: THREE.Object3D): Promise<void> | void { return this.warmupQueue?.retire(root); }
  /** Whole-view shutdown also owns active borrowers whose dynamic roots already detached. */
  retireAll(): Promise<void> | void {
    const queue=this.warmupQueue;if(!queue)return;
    queue.dispose();if(queue.info().active)return queue.idle();
  }
  pumpWarmup(): void { if (!this.disposed) void this.warmupQueue?.pump(); }
  get warmupInfo(): WarmupStats { return this.warmupQueue?.info() ?? {admitted:0,cachedLayouts:0,pending:0,active:false,compiled:0,cancelled:0,failed:0,lastError:null}; }
  get shadowCameras(): readonly THREE.Camera[] { return Array.from({length:this.sun.shadow.getViewportCount()},(_,i)=>this.sun.shadow.getCamera(i)); }
  staticShadowMaterial(side: THREE.Side, shadowSide: THREE.Side | null): THREE.Material {
    const material = new MeshBasicNodeMaterial({color:0,side}); material.shadowSide=shadowSide; material.userData.skipGpuAdapter=true; return material;
  }
  get failure(): string | null { return this.failureMessage; }

  attach(scene: THREE.Scene, camera: THREE.Camera, seaLevel: number): void {
    this.scene = scene; this.camera = camera; this.seaLevel = seaLevel;
    // A clear-colour background forces an extra cascade clear in the node renderer.
    scene.background = null;
    scene.add(this.sky, this.water, this.sun);
    if (this.postEnabled) this.createPipeline(scene, camera);
  }

  private createPipeline(scene: THREE.Scene, camera: THREE.Camera): void {
    const scenePass = createGpuScenePass(scene, camera, this.backend); this.scenePass = scenePass;
    const reflectionFade = smoothstep(360, 180, positionView.z.negate());
    const sceneMrt = mrt({ output, normal: normalView, metalRough: vec2(roughness.lessThan(.75).select(metalness.mul(reflectionFade), 0), roughness) });
    sceneMrt.setBlendMode("normal", new BlendMode(MaterialBlending));
    sceneMrt.setBlendMode("metalRough", new BlendMode(MaterialBlending));
    scenePass.setMRT(sceneMrt);
    const color = scenePass.getTextureNode("output"), packed = scenePass.getTextureNode("metalRough");
    // SSR ray refinement samples the normal texture at arbitrary UVs. Keep its TextureNode
    // object intact; the r186 type signature says vec3 but a .rgb SplitNode has no sample().
    const normals = scenePass.getTextureNode("normal");
    const reflections = ssr(color, scenePass.getTextureNode("depth"), normals as unknown as Node<"vec3">, { metalnessNode: packed.r, roughnessNode: packed.g, camera });
    this.reflections = reflections;
    reflections.resolutionScale = .5; reflections.blurQuality = 1; reflections.maxDistance.value = 42;
    reflections.thickness.value = .85; reflections.quality.value = .25; reflections.binaryRefine = true;
    reflections.intensity.value = .5; reflections.screenEdgeFadeBlack = true;
    const reflectionMask = packed.r.greaterThan(0).select(smoothstep(.75, .55, packed.g), 0);
    const exposed = max(color.rgb.add(reflections.rgb.mul(reflectionMask)), vec3(0)).mul(this.exposure).mul(this.balance);
    const peak = max(max(exposed.r, exposed.g), exposed.b);
    const bloomPass = bloom(vec4(exposed.mul(float(8).div(max(peak, 8))), 1), .24, .4, 1.2);
    bloomPass.smoothWidth.value = .3; bloomPass.setResolutionScale(.5); this.bloomPass = bloomPass;
    const graded = Fn(() => {
      const rgb = exposed.add(bloomPass.rgb).toVar();
      const luma = dot(rgb, vec3(.2126, .7152, .0722)).toVar();
      rgb.mulAssign(mix(vec3(.965, 1.005, 1.045), vec3(1), smoothstep(.02, .6, luma))
        .mul(mix(vec3(1), vec3(1.035, 1.005, .965), smoothstep(.6, 3, luma))));
      rgb.mulAssign(pow(max(luma, .0001).div(.18), this.contrast.sub(1)));
      const gray = dot(rgb, vec3(.2126, .7152, .0722));
      const chroma = max(max(rgb.r, rgb.g), rgb.b).sub(min(min(rgb.r, rgb.g), rgb.b));
      const vibrance = float(.1).mul(float(1).sub(chroma.div(max(max(max(rgb.r, rgb.g), rgb.b), .0001))));
      rgb.assign(max(mix(vec3(gray), rgb, this.saturation.add(vibrance)), vec3(0)));
      const aspect = screenSize.x.div(screenSize.y);
      const radius = length(screenUV.sub(.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(.5)));
      return vec4(rgb.mul(float(1).sub(smoothstep(.35, 1, radius).mul(.12))), 1);
    })();
    this.pipeline = new RenderPipeline(this.renderer, graded);
  }

  setPreset(preset: LightingPreset, look: PresentationLook = presentationLook(preset.name), key: string = preset.name): void {
    this.night.value = preset.nightFactor ?? (preset.name === "night" ? 1 : 0);
    this.skyExposure.value = .148 * (1 - this.night.value * .85);
    this.sky.turbidity.value = 8; this.sky.rayleigh.value = 2.8;
    this.sky.mieCoefficient.value = .008; this.sky.mieDirectionalG.value = .88;
    this.sky.cloudCoverage.value = preset.cloudCoverage ?? .35;
    this.sky.cloudDensity.value = Math.min(.55, (preset.cloudOpacity ?? .65) * .58);
    const direction = sunDirection(preset); this.sky.sunPosition.value.copy(direction); this.sun.position.copy(direction);
    this.sun.color.setHex(preset.sunColor); this.sun.intensity = preset.sunIntensity;
    this.sun.updateMatrixWorld();
    this.waterLight.value = preset.water;
    this.waterColor.value.setHex(preset.name === "night" ? 0x0b202a : 0x183a42);
    this.fogDensity.value = preset.fog.density;
    this.exposure.value = preset.exposure;
    this.contrast.value = look.contrast; this.saturation.value = look.saturation;
    this.balance.value.set(...look.balance);
    if (this.bloomPass) { this.bloomPass.strength.value = look.bloom; this.bloomPass.threshold.value = look.bloomThreshold; }
    this.renderer.toneMappingExposure = this.postEnabled ? 1 : preset.exposure;
    if (key !== this.envKey && this.scene) {
      this.envKey = key;
      this.sky.showSunDisc.value = 0; this.envScene.add(this.sky);
      this.environment = this.pmrem.fromScene(this.envScene, 0, .1, 100, { size: 128, renderTarget: this.environment });
      this.scene.environment = this.environment.texture;
      this.sky.showSunDisc.value = 1; this.scene.add(this.sky);
      this.scene.environmentIntensity = preset.envIntensity;
      this.installFog(this.scene);
    }
  }

  private installFog(scene: THREE.Scene): void {
    if (!this.environment) return;
    const ray = positionWorld.sub(cameraPosition), dist = length(ray), direction = ray.div(max(dist, .001));
    const horizon = normalize(vec3(direction.x, max(direction.y, .015), direction.z));
    const sky = pmremTexture(this.environment.texture, horizon, float(.3)).rgb;
    const height = float(900), ya = max(positionWorld.y, 0), yb = max(cameraPosition.y, 0), dy = yb.sub(ya);
    const ea = exp(ya.div(height).negate()), eb = exp(yb.div(height).negate());
    const mean = select(abs(dy).greaterThan(1), ea.sub(eb).mul(height).div(dy), ea);
    const optical = this.fogDensity.mul(dist).mul(mean);
    scene.fogNode = fog(sky, float(1).sub(exp(optical.mul(optical).negate())));
  }

  frame(time: number, camera: THREE.Camera, aboveGround: number): void {
    this.time.value = time;
    this.sun.shadow.camera.far = Math.max(300, Math.min(720, 260 + Math.max(0, aboveGround) * 1.6));
    this.water.position.set(Math.round(camera.position.x / 50) * 50, this.seaLevel - .12, Math.round(camera.position.z / 50) * 50);
  }
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.error) { const error = this.error; this.error = null; throw new Error(error); }
    this.renderer.info.reset();
    try {
      if (this.pipeline && this.postEnabled) {
        this.pipeline.render();
        // Three can report a graph failure without throwing. Count only complete frames.
        if (this.error) throw new Error(this.error);
        this.postInfo.enabled = true;
        this.postInfo.ssr = this.reflections !== null;
        this.postInfo.bloom = this.bloomPass !== null;
        this.postInfo.framesRendered++;
      } else this.renderer.render(scene, camera);
    }
    catch (error) { this.captureError(error); throw error; }
  }
  resize(): void { /* PassNode tracks the renderer's drawing buffer on each update. */ }
  setShadows(enabled: boolean): void {
    if (this.renderer.shadowMap.enabled !== enabled) this.warmupQueue?.invalidate();
    this.renderer.shadowMap.enabled = enabled; this.sun.castShadow = enabled;
    if (!enabled) { this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
  }
  private disposePipeline(): void {
    const pipeline=this.pipeline,pass=this.scenePass,bloom=this.bloomPass,reflections=this.reflections;
    this.pipeline = null; this.scenePass = null; this.bloomPass = null; this.reflections = null;
    const release=():void=>{pipeline?.dispose();pass?.dispose();bloom?.dispose();reflections?.dispose();};
    if(this.warmupQueue?.info().active)void this.warmupQueue.idle().then(release,release);else release();
    this.postInfo.enabled = false; this.postInfo.ssr = false; this.postInfo.bloom = false;
  }
  disablePost(): void { this.postEnabled = false; this.warmupQueue?.invalidate(); this.disposePipeline(); this.renderer.toneMappingExposure = this.exposure.value; }
  get presentation(): boolean { return this.postEnabled && this.pipeline !== null; }
  get postProcessing(): PostProcessingInfo { return this.postInfo; }
  get shadowCascades(): number { return this.renderer.shadowMap.enabled && this.sun.castShadow && this.sun.shadow.map ? 2 : 0; }
  get shadowAtlas(): { width: number; height: number } | null {
    const map = this.sun.shadow.map; return map ? { width: map.width, height: map.height } : null;
  }
  async dispose(): Promise<void> {
    if (this.disposed) { await this.disposal; return; }
    this.disposed = true;
    this.warmupQueue?.dispose();
    if (THREE.getConsoleFunction() === this.reportConsole) THREE.setConsoleFunction(this.previousConsole ?? normalThreeConsole);
    this.disposal=(async()=>{
      await this.warmupQueue?.idle();
      this.disposePipeline(); this.pmrem.dispose(); this.environment?.dispose();
      this.sun.dispose(); this.sky.geometry.dispose(); this.sky.material.dispose();
      this.water.geometry.dispose(); (this.water.material as THREE.Material).dispose();
      await this.renderer.dispose();
    })();
    await this.disposal;
  }
}
