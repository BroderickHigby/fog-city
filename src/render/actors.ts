// Players as the renderer draws them: a car per player (models/player-car.glb when present,
// else an original procedural hatchback) and, when the sim puts a player on foot, a simple
// human placeholder (capsule body, head, no robot features) at the foot position.
//
// The foot position is read defensively: the sim track is adding PlayerState.mode "foot"
// with a position whose exact field name may differ. See footPose().

import * as THREE from "three";
import type { ModelRegistry } from "./model-registry.ts";
import type { Pose } from "./types.ts";

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The on-foot pose of a player, or null when there is none. Accepts the first of
 * p.foot / p.onFoot / p.ped / p.pedestrian / p.body / p.pos / p.position that has numeric x
 * and z; y and heading are optional (heading may also be "yaw" or "facing").
 */
export function footPose(p: unknown, out: Pose): Pose | null {
  if (!p || typeof p !== "object") return null;
  const rec = p as Record<string, unknown>;
  for (const key of ["foot", "onFoot", "ped", "pedestrian", "body", "pos", "position"]) {
    const v = rec[key] as Record<string, unknown> | undefined;
    if (v && typeof v === "object" && num(v.x) && num(v.z)) {
      out.x = v.x;
      out.z = v.z;
      out.y = num(v.y) ? v.y : NaN;
      out.heading = num(v.heading) ? v.heading : num(v.yaw) ? v.yaw : num(v.facing) ? v.facing : NaN;
      return out;
    }
  }
  return null;
}

const CAR_COLORS = [0xc8372d, 0x2d6fc8, 0xe0b23a, 0x3a9a6a, 0xe8e4da, 0x6a3fa0];
const CLOTHES = [0x2f4f7f, 0x8a3b3b, 0x3f6f4a, 0x6b5a3a, 0x444a55, 0x9a6b2f];

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

/** An original, toy-like hatchback that faces -z. Headlights/taillights glow at night. */
export function makeBoxCar(color: number): THREE.Group {
  const g = new THREE.Group();
  g.name = "box-car";
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.12 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223140, roughness: 0.06, metalness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.7, metalness: 0.2 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.92 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.3, metalness: 0.9 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 0.2, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x701010, emissive: 0xff2010, emissiveIntensity: 0.2, roughness: 0.4 });
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
  for (const [x, z] of [
    [-0.84, -1.32],
    [0.84, -1.32],
    [-0.84, 1.34],
    [0.84, 1.34],
  ] as const) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.position.set(x, 0.36, z);
    const r = new THREE.Mesh(rimGeo, rim);
    r.position.set(x, 0.36, z);
    g.add(w, r);
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
  g.userData.fcLamps = [lamp, tail];
  return g;
}

/** A plain human stand-in (about 1.75 m): capsule body, head; origin at the feet, faces -z. */
export function makePerson(color: number): THREE.Group {
  const g = new THREE.Group();
  g.name = "person";
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc69c7b, roughness: 0.7 });
  const legs = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.9 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.55, 4, 10), cloth);
  torso.position.y = 1.16;
  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.62, 4, 8), legs);
  hips.position.y = 0.48;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), skin);
  head.position.y = 1.62;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.06), skin);
  nose.position.set(0, 1.62, -0.13);
  g.add(torso, hips, head, nose);
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

interface PlayerView {
  car: THREE.Object3D;
  carSource: "file" | "fallback";
  person: THREE.Object3D | null;
  colorIndex: number;
}

export class Actors {
  readonly group = new THREE.Group();
  private players = new Map<string, PlayerView>();
  private registry: ModelRegistry<THREE.Object3D>;
  private night = 0;
  private hidden: string | null = null;
  private hiddenPart: "car" | "person" = "car";

  constructor(registry: ModelRegistry<THREE.Object3D>) {
    this.registry = registry;
    this.group.name = "actors";
  }

  private view(id: string): PlayerView {
    let v = this.players.get(id);
    if (v) return v;
    const colorIndex = this.players.size;
    const now = this.registry.now("player-car");
    const car = now.source === "file" ? now.model : makeBoxCar(CAR_COLORS[colorIndex % CAR_COLORS.length]!);
    v = { car, carSource: now.source, person: null, colorIndex };
    this.players.set(id, v);
    this.group.add(car);
    this.applyNight(car);
    if (now.source === "fallback") {
      // Swap in the real model if it turns up.
      void this.registry.get("player-car").then((r) => {
        const cur = this.players.get(id);
        if (r.source !== "file") {
          disposeTree(r.model);
          return;
        }
        if (!cur || cur.carSource === "file") return;
        r.model.position.copy(cur.car.position);
        r.model.rotation.copy(cur.car.rotation);
        r.model.visible = cur.car.visible;
        this.group.remove(cur.car);
        disposeTree(cur.car);
        cur.car = r.model;
        cur.carSource = "file";
        this.group.add(r.model);
        this.applyNight(r.model);
      });
    }
    return v;
  }

  setCar(id: string, pose: Pose): void {
    const v = this.view(id);
    v.car.position.set(pose.x, pose.y, pose.z);
    v.car.rotation.y = -pose.heading;
    v.car.visible = !(this.hidden === id && this.hiddenPart === "car");
  }

  /** Show (pose) or hide (null) the player's on-foot body. */
  setFoot(id: string, pose: Pose | null): void {
    const v = this.view(id);
    if (!pose) {
      if (v.person) v.person.visible = false;
      return;
    }
    if (!v.person) {
      v.person = makePerson(CLOTHES[v.colorIndex % CLOTHES.length]!);
      this.group.add(v.person);
    }
    v.person.visible = !(this.hidden === id && this.hiddenPart === "person");
    v.person.position.set(pose.x, pose.y, pose.z);
    v.person.rotation.y = -pose.heading;
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
      // A loaded model shares geometry with the registry's prototype: only dispose our own.
      if (v.carSource === "fallback") disposeTree(v.car);
      if (v.person) {
        this.group.remove(v.person);
        disposeTree(v.person);
      }
      this.players.delete(id);
    }
  }

  setNight(n: number): void {
    this.night = n;
    for (const v of this.players.values()) this.applyNight(v.car);
  }

  private applyNight(car: THREE.Object3D): void {
    const lamps = car.userData.fcLamps as THREE.MeshStandardMaterial[] | undefined;
    if (lamps) for (const m of lamps) m.emissiveIntensity = 0.2 + this.night * 3.5;
  }

  dispose(): void {
    this.remove(new Set());
  }
}
