// The player's authored human model is independent of world quality settings. Geometry,
// clips and base materials are shared; every player owns a skeleton and animation mixer.
// The player moves with the Mixamo locomotion bank (MIXAMO_MOTION_FILE: idle, walk, jog, run) when
// it loads, else the model's own baked clips. Getting out of a car's way (the sim's dodge) plays
// real clips on the same skeleton: Rocketbox's from PLAYER_DODGE_FILE (assets/imports/rocketbox/
// clips.py: a startled push-off, a sprint, pulling up, brushing off once clear) and Mixamo's from
// MIXAMO_DODGE_FILE (assets/imports/mixamo/build.ts: a stumble back for the override, a flinch on
// a sidestep), between the jog or run matched to the body's speed (human-motion.ts).
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { DodgeState } from "../sim/contract.ts";
import { MOTIONS, ONCE, motionFor, type Motion } from "./human-motion.ts";
import { HumanFeet, type HumanSupportHeight } from "./human-feet.ts";
import { disposeRenderObjects } from "./gpu-instance-ownership.ts";
import { compactCrowdAvatar } from "./crowd-avatar-compact.ts";

export const PLAYER_BODY_FILE = "models/generic-player.glb";
/** The dodge clips (no mesh), shared by every human on the Rocketbox skeleton (assets/imports/rocketbox/README.md). */
export const PLAYER_DODGE_FILE = "models/anim/dodge-clips.glb";
export { motionFor };
/** Blend between clips, seconds (a dodge's clips change faster than a walk's). */
const FADE_S = 0.25;
const DODGE_FADE_S = 0.12;
const JOG_FADE_S = 0.1;
/** The Mixamo locomotion's own speeds (mixamo-motion.json: jog, and run as the Shift sprint), m/s. */
const MIXAMO_JOG_MPS = 3;
const MIXAMO_RUN_MPS = 7;
/** Drawn yaw closes on the sim heading at this rate (1/s); a turn over TURN_SNAP_RAD snaps. */
export const TURN_RATE = 14;
export const TURN_SNAP_RAD = 2.6;
/** Hair cards are cut out at this alpha rather than blended: no sorting against the head, and they shadow. */
export const HAIR_ALPHA_CUT = 0.45;
export const MIXAMO_MOTION_FILE = "models/mixamo-motion.json";
/** The Mixamo dodge clips (stumble, flinch) on the same rig: assets/imports/mixamo/build.ts --set dodge. */
export const MIXAMO_DODGE_FILE = "models/anim/mixamo-dodge.json";
type ByteLoader = (path: string) => Promise<Uint8Array>;
const motionBanks = new WeakMap<ByteLoader, Map<string, Promise<THREE.AnimationClip[]>>>();

/** A Mixamo motion bank (assets/imports/mixamo/build.ts) holding at least `needs`: shared per loader; [] when missing or unsupported. */
function mixamoBank(bytes: ByteLoader, file: string, needs: readonly string[]): Promise<THREE.AnimationClip[]> {
  let banks = motionBanks.get(bytes);
  if (!banks) motionBanks.set(bytes, banks = new Map());
  let bank = banks.get(file);
  if (!bank) {
    bank = bytes(file).then(data => {
      const json = JSON.parse(new TextDecoder().decode(data));
      if (json.version !== 1 || json.rig !== "rocketbox" || !Array.isArray(json.clips)) throw new Error("Unsupported Mixamo motion bank");
      const clips: THREE.AnimationClip[] = json.clips.map((clip: Parameters<typeof THREE.AnimationClip.parse>[0]) => THREE.AnimationClip.parse(clip));
      if (!needs.every(name => clips.some(clip => clip.name === name && clip.duration > 0 && clip.validate()))) throw new Error("Incomplete Mixamo motion bank");
      return clips;
    }).catch(() => {
      banks.delete(file);
      return [];
    });
    banks.set(file, bank);
  }
  return bank;
}

/** One shared bank for player clones; older/offline asset sets retain their baked motions. */
function mixamoMotions(bytes: ByteLoader): Promise<THREE.AnimationClip[]> {
  return mixamoBank(bytes, MIXAMO_MOTION_FILE, ["idle", "walk", "jog", "run"]);
}

/**
 * The dodge bank's clips for a body loaded from `file`. Its hip height is the player's
 * (generic-player.glb): another character keeps the rotations and its own hip height.
 */
async function mixamoDodge(bytes: ByteLoader, file: string): Promise<THREE.AnimationClip[]> {
  const clips = await mixamoBank(bytes, MIXAMO_DODGE_FILE, ["stumble", "flinch"]);
  if (file === PLAYER_BODY_FILE) return clips;
  return clips.map(clip => new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter(track => track.name !== "Bip01_Pelvis.position")));
}
export interface BodyRenderCost { drawCalls: number; triangles: number }

/** Colour-pass primitives and triangles, including material groups and clipped draw ranges. */
export function bodyRenderCost(root: THREE.Object3D): BodyRenderCost {
  const cost = { drawCalls: 0, triangles: 0 };
  root.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const total = geometry.index?.count ?? geometry.getAttribute("position").count;
    const range = geometry.drawRange;
    const count = (material: THREE.Material | undefined, start: number, size: number): void => {
      if (!material?.visible) return;
      const end = Math.min(total, range.start + range.count, start + size);
      const triangles = Math.max(0, Math.floor((end - Math.max(range.start, start)) / 3));
      if (triangles === 0) return;
      const passes = material.transparent && material.side === THREE.DoubleSide && !material.forceSinglePass ? 2 : 1;
      cost.drawCalls += passes;
      cost.triangles += triangles * passes;
    };
    if (Array.isArray(mesh.material)) {
      for (const group of geometry.groups) count(mesh.material[group.materialIndex ?? 0], group.start, group.count);
    } else count(mesh.material, 0, total);
  });
  return cost;
}

interface Body {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  feet: HumanFeet;
  actions: Record<Motion, THREE.AnimationAction | null>;
  current: Motion;
  materials: THREE.Material[];
  skeletons: Set<THREE.Skeleton>;
  seen: boolean;
  /** Drawn compass heading; NaN until first placed. */
  yaw: number;
}

/** Shortest signed turn from a to b, in (-pi, pi]. */
function turn(a: number, b: number): number {
  const d = (b - a) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d <= -Math.PI ? d + 2 * Math.PI : d;
}

/** Drawn heading for the frame: eases toward the sim heading, snapping on the first frame or a reversal. */
export function easeYaw(drawn: number, target: number, dt: number): number {
  if (!Number.isFinite(drawn) || !(dt > 0)) return target;
  const d = turn(drawn, target);
  if (Math.abs(d) > TURN_SNAP_RAD) return target;
  const next = drawn + d * (1 - Math.exp(-TURN_RATE * dt));
  return Math.abs(turn(next, target)) < 1e-4 ? target : next;
}

export class PlayerBodies {
  readonly group = new THREE.Group();
  /** Each clone has the prototype's same geometry/material colour-pass cost. */
  readonly renderCost: Readonly<BodyRenderCost>;
  private readonly bodies = new Map<string, Body>();
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly sprintSpeed: number;
  private readonly gltf: Pick<GLTF, "scene" | "animations">;
  private readonly clips: THREE.AnimationClip[];
  private readonly shadows: boolean;
  private drawnCount = 0;
  private disposed = false;
  private supportHeight: HumanSupportHeight | undefined;

  private constructor(gltf: GLTF, shadows: boolean, dodge: GLTF | null, mixamoDodge: THREE.AnimationClip[]) {
    // Parser dependency caches retain superseded primitive maps after crowd compaction.
    this.gltf = { scene: gltf.scene, animations: gltf.animations };
    this.clips = [...gltf.animations, ...(dodge?.animations ?? []), ...mixamoDodge];
    let sprint = 5.8;
    dodge?.scene.traverse(object => {
      const raw: unknown = object.userData.clips;
      if (typeof raw !== "string") return;
      try {
        for (const c of JSON.parse(raw) as Array<{ name?: unknown; sourceSpeed?: unknown }>) {
          if (c.name === "sprint" && typeof c.sourceSpeed === "number" && c.sourceSpeed > 0) sprint = c.sourceSpeed;
        }
      } catch {
        // (No clip notes: the default.)
      }
    });
    this.sprintSpeed = sprint;
    this.shadows = shadows;
    let speed = 1.39, runSpeed = 3.2;
    gltf.scene.traverse(object => {
      const value: unknown = object.userData.walkSpeedMps;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) speed = value;
      const run: unknown = object.userData.runSpeedMps;
      if (typeof run === "number" && Number.isFinite(run) && run > 0) runSpeed = run;
    });
    this.walkSpeed = speed;
    this.runSpeed = runSpeed;
    this.group.name = "players:bodies";
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material.name.endsWith("_hair") || !material.transparent) continue;
        material.transparent = false;
        material.depthWrite = true;
        material.alphaTest = HAIR_ALPHA_CUT;
        material.needsUpdate = true;
      }
    });
    this.renderCost = Object.freeze(bodyRenderCost(gltf.scene));
  }

  /** Load a body model: the player's by default, or another Rocketbox-rigged file (the crowd's). */
  static async load(bytes: (path: string) => Promise<Uint8Array>, shadows: boolean, file: string = PLAYER_BODY_FILE, options: Readonly<{ compactCrowd?: boolean }> = {}): Promise<PlayerBodies> {
    const [buffer, motions] = await Promise.all([bytes(file), file === PLAYER_BODY_FILE ? mixamoMotions(bytes) : Promise.resolve([] as THREE.AnimationClip[])]);
    const gltf = await new GLTFLoader().parseAsync(buffer.slice().buffer as ArrayBuffer, "");
    try {
      if (options.compactCrowd) await compactCrowdAvatar(gltf.scene, { alphaTest: HAIR_ALPHA_CUT });
    } catch (error) {
      disposeBodyPrototype(gltf.scene);
      throw error;
    }
    if (motions.length) {
      gltf.animations = motions;
      gltf.scene.userData.motionSource = "mixamo";
    }
    // The dodge clips are optional: without them a dodge plays the plain locomotion.
    let dodge: GLTF | null = null;
    try {
      const clips = await bytes(PLAYER_DODGE_FILE);
      dodge = await new GLTFLoader().parseAsync(clips.slice().buffer as ArrayBuffer, "");
    } catch {
      dodge = null;
    }
    return new PlayerBodies(gltf, shadows, dodge, await mixamoDodge(bytes, file));
  }

  private body(id: string, tint?: THREE.Color): Body {
    const existing = this.bodies.get(id);
    if (existing) return existing;
    const content = cloneSkinned(this.gltf.scene);
    const root = new THREE.Group();
    root.userData = { ...content.userData };
    root.add(content);
    const materials: THREE.Material[] = [];
    const skeletons = new Set<THREE.Skeleton>();
    const tinted = new Map<THREE.Material, THREE.Material>();
    root.name = `player-body:${id}`;
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      mesh.frustumCulled = false;
      const skinned = object as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skeletons.add(skinned.skeleton);
      if (!tint) return;
      const materialFor = (material: THREE.Material): THREE.Material => {
        if (material.userData.tintSlot !== "outer") return material;
        let clone = tinted.get(material);
        if (!clone) {
          clone = material.clone();
          (clone as THREE.MeshStandardMaterial).color.copy(tint);
          tinted.set(material, clone);
          materials.push(clone);
        }
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(materialFor) : materialFor(mesh.material);
    });
    const mixer = new THREE.AnimationMixer(root);
    const action = (name: Motion): THREE.AnimationAction | null => {
      const clip = this.clips.find(candidate => candidate.name === name);
      if (!clip) return null;
      const a = mixer.clipAction(clip);
      if (ONCE.has(name)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      return a;
    };
    const actions = {} as Record<Motion, THREE.AnimationAction | null>;
    for (const m of MOTIONS) actions[m] = action(m);
    const body: Body = { root, mixer, feet: new HumanFeet(root, content), actions, current: "idle", materials, skeletons, seen: false, yaw: Number.NaN };
    body.actions.idle?.play();
    this.group.add(root);
    this.bodies.set(id, body);
    return body;
  }

  /** Actual rendered support under each posed shoe; optional for previews and unloaded tiles. */
  setSupportHeight(height: HumanSupportHeight): void { this.supportHeight = height; }

  begin(): void {
    for (const body of this.bodies.values()) body.seen = false;
    this.drawnCount = 0;
  }

  /** One player on foot this frame: `speed` along their facing, `dodge` the sim's (null: walking). */
  add(id: string, x: number, y: number, z: number, heading: number, speed: number, dt: number, tint?: THREE.Color, dodge: Readonly<DodgeState> | null = null): void {
    if (this.disposed) return;
    const body = this.body(id, tint);
    body.seen = true;
    body.root.visible = true;
    body.root.position.set(x, y, z);
    body.yaw = easeYaw(body.yaw, heading, dt);
    body.root.rotation.set(0, -body.yaw, 0);
    const velocity = Math.abs(speed);
    const wanted = motionFor(velocity, dodge, m => body.actions[m] !== null);
    body.root.userData.motion = wanted;
    if (wanted !== body.current) {
      const from = body.actions[body.current];
      const to = body.actions[wanted];
      if (to) {
        to.reset().play();
        // Enter the imported jog promptly (a longer blend from idle folds the shoes into the
        // ground); a dodge's clips change faster than a walk's.
        if (from) to.crossFadeFrom(from, wanted === "jog" ? JOG_FADE_S : dodge || ONCE.has(body.current) ? DODGE_FADE_S : FADE_S, false);
        body.current = wanted;
      }
    }
    const action = body.actions[body.current];
    // Locomotion plays at the body's speed over the clip's own (no foot sliding).
    if (action) action.timeScale = body.current === "walk" ? Math.max(0.6, Math.min(2, velocity / this.walkSpeed))
      : body.current === "jog" ? Math.max(0.7, Math.min(2, velocity / MIXAMO_JOG_MPS))
      : body.current === "run" ? Math.max(0.7, Math.min(2, velocity / (body.actions.jog ? MIXAMO_RUN_MPS : this.runSpeed)))
      : body.current === "sprint" ? Math.max(0.7, Math.min(1.5, velocity / this.sprintSpeed)) : 1;
    body.mixer.update(Math.max(0, dt));
    body.feet.update(Boolean(body.actions.jog) && (wanted === "jog" || wanted === "run"), this.supportHeight);
    this.drawnCount++;
  }

  end(): void {
    for (const body of this.bodies.values()) if (!body.seen) {
      body.root.visible = false;
      body.yaw = Number.NaN; // Reappearing (out of the car, back in view) faces the sim heading at once.
    }
  }

  get drawn(): number { return this.drawnCount; }

  /** Player `id`'s posed body root, once it has been drawn. */
  rootOf(id: string): THREE.Object3D | null { return this.bodies.get(id)?.root ?? null; }

  remove(keep: ReadonlySet<string>): void {
    for (const [id, body] of this.bodies) {
      if (keep.has(id)) continue;
      body.mixer.stopAllAction();
      body.mixer.uncacheRoot(body.root);
      // Crowd clones share prototype geometry/materials, so those resource owners
      // cannot release this clone's renderer objects and bone-matrix UBOs for it.
      disposeRenderObjects(body.root);
      for (const skeleton of body.skeletons) skeleton.dispose();
      for (const material of body.materials) material.dispose();
      body.root.removeFromParent();
      this.bodies.delete(id);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remove(new Set());
    this.drawnCount = 0;
    disposeBodyPrototype(this.gltf.scene);
    this.group.removeFromParent();
  }
}


/** The loader owns a prototype's geometry, materials, maps and embedded decoded images. */
function disposeBodyPrototype(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>(), skeletons = new Set<THREE.Skeleton>(), images = new Set<unknown>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((mesh as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) { images.add(texture.image); texture.dispose(); }
  for (const image of images) if (image && typeof (image as { close?: unknown }).close === "function") (image as ImageBitmap).close();
}
