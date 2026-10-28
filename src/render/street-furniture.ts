// Traffic signals and stop signs from the pipeline's street-furniture.json
// (pipeline/lib/street-furniture.ts), as instances per street-detail cell: in the layer's shared
// instance pool (instance-pool.ts), or the cell's own instanced meshes. Render-only.
//
// Supplied signal controls use the same phase plan as the cars. The legacy two-axis plan
// remains available for standalone fixtures without controls.
// Models face -z; the renderer sets rotation.y = -heading.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TICK_HZ } from "../sim/contract.ts";
import { signalPhase, type TrafficSignalControls } from "../sim/traffic-signals.ts";
import { LocalInstances, type InstanceBlock, type InstanceSink } from "./instance-pool.ts";

export interface SignalRecord {
  id: string;
  node: string;
  x: number;
  z: number;
  heading: number;
  group: 0 | 1;
  arm: number;
  ped: number | null;
}

export interface StopSignRecord {
  id: string;
  node: string;
  x: number;
  z: number;
  heading: number;
  allWay: boolean;
}

export const SIGNAL_CYCLE_S = 60;
const GREEN_S = 27;
const YELLOW_S = 3;
const WALK_S = 20;

/** FNV-1a of a string, 32-bit. */
export function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Aspect = "green" | "yellow" | "red";

/** The vehicle aspect and pedestrian WALK of a group at a node at a sim tick. */
export function signalState(node: string, group: 0 | 1, tick: number): { aspect: Aspect; walk: boolean } {
  const offset = hashId(node) % (SIGNAL_CYCLE_S * TICK_HZ);
  const t = (((tick + offset) % (SIGNAL_CYCLE_S * TICK_HZ)) / TICK_HZ + (group === 1 ? SIGNAL_CYCLE_S / 2 : 0)) % SIGNAL_CYCLE_S;
  const aspect: Aspect = t < GREEN_S ? "green" : t < GREEN_S + YELLOW_S ? "yellow" : "red";
  // People cross this leg while the other axis has its green.
  const cross = t - SIGNAL_CYCLE_S / 2;
  return { aspect, walk: cross >= 0 && cross < WALK_S };
}

const POLE_H = 4.8;
const HEAD_Y = 4.0;
const ARM_Y = 5.6;
const PED_Y = 2.7;
const LENS_SPACING = .37;

interface Protos {
  pole: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  backplate: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  armPole: THREE.BufferGeometry;
  lens: THREE.BufferGeometry;
  pedHead: THREE.BufferGeometry;
  post: THREE.BufferGeometry;
  plate: THREE.BufferGeometry;
  plateBack: THREE.BufferGeometry;
  plaque: THREE.BufferGeometry;
  metal: THREE.MeshStandardMaterial;
  housing: THREE.MeshStandardMaterial;
  border: THREE.MeshStandardMaterial;
  lensMat: THREE.MeshBasicMaterial;
  stopFace: THREE.MeshStandardMaterial;
  stopBack: THREE.MeshStandardMaterial;
  plaqueMat: THREE.MeshStandardMaterial;
}

let protos: Protos | null = null;

function textTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** An octagon in the xy plane, flat top, facing +z, with UVs over its bounding square. */
function octagon(r: number): THREE.BufferGeometry {
  return new THREE.CircleGeometry(r, 8, Math.PI / 8);
}

/** Full-size vehicle head with shallow open-bottom sun visors, all one draw batch. */
function vehicleHead(): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, normal: THREE.Vector3): void => {
    if (b.clone().sub(a).cross(c.clone().sub(a)).dot(normal) < 0) [b, d] = [d, b];
    for (const p of [a, b, c, a, c, d]) { positions.push(p.x, p.y, p.z); normals.push(normal.x, normal.y, normal.z); uvs.push(0, 0); }
  };
  for (const y of [LENS_SPACING, 0, -LENS_SPACING]) {
    const at = (r: number, angle: number, z: number): THREE.Vector3 => new THREE.Vector3(Math.cos(angle) * r, y + Math.sin(angle) * r, z);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 8, b = (i + 1) * Math.PI / 8, mid = (a + b) / 2;
      const n = new THREE.Vector3(Math.cos(mid), Math.sin(mid), 0);
      quad(at(.186, a, -.14), at(.186, b, -.14), at(.186, b, -.38), at(.186, a, -.38), n);
      quad(at(.165, a, -.14), at(.165, b, -.14), at(.165, b, -.38), at(.165, a, -.38), n.clone().negate());
      quad(at(.165, a, -.38), at(.165, b, -.38), at(.186, b, -.38), at(.186, a, -.38), new THREE.Vector3(0, 0, -1));
    }
  }
  const visors = new THREE.BufferGeometry();
  visors.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  visors.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  visors.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const box = new THREE.BoxGeometry(.46, 1.26, .28), housing = box.toNonIndexed();
  box.dispose();
  const geometry = mergeGeometries([housing, visors], false)!;
  housing.dispose(); visors.dispose();
  return geometry;
}

function getProtos(): Protos {
  if (protos) return protos;
  const stopTex = textTexture((ctx, w, h) => {
    const oct = (r: number): void => {
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        ctx.lineTo(w / 2 + Math.cos(a) * r, h / 2 - Math.sin(a) * r);
      }
      ctx.closePath();
    };
    ctx.fillStyle = "#ffffff";
    oct(w / 2);
    ctx.fill();
    ctx.fillStyle = "#b5121b";
    oct(w / 2 - 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 74px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("STOP", w / 2, h / 2 + 4);
  }, 256, 256);
  const plaqueTex = textTexture((ctx, w, h) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#b5121b";
    ctx.fillRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 40px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ALL WAY", w / 2, h / 2 + 2);
  }, 256, 80);
  const lens = new THREE.CircleGeometry(.15, 16).rotateY(Math.PI);
  protos = {
    pole: new THREE.CylinderGeometry(0.08, 0.11, POLE_H, 8).translate(0, POLE_H / 2, 0),
    head: vehicleHead(),
    backplate: new THREE.BoxGeometry(.68, 1.50, .045).translate(0, 0, .17),
    arm: new THREE.BoxGeometry(1, 0.12, 0.12).translate(0.5, 0, 0),
    armPole: new THREE.CylinderGeometry(0.1, 0.14, ARM_Y + 0.2, 8).translate(0, (ARM_Y + 0.2) / 2, 0),
    lens,
    pedHead: new THREE.BoxGeometry(0.32, 0.32, 0.2),
    post: new THREE.CylinderGeometry(0.035, 0.035, 2.45, 6).translate(0, 1.22, 0),
    plate: octagon(0.38).rotateY(Math.PI),
    plateBack: octagon(0.38),
    plaque: new THREE.PlaneGeometry(0.46, 0.15).rotateY(Math.PI),
    metal: new THREE.MeshStandardMaterial({ color: 0x4a4f4c, roughness: 0.55, metalness: 0.6, name: "fc:signal-pole" }),
    housing: new THREE.MeshStandardMaterial({ color: 0x1e211f, roughness: 0.7, metalness: 0.2, name: "fc:signal-head" }),
    border: new THREE.MeshStandardMaterial({ color: 0xe1bd48, roughness: .85, metalness: 0, name: "fc:signal-backplate" }),
    lensMat: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, name: "fc:signal-lens" }),
    stopFace: new THREE.MeshStandardMaterial({ color: stopTex ? 0xffffff : 0xb5121b, map: stopTex, roughness: 0.5, name: "fc:stop-sign" }),
    stopBack: new THREE.MeshStandardMaterial({ color: 0x9a9d9a, roughness: 0.6, metalness: 0.5, name: "fc:sign-back" }),
    plaqueMat: new THREE.MeshStandardMaterial({ color: plaqueTex ? 0xffffff : 0xb5121b, map: plaqueTex, roughness: 0.5, name: "fc:stop-plaque" }),
  };
  return protos;
}

/** Lamp colours, lit and dark (linear). */
const LAMP = {
  red: new THREE.Color(1.0, 0.025, 0.012),
  yellow: new THREE.Color(1.0, 0.65, 0.015),
  green: new THREE.Color(0.02, 0.95, 0.16),
  walk: new THREE.Color(0.95, 0.95, 0.9),
  hand: new THREE.Color(1.0, 0.35, 0.05),
};
const DARK = 0.035;

interface Lamp {
  index: number;
  node: string;
  group: 0 | 1;
  edge: string;
  signalId: string;
  lit?: boolean;
  /** Vehicle aspect this lens shows, or "ped". */
  kind: Aspect | "ped";
}

/** One cell's signals and stop signs. */
export class FurnitureCell {
  readonly group = new THREE.Group();
  readonly signals: number;
  readonly stopSigns: number;
  private readonly sink: InstanceSink;
  private readonly blocks: InstanceBlock[] = [];
  private readonly lenses: InstanceBlock | null;
  private readonly lamps: Lamp[] = [];
  private readonly controls: TrafficSignalControls | undefined;
  private readonly phases = new Map<string, { tick: number; aspect: Aspect; walk: boolean }>();
  private readonly lampColor = new THREE.Color();
  private lastTick = -1;

  /** `sink`: where the instances go; by default this cell's own meshes in `group`. */
  constructor(signals: readonly SignalRecord[], stopSigns: readonly StopSignRecord[], ground: (x: number, z: number) => number, controls?: TrafficSignalControls, sink?: InstanceSink) {
    const p = getProtos();
    this.sink = sink ?? new LocalInstances(this.group);
    this.signals = signals.length;
    this.stopSigns = stopSigns.length;
    this.controls = controls;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const local = new THREE.Vector3();
    const place = (x: number, z: number, heading: number, lx = 0, ly = 0, lz = 0, sx = 1): THREE.Matrix4 => {
      q.setFromAxisAngle(up, -heading);
      local.set(lx, ly, lz).applyQuaternion(q);
      pos.set(x + local.x, ground(x, z) + local.y, z + local.z);
      s.set(sx, 1, 1);
      return m.compose(pos, q, s);
    };
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string, cast = true, colors = false): InstanceBlock | null => {
      const block = this.sink.add(geo, mat, mats, { name, castShadow: cast, receiveShadow: true, colors });
      if (block) this.blocks.push(block);
      return block;
    };

    const poles: THREE.Matrix4[] = [], armPoles: THREE.Matrix4[] = [], arms: THREE.Matrix4[] = [];
    const heads: THREE.Matrix4[] = [], pedHeads: THREE.Matrix4[] = [], lenses: THREE.Matrix4[] = [];
    const aspects: Aspect[] = ["red", "yellow", "green"];
    const addHead = (sig: SignalRecord, lx: number, ly: number): void => {
      heads.push(place(sig.x, sig.z, sig.heading, lx, ly, 0).clone());
      aspects.forEach((a, k) => {
        lenses.push(place(sig.x, sig.z, sig.heading, lx, ly + LENS_SPACING - k * LENS_SPACING, -.16).clone());
        this.lamps.push({ index: lenses.length - 1, node: sig.node, group: sig.group, edge: sig.id.slice(`sig:${sig.node}:`.length), signalId: sig.id, kind: a });
      });
    };
    for (const sig of signals) {
      if (sig.arm > 0) {
        armPoles.push(place(sig.x, sig.z, sig.heading).clone());
        arms.push(place(sig.x, sig.z, sig.heading, 0, ARM_Y, 0, sig.arm).clone());
        addHead(sig, sig.arm - 0.2, ARM_Y - 0.6);
      } else {
        poles.push(place(sig.x, sig.z, sig.heading).clone());
      }
      addHead(sig, 0, HEAD_Y);
      if (sig.ped !== null) {
        pedHeads.push(place(sig.x, sig.z, sig.ped, 0, PED_Y, 0).clone());
        lenses.push(place(sig.x, sig.z, sig.ped, 0, PED_Y, -0.11).clone().scale(new THREE.Vector3(.68, .68, 1)));
        this.lamps.push({ index: lenses.length - 1, node: sig.node, group: sig.group, edge: sig.id.slice(`sig:${sig.node}:`.length), signalId: sig.id, kind: "ped" });
      }
    }
    inst(p.pole, p.metal, poles, "signal poles");
    inst(p.armPole, p.metal, armPoles, "signal mast poles");
    inst(p.arm, p.metal, arms, "signal mast arms");
    inst(p.head, p.housing, heads, "signal heads");
    inst(p.backplate, p.border, heads, "signal backplates");
    inst(p.pedHead, p.housing, pedHeads, "pedestrian heads");
    this.lenses = inst(p.lens, p.lensMat, lenses, "signal lenses", false, true);

    const posts: THREE.Matrix4[] = [], plates: THREE.Matrix4[] = [], backs: THREE.Matrix4[] = [], plaques: THREE.Matrix4[] = [];
    for (const st of stopSigns) {
      posts.push(place(st.x, st.z, st.heading).clone());
      plates.push(place(st.x, st.z, st.heading, 0, 2.15, -0.045).clone());
      backs.push(place(st.x, st.z, st.heading, 0, 2.15, -0.035).clone());
      if (st.allWay) plaques.push(place(st.x, st.z, st.heading, 0, 1.66, -0.045).clone());
    }
    inst(p.post, p.metal, posts, "sign posts");
    inst(p.plate, p.stopFace, plates, "stop signs");
    inst(p.plateBack, p.stopBack, backs, "stop sign backs");
    inst(p.plaque, p.plaqueMat, plaques, "all-way plaques");
  }

  /** Check the exact sim tick; upload colors only when a lamp changes aspect. */
  update(tick: number): void {
    if (!this.lenses) return;
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const c = this.lampColor;
    let changed = false;
    for (const l of this.lamps) {
      let st = this.phases.get(l.signalId);
      if (!st || st.tick !== tick) {
        const control = this.controls?.get(l.node), group = control?.approaches.get(l.edge);
        const next = control ? group === undefined ? { aspect: "red" as const, walk: false } : signalPhase(l.node, group, tick, control.groupCount)
          : signalState(l.node, l.group, tick);
        if (!st) { st = { ...next, tick }; this.phases.set(l.signalId, st); }
        else { st.tick = tick; st.aspect = next.aspect; st.walk = next.walk; }
      }
      const lit = l.kind === "ped" ? st.walk : st.aspect === l.kind;
      if (l.lit === lit) continue;
      l.lit = lit;
      if (l.kind === "ped") c.copy(st.walk ? LAMP.walk : LAMP.hand);
      else c.copy(LAMP[l.kind]).multiplyScalar(st.aspect === l.kind ? 1 : DARK);
      this.lenses.setColorAt(l.index, c);
      changed = true;
    }
    if (changed) this.lenses.commitColors();
  }

  dispose(): void {
    // Prototype geometries and materials are shared; only this cell's instances are released.
    for (const block of this.blocks) this.sink.release(block);
    this.blocks.length = 0;
    this.group.clear();
  }
}
