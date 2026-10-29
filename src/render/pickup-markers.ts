// Pickup and drop markers: the person waiting to be picked up (Runway Run investors, taxi fares)
// jumping and waving both arms overhead, a glowing ring on the ground that is exactly the sim's
// stop rule (centre and radius, src/presentation/pickup-markers.ts), a tall faint beacon, and a
// spinning diamond over the stop. The ring turns green and fills while the car holds inside it
// slowly enough. When the pickup happens the person walks to the car and is gone, and the ring
// fades. Render-only: nothing here reaches the sim.
//
// The person is a Rocketbox crowd character (the same skinned files and idle/walk clips as the
// street crowd, crowd-humans.ts), the arms raised by aiming the arm bones after the clip; until
// that file has loaded, a procedural stand-in in the same outfit colours does the same moves.
import * as THREE from "three";
import type { PickupKind, PickupMarker } from "../presentation/pickup-markers.ts";
import { PlayerBodies } from "./player-body.ts";
import { retireRenderTree } from "./renderer-warmup.ts";

/** The ring's coloured band, metres, inside the rule's radius. */
export const RING_BAND_M = 0.32;
/** The progress arc's band, just inside the ring. */
export const PROGRESS_BAND_M = 0.26;
/** Segments around a ring. */
export const RING_SEGMENTS = 72;
/** Above the drawn ground, metres (clear of the road's own decals). */
export const RING_LIFT_M = 0.06;
/** The beacon's height, metres. */
export const BEACON_HEIGHT_M = 60;
/** A boarding person reaches the car in this long, then is gone. */
export const BOARD_S = 1.2;
/** A marker with no pickup (the run ended, the fare was cancelled) fades out in this long. */
export const FADE_S = 0.35;
/** The person turns to face a car nearer than this, metres. */
export const FACE_CAR_M = 70;
/** Jump: a hop this high, metres, every JUMP_PERIOD_S seconds. */
export const JUMP_M = 0.32;
export const JUMP_PERIOD_S = 0.85;

/** The crowd character each waiting kind wears: a dark suit and tie for investors, a red track jacket for fares. */
export const PICKUP_CHARACTER: Readonly<Record<"investor" | "fare", string>> = {
  investor: "models/crowd/Male_Adult_04.glb",
  fare: "models/crowd/Male_Adult_10.glb",
};

const RING_COLOR: Readonly<Record<PickupKind, number>> = {
  investor: 0xffc22e,
  demo: 0xff5ad8,
  fare: 0x38d8ff,
  dropoff: 0xff5ad8,
};
const READY_COLOR = 0x46ff7e;

/** Outfit of the procedural stand-in, as close as boxes get to the crowd file it stands in for. */
const OUTFIT: Readonly<Record<"investor" | "fare", { coat: number; shirt: number; legs: number; accent: number }>> = {
  investor: { coat: 0x1d2538, shirt: 0xf3f1ea, legs: 0x1a2030, accent: 0x2fb4e8 },
  fare: { coat: 0xc42d2a, shirt: 0xf0efe8, legs: 0x22252c, accent: 0xf3f1ea },
};
const SKIN = 0xc79874;
const HAIR = 0x2b1d14;

export type GroundAt = (x: number, yRef: number, z: number) => number;

/**
 * A flat ring band from radius `inner` to `outer` around (0, 0), its vertices' heights from
 * `height(x, z)` (local x, z), so it lies on a hill. Vertex order runs around the circle in
 * segment order (six indices a segment), so a draw range shows an arc from north clockwise.
 */
export function ringGeometry(inner: number, outer: number, segments: number, height: (x: number, z: number) => number, out?: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = out ?? new THREE.BufferGeometry();
  let pos = g.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || pos.count !== (segments + 1) * 2) {
    pos = new THREE.BufferAttribute(new Float32Array((segments + 1) * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", pos);
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      index.push(a, c, b, b, c, d);
    }
    g.setIndex(index);
  }
  for (let i = 0; i <= segments; i++) {
    // Compass bearing from north (-z), clockwise.
    const t = (i / segments) * Math.PI * 2, sx = Math.sin(t), sz = -Math.cos(t);
    const ix = sx * inner, iz = sz * inner, ox = sx * outer, oz = sz * outer;
    pos.setXYZ(i * 2, ix, height(ix, iz), iz);
    pos.setXYZ(i * 2 + 1, ox, height(ox, oz), oz);
  }
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** A filled disc of radius r, rim heights from `height` (centre from the centre's). */
function discGeometry(r: number, segments: number, height: (x: number, z: number) => number, out?: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = out ?? new THREE.BufferGeometry();
  let pos = g.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || pos.count !== segments + 2) {
    pos = new THREE.BufferAttribute(new Float32Array((segments + 2) * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", pos);
    const index: number[] = [];
    for (let i = 0; i < segments; i++) index.push(0, i + 2, i + 1);
    g.setIndex(index);
  }
  pos.setXYZ(0, 0, height(0, 0), 0);
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2, x = Math.sin(t) * r, z = -Math.cos(t) * r;
    pos.setXYZ(i + 1, x, height(x, z), z);
  }
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** Outer radius of a ring geometry: the farthest vertex from its axis (for tests and QA). */
export function ringOuterRadius(g: THREE.BufferGeometry): number {
  const p = g.getAttribute("position");
  let r = 0;
  for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getZ(i)));
  return r;
}

function glow(color: number, opacity: number, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

/** Procedural person (feet at 0, facing -z): arms on shoulder pivots, legs on hip pivots. */
class StandIn {
  readonly group = new THREE.Group();
  readonly armL = new THREE.Group();
  readonly armR = new THREE.Group();
  readonly foreL = new THREE.Group();
  readonly foreR = new THREE.Group();
  readonly legL = new THREE.Group();
  readonly legR = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(kind: "investor" | "fare", shadows: boolean) {
    this.group.name = "pickup:stand-in";
    const o = OUTFIT[kind];
    const mat = (color: number): THREE.MeshStandardMaterial => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75 }); this.materials.push(m); return m; };
    const coat = mat(o.coat), shirt = mat(o.shirt), legs = mat(o.legs), accent = mat(o.accent), skin = mat(SKIN), hair = mat(HAIR);
    const box = (w: number, h: number, d: number): THREE.BufferGeometry => { const g = new THREE.BoxGeometry(w, h, d); this.geometries.push(g); return g; };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh => {
      const r = new THREE.Mesh(g, m); r.position.set(x, y, z); r.castShadow = shadows; r.receiveShadow = shadows; parent.add(r); return r;
    };
    // Torso, collar and tie (or the jacket's zip), head and hair.
    mesh(box(0.42, 0.6, 0.24), coat, 0, 1.18, 0, this.group);
    mesh(box(0.14, 0.34, 0.02), shirt, 0, 1.3, -0.125, this.group);
    mesh(box(0.05, 0.3, 0.02), accent, 0, 1.28, -0.137, this.group);
    mesh(box(0.38, 0.1, 0.24), legs, 0, 0.87, 0, this.group);
    const head = new THREE.SphereGeometry(0.115, 12, 10); this.geometries.push(head);
    mesh(head, skin, 0, 1.6, 0, this.group);
    const cap = new THREE.SphereGeometry(0.12, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2); this.geometries.push(cap);
    mesh(cap, hair, 0, 1.62, 0.01, this.group);
    for (const [arm, fore, side] of [[this.armL, this.foreL, -1], [this.armR, this.foreR, 1]] as const) {
      arm.position.set(0.25 * side, 1.43, 0);
      this.group.add(arm);
      mesh(box(0.11, 0.32, 0.12), coat, 0, -0.16, 0, arm);
      fore.position.set(0, -0.31, 0);
      arm.add(fore);
      mesh(box(0.1, 0.28, 0.11), coat, 0, -0.14, 0, fore);
      mesh(box(0.08, 0.1, 0.06), skin, 0, -0.32, 0, fore);
    }
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]] as const) {
      leg.position.set(0.1 * side, 0.86, 0);
      this.group.add(leg);
      mesh(box(0.15, 0.82, 0.16), legs, 0, -0.41, 0, leg);
      mesh(box(0.12, 0.08, 0.26), hair, 0, -0.82, -0.05, leg);
    }
  }

  /** Arms overhead (`raise` 0 .. 1), waving at phase `wave`; legs swing with `stride` (walking). */
  pose(raise: number, wave: number, stride: number): void {
    const up = raise * (Math.PI - 0.45);
    // The left arm (-x) swings out by +z rotation's opposite; each forearm waves past the head.
    this.armL.rotation.set(0, 0, -(up + raise * 0.22 * Math.sin(wave)));
    this.armR.rotation.set(0, 0, up + raise * 0.22 * Math.sin(wave + Math.PI));
    this.foreL.rotation.set(0, 0, -raise * 0.5 * Math.sin(wave * 1.5));
    this.foreR.rotation.set(0, 0, raise * 0.5 * Math.sin(wave * 1.5 + Math.PI));
    if (raise < 0.01) { this.armL.rotation.x = -0.5 * Math.sin(stride); this.armR.rotation.x = 0.5 * Math.sin(stride); }
    this.legL.rotation.x = 0.5 * Math.sin(stride);
    this.legR.rotation.x = -0.5 * Math.sin(stride);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}

type Phase = "waiting" | "boarding" | "fading";

interface Marker {
  key: string;
  row: PickupMarker;
  phase: Phase;
  /** Seconds in the current phase. */
  age: number;
  root: THREE.Group;
  ring: THREE.Mesh;
  arc: THREE.Mesh;
  disc: THREE.Mesh;
  beacon: THREE.Mesh;
  diamond: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  arcMat: THREE.MeshBasicMaterial;
  discMat: THREE.MeshBasicMaterial;
  beaconMat: THREE.MeshBasicMaterial;
  diamondMat: THREE.MeshBasicMaterial;
  /** Seconds until the ring is laid on the ground again (tiles load late). */
  resample: number;
  standIn: StandIn | null;
  /** Drawn person: position, heading (compass), scale. */
  px: number; py: number; pz: number; heading: number; scale: number;
  /** Where a boarding person walks: the car's kerb-side door. */
  boardFrom: { x: number; z: number } | null;
  boardTo: { x: number; z: number } | null;
  /** The sim body this person stands for (hidden from the crowd). */
  agentId: number | null;
  seed: number;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/** Turn `bone` (in world space) so the direction to `child` points along `want` (unit). */
function aimBone(bone: THREE.Object3D, child: THREE.Object3D, want: THREE.Vector3): void {
  bone.getWorldPosition(_v1);
  child.getWorldPosition(_v2);
  _v2.sub(_v1);
  if (_v2.lengthSq() < 1e-8 || !bone.parent) return;
  _v2.normalize();
  _q1.setFromUnitVectors(_v2, want);
  bone.getWorldQuaternion(_q2);
  _q1.multiply(_q2);
  bone.parent.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(_q1));
  bone.updateMatrixWorld(true);
}

interface ArmBones { upperL: THREE.Object3D; foreL: THREE.Object3D; handL: THREE.Object3D; upperR: THREE.Object3D; foreR: THREE.Object3D; handR: THREE.Object3D }

function findArms(root: THREE.Object3D): ArmBones | null {
  const by = (name: string): THREE.Object3D | undefined => root.getObjectByName(name) ?? root.getObjectByName(name.replaceAll(" ", "_"));
  const upperL = by("Bip01 L UpperArm"), foreL = by("Bip01 L Forearm"), handL = by("Bip01 L Hand");
  const upperR = by("Bip01 R UpperArm"), foreR = by("Bip01 R Forearm"), handR = by("Bip01 R Hand");
  return upperL && foreL && handL && upperR && foreR && handR ? { upperL, foreL, handL, upperR, foreR, handR } : null;
}

export interface PickupLayerInfo {
  markers: number; people: number; skinned: number; boarding: number; ringRadii: number[];
  /** Each marker as drawn (QA): kind, phase, ring centre, the person's drawn spot, and the dwell. */
  rows: { kind: PickupKind; phase: string; x: number; z: number; radiusM: number; person: { x: number; z: number } | null; inside: boolean; progress: number }[];
}

/** Wrap a compass angle to (-pi, pi]. */
function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

export class PickupMarkerLayer {
  readonly group = new THREE.Group();
  private readonly markers = new Map<string, Marker>();
  private readonly bodies: Partial<Record<"investor" | "fare", PlayerBodies | null>> = {};
  private readonly loading = new Set<string>();
  private readonly arms = new Map<string, ArmBones | null>();
  private readonly hidden = new Set<number>();
  private time = 0;
  private skinnedDrawn = 0;
  private disposed = false;
  private readonly beaconGeometry: THREE.BufferGeometry;
  private readonly diamondGeometry: THREE.BufferGeometry;

  /**
   * `bytes`: where crowd files come from (null: stand-ins only). `available`: the crowd files this
   * build carries (null: all). `ground`: the drawn surface height near a sim height.
   */
  private readonly bytes: ((path: string) => Promise<Uint8Array>) | null;
  private readonly shadows: boolean;
  private readonly ground: GroundAt;
  private readonly available: ReadonlySet<string> | null;

  constructor(bytes: ((path: string) => Promise<Uint8Array>) | null, shadows: boolean, ground: GroundAt, available: ReadonlySet<string> | null = null) {
    this.bytes = bytes;
    this.shadows = shadows;
    this.ground = ground;
    this.available = available;
    this.group.name = "pickup-markers";
    this.beaconGeometry = new THREE.CylinderGeometry(0.28, 0.28, 1, 16, 1, true).translate(0, 0.5, 0);
    this.diamondGeometry = new THREE.OctahedronGeometry(0.28, 0).scale(1, 1.45, 1);
  }

  /** Sim body ids drawn by this layer (taxi passengers), for the crowd to skip. */
  hiddenAgents(): ReadonlySet<number> { return this.hidden; }

  private load(kind: "investor" | "fare"): void {
    const file = PICKUP_CHARACTER[kind];
    if (!this.bytes || this.loading.has(kind) || (this.available && !this.available.has(file))) return;
    this.loading.add(kind);
    this.bodies[kind] = null;
    void PlayerBodies.load(this.bytes, this.shadows, file, { compactCrowd: true }).then((bodies) => {
      if (this.disposed) { bodies.dispose(); return; }
      bodies.setSupportHeight((x, y, z) => this.ground(x, y, z));
      bodies.group.name = `pickup:${kind}`;
      this.bodies[kind] = bodies;
      this.group.add(bodies.group);
    }).catch((error: unknown) => {
      console.warn(`[fog-city] pickup person ${file}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private create(row: PickupMarker): Marker {
    const color = RING_COLOR[row.kind];
    const root = new THREE.Group();
    root.name = `pickup:${row.kind}`;
    const ringMat = glow(color, 0.85), arcMat = glow(READY_COLOR, 0.95), discMat = glow(color, 0.12), beaconMat = glow(color, 0.22, true);
    beaconMat.polygonOffset = false;
    const diamondMat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.BufferGeometry(), ringMat);
    const arc = new THREE.Mesh(new THREE.BufferGeometry(), arcMat);
    const disc = new THREE.Mesh(new THREE.BufferGeometry(), discMat);
    ring.name = "pickup-ring"; arc.name = "pickup-progress"; disc.name = "pickup-fill";
    ring.renderOrder = 3; arc.renderOrder = 4; disc.renderOrder = 2;
    const beacon = new THREE.Mesh(this.beaconGeometry, beaconMat);
    beacon.name = "pickup-beacon"; beacon.renderOrder = 5;
    const diamond = new THREE.Mesh(this.diamondGeometry, diamondMat);
    diamond.name = "pickup-diamond";
    for (const m of [ring, arc, disc, beacon, diamond]) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; root.add(m); }
    this.group.add(root);
    let seed = 0;
    for (let i = 0; i < row.key.length; i++) seed = (seed * 31 + row.key.charCodeAt(i)) >>> 0;
    const p = row.person;
    const marker: Marker = {
      key: row.key, row, phase: "waiting", age: 0, root, ring, arc, disc, beacon, diamond, ringMat, arcMat, discMat, beaconMat, diamondMat,
      resample: 0, standIn: null, px: p?.x ?? row.x, py: p?.y ?? row.y, pz: p?.z ?? row.z, heading: p?.rest ?? 0, scale: 1,
      boardFrom: null, boardTo: null, agentId: p?.agentId ?? null, seed,
    };
    if (p) {
      const kind = row.kind === "investor" ? "investor" : "fare";
      marker.standIn = new StandIn(kind, this.shadows);
      root.add(marker.standIn.group);
      this.load(kind);
    }
    return marker;
  }

  /** Lay the ring, arc and fill on the drawn ground around the rule's centre. */
  private lay(m: Marker): void {
    const { x, y, z, radiusM } = m.row;
    const base = this.ground(x, y, z);
    m.root.position.set(x, 0, z);
    const h = (lx: number, lz: number): number => this.ground(x + lx, base, z + lz) + RING_LIFT_M;
    ringGeometry(Math.max(0.05, radiusM - RING_BAND_M), radiusM, RING_SEGMENTS, h, m.ring.geometry);
    const ai = Math.max(0.05, radiusM - RING_BAND_M - PROGRESS_BAND_M);
    ringGeometry(ai, radiusM - RING_BAND_M, RING_SEGMENTS, (lx, lz) => h(lx, lz) + 0.01, m.arc.geometry);
    discGeometry(radiusM - RING_BAND_M, RING_SEGMENTS, (lx, lz) => h(lx, lz) - 0.01, m.disc.geometry);
    m.beacon.position.set(0, base, 0);
    m.resample = 0.5;
  }

  /**
   * One frame: `rows` are this frame's pickups and drops; `car` the player's car (null on foot);
   * `camera` where the view is (for the beacon's fade). Rows that vanished board (car near) or fade.
   */
  update(rows: readonly PickupMarker[], car: { x: number; y: number; z: number; heading: number } | null, camera: { x: number; z: number }, dt: number): void {
    if (this.disposed) return;
    const step = Math.max(0, Math.min(0.1, dt));
    this.time += step;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.key);
      let m = this.markers.get(row.key);
      if (!m) { m = this.create(row); this.markers.set(row.key, m); this.lay(m); }
      const moved = Math.abs(m.row.x - row.x) + Math.abs(m.row.z - row.z) + Math.abs(m.row.radiusM - row.radiusM) > 1e-3;
      m.row = row;
      if (m.phase !== "waiting") { m.phase = "waiting"; m.age = 0; m.scale = 1; }
      if (moved) this.lay(m);
    }
    for (const m of this.markers.values()) {
      if (seen.has(m.key) || m.phase !== "waiting") continue;
      m.age = 0;
      const near = car && m.row.person && Math.hypot(car.x - m.px, car.z - m.pz) <= m.row.radiusM + 4;
      if (near && car) {
        m.phase = "boarding";
        // The kerb-side door: a metre to the car's side the person is on.
        const rx = Math.cos(car.heading), rz = Math.sin(car.heading);
        const side = (m.px - car.x) * rx + (m.pz - car.z) * rz >= 0 ? 1 : -1;
        m.boardFrom = { x: m.px, z: m.pz };
        m.boardTo = { x: car.x + rx * side * 1.0, z: car.z + rz * side * 1.0 };
      } else m.phase = "fading";
    }
    this.hidden.clear();
    for (const k of Object.values(this.bodies)) k?.begin();
    this.skinnedDrawn = 0;
    for (const [key, m] of [...this.markers]) {
      m.age += step;
      const done = (m.phase === "boarding" && m.age >= BOARD_S) || (m.phase === "fading" && m.age >= FADE_S);
      if (done) { this.retire(m); this.markers.delete(key); continue; }
      if (m.agentId !== null) this.hidden.add(m.agentId);
      m.resample -= step;
      if (m.resample <= 0 && m.phase === "waiting") this.lay(m);
      this.animate(m, car, camera, step);
    }
    for (const k of Object.values(this.bodies)) k?.end();
    if (Math.floor(this.time) !== Math.floor(this.time - step)) {
      for (const [kind, bodies] of Object.entries(this.bodies)) {
        if (!bodies) continue;
        const keep = new Set([...this.markers.values()].filter((m) => m.row.person && (m.row.kind === "investor" ? "investor" : "fare") === kind).map((m) => m.key));
        bodies.remove(keep);
        for (const id of this.arms.keys()) if (!this.markers.has(id)) this.arms.delete(id);
      }
    }
  }

  private animate(m: Marker, car: { x: number; y: number; z: number; heading: number } | null, camera: { x: number; z: number }, dt: number): void {
    const row = m.row, t = this.time + (m.seed % 1000) / 333;
    const fade = m.phase === "fading" ? 1 - m.age / FADE_S : m.phase === "boarding" ? Math.max(0, 1 - m.age / (BOARD_S * 0.6)) : 1;
    const ready = m.phase === "boarding" || row.inside;
    const progress = m.phase === "boarding" ? 1 : row.progress;
    // Ring: a gentle pulse; green while the car holds inside it.
    const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 / 1.4);
    m.ringMat.color.setHex(ready ? READY_COLOR : RING_COLOR[row.kind]);
    m.ringMat.opacity = (0.62 + 0.3 * pulse) * fade;
    m.discMat.color.setHex(ready ? READY_COLOR : RING_COLOR[row.kind]);
    m.discMat.opacity = (0.1 + 0.05 * pulse + 0.25 * progress) * fade;
    m.arcMat.opacity = 0.95 * fade;
    const index = m.arc.geometry.getIndex();
    if (index) m.arc.geometry.setDrawRange(0, Math.round(RING_SEGMENTS * Math.max(0, Math.min(1, progress))) * 6);
    m.arc.visible = progress > 0;
    // Beacon: faint, fading out close up so it never hides the person.
    const d = Math.hypot(camera.x - row.x, camera.z - row.z);
    const near = Math.max(0, Math.min(1, (d - 14) / 30));
    m.beaconMat.opacity = (0.03 + 0.22 * near) * fade;
    m.beacon.scale.set(1, BEACON_HEIGHT_M, 1);
    m.beacon.visible = fade > 0.01;
    // Diamond over the stop (over the head while someone waits), spinning and bobbing.
    m.diamond.rotation.y = this.time * 2.2;
    m.diamondMat.color.setHex(ready ? READY_COLOR : RING_COLOR[row.kind]);
    m.diamond.visible = fade > 0.01;

    const person = row.person;
    if (!person) {
      m.diamond.position.set(0, this.ground(row.x, row.y, row.z) + 2.4 + 0.12 * Math.sin(this.time * 3), 0);
      return;
    }
    // Where the person is and faces.
    let speed = 0;
    if (m.phase === "boarding" && m.boardFrom && m.boardTo) {
      const k = Math.min(1, m.age / (BOARD_S * 0.75));
      const nx = m.boardFrom.x + (m.boardTo.x - m.boardFrom.x) * k, nz = m.boardFrom.z + (m.boardTo.z - m.boardFrom.z) * k;
      speed = dt > 0 ? Math.hypot(nx - m.px, nz - m.pz) / dt : 0;
      if (Math.hypot(m.boardTo.x - m.px, m.boardTo.z - m.pz) > 0.05) m.heading = Math.atan2(m.boardTo.x - m.px, -(m.boardTo.z - m.pz));
      m.px = nx; m.pz = nz;
      m.scale = m.age < BOARD_S * 0.7 ? 1 : Math.max(0, 1 - (m.age - BOARD_S * 0.7) / (BOARD_S * 0.3));
    } else if (m.phase === "waiting") {
      m.px = person.x; m.pz = person.z;
      const want = car && Math.hypot(car.x - person.x, car.z - person.z) < FACE_CAR_M
        ? Math.atan2(car.x - person.x, -(car.z - person.z)) : person.rest;
      m.heading = wrap(m.heading + wrap(want - m.heading) * (1 - Math.exp(-6 * dt)));
      m.scale = 1;
    } else m.scale = Math.max(0, 1 - m.age / FADE_S);
    m.py = this.ground(m.px, person.y, m.pz);
    // Jump and wave while waiting; stand still (still waving) once the car is holding inside.
    const jumping = m.phase === "waiting" && !row.inside;
    const phase = (t / JUMP_PERIOD_S) % 1;
    const hop = jumping ? JUMP_M * Math.pow(Math.sin(Math.PI * phase), 0.8) : 0;
    const raise = m.phase === "boarding" ? Math.max(0, 1 - m.age / 0.25) : 1;
    const wave = t * Math.PI * 2 * 1.6;
    const lx = m.px - m.root.position.x, lz = m.pz - m.root.position.z;
    m.diamond.position.set(lx, m.py + 2.35 + hop + 0.1 * Math.sin(this.time * 3), lz);
    m.diamond.scale.setScalar(Math.max(0.001, m.scale));
    const kind = row.kind === "investor" ? "investor" : "fare";
    const bodies = this.bodies[kind];
    if (bodies && m.scale > 0.001) {
      if (m.standIn) { m.standIn.group.visible = false; }
      bodies.add(m.key, m.px, m.py, m.pz, m.heading, speed, dt);
      const root = bodies.rootOf(m.key);
      if (root) {
        root.position.y += hop;
        root.scale.setScalar(Math.max(0.001, m.scale));
        if (!this.arms.has(m.key)) this.arms.set(m.key, findArms(root));
        const arms = this.arms.get(m.key);
        if (arms && raise > 0.01) this.raiseArms(root, arms, m.heading, raise, wave);
        this.skinnedDrawn++;
      }
      return;
    }
    if (m.standIn) {
      const g = m.standIn.group;
      g.visible = m.scale > 0.001;
      g.position.set(lx, m.py + hop, lz);
      g.rotation.set(0, -m.heading, 0);
      g.scale.setScalar(Math.max(0.001, m.scale));
      m.standIn.pose(raise, wave, speed > 0.1 ? this.time * 9 : 0);
    }
  }

  /** Aim both arms overhead, waving: after the clip, so the idle pose below the shoulders stays. */
  private raiseArms(root: THREE.Object3D, arms: ArmBones, heading: number, raise: number, wave: number): void {
    root.updateMatrixWorld(true);
    // The person's right in the world (+x east, +z south): a compass heading h faces (sin h, -cos h).
    const rx = Math.cos(heading), rz = Math.sin(heading), fx = Math.sin(heading), fz = -Math.cos(heading);
    for (const [upper, fore, hand, side, offset] of [[arms.upperL, arms.foreL, arms.handL, -1, 0], [arms.upperR, arms.foreR, arms.handR, 1, Math.PI]] as const) {
      // Rest: the upper arm hangs; raised: up and a little out, swaying with the wave.
      upper.getWorldPosition(_v1); fore.getWorldPosition(_v2);
      const out = 0.38 + 0.22 * Math.sin(wave + offset);
      _dir.set(rx * side * out + fx * 0.08, 1, rz * side * out + fz * 0.08).normalize();
      const hangX = rx * side * 0.15, hangZ = rz * side * 0.15;
      _v2.set(hangX, -1, hangZ).normalize();
      _dir.lerp(_v2, 1 - raise).normalize();
      aimBone(upper, fore, _dir);
      // The forearm waves past the head.
      const sway = 0.15 + 0.5 * Math.sin(wave * 1.5 + offset);
      _dir.set(rx * side * sway + fx * 0.05, 1, rz * side * sway + fz * 0.05).normalize();
      _v2.set(hangX, -1, hangZ).normalize();
      _dir.lerp(_v2, 1 - raise).normalize();
      if (_dir.lengthSq() < 1e-6) _dir.copy(_up);
      aimBone(fore, hand, _dir);
    }
  }

  private retire(m: Marker): void {
    m.standIn?.dispose();
    const geometries = [m.ring.geometry, m.arc.geometry, m.disc.geometry];
    const materials = [m.ringMat, m.arcMat, m.discMat, m.beaconMat, m.diamondMat];
    void retireRenderTree(m.root, () => { for (const g of geometries) g.dispose(); for (const mat of materials) mat.dispose(); });
    this.arms.delete(m.key);
  }

  info(): PickupLayerInfo {
    const list = [...this.markers.values()];
    return {
      markers: list.length,
      people: list.filter((m) => m.row.person).length,
      skinned: this.skinnedDrawn,
      boarding: list.filter((m) => m.phase === "boarding").length,
      ringRadii: list.map((m) => Math.round(ringOuterRadius(m.ring.geometry) * 100) / 100),
      rows: list.map((m) => ({ kind: m.row.kind, phase: m.phase, x: m.row.x, z: m.row.z, radiusM: m.row.radiusM,
        person: m.row.person ? { x: m.px, z: m.pz } : null, inside: m.row.inside, progress: m.row.progress })),
    };
  }

  /** Drop every marker at once (a new world, a reload). */
  clear(): void {
    for (const m of this.markers.values()) this.retire(m);
    this.markers.clear();
    this.hidden.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    for (const b of Object.values(this.bodies)) b?.dispose();
    this.beaconGeometry.dispose();
    this.diamondGeometry.dispose();
    this.group.removeFromParent();
  }
}
