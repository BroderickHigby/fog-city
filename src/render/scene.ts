// The M0 renderer: owns the WebGLRenderer, scene, lighting, sky, the Bay, streamed tiles,
// players and landmarks. main.ts feeds it interpolated sim poses; it never touches sim state.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { TileCollider } from "../sim/world.ts";
import { Actors, makeBoxCar } from "./actors.ts";
import { CameraRig, type CameraMode, type CameraTarget, type FlyInput } from "./cameras.ts";
import { LandmarkLayer } from "./landmark-layer.ts";
import { createSharedMaterials, fcUniforms, installFog, setFog, type SharedMaterials } from "./materials.ts";
import { ModelRegistry } from "./model-registry.ts";
import { createNightMaterials, type NightMaterials } from "./props.ts";
import { DAY, NIGHT, Sky, applySkyPreset, sunDirection, type LightingPreset } from "./sky.ts";
import { TileStreamer } from "./tile-streamer.ts";
import type { GroundFn, Manifest, Pose, RoadGraph } from "./types.ts";
import { Water } from "./water.ts";

export type { CameraMode } from "./cameras.ts";

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
}

export interface WorldData {
  manifest: Manifest;
  base: string;
  colliders: ReadonlyMap<string, TileCollider>;
  roads: RoadGraph | null;
  ground: GroundFn;
  /** True when (x, y, z) is inside a building below its roof (camera pull-in). */
  occluded: (x: number, y: number, z: number) => boolean;
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
}

const SHADOW_HALF = 160;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.5, 6000);
  readonly rig: CameraRig;
  readonly streamer: TileStreamer;
  readonly actors: Actors;
  readonly landmarks: LandmarkLayer;
  private readonly container: HTMLElement;
  private readonly materials: SharedMaterials;
  private readonly nightMats: NightMaterials;
  private readonly sky = new Sky();
  private readonly water = new Water();
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
  private lastCalls = 0;
  private lastTris = 0;
  private fpsAvg = 60;
  private time = 0;

  constructor(container: HTMLElement, world: WorldData, opts: RenderOptions) {
    installFog();
    this.container = container;
    this.shadows = opts.shadows;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = opts.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.scene.fog = this.fog;
    this.scene.add(this.sky.mesh, this.water.mesh, this.sun, this.sun.target, this.hemi, this.headlight, this.headlight.target);
    this.envScene.add(new Sky(900).mesh);
    if (opts.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const c = this.sun.shadow.camera;
      c.left = -SHADOW_HALF;
      c.right = SHADOW_HALF;
      c.top = SHADOW_HALF;
      c.bottom = -SHADOW_HALF;
      c.near = 1;
      c.far = 1600;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
    }

    this.materials = createSharedMaterials();
    this.nightMats = createNightMaterials();

    const gltf = new GLTFLoader();
    this.registry = new ModelRegistry<THREE.Object3D>({
      load: async (url) => (await gltf.loadAsync(url)).scene,
      clone: (o) => o.clone(true),
      fallback: (key) => (key === "player-car" ? makeBoxCar(0xc8372d) : new THREE.Group()),
      available: opts.models,
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
      onReady: (g) => this.prepareShadows(g),
    });
    this.actors = new Actors(this.registry);
    this.scene.add(this.actors.group);
    this.landmarks = new LandmarkLayer(
      opts.landmarks,
      this.registry,
      world.ground,
      (ids) => this.streamer.hideBuildings(ids),
      (root) => this.prepareShadows(root),
    );
    this.scene.add(this.landmarks.group);
    this.rig = new CameraRig(this.camera, world.ground, world.occluded);

    this.nightOn = opts.night;
    this.applyPreset(opts.night ? NIGHT : DAY);
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
    this.applyPreset(on ? NIGHT : DAY);
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
    this.hemi.intensity = p.hemiIntensity;
    this.water.setBodyLight(p.water);
    fcUniforms.fcNight.value = night;
    this.materials.lampHead.emissiveIntensity = night * 6;
    this.headlight.intensity = night * 140;
    this.streamer.setNight(night > 0);
    this.actors.setNight(night);
    this.scene.environment = this.envFor(p);
    this.scene.environmentIntensity = p.envIntensity;
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

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCar(id: string, pose: Pose): void {
    this.actors.setCar(id, pose);
  }

  setFoot(id: string, pose: Pose | null): void {
    this.actors.setFoot(id, pose);
  }

  /** Per-frame update after the sim has stepped. */
  frame(dtSeconds: number, local: { id: string; target: CameraTarget } | null, fly: Readonly<FlyInput>, minuteOfDay: number): void {
    this.time += dtSeconds;
    fcUniforms.fcTime.value = this.time;
    if (dtSeconds > 0) this.fpsAvg += (1 / Math.max(dtSeconds, 1e-3) - this.fpsAvg) * Math.min(1, dtSeconds * 2);
    if (local) {
      const t = local.target;
      this.actors.hideFor(this.rig.mode === "first-person" ? local.id : null, t.onFoot ? "person" : "car");
      this.rig.update(dtSeconds, t, fly);
      // The headlight rides on the local car.
      const fx = Math.sin(t.heading);
      const fz = -Math.cos(t.heading);
      this.headlight.visible = !t.onFoot;
      this.headlight.position.set(t.x + fx * 2.2, t.y + 0.9, t.z + fz * 2.2);
      this.headlight.target.position.set(t.x + fx * 30, t.y - 1.5, t.z + fz * 30);
      this.headlight.target.updateMatrixWorld();
    } else {
      this.rig.update(dtSeconds, NO_TARGET, fly);
    }
    const cam = this.camera.position;
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

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.lastCalls = this.renderer.info.render.calls;
    this.lastTris = this.renderer.info.render.triangles;
  }

  info(): RenderInfo {
    const s = this.streamer.stats();
    return {
      drawCalls: this.lastCalls,
      triangles: this.lastTris,
      tilesLoaded: s.ready,
      cameraMode: this.rig.mode,
      night: this.nightOn,
      tilesPending: s.pending,
      tilesTotal: s.total,
      tilesFailed: s.failed,
      landmarks: this.landmarks.count,
      fps: this.fpsAvg,
      pixelRatio: this.renderer.getPixelRatio(),
      shadows: this.shadows,
    };
  }

  dispose(): void {
    this.streamer.dispose();
    this.actors.dispose();
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

const NO_TARGET: CameraTarget = Object.freeze({ x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false });
