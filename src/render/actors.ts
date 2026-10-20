// Players as the renderer draws them: a car per player (models/player-car.glb when present,
// else an original procedural hatchback), its body pitched and rolled as the sim says and
// its wheels rolling (rotation.x -= distance / radius) and steering; and, while the player is
// on foot, the walker, drawn by the same person builder as the crowd (person.ts) and walking.
// Car lights are light_* materials: NightLights scales them with the rest of the city.

import * as THREE from "three";
import { PeopleRig } from "./agent-layer.ts";
import { advanceGait, gaitAmount, rollWheel } from "./agent-lod.ts";
import { packedMaterial } from "./agent-packing.ts";
import type { NightLights } from "./lights.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { STRIDE_M, newLook, type PersonLook } from "./person.ts";
import type { Pose } from "./types.ts";

/** A car between two ticks. Angles in radians; pitch + = nose up, roll + = right side down, steer + = right. */
export interface CarPose extends Pose {
  pitch: number;
  roll: number;
  steer: number;
  speed: number;
}

/** A walker between two ticks. */
export interface WalkerPose extends Pose {
  speed: number;
}

const CAR_COLORS = [0xc8372d, 0x2d6fc8, 0xe0b23a, 0x3a9a6a, 0xe8e4da, 0x6a3fa0];
const SHIRTS = [0x2f6f9f, 0xb0453a, 0x3f7f4a, 0xd0a03a, 0x6a4f9a, 0x2f8a85];
const PANTS = [0x2b3a55, 0x1f2024, 0x8f7d58, 0x4a4d52];
const SKIN = [0xe0ac86, 0x8d5a3b, 0xf1c7a5, 0xa5714b, 0x6b4229, 0xc68e64];
const HAIR = [0x2a1f17, 0x1b1612, 0x6b4a2e, 0x8a8a88];
/** Most players drawn on foot at once (the people rig's capacity). */
export const MAX_PLAYERS_DRAWN = 16;

/** A box whose top face is narrowed (kx, kz) and shifted back (dz): a car greenhouse. */
function taperedBox(w: number, h: number, d: number, kx: number, kz: number, dz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * kx);
      pos.setZ(i, pos.getZ(i) * kz + dz);
    }
  }
  g.computeVertexNormals();
  return g;
}

/**
 * An original, toy-like hatchback that faces -z, with the same node contract as
 * player-car.glb: wheel_FL/FR/RL/RR at the hubs (extras wheel, radius, steer) and
 * light_headlight / light_taillight materials.
 */
export function makeBoxCar(color: number): THREE.Group {
  const g = new THREE.Group();
  g.name = "box-car";
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.12, name: "paint" });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223140, roughness: 0.06, metalness: 0.85, name: "glass" });
  const trim = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.7, metalness: 0.2, name: "trim_black" });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.92, name: "tire" });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.3, metalness: 0.9, name: "rim" });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 0, roughness: 0.2, name: "light_headlight" });
  const tail = new THREE.MeshStandardMaterial({ color: 0x701010, emissive: 0xff2010, emissiveIntensity: 0, roughness: 0.4, name: "light_taillight" });
  const body = new THREE.Mesh(taperedBox(1.86, 0.62, 4.15, 0.98, 0.97, 0), paint);
  body.position.y = 0.68;
  const hood = new THREE.Mesh(taperedBox(1.8, 0.14, 1.25, 0.94, 0.9, 0.06), paint);
  hood.position.set(0, 1.06, -1.35);
  const cabin = new THREE.Mesh(taperedBox(1.76, 0.66, 2.55, 0.84, 0.7, 0.22), glass);
  cabin.position.set(0, 1.32, 0.35);
  const roof = new THREE.Mesh(taperedBox(1.46, 0.07, 1.72, 0.96, 0.95, 0), paint);
  roof.position.set(0, 1.68, 0.5);
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.26, 0.18), trim);
  bumperF.position.set(0, 0.46, -2.12);
  const bumperR = bumperF.clone();
  bumperR.position.z = 2.12;
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 3.2), trim);
  skirt.position.set(0, 0.36, 0);
  g.add(body, hood, cabin, roof, bumperF, bumperR, skirt);
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 16).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.27, 10).rotateZ(Math.PI / 2);
  for (const [name, x, z] of [
    ["FL", -0.84, -1.32],
    ["FR", 0.84, -1.32],
    ["RL", -0.84, 1.34],
    ["RR", 0.84, 1.34],
  ] as const) {
    const hub = new THREE.Group();
    hub.name = `wheel_${name}`;
    hub.position.set(x, 0.36, z);
    hub.userData = { wheel: name, radius: 0.36, steer: name.startsWith("F") };
    hub.add(new THREE.Mesh(wheelGeo, tyre), new THREE.Mesh(rimGeo, rim));
    g.add(hub);
  }
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.13, 0.05), lamp);
    h.position.set(x, 0.86, -2.08);
    h.name = "headlight";
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.05), tail);
    t.position.set(x, 0.9, 2.08);
    t.name = "taillight";
    g.add(h, t);
  }
  return g;
}

export function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

export interface Wheel {
  node: THREE.Object3D;
  radius: number;
  steer: boolean;
  angle: number;
}

interface PlayerView {
  car: THREE.Object3D;
  carSource: "file" | "fallback";
  wheels: Wheel[];
  lastX: number;
  lastZ: number;
  placed: boolean;
  look: PersonLook;
  walker: WalkerPose | null;
  gait: number;
  gaitAmount: number;
  walkX: number;
  walkZ: number;
  walking: boolean;
}

/** The wheel nodes of a car model (extras {"wheel": "FL", "radius", "steer"}). */
export function findWheels(car: THREE.Object3D): Wheel[] {
  const out: Wheel[] = [];
  car.traverse((o) => {
    const u = o.userData as { wheel?: unknown; radius?: unknown; steer?: unknown };
    if (typeof u.wheel !== "string") return;
    o.rotation.order = "YXZ";
    out.push({ node: o, radius: typeof u.radius === "number" && u.radius > 0 ? u.radius : 0.35, steer: u.steer === true, angle: 0 });
  });
  return out;
}

export class Actors {
  readonly group = new THREE.Group();
  private players = new Map<string, PlayerView>();
  private registry: ModelRegistry<THREE.Object3D>;
  private lights: NightLights;
  private hidden: string | null = null;
  private hiddenPart: "car" | "person" = "car";
  private colorsUsed = 0;
  private readonly peopleMaterial = packedMaterial(true);
  private readonly people = new PeopleRig(MAX_PLAYERS_DRAWN, this.peopleMaterial, "players:people");

  constructor(registry: ModelRegistry<THREE.Object3D>, lights: NightLights) {
    this.registry = registry;
    this.lights = lights;
    this.group.name = "actors";
    this.group.add(this.people.group);
  }

  /** Where each player's car model came from ("file" = player-car.glb). */
  carSources(): Record<string, "file" | "fallback"> {
    const out: Record<string, "file" | "fallback"> = {};
    for (const [id, v] of this.players) out[id] = v.carSource;
    return out;
  }

  /** Players drawn on foot last frame. */
  get walkers(): number {
    return this.people.body.count;
  }

  private adopt(v: PlayerView, car: THREE.Object3D, source: "file" | "fallback"): void {
    car.rotation.order = "YXZ";
    v.car = car;
    v.carSource = source;
    v.wheels = findWheels(car);
    this.group.add(car);
    this.lights.track(car);
  }

  private view(id: string): PlayerView {
    let v = this.players.get(id);
    if (v) return v;
    const colorIndex = this.colorsUsed++;
    const look = newLook();
    look.shirt.setHex(SHIRTS[colorIndex % SHIRTS.length]!);
    look.pants.setHex(PANTS[colorIndex % PANTS.length]!);
    look.skin.setHex(SKIN[colorIndex % SKIN.length]!);
    look.hair.setHex(HAIR[colorIndex % HAIR.length]!);
    const now = this.registry.now("player-car");
    const car = now.source === "file" ? now.model : makeBoxCar(CAR_COLORS[colorIndex % CAR_COLORS.length]!);
    if (now.source !== "file") disposeTree(now.model);
    v = {
      car,
      carSource: now.source,
      wheels: [],
      lastX: 0,
      lastZ: 0,
      placed: false,
      look,
      walker: null,
      gait: 0,
      gaitAmount: 0,
      walkX: 0,
      walkZ: 0,
      walking: false,
    };
    this.players.set(id, v);
    this.adopt(v, car, now.source);
    if (now.source === "fallback") {
      // Swap in the real model when it turns up.
      void this.registry.get("player-car").then((r) => {
        const cur = this.players.get(id);
        if (r.source !== "file") {
          disposeTree(r.model);
          return;
        }
        if (!cur || cur.carSource === "file") return;
        const old = cur.car;
        this.group.remove(old);
        this.lights.untrack(old);
        disposeTree(old);
        r.model.position.copy(old.position);
        r.model.rotation.copy(old.rotation);
        r.model.visible = old.visible;
        const angles = cur.wheels.map((w) => w.angle);
        this.adopt(cur, r.model, "file");
        cur.wheels.forEach((w, i) => (w.angle = angles[i] ?? 0));
      });
    }
    return v;
  }

  setCar(id: string, pose: CarPose): void {
    const v = this.view(id);
    v.car.position.set(pose.x, pose.y, pose.z);
    v.car.rotation.set(pose.pitch, -pose.heading, -pose.roll, "YXZ");
    v.car.visible = !(this.hidden === id && this.hiddenPart === "car");
    let dist = v.placed ? Math.hypot(pose.x - v.lastX, pose.z - v.lastZ) : 0;
    if (dist > 8) dist = 0; // a respawn, not a roll
    if (pose.speed < 0) dist = -dist;
    v.lastX = pose.x;
    v.lastZ = pose.z;
    v.placed = true;
    for (const w of v.wheels) {
      w.angle = rollWheel(w.angle, dist, w.radius);
      w.node.rotation.set(w.angle, w.steer ? -pose.steer : 0, 0, "YXZ");
    }
  }

  /** Show (pose) or hide (null) the player's walker; drawn by update(). */
  setFoot(id: string, pose: WalkerPose | null): void {
    const v = this.view(id);
    if (!pose) {
      v.walker = null;
      v.walking = false;
      return;
    }
    if (!v.walker) v.walker = { x: 0, y: 0, z: 0, heading: 0, speed: 0 };
    Object.assign(v.walker, pose);
  }

  /** Per frame, after setCar/setFoot: draws the walkers. */
  update(dt: number): void {
    this.people.begin();
    for (const [id, v] of this.players) {
      const w = v.walker;
      if (!w) continue;
      let dist = v.walking ? Math.hypot(w.x - v.walkX, w.z - v.walkZ) : 0;
      if (dist > 5) dist = 0;
      v.walkX = w.x;
      v.walkZ = w.z;
      v.walking = true;
      v.gait = advanceGait(v.gait, dist, STRIDE_M);
      v.gaitAmount += (gaitAmount(w.speed, 1.6) - v.gaitAmount) * Math.min(1, dt * 6);
      if (this.hidden === id && this.hiddenPart === "person") continue;
      this.people.add(w.x, w.y, w.z, w.heading, v.look, Math.sin(v.gait) * v.gaitAmount);
    }
    this.people.end();
  }

  /** Hide one player's own body (first-person view), or nobody. */
  hideFor(id: string | null, part: "car" | "person" = "car"): void {
    this.hidden = id;
    this.hiddenPart = part;
  }

  remove(keep: ReadonlySet<string>): void {
    for (const [id, v] of this.players) {
      if (keep.has(id)) continue;
      this.group.remove(v.car);
      // A loaded model shares geometry and materials with the registry's prototype: only dispose our own.
      if (v.carSource === "fallback") {
        this.lights.untrack(v.car);
        disposeTree(v.car);
      }
      this.players.delete(id);
    }
  }

  dispose(): void {
    this.remove(new Set());
    this.people.dispose();
    this.peopleMaterial.dispose();
  }
}
