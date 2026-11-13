import { activeWorldTick } from "../sim/pause-timers.ts";
// The M0 renderer: owns the WebGLRenderer, scene, lighting, sky, the Bay, streamed tiles,
// players, ambient agents and landmarks. main.ts feeds it interpolated player poses and the
// two latest sim states (agents are interpolated here); it never changes sim state.

import * as THREE from "three";
import type { Assets } from "../io/assets.ts";
import type { SimState } from "../sim/contract.ts";
import type { TileCollider } from "../sim/world.ts";
import { Actors, CAR_COLORS, makeBoxCar, type CarPose, type WalkerPose } from "./actors.ts";
import { AgentLayer, type AgentRenderInfo } from "./agent-layer.ts";
import { FarLayer } from "./far-layer.ts";
import { parkShapes, parkPavementRegions, tintParks } from "./parks.ts";
import { createPavementMask } from "./pavement.ts";
import type { Viewer } from "./agent-lod.ts";
import { CameraRig, type CameraMode, type CameraTarget, type FlyInput } from "./cameras.ts";
import { LandmarkLayer } from "./landmark-layer.ts";
import { LandmarkFallbacks } from "./landmark-fallback.ts";
import { landmarkRenderReplacements } from "./landmark-replacements.ts";
import { filterLandmarkHulls } from "./landmark-mask.ts";
import type { LandmarkWorldReplacement } from "../io/landmark-world.ts";
import type { TrafficSignalControls } from "../sim/traffic-signals.ts";
import { NightLights } from "./lights.ts";
import { createSharedMaterials, fcUniforms, installFog, setFog, type SharedMaterials } from "./materials.ts";
import { ModelRegistry } from "./model-registry.ts";
import { createNightMaterials, type NightMaterials } from "./props.ts";
import { DAY, NIGHT, Sky, applySkyPreset, sunDirection, LIGHTING_PRESETS, type LightingPreset } from "./sky.ts";
import { createTileLoader } from "./gltf-loader.ts";
import { TileStreamer, type StreamerStats } from "./tile-streamer.ts";
import { StaticScene, type StaticSceneStats } from "./static-scene.ts";
import { clearRenderRetirementOwner, setRenderRetirementOwner, type RenderRetirementOwner, type WarmupStats } from "./renderer-warmup.ts";
import type { BuildingDetailStats } from "./building-character.ts";
import type { GroundFn, Manifest, RoadGraph } from "./types.ts";
import { Water } from "./water.ts";
import { createLandmarkWater } from "./landmark-water.ts";
import { softwareFarBudget } from "./far-selection.ts";
import { AvatarGround } from "./avatar-ground.ts";
import { FoliageLayer } from "./foliage.ts";
import { VisualQuality, presentationLook, type PresentationLook } from "./quality.ts";
import { daylightAt } from "./daylight.ts";
import { CLEAR_WEATHER, WeatherLayer, weatherKey, weatherLight, type TideStrip, type WeatherLook } from "./weather.ts";
import { StreetLightRig } from "./street-lights.ts";
import { CAR_LIGHT_POOL, LAMP_LIGHT_POOL, VEHICLE_STRIDE, CarLightPool, LampLightPool, poolSize } from "./night-light-pools.ts";
import { disposeDetailTextures, detailTextures, detailTexturesLoaded, loadDetailTextures, setDetailTextures, type DetailTextures } from "./detail-textures.ts";
import { GfxGovernor, PIXEL_STEP, renderPixelRatio, tierDetail, type GfxDetail, type GfxStep, type GfxTier } from "./gfx.ts";
import { PLAYER_BODY_FILE } from "./player-body.ts";
import { CROWD_FILES, CrowdHumans } from "./crowd-humans.ts";
import { BLASTER_FILE, type SprayCue } from "./held-blaster.ts";
import { loadSurfaceTextures, type SurfaceTextures } from "./surface-textures.ts";
import { trackGpuMemory, type GpuMemory } from "./gpu-memory.ts";
import { StreetDetailLayer, type StreetDetailInfo } from "./street-detail.ts";
import type { GrassInfo } from "./grass.ts";
import { createGpuEngine, type GpuEngine, type RendererBackendRequest, type PostProcessingInfo } from "./gpu-engine.ts";
import type { WebGPURenderer } from "three/webgpu";
import { GpuInstanceOwnership } from "./gpu-instance-ownership.ts";
import { prepareGpuScene, setGpuMaterialsEnabled, updateGpuMaterialTime } from "./node-materials.ts";

export type { CameraMode } from "./cameras.ts";

export interface RenderOptions {
  /** Node renderer by default; legacy remains an explicit compatibility option. */
  backend?: RendererBackendRequest;
  /** Tile load radius around the camera, metres. */
  radius: number;
  shadows?: boolean;
  quality?: boolean;
  timeOfDay?: keyof typeof LIGHTING_PRESETS;
  /** Account GPU memory (gpu-memory.ts) for renderStats (?gpumem=1; the visual slice). */
  gpuMemory?: boolean;
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
  /** The promenade the King tide floods (the sim's TIDE_PROMENADE), or none. */
  tide?: TideStrip;
  /**
   * WebGPU only: size of the car headlight pool (?carlights=; 0 turns it off) and of the street
   * lamp pool (?lamplights=; 0 keeps the 8-lamp rig of the other backends). Whole numbers from 0
   * to MAX_POOL_SIZE; anything else is clamped. See night-light-pools.ts.
   */
  carLights?: number;
  lampLights?: number;
}

export interface WorldData {
  signals?: TrafficSignalControls;
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
  landmarkReplacements?: readonly LandmarkWorldReplacement[];
}

export interface RenderInfo {
  backend?: "webgpu" | "webgl-node" | "webgl-legacy";
  shadowCascades?: number;
  shadowAtlas?: { width: number; height: number } | null;
  graphicsError?: string | null;
  postProcessing?: PostProcessingInfo;
  staticScene?: StaticSceneStats;
  warmup?: WarmupStats;
  /** Bounded nearby architectural geometry and its style mix. */
  buildingDetail?: BuildingDetailStats;
  grass?: GrassInfo;
  drawCalls: number;
  triangles: number;
  tilesLoaded: number;
  cameraMode: CameraMode;
  presentation: boolean;
  lightingPreset: string;
  /** Whether the light follows the game clock, and the weather drawn (rain streaks, puddles, tide depth). */
  followsClock: boolean;
  weather: { fog: number; rain: boolean; wetness: number; puddles: number; tideM: number };
  /** Street lamps lit by real point lights this frame (high tier, at night). */
  streetLightsLit: number;
  /** Oncoming-car headlights lit by real point lights this frame (WebGPU backend, at night). */
  carLightsLit: number;
  /** Pedestrians drawn as skinned Rocketbox people last frame, and crowd characters loaded. */
  crowdDrawn: number;
  crowdLoaded: number;
  foliage: { near: number; far: number; draws: number };
  surfaceTextures: readonly string[];
  /** Scanned surface detail in use (detail-textures.ts): empty at the low tier or on the legacy renderer. */
  detailTextures?: readonly string[];
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
  /** Pipeline-placed street detail near the camera (street-detail.ts). */
  streetDetail?: StreetDetailInfo;
}

/** The camera sees this far: the far skyline reaches across the city and the Bay. */
export const CAMERA_FAR_M = 20000;
/** The sea plane's side (it follows the camera): beyond the far plane in every direction. */
const SEA_SIZE_M = 2 * CAMERA_FAR_M + 2000;
/** Environment maps kept for the clock's sky and the presets. */
/**
 * Cube size of the sky's environment maps. A new one is built whenever the clock's sun moves a few
 * degrees or the weather steps (envFor), and three's GGX prefilter costs in proportion to its
 * pixels: at the default 256 one build stalled a SwiftShader frame for 3.7 s, at 128 for 0.6 s.
 * The sky is smooth gradients and soft clouds, so the smaller cube costs little detail.
 */
const ENV_MAP_SIZE = 128;
const ENV_CACHE_MAX = 12;
/** The local car's headlight at full night. */
const HEADLIGHT_NIGHT = 140;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer | WebGPURenderer;
  private readonly gpu: GpuEngine | null;
  readonly scene = new THREE.Scene();
  private observationPose:{x:number;y:number;z:number;yaw:number;pitch:number;fovDegrees:number}|null=null;
  private observationFov:number|null=null;
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.5, CAMERA_FAR_M);
  readonly rig: CameraRig;
  readonly streamer: TileStreamer;
  readonly actors: Actors;
  readonly agents: AgentLayer;
  readonly landmarks: LandmarkLayer;
  private readonly landmarkFallbacks:LandmarkFallbacks;
  readonly far: FarLayer;
  readonly streetDetail: StreetDetailLayer;
  readonly lights = new NightLights();
  private readonly container: HTMLElement;
  private readonly materials: SharedMaterials;
  private readonly nightMats: NightMaterials;
  private readonly sky = new Sky();
  private readonly water = new Water(SEA_SIZE_M);
  private readonly landmarkWater: THREE.Mesh | null;
  private readonly ground: (x: number, z: number) => number;
  private readonly avatarGround = new AvatarGround();
  private readonly foliage: FoliageLayer;
  private quality: VisualQuality | null = null;
  /** Point lights at the nearest street lamps at night (high tier only). */
  private streetLights: StreetLightRig | null = null;
  /** WebGPU backend: pools of real lights for the street lamps and the cars' headlights at night. */
  private lampPool: LampLightPool | null = null;
  private carLights: CarLightPool | null = null;
  private readonly carPoses = new Float32Array(512 * VEHICLE_STRIDE);
  private crowd: CrowdHumans | null = null;
  private readonly staticScene: StaticScene;
  private readonly surfaceTextures: SurfaceTextures;
  private frameDelta = 1 / 60;
  private activePreset: LightingPreset["name"] = "day";
  private dayPreset: LightingPreset = DAY;
  private readonly maxPixelRatio: number;
  private pixelBudget: number;
  private readonly tier: GfxTier | "unknown";
  /** The tier's shadow, reflection, AO and anti-aliasing figures (gfx.ts TIER_DETAIL). */
  private readonly detail: Readonly<GfxDetail>;
  /** The scanned surface detail this renderer's materials were built with; it releases them. */
  private readonly detailScans: DetailTextures | null;
  /** Legacy renderer: metres per sun-shadow texel; the shadow box moves in steps of one. */
  private readonly shadowTexel: number;
  private governor: GfxGovernor | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private readonly headlight = new THREE.SpotLight(0xfff0d8, 0, 90, 0.52, 0.55, 1.4);
  private readonly fog = new THREE.FogExp2(0xffffff, 0.0005);
  private readonly pmrem: THREE.PMREMGenerator | null;
  private readonly envCache = new Map<string, THREE.Texture>();
  private readonly envScene = new THREE.Scene();
  private readonly registry: ModelRegistry<THREE.Object3D>;
  private readonly shadows: boolean;
  /** Reads the GPU memory totals when ?gpumem=1 turned the accounting on. */
  private readonly gpuMemory: (() => GpuMemory) | null;
  private readonly sunDir = new THREE.Vector3();
  private nightOn = false;
  /** Lighting fixed by ?tod=, ?night=1, the N key or the debug handle; otherwise it follows the game clock. */
  private lightingPinned = false;
  /** The lighting before weather, its grade and its environment-map key. */
  private baseLight: { preset: LightingPreset; look: PresentationLook; envKey: string } = { preset: DAY, look: presentationLook("day"), envKey: "day" };
  private weatherLook: WeatherLook = CLEAR_WEATHER;
  private readonly weather: WeatherLayer;
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
  private nodeFailed = false;
  private disposed = false;
  /** Only admitted scene objects are held here; removed tiles immediately release their listeners. */
  private readonly watched = new Set<THREE.Object3D>();
  private retirementOwner: RenderRetirementOwner | null = null;
  private readonly gpuChildAdded = (event: { child: THREE.Object3D }): void => this.watchGpuTree(event.child);
  private readonly gpuChildRemoved = (event: { child: THREE.Object3D }): void => { this.unwatchGpuTree(event.child); };
  private readonly resizeListener = (): void => this.resize();
  private readonly gpuGround: GroundFn;
  private instanceOwnership: GpuInstanceOwnership | null = null;

  /** Initialize GPU capabilities before constructing materials or drawing the first frame. */
  static async create(container: HTMLElement, world: WorldData, opts: RenderOptions): Promise<SceneRenderer> {
    if (opts.backend !== "legacy") {
      let gpu: GpuEngine | null = null;
      let candidate: SceneRenderer | null = null;
      try {
        gpu = await createGpuEngine({ backend: opts.backend, shadows: opts.shadows ?? true, quality: opts.quality ?? true, detail: tierDetail(opts.tier) });
        setGpuMaterialsEnabled(true);
        // Scanned surface detail must exist before the city's node materials are built: the engine
        // stops compiling after boot. A missing scan only means no detail (detail-textures.ts).
        setDetailTextures(await loadDetailTextures(path => world.assets ? world.assets.bytes(path)
          : fetch(path).then(r => { if (!r.ok) throw new Error(`${r.status} ${path}`); return r.arrayBuffer(); }).then(b => new Uint8Array(b)),
        tierDetail(opts.tier).surfaceDetail, gpu.renderer.getMaxAnisotropy()));
        candidate = new SceneRenderer(container, world, opts, gpu);
        await gpu.prewarm(candidate.scene, candidate.camera);
        return candidate;
      } catch (error) {
        candidate?.dispose();
        disposeDetailTextures(detailTextures());
        if (gpu) { gpu.renderer.domElement.remove(); await gpu.dispose(); }
        console.warn("[fog-city] Node renderer unavailable; using compatible WebGL renderer.", error);
      }
    }
    setGpuMaterialsEnabled(false);
    setDetailTextures(null);
    return new SceneRenderer(container, world, opts);
  }

  constructor(container: HTMLElement, world: WorldData, opts: RenderOptions, gpu: GpuEngine | null = null) {
    installFog();
    setGpuMaterialsEnabled(gpu !== null);
    this.gpu = gpu; this.gpuGround = world.ground;
    this.container = container;
    this.ground = world.ground;
    this.water.setLevel(world.manifest.water?.y ?? 0);
    // The presentation chain renders into its own target and anti-aliases with FXAA, so the
    // canvas needs no MSAA then: at a large drawing buffer MSAA alone costs hundreds of MB.
    this.renderer = gpu?.renderer ?? new THREE.WebGLRenderer({
      antialias: opts.quality !== true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? true,
      powerPreference: "high-performance",
    });
    const gl = !gpu ? (this.renderer as THREE.WebGLRenderer).getContext() : gpu.backend === "webgl-node" ? gpu.renderer.getContext() as WebGL2RenderingContext : null;
    this.gpuMemory = opts.gpuMemory && gl && !gpu ? trackGpuMemory(gl as WebGL2RenderingContext) : null;
    const rendererInfo = gl?.getExtension("WEBGL_debug_renderer_info");
    const rendererName = gl ? String(gl.getParameter(rendererInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)) : "WebGPU";
    const software = /swiftshader|llvmpipe|software/i.test(rendererName);
    this.shadows = opts.shadows ?? !software;
    this.maxPixelRatio = opts.maxPixelRatio;
    this.pixelBudget = opts.pixelBudget ?? Infinity;
    this.tier = opts.tier ?? "unknown";
    this.detail = tierDetail(this.tier);
    this.detailScans = gpu ? detailTextures() : null;
    this.shadowTexel = (this.detail.shadowHalf * 2) / this.detail.shadowMapSize;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = this.shadows;
    if (!gpu) (this.renderer as THREE.WebGLRenderer).shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = gpu ? null : new THREE.PMREMGenerator(this.renderer as THREE.WebGLRenderer);

    this.scene.fog = this.fog;
    this.scene.add(this.hemi, this.headlight, this.headlight.target);
    if (!gpu) { this.scene.add(this.sky.mesh, this.water.mesh, this.sun, this.sun.target); this.envScene.add(new Sky(900).mesh); }
    if (this.shadows && !gpu) {
      this.sun.castShadow = true;
      const { shadowMapSize: size, shadowHalf: half } = this.detail;
      this.sun.shadow.mapSize.set(size, size);
      const c = this.sun.shadow.camera;
      c.left = -half;
      c.right = half;
      c.top = half;
      c.bottom = -half;
      c.near = 1;
      c.far = 1600;
      this.sun.shadow.bias = -0.00008;
      this.sun.shadow.normalBias = 0.035;
    }

    this.materials = createSharedMaterials();
    this.nightMats = createNightMaterials();

    const gltf = createTileLoader();
    const assets = world.assets;
    this.surfaceTextures = loadSurfaceTextures(this.materials, async path => {
      if (assets) return assets.bytes(path);
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Surface texture: ${response.status} ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    }, { anisotropy: gpu ? gpu.renderer.getMaxAnisotropy() : (this.renderer as THREE.WebGLRenderer).capabilities.getMaxAnisotropy() });
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
    // Far terrain triangles span 100 m. Include paving just outside a park too,
    // otherwise a green edge vertex can interpolate across that neighbouring road.
    const pavement = parks.length ? createPavementMask(world.roads, world.colliders,
      parkPavementRegions(parks)) : undefined;
    this.foliage = new FoliageLayer(this.shadows);
    this.scene.add(this.foliage.group);
    const landmarkReplacements=landmarkRenderReplacements(opts.landmarks,world.colliders.values(),world.landmarkReplacements);
    const landmarkSources=landmarkReplacements.flatMap(l=>l.sources);
    this.far = new FarLayer({
      manifest: world.manifest,
      base: world.base,
      load: loadTile,
      tint: (geo, m, terrain) => tintParks(geo, m, parks, terrain, pavement),
      filterGeometry:landmarkSources.length?(geo,m)=>filterLandmarkHulls(geo,m,landmarkSources):undefined,
      ground: world.ground,
      budget: softwareFarBudget(rendererName),
    });
    this.scene.add(this.far.group);

    this.staticScene = new StaticScene({
      shadowCameras: this.shadows ? (gpu ? gpu.shadowCameras : [this.sun.shadow.camera]) : [],
      material: gpu ? ({side,shadowSide}) => gpu.staticShadowMaterial(side,shadowSide) : undefined,
    });
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
      onReady: (g) => { this.prepareShadows(g); this.avatarGround.addTile(g); this.foliage.addTile(g); this.staticScene.admit(g); },
      onUnload: (g) => { this.staticScene.remove(g); return this.gpu?.retire(g); },
      onTileVisible: (id, visible) => {
        this.far.setTileVisible(id, visible);
        if (!visible) { this.avatarGround.removeTile(id); this.foliage.removeTile(id); }
      },
      tintGround: (geo, m) => tintParks(geo, m, parks, undefined, pavement),
      fallbackCollider: world.fallbackCollider,
    });
    this.far.start();
    this.streetDetail = new StreetDetailLayer({
      foliage: this.foliage,
      base: world.base,
      json: assets ? (path) => assets.json(path) : fetchJson,
      ground: world.ground,
      materials: this.materials,
      roads: world.roads,
      signals: world.signals,
      colliders: world.colliders,
      surfaces: { add: (id, roots) => this.avatarGround.addSurface(id, roots), remove: (id) => this.avatarGround.removeTile(id) },
    });
    this.scene.add(this.streetDetail.group);
    void this.streetDetail.load();
    // With ?shadows=1 the players and the agents cast (and receive) shadows like the city.
    const modelBytes = async (path: string): Promise<Uint8Array> => {
      if (assets) return assets.bytes(path);
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Player model: ${response.status} ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    this.actors = new Actors(this.registry, this.lights, this.shadows,
      available && !available.has(PLAYER_BODY_FILE) ? undefined : modelBytes,
      available && !available.has(BLASTER_FILE) ? undefined : modelBytes);
    this.actors.setSupportHeight((x, y, z) => this.avatarGround.surfaceAt(x, y, z));
    this.scene.add(this.actors.group);
    this.agents = new AgentLayer(this.registry, {}, this.shadows);
    this.agents.setSupportHeight((x, y, z) => this.avatarGround.heightAt(x, y, z));
    this.scene.add(this.agents.group);
    // The nearest pedestrians as skinned Rocketbox people, when the build carries the crowd.
    const crowdFiles = CROWD_FILES.filter((f) => !available || available.has(f));
    if (crowdFiles.length > 0) {
      this.crowd = new CrowdHumans(async (path) => {
        if (assets) return assets.bytes(path);
        const response = await fetch(path);
        if (!response.ok) throw new Error(`Crowd model: ${response.status} ${path}`);
        return new Uint8Array(await response.arrayBuffer());
      }, this.shadows, crowdFiles);
      this.crowd.setSupportHeight((x, y, z) => this.avatarGround.surfaceAt(x, y, z));
      this.agents.setCrowd(this.crowd);
      this.scene.add(this.crowd.group);
    }
    this.landmarkFallbacks=new LandmarkFallbacks(landmarkReplacements,ids=>this.streamer.hideBuildings(ids));
    this.prepareShadows(this.landmarkFallbacks.group);
    this.scene.add(this.landmarkFallbacks.group);
    this.landmarks = new LandmarkLayer(
      opts.landmarks,
      this.registry,
      world.ground,
      (ids) => this.streamer.hideBuildings([...ids,...(world.landmarkReplacements??[])
        .filter(l=>l.sources.some(b=>ids.includes(b.id))).flatMap(l=>l.colliders.map(b=>b.id))]),
      (root) => {
        this.landmarkFallbacks.retire(root.name.slice("landmark:".length));
        this.prepareShadows(root);
        this.lights.track(root);
      },
    );
    this.scene.add(this.landmarks.group);
    this.landmarkWater = createLandmarkWater(world.manifest.world, (gpu?.water ?? this.water.mesh).material as THREE.Material);
    if(this.landmarkWater)this.scene.add(this.landmarkWater);
    this.rig = new CameraRig(this.camera, world.ground, world.occluded);

    // Keep unclipped direct rendering on devices without floating-point color targets.
    if (!gpu && (opts.quality ?? !software) && (this.renderer as THREE.WebGLRenderer).extensions.has("EXT_color_buffer_float")) {
      this.quality = new VisualQuality(this.renderer as THREE.WebGLRenderer, this.scene, this.camera, this.detail.antialias);
      this.streetLights = new StreetLightRig();
      this.scene.add(this.streetLights.group);
    }
    if (gpu) {
      gpu.attach(this.scene, this.camera, world.manifest.water?.y ?? 0);
      // Only WebGPU has clustered lighting (gpu-engine.ts), where more point lights are cheap; the
      // WebGL node backend and the legacy renderer evaluate every light for every pixel and keep 8.
      const clustered = gpu.backend === "webgpu" && this.tier !== "low";
      const lamps = clustered ? poolSize(opts.lampLights, LAMP_LIGHT_POOL) : 0;
      if (lamps > 0) { this.lampPool = new LampLightPool(lamps); this.scene.add(this.lampPool.group); }
      else { this.streetLights = new StreetLightRig(); this.scene.add(this.streetLights.group); }
      const cars = clustered ? poolSize(opts.carLights, CAR_LIGHT_POOL) : 0;
      if (cars > 0) { this.carLights = new CarLightPool(cars); this.scene.add(this.carLights.group); }
    }
    this.weather = new WeatherLayer(opts.tide ?? null, world.ground);
    this.scene.add(this.weather.root);
    const preset = opts.timeOfDay ? LIGHTING_PRESETS[opts.timeOfDay] : opts.night ? NIGHT : DAY;
    this.nightOn = preset.name === "night";
    this.lightingPinned = !!opts.timeOfDay || opts.night;
    if (!this.nightOn) this.dayPreset = preset;
    this.applyPreset(preset);
    this.governor = new GfxGovernor(opts.governed ?? false, {
      post: this.quality !== null || (gpu?.presentation ?? false), shadows: this.shadows, pixelBudget: this.pixelBudget, maxPixelRatio: this.maxPixelRatio,
    });
    window.addEventListener("resize", this.resizeListener);
    this.resize();
    if (gpu) this.watchGpuTree(this.scene);
  }

  /** Convert only newly admitted subtrees, including asynchronously loaded actor/model roots. */
  private watchGpuTree(root: THREE.Object3D): void {
    if (this.disposed || this.watched.has(root)) return;
    const owner=this.retirementOwner??={retire:object=>this.unwatchGpuTree(object)};
    root.updateWorldMatrix(true, true);
    if (this.gpu?.backend === "webgpu") {
      this.instanceOwnership ??= new GpuInstanceOwnership(this.gpu.renderer);
      root.traverse(object => { if ((object as THREE.InstancedMesh).isInstancedMesh) this.instanceOwnership!.adopt(object as THREE.InstancedMesh); });
    }
    prepareGpuScene(root, { ground: this.gpuGround });
    this.gpu?.admit(root);
    root.traverse(object => {
      if (this.watched.has(object)) return;
      this.watched.add(object);
      setRenderRetirementOwner(object,owner);
      object.addEventListener("childadded", this.gpuChildAdded);
      object.addEventListener("childremoved", this.gpuChildRemoved);
    });
  }

  private unwatchGpuTree(root: THREE.Object3D): Promise<void> | void {
    if(!this.watched.has(root))return;
    const retirement=this.gpu?.retire(root);
    root.traverse(object => {
      object.removeEventListener("childadded", this.gpuChildAdded);
      object.removeEventListener("childremoved", this.gpuChildRemoved);
      this.watched.delete(object);
      if(this.retirementOwner)clearRenderRetirementOwner(object,this.retirementOwner);
    });
    return retirement;
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
    // Returning to the clock must also unpin a daytime preset such as golden hour.
    if (on === this.nightOn && (on || !this.lightingPinned)) return;
    this.nightOn = on;
    // Night is a look the player holds; turning it off hands the light back to the game clock.
    this.lightingPinned = on;
    this.daylightKey = "";
    this.applyPreset(on ? NIGHT : this.dayPreset);
  }

  /** Switch to a named lighting preset (noon, golden, twilight, night), as ?tod= does at boot. */
  setTimeOfDay(name: keyof typeof LIGHTING_PRESETS): void {
    this.lightingPinned = true;
    const p = LIGHTING_PRESETS[name];
    this.nightOn = p.name === "night";
    if (!this.nightOn) this.dayPreset = p;
    this.applyPreset(p);
  }

  /**
   * GPU resource figures for budget reports (the visual slice, docs/visual/): renderer.info's live
   * geometries, textures and shader programs; with ?gpumem=1 the bytes the GPU holds in textures
   * and renderbuffers (gpu-memory.ts); and a scene-scan estimate of material textures (each unique
   * texture's base level at 4 bytes a texel, a third more with mipmaps), which misses textures
   * bound only through shader uniforms. Walks the scene: call it on demand, not every frame.
   */
  renderStats(): { geometries: number; textures: number; programs: number; textureBytesEst: number; gpu: GpuMemory | null; fov: number; width: number; height: number; pixelRatio: number; backend: string; trackedBytes: number | null } {
    const seen = new Set<THREE.Texture>();
    let bytes = 0;
    const add = (t: unknown): void => {
      const tex = t as THREE.Texture | null;
      if (!tex || !(tex as THREE.Texture).isTexture || seen.has(tex)) return;
      seen.add(tex);
      const img = tex.image as { width?: number; height?: number; data?: { byteLength?: number } } | undefined;
      const w = img?.width ?? 0;
      const h = img?.height ?? 0;
      const base = img?.data?.byteLength ?? w * h * 4;
      bytes += tex.generateMipmaps ? (base * 4) / 3 : base;
    };
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        for (const v of Object.values(m as unknown as Record<string, unknown>)) add(v);
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u) for (const v of Object.values(u)) add(v?.value);
      }
    });
    add(this.scene.environment);
    const size = this.renderer.getSize(new THREE.Vector2());
    return {
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.gpu ? this.gpu.renderer.info.memory.programs : (this.renderer as THREE.WebGLRenderer).info.programs?.length ?? 0,
      textureBytesEst: Math.round(bytes),
      gpu: this.gpuMemory ? this.gpuMemory() : null,
      fov: this.camera.fov,
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      backend: this.gpu?.backend ?? "webgl-legacy",
      trackedBytes: this.gpu ? this.gpu.renderer.info.memory.total : null,
    };
  }

  /** Whether the lighting follows the game clock (setDaylight) rather than a fixed preset. */
  get followsClock(): boolean {
    return !this.lightingPinned;
  }

  private daylightKey = "";

  /**
   * The game clock's light: the sun for the date and hour, the presets blended by its
   * elevation (daylight.ts). A no-op while the lighting is pinned. Cheap to call every
   * frame: it re-applies only when the hour has moved by a game minute.
   */
  setDaylight(month: number, day: number, hour: number): void {
    if (this.lightingPinned) return;
    const key = `${month}/${day}/${Math.floor(hour * 60)}`;
    if (key === this.daylightKey) return;
    this.daylightKey = key;
    const d = daylightAt(month, day, hour);
    this.nightOn = false;
    this.applyPreset(d.preset, d.look, d.envKey);
  }

  /** The sim's weather at the camera (weatherView); the lighting re-applies when fog or rain move by 1%. */
  setWeather(w: WeatherLook): void {
    const before = this.weatherLook;
    this.weatherLook = w;
    if (Math.abs(before.fog - w.fog) > 0.01 || Math.abs(before.rain - w.rain) > 0.01 || (before.rain > 0) !== (w.rain > 0) || (before.fog > 0) !== (w.fog > 0)) {
      const b = this.baseLight;
      this.applyLit(b.preset, b.look, b.envKey);
    }
  }

  private applyPreset(p: LightingPreset, look: PresentationLook = presentationLook(p.name), envKey: string = p.name): void {
    this.baseLight = { preset: p, look, envKey };
    this.applyLit(p, look, envKey);
  }

  private applyLit(base: LightingPreset, look: PresentationLook, envKey: string): void {
    const p = weatherLight(base, this.weatherLook);
    const night = p.nightFactor ?? (p.name === "night" ? 1 : 0);
    this.quality?.setPreset(p, look);
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
    this.streetLights?.setNight(night);
    this.lampPool?.setNight(night);
    this.carLights?.setNight(night);
    if (this.gpu) this.gpu.setPreset(p, look, `${envKey}:${weatherKey(this.weatherLook)}`);
    else { this.scene.environment = this.envFor(`${envKey}:${weatherKey(this.weatherLook)}`); this.scene.environmentIntensity = p.envIntensity; }
  }

  /**
   * Image-based lighting from the sky itself (the sky uniforms must already hold the light),
   * generated once per key: a preset, or a few degrees of the clock's sun and a step of weather.
   * The cache keeps the ENV_CACHE_MAX most recent maps.
   */
  private envFor(key: string): THREE.Texture {
    if (!this.pmrem) throw new Error("Legacy environment generation requires the WebGL renderer");
    let env = this.envCache.get(key);
    if (env) {
      this.envCache.delete(key);
      this.envCache.set(key, env);
      return env;
    }
    const previousLinear = fcUniforms.fcLinearOutput.value;
    fcUniforms.fcLinearOutput.value = 1;
    try { env = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 2000, { size: ENV_MAP_SIZE }).texture; }
    finally { fcUniforms.fcLinearOutput.value = previousLinear; }
    this.envCache.set(key, env);
    while (this.envCache.size > ENV_CACHE_MAX) {
      const oldest = this.envCache.keys().next().value as string;
      this.envCache.get(oldest)?.dispose();
      this.envCache.delete(oldest);
    }
    return env;
  }

  /**
   * Look-dev only (debug handle): draw the robots nearest the camera with these combat looks,
   * nearest first (null: as the sim says). Render-only; returns the agent ids it chose.
   */
  previewCombatLook(stages: ReadonlyArray<{ rust: number; wet: number; topple: number; height?: number }> | null): number[] {
    if (!stages) {
      this.agents.setCombatLookOverride(null);
      return [];
    }
    const c = this.camera.position;
    const ids = this.agents.nearestRobots(c.x, c.z, stages.length);
    this.agents.setCombatLookOverride(new Map(ids.map((id, i) => [id, { ...stages[i]! }])));
    return ids;
  }

  /** Camera mode switch from outside the key handler (debug, URL). */
  setCameraMode(m: CameraMode): void {
    this.rig.setMode(m);
    this.framesSinceJump = 0;
  }

  /** A recorded coin-op viewing pose; the player remains at the actual overlook. */
  setObservationPose(pose:{x:number;y:number;z:number;yaw:number;pitch:number;fovDegrees:number}|null):void {this.observationPose=pose;}

  /** Jump the free camera (debug, screenshots). Angles in radians. */
  flyTo(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.rig.setFlyPose(x, y, z, yaw, pitch);
    this.framesSinceJump = 0;
  }

  /** No tile queued, loading or building for where the camera is now. */
  tilesSettled(): boolean {
    return !this.nodeFailed && !this.gpu?.failure && this.framesSinceJump >= 2 && this.streamer.settled() && this.far.settled() && this.streetDetail.settled();
  }

  /** Only the streets around the first visible camera, without waiting for the far skyline. */
  startupSurfaceReady(): boolean {
    if (this.nodeFailed || this.gpu?.failure) throw new Error(this.gpu?.failure ?? "Starting street renderer failed");
    return this.streamer.startupSurfaceReady(this.camera.position.x, this.camera.position.z);
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
    this.gpu?.resize();
  }

  /** Knocked-over street trees (impact-layer.ts) through the foliage layer. */
  setFoliageOverride(fn: ((x: number, z: number, matrix: THREE.Matrix4) => THREE.Matrix4 | null) | null): void {
    this.foliage.setOverride(fn);
  }

  /** The governor's step down (gfx.ts): fewer pixels, then no shadows, then no post chain. */
  private stepDown(step: GfxStep): void {
    if (step === "pixels") {
      const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      // renderPixelRatio already enforces a minimum ratio. A fixed pixel floor would
      // make reductions ineffective on phones and smaller game windows.
      this.pixelBudget = Math.min(this.pixelBudget, buffer.x * buffer.y) * PIXEL_STEP;
      this.resize();
    } else if (step === "shadows") {
      this.renderer.shadowMap.enabled = false;
      this.gpu?.setShadows(false);
      this.sun.castShadow = false;
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      // Every lit material compiled its shadow lookups: recompile them without.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
      });
    } else {
      this.quality?.dispose(); this.quality = null;
      this.gpu?.disablePost();
    }
  }

  /**
   * After the GL context came back (context-guard.ts): three.js re-uploads geometry and textures
   * from their CPU copies by itself; the sky's environment maps lived only on the GPU, so they
   * are made again.
   */
  contextRestored(): void {
    if (this.gpu) { this.failNodeRenderer("The graphics context was reset; resuming in compatibility mode."); return; }
    this.envCache.clear();
    const b = this.baseLight;
    this.applyLit(b.preset, b.look, b.envKey);
    this.resize();
  }

  /** Debug/recovery hooks work on the native WebGL renderer and the node WebGL backend. */
  forceContextLoss(): void {
    if (!this.gpu) { (this.renderer as THREE.WebGLRenderer).forceContextLoss(); return; }
    if (this.gpu.backend === "webgl-node") (this.gpu.renderer.getContext() as WebGL2RenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    else this.failNodeRenderer("Graphics device reset requested.");
  }
  forceContextRestore(): void {
    if (!this.gpu) { (this.renderer as THREE.WebGLRenderer).forceContextRestore(); return; }
    if (this.gpu.backend === "webgl-node") (this.gpu.renderer.getContext() as WebGL2RenderingContext).getExtension("WEBGL_lose_context")?.restoreContext();
  }
  private failNodeRenderer(message: string): void {
    if (this.nodeFailed) return;
    this.nodeFailed = true;
    console.warn(`[fog-city] ${message}`);
    // Reuse the existing save-and-safe-mode recovery flow, rather than losing game progress.
    this.renderer.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  }

  setCar(id: string, pose: CarPose): void {
    this.actors.setCar(id, { ...pose, y: this.avatarGround.heightAt(pose.x, pose.y, pose.z) });
  }

  /** This frame's spray for player `id` (held-blaster.ts), or null. */
  setSpray(id: string, cue: SprayCue | null): void {
    this.actors.setSpray(id, cue);
  }

  /** Where player `id`'s stream leaves the blaster's nozzle (world), or null. */
  nozzle(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    return this.actors.nozzle(id, out);
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
   * a slow sim is not cured by drawing less. A render stall can itself create a tick backlog,
   * so catch-up alone must not disable the governor.
   */
  frame(
    dtSeconds: number,
    local: { id: string; target: CameraTarget } | null,
    fly: Readonly<FlyInput>,
    minuteOfDay: number,
    frameSeconds: number = dtSeconds,
    simSeconds = 0,
    _simCatchingUp = false,
  ): void {
    this.frameDelta = dtSeconds;
    this.time += dtSeconds;
    fcUniforms.fcTime.value = this.time;
    if (this.gpu) updateGpuMaterialTime(this.time, this.ground(this.camera.position.x, this.camera.position.z));
    if (frameSeconds > 0) this.fpsAvg += (1 / Math.max(frameSeconds, 1e-3) - this.fpsAvg) * Math.min(1, frameSeconds * 2);
    const step = this.governor?.frame(Math.max(1e-4, frameSeconds - simSeconds), !this.tilesSettled() || document.hidden);
    if (step) this.stepDown(step);
    if (local) {
      const t = local.target;
      this.actors.hideFor(this.rig.mode === "first-person" && t.robotaxiId === undefined ? local.id : null, t.onFoot ? "person" : "car");
      this.agents.setHiddenAgent(this.rig.mode === "first-person" ? t.robotaxiId ?? null : null);
      this.rig.update(dtSeconds, t, fly);
      // The headlight rides on the local car; on foot it is dark (intensity 0, still in the scene).
      const fx = Math.sin(t.heading);
      const fz = -Math.cos(t.heading);
      this.headlight.intensity = t.onFoot ? 0 : this.headlightBase;
      this.headlight.position.set(t.x + fx * 2.2, t.y + 0.9, t.z + fz * 2.2);
      this.headlight.target.position.set(t.x + fx * 30, t.y - 1.5, t.z + fz * 30);
      this.headlight.target.updateMatrixWorld();
    } else {
      this.agents.setHiddenAgent(null);
      this.rig.update(dtSeconds, NO_TARGET, fly);
    }
    const observation=this.observationPose;
    if(observation){
      this.observationFov??=this.camera.fov;
      this.camera.position.set(observation.x,observation.y,observation.z);
      this.camera.lookAt(observation.x+Math.sin(observation.yaw)*Math.cos(observation.pitch),observation.y+Math.sin(observation.pitch),observation.z-Math.cos(observation.yaw)*Math.cos(observation.pitch));
      if(this.camera.fov!==observation.fovDegrees){this.camera.fov=observation.fovDegrees;this.camera.updateProjectionMatrix();}
      this.camera.updateMatrixWorld();
    }else if(this.observationFov!==null){this.camera.fov=this.observationFov;this.observationFov=null;this.camera.updateProjectionMatrix();}
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
      if (this.carLights) this.carLights.update(cam.x, cam.z, this.viewer.fx, this.viewer.fz, this.carPoses, this.agents.vehiclePoses(this.carPoses, local?.target.robotaxiId ?? null));
    }
    this.fitNearPlane();
    this.sky.follow(this.camera);
    this.water.follow(this.camera);
    // Keep the sun light (and its shadow box) centred near the camera.
    // Move in texel-sized steps, rather than visibly jumping twenty metres.
    const sx = Math.round(cam.x / this.shadowTexel) * this.shadowTexel;
    const sz = Math.round(cam.z / this.shadowTexel) * this.shadowTexel;
    const groundY = this.ground(sx, sz);
    this.sun.target.position.set(sx, groundY, sz);
    this.sun.position.set(sx + this.sunDir.x * 800, groundY + this.sunDir.y * 800, sz + this.sunDir.z * 800);
    this.sun.target.updateMatrixWorld();
    this.streamer.update(cam.x, cam.z, 4);
    this.streetLights?.update(cam.x, cam.z, dtSeconds, this.streamer.lampHeads());
    this.lampPool?.update(cam.x, cam.z, dtSeconds, this.streamer.lampHeads(), this.viewer.fx, this.viewer.fz);
    this.far.update(cam.x, cam.z);
    this.foliage.update(cam.x, cam.z);
    this.streetDetail.setView(this.camera, this.shadows ? this.sunDir : null);
    this.streetDetail.update(cam.x, cam.z, this.sim?activeWorldTick(this.sim.curr):0);
    this.landmarks.update(minuteOfDay);
    this.weather.update(this.weatherLook, this.camera, this.time, fcUniforms.fcNight.value);
    this.staticScene.update();
    this.gpu?.frame(this.time, this.camera, cam.y - this.ground(cam.x, cam.z));
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
    if (this.gpu) {
      if (this.nodeFailed) return;
      try { this.gpu.render(this.scene, this.camera); }
      catch (error) { this.failNodeRenderer(error instanceof Error ? error.message : String(error)); return; }
    } else if (this.quality) this.quality.render(this.frameDelta);
    else this.renderer.render(this.scene, this.camera);
    this.far.endFrame();
    this.framesSinceJump++;
    this.lastCalls = this.gpu ? this.gpu.renderer.info.render.drawCalls : this.renderer.info.render.calls;
    this.lastTris = this.renderer.info.render.triangles;
  }

  /** Render stats. Fills `out` (reused by the HUD every frame) or a fresh object. */
  info(out: RenderInfo = { ...EMPTY_INFO }): RenderInfo {
    out.backend = this.gpu?.backend ?? "webgl-legacy";
    out.staticScene = this.staticScene.info();
    out.warmup = this.gpu?.warmupInfo;
    out.shadowCascades = this.gpu?.shadowCascades ?? (this.renderer.shadowMap.enabled ? 1 : 0);
    out.shadowAtlas = this.gpu?.shadowAtlas ?? null;
    out.graphicsError = this.gpu?.failure ?? null;
    out.postProcessing = this.gpu?.postProcessing;
    const s = this.streamer.stats(this.statsScratch);
    out.drawCalls = this.lastCalls;
    out.triangles = this.lastTris;
    out.tilesLoaded = s.ready;
    out.cameraMode = this.rig.mode;
    out.presentation = this.quality !== null || (this.gpu?.presentation ?? false);
    out.lightingPreset = this.activePreset;
    out.followsClock = !this.lightingPinned;
    out.weather = { fog: this.weatherLook.fog, wetness: this.weatherLook.wetness, ...this.weather.info };
    out.streetLightsLit = (this.streetLights?.lit ?? 0) + (this.lampPool?.lit ?? 0);
    out.carLightsLit = this.carLights?.lit ?? 0;
    out.crowdDrawn = this.crowd?.drawn ?? 0;
    out.crowdLoaded = this.crowd?.loaded ?? 0;
    out.foliage = this.foliage.info;
    out.surfaceTextures = this.surfaceTextures.loaded;
    out.detailTextures = this.detailScans ? detailTexturesLoaded() : [];
    out.night = this.nightOn;
    out.tilesPending = s.pending;
    out.tilesTotal = s.total;
    out.tilesFailed = s.failed;
    out.landmarks = this.landmarks.count;
    out.fps = this.fpsAvg;
    out.pixelRatio = this.renderer.getPixelRatio();
    out.gfx = { tier: this.tier, pixelBudget: this.pixelBudget, steps: this.governor?.taken ?? [] };
    out.shadows = this.renderer.shadowMap.enabled;
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
    out.streetDetail = this.streetDetail.info();
    out.buildingDetail = this.streamer.buildingDetailInfo();
    out.grass = this.streetDetail.grass.info();
    return out;
  }

  /** Each landmarks.json placement and whether its model is in the scene. */
  landmarkEntries(): Array<{ id: string; x: number; y: number; z: number; loaded: boolean }> {
    return this.landmarks.entries();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.resizeListener);
    for (const object of this.watched) {
      object.removeEventListener("childadded", this.gpuChildAdded);
      object.removeEventListener("childremoved", this.gpuChildRemoved);
      if(this.retirementOwner)clearRenderRetirementOwner(object,this.retirementOwner);
    }
    this.watched.clear();
    // The active borrower may be an already-detached avatar/car, so retire the view's
    // entire admission queue before releasing shared prototypes and scene resources.
    const retirement=this.gpu?.retireAll();
    const release=():void=>{
      this.surfaceTextures.dispose();
      disposeDetailTextures(this.detailScans);
      this.streamer.dispose();
      this.staticScene.dispose();
      this.avatarGround.clear();
      this.foliage.dispose();
      this.quality?.dispose();
      this.streetLights?.dispose();
      this.lampPool?.dispose();
      this.carLights?.dispose();
      this.far.dispose();
      this.landmarkFallbacks.dispose();
      this.streetDetail.dispose();
      this.actors.dispose();
      this.agents.dispose();
      this.crowd?.dispose();
      this.sky.dispose();
      this.water.dispose();
      this.landmarkWater?.geometry.dispose();
      (this.landmarkWater?.material as THREE.Material | undefined)?.dispose();
      this.weather.dispose();
      for (const m of this.materials.all) m.dispose();
      this.nightMats.glow.dispose();
      this.nightMats.pool.dispose();
      for (const e of this.envCache.values()) e.dispose();
      this.pmrem?.dispose();
      this.instanceOwnership?.dispose();
      if (this.gpu) void this.gpu.dispose(); else this.renderer.dispose();
    };
    // A stopped view must not destroy a representative's geometry, textures or instance
    // owner while its already-started shader build is still borrowing those resources.
    if(retirement)void retirement.then(release,release);else release();
  }
}

const EMPTY_INFO: RenderInfo = Object.freeze({
  drawCalls: 0,
  triangles: 0,
  tilesLoaded: 0,
  cameraMode: "chase" as CameraMode,
  presentation: false,
  lightingPreset: "day",
  followsClock: false,
  weather: { fog: 0, rain: false, wetness: 0, puddles: 0, tideM: 0 },
  streetLightsLit: 0,
  carLightsLit: 0,
  crowdDrawn: 0,
  crowdLoaded: 0,
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
async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}
