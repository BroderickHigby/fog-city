// Fog City Planner: the US-101 / Lombard St demo in the 3D city (?mode=planner).
// The game's simulation does not run here: the renderer draws the city, and this module draws the
// corridor model's cars, signal lamps and a congestion ribbon over it, with a panel to switch
// signal plans and traffic levels and a scorecard computed from the same model.
import * as THREE from "three";
import { NO_FLY_INPUT } from "../render/cameras.ts";
import type { SceneRenderer } from "../render/scene.ts";
import { buildCorridor, pointAt, type Corridor, type RoadsFile, type SignalsFile } from "./corridor.ts";
import type { Period } from "./demand.ts";
import { mountPlannerPanel, type PanelState, type ScoreRow } from "./panel.ts";
import { DEMAND_IDS, PLAN_IDS, averageRuns, demandFor, planFor, type DemandId, type PlanId } from "./scenarios.ts";
import { CorridorSim, IDM, STOP_BACK_M, type Car } from "./traffic.ts";
import type { Aspect } from "./signals.ts";

export interface PlannerHost {
  view: SceneRenderer;
  container: HTMLElement;
  roads: RoadsFile;
  signals: SignalsFile;
  ground: (x: number, z: number) => number;
  params: URLSearchParams;
  /** Wait for the first streets to load, then reveal the page (main.ts's loading screen). */
  prepare: (render: () => void) => Promise<void>;
  reveal: () => void;
}

const MAX_CARS = 900;
const LANE_W = 3.3;
const MEDIAN = 1.2;
const RIBBON_STEP = 20;
const SPEEDS = [1, 4, 10] as const;
const CAMERAS = ["tour", "overview", "street", "follow"] as const;
export type CameraId = (typeof CAMERAS)[number];

interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; fovDegrees: number }

const speedColor = (v: number, out: THREE.Color): THREE.Color => {
  const f = Math.max(0, Math.min(1, v / IDM.v0));
  // Stopped red, crawling amber, flowing green.
  return f < 0.5 ? out.setRGB(0.95, 0.18 + f * 1.3, 0.12) : out.setRGB(0.95 - (f - 0.5) * 1.5, 0.83, 0.25 + (f - 0.5) * 0.3);
};
const ASPECT_COLOR: Record<Aspect, THREE.Color> = { green: new THREE.Color(0.2, 1, 0.45), yellow: new THREE.Color(1, 0.8, 0.15), red: new THREE.Color(1, 0.15, 0.12) };

function lookPose(from: THREE.Vector3, at: THREE.Vector3, fovDegrees = 50): Pose {
  const d = at.clone().sub(from), flat = Math.hypot(d.x, d.z);
  return { x: from.x, y: from.y, z: from.z, yaw: Math.atan2(d.x, -d.z), pitch: Math.atan2(d.y, flat), fovDegrees };
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const k = t * t * (3 - 2 * t);
  let dy = b.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dy * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k, fovDegrees: a.fovDegrees + (b.fovDegrees - a.fovDegrees) * k };
}

export class PlannerScene {
  readonly group = new THREE.Group();
  private readonly corridor: Corridor;
  private readonly ground: (x: number, z: number) => number;
  private readonly bodies: THREE.InstancedMesh;
  private readonly cabins: THREE.InstancedMesh;
  private readonly lamps: THREE.InstancedMesh;
  private readonly ribbon: THREE.InstancedMesh;
  private readonly ribbonSpeed: [Float32Array, Float32Array];
  private readonly lampSlots: { idx: number; dir: 0 | 1 }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly col = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(corridor: Corridor, ground: (x: number, z: number) => number) {
    this.corridor = corridor; this.ground = ground;
    this.group.name = "planner";
    const unlit = (opts: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial => {
      const m = new THREE.MeshBasicMaterial(opts); m.userData.skipGpuAdapter = true; m.fog = false; return m;
    };
    const lit = new THREE.MeshLambertMaterial({ color: 0xffffff }); lit.userData.skipGpuAdapter = true;
    this.bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1.85, 0.8, 4.5).translate(0, 0.62, 0), lit, MAX_CARS);
    const cabinMat = new THREE.MeshLambertMaterial({ color: 0x1d2733 }); cabinMat.userData.skipGpuAdapter = true;
    this.cabins = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.62, 2.3).translate(0, 1.33, 0.2), cabinMat, MAX_CARS);
    for (const mesh of [this.bodies, this.cabins]) { mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3).fill(1), 3);
    this.bodies.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // A glowing lamp over each stop line, one per direction a signal controls.
    const n = corridor.signals.length;
    for (let i = 1; i < n; i++) this.lampSlots.push({ idx: i, dir: 0 });
    for (let i = 0; i < n; i++) this.lampSlots.push({ idx: i, dir: 1 });
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 16, 10), unlit({ color: 0xffffff }), this.lampSlots.length);
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.lampSlots.length * 3).fill(1), 3);
    this.lamps.frustumCulled = false;
    this.lampSlots.forEach((slot, k) => {
      const at = slot.dir === 0 ? corridor.signals[slot.idx]!.s - STOP_BACK_M : corridor.signals[slot.idx]!.s + STOP_BACK_M;
      const pose = this.place(at, slot.dir, corridor.lanesPerDirection + 0.6);
      this.p.set(pose.x, pose.y + 6.2, pose.z);
      this.m.compose(this.p, this.q.identity(), this.sc.set(1, 1, 1));
      this.lamps.setMatrixAt(k, this.m);
    });
    // Congestion ribbon: a strip under each direction's lanes, coloured by recent speed.
    const segs = Math.ceil(corridor.length / RIBBON_STEP);
    this.ribbonSpeed = [new Float32Array(segs).fill(IDM.v0), new Float32Array(segs).fill(IDM.v0)];
    const ribbonMat = unlit({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
    this.ribbon = new THREE.InstancedMesh(new THREE.PlaneGeometry(LANE_W * corridor.lanesPerDirection, RIBBON_STEP * 1.02).rotateX(-Math.PI / 2), ribbonMat, segs * 2);
    this.ribbon.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(segs * 2 * 3).fill(1), 3);
    this.ribbon.frustumCulled = false; this.ribbon.renderOrder = 2;
    for (const dir of [0, 1] as const) {
      for (let k = 0; k < segs; k++) {
        const s = Math.min(corridor.length, (k + 0.5) * RIBBON_STEP);
        const pose = this.place(dir === 0 ? s : corridor.length - s, dir, (corridor.lanesPerDirection - 1) / 2);
        this.q.setFromAxisAngle(this.up, -pose.heading);
        this.p.set(pose.x, pose.y + 0.18, pose.z);
        this.m.compose(this.p, this.q, this.sc.set(1, 1, 1));
        this.ribbon.setMatrixAt(dir * segs + k, this.m);
      }
    }
    this.group.add(this.ribbon, this.bodies, this.cabins, this.lamps);
  }

  /** World pose of a point `s` along direction `dir`, in lane `lane` (0 = next to the median). */
  place(s: number, dir: 0 | 1, lane: number): { x: number; y: number; z: number; heading: number } {
    const along = dir === 0 ? s : this.corridor.length - s;
    const c = pointAt(this.corridor, along);
    const heading = dir === 0 ? c.heading : c.heading + Math.PI;
    const off = MEDIAN + (lane + 0.5) * LANE_W;
    const x = c.x + Math.cos(heading) * off, z = c.z + Math.sin(heading) * off;
    return { x, y: this.ground(x, z), z, heading };
  }

  update(cars: readonly Car[], main: readonly Aspect[], dt: number): void {
    let k = 0;
    const segs = this.ribbonSpeed[0].length;
    const sum = [new Float32Array(segs), new Float32Array(segs)], cnt = [new Uint16Array(segs), new Uint16Array(segs)];
    for (const c of cars) {
      if (k >= MAX_CARS) break;
      const pose = this.place(c.s, c.dir, c.lane);
      this.q.setFromAxisAngle(this.up, -pose.heading);
      this.p.set(pose.x, pose.y, pose.z);
      this.m.compose(this.p, this.q, this.sc.set(1, 1, 1));
      this.bodies.setMatrixAt(k, this.m); this.cabins.setMatrixAt(k, this.m);
      this.bodies.setColorAt(k, speedColor(c.v, this.col));
      const seg = Math.min(segs - 1, Math.max(0, Math.floor(c.s / RIBBON_STEP)));
      const sd = sum[c.dir]!, cd = cnt[c.dir]!;
      sd[seg] = sd[seg]! + c.v; cd[seg] = cd[seg]! + 1;
      k++;
    }
    this.bodies.count = k; this.cabins.count = k;
    this.bodies.instanceMatrix.needsUpdate = true; this.cabins.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    const blend = Math.min(1, dt / 6);
    for (const dir of [0, 1] as const) {
      for (let i = 0; i < segs; i++) {
        const target = cnt[dir]![i]! ? sum[dir]![i]! / cnt[dir]![i]! : IDM.v0;
        this.ribbonSpeed[dir][i] = this.ribbonSpeed[dir][i]! + (target - this.ribbonSpeed[dir][i]!) * blend;
        this.ribbon.setColorAt(dir * segs + i, speedColor(this.ribbonSpeed[dir][i]!, this.col));
      }
    }
    if (this.ribbon.instanceColor) this.ribbon.instanceColor.needsUpdate = true;
    this.lampSlots.forEach((slot, j) => this.lamps.setColorAt(j, ASPECT_COLOR[main[slot.idx]!]));
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.cabins, this.lamps, this.ribbon]) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
    this.group.removeFromParent();
  }
}

/** Camera poses over the corridor. */
export function cameraPoses(c: Corridor, ground: (x: number, z: number) => number): Record<Exclude<CameraId, "tour" | "follow">, Pose> & { bridge: Pose; vanNess: Pose } {
  const mid = pointAt(c, c.length * 0.5), gy = ground(mid.x, mid.z);
  const target = new THREE.Vector3(mid.x, gy, mid.z);
  const fillmore = c.signals.find((s) => s.street.startsWith("Fillmore")) ?? c.signals[6]!;
  const west = pointAt(c, c.length * 0.92), east = pointAt(c, c.length * 0.05);
  return {
    // From above Pacific Heights, looking north over the corridor to the Bay.
    overview: lookPose(new THREE.Vector3(mid.x + 260, gy + 340, mid.z + 720), target, 52),
    // Street level at Fillmore, looking west toward the bridge.
    street: lookPose(new THREE.Vector3(fillmore.x + 70, ground(fillmore.x, fillmore.z) + 14, fillmore.z + 26), new THREE.Vector3(fillmore.x - 180, ground(fillmore.x, fillmore.z) + 2, fillmore.z - 30), 55),
    bridge: lookPose(new THREE.Vector3(west.x + 120, ground(west.x, west.z) + 110, west.z + 160), new THREE.Vector3(west.x - 260, ground(west.x, west.z), west.z - 80), 50),
    vanNess: lookPose(new THREE.Vector3(east.x + 150, ground(east.x, east.z) + 90, east.z + 140), new THREE.Vector3(east.x - 120, ground(east.x, east.z), east.z - 20), 52),
  };
}

export interface PlannerHandle {
  ready: boolean;
  corridor: Corridor;
  state(): PanelState & { cars: number; simTime: number; camera: CameraId };
  select(change: Partial<{ plan: PlanId; demand: DemandId; period: Period; speed: number; camera: CameraId }>): void;
  scores(): readonly ScoreRow[];
}

export async function runPlanner(host: PlannerHost): Promise<PlannerHandle> {
  const { view, container, ground, params } = host;
  const corridor = buildCorridor(host.roads, host.signals);
  const scene = new PlannerScene(corridor, ground);
  view.scene.add(scene.group);
  const poses = cameraPoses(corridor, ground);
  const pick = <T extends string>(v: string | null, all: readonly T[], d: T): T => all.includes(v as T) ? v as T : d;
  const state: PanelState & { camera: CameraId } = {
    period: pick(params.get("period"), ["pm", "am"] as const, "pm"),
    demand: pick(params.get("traffic"), DEMAND_IDS, "now"),
    plan: pick(params.get("plan"), PLAN_IDS, "today"),
    speed: SPEEDS.includes(Number(params.get("speed")) as 1) ? Number(params.get("speed")) : 4,
    camera: pick(params.get("camera"), CAMERAS, "tour"),
  };
  let sim!: CorridorSim;
  let follow: number | null = null;
  const scoreCache = new Map<string, ScoreRow[]>();
  const restart = (): void => {
    const d = demandFor(corridor, state.demand, state.period);
    sim = new CorridorSim(corridor, d, planFor(corridor, state.plan, state.period, d), { seed: 11, warmupS: 0, durationS: 1e9 });
    // Start from a road that already has traffic on it.
    for (let t = 0; t < 240; t += sim.dt) sim.step();
    follow = null;
  };
  const scores = (): ScoreRow[] => {
    const key = `${state.period}:${state.demand}`;
    let rows = scoreCache.get(key);
    if (!rows) {
      const d = demandFor(corridor, state.demand, state.period);
      rows = PLAN_IDS.map((id) => {
        const m = averageRuns(corridor, d, planFor(corridor, id, state.period, d), [2, 3], { durationS: 1800 });
        return { plan: id, travelTimeS: m.travelTimeS, stopsPerCar: m.stopsPerCar, lostHours: m.delayHoursPerHour.main + m.delayHoursPerHour.cross,
          crossHours: m.delayHoursPerHour.cross, co2KgPerHour: m.co2KgPerHour.total, toBridgePerHour: m.exitsPerHour[0] };
      });
      scoreCache.set(key, rows);
    }
    return rows;
  };
  restart();
  const panel = mountPlannerPanel(document, container, {
    corridor, state,
    onChange: (change) => {
      const before = { ...state };
      Object.assign(state, change);
      if (change.camera) tourT = 0;
      if (before.plan !== state.plan || before.demand !== state.demand || before.period !== state.period) restart();
      if (before.demand !== state.demand || before.period !== state.period) refreshScores();
      panel.update(state, sim.snapshot());
    },
  });
  const refreshScores = (): void => {
    panel.setScores(null);
    setTimeout(() => panel.setScores(scores()), 30);
  };

  // Camera: fixed views, a car to ride with, or the tour that visits each in turn.
  const tour: Pose[] = [poses.overview, poses.vanNess, poses.street, poses.bridge];
  let tourT = 0;
  const followPose = (): Pose | null => {
    const cars = sim.snapshot().cars;
    let car = follow === null ? undefined : cars.find((c) => c.id === follow);
    if (!car) {
      car = cars.filter((c) => c.dir === (state.period === "pm" ? 0 : 1) && c.fromEnd && c.exitAt < 0 && c.s < 200).sort((a, b) => b.s - a.s)[0];
      follow = car?.id ?? null;
    }
    if (!car) return null;
    const p = scene.place(car.s, car.dir, car.lane), back = scene.place(Math.max(0, car.s - 28), car.dir, car.lane);
    return lookPose(new THREE.Vector3(back.x, back.y + 9, back.z), new THREE.Vector3(p.x, p.y + 1.5, p.z), 58);
  };
  const currentPose = (dt: number): Pose => {
    if (state.camera === "overview") return poses.overview;
    if (state.camera === "street") return poses.street;
    if (state.camera === "follow") return followPose() ?? poses.street;
    tourT += dt;
    const hold = 9, move = 4, leg = hold + move;
    const i = Math.floor(tourT / leg) % tour.length, u = tourT % leg;
    return u < hold ? tour[i]! : lerpPose(tour[i]!, tour[(i + 1) % tour.length]!, (u - hold) / move);
  };

  const minute = state.period === "pm" ? 16 * 60 + 40 : 8 * 60 + 15;
  view.setObservationPose(currentPose(0));
  await host.prepare(() => { scene.update(sim.snapshot().cars, sim.main, 1); view.frame(0, null, NO_FLY_INPUT, minute); view.render(); });
  host.reveal();
  refreshScores();
  panel.update(state, sim.snapshot());

  const handle: PlannerHandle = {
    ready: true, corridor,
    state: () => ({ ...state, cars: sim.snapshot().cars.length, simTime: sim.t }),
    select: (change) => { panel.apply(change); },
    scores: () => scores(),
  };
  (window as unknown as { __fogcityPlanner?: PlannerHandle }).__fogcityPlanner = handle;

  let last = performance.now(), nextPanel = 0;
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const steps = Math.min(40, Math.round(dt * state.speed / sim.dt) || (state.speed > 0 ? 1 : 0));
    for (let i = 0; i < steps; i++) sim.step();
    const snap = sim.snapshot();
    scene.update(snap.cars, snap.main, dt * state.speed);
    view.setObservationPose(currentPose(dt));
    view.frame(dt, null, NO_FLY_INPUT, state.period === "pm" ? 16 * 60 + 40 : 8 * 60 + 15);
    view.render();
    if (now >= nextPanel) { nextPanel = now + 250; panel.update(state, snap); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return handle;
}
