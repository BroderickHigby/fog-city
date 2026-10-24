// Draws the sim's ambient agents (state.ext.agents: robotaxis, errand robots, sidewalk bots,
// people) between two sim ticks, interpolated with agentPairs(prev, curr).
//
// Cost is the hard constraint (hundreds of agents, software WebGL in tests), so nothing is
// cloned per agent: every rigid part of every kind is ONE InstancedMesh in the packed format
// (agent-packing.ts), whatever the number of agents.
//  - near tier (agent-lod.ts: the 16 nearest within 60 m): the full model split at its joints,
//    animated: wheels roll (rotation.x -= distance / radius) and the front ones steer, Footman
//    (errand robot) limbs swing while walking (bag full by default), people walk. The Meander
//    robotaxi's sliding door is its own part, drawn shut until the sim carries a door state.
//  - mid tier (to 140 m): the model vertex-clustered to a few hundred triangles, rest pose.
//  - far tier (to 450 m): a hand-built box proxy (~70-160 triangles) with the model's colours.
//  - mode cues on every tier: wait/yield (or slowing harder than 2.4 m/s^2, measured over the
//    distance moved so a far agent the sim steps every 4th tick reads the same, and held
//    0.35 s) = brake lights; honk = hazards and the status light flashing.
//  - far from every player the sim steps an agent only every LOD_STRIDE ticks; it is drawn
//    across that whole step (agent-lod.ts trackStep/windowAlpha) so it glides, not stop-go.
//  - errand robots carry a full bag unless the agent says otherwise; setBags() overrides it.
// Instance capacities come from tierCapacity() and instanceBudget() (agent-lod.ts): mid and far
// parts hold MAX_AGENTS, near parts nearCap (x2 for a person's arms and legs).
// With shadows on (?shadows=1) every agent mesh casts and receives them.
// Draw calls: robotaxi 5 near + 2, errand robot 6 + 2, sidewalk bot 3 + 2, people 3 + 2: at
// most 25, and an InstancedMesh with no instances this frame is not drawn at all.
// Until a kind's model has loaded (or if it never does), its agents draw as the box proxy.

import * as THREE from "three";
import { AGENT_KINDS, AGENT_SPEC, MAX_AGENTS, agentPairs, playerBodies, type AgentKind, type AgentState } from "../sim/agents.ts";
import type { SimState } from "../sim/contract.ts";
import {
  DEFAULT_TIERS,
  TIER_FAR,
  TIER_HIDDEN,
  TIER_MID,
  TIER_NEAR,
  advanceGait,
  agentCue,
  agentModelScale,
  gaitAmount,
  instanceBudget,
  interpolateAgent,
  onFarStride,
  rollWheel,
  selectTiers,
  steerFromYaw,
  tierCapacity,
  trackStep,
  windowAlpha,
  type AgentCue,
  type AgentPose,
  type StepWindow,
  type TierOptions,
  type Viewer,
} from "./agent-lod.ts";
import {
  agentUniforms,
  extractParts,
  mergePacked,
  packGeometry,
  packedMaterial,
  proxyOf,
  triangleCount,
  type Channel,
  type PackedModel,
  type PackedSurface,
  type PartSpec,
} from "./agent-packing.ts";
import { channelIntensities } from "./lights.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { HIP, SHOULDER, STRIDE_M, newLook, personLook, personParts, type PersonLook } from "./person.ts";
import type { CrowdHumans } from "./crowd-humans.ts";

// ---------------------------------------------------------------- one instanced part

/** One InstancedMesh for one rig part, with its per-instance cue (and, for people, look) attributes. */
export class PartMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  readonly triangles: number;
  count = 0;
  private readonly cue: THREE.InstancedBufferAttribute;
  private readonly cols: THREE.InstancedBufferAttribute[];

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string, slots: boolean) {
    // Share the vertex data; the instanced attributes are this mesh's own.
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(geometry.attributes)) g.setAttribute(k, a);
    g.setIndex(geometry.index);
    this.capacity = capacity;
    this.triangles = triangleCount(geometry);
    this.cue = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.cue.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("fcCue", this.cue);
    this.cols = [];
    if (slots) {
      for (const k of ["fcColA", "fcColB", "fcColC", "fcColD"]) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(k, a);
        this.cols.push(a);
      }
    }
    this.mesh = new THREE.InstancedMesh(g, material, capacity);
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  begin(): void {
    this.count = 0;
  }

  push(m: THREE.Matrix4, cue: Readonly<AgentCue> | null, look: Readonly<PersonLook> | null): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const c = this.cue.array as Float32Array;
    c[i * 2] = cue ? cue.brake : 0;
    c[i * 2 + 1] = cue ? cue.flash : 0;
    if (look && this.cols.length === 4) {
      setRgb(this.cols[0]!, i, look.shirt);
      setRgb(this.cols[1]!, i, look.pants);
      setRgb(this.cols[2]!, i, look.skin);
      setRgb(this.cols[3]!, i, look.hair);
    }
    this.count = i + 1;
    return true;
  }

  end(): void {
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    flag(this.mesh.instanceMatrix, n * 16);
    flag(this.cue, n * 2);
    for (const a of this.cols) flag(a, n * 3);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

/** Shadows on (?shadows=1): the mesh casts and receives them. */
export function castShadows(mesh: THREE.Object3D, on: boolean): void {
  mesh.castShadow = on;
  mesh.receiveShadow = on;
}

function setRgb(a: THREE.InstancedBufferAttribute, i: number, c: THREE.Color): void {
  const arr = a.array as Float32Array;
  arr[i * 3] = c.r;
  arr[i * 3 + 1] = c.g;
  arr[i * 3 + 2] = c.b;
}

function flag(a: THREE.BufferAttribute, count: number): void {
  a.clearUpdateRanges();
  a.addUpdateRange(0, count);
  a.needsUpdate = true;
}

// ---------------------------------------------------------------- scratch maths

const _base = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** Agent placement: origin on the ground, rotation.y = -heading, nose-up pitch, uniform scale. */
function baseMatrix(x: number, y: number, z: number, heading: number, pitch: number, scale: number, out: THREE.Matrix4): THREE.Matrix4 {
  _e.set(pitch, -heading, 0, "YXZ");
  _q.setFromEuler(_e);
  return out.compose(_p.set(x, y, z), _q, _s.setScalar(scale));
}

/** base x T(pivot) x Ry(ry) x Rx(rx). */
function partMatrix(base: THREE.Matrix4, px: number, py: number, pz: number, rx: number, ry: number, out: THREE.Matrix4): THREE.Matrix4 {
  _e.set(rx, ry, 0, "YXZ");
  _q.setFromEuler(_e);
  _local.compose(_p.set(px, py, pz), _q, _one);
  return out.multiplyMatrices(base, _local);
}

// ---------------------------------------------------------------- people (agents and players)

/** Instanced people: body, two arms, two legs per person; also draws players on foot. */
export class PeopleRig {
  readonly group = new THREE.Group();
  readonly body: PartMesh;
  readonly arms: PartMesh;
  readonly legs: PartMesh;

  /** `people`: the most people drawn at once (each takes one body, two arms and two legs). */
  constructor(people: number, material: THREE.Material, name: string, shadows = false) {
    const parts = personParts();
    this.body = new PartMesh(parts.body, material, instanceBudget(people, 1), `${name}:body`, true);
    this.arms = new PartMesh(parts.arm, material, instanceBudget(people, 2), `${name}:arms`, true);
    this.legs = new PartMesh(parts.leg, material, instanceBudget(people, 2), `${name}:legs`, true);
    this.group.name = name;
    for (const m of [this.body, this.arms, this.legs]) {
      castShadows(m.mesh, shadows);
      this.group.add(m.mesh);
    }
  }

  begin(): void {
    this.body.begin();
    this.arms.begin();
    this.legs.begin();
  }

  /** One person: `swing` is sin(gait phase) times the gait amount (-1..1). */
  add(x: number, y: number, z: number, heading: number, look: Readonly<PersonLook>, swing: number): void {
    if (this.body.count >= this.body.capacity) return;
    baseMatrix(x, y, z, heading, 0, look.scale, _base);
    this.body.push(_base, null, look);
    const leg = 0.42 * swing;
    const arm = 0.34 * swing;
    this.legs.push(partMatrix(_base, -HIP[0], HIP[1], HIP[2], leg, 0, _m), null, look);
    this.legs.push(partMatrix(_base, HIP[0], HIP[1], HIP[2], -leg, 0, _m), null, look);
    this.arms.push(partMatrix(_base, -SHOULDER[0], SHOULDER[1], SHOULDER[2], -arm, 0, _m), null, look);
    this.arms.push(partMatrix(_base, SHOULDER[0], SHOULDER[1], SHOULDER[2], arm, 0, _m), null, look);
  }

  end(): void {
    this.body.end();
    this.arms.end();
    this.legs.end();
  }

  get drawCalls(): number {
    return (this.body.count > 0 ? 1 : 0) + (this.arms.count > 0 ? 1 : 0) + (this.legs.count > 0 ? 1 : 0);
  }

  dispose(): void {
    this.body.dispose();
    this.arms.dispose();
    this.legs.dispose();
  }
}

// ---------------------------------------------------------------- kinds

/** Registry keys of the agent models (model-registry.ts MODEL_FILES). */
export const AGENT_MODEL_KEY: Readonly<Record<Exclude<AgentKind, "person">, string>> = {
  robotaxi: "robotaxi",
  errandRobot: "robot",
  sidewalkBot: "sidewalk-bot",
};

const NONE: Channel = { type: "none" };

/**
 * How each model splits into animated parts (node names: assets/blender/README.md, "Models and
 * their contracts"). Wave 2: the Meander robotaxi has no sensor dome and a kerb-side sliding
 * door; the Trundle (sidewalk bot) has four wheels on two axles, a lid and cargo (drawn with
 * the body) and no flag; the Footman (errand robot) keeps the wave-1 node contract.
 */
export const AGENT_RIGS: Readonly<Record<Exclude<AgentKind, "person">, readonly PartSpec[]>> = {
  robotaxi: [
    { name: "body", nodes: [], pivot: "root", channel: NONE },
    { name: "doorR", nodes: ["door_slide_R"], pivot: "node", channel: { type: "slide" } },
    { name: "wheelFL", nodes: ["wheel_FL"], pivot: "node", channel: { type: "steer-spin" } },
    { name: "wheelFR", nodes: ["wheel_FR"], pivot: "node", channel: { type: "steer-spin" } },
    // Both rear wheels turn about the same axle line: one rigid part.
    { name: "axleRear", nodes: ["wheel_RL", "wheel_RR"], pivot: "centre", channel: { type: "spin" } },
  ],
  errandRobot: [
    { name: "body", nodes: [], pivot: "root", channel: NONE },
    { name: "armL", nodes: ["arm_upper_L"], pivot: "node", channel: { type: "swing", gain: -0.8 } },
    { name: "armR", nodes: ["arm_upper_R"], pivot: "node", channel: { type: "swing", gain: 0.45 } },
    { name: "bagContents", nodes: ["bag_contents"], pivot: { part: "armR" }, channel: { type: "swing", gain: 0.45 }, bagContents: true },
    { name: "legL", nodes: ["leg_upper_L"], pivot: "node", channel: { type: "swing", gain: 1 } },
    { name: "legR", nodes: ["leg_upper_R"], pivot: "node", channel: { type: "swing", gain: -1 } },
  ],
  sidewalkBot: [
    { name: "body", nodes: [], pivot: "root", channel: NONE },
    // 1 = front, 2 = rear.
    { name: "axle1", nodes: ["wheel_L1", "wheel_R1"], pivot: "centre", channel: { type: "spin" } },
    { name: "axle2", nodes: ["wheel_L2", "wheel_R2"], pivot: "centre", channel: { type: "spin" } },
  ],
};

/**
 * Vertex-cluster cell for each kind's mid-range proxy, metres. The wave-2 Trundle has twice the
 * wave-1 bot's detail; 0.12 m cells left it 302 triangles (budget 200), 0.2 m leaves 176. At the
 * mid tier's 60 m the 0.56 m bot is about six pixels tall, so the coarser cell does not show.
 */
export const PROXY_CELL: Readonly<Record<Exclude<AgentKind, "person">, number>> = { robotaxi: 0.2, errandRobot: 0.16, sidewalkBot: 0.2 };
/** Peak limb swing, radians, for a walking errand robot. */
const ROBOT_SWING = 0.38;

interface KindView {
  kind: Exclude<AgentKind, "person">;
  /** "file" once the model is in; until then (and if it never loads) the box proxy draws everything. */
  source: "pending" | "file" | "fallback";
  model: PackedModel | null;
  scale: number;
  near: Array<{ part: PartMesh; pivot: THREE.Vector3; channel: Channel; bagContents: boolean }>;
  mid: PartMesh;
  far: PartMesh;
}

interface Anim {
  wheel: number;
  steer: number;
  gait: number;
  amount: number;
  x: number;
  z: number;
  heading: number;
  seen: number;
}

export interface AgentRenderInfo {
  /** Agents drawn last frame (both tiers). */
  drawn: number;
  /** Of those, with the full animated model. */
  near: number;
  /** Agents in the sim state. */
  total: number;
  /** Agent draw calls last frame. */
  drawCalls: number;
  /** Agent triangles last frame. */
  triangles: number;
  /** Kinds whose model file is in use. */
  models: string[];
}

export class AgentLayer {
  readonly group = new THREE.Group();
  private readonly material = packedMaterial(false);
  private readonly peopleMaterial = packedMaterial(true);
  private readonly kinds = new Map<AgentKind, KindView>();
  private readonly people: PeopleRig;
  private readonly peopleMid: PartMesh;
  private readonly peopleFar: PartMesh;
  private readonly opts: TierOptions;
  private readonly shadows: boolean;
  /** Instances per part mesh: far and mid hold every agent, near the nearCap nearest. */
  private readonly capFar: number;
  private readonly capMid: number;
  private readonly capNear: number;
  private disposed = false;

  private lastPrev: SimState | null = null;
  private lastCurr: SimState | null = null;
  private pairs: Array<[AgentState | null, AgentState]> = [];
  /** Per agent id: the sim step it is drawn across (one tick near players, LOD_STRIDE far away). */
  private windows = new Map<number, StepWindow>();
  private windowTick = -Infinity;
  /** Errand robots' bags: full, empty, or (null) as each agent says. */
  private bags: boolean | null = null;
  private poses: AgentPose[] = [];
  private ids = new Int32Array(0);
  private xs = new Float64Array(0);
  private zs = new Float64Array(0);
  private tiers = new Uint8Array(0);
  private scratch = { idx: new Int32Array(0), key: new Float64Array(0) };
  private wasNear = new Set<number>();
  private anims = new Map<number, Anim>();
  private frameNo = 0;
  private readonly cue: AgentCue = { brake: 0, flash: 0, brakeUntil: 0 };
  /** Per agent id: render time until which its brake lights stay on (agentCue's hold). */
  private brakeUntil = new Map<number, number>();
  private readonly look = newLook();
  private stats: AgentRenderInfo = { drawn: 0, near: 0, total: 0, drawCalls: 0, triangles: 0, models: [] };

  constructor(registry: ModelRegistry<THREE.Object3D>, opts: Partial<TierOptions> = {}, shadows = false) {
    this.opts = { ...DEFAULT_TIERS, ...opts };
    this.shadows = shadows;
    this.capFar = instanceBudget(tierCapacity(TIER_FAR, this.opts, MAX_AGENTS), 1);
    this.capMid = instanceBudget(tierCapacity(TIER_MID, this.opts, MAX_AGENTS), 1);
    this.capNear = tierCapacity(TIER_NEAR, this.opts, MAX_AGENTS);
    this.group.name = "agents";
    for (const kind of AGENT_KINDS) {
      if (kind === "person") continue;
      const box = fallbackProxy(kind);
      const far = this.adopt(new PartMesh(box, this.material, this.capFar, `agents:${kind}:far`, false));
      const mid = this.adopt(new PartMesh(box, this.material, this.capMid, `agents:${kind}:mid`, false));
      const view: KindView = { kind, source: "pending", model: null, scale: 1, near: [], mid, far };
      this.kinds.set(kind, view);
      void registry.get(AGENT_MODEL_KEY[kind]).then((r) => {
        if (this.disposed) return;
        if (r.source !== "file") {
          view.source = "fallback";
          return;
        }
        this.install(view, extractParts(r.model, AGENT_RIGS[kind]));
      });
    }
    this.people = new PeopleRig(this.capNear, this.peopleMaterial, "agents:people", shadows);
    this.group.add(this.people.group);
    this.peopleMid = this.adopt(new PartMesh(personParts().mid, this.peopleMaterial, this.capMid, "agents:people:mid", true));
    this.peopleFar = this.adopt(new PartMesh(personParts().far, this.peopleMaterial, this.capFar, "agents:people:far", true));
  }

  /** Into the scene, casting shadows when they are on. */
  private adopt(part: PartMesh): PartMesh {
    castShadows(part.mesh, this.shadows);
    this.group.add(part.mesh);
    return part;
  }

  /** Every part mesh's instance capacity, by mesh name (tests check it against the budget rule). */
  capacities(): Record<string, number> {
    const out: Record<string, number> = {};
    this.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) out[m.name] = m.instanceMatrix.count;
    });
    return out;
  }

  private install(view: KindView, model: PackedModel): void {
    const size = model.bodyBounds.isEmpty() ? model.bounds : model.bodyBounds;
    view.scale = agentModelScale(view.kind, { length: size.max.z - size.min.z, width: size.max.x - size.min.x });
    view.model = model;
    for (const p of model.parts) {
      if (!p.geometry) continue;
      const part = this.adopt(new PartMesh(p.geometry, this.material, instanceBudget(this.capNear, 1), `agents:${view.kind}:${p.name}`, false));
      view.near.push({ part, pivot: p.pivot, channel: p.channel, bagContents: p.bagContents });
    }
    const proxy = proxyOf(model, PROXY_CELL[view.kind]);
    // Only the old instanced mesh goes: its box geometry is the far tier's too.
    this.group.remove(view.mid.mesh);
    view.mid.mesh.dispose();
    view.mid = this.adopt(new PartMesh(proxy, this.material, this.capMid, `agents:${view.kind}:mid`, false));
    view.source = "file";
  }

  /**
   * Render-only: errand robots' bags full (true), empty (false), or as each agent says (null,
   * the default; the sim carries no bag tell yet, so full).
   */
  setBags(full: boolean | null): void {
    this.bags = full;
  }

  /** Scale the light channels for night (0 day .. 1 night). */
  private crowd: CrowdHumans | null = null;

  /** Draw the nearest people with the skinned crowd (null: the procedural rig only). */
  setCrowd(crowd: CrowdHumans | null): void {
    this.crowd = crowd;
  }

  setNight(night: number): void {
    const [h, t, s] = channelIntensities(night);
    agentUniforms.fcLightK.value.x = h;
    agentUniforms.fcLightK.value.y = t;
    agentUniforms.fcLightK.value.z = s;
  }

  /** Triangles of each kind's near model and far proxy (for reports and tests). */
  budgets(): Record<string, { near: number; mid: number; far: number; source: string }> {
    const out: Record<string, { near: number; mid: number; far: number; source: string }> = {};
    for (const [k, v] of this.kinds) {
      out[k] = { near: v.near.reduce((s, p) => s + p.part.triangles, 0), mid: v.mid.triangles, far: v.far.triangles, source: v.source };
    }
    out.person = {
      near: this.people.body.triangles + 2 * this.people.arms.triangles + 2 * this.people.legs.triangles,
      mid: this.peopleMid.triangles,
      far: this.peopleFar.triangles,
      source: "procedural",
    };
    return out;
  }

  info(): AgentRenderInfo {
    return this.stats;
  }

  /**
   * Place every agent for this frame: `alpha` is the fraction of a tick since `curr`'s, the
   * viewer the camera, `dt` the frame time and `time` a running render clock (seconds).
   */
  update(prev: SimState, curr: SimState, alpha: number, viewer: Readonly<Viewer>, dt: number, time: number): void {
    this.frameNo++;
    if (prev !== this.lastPrev || curr !== this.lastCurr) {
      this.lastPrev = prev;
      this.lastCurr = curr;
      this.pairs = agentPairs(prev, curr);
      this.track(prev, curr.tick);
    }
    const pairs = this.pairs;
    const n = pairs.length;
    const tick = curr.tick;
    this.ensure(n);
    for (let i = 0; i < n; i++) {
      const b = pairs[i]![1];
      const w = this.windows.get(b.id)!;
      const p = interpolateAgent(w.from, w.to, windowAlpha(w, tick, alpha), this.poses[i]!);
      this.ids[i] = b.id;
      this.xs[i] = p.x;
      this.zs[i] = p.z;
    }
    selectTiers(n, this.ids, this.xs, this.zs, viewer, this.wasNear, this.opts, this.tiers, this.scratch);
    this.wasNear.clear();

    for (const v of this.kinds.values()) {
      v.mid.begin();
      v.far.begin();
      for (const p of v.near) p.part.begin();
    }
    this.people.begin();
    this.peopleMid.begin();
    this.peopleFar.begin();
    this.crowd?.begin(dt);
    let drawn = 0;
    let near = 0;
    for (let i = 0; i < n; i++) {
      const tier = this.tiers[i]!;
      if (tier === TIER_HIDDEN) continue;
      const [a, b] = pairs[i]!;
      const pose = this.poses[i]!;
      const held = this.brakeUntil.get(b.id) ?? -Infinity;
      const moved = a ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
      const cue = agentCue(b.kind, b.mode, a ? a.speed : b.speed, b.speed, moved, time, held, this.cue);
      if((b as AgentState&{visualFlash?:boolean}).visualFlash)cue.flash=Math.sin(time*9)>0?1:0;
      if (cue.brakeUntil > held) this.brakeUntil.set(b.id, cue.brakeUntil);
      drawn++;
      if (b.kind === "person") {
        personLook(b.id, this.look);
        if (tier === TIER_NEAR) {
          const anim = this.anim(b.id, pose, dt);
          this.wasNear.add(b.id);
          near++;
          // The nearest people are skinned Rocketbox bodies once loaded (crowd-humans.ts).
          if (this.crowd?.add(b.id, pose.x, pose.y, pose.z, pose.heading, b.speed, dt)) continue;
          this.people.add(pose.x, pose.y, pose.z, pose.heading, this.look, Math.sin(anim.gait) * anim.amount);
        } else {
          baseMatrix(pose.x, pose.y, pose.z, pose.heading, 0, this.look.scale, _base);
          (tier === TIER_MID ? this.peopleMid : this.peopleFar).push(_base, null, this.look);
        }
        continue;
      }
      const view = this.kinds.get(b.kind)!;
      if (tier === TIER_NEAR && view.source === "file") {
        this.wasNear.add(b.id);
        near++;
        this.drawNear(view, b, pose, cue, dt);
      } else {
        baseMatrix(pose.x, pose.y, pose.z, pose.heading, pose.pitch, view.scale, _base);
        _base.scale(_s.set(1,visualHeight(b),1));
        (tier === TIER_FAR ? view.far : view.mid).push(_base, cue, null);
      }
    }
    let calls = 0;
    let tris = 0;
    const tally = (m: PartMesh): void => {
      m.end();
      if (m.count === 0) return;
      calls++;
      tris += m.count * m.triangles;
    };
    for (const v of this.kinds.values()) {
      tally(v.mid);
      tally(v.far);
      for (const p of v.near) tally(p.part);
    }
    this.people.end();
    this.crowd?.end();
    for (const m of [this.people.body, this.people.arms, this.people.legs]) if (m.count > 0) tris += m.count * m.triangles;
    calls += this.people.drawCalls;
    tally(this.peopleMid);
    tally(this.peopleFar);

    if (this.frameNo % 120 === 0) {
      for (const [id, an] of this.anims) if (this.frameNo - an.seen > 120) this.anims.delete(id);
      for (const [id, until] of this.brakeUntil) if (until < time) this.brakeUntil.delete(id);
      for (const [id, w] of this.windows) if (w.seen < this.windowTick) this.windows.delete(id);
    }
    const s = this.stats;
    s.drawn = drawn;
    s.near = near;
    s.total = n;
    s.drawCalls = calls;
    s.triangles = tris;
    s.models = [...this.kinds.values()].filter((v) => v.source === "file").map((v) => v.kind);
  }

  /** Each agent's step window for a new current tick (the sim decides far from prev's player bodies). */
  private track(prev: SimState, tick: number): void {
    if (tick <= this.windowTick) this.windows.clear(); // a rewind or a new session
    this.windowTick = tick;
    const bodies = playerBodies(prev);
    for (const [a, b] of this.pairs) {
      const far = a !== null && onFarStride(bodies, a.x, a.z);
      const w = this.windows.get(b.id);
      const next = trackStep(w, a, b, b.id, tick, far);
      if (next !== w) this.windows.set(b.id, next);
    }
  }

  private ensure(n: number): void {
    while (this.poses.length < n) this.poses.push({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, speed: 0 });
    if (this.ids.length >= n) return;
    const cap = Math.max(n, this.ids.length * 2, 64);
    this.ids = new Int32Array(cap);
    this.xs = new Float64Array(cap);
    this.zs = new Float64Array(cap);
    this.tiers = new Uint8Array(cap);
    this.scratch = { idx: new Int32Array(cap), key: new Float64Array(cap) };
  }

  /** The animation state of a near agent, advanced to this frame's pose. */
  private anim(id: number, pose: AgentPose, dt: number, wheelRadius = 0.35, wheelbase = 2.7, cruise = 1.3): Anim {
    let an = this.anims.get(id);
    const fresh = !an || this.frameNo - an.seen > 2;
    if (!an) {
      an = { wheel: 0, steer: 0, gait: (id * 1.7) % (Math.PI * 2), amount: 0, x: pose.x, z: pose.z, heading: pose.heading, seen: 0 };
      this.anims.set(id, an);
    }
    let dist = 0;
    if (!fresh) {
      dist = Math.hypot(pose.x - an.x, pose.z - an.z);
      if (dist > 5) dist = 0; // a jump, not a roll
      if (pose.speed < 0) dist = -dist;
      if (dt > 0) {
        let dh = pose.heading - an.heading;
        if (dh > Math.PI) dh -= Math.PI * 2;
        else if (dh < -Math.PI) dh += Math.PI * 2;
        const target = steerFromYaw(dh / dt, pose.speed, wheelbase);
        an.steer += (target - an.steer) * Math.min(1, dt * 6);
      }
    } else {
      an.steer = 0;
    }
    an.wheel = rollWheel(an.wheel, dist, wheelRadius);
    an.gait = advanceGait(an.gait, dist, STRIDE_M);
    const want = gaitAmount(pose.speed, cruise);
    an.amount += (want - an.amount) * Math.min(1, dt * 5);
    an.x = pose.x;
    an.z = pose.z;
    an.heading = pose.heading;
    an.seen = this.frameNo;
    return an;
  }

  private drawNear(view: KindView, b: Readonly<AgentState>, pose: AgentPose, cue: Readonly<AgentCue>, dt: number): void {
    const model = view.model!;
    const spec = AGENT_SPEC[b.kind];
    const radius = model.wheelRadius * view.scale;
    const anim = this.anim(b.id, pose, dt, radius, model.wheelbase * view.scale, (spec.vmin + spec.vmax) / 2);
    baseMatrix(pose.x, pose.y, pose.z, pose.heading, pose.pitch, view.scale, _base);
    _base.scale(_s.set(1,visualHeight(b),1));
    const swing = Math.sin(anim.gait) * anim.amount * ROBOT_SWING;
    for (const p of view.near) {
      if (p.bagContents && !bagFull(b, this.bags)) continue;
      let rx = 0;
      let ry = 0;
      switch (p.channel.type) {
        case "spin":
          rx = anim.wheel;
          break;
        case "steer-spin":
          rx = anim.wheel;
          ry = -anim.steer;
          break;
        case "swing":
          rx = p.channel.gain * swing;
          break;
        case "slide": // shut: no door state in the sim yet
        case "none":
          break;
      }
      p.part.push(partMatrix(_base, p.pivot.x, p.pivot.y, p.pivot.z, rx, ry, _m), cue, null);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const v of this.kinds.values()) {
      v.mid.dispose();
      v.far.dispose();
      for (const p of v.near) p.part.dispose();
    }
    this.people.dispose();
    this.peopleMid.dispose();
    this.peopleFar.dispose();
    this.material.dispose();
    this.peopleMaterial.dispose();
  }
}

/**
 * Is this errand robot's bag full? `override` (AgentLayer.setBags) wins when set. Otherwise the
 * content track's tells say a bag is full (fullBag) or empty (emptyBag); the sim does not
 * carry the tell yet, so every bag is full (README default).
 */
export function bagFull(a: Readonly<AgentState>, override: boolean | null = null): boolean {
  if (override !== null) return override;
  const tell = (a as unknown as { tell?: unknown }).tell;
  return tell !== "emptyBag";
}

function visualHeight(a:Readonly<AgentState>):number {const scale=(a as AgentState&{visualHeightScale?:number}).visualHeightScale;return typeof scale==="number"&&Number.isFinite(scale)?Math.max(.05,Math.min(1,scale)):1;}

// ---------------------------------------------------------------- box proxies

function surf(hex: number, roughness = 0.6, metalness = 0, channel = 0, emissive = 0x000000): PackedSurface {
  const c = new THREE.Color().setHex(hex);
  const e = new THREE.Color().setHex(emissive);
  return { color: [c.r, c.g, c.b], roughness, metalness, emissive: [e.r, e.g, e.b], channel };
}

function placed(g: THREE.BufferGeometry, s: PackedSurface, x: number, y: number, z: number): THREE.BufferGeometry {
  const out = packGeometry(g, s, new THREE.Matrix4().makeTranslation(x, y, z), false);
  g.dispose();
  return out;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, s: PackedSurface): THREE.BufferGeometry {
  return placed(new THREE.BoxGeometry(w, h, d), s, x, y, z);
}

/** A box whose top face is scaled by (kx, kz): a greenhouse. */
function taper(w: number, h: number, d: number, kx: number, kz: number, x: number, y: number, z: number, s: PackedSurface): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * kx);
      p.setZ(i, p.getZ(i) * kz);
    }
  }
  g.computeVertexNormals();
  return placed(g, s, x, y, z);
}

/**
 * The far proxy of a kind (also its stand-in while the model loads, or if it never does):
 * boxes in the model's proportions and colours, lights included. Faces -z, origin on the ground.
 * Sizes follow the wave-2 models (assets/blender/README.md): the Meander robotaxi, 4.98 x 1.92 x
 * 1.53 m with its sensors in one dark roof band round a teal status line and no dome; the
 * Footman, 1.95 m to the ring on its lantern head; the Trundle, a 0.56 m bread bin with a sage
 * roll-top lid and no flag.
 */
export function fallbackProxy(kind: Exclude<AgentKind, "person">): THREE.BufferGeometry {
  const dark = surf(0x1b1d20, 0.8);
  if (kind === "robotaxi") {
    const white = surf(0xeceee9, 0.3, 0.05);
    const glass = surf(0x1b232b, 0.08, 0.6);
    const band = surf(0x0e1319, 0.06, 0.4);
    const head = surf(0xf4f6f8, 0.2, 0, 1, 0xf2f7ff);
    const tail = surf(0x8a1010, 0.3, 0, 2, 0xff2a1a);
    const status = surf(0x2fd6c1, 0.3, 0, 3, 0x2fffe0);
    const parts = [
      // Long side on z (the car faces -z): 1.9 m across, 4.95 m nose to tail, low and flat-roofed.
      box(1.9, 0.62, 4.95, 0, 0.6, 0, white),
      // Long raked windscreen and fastback: a glass greenhouse set back from the short nose.
      taper(1.8, 0.52, 4.0, 0.88, 0.82, 0, 1.17, 0.3, glass),
      // The sensor band round the roof edge, with the teal status line in it.
      box(1.6, 0.1, 3.3, 0, 1.48, 0.3, band),
      box(1.64, 0.04, 2.2, 0, 1.46, 0.55, status),
      box(1.2, 0.04, 0.04, 0, 0.585, -2.47, head),
      box(1.52, 0.04, 0.04, 0, 0.9, 2.47, tail),
    ];
    for (const [x, z] of [[-0.81, -1.52], [0.81, -1.52], [-0.81, 1.52], [0.81, 1.52]] as const) parts.push(box(0.22, 0.72, 0.72, x, 0.36, z, dark));
    return mergePacked(parts);
  }
  if (kind === "errandRobot") {
    const ceramic = surf(0xf3f1ec, 0.24);
    const bronze = surf(0x9a7b55, 0.35, 0.7);
    const face = surf(0xffe7c2, 0.4, 0, 3, 0xffd9a0);
    return mergePacked([
      box(0.12, 0.91, 0.14, -0.095, 0.455, 0, ceramic),
      box(0.12, 0.91, 0.14, 0.095, 0.455, 0, ceramic),
      taper(0.36, 0.55, 0.26, 1.1, 1.0, 0, 1.185, 0, ceramic),
      box(0.08, 0.62, 0.09, -0.24, 1.12, 0, ceramic),
      box(0.08, 0.62, 0.09, 0.24, 1.12, 0, ceramic),
      // The lantern head: barrel, cap and carrying ring, the face light a strip across the front.
      box(0.26, 0.34, 0.26, 0, 1.7, 0, ceramic),
      box(0.3, 0.04, 0.3, 0, 1.89, 0, bronze),
      box(0.08, 0.04, 0.02, 0, 1.93, 0, bronze),
      box(0.18, 0.03, 0.01, 0, 1.72, -0.135, face),
      // The grocery bag in the right hand.
      box(0.13, 0.28, 0.16, 0.25, 0.6, 0, surf(0xb98b58, 0.85)),
    ]);
  }
  return mergePacked([
    // Wheels, fender skirts and bumper band as one graphite block, down to the ground.
    box(0.62, 0.18, 0.75, 0, 0.09, 0, surf(0x2b2f35, 0.55, 0.2)),
    box(0.58, 0.3, 0.72, 0, 0.33, 0, surf(0xefe9df, 0.3)),
    // The sage roll-top lid, set back from the rounded front top.
    taper(0.56, 0.08, 0.6, 0.9, 0.85, 0, 0.52, 0.04, surf(0x9cb59a, 0.38)),
    // One soft light strip along the front lip under the lid.
    box(0.4, 0.03, 0.02, 0, 0.42, -0.365, surf(0xfff2d6, 0.3, 0, 3, 0xffe6b8)),
  ]);
}
