// The player's authored human model is independent of world quality settings. Geometry,
// clips and base materials are shared; every player owns a skeleton and animation mixer.
// Getting out of a car's way (the sim's dodge) plays real clips from PLAYER_DODGE_FILE, baked
// onto the same skeleton (assets/imports/rocketbox/clips.py): a startled push-off into a run (or
// a flinch, on a sidestep), a run or a sprint matched to the body's speed, a stumble back for the
// override, and brushing off once clear.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { DodgeState } from "../sim/contract.ts";
import { MOTIONS, ONCE, motionFor, type Motion } from "./human-motion.ts";

export const PLAYER_BODY_FILE = "models/generic-player.glb";
/** The dodge clips (no mesh), shared by every human on the Rocketbox skeleton (assets/imports/rocketbox/README.md). */
export const PLAYER_DODGE_FILE = "models/anim/dodge-clips.glb";
export { motionFor };
/** Blend between clips, seconds (a dodge's clips change faster than a walk's). */
const FADE_S = 0.25;
const DODGE_FADE_S = 0.12;
interface Body {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Motion, THREE.AnimationAction | null>;
  current: Motion;
  materials: THREE.Material[];
  skeletons: Set<THREE.Skeleton>;
  seen: boolean;
}

export class PlayerBodies {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<string, Body>();
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly sprintSpeed: number;
  private readonly gltf: GLTF;
  private readonly clips: THREE.AnimationClip[];
  private readonly shadows: boolean;
  private drawnCount = 0;
  private disposed = false;

  private constructor(gltf: GLTF, shadows: boolean, dodge: GLTF | null) {
    this.gltf = gltf;
    this.clips = [...gltf.animations, ...(dodge?.animations ?? [])];
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
  }

  static async load(bytes: (path: string) => Promise<Uint8Array>, shadows: boolean): Promise<PlayerBodies> {
    const buffer = await bytes(PLAYER_BODY_FILE);
    const gltf = await new GLTFLoader().parseAsync(buffer.slice().buffer as ArrayBuffer, "");
    // The dodge clips are optional: without them a dodge plays the plain locomotion.
    let dodge: GLTF | null = null;
    try {
      const clips = await bytes(PLAYER_DODGE_FILE);
      dodge = await new GLTFLoader().parseAsync(clips.slice().buffer as ArrayBuffer, "");
    } catch {
      dodge = null;
    }
    return new PlayerBodies(gltf, shadows, dodge);
  }

  private body(id: string, tint?: THREE.Color): Body {
    const existing = this.bodies.get(id);
    if (existing) return existing;
    const root = cloneSkinned(this.gltf.scene);
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
    const body: Body = { root, mixer, actions, current: "idle", materials, skeletons, seen: false };
    body.actions.idle?.play();
    this.group.add(root);
    this.bodies.set(id, body);
    return body;
  }

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
    body.root.rotation.set(0, -heading, 0);
    const velocity = Math.abs(speed);
    const wanted = motionFor(velocity, dodge, m => body.actions[m] !== null);
    if (wanted !== body.current) {
      const from = body.actions[body.current];
      const to = body.actions[wanted];
      if (to) {
        to.reset().play();
        if (from) to.crossFadeFrom(from, dodge || ONCE.has(body.current) ? DODGE_FADE_S : FADE_S, false);
        body.current = wanted;
      }
    }
    const action = body.actions[body.current];
    // Locomotion plays at the body's speed over the clip's own (no foot sliding).
    if (action) action.timeScale = body.current === "walk" ? Math.max(0.6, Math.min(2, velocity / this.walkSpeed)) : body.current === "run" ? Math.max(0.7, Math.min(2, velocity / this.runSpeed)) : body.current === "sprint" ? Math.max(0.7, Math.min(1.5, velocity / this.sprintSpeed)) : 1;
    body.mixer.update(Math.max(0, dt));
    this.drawnCount++;
  }

  end(): void {
    for (const body of this.bodies.values()) if (!body.seen) body.root.visible = false;
  }

  get drawn(): number { return this.drawnCount; }

  remove(keep: ReadonlySet<string>): void {
    for (const [id, body] of this.bodies) {
      if (keep.has(id)) continue;
      body.mixer.stopAllAction();
      body.mixer.uncacheRoot(body.root);
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
    // Prototype resources belong to this loader, never to an individual player's clone.
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const skeletons = new Set<THREE.Skeleton>();
    this.gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      const skinned = object as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skeletons.add(skinned.skeleton);
    });
    for (const skeleton of skeletons) skeleton.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.group.removeFromParent();
  }
}
