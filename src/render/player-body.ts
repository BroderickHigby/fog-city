// The high tier's player on foot (gfx.ts "characters"): models/player.glb, the assets track's
// skinned body in its default look (founder-default: the owner's consented, stylised likeness;
// design.md decision log 2026-10-21), in place of person.ts's placeholder. One clone per player
// on foot (SkeletonUtils), an AnimationMixer per clone: idle when standing, walk scaled to the
// speed so the feet stay planted, run above RUN_FROM, cross-faded. Render-only.

import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export const PLAYER_BODY_FILE = "models/player.glb";

/** Speeds (m/s): idle below WALK_FROM, run from RUN_FROM. */
const WALK_FROM = 0.2;
const RUN_FROM = 3.2;
const FADE_S = 0.25;

interface Body {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<"idle" | "walk" | "run", THREE.AnimationAction | null>;
  current: "idle" | "walk" | "run";
  seen: boolean;
}

export class PlayerBodies {
  readonly group = new THREE.Group();
  private readonly gltf: GLTF;
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly bodies = new Map<string, Body>();
  private readonly shadows: boolean;
  private drawnCount = 0;

  private constructor(gltf: GLTF, shadows: boolean) {
    this.gltf = gltf;
    this.shadows = shadows;
    let extras: Record<string, unknown> = {};
    gltf.scene.traverse((o) => {
      if (o.name === "player") extras = o.userData ?? {};
    });
    this.walkSpeed = typeof extras.walkSpeedMps === "number" ? extras.walkSpeedMps : 1.39;
    this.runSpeed = this.walkSpeed * 2.6;
    this.group.name = "players:bodies";
  }

  static async load(bytes: (path: string) => Promise<Uint8Array>, shadows: boolean): Promise<PlayerBodies> {
    const b = await bytes(PLAYER_BODY_FILE);
    const gltf = await new GLTFLoader().parseAsync(b.slice().buffer as ArrayBuffer, "");
    return new PlayerBodies(gltf, shadows);
  }

  private body(id: string): Body {
    let b = this.bodies.get(id);
    if (b) return b;
    const root = cloneSkinned(this.gltf.scene);
    root.name = `player-body:${id}`;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = this.shadows;
      m.receiveShadow = this.shadows;
      // Skinned bounds follow the rest pose; never cull the player.
      m.frustumCulled = false;
    });
    const mixer = new THREE.AnimationMixer(root);
    const clip = (name: string): THREE.AnimationAction | null => {
      const c = this.gltf.animations.find((a) => a.name === name);
      return c ? mixer.clipAction(c) : null;
    };
    b = { root, mixer, actions: { idle: clip("idle"), walk: clip("walk"), run: clip("run") }, current: "idle", seen: false };
    b.actions.idle?.play();
    this.group.add(root);
    this.bodies.set(id, b);
    return b;
  }

  begin(): void {
    for (const b of this.bodies.values()) b.seen = false;
    this.drawnCount = 0;
  }

  /** One player on foot at (x, y, z) facing compass `heading`, moving at `speed` m/s. */
  add(id: string, x: number, y: number, z: number, heading: number, speed: number, dt: number): void {
    const b = this.body(id);
    b.seen = true;
    b.root.visible = true;
    b.root.position.set(x, y, z);
    b.root.rotation.set(0, -heading, 0);
    const want: Body["current"] = speed >= RUN_FROM && b.actions.run ? "run" : speed >= WALK_FROM ? "walk" : "idle";
    if (want !== b.current) {
      const from = b.actions[b.current];
      const to = b.actions[want];
      if (to) {
        to.reset().play();
        if (from) to.crossFadeFrom(from, FADE_S, false);
        b.current = want;
      }
    }
    const a = b.actions[b.current];
    if (a) a.timeScale = b.current === "walk" ? Math.max(0.6, Math.min(2, speed / this.walkSpeed)) : b.current === "run" ? Math.max(0.7, speed / this.runSpeed) : 1;
    b.mixer.update(dt);
    this.drawnCount++;
  }

  end(): void {
    for (const b of this.bodies.values()) if (!b.seen) b.root.visible = false;
  }

  get drawn(): number {
    return this.drawnCount;
  }

  dispose(): void {
    for (const b of this.bodies.values()) b.mixer.stopAllAction();
    this.bodies.clear();
  }
}
