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
import { makeDrawnGroundFn } from "./ground.ts";
import type { Viewer } from "./agent-lod.ts";
import { CameraRig, type CameraMode, type CameraTarget, type FlyInput } from "./cameras.ts";
import { LandmarkLayer } from "./landmark-layer.ts";
import { NightLights } from "./lights.ts";
import { createSharedMaterials, fcUniforms, installFog, setFog, type SharedMaterials } from "./materials.ts";
import { ModelRegistry } from "./model-registry.ts";
import { createNightMaterials, type NightMaterials } from "./props.ts";
import { DAY, NIGHT, NOON, Sky, applySkyPreset, sunDirection, type LightingPreset } from "./sky.ts";
import { createTileLoader } from "./gltf-loader.ts";
import { TileStreamer, type StreamerStats } from "./tile-streamer.ts";
import type { LookFn } from "./house-kit.ts";
import { loadKitLib } from "./house-kit-mesh.ts";
import { parseKitDoc, type StorefrontAnchor } from "./house-kit-props.ts";
import type { GroundFn, Manifest, RoadGraph } from "./types.ts";
import { Water, WaterReflection } from "./water.ts";
import { applyTriplanar, DetailMaterial, loadDetailSets, textureBytes, type DetailSet } from "./detail.ts";
import { chooseTier, featuresFor, GfxGovernor, probeCaps, type GfxChoice, type GfxFeatures, type GfxRequest } from "./gfx.ts";
import { PostChain } from "./post.ts";
import { CrowdRig } from "./crowd.ts";
import { PlayerBodies } from "./player-body.ts";
import { buildShowcase, MASK_HALF_M, SHOWCASE, type Showcase, type ShowcaseStats } from "./showcase.ts";

/** How far from the showcase's centre the camera may be for the Bay to mirror the city. */
const REFLECT_REACH_M = 2500;

export type { CameraMode } from "./cameras.ts";

export type TimeOfDay = "golden" | "noon" | "night";

export interface RenderOptions {
  /** Tile load radius around the camera, metres. */
  radius: number;
  shadows: boolean;
  night: boolean;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** Known model files (paths under public/), or null to try every URL. */
  models: ReadonlySet<string> | null;
  /** content/landmarks.json, parsed, or null. */
  landmarks: unknown;
  /** public/models/house-kit/house-kit.json (the house kit's prototypes); null or absent: no kit geometry. */
  houseKit?: unknown;
  /** ?gfx=high|default|auto (gfx.ts); absent: auto. */
  gfx?: GfxRequest;
  /** ?gfxoff=post,shadows,detail,showcase: high-tier features to leave off (A/B comparisons). */
  gfxOff?: readonly string[];
}

export interface WorldData {
  manifest: Manifest;
  base: string;
  colliders: ReadonlyMap<string, TileCollider>;
  roads: RoadGraph | null;
  ground: GroundFn;
  /** boundary.json (its shore lines get quay faces), or null. */
  boundary?: { shore: ReadonlyArray<{ closed: boolean; lake?: unknown; points: ReadonlyArray<readonly number[]> }> } | null;
  /** True when (x, y, z) is inside a building below its roof (camera pull-in). */
  occluded: (x: number, y: number, z: number) => boolean;
  /** Where glb bytes come from (loose files or the packed build). Omitted: fetch each URL. */
  assets?: Assets;
  /** A tile's own collider (with building meta) for a tile whose glb failed; see StreamerOptions. */
  fallbackCollider?: (id: string) => Promise<TileCollider | null>;
  /** The house kit's colours and materials per building (house-colours.ts houseLookFn). */
  houseLook?: LookFn;
  /** storefronts.json's anchors (K5), or null. */
  storefronts?: readonly StorefrontAnchor[] | null;
}

export interface RenderInfo {
  drawCalls: number;
  triangles: number;
  tilesLoaded: number;
  cameraMode: CameraMode;
  night: boolean;
  tilesPending: number;
  tilesTotal: number;
  tilesFailed: number;
  landmarks: number;
  fps: number;
  pixelRatio: number;
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
  /** Players drawn from models/player-car.glb (the rest use the procedural car). */
  playerCarsFromFile: number;
  /** Players drawn on foot last frame. */
  walkers: number;
  /** Far-LOD cells the manifest lists, loaded into the scene, and drawn in the last frame. */
  farCellsTotal: number;
  farCells: number;
  farCellsDrawn: number;
  /** Triangles in the loaded far cells. */
  farTriangles: number;
  /** The camera's far plane, metres. */
  cameraFar: number;
  /** The graphics tier (gfx.ts), why, and which of its features are on now. */
  gfx: {
    tier: GfxChoice["tier"];
    requested: GfxChoice["requested"];
    reason: string;
    post: boolean;
    reflections: boolean;
    detail: boolean;
    detailSets: number;
    dropped: string[];
    /** The Ferry Building showcase's street detail (showcase.ts), once built. */
    showcase: ShowcaseStats | null;
    /** The animated crowd and the skinned player body are in (else the placeholders draw). */
    characters: { crowd: boolean; player: boolean };
  };
}

const SHADOW_HALF = 160;
/** The high tier's shadow box (half side, metres) and map: crisper, and reaching the plaza's far side. */
const SHADOW_HALF_HIGH = 140;
const SHADOW_MAP_HIGH = 4096;
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
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private readonly headlight = new THREE.SpotLight(0xfff0d8, 0, 90, 0.52, 0.55, 1.4);
  private readonly fog = new THREE.FogExp2(0xffffff, 0.0005);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envCache = new Map<string, THREE.Texture>();
  private readonly envScene = new THREE.Scene();
  private readonly registry: ModelRegistry<THREE.Object3D>;
  private readonly shadows: boolean;
  readonly gfx: GfxChoice;
  private readonly features: GfxFeatures;
  private post: PostChain | null = null;
  private reflection: WaterReflection | null = null;
  private readonly governor: GfxGovernor;
  private detailSets = 0;
  private showcase: Showcase | null = null;
  /** How the ground's detail is applied (set once the texture sets land), and tile ground materials waiting for it. */
  private groundDetail: ((m: THREE.MeshStandardMaterial) => void) | null = null;
  private readonly groundWaiting: THREE.MeshStandardMaterial[] = [];
  /** Landmark models placed before the texture sets landed, and the materials already dressed. */
  private readonly landmarkWaiting: THREE.Object3D[] = [];
  private readonly dressed = new WeakSet<THREE.Material>();
  private landmarkSets: Map<string, DetailSet> | null = null;
  private readonly drawnGround: (x: number, z: number) => number;
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.gfx = chooseTier(opts.gfx ?? "auto", probeCaps(this.renderer.getContext()));
    this.features = featuresFor(this.gfx.tier, opts.shadows);
    for (const k of opts.gfxOff ?? []) if (k in this.features) this.features[k as keyof GfxFeatures] = false;
    // Only a tier the browser was given by auto steps down; ?gfx=high keeps every feature on.
    this.governor = new GfxGovernor(this.gfx.tier === "high" && this.gfx.requested === "auto");
    const high = this.gfx.tier === "high";
    this.shadows = this.features.shadows;
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The post chain renders several times a frame: count the whole frame (reset in render()).
    this.renderer.info.autoReset = !this.features.post;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.scene.fog = this.fog;
    this.scene.add(this.sky.mesh, this.water.mesh, this.sun, this.sun.target, this.hemi, this.headlight, this.headlight.target);
    this.envScene.add(new Sky(900).mesh);
    if (this.shadows) {
      this.sun.castShadow = true;
      const map = high ? SHADOW_MAP_HIGH : 2048;
      const half = high ? SHADOW_HALF_HIGH : SHADOW_HALF;
      this.sun.shadow.mapSize.set(map, map);
      const c = this.sun.shadow.camera;
      c.left = -half;
      c.right = half;
      c.top = half;
      c.bottom = -half;
      c.near = 1;
      c.far = 1600;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
      // Soft edges (PCF with a wider kernel): the high tier's penumbra.
      if (high) this.sun.shadow.radius = 3;
    }

    this.materials = createSharedMaterials();
    this.nightMats = createNightMaterials();
    if (this.features.post) this.post = new PostChain(this.renderer, this.scene, this.camera, opts.gfxOff ?? []);
    if (this.features.reflections) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.reflection = new WaterReflection(size.x >> 1, size.y >> 1);
    }
    this.drawnGround = makeDrawnGroundFn([...world.colliders.values()]);
    if (this.features.detail) this.loadDetail(world.assets, world.roads);

    const gltf = new GLTFLoader();
    const assets = world.assets;
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
    this.far = new FarLayer({
      manifest: world.manifest,
      base: world.base,
      load: loadTile,
    });
    this.scene.add(this.far.group);

    this.streamer = new TileStreamer({
      parent: this.scene,
      manifest: world.manifest,
      base: world.base,
      colliders: world.colliders,
      roads: world.roads,
      ground: world.ground,
      drawnGround: this.drawnGround,
      materials: this.materials,
      night: this.nightMats,
      radius: opts.radius,
      loadGltf: assets ? loadTile : undefined,
      onReady: (g) => this.prepareShadows(g),
      onGroundMaterial: (gm) => {
        if (!this.features.detail) return;
        if (this.groundDetail) this.groundDetail(gm);
        else this.groundWaiting.push(gm);
      },
      onTileVisible: (id, visible) => this.far.setTileVisible(id, visible),
      lakeMaterial: this.water.lakeMaterial,
      shore: world.boundary?.shore,
      fallbackCollider: world.fallbackCollider,
      houseLook: world.houseLook,
      storefronts: world.storefronts,
    });
    this.far.start();
    // The house kit's prototypes (bays, stoops, mouldings, roof props): near tiles build their
    // kit once they arrive; a prototype that fails to load is simply not drawn.
    const kitDoc = parseKitDoc(opts.houseKit);
    if (kitDoc) void loadKitLib(this.registry, kitDoc).then((lib) => this.streamer.setKitLib(lib, kitDoc));
    // With ?shadows=1 the players and the agents cast (and receive) shadows like the city.
    this.actors = new Actors(this.registry, this.lights, opts.shadows);
    this.scene.add(this.actors.group);
    this.agents = new AgentLayer(this.registry, {}, opts.shadows);
    this.scene.add(this.agents.group);
    if (this.features.characters) this.loadCharacters(world.assets);
    this.landmarks = new LandmarkLayer(
      opts.landmarks,
      this.registry,
      world.ground,
      (ids) => this.streamer.hideBuildings(ids),
      (root) => {
        this.prepareShadows(root);
        this.lights.track(root);
        if (this.features.detail) {
          if (this.landmarkSets) this.dressLandmark(root);
          else this.landmarkWaiting.push(root);
        }
      },
    );
    this.scene.add(this.landmarks.group);
    this.rig = new CameraRig(this.camera, world.ground, world.occluded);

    this.nightOn = opts.night;
    this.applyPreset(opts.night ? NIGHT : DAY);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  /** The high tier's people: the animated crowd and the skinned player body; each keeps the placeholder if its files fail. */
  private loadCharacters(assets: Assets | undefined): void {
    const bytes = textureBytes(assets);
    void CrowdRig.load(bytes, [400, 600], this.shadows)
      .then((crowd) => {
        this.agents.setCrowd(crowd);
        this.charactersOn.crowd = true;
      })
      .catch((err) => console.warn("crowd: placeholder people kept:", err));
    void PlayerBodies.load(bytes, this.shadows)
      .then((bodies) => {
        this.actors.setBodies(bodies);
        this.charactersOn.player = true;
      })
      .catch((err) => console.warn("player body: placeholder kept:", err));
  }

  private readonly charactersOn = { crowd: false, player: false };

  /** The high tier's PBR detail on the ground, roads and sidewalks (detail.ts); the materials recompile once when it lands. */
  private loadDetail(assets: Assets | undefined, roads: RoadGraph | null): void {
    const m = this.materials;
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    void loadDetailSets(textureBytes(assets), ["asphalt", "concrete", "grass", "pavers", "paint", "sandstone"], aniso).then((sets) => {
      this.detailSets = sets.size;
      this.landmarkSets = sets;
      for (const root of this.landmarkWaiting.splice(0)) this.dressLandmark(root);
      const asphalt = sets.get("asphalt");
      const concrete = sets.get("concrete");
      const grass = sets.get("grass");
      const pavers = sets.get("pavers");
      const paint = sets.get("paint");
      const road = { albedo: 1, normalScale: 1, roughness: 1, ao: 0.6, farM: 160 };
      if (asphalt) for (const mat of [m.roadUv, m.freewayUv, m.road]) new DetailMaterial(mat).apply(asphalt, road);
      if (concrete) new DetailMaterial(m.sidewalk).apply(concrete, { albedo: 1, normalScale: 1, roughness: 1, ao: 0.7, farM: 120 });
      if (!concrete) return;
      // The Ferry Building showcase: paint, the F-line and palms, and pavers under its mask.
      if (this.features.showcase && roads) {
        this.showcase = buildShowcase(roads, this.drawnGround, {
          paint: paint ? { orm: paint.orm, normal: paint.normal } : undefined,
          concrete: { albedo: concrete.albedo.clone(), normal: concrete.normal.clone(), orm: concrete.orm.clone(), sizeM: concrete.info.sizeM },
        });
        this.prepareShadows(this.showcase.group);
        // Paint, trackbed and rails lie on the road: they receive shadows but never cast them.
        this.showcase.group.traverse((o) => {
          if (/paint|trackbed|rails/.test(o.name)) o.castShadow = false;
        });
        this.scene.add(this.showcase.group);
      }
      // The shared ground and every tile's own ground (bores cut out under it) wear the same detail.
      const mask = this.showcase?.mask ?? null;
      this.groundDetail = (gm) => {
        const d = new DetailMaterial(gm);
        d.apply(concrete, { albedo: 0.8, normalScale: 0.8, roughness: 1, ao: 0.5, farM: 160, greyOnly: true }, grass);
        if (pavers && mask) d.setMasked(pavers, mask, MASK_HALF_M);
      };
      this.groundDetail(m.ground);
      for (const gm of this.groundWaiting.splice(0)) this.groundDetail(gm);
    });
  }

  /**
   * The high tier's stone on the landmark models (they carry no UVs): world-space triplanar detail
   * on the materials named for sandstone (the Ferry Building, R-Evolution's plinth...), slate and
   * concrete. Materials are shared between clones: each is dressed once.
   */
  private dressLandmark(root: THREE.Object3D): void {
    const sets = this.landmarkSets;
    if (!sets) return;
    const sandstone = sets.get("sandstone");
    const concrete = sets.get("concrete");
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const m = mat as THREE.MeshStandardMaterial;
        if (!m.isMeshStandardMaterial || this.dressed.has(m)) continue;
        const name = m.name.toLowerCase();
        if (sandstone && /sandstone|stone|limestone|granite|plinth/.test(name)) {
          applyTriplanar(m, sandstone, { albedo: 0.9, normalScale: 1.2, roughness: 0.8, ao: 0.8, farM: 260 });
        } else if (concrete && /concrete|roof|slate|plaster|stucco/.test(name)) {
          applyTriplanar(m, concrete, { albedo: 0.6, normalScale: 0.8, roughness: 0.6, ao: 0.6, farM: 200 });
        } else continue;
        this.dressed.add(m);
      }
    });
  }

  private prepareShadows(root: THREE.Object3D): void {
    if (!this.shadows) return;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = m.name || m.parent?.name || "";
      m.receiveShadow = true;
      m.castShadow = !/ground|road|pool|sidewalk|lake/.test(name);
    });
  }

  get night(): boolean {
    return this.nightOn;
  }

  setNight(on: boolean): void {
    if (on === this.nightOn) return;
    this.nightOn = on;
    this.applyPreset(on ? NIGHT : this.daylight);
  }

  /** The daylight look: golden hour (the default, 18:52) or midday; night stays the N key's. */
  private daylight: LightingPreset = DAY;

  /** "golden" (the default day), "noon" or "night" (?tod=, the debug handle). */
  setTimeOfDay(t: TimeOfDay): void {
    this.daylight = t === "noon" ? NOON : DAY;
    this.nightOn = t === "night";
    this.applyPreset(this.nightOn ? NIGHT : this.daylight);
  }

  get timeOfDay(): TimeOfDay {
    return this.nightOn ? "night" : this.daylight === NOON ? "noon" : "golden";
  }

  private applyPreset(p: LightingPreset): void {
    const night = p.name === "night" ? 1 : 0;
    applySkyPreset(p);
    this.fog.color.setHex(p.fogColor);
    setFog(p.fog, this.fog);
    this.renderer.toneMappingExposure = p.exposure;
    sunDirection(p, this.sunDir);
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    // The high tier's shadows take the sun off whole streets: more sky and warmer bounce fill
    // what they leave (the default tier has no shadows and keeps its balance).
    const fill = this.shadows && this.gfx.tier === "high" ? 1.7 : 1;
    this.hemi.intensity = p.hemiIntensity * fill;
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
    this.post?.setNight(night > 0);
    this.scene.environment = this.envFor(p);
    this.scene.environmentIntensity = p.envIntensity * (fill > 1 ? 1.35 : 1);
  }

  /** Image-based lighting from the sky itself, generated once per preset. */
  private envFor(p: LightingPreset): THREE.Texture {
    let env = this.envCache.get(p.name);
    if (!env) {
      env = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 2000).texture;
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
    return this.framesSinceJump >= 2 && this.streamer.settled() && this.streamer.kitsSettled() && this.far.settled();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    if (this.reflection) {
      const pr = this.renderer.getPixelRatio();
      this.reflection.setSize(Math.round((w * pr) / 2), Math.round((h * pr) / 2));
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCar(id: string, pose: CarPose): void {
    this.actors.setCar(id, pose);
  }

  setFoot(id: string, pose: WalkerPose | null): void {
    this.actors.setFoot(id, pose);
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
   * uses (main.ts clamps it); `frameSeconds` is the real, unclamped frame time, for the FPS figure.
   */
  frame(
    dtSeconds: number,
    local: { id: string; target: CameraTarget } | null,
    fly: Readonly<FlyInput>,
    minuteOfDay: number,
    frameSeconds: number = dtSeconds,
  ): void {
    this.time += dtSeconds;
    fcUniforms.fcTime.value = this.time;
    if (frameSeconds > 0) this.fpsAvg += (1 / Math.max(frameSeconds, 1e-3) - this.fpsAvg) * Math.min(1, frameSeconds * 2);
    this.govern(frameSeconds);
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
    const sx = Math.round(cam.x / 20) * 20;
    const sz = Math.round(cam.z / 20) * 20;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + this.sunDir.x * 800, this.sunDir.y * 800, sz + this.sunDir.z * 800);
    this.sun.target.updateMatrixWorld();
    this.streamer.update(cam.x, cam.z, 4);
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

  /** Within REFLECT_REACH_M of the showcase, above the water: the Bay mirrors the city. */
  private renderReflection(): void {
    const r = this.reflection;
    if (!r) return;
    const c = this.camera.position;
    const level = this.water.seaLevel;
    const on = Math.hypot(c.x - SHOWCASE.x, c.z - SHOWCASE.z) < REFLECT_REACH_M && c.y > level + 0.3;
    if (!on) {
      this.water.setReflection(r, 0);
      return;
    }
    r.render(this.renderer, this.scene, this.camera, level, this.water.mesh);
    this.water.setReflection(r, 1);
  }

  /** The high tier steps down when it cannot hold its frame rate (gfx.ts GfxGovernor). */
  private govern(frameSeconds: number): void {
    const drop = this.governor.frame(frameSeconds, !this.streamer.settled());
    if (drop === "reflections" && this.reflection) {
      this.water.setReflection(null, 0);
      this.reflection.dispose();
      this.reflection = null;
      console.info("gfx: water reflections off (frame rate)");
    } else if (drop === "post" && this.post) {
      this.post.dispose();
      this.post = null;
      this.renderer.info.autoReset = true;
      console.info("gfx: post-processing off (frame rate)");
    } else if (drop === "shadows" && this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      // Materials compiled with shadow maps recompile without them.
      this.scene.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) x.needsUpdate = true;
      });
      console.info("gfx: shadows off (frame rate)");
    }
  }

  render(): void {
    if (!this.renderer.info.autoReset) this.renderer.info.reset();
    this.renderReflection();
    if (this.post) this.post.render();
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
    out.night = this.nightOn;
    out.tilesPending = s.pending;
    out.tilesTotal = s.total;
    out.tilesFailed = s.failed;
    out.landmarks = this.landmarks.count;
    out.fps = this.fpsAvg;
    out.pixelRatio = this.renderer.getPixelRatio();
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
    const f = this.far.info();
    out.farCellsTotal = f.total;
    out.farCells = f.loaded;
    out.farCellsDrawn = f.drawn;
    out.farTriangles = f.triangles;
    out.cameraFar = this.camera.far;
    out.gfx = {
      tier: this.gfx.tier,
      requested: this.gfx.requested,
      reason: this.gfx.reason,
      post: this.post !== null,
      reflections: this.reflection !== null,
      detail: this.features.detail,
      detailSets: this.detailSets,
      dropped: [...this.governor.dropped],
      showcase: this.showcase?.stats ?? null,
      characters: { ...this.charactersOn },
    };
    return out;
  }

  /** Each landmarks.json placement and whether its model is in the scene. */
  landmarkEntries(): Array<{ id: string; x: number; y: number; z: number; loaded: boolean }> {
    return this.landmarks.entries();
  }

  dispose(): void {
    this.streamer.dispose();
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
    this.post?.dispose();
    this.reflection?.dispose();
    this.showcase?.dispose();
    this.renderer.dispose();
  }
}

const EMPTY_INFO: RenderInfo = Object.freeze({
  drawCalls: 0,
  triangles: 0,
  tilesLoaded: 0,
  cameraMode: "chase" as CameraMode,
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
  farCellsTotal: 0,
  farCells: 0,
  farCellsDrawn: 0,
  farTriangles: 0,
  cameraFar: 0,
  gfx: { tier: "default" as const, requested: "auto" as const, reason: "", post: false, reflections: false, detail: false, detailSets: 0, dropped: [], showcase: null, characters: { crowd: false, player: false } },
});

const NO_TARGET: CameraTarget = Object.freeze({ x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false });

/** An ArrayBuffer holding exactly these bytes (GLTFLoader.parse takes a whole buffer). */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}
