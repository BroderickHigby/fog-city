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
// Rigid agents and procedural people are instanced; the nearest skinned people use only the
// remaining calls within AGENT_DRAW_CALL_BUDGET, with procedural fallback for the rest.
// Until a kind's model has loaded (or if it never does), its agents draw as the box proxy.

import * as THREE from "three";
import { carAppearance, type CarAppearance } from "./car-appearance.ts";
import { TrafficLean } from "./body-motion.ts";
import { isCivilianTraffic } from "../sim/civilian-traffic.ts";
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
  robotFinish,
  triangleCount,
  type Channel,
  type PackedModel,
  type PackedSurface,
  type PartSpec,
} from "./agent-packing.ts";
import { channelIntensities } from "./lights.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { leapDrawOffset } from "./human-motion.ts";
import { HIP, SHOULDER, STRIDE_M, WALK_ARM, WALK_LEG, dodgePose, newLook, personLook, personParts, strideFor, type PersonLook, type PersonPose } from "./person.ts";
import { CROWD_NEAR_MAX, type CrowdHumans } from "./crowd-humans.ts";

/** Ambient agents' allocation within the design's 40-call total character budget. */
export const AGENT_DRAW_CALL_BUDGET = 27;

// ---------------------------------------------------------------- one instanced part

/** One InstancedMesh for one rig part, with its per-instance cue (and, for people, look) attributes. */
export class PartMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  readonly triangles: number;
  count = 0;
  private readonly cue: THREE.InstancedBufferAttribute;
  private readonly cols: THREE.InstancedBufferAttribute[];
  private readonly carPaint: THREE.InstancedBufferAttribute;
  private readonly carAccent: THREE.InstancedBufferAttribute;
  private readonly carMotion: THREE.InstancedBufferAttribute;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string, slots: boolean) {
    // Share the vertex data; the instanced attributes are this mesh's own.
    const g = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(geometry.attributes)) g.setAttribute(k, a);
    g.setIndex(geometry.index);
    this.capacity = capacity;
    this.triangles = triangleCount(geometry);
    this.cue = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.cue.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("fcCue", this.cue);
    this.carPaint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.carAccent = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.carMotion = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("fcCarPaint", this.carPaint); g.setAttribute("fcCarAccent", this.carAccent); g.setAttribute("fcCarMotion", this.carMotion);
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

  push(m: THREE.Matrix4, cue: Readonly<AgentCue> | null, look: Readonly<PersonLook> | null, car?: CarAppearance, wheel = 0, steer = 0): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const c = this.cue.array as Float32Array;
    c[i * 4] = cue ? cue.brake : 0;
    c[i * 4 + 1] = cue ? cue.flash : 0;
    c[i * 4 + 2] = cue?.rust ?? 0;
    c[i * 4 + 3] = cue?.wet ?? 0;
    if (look && this.cols.length === 4) {
      setRgb(this.cols[0]!, i, look.shirt);
      setRgb(this.cols[1]!, i, look.pants);
      setRgb(this.cols[2]!, i, look.skin);
      setRgb(this.cols[3]!, i, look.hair);
    }
    if (car) {
      this.carPaint.setXYZW(i, car.paint.r, car.paint.g, car.paint.b, car.style);
      this.carAccent.setXYZ(i, car.accent.r, car.accent.g, car.accent.b);
    }
    this.carMotion.setXY(i, wheel, steer);
    this.count = i + 1;
    return true;
  }

  end(): void {
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    flag(this.mesh.instanceMatrix, n * 16);
    flag(this.cue, n * 4);
    flag(this.carPaint, n * 4); flag(this.carAccent, n * 3); flag(this.carMotion, n * 2);
    for (const a of this.cols) flag(a, n * 3);
  }

  /** Share a coarser vehicle batch when the character draw budget is full. */
  transferInto(target: PartMesh): boolean {
    if(target.count+this.count>target.capacity) return false;
    const offset=target.count;
    (target.mesh.instanceMatrix.array as Float32Array).set((this.mesh.instanceMatrix.array as Float32Array).subarray(0,this.count*16),offset*16);
    for(const [source,dest] of [[this.cue,target.cue],[this.carPaint,target.carPaint],[this.carAccent,target.carAccent],[this.carMotion,target.carMotion]]) {
      (dest!.array as Float32Array).set((source!.array as Float32Array).subarray(0,this.count*source!.itemSize),offset*dest!.itemSize);
    }
    target.count+=this.count; this.count=0; return true;
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
/** A near vehicle's placement without its body lean: its wheels' parent. */
const _flat = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
/** The override's drawn offset (human-motion.ts leapDrawOffset). */
const _off = { x: 0, z: 0 };
const _one = new THREE.Vector3(1, 1, 1);

/** Agent placement: origin on the ground, rotation.y = -heading, nose-up pitch, uniform scale. */
function baseMatrix(x: number, y: number, z: number, heading: number, pitch: number, scale: number, out: THREE.Matrix4, roll = 0): THREE.Matrix4 {
  _e.set(pitch, -heading, -roll, "YXZ");
  _q.setFromEuler(_e);
  return out.compose(_p.set(x, y, z), _q, _s.setScalar(scale));
}

/** base x T(pivot) x Ry(ry) x Rx(rx) x Rz(rz). */
function partMatrix(base: THREE.Matrix4, px: number, py: number, pz: number, rx: number, ry: number, out: THREE.Matrix4, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz, "YXZ");
  _q.setFromEuler(_e);
  _local.compose(_p.set(px, py, pz), _q, _one);
  return out.multiplyMatrices(base, _local);
}

/**
 * A vehicle's placement with its drawn body lean (body-motion.ts TrafficLean) added to pitch and roll,
 * turned about the vehicle's origin on the road. A one-instance car or a far proxy tilts whole, wheels
 * included (as Slop New York's traffic does): at the caps an axle dips or floats by at most 4.7 cm. A
 * near model with its own wheel parts keeps its wheels flat instead (drawNear) and tilts only the body.
 */
function vehicleMatrix(pose: Readonly<AgentPose>, scale: number, out: THREE.Matrix4): THREE.Matrix4 {
  return baseMatrix(pose.x, pose.y, pose.z, pose.heading, pose.pitch + (pose.leanPitch ?? 0), scale, out, (pose.roll ?? 0) + (pose.leanRoll ?? 0));
}

// ---------------------------------------------------------------- people (agents and players)

/** A plain walk (person.ts dodgePose with no dodge, at walking speed). */
const WALK_POSE: Readonly<PersonPose> = { lean: 0, legGain: WALK_LEG, armGain: WALK_ARM, armOut: 0 };

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

  /**
   * One person: `swing` is sin(gait phase) times the gait amount (-1..1); `pose` (person.ts
   * dodgePose) leans the body and scales the swing for a run, a startle, a stumble (default: a walk).
   */
  add(x: number, y: number, z: number, heading: number, look: Readonly<PersonLook>, swing: number, pose: Readonly<PersonPose> = WALK_POSE, cue: Readonly<AgentCue> | null = null): void {
    if (this.body.count >= this.body.capacity) return;
    baseMatrix(x, y, z, heading, pose.lean, look.scale, _base);
    this.body.push(_base, cue, look);
    const leg = pose.legGain * swing;
    const arm = pose.armGain * swing;
    this.legs.push(partMatrix(_base, -HIP[0], HIP[1], HIP[2], leg, 0, _m), cue, look);
    this.legs.push(partMatrix(_base, HIP[0], HIP[1], HIP[2], -leg, 0, _m), cue, look);
    this.arms.push(partMatrix(_base, -SHOULDER[0], SHOULDER[1], SHOULDER[2], -arm, 0, _m, -pose.armOut), cue, look);
    this.arms.push(partMatrix(_base, SHOULDER[0], SHOULDER[1], SHOULDER[2], arm, 0, _m, pose.armOut), cue, look);
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

/** Mirrors and bumpers of the ordinary car fit entirely inside its shared traffic body. */
export function civilianModelScale(size: {width:number;length:number}): number {
  return Math.min(1,AGENT_SPEC.robotaxi.halfWidth*2/size.width,AGENT_SPEC.robotaxi.halfLength*2/size.length);
}

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
  /** Horizontal speed as drawn (smoothed over frames), m/s: what a person's gait and pose follow. */
  v: number;
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
  private readonly material = packedMaterial(false, true);
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
  private supportHeight: (x: number, y: number, z: number) => number = (_x, y) => y;

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
  private readonly humanCandidates: number[] = [];
  private readonly budgetGroups = new Set<number>();
  private readonly rigidCandidates: Array<{ kind: AgentKind | "civilian"; distance: number }> = [];
  private readonly nearPeople: number[] = [];
  /** Each near person's wetness (the combat look) by pose index, for the plain body when the crowd does not draw them. */
  private readonly nearPeopleWet = new Map<number, number>();
  private readonly personCue: AgentCue = { brake: 0, flash: 0, rust: 0, wet: 0, brakeUntil: 0 };
  private anims = new Map<number, Anim>();
  /** Per vehicle id: its body spring (near and mid tiers only; a far car is too small to show it). */
  private leans = new Map<number, TrafficLean>();
  private frameNo = 0;
  private readonly cue: AgentCue = { brake: 0, flash: 0, brakeUntil: 0 };
  /** Per agent id: render time until which its brake lights stay on (agentCue's hold). */
  private brakeUntil = new Map<number, number>();
  private readonly look = newLook();
  /**
   * Look-dev only (debug handle previewCombatLook): per agent id, a combat look drawn instead of
   * the decorated one. Never set in play; the sim never sees it.
   */
  private lookOverride: ReadonlyMap<number, VisualCombat & { height?: number }> | null = null;
  /** Rust-stained water pooled under each heap (the sim's puddle): a flat, glossy disc. */
  private readonly puddles: THREE.InstancedMesh;
  private puddleCount = 0;
  private readonly pose: PersonPose = { lean: 0, legGain: WALK_LEG, armGain: WALK_ARM, armOut: 0 };
  private civilianNear: PartMesh | null = null;
  private civilianFar: PartMesh | null = null;
  private civilianWheelRadius = 0.36;
  private civilianScale = 1;
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
    void registry.get("player-car").then(r => {
      if (this.disposed || r.source !== "file" || !r.model) return;
      const model = extractParts(r.model, AGENT_RIGS.robotaxi.filter(part => part.name !== "doorR"));
      const pieces: THREE.BufferGeometry[] = [];
      for (const part of model.parts) {
        if (!part.geometry) continue;
        const geometry = part.geometry.clone().translate(part.pivot.x,part.pivot.y,part.pivot.z);
        const wheels = geometry.getAttribute("fcWheel") as THREE.BufferAttribute;
        const code = part.channel.type === "steer-spin" ? 2 : part.channel.type === "spin" ? 1 : 0;
        for (let i=0;i<wheels.count;i++) wheels.setXYZW(i,part.pivot.x,part.pivot.y,part.pivot.z,code);
        pieces.push(geometry);
      }
      const geometry = mergePacked(pieces);
      this.civilianWheelRadius = model.wheelRadius;
      const size=model.bounds.getSize(new THREE.Vector3());
      this.civilianScale=civilianModelScale({width:size.x,length:size.z});
      this.civilianNear = this.adopt(new PartMesh(geometry,this.material,this.capNear,"agents:civilian:near",false));
      const reduced = proxyOf(model,0.20);
      this.civilianFar = this.adopt(new PartMesh(reduced,this.material,this.capFar,"agents:civilian:far",false));
      geometry.dispose(); reduced.dispose();
      for(const piece of pieces) piece.dispose();
      for(const part of model.parts) part.geometry?.dispose();
    });
    const disc = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const puddleMat = new THREE.MeshStandardMaterial({ color: 0x2b1a10, roughness: 0.06, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, name: "fc:heap-puddle" });
    this.puddles = new THREE.InstancedMesh(disc, puddleMat, PUDDLES_MAX);
    this.puddles.name = "agents:puddles";
    this.puddles.count = 0;
    this.puddles.frustumCulled = false;
    this.puddles.receiveShadow = shadows;
    this.puddles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.puddles);
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

  /** Every part mesh's instance capacity, by mesh name (tests check it against the budget rule). Puddles are not parts. */
  capacities(): Record<string, number> {
    const out: Record<string, number> = {};
    this.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && m !== this.puddles) out[m.name] = m.instanceMatrix.count;
    });
    return out;
  }

  /** After update(): the visible vehicle's interpolated, grounded frame and model bounds. */
  copyVehicleFrame(id: number, matrix: THREE.Matrix4, bounds: THREE.Box3): boolean {
    if (this.disposed || id === this.hiddenAgent) return false;
    for (let i = 0; i < this.pairs.length; i++) {
      const actor = this.pairs[i]![1];
      if (actor.id !== id) continue;
      const tier = this.tiers[i]!;
      if (actor.kind !== "robotaxi" || tier === TIER_HIDDEN) return false;
      const pose = this.poses[i]!;
      if (isCivilianTraffic(actor) && this.civilianNear && this.civilianFar) {
        const part = tier === TIER_NEAR && this.civilianNear.count ? this.civilianNear : this.civilianFar;
        if (!part.mesh.geometry.boundingBox) part.mesh.geometry.computeBoundingBox();
        bounds.copy(part.mesh.geometry.boundingBox!);
        vehicleMatrix(pose, this.civilianScale, matrix);
      } else {
        const view = this.kinds.get("robotaxi")!;
        if (tier === TIER_NEAR && view.source === "file") bounds.copy(view.model!.bodyBounds);
        else {
          const geometry = (tier === TIER_FAR ? view.far : view.mid).mesh.geometry;
          if (!geometry.boundingBox) geometry.computeBoundingBox();
          bounds.copy(geometry.boundingBox!);
        }
        vehicleMatrix(pose, view.scale, matrix);
        const override = this.lookOverride?.get(actor.id);
        collapse(matrix, actor, override ?? visualCombat(actor), override?.height ?? visualHeight(actor));
      }
      return !bounds.isEmpty();
    }
    return false;
  }

  private install(view: KindView, model: PackedModel): void {
    const size = model.bodyBounds.isEmpty() ? model.bounds : model.bodyBounds;
    view.scale = agentModelScale(view.kind, { length: size.max.z - size.min.z, width: size.max.x - size.min.x });
    view.model = model;
    // Robots: the near model and its proxy share one finish that reads the same up close.
    if (view.kind === "errandRobot" || view.kind === "sidewalkBot") robotFinish(model);
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

  private hiddenAgent: number | null = null;

  /** Hide only the occupied taxi while looking from its driver's seat. */
  setHiddenAgent(id: number | null): void { this.hiddenAgent = id; }

  /**
   * Render-only: errand robots' bags full (true), empty (false), or as each agent says (null,
   * the default; the sim carries no bag tell yet, so full).
   */
  setBags(full: boolean | null): void {
    this.bags = full;
  }

  /** Look-dev only: draw these agents with these combat looks (null: as the sim says). */
  setCombatLookOverride(looks: ReadonlyMap<number, VisualCombat & { height?: number }> | null): void {
    this.lookOverride = looks;
  }

  /**
   * The robots of the last frame nearest (x, z), nearest first (look-dev): walking robots before
   * road vehicles (a robotaxi is disabled, never toppled, by the sim).
   */
  nearestRobots(x: number, z: number, n: number): number[] {
    const out: Array<{ id: number; d: number }> = [];
    for (const [, b] of this.pairs) {
      if (b.kind === "person") continue;
      out.push({ id: b.id, d: Math.hypot(b.x - x, b.z - z) + (AGENT_SPEC[b.kind].road ? 1e6 : 0) });
    }
    return out.sort((p, q) => p.d - q.d).slice(0, n).map((p) => p.id);
  }

  /** Scale the light channels for night (0 day .. 1 night). */
  private crowd: CrowdHumans | null = null;

  /** Draw the nearest people with the skinned crowd (null: the procedural rig only). */
  setCrowd(crowd: CrowdHumans | null): void {
    this.crowd = crowd;
  }

  /** Match ambient bodies to the same loaded street surfaces as the player's avatar. */
  setSupportHeight(height: (x: number, y: number, z: number) => number): void {
    this.supportHeight = height;
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
      // The override moved this body at once: drawn as a shove aside from where it was (human-motion.ts).
      if (b.dodge && b.dodge.leap && b.dodge.phase === "dive") {
        leapDrawOffset(b.dodge, alpha, _off);
        p.x = b.x + _off.x;
        p.y = b.y;
        p.z = b.z + _off.z;
      }
      p.y = this.supportHeight(p.x, p.y, p.z);
      p.leanPitch = 0;
      p.leanRoll = 0;
      this.ids[i] = b.id;
      this.xs[i] = p.x;
      this.zs[i] = p.z;
    }
    selectTiers(n, this.ids, this.xs, this.zs, viewer, this.wasNear, this.opts, this.tiers, this.scratch);
    this.planHumanAdmission(viewer);
    this.wasNear.clear();

    for (const v of this.kinds.values()) {
      v.mid.begin();
      v.far.begin();
      for (const p of v.near) p.part.begin();
    }
    this.civilianNear?.begin(); this.civilianFar?.begin();
    this.people.begin();
    this.peopleMid.begin();
    this.peopleFar.begin();
    this.puddleCount = 0;
    this.nearPeople.length = 0;
    this.nearPeopleWet.clear();
    let drawn = 0;
    let near = 0;
    for (let i = 0; i < n; i++) {
      const tier = this.tiers[i]!;
      if (tier === TIER_HIDDEN) continue;
      const [a, b] = pairs[i]!;
      if (b.id === this.hiddenAgent) continue;
      const pose = this.poses[i]!;
      if (b.kind === "robotaxi") this.lean(b, pose, tier, dt);
      const held = this.brakeUntil.get(b.id) ?? -Infinity;
      const moved = a ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
      const cue = agentCue(b.kind, b.mode, a ? a.speed : b.speed, b.speed, moved, time, held, this.cue);
      if((b as AgentState&{visualFlash?:boolean}).visualFlash)cue.flash=Math.sin(time*9)>0?1:0;
      const override = this.lookOverride?.get(b.id);
      const combat = override ?? visualCombat(b);
      const height = override?.height ?? visualHeight(b);
      cue.rust = combat.rust;
      cue.wet = combat.wet;
      if (cue.brakeUntil > held) this.brakeUntil.set(b.id, cue.brakeUntil);
      drawn++;
      if (b.kind === "person") {
        personLook(b.id, this.look);
        if (tier === TIER_NEAR) {
          this.wasNear.add(b.id);
          near++;
          this.nearPeople.push(i);
          this.nearPeopleWet.set(i, combat.wet);
        } else {
          baseMatrix(pose.x, pose.y, pose.z, pose.heading, 0, this.look.scale, _base);
          (tier === TIER_MID ? this.peopleMid : this.peopleFar).push(_base, cue, this.look);
        }
        continue;
      }
      if (isCivilianTraffic(b) && this.civilianNear && this.civilianFar) {
        const anim = this.anim(b.id,pose,dt,this.civilianWheelRadius*this.civilianScale,2.7*this.civilianScale,10);
        vehicleMatrix(pose,this.civilianScale,_base);
        const part = tier === TIER_NEAR ? this.civilianNear : this.civilianFar;
        part.push(_base,cue,null,carAppearance(Math.floor(b.id/8)),anim.wheel,-anim.steer);
        if(tier === TIER_NEAR) { near++; this.wasNear.add(b.id); }
        continue;
      }
      const view = this.kinds.get(b.kind)!;
      if (combat.topple >= 1 && height > 0.05 && this.puddleCount < PUDDLES_MAX) {
        const r = AGENT_SPEC[b.kind].radius * 1.8;
        _m.compose(_p.set(pose.x, pose.y + 0.03, pose.z), _q.identity(), _s.set(r, 1, r * 0.8));
        this.puddles.setMatrixAt(this.puddleCount++, _m);
      }
      if (tier === TIER_NEAR && view.source === "file") {
        this.wasNear.add(b.id);
        near++;
        this.drawNear(view, b, pose, cue, dt);
      } else {
        vehicleMatrix(pose, view.scale, _base);
        collapse(_base, b, combat, height);
        (tier === TIER_FAR ? view.far : view.mid).push(_base, cue, null, b.kind === "robotaxi" ? carAppearance(b.id,true) : undefined);
      }
    }
    // First account for the instanced tiers. Reserve the procedural rig's three calls whenever
    // any near person cannot fit as a skinned body, so overflow never disappears or exceeds the
    // allocation. Hand the remaining calls to the nearest people, independently of agent ids.
    let fixedCalls = Number(this.peopleMid.count > 0) + Number(this.peopleFar.count > 0) + Number((this.civilianNear?.count ?? 0)>0) + Number((this.civilianFar?.count ?? 0)>0) + Number(this.puddleCount>0);
    for (const v of this.kinds.values()) {
      fixedCalls += Number(v.mid.count > 0) + Number(v.far.count > 0);
      for (const p of v.near) fixedCalls += Number(p.part.count > 0);
    }
    if(fixedCalls > AGENT_DRAW_CALL_BUDGET-(this.nearPeople.length?3:0) && this.civilianNear?.count && this.civilianFar?.count) {
      if(this.civilianNear.transferInto(this.civilianFar)) fixedCalls--;
    }
    const remaining = Math.max(0, AGENT_DRAW_CALL_BUDGET - fixedCalls);
    this.nearPeople.sort((a, b) => {
      const pa = this.poses[a]!, pb = this.poses[b]!;
      return (pa.x - viewer.x) ** 2 + (pa.z - viewer.z) ** 2 - (pb.x - viewer.x) ** 2 - (pb.z - viewer.z) ** 2 || this.ids[a]! - this.ids[b]!;
    });
    let allCost = this.crowd && this.nearPeople.length <= CROWD_NEAR_MAX ? 0 : Infinity;
    for (const i of this.nearPeople) allCost += this.crowd?.costFor(this.ids[i]!)?.drawCalls ?? Infinity;
    const reserveFallback = this.nearPeople.length > 0 && allCost > remaining ? 3 : 0;
    this.crowd?.begin(dt, Math.max(0, remaining - reserveFallback));
    for (const i of this.nearPeople) {
      const b = pairs[i]![1], pose = this.poses[i]!;
      // (Its drawn speed: a dodging person moves whichever way it goes, a sidestep sideways.)
      const anim = this.anim(b.id, pose, dt, 0.35, 2.7, 1.3, true);
      if (this.crowd?.add(b.id, pose.x, pose.y, pose.z, pose.heading, b.dodge ? anim.v : b.speed, dt, b.dodge)) continue;
      personLook(b.id, this.look);
      this.personCue.wet = this.nearPeopleWet.get(i) ?? 0;
      this.people.add(pose.x, pose.y, pose.z, pose.heading, this.look, Math.sin(anim.gait) * anim.amount, dodgePose(b.dodge, anim.v, this.pose), this.personCue);
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
    if(this.civilianNear) tally(this.civilianNear); if(this.civilianFar) tally(this.civilianFar);
    this.puddles.count = this.puddleCount;
    if (this.puddleCount > 0) {
      this.puddles.instanceMatrix.needsUpdate = true;
      calls++;
      tris += this.puddleCount * 20;
    }
    this.people.end();
    this.crowd?.end();
    calls += this.crowd?.drawCalls ?? 0;
    tris += this.crowd?.triangles ?? 0;
    for (const m of [this.people.body, this.people.arms, this.people.legs]) if (m.count > 0) tris += m.count * m.triangles;
    calls += this.people.drawCalls;
    tally(this.peopleMid);
    tally(this.peopleFar);

    if (this.frameNo % 120 === 0) {
      for (const [id, an] of this.anims) if (this.frameNo - an.seen > 120) this.anims.delete(id);
      for (const [id, l] of this.leans) if (this.frameNo - l.seen > 120) this.leans.delete(id);
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

  /**
   * Preserve loaded human identity independently of traffic's near slots. Reserve the real
   * compact avatar cost before rigid detail; a robot may use its existing mid/far model to
   * make room, rather than replacing a nearby person's face and clothes with a box rig.
   */
  private planHumanAdmission(viewer: Readonly<Viewer>): void {
    if (!this.crowd) return;
    const candidates = this.humanCandidates; candidates.length = 0;
    for (let i = 0; i < this.pairs.length; i++) {
      const actor = this.pairs[i]![1];
      if (actor.kind !== "person" || this.tiers[i] === TIER_HIDDEN) continue;
      const p = this.poses[i]!, dx = p.x - viewer.x, dz = p.z - viewer.z;
      const range = this.opts.nearRange + (this.wasNear.has(actor.id) ? this.opts.hysteresis : 0);
      if (dx * dx + dz * dz <= range * range && dx * viewer.fx + dz * viewer.fz >= -this.opts.behind) candidates.push(i);
      // A person's near allocation is separate from the rigid actor allocation.
      if (this.tiers[i] === TIER_NEAR) this.tiers[i] = TIER_MID;
    }
    if (candidates.length === 0) return;
    const distance = (i: number): number => (this.poses[i]!.x - viewer.x) ** 2 + (this.poses[i]!.z - viewer.z) ** 2;
    candidates.sort((a, b) => distance(a) - distance(b) || this.ids[a]! - this.ids[b]!);
    for (let k = 0; k < Math.min(candidates.length, this.capNear, CROWD_NEAR_MAX); k++) this.tiers[candidates[k]!] = TIER_NEAR;

    const cost = (): number => {
      const groups = this.budgetGroups; groups.clear(); let people = 0;
      for (let i = 0; i < this.pairs.length; i++) {
        const actor = this.pairs[i]![1], tier = this.tiers[i]!;
        if (tier === TIER_HIDDEN || actor.id === this.hiddenAgent) continue;
        if (actor.kind === "person") {
          if (tier === TIER_NEAR) {
            const loaded = this.crowd!.costFor(actor.id);
            if (loaded) people += loaded.drawCalls; else groups.add(3);
          } else groups.add(tier === TIER_MID ? 1 : 2);
          continue;
        }
        if (isCivilianTraffic(actor) && this.civilianNear && this.civilianFar) {
          groups.add(tier === TIER_NEAR ? 5 : 6); continue;
        }
        const view = this.kinds.get(actor.kind)!;
        const group = actor.kind === "robotaxi" ? 32 : actor.kind === "errandRobot" ? 64 : 96;
        if (tier === TIER_NEAR && view.source === "file") {
          for (let k = 0; k < view.near.length; k++) if (view.near[k]!.part.triangles > 0) groups.add(group + k);
        } else groups.add(group + (tier === TIER_FAR ? 17 : 16));
        const combat = this.lookOverride?.get(actor.id) ?? visualCombat(actor);
        if (combat.topple >= 1 && (this.lookOverride?.get(actor.id)?.height ?? visualHeight(actor)) > .05) groups.add(4);
      }
      return people + groups.size + (groups.has(3) ? 2 : 0);
    };
    if (cost() <= AGENT_DRAW_CALL_BUDGET) return;
    const kinds = this.rigidCandidates; kinds.length = 0;
    for (const kind of ["robotaxi", "errandRobot", "sidewalkBot", "civilian"] as const) {
      let nearest = Infinity;
      for (let i = 0; i < this.pairs.length; i++) {
        const actor = this.pairs[i]![1];
        if (this.tiers[i] === TIER_HIDDEN || actor.kind === "person") continue;
        const family = isCivilianTraffic(actor) && this.civilianNear && this.civilianFar ? "civilian" : actor.kind;
        if (family === kind) nearest = Math.min(nearest, distance(i));
      }
      if (nearest < Infinity) kinds.push({ kind, distance: nearest });
    }
    kinds.sort((a, b) => b.distance - a.distance || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    // First trim articulated parts; only then consolidate distant proxies when necessary.
    for (const [from, to] of [[TIER_NEAR, TIER_MID], [TIER_MID, TIER_FAR]] as const) {
      for (const candidate of kinds) {
        for (let i = 0; i < this.pairs.length; i++) {
          const actor = this.pairs[i]![1];
          if (actor.kind === "person" || this.tiers[i] !== from) continue;
          const family = isCivilianTraffic(actor) && this.civilianNear && this.civilianFar ? "civilian" : actor.kind;
          if (family === candidate.kind) this.tiers[i] = to;
        }
        if (cost() <= AGENT_DRAW_CALL_BUDGET) return;
      }
    }
  }

  /**
   * Set this vehicle's drawn lean (pose.leanPitch/leanRoll) from its drawn speed and heading: the
   * body-motion.ts spring, stepped for near and mid vehicles only. A manually driven taxi has its own
   * suspension (pose.roll); a vehicle that was out of sight starts level.
   */
  private lean(b: Readonly<AgentState>, pose: AgentPose, tier: number, dt: number): void {
    if (tier < TIER_MID || pose.roll !== undefined) return;
    let l = this.leans.get(b.id);
    if (!l) this.leans.set(b.id, l = new TrafficLean());
    else if (this.frameNo - l.seen > 2) l.reset();
    l.seen = this.frameNo;
    l.update(dt, pose.speed, pose.heading);
    pose.leanPitch = l.spring.pitch.x;
    pose.leanRoll = l.spring.roll.x;
  }

  /**
   * The animation state of a near agent, advanced to this frame's pose. A person (`person`) steps
   * by the distance it is drawn to move whichever way it goes (a sidestep swings its legs too),
   * with longer steps the faster it goes (strideFor), so its feet never slide.
   */
  private anim(id: number, pose: AgentPose, dt: number, wheelRadius = 0.35, wheelbase = 2.7, cruise = 1.3, person = false): Anim {
    let an = this.anims.get(id);
    const fresh = !an || this.frameNo - an.seen > 2;
    if (!an) {
      an = { wheel: 0, steer: 0, gait: (id * 1.7) % (Math.PI * 2), amount: 0, x: pose.x, z: pose.z, heading: pose.heading, seen: 0, v: 0 };
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
    if (dt > 0) an.v += (Math.abs(dist) / dt - an.v) * Math.min(1, dt * 12);
    an.gait = advanceGait(an.gait, dist, person ? strideFor(an.v) : STRIDE_M);
    const want = gaitAmount(person ? an.v : pose.speed, cruise);
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
    // The body takes the lean; the wheels (their own parts) stay flat on the road under it.
    vehicleMatrix(pose, view.scale, _base);
    const leaning = (pose.leanPitch ?? 0) !== 0 || (pose.leanRoll ?? 0) !== 0;
    if (leaning) baseMatrix(pose.x, pose.y, pose.z, pose.heading, pose.pitch, view.scale, _flat, pose.roll);
    const override = this.lookOverride?.get(b.id);
    const combat = override ?? visualCombat(b), height = override?.height ?? visualHeight(b);
    collapse(_base, b, combat, height);
    if (leaning) collapse(_flat, b, combat, height);
    // A seized robot's limbs and wheels stop where they are.
    const swing = cue.rust && cue.rust >= 1 ? 0 : Math.sin(anim.gait) * anim.amount * ROBOT_SWING;
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
          ry = -(pose.steer ?? anim.steer);
          break;
        case "swing":
          rx = p.channel.gain * swing;
          break;
        case "slide": // shut: no door state in the sim yet
        case "none":
          break;
      }
      const wheel = p.channel.type === "spin" || p.channel.type === "steer-spin";
      p.part.push(partMatrix(wheel && leaning ? _flat : _base, p.pivot.x, p.pivot.y, p.pivot.z, rx, ry, _m), cue, null, b.kind === "robotaxi" ? carAppearance(b.id,true) : undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const v of this.kinds.values()) {
      v.mid.dispose();
      v.far.dispose();
      for (const p of v.near) p.part.dispose();
    }
    this.civilianNear?.dispose(); this.civilianFar?.dispose();
    this.puddles.geometry.dispose();
    (this.puddles.material as THREE.Material).dispose();
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

/**
 * The combat presentation an agent carries (render-only; runtime-actors.ts decorates it from the
 * sim's combat targets): rust 0..1, wetness 0..1, and how far it has toppled (0 standing, 1 lying
 * on its side, as a heap). Undecorated agents: none of it.
 */
export interface VisualCombat {
  rust: number;
  wet: number;
  topple: number;
}
const _combat: VisualCombat = { rust: 0, wet: 0, topple: 0 };
export function visualCombat(a: Readonly<AgentState>): VisualCombat {
  const v = a as AgentState & { visualRust?: number; visualWet?: number; visualTopple?: number };
  const f = (x: number | undefined): number => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
  _combat.rust = f(v.visualRust);
  _combat.wet = f(v.visualWet);
  _combat.topple = f(v.visualTopple);
  return _combat;
}

/** Heaps drawn with a puddle under them at once. */
export const PUDDLES_MAX = 64;

/** Most a collapsing robot tips over (radians): onto its side, short of upside down. */
export const TOPPLE_RAD = 1.35;
const _rz = new THREE.Matrix4();

/**
 * The slump: a seized robot tips sideways (left or right by its id) about its foot as it sinks,
 * ending on its side as a heap. The sim's height scale squashes the tipped body along the
 * vertical, so its width cannot stand taller than the heap. Applied after the placement matrix.
 */
export function collapse(base: THREE.Matrix4, a: Readonly<Pick<AgentState, "id">>, c: Readonly<VisualCombat>, height: number): void {
  base.scale(_s.set(1, height, 1));
  if (c.topple > 0) base.multiply(_rz.makeRotationZ((a.id % 2 === 0 ? 1 : -1) * TOPPLE_RAD * c.topple * c.topple * (3 - 2 * c.topple)));
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
    const white = { ...surf(0xeceee9, 0.3, 0.05), paint: 1 };
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
