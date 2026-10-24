// The M0 renderer: owns the WebGLRenderer, scene, lighting, sky, the Bay, streamed tiles,
// players, ambient agents and landmarks. main.ts feeds it interpolated player poses and the
// two latest sim states (agents are interpolated here); it never changes sim state.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Assets } from "../io/assets.ts";
import type { SimState } from "../sim/contract.ts";
import type { TileCollider } from "../sim/world.ts";
import { Actors, CAR_COLORS, makeBoxCar, type CarPose, type WalkerPose } from "./actors.ts";
import { AgentLayer, type AgentRenderInfo } from "./agent-layer.ts";
import { FarLayer } from "./far-layer.ts";
import { parkShapes, tintParks } from "./parks.ts";
import type { Viewer } from "./agent-lod.ts";
import { CameraRig, type CameraMode, type CameraTarget, type FlyInput } from "./cameras.ts";
import { LandmarkLayer } from "./landmark-layer.ts";
import { NightLights } from "./lights.ts";
import { createSharedMaterials, fcUniforms, installFog, setFog, type SharedMaterials } from "./materials.ts";
import { ModelRegistry } from "./model-registry.ts";
import { createNightMaterials, type NightMaterials } from "./props.ts";
import { DAY, NIGHT, Sky, applySkyPreset, sunDirection, LIGHTING_PRESETS, type LightingPreset } from "./sky.ts";
import { createTileLoader } from "./gltf-loader.ts";
import { TileStreamer, type StreamerStats } from "./tile-streamer.ts";
import type { GroundFn, Manifest, RoadGraph } from "./types.ts";
import { Water } from "./water.ts";
import { softwareFarBudget } from "./far-selection.ts";
import { AvatarGround } from "./avatar-ground.ts";
import { FoliageLayer } from "./foliage.ts";
import { VisualQuality } from "./quality.ts";
import { GfxGovernor, PIXEL_STEP, renderPixelRatio, type GfxStep, type GfxTier } from "./gfx.ts";
import { PLAYER_BODY_FILE } from "./player-body.ts";
import { loadSurfaceTextures, type SurfaceTextures } from "./surface-textures.ts";

export type { CameraMode } from "./cameras.ts";

export interface RenderOptions {
  /** Tile load radius around the camera, metres. */
  radius: number;
  shadows?: boolean;
  quality?: boolean;
  timeOfDay?: keyof typeof LIGHTING_PRESETS;
  night: boolean;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** Most drawing-buffer pixels (gfx.ts TIER_SETTINGS); unbounded when omitted. */
  pixelBudget?: number;
  /** The graphics tier (gfx.ts), for reports; and whether the governor may step it down. */
  tier?: GfxTier;
  governed?: boolean;
  /** Keep the drawing buffer between frames (software renderers: tests read the canvas). */
  preserveDrawingBuffer?: boolean;
  /** Known model files (paths under public/), or null to try every URL. */
  models: ReadonlySet<string> | null;
  /** content/landmarks.json, parsed, or null. */
  landmarks: unknown;
}

export interface WorldData {
  manifest: Manifest;
  base: string;
  colliders: ReadonlyMap<string, TileCollider>;
  roads: RoadGraph | null;
  ground: GroundFn;
  /** True when (x, y, z) is inside a building below its roof (camera pull-in). */
  occluded: (x: number, y: number, z: number) => boolean;
  /** Where glb bytes come from (loose files or the packed build). Omitted: fetch each URL. */
  assets?: Assets;
  /** districts.json, parsed (its park polygons tint the ground green), or null. */
  districts?: unknown;
  /** A tile's own collider (with building meta) for a tile whose glb failed; see StreamerOptions. */
  fallbackCollider?: (id: string) => Promise<TileCollider | null>;
}

export interface RenderInfo {
  drawCalls: number;
  triangles: number;
  tilesLoaded: number;
  cameraMode: CameraMode;
  presentation: boolean;
  lightingPreset: string;
  foliage: { near: number; far: number; draws: number };
  surfaceTextures: readonly string[];
  night: boolean;
  tilesPending: number;
  tilesTotal: number;
  tilesFailed: number;
  landmarks: number;
  fps: number;
  pixelRatio: number;
  /** The graphics tier, its pixel budget now, and the governor's steps so far. */
  gfx?: { tier: GfxTier | "unknown"; pixelBudget: number; steps: readonly GfxStep[] };
  shadows: boolean;
  /** Ambient agents drawn last frame (near models plus far proxies), and of those with full models. */
  agents: number;
  agentsNear: number;
  /** Agents in the sim state the renderer was given. */
  agentsTotal: number;
  /** Draw calls the agents took last frame. */
  agentDrawCalls: number;
  /** Agent kinds drawn from their model files (the rest use box stand-ins). */
  agentModels: string[];
  /** Players drawn from models/civilian-car.glb (the rest use the procedural car). */
  playerCarsFromFile: number;
  /** Players drawn on foot last frame. */
  walkers: number;
  /** On-foot players using the animated human asset, rather than a loading fallback. */
  walkersFromFile: number;
  /** Far-LOD cells the manifest lists, loaded into the scene, and drawn in the last frame. */
  farCellsTotal: number;
  farCells: number;
  farCellsDrawn: number;
  /** Triangles in the loaded far cells. */
  farTriangles: number;
  /** Far quads at the city's outer edge stitched to the streamed tiles' ground. */
  farSeamEdges: number;
  /** The camera's far plane, metres. */
  cameraFar: number;
  /** CPU-renderer fallback diagnostics; native GPUs have no radius limit. */
  farBudget?: { radius: number | null; queued: number; loading: number; failed: number };
}

const SHADOW_HALF = 96;
/** The governor never takes the drawing buffer under this many pixels. */
const MIN_PIXEL_BUDGET = 900_000;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_TEXEL_M = (SHADOW_HALF * 2) / SHADOW_MAP_SIZE;
/** The camera sees this far: the far skyline reaches across the city and the Bay. */
export const CAMERA_FAR_M = 20000;
/** The sea plane's side (it follows the camera): beyond the far plane in every direction. */
const SEA_SIZE_M = 2 * CAMERA_FAR_M + 2000;
/** The local car's headlight at full night. */
const HEADLIGHT_NIGHT = 140;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.5, CAMERA_FAR_M);
  readonly rig: CameraRig;
  readonly streamer: TileStreamer;
  readonly actors: Actors;
  readonly agents: AgentLayer;
  readonly landmarks: LandmarkLayer;
  readonly far: FarLayer;
  readonly lights = new NightLights();
  private readonly container: HTMLElement;
  private readonly materials: SharedMaterials;
  private readonly nightMats: NightMaterials;
  private readonly sky = new Sky();
  private readonly water = new Water(SEA_SIZE_M);
  private readonly ground: (x: number, z: number) => number;
  private readonly avatarGround = new AvatarGround();
  private readonly foliage: FoliageLayer;
  private quality: VisualQuality | null = null;
  private readonly surfaceTextures: SurfaceTextures;
  private frameDelta = 1 / 60;
  private activePreset: LightingPreset["name"] = "day";
  private dayPreset: LightingPreset = DAY;
  private lastPreset: LightingPreset = DAY;
  private readonly maxPixelRatio: number;
  private pixelBudget: number;
  private readonly tier: GfxTier | "unknown";
  private governor: GfxGovernor | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private readonly headlight = new THREE.SpotLight(0xfff0d8, 0, 90, 0.52, 0.55, 1.4);
  private readonly fog = new THREE.FogExp2(0xffffff, 0.0005);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envCache = new Map<string, THREE.Texture>();
  private readonly envScene = new THREE.Scene();
  private readonly registry: ModelRegistry<THREE.Object3D>;
  private readonly shadows: boolean;
  private readonly sunDir = new THREE.Vector3();
  private nightOn = false;
  private headlightBase = 0;
  private sim: { prev: SimState; curr: SimState; alpha: number } | null = null;
  private readonly viewer: Viewer = { x: 0, z: 0, fx: 0, fz: -1 };
  private readonly camDir = new THREE.Vector3();
  private lastCalls = 0;
  private lastTris = 0;
  private fpsAvg = 60;
  private time = 0;
  private readonly statsScratch: StreamerStats = { total: 0, ready: 0, pending: 0, failed: 0, glbReady: 0, builtReady: 0 };
  /** Frames rendered since a camera jump (debug fly-to, mode switch). */
  private framesSinceJump = 0;

  constructor(container: HTMLElement, world: WorldData, opts: RenderOptions) {
    installFog();
    this.container = container;
    this.ground = world.ground;
    this.water.setLevel(world.manifest.water?.y ?? 0);
    // The presentation chain renders into its own target and anti-aliases with FXAA, so the
    // canvas needs no MSAA then: at a large drawing buffer MSAA alone costs hundreds of MB.
    this.renderer = new THREE.WebGLRenderer({
      antialias: opts.quality !== true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? true,
      powerPreference: "high-performance",
    });
    const gl = this.renderer.getContext();
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererName = String(gl.getParameter(rendererInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    const software = /swiftshader|llvmpipe|software/i.test(rendererName);
    this.shadows = opts.shadows ?? !software;
    this.maxPixelRatio = opts.maxPixelRatio;
    this.pixelBudget = opts.pixelBudget ?? Infinity;
    this.tier = opts.tier ?? "unknown";
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.scene.fog = this.fog;
    this.scene.add(this.sky.mesh, this.water.mesh, this.sun, this.sun.target, this.hemi, this.headlight, this.headlight.target);
    this.envScene.add(new Sky(900).mesh);
    if (this.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      const c = this.sun.shadow.camera;
      c.left = -SHADOW_HALF;
      c.right = SHADOW_HALF;
      c.top = SHADOW_HALF;
      c.bottom = -SHADOW_HALF;
      c.near = 1;
      c.far = 1600;
      this.sun.shadow.bias = -0.00008;
      this.sun.shadow.normalBias = 0.035;
    }

    this.materials = createSharedMaterials();
    this.nightMats = createNightMaterials();

    const gltf = new GLTFLoader();
    const assets = world.assets;
    this.surfaceTextures = loadSurfaceTextures(this.materials, async path => {
      if (assets) return assets.bytes(path);
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Surface texture: ${response.status} ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    }, { anisotropy: this.renderer.capabilities.getMaxAnisotropy() });
    // A packed build carries only the models it lists; the dev server's listing is the build-time one.
    const available = opts.models && assets && assets.mode === "packed" ? new Set([...opts.models].filter((u) => assets.has(u))) : opts.models;
    this.registry = new ModelRegistry<THREE.Object3D>({
      load: assets
        ? async (url) => (await gltf.parseAsync(bufferOf(await assets.bytes(url)), "")).scene
        : async (url) => (await gltf.loadAsync(url)).scene,
      clone: (o) => o.clone(true),
      fallback: (key) => (key === "player-car" ? makeBoxCar(CAR_COLORS[0]!) : new THREE.Group()),
      available,
    });
    const tileLoader = createTileLoader();
    const loadTile = assets ? async (url: string) => tileLoader.parseAsync(bufferOf(await assets.bytes(url)), "") : (url: string) => tileLoader.loadAsync(url);
    const parks = parkShapes(world.districts ?? null);
    this.foliage = new FoliageLayer(this.shadows);
    this.scene.add(this.foliage.group);
    this.far = new FarLayer({
      manifest: world.manifest,
      base: world.base,
      load: loadTile,
      tint: (geo, m, terrain) => tintParks(geo, m, parks, terrain),
      ground: world.ground,
      budget: softwareFarBudget(rendererName),
    });
    this.scene.add(this.far.group);

    this.streamer = new TileStreamer({
      parent: this.scene,
      manifest: world.manifest,
      base: world.base,
      colliders: world.colliders,
      roads: world.roads,
      ground: world.ground,
      materials: this.materials,
      night: this.nightMats,
      radius: opts.radius,
      loadGltf: assets ? loadTile : undefined,
      onReady: (g) => { this.prepareShadows(g); this.avatarGround.addTile(g); this.foliage.addTile(g); },
      onTileVisible: (id, visible) => {
        this.far.setTileVisible(id, visible);
        if (!visible) { this.avatarGround.removeTile(id); this.foliage.removeTile(id); }
      },
      tintGround: (geo, m) => tintParks(geo, m, parks),
      fallbackCollider: world.fallbackCollider,
    });
    this.far.start();
    // With ?shadows=1 the players and the agents cast (and receive) shadows like the city.
    this.actors = new Actors(this.registry, this.lights, this.shadows,
      available && !available.has(PLAYER_BODY_FILE) ? undefined : async (path) => {
        if (assets) return assets.bytes(path);
        const response = await fetch(path);
        if (!response.ok) throw new Error(`Player model: ${response.status} ${path}`);
        return new Uint8Array(await response.arrayBuffer());
      });
    this.scene.add(this.actors.group);
    this.agents = new AgentLayer(this.registry, {}, this.shadows);
    this.scene.add(this.agents.group);
    this.landmarks = new LandmarkLayer(
      opts.landmarks,
      this.registry,
      world.ground,
      (ids) => this.streamer.hideBuildings(ids),
      (root) => {
        this.prepareShadows(root);
        this.lights.track(root);
      },
    );
    this.scene.add(this.landmarks.group);
    this.rig = new CameraRig(this.camera, world.ground, world.occluded);

    // Keep unclipped direct rendering on devices without floating-point color targets.
    if ((opts.quality ?? !software) && this.renderer.extensions.has("EXT_color_buffer_float")) {
      this.quality = new VisualQuality(this.renderer, this.scene, this.camera);
    }
    const preset = opts.timeOfDay ? LIGHTING_PRESETS[opts.timeOfDay] : opts.night ? NIGHT : DAY;
    this.nightOn = preset.name === "night";
    if (!this.nightOn) this.dayPreset = preset;
    this.applyPreset(preset);
    this.governor = new GfxGovernor(opts.governed ?? false, {
      post: this.quality !== null, shadows: this.shadows, pixelBudget: this.pixelBudget, maxPixelRatio: this.maxPixelRatio,
    });
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private prepareShadows(root: THREE.Object3D): void {
    if (!this.shadows) return;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = m.name || m.parent?.name || "";
      m.receiveShadow = true;
      m.castShadow = !/ground|road|pool/.test(name);
    });
  }

  get night(): boolean {
    return this.nightOn;
  }

  setNight(on: boolean): void {
    if (on === this.nightOn) return;
    this.nightOn = on;
    this.applyPreset(on ? NIGHT : this.dayPreset);
  }

  private applyPreset(p: LightingPreset): void {
    this.lastPreset = p;
    const night = p.nightFactor ?? (p.name === "night" ? 1 : 0);
    this.quality?.setPreset(p);
    this.activePreset = p.name;
    applySkyPreset(p);
    this.fog.color.setHex(p.fogColor);
    setFog(p.fog, this.fog);
    this.renderer.toneMappingExposure = p.exposure;
    sunDirection(p, this.sunDir);
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.water.setBodyLight(p.water);
    this.water.setCityGlow(0xffb070, night * 0.09);
    fcUniforms.fcNight.value = night;
    this.materials.lampHead.emissiveIntensity = night * 6;
    // The headlight stays in the scene at intensity 0 by day or on foot: the light count
    // never changes, so no shader recompiles.
    this.headlightBase = night * HEADLIGHT_NIGHT;
    this.headlight.intensity = this.headlightBase;
    this.streamer.setNight(night > 0);
    this.lights.setNight(night);
    this.agents.setNight(night);
    this.scene.environment = this.envFor(p);
    this.scene.environmentIntensity = p.envIntensity;
  }

  /** Image-based lighting from the sky itself, generated once per preset. */
  private envFor(p: LightingPreset): THREE.Texture {
    let env = this.envCache.get(p.name);
    if (!env) {
      const previousLinear = fcUniforms.fcLinearOutput.value;
      fcUniforms.fcLinearOutput.value = 1;
      try { env = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 2000).texture; }
      finally { fcUniforms.fcLinearOutput.value = previousLinear; }
      this.envCache.set(p.name, env);
    }
    return env;
  }

  /** Camera mode switch from outside the key handler (debug, URL). */
  setCameraMode(m: CameraMode): void {
    this.rig.setMode(m);
    this.framesSinceJump = 0;
  }

  /** Jump the free camera (debug, screenshots). Angles in radians. */
  flyTo(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.rig.setFlyPose(x, y, z, yaw, pitch);
    this.framesSinceJump = 0;
  }

  /** No tile queued, loading or building for where the camera is now. */
  tilesSettled(): boolean {
    return this.framesSinceJump >= 2 && this.streamer.settled() && this.far.settled();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    // The drawing buffer follows the screen up to the tier's pixel budget (gfx.ts).
    this.renderer.setPixelRatio(renderPixelRatio(window.devicePixelRatio || 1, w, h, this.pixelBudget, this.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.quality?.resize(w, h);
  }

  /** The governor's step down (gfx.ts): fewer pixels, then no shadows, then no post chain. */
  private stepDown(step: GfxStep): void {
    if (step === "pixels") {
      const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.pixelBudget = Math.max(MIN_PIXEL_BUDGET, Math.min(this.pixelBudget, buffer.x * buffer.y) * PIXEL_STEP);
      this.resize();
    } else if (step === "shadows") {
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      // Every lit material compiled its shadow lookups: recompile them without.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
      });
    } else if (this.quality) {
      this.quality.dispose();
      this.quality = null;
    }
  }

  /**
   * After the GL context came back (context-guard.ts): three.js re-uploads geometry and textures
   * from their CPU copies by itself; the sky's environment maps lived only on the GPU, so they
   * are made again.
   */
  contextRestored(): void {
    this.envCache.clear();
    this.applyPreset(this.lastPreset);
    this.resize();
  }

  setCar(id: string, pose: CarPose): void {
    this.actors.setCar(id, pose);
  }

  setFoot(id: string, pose: WalkerPose | null): void {
    this.actors.setFoot(id, pose ? { ...pose, y: this.avatarGround.heightAt(pose.x, pose.y, pose.z) } : null);
  }

  /** The two latest sim states and how far (0..1) the frame is between them: agents are drawn from these. */
  setSim(prev: SimState, curr: SimState, alpha: number): void {
    if (!this.sim) this.sim = { prev, curr, alpha };
    this.sim.prev = prev;
    this.sim.curr = curr;
    this.sim.alpha = alpha;
  }

  /**
   * Per-frame update after the sim has stepped. `dtSeconds` is the frame time the animation
   * uses (main.ts clamps it); `frameSeconds` is the real, unclamped frame time, for the FPS figure;
   * `simSeconds` is how much of it the sim's ticks took, which the graphics governor leaves out:
   * a slow sim is not cured by drawing less.
   */
  frame(
    dtSeconds: number,
    local: { id: string; target: CameraTarget } | null,
    fly: Readonly<FlyInput>,
    minuteOfDay: number,
    frameSeconds: number = dtSeconds,
    simSeconds = 0,
  ): void {
    this.frameDelta = dtSeconds;
    this.time += dtSeconds;
    fcUniforms.fcTime.value = this.time;
    if (frameSeconds > 0) this.fpsAvg += (1 / Math.max(frameSeconds, 1e-3) - this.fpsAvg) * Math.min(1, frameSeconds * 2);
    const step = this.governor?.frame(Math.max(1e-4, frameSeconds - simSeconds), !this.tilesSettled() || document.hidden);
    if (step) this.stepDown(step);
    if (local) {
      const t = local.target;
      this.actors.hideFor(this.rig.mode === "first-person" ? local.id : null, t.onFoot ? "person" : "car");
      this.rig.update(dtSeconds, t, fly);
      // The headlight rides on the local car; on foot it is dark (intensity 0, still in the scene).
      const fx = Math.sin(t.heading);
      const fz = -Math.cos(t.heading);
      this.headlight.intensity = t.onFoot ? 0 : this.headlightBase;
      this.headlight.position.set(t.x + fx * 2.2, t.y + 0.9, t.z + fz * 2.2);
      this.headlight.target.position.set(t.x + fx * 30, t.y - 1.5, t.z + fz * 30);
      this.headlight.target.updateMatrixWorld();
    } else {
      this.rig.update(dtSeconds, NO_TARGET, fly);
    }
    this.actors.update(dtSeconds);
    const cam = this.camera.position;
    if (this.sim) {
      this.camera.getWorldDirection(this.camDir);
      const h = Math.hypot(this.camDir.x, this.camDir.z);
      this.viewer.x = cam.x;
      this.viewer.z = cam.z;
      this.viewer.fx = h > 1e-6 ? this.camDir.x / h : 0;
      this.viewer.fz = h > 1e-6 ? this.camDir.z / h : -1;
      this.agents.update(this.sim.prev, this.sim.curr, this.sim.alpha, this.viewer, dtSeconds, this.time);
    }
    this.fitNearPlane();
    this.sky.follow(this.camera);
    this.water.follow(this.camera);
    // Keep the sun light (and its shadow box) centred near the camera.
    // Move in texel-sized steps, rather than visibly jumping twenty metres.
    const sx = Math.round(cam.x / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;
    const sz = Math.round(cam.z / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;
    const groundY = this.ground(sx, sz);
    this.sun.target.position.set(sx, groundY, sz);
    this.sun.position.set(sx + this.sunDir.x * 800, groundY + this.sunDir.y * 800, sz + this.sunDir.z * 800);
    this.sun.target.updateMatrixWorld();
    this.streamer.update(cam.x, cam.z, 4);
    this.far.update(cam.x, cam.z);
    this.foliage.update(cam.x, cam.z);
    this.landmarks.update(minuteOfDay);
  }

  /**
   * The near plane follows the camera's height above the ground: 0.5 m at street level, up to
   * 4 m from a hilltop or the air, so the 20 km depth range keeps enough precision for the far
   * shoreline and skyline.
   */
  private fitNearPlane(): void {
    const c = this.camera.position;
    const above = c.y - this.ground(c.x, c.z);
    const near = Math.min(4, Math.max(0.5, above * 0.02));
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.05) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  render(): void {
    if (this.quality) this.quality.render(this.frameDelta);
    else this.renderer.render(this.scene, this.camera);
    this.far.endFrame();
    this.framesSinceJump++;
    this.lastCalls = this.renderer.info.render.calls;
    this.lastTris = this.renderer.info.render.triangles;
  }

  /** Render stats. Fills `out` (reused by the HUD every frame) or a fresh object. */
  info(out: RenderInfo = { ...EMPTY_INFO }): RenderInfo {
    const s = this.streamer.stats(this.statsScratch);
    out.drawCalls = this.lastCalls;
    out.triangles = this.lastTris;
    out.tilesLoaded = s.ready;
    out.cameraMode = this.rig.mode;
    out.presentation = this.quality !== null;
    out.lightingPreset = this.activePreset;
    out.foliage = this.foliage.info;
    out.surfaceTextures = this.surfaceTextures.loaded;
    out.night = this.nightOn;
    out.tilesPending = s.pending;
    out.tilesTotal = s.total;
    out.tilesFailed = s.failed;
    out.landmarks = this.landmarks.count;
    out.fps = this.fpsAvg;
    out.pixelRatio = this.renderer.getPixelRatio();
    out.gfx = { tier: this.tier, pixelBudget: this.pixelBudget, steps: this.governor?.taken ?? [] };
    out.shadows = this.shadows;
    const a: AgentRenderInfo = this.agents.info();
    out.agents = a.drawn;
    out.agentsNear = a.near;
    out.agentsTotal = a.total;
    out.agentDrawCalls = a.drawCalls;
    out.agentModels = a.models;
    let fromFile = 0;
    for (const src of Object.values(this.actors.carSources())) if (src === "file") fromFile++;
    out.playerCarsFromFile = fromFile;
    out.walkers = this.actors.walkers;
    out.walkersFromFile = this.actors.walkersFromFile;
    const f = this.far.info();
    out.farCellsTotal = f.total;
    out.farCells = f.loaded;
    out.farCellsDrawn = f.drawn;
    out.farTriangles = f.triangles;
    out.farSeamEdges = f.seamEdges;
    out.farBudget = { radius: f.radius, queued: f.queued, loading: f.loading, failed: f.failed };
    out.cameraFar = this.camera.far;
    return out;
  }

  /** Each landmarks.json placement and whether its model is in the scene. */
  landmarkEntries(): Array<{ id: string; x: number; y: number; z: number; loaded: boolean }> {
    return this.landmarks.entries();
  }

  dispose(): void {
    this.surfaceTextures.dispose();
    this.streamer.dispose();
    this.avatarGround.clear();
    this.foliage.dispose();
    this.quality?.dispose();
    this.far.dispose();
    this.actors.dispose();
    this.agents.dispose();
    this.sky.dispose();
    this.water.dispose();
    for (const m of this.materials.all) m.dispose();
    this.nightMats.glow.dispose();
    this.nightMats.pool.dispose();
    for (const e of this.envCache.values()) e.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}

const EMPTY_INFO: RenderInfo = Object.freeze({
  drawCalls: 0,
  triangles: 0,
  tilesLoaded: 0,
  cameraMode: "chase" as CameraMode,
  presentation: false,
  lightingPreset: "day",
  foliage: { near: 0, far: 0, draws: 0 }, surfaceTextures: [],
  night: false,
  tilesPending: 0,
  tilesTotal: 0,
  tilesFailed: 0,
  landmarks: 0,
  fps: 0,
  pixelRatio: 1,
  shadows: false,
  agents: 0,
  agentsNear: 0,
  agentsTotal: 0,
  agentDrawCalls: 0,
  agentModels: [],
  playerCarsFromFile: 0,
  walkers: 0,
  walkersFromFile: 0,
  farCellsTotal: 0,
  farCells: 0,
  farCellsDrawn: 0,
  farTriangles: 0,
  farSeamEdges: 0,
  cameraFar: 0,
});

const NO_TARGET: CameraTarget = Object.freeze({ x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false });

/** An ArrayBuffer holding exactly these bytes (GLTFLoader.parse takes a whole buffer). */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}
