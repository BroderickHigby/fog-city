// Night light pools (WebGPU backend only): fixed sets of real point lights that follow the
// camera, so oncoming cars and the street lamps near the player light the road, the facades and
// each other at night, not only paint a glow decal.
//
// Shape and idea adapted from Slop New York (MIT, copyright 2026 Mr.doob; see
// assets/imports/slop-new-york/LICENSE.md): a fixed pool of lights is handed each frame to the
// sources nearest the camera (traffic.js updateTrafficLights, street-details.js update), sources
// ahead of the camera are preferred over those behind it (effective distance), a source near the
// edge of the pool fades out smoothly so a swap never pops, and an idle light is parked far below
// the ground at intensity 0. Slop's headlights are SpotLights; the r186 clustered lighting
// (three/addons/lighting/ClusteredLighting.js) clusters only unshadowed PointLights, and every
// SpotLight would stay in every material's own light loop, so each car here gets one PointLight
// just ahead of its nose instead of two spots.
//
// Pool sizes are fixed for the life of the renderer, so turning night on or off never changes
// the scene's light count. By day every light sits at intensity 0 and parked.
// The selection is pure (tests/render/night-light-pools.test.ts); the classes only move lights.
import * as THREE from "three";
import { ROBOTAXI_BODY } from "../sim/agents.ts";
import { STREET_LIGHT_COLOR, STREET_LIGHT_NIGHT_INTENSITY, STREET_LIGHT_REACH_M, STREET_LIGHT_RANGE_M } from "./street-lights.ts";

/**
 * Pool sizes on the WebGPU backend: car headlights, and street lamps (the other backends keep
 * street-lights.ts's 8). Chosen from how many sources are really in reach, not from Slop's
 * 96 + 36 + 48: at 736 street-level views over the SF traffic (four sim times, both ways along
 * each robotaxi's road) the cars in reach were 5 at the median, 15 at the 95th percentile and
 * 20 at most, and the lamps 18, 25 and 32. 24 cars cover every view seen; 24 lamps cover about
 * nine views in ten, and in the rest the farthest lamp fades out toward the pool's cutoff.
 * A light only costs where it reaches, so a larger pool would sit unused (parked) most of the time.
 */
export const CAR_LIGHT_POOL = 24;
export const LAMP_LIGHT_POOL = 24;

/**
 * Most lights a pool may hold. ?carlights= and ?lamplights= are clamped to this: a huge value
 * would allocate a huge pool, and ClusteredLighting (gpu-engine.ts) holds 256 point lights in
 * all, silently dropping the rest, so two full pools (192) must leave room for the others.
 */
export const MAX_POOL_SIZE = 96;

/** A pool size from a URL value: whole, 0 to MAX_POOL_SIZE; `fallback` when it is missing or not a number. */
export function poolSize(value: number | undefined | null, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(MAX_POOL_SIZE, Math.floor(value)));
}

/** Where an idle light waits: far below any ground, so no cluster takes it. */
const PARK_Y = -1000;

/** Floats per vehicle in AgentLayer.vehiclePoses: x, y, z, compass heading, id. */
export const VEHICLE_STRIDE = 5;

// ---------------------------------------------------------------- the pure half

/**
 * Keeps the `cap` best sources of a stream, nearest (smallest effective distance) first, and
 * remembers the first one it had to drop: its distance is the pool's cutoff, so the sources near
 * the end of the pool can fade out toward it. Ties break on the source id, so the result does
 * not depend on the order the sources are offered in. Allocation-free after construction.
 */
export class NearestPicker {
  /** The most sources kept: the size it was built for, or less after limit(). */
  cap: number;
  private readonly most: number;
  private n = 0;
  private readonly eff: Float64Array;
  private readonly ids: Float64Array;
  private readonly data: Float64Array;

  constructor(cap: number) {
    this.cap = this.most = Math.max(0, Math.floor(cap));
    this.eff = new Float64Array(this.cap + 1);
    this.ids = new Float64Array(this.cap + 1);
    this.data = new Float64Array((this.cap + 1) * 4);
  }

  /** Keep at most `n` sources from now on (never more than the size it was built for). Starts a new pick. */
  limit(n: number): void {
    this.cap = Math.max(0, Math.min(this.most, Math.floor(n)));
    this.n = 0;
  }

  reset(): void { this.n = 0; }

  /** Offer one source: its effective distance, a stable id, and up to four numbers to carry. */
  offer(eff: number, id: number, a = 0, b = 0, c = 0, d = 0): void {
    const room = this.cap + 1;
    if (this.n === room) {
      const last = room - 1;
      if (eff > this.eff[last]! || (eff === this.eff[last] && id >= this.ids[last]!)) return;
    }
    let at = this.n < room ? this.n++ : room - 1;
    while (at > 0 && (this.eff[at - 1]! > eff || (this.eff[at - 1] === eff && this.ids[at - 1]! > id))) {
      this.eff[at] = this.eff[at - 1]!;
      this.ids[at] = this.ids[at - 1]!;
      this.data.copyWithin(at * 4, (at - 1) * 4, at * 4);
      at--;
    }
    this.eff[at] = eff;
    this.ids[at] = id;
    this.data[at * 4] = a; this.data[at * 4 + 1] = b; this.data[at * 4 + 2] = c; this.data[at * 4 + 3] = d;
  }

  /** Sources kept (at most `cap`). */
  get count(): number { return Math.min(this.n, this.cap); }
  effDist(i: number): number { return this.eff[i]!; }
  id(i: number): number { return this.ids[i]!; }
  /** The i-th kept source's carried numbers: k = 0..3. */
  value(i: number, k: 0 | 1 | 2 | 3): number { return this.data[i * 4 + k]!; }

  /** Where the pool ends: the first dropped source's distance, or `range` when nothing was dropped. */
  cutoff(range: number): number { return this.n > this.cap ? Math.min(range, this.eff[this.cap]!) : range; }

  /** 1 for a source well inside the pool, easing to 0 at its cutoff (smoothstep over the outer 38%). */
  fade(i: number, range: number): number { return smoothFade(this.eff[i]!, this.cutoff(range)); }
}

/** 1 up to 62% of the cutoff, easing to 0 at the cutoff. */
export function smoothFade(dist: number, cutoff: number): number {
  if (!(cutoff > 0)) return 0;
  const start = cutoff * 0.62;
  const t = Math.min(1, Math.max(0, (cutoff - dist) / (cutoff - start)));
  return t * t * (3 - 2 * t);
}

/** How far a source off to the side or behind the camera counts as farther away (metres per metre behind). */
export const BEHIND_START_M = 6;
export const BEHIND_WEIGHT = 2.8;

/**
 * Distance from the viewer, plus a penalty for sources behind the camera plane (the camera looks
 * along (fx, fz)): a light behind you lights little of what you see, so one ahead wins the slot.
 * With no look direction (fx = fz = 0) it is the plain distance.
 */
export function effectiveDistance(dx: number, dz: number, fx: number, fz: number): number {
  const dist = Math.hypot(dx, dz);
  if (fx === 0 && fz === 0) return dist;
  return dist + Math.max(0, BEHIND_START_M - (dx * fx + dz * fz)) * BEHIND_WEIGHT;
}

/**
 * Keeps a source in the light it had last frame. `selected` are this frame's source ids (the
 * first `count`); `slotIds` is what each light drove last frame (-1: idle) and is updated in
 * place. Fills `slotOf[i]` with the slot for selected[i]. A source that stays selected keeps its
 * slot, new ones take the lowest free slots; slots nobody claims go idle.
 */
export function assignSlots(selected: ArrayLike<number>, count: number, slotIds: Float64Array, slotOf: Int32Array): void {
  const slots = slotIds.length;
  if (claimedScratch.length < slots) claimedScratch = new Uint8Array(slots);
  if (openScratch.length < count) openScratch = new Int32Array(count);
  const claimed = claimedScratch.fill(0, 0, slots);
  let open = 0;
  for (let i = 0; i < count; i++) {
    slotOf[i] = -1;
    const id = selected[i]!;
    for (let s = 0; s < slots; s++) {
      if (!claimed[s] && slotIds[s] === id) { claimed[s] = 1; slotOf[i] = s; break; }
    }
    if (slotOf[i]! < 0) openScratch[open++] = i;
  }
  let s = 0;
  for (let k = 0; k < open; k++) {
    const i = openScratch[k]!;
    while (s < slots && claimed[s]) s++;
    if (s >= slots) break;
    claimed[s] = 1;
    slotOf[i] = s;
  }
  slotIds.fill(-1);
  for (let i = 0; i < count; i++) if (slotOf[i]! >= 0) slotIds[slotOf[i]!] = selected[i]!;
}

let claimedScratch = new Uint8Array(64);
let openScratch = new Int32Array(64);

/**
 * Where a car's pool light goes, and how far it reaches. The light sits ahead of the nose so it
 * pools on the road in front; when a car is close ahead in the same lane (`gapAhead`, bumper to
 * bumper, metres; Infinity for none) the light is pulled back toward its own nose and its reach
 * is cut, so the beam never lands on the far side of the car in front (Slop's maxReach rule).
 */
export function beamFor(gapAhead: number, p: CarLightParams): { ahead: number; reach: number } {
  if (!(gapAhead < p.reachM)) return { ahead: p.aheadM, reach: p.reachM };
  const gap = Math.max(0, gapAhead);
  return { ahead: Math.min(p.aheadM, Math.max(0.4, gap * 0.45)), reach: Math.min(p.reachM, Math.max(p.minReachM, gap + 3)) };
}

// ---------------------------------------------------------------- car headlights

export interface CarLightParams {
  /** Candela at full night. */
  intensity: number;
  decay: number;
  /** Cutoff radius of a car's light, and the shortest it is cut to behind a car ahead. */
  reachM: number;
  minReachM: number;
  /** Light height above the road, and how far ahead of the nose it sits. */
  heightM: number;
  aheadM: number;
  /** Cars farther than this (effective distance) get no light. */
  rangeM: number;
  /** Lights in use, at most the pool's size: lower it to measure what a smaller pool costs. */
  limit: number;
}

export const CAR_LIGHT_PARAMS: Readonly<CarLightParams> = Object.freeze({
  // Tuned by eye on the SF world at night (qa-shots): a point light cannot be a cone, and a low
  // one lights the walls beside the road far more than the dark asphalt, so it rides 3 m up and
  // 7 m ahead of the nose, where it pools on the road in front of the car like a low beam.
  intensity: 50,
  decay: 2,
  reachM: 21,
  minReachM: 8,
  heightM: 3,
  aheadM: 7,
  rangeM: 120,
  limit: Infinity,
});

/** The robotaxi body is centred on the agent's origin: its nose is this far ahead of it. */
const NOSE_M = ROBOTAXI_BODY.halfLength;
/** A car this far ahead (nose to tail) and within this lateral distance is "the car in front". */
const LANE_HALF_WIDTH_M = 2.1;
const COLOR_HEAD = 0xfff1d8;

export class CarLightPool {
  readonly group = new THREE.Group();
  readonly lights: THREE.PointLight[] = [];
  /** Tunable in the page while looking: with ?debug=1, `__fogcityView.carLights.params` (src/main.ts exposes the view). Not read from the sim. */
  readonly params: CarLightParams = { ...CAR_LIGHT_PARAMS };
  private night = 0;
  private parked = false;
  private readonly picker: NearestPicker;
  private readonly slotIds: Float64Array;
  private readonly slotOf: Int32Array;
  private readonly selected: Float64Array;
  private readonly used: Uint8Array;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.group.name = "car-lights";
    this.picker = new NearestPicker(size);
    this.slotIds = new Float64Array(size).fill(-1);
    this.slotOf = new Int32Array(size);
    this.selected = new Float64Array(size);
    this.used = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(COLOR_HEAD, 0, this.params.reachM, this.params.decay);
      light.name = `car-light:${i}`;
      light.castShadow = false;
      light.position.set(0, PARK_Y, 0);
      this.lights.push(light);
      this.group.add(light);
    }
    this.parked = true;
  }

  setNight(night: number): void {
    this.night = Math.max(0, Math.min(1, night));
  }

  /** Lights on this frame (for tests, and renderInfo().carLightsLit). */
  get lit(): number {
    let n = 0;
    for (const l of this.lights) if (l.intensity > 0) n++;
    return n;
  }

  /** The light driven by car `id` right now, or -1 (for tests, and renderInfo().streetLightsLit). */
  slotFor(id: number): number {
    return this.slotIds.indexOf(id);
  }

  /**
   * Per frame: give the pool to the `size` cars nearest (x, z), preferring cars ahead of the
   * camera (it looks along (fx, fz)). `vehicles` holds `count` cars of VEHICLE_STRIDE floats
   * (x, y, z, heading, id), as AgentLayer.vehiclePoses fills them.
   */
  update(x: number, z: number, fx: number, fz: number, vehicles: ArrayLike<number>, count: number): void {
    // By day, and for a pool of none, there is nothing to place.
    if (this.night < 0.05 || this.size === 0) { this.park(); return; }
    const p = this.params;
    const picker = this.picker;
    picker.limit(p.limit);
    for (let v = 0; v < count; v++) {
      const o = v * VEHICLE_STRIDE;
      const eff = effectiveDistance(vehicles[o]! - x, vehicles[o + 2]! - z, fx, fz);
      if (eff >= p.rangeM) continue;
      picker.offer(eff, vehicles[o + 4]!, v);
    }
    const n = picker.count;
    for (let i = 0; i < n; i++) this.selected[i] = picker.id(i);
    assignSlots(this.selected, n, this.slotIds, this.slotOf);
    const level = this.night * Math.min(1, (this.night - 0.05) / 0.3);
    const used = this.used.fill(0);
    for (let i = 0; i < n; i++) {
      const slot = this.slotOf[i]!;
      if (slot < 0) continue;
      used[slot] = 1;
      const o = picker.value(i, 0) * VEHICLE_STRIDE;
      const heading = vehicles[o + 3]!;
      const sx = Math.sin(heading), sz = -Math.cos(heading);
      const gap = this.gapAhead(vehicles, count, o, sx, sz);
      const beam = beamFor(gap, p);
      const light = this.lights[slot]!;
      light.position.set(vehicles[o]! + sx * (NOSE_M + beam.ahead), vehicles[o + 1]! + p.heightM, vehicles[o + 2]! + sz * (NOSE_M + beam.ahead));
      light.distance = beam.reach;
      light.decay = p.decay;
      light.intensity = p.intensity * level * picker.fade(i, p.rangeM);
    }
    for (let s = 0; s < this.size; s++) {
      if (used[s]) continue;
      const light = this.lights[s]!;
      light.intensity = 0;
      light.position.set(0, PARK_Y, 0);
    }
    this.parked = false;
  }

  /** Bumper-to-bumper distance to the nearest car ahead in this car's lane, or Infinity. */
  private gapAhead(vehicles: ArrayLike<number>, count: number, self: number, sx: number, sz: number): number {
    let best = Infinity;
    const x = vehicles[self]!, z = vehicles[self + 2]!;
    const reach = this.params.reachM + 2 * NOSE_M;
    for (let v = 0; v < count; v++) {
      const o = v * VEHICLE_STRIDE;
      if (o === self) continue;
      const dx = vehicles[o]! - x, dz = vehicles[o + 2]! - z;
      const along = dx * sx + dz * sz;
      if (along <= 0 || along > reach) continue;
      if (Math.abs(dx * sz - dz * sx) > LANE_HALF_WIDTH_M) continue;
      const gap = along - 2 * NOSE_M;
      if (gap < best) best = gap;
    }
    return best;
  }

  private park(): void {
    if (this.parked) return;
    for (const l of this.lights) { l.intensity = 0; l.position.set(0, PARK_Y, 0); }
    this.slotIds.fill(-1);
    this.parked = true;
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------- street lamps

export interface LampLightParams {
  /** Candela at full night, and the cutoff radius of one lamp's light. */
  intensity: number;
  reachM: number;
  /** Lamps farther than this (effective distance) get no light. */
  rangeM: number;
  /** Lights in use, at most the pool's size: lower it to measure what a smaller pool costs. */
  limit: number;
}

export const LAMP_LIGHT_PARAMS: Readonly<LampLightParams> = Object.freeze({
  intensity: STREET_LIGHT_NIGHT_INTENSITY,
  reachM: STREET_LIGHT_REACH_M,
  rangeM: STREET_LIGHT_RANGE_M,
  limit: Infinity,
});

export class LampLightPool {
  readonly group = new THREE.Group();
  readonly lights: THREE.PointLight[] = [];
  /** Tunable in the page while looking: with ?debug=1, `__fogcityView.lampPool.params`. Not read from the sim. */
  readonly params: LampLightParams = { ...LAMP_LIGHT_PARAMS };
  private night = 0;
  private parked = false;
  private lastX = Infinity;
  private lastZ = Infinity;
  private sinceS = Infinity;
  private readonly picker: NearestPicker;
  private readonly slotIds: Float64Array;
  private readonly slotOf: Int32Array;
  private readonly selected: Float64Array;
  private readonly used: Uint8Array;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.group.name = "street-lights";
    this.picker = new NearestPicker(size);
    this.slotIds = new Float64Array(size).fill(-1);
    this.slotOf = new Int32Array(size);
    this.selected = new Float64Array(size);
    this.used = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(STREET_LIGHT_COLOR, 0, this.params.reachM, 2);
      light.name = `street-light:${i}`;
      light.castShadow = false;
      light.position.set(0, PARK_Y, 0);
      this.lights.push(light);
      this.group.add(light);
    }
    this.parked = true;
  }

  setNight(night: number): void {
    this.night = Math.max(0, Math.min(1, night));
    this.sinceS = Infinity; // re-apply intensities on the next update
  }

  get lit(): number {
    let n = 0;
    for (const l of this.lights) if (l.intensity > 0) n++;
    return n;
  }

  /**
   * Per frame: give the pool to the lamp heads (x, y, z triples per tile) nearest (x, z),
   * preferring lamps ahead of the camera, which looks along (fx, fz). Lamps do not move, so the
   * pick is redone only after the camera has moved 4 m or half a second has passed.
   */
  update(x: number, z: number, dt: number, heads: Iterable<Float32Array>, fx: number, fz: number): void {
    this.sinceS += dt;
    if (this.night <= 0 || this.size === 0) { this.park(); return; }
    if (this.sinceS < 0.5 && Math.hypot(x - this.lastX, z - this.lastZ) < 4) return;
    this.sinceS = 0; this.lastX = x; this.lastZ = z;
    const picker = this.picker;
    picker.limit(this.params.limit);
    for (const h of heads) {
      for (let i = 0; i + 2 < h.length; i += 3) {
        const hx = h[i]!, hy = h[i + 1]!, hz = h[i + 2]!;
        const eff = effectiveDistance(hx - x, hz - z, fx, fz);
        if (eff >= this.params.rangeM) continue;
        picker.offer(eff, lampId(hx, hz), hx, hy, hz);
      }
    }
    const n = picker.count;
    for (let i = 0; i < n; i++) this.selected[i] = picker.id(i);
    assignSlots(this.selected, n, this.slotIds, this.slotOf);
    const used = this.used.fill(0);
    for (let i = 0; i < n; i++) {
      const slot = this.slotOf[i]!;
      if (slot < 0) continue;
      used[slot] = 1;
      const light = this.lights[slot]!;
      light.position.set(picker.value(i, 0), picker.value(i, 1) - 0.3, picker.value(i, 2));
      light.distance = this.params.reachM;
      light.intensity = this.params.intensity * this.night * picker.fade(i, this.params.rangeM);
    }
    for (let s = 0; s < this.size; s++) {
      if (used[s]) continue;
      const light = this.lights[s]!;
      light.intensity = 0;
      light.position.set(0, PARK_Y, 0);
    }
    this.parked = false;
  }

  private park(): void {
    if (this.parked) return;
    for (const l of this.lights) { l.intensity = 0; l.position.set(0, PARK_Y, 0); }
    this.slotIds.fill(-1);
    this.parked = true;
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
    this.group.removeFromParent();
  }
}

/** A lamp's identity: its place, to 12.5 cm (lamps are static, so the id is stable between picks). */
export function lampId(x: number, z: number): number {
  return Math.round(x * 8) * 1_000_003 + Math.round(z * 8);
}
