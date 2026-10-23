// The player's authored human model is independent of world quality settings. Geometry,
// clips and base materials are shared; every player owns a skeleton and animation mixer.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export const PLAYER_BODY_FILE = "models/generic-player.glb";
/** Drawn yaw closes on the sim heading at this rate (1/s); a turn over TURN_SNAP_RAD snaps. */
export const TURN_RATE = 14;
export const TURN_SNAP_RAD = 2.6;
/** Hair cards are cut out at this alpha rather than blended: no sorting against the head, and they shadow. */
export const HAIR_ALPHA_CUT = 0.45;
type Motion = "idle" | "walk" | "run";
interface Body {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
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
  private readonly bodies = new Map<string, Body>();
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly gltf: GLTF;
  private readonly shadows: boolean;
  private drawnCount = 0;
  private disposed = false;

  private constructor(gltf: GLTF, shadows: boolean) {
    this.gltf = gltf;
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
  }

  static async load(bytes: (path: string) => Promise<Uint8Array>, shadows: boolean): Promise<PlayerBodies> {
    const buffer = await bytes(PLAYER_BODY_FILE);
    const gltf = await new GLTFLoader().parseAsync(buffer.slice().buffer as ArrayBuffer, "");
    return new PlayerBodies(gltf, shadows);
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
      const clip = this.gltf.animations.find(candidate => candidate.name === name);
      return clip ? mixer.clipAction(clip) : null;
    };
    const body: Body = { root, mixer, actions: { idle: action("idle"), walk: action("walk"), run: action("run") }, current: "idle", materials, skeletons, seen: false, yaw: Number.NaN };
    body.actions.idle?.play();
    this.group.add(root);
    this.bodies.set(id, body);
    return body;
  }

  begin(): void {
    for (const body of this.bodies.values()) body.seen = false;
    this.drawnCount = 0;
  }

  add(id: string, x: number, y: number, z: number, heading: number, speed: number, dt: number, tint?: THREE.Color): void {
    if (this.disposed) return;
    const body = this.body(id, tint);
    body.seen = true;
    body.root.visible = true;
    body.root.position.set(x, y, z);
    body.yaw = easeYaw(body.yaw, heading, dt);
    body.root.rotation.set(0, -body.yaw, 0);
    const velocity = Math.abs(speed);
    const wanted: Motion = velocity >= 3.2 && body.actions.run ? "run" : velocity >= 0.2 && body.actions.walk ? "walk" : "idle";
    if (wanted !== body.current) {
      const from = body.actions[body.current];
      const to = body.actions[wanted];
      if (to) {
        to.reset().play();
        if (from) to.crossFadeFrom(from, 0.25, false);
        body.current = wanted;
      }
    }
    const action = body.actions[body.current];
    if (action) action.timeScale = body.current === "walk" ? Math.max(0.6, Math.min(2, velocity / this.walkSpeed)) : body.current === "run" ? Math.max(0.7, Math.min(2, velocity / this.runSpeed)) : 1;
    body.mixer.update(Math.max(0, dt));
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
