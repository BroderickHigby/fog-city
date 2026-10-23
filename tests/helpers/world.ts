// The world-continuity gate's shared helpers (docs/qa/world-continuity-gate.md, rule 2): the sf
// world loaded exactly as the game boots it, the per-tile collider records with their metadata,
// the 10 m ground lattice, a road follower and a walker follower around the real sim, and a
// meshopt GLB decoder for Node. Harness-owned; every gate test reads the world through here.
//
// Never touches the network: everything comes from public/tiles/<world>/. Each loader is cached
// per worker (per test file under Vitest's isolation), so one file pays for one world.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshoptDecoder } from "meshoptimizer";
import { toLatLon } from "../../src/geo/project.ts";
import * as sim from "../../src/sim/index.ts";
import {
  CAR,
  DT,
  buildWorld,
  cellKey,
  groundHeight,
  makeCar,
  makeFoot,
  pointInPolygon,
  stepCar,
  stepFoot,
  type BoundaryFile,
  type BuildingCollider,
  type CarState,
  type FootState,
  type Heightfield,
  type RoadsFile,
  type SimInput,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";
import { ROOT, loadWorldFiles, readJson, type WorldManifest } from "../helpers.ts";

export type P2 = [number, number];

// ---------------------------------------------------------------- the world as the game boots it

/** One road edge of roads.json, with the fields the gate reads (extra fields kept). */
export type RoadEdge = RoadsFile["edges"][number] & {
  cnn?: string;
  classcode?: number;
  /** Fields a later pipeline may add; the gate reads them when present. */
  tunnel?: boolean;
  stairs?: boolean;
  profile?: unknown;
  [k: string]: unknown;
};

export interface GameWorld {
  name: string;
  /** buildWorld(collider pack, roads.json, boundary.json): exactly the game's world. */
  world: World;
  manifest: WorldManifest & Record<string, unknown>;
  /** The colliders as the sim holds them, in manifest order. */
  tiles: TileCollider[];
  roads: RoadsFile;
  boundary: BoundaryFile;
  edges: Map<string, RoadEdge>;
  /** Every building record by id, with its tile. */
  byId: Map<string, BuildingCollider & { tile: string }>;
  /** Milliseconds: reading and decoding the files, and buildWorld. */
  loadMs: number;
  buildMs: number;
}

const worlds = new Map<string, GameWorld>();

/**
 * The world exactly as the game boots it (src/io/world-load.ts and src/main.ts): the collider
 * pack, the road graph and the boundary walls through assembleWorldFiles and buildWorld. Cached
 * per worker. About 2 s and 0.7 GB for the 583-tile city.
 */
export function gameWorld(name = "sf"): GameWorld {
  const hit = worlds.get(name);
  if (hit) return hit;
  const t0 = performance.now();
  const files = loadWorldFiles(name);
  if (!files.roads) throw new Error(`${name}: the gate needs the road graph its manifest names`);
  if (!files.boundary) throw new Error(`${name}: the gate needs the boundary its manifest names`);
  const t1 = performance.now();
  const world = buildWorld(files.tiles, files.roads as unknown as RoadsFile, files.boundary);
  const t2 = performance.now();
  const byId = new Map<string, BuildingCollider & { tile: string }>();
  for (const t of files.tiles) for (const b of t.buildings) byId.set(b.id, { ...b, tile: t.tileId });
  const roads = files.roads as unknown as RoadsFile;
  const gw: GameWorld = {
    name,
    world,
    manifest: files.manifest as GameWorld["manifest"],
    tiles: files.tiles,
    roads,
    boundary: files.boundary,
    edges: new Map(roads.edges.map((e) => [e.id, e as RoadEdge])),
    byId,
    loadMs: t1 - t0,
    buildMs: t2 - t1,
  };
  worlds.set(name, gw);
  return gw;
}

/** The world's colliders only (no roads, no walls): for data checks that must not see the walls. */
export function bareWorld(gw: GameWorld): World {
  return buildWorld(gw.tiles);
}

// ---------------------------------------------------------------- collider records with metadata

/** A building record from a tile's *.collider.json, with the pipeline's metadata. */
export interface SfRecord {
  id: string;
  footprint: P2[];
  baseY: number;
  topY: number;
  meta: {
    footY?: number;
    heightM?: number;
    heightSource?: string;
    lidarM?: [number, number];
    parcel?: string;
    year?: number;
    use?: string;
    stories?: number;
    units?: number;
    condo?: boolean;
    towerOf?: string;
    podiumTopY?: number;
    tower?: string;
    [k: string]: unknown;
  };
  tile: string;
}

const records = new Map<string, SfRecord[]>();

/**
 * Every building record of every tile's collider JSON (the pack leaves the metadata out), in
 * manifest then file order. Heavier than the pack (about 80 MB of JSON): only the building data
 * checks call it.
 */
export function colliderRecords(gw: GameWorld): SfRecord[] {
  const hit = records.get(gw.name);
  if (hit) return hit;
  const out: SfRecord[] = [];
  for (const t of gw.manifest.tiles) {
    const c = readJson<{ tileId: string; buildings: Array<Omit<SfRecord, "tile">> }>(`public/tiles/${gw.name}/${t.collider}`);
    for (const b of c.buildings) out.push({ ...b, meta: b.meta ?? {}, tile: c.tileId });
  }
  records.set(gw.name, out);
  return out;
}

/** The per-tile collider JSON's ground and buildings (minus meta), for the pack-vs-JSON check. */
export function colliderJsonTiles(gw: Pick<GameWorld, "name" | "manifest">): TileCollider[] {
  return gw.manifest.tiles.map((t) => {
    const c = readJson<TileCollider & { buildings: Array<BuildingCollider & { meta?: unknown }> }>(`public/tiles/${gw.name}/${t.collider}`);
    // What the sim reads (src/sim/pack.ts carries the same): buildings with their undersides, and
    // the tile's decks, tunnels and movable spans; the pipeline's meta stays out.
    const out: TileCollider = {
      tileId: c.tileId,
      ground: c.ground,
      buildings: c.buildings.map((b) => ({ id: b.id, footprint: b.footprint, baseY: b.baseY, topY: b.topY, ...(b.underY !== undefined ? { underY: b.underY } : {}) })),
    };
    if (c.decks) out.decks = c.decks;
    if (c.tunnels) out.tunnels = c.tunnels;
    if (c.movable) out.movable = c.movable;
    return out;
  });
}

// ---------------------------------------------------------------- geometry

export const r2 = (v: number): number => Math.round(v * 100) / 100;
export const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** "lat,lon" with 5 decimals, for messages. */
export function ll(x: number, z: number): string {
  const p = toLatLon(x, z);
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}

/** Compass bearing of a direction (dx, dz): radians clockwise from north (-z). */
export const bearing = (dx: number, dz: number): number => Math.atan2(dx, -dz);
export const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** A polyline resampled at about `step` m, first and last points kept. */
export function resample(points: ReadonlyArray<readonly number[]>, step = 1): P2[] {
  const out: P2[] = [[points[0]![0]!, points[0]![1]!]];
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1]![0]!;
    const az = points[i - 1]![1]!;
    const bx = points[i]![0]!;
    const bz = points[i]![1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

export function polyLen(pts: ReadonlyArray<readonly number[]>): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0]! - pts[i - 1]![0]!, pts[i]![1]! - pts[i - 1]![1]!);
  return s;
}

export function centroid(fp: ReadonlyArray<readonly number[]>): P2 {
  let x = 0;
  let z = 0;
  for (const p of fp) {
    x += p[0]!;
    z += p[1]!;
  }
  return [x / fp.length, z / fp.length];
}

export function bbox(fp: ReadonlyArray<readonly number[]>): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of fp) {
    if (p[0]! < x0) x0 = p[0]!;
    if (p[0]! > x1) x1 = p[0]!;
    if (p[1]! < z0) z0 = p[1]!;
    if (p[1]! > z1) z1 = p[1]!;
  }
  return [x0, z0, x1, z1];
}

export function polygonArea(fp: ReadonlyArray<readonly number[]>): number {
  let a = 0;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) a += fp[j]![0]! * fp[i]![1]! - fp[i]![0]! * fp[j]![1]!;
  return Math.abs(a) / 2;
}

/**
 * Visit the cell centres of a `step` m raster that lie inside a footprint (even-odd rule, by
 * scanline: the same cells pointInPolygon accepts, without testing every cell of the box).
 */
export function forRasterInside(fp: ReadonlyArray<readonly [number, number]>, step: number, fn: (x: number, z: number) => void): void {
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of fp) {
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  const xs: number[] = [];
  for (let z = Math.floor(z0 / step) * step + step / 2; z < z1; z += step) {
    xs.length = 0;
    for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
      const [xi, zi] = fp[i]!;
      const [xj, zj] = fp[j]!;
      if (zi > z !== zj > z) xs.push(((xj - xi) * (z - zi)) / (zj - zi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const a = xs[q]!;
      const b = xs[q + 1]!;
      for (let x = Math.ceil((a - step / 2) / step) * step + step / 2; x < b; x += step) if (x > a) fn(x, z);
    }
  }
}

/** Points on a `step` m raster (cell centres) inside a footprint. */
export function rasterInside(fp: ReadonlyArray<readonly [number, number]>, step = 1): P2[] {
  const out: P2[] = [];
  forRasterInside(fp, step, (x, z) => out.push([x, z]));
  return out;
}

/** Distance from a point to a segment. */
export function distToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
}

/** Distance from a point to a polygon's boundary (0 on it). */
export function distToRing(x: number, z: number, ring: ReadonlyArray<readonly number[]>): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegment(x, z, ring[j]![0]!, ring[j]![1]!, ring[i]![0]!, ring[i]![1]!);
    if (d < best) best = d;
  }
  return best;
}

/** A small seeded PRNG (mulberry32): the gate's samples are the same on every run. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The largest value (or `floor` when there is none or all are smaller), without spreading a long array onto the stack. */
export function maxOf(values: Iterable<number>, floor = -Infinity): number {
  let m = floor;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

// ---------------------------------------------------------------- ground: lattice, mesh, surface

export const LATTICE_M = 10;

/** The heightfield of the built tile that holds (x, z) (tile index floor(x / 500)), or null. */
export function tileField(world: World, x: number, z: number): Heightfield | null {
  return world.tileGround?.get(cellKey(Math.floor(x / 500), Math.floor(z / 500))) ?? null;
}

/** The city's 10 m lattice vertex (gx, gz) = (x / 10, z / 10): height and water flag, or null off the built tiles. */
export function latticeAt(world: World, gx: number, gz: number): { y: number; water: boolean } | null {
  const ix = Math.floor(gx / 50);
  const iz = Math.floor(gz / 50);
  const g = world.tileGround?.get(cellKey(ix, iz));
  if (!g) return null;
  const i = gx - ix * 50;
  const k = gz - iz * 50;
  return { y: g.heights[k * g.nx + i]!, water: g.water?.[k * g.nx + i] === 1 };
}

/**
 * The ground as the GLB draws it: each 10 m cell split into two triangles along its
 * (i+1, k)-(i, k+1) diagonal (pipeline/lib/mesh.ts groundMesh, terrain.ts meshHeightAt). The sim's
 * groundHeight is bilinear; W-22 is the difference.
 */
export function meshGroundHeight(world: World, x: number, z: number): number {
  const g = tileField(world, x, z);
  if (!g) return groundHeight(world, x, z);
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  const ix = Math.min(Math.floor(fx), g.nx - 2);
  const iz = Math.min(Math.floor(fz), g.nz - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = g.heights[iz * g.nx + ix] ?? 0;
  const h10 = g.heights[iz * g.nx + ix + 1] ?? 0;
  const h01 = g.heights[(iz + 1) * g.nx + ix] ?? 0;
  const h11 = g.heights[(iz + 1) * g.nx + ix + 1] ?? 0;
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

type SurfaceFn = (world: World, x: number, z: number, yHint?: number) => number;

/**
 * The height a body stands on at (x, z): the sim's surfaceHeight(world, x, z, yHint) when the sim
 * exports one (decks, tunnels and road profiles, docs/design.md), else its groundHeight. The gate
 * reads the sim's own function, so a fix in the sim shows up here with no change to the gate.
 */
export function surfaceAt(world: World, x: number, z: number, yHint?: number): number {
  const fn = (sim as unknown as { surfaceHeight?: SurfaceFn }).surfaceHeight;
  return fn ? fn(world, x, z, yHint) : groundHeight(world, x, z);
}

/** Is the sim reading a surface other than the bare ground (decks, tunnels, profiles)? */
export function simHasSurfaces(): boolean {
  return typeof (sim as unknown as { surfaceHeight?: SurfaceFn }).surfaceHeight === "function";
}

// ---------------------------------------------------------------- districts

interface DistrictsFile {
  districts: Array<{ name: string; polygons: P2[][][] }>;
}
const districtCache = new Map<string, DistrictsFile["districts"]>();

/** The analysis neighbourhood (districts.json) that holds (x, z), or "(none)". */
export function districtOf(gw: GameWorld, x: number, z: number): string {
  let ds = districtCache.get(gw.name);
  if (!ds) {
    ds = readJson<DistrictsFile>(`public/tiles/${gw.name}/${gw.manifest.layers?.districts ?? "districts.json"}`).districts;
    districtCache.set(gw.name, ds);
  }
  for (const d of ds) {
    for (const poly of d.polygons) {
      if (pointInPolygon(x, z, poly[0]!) && !poly.slice(1).some((h) => pointInPolygon(x, z, h))) return d.name;
    }
  }
  return "(none)";
}

// ---------------------------------------------------------------- the road follower

export interface DriveOptions {
  /** Target speed, m/s. */
  vmax?: number;
  /** Speed at the start (default min(vmax, 8)). */
  startSpeed?: number;
  /** Tick limit (default: the path at half speed plus 10 s). */
  maxTicks?: number;
  /** Ticks of throttle held at under 0.5 m/s that count as stuck (default 120: 2 s). */
  stuckTicks?: number;
}

export interface DriveResult {
  reached: boolean;
  stuck: boolean;
  /** Where it stopped (x, z) when stuck. */
  stuckAt: P2 | null;
  ticks: number;
  /** Path samples (about metres) covered, and the path's length. */
  progressM: number;
  lenM: number;
  /** Longest airborne run and total airborne time, seconds. */
  maxAirS: number;
  airS: number;
  /** Highest the car got above the ground under it, metres. */
  maxAboveM: number;
  /** Lowest the car went below the surface under it (positive = under), metres. */
  maxBelowM: number;
  maxLandMps: number;
  hits: number;
  maxDevM: number;
  /** The largest horizontal move in one tick, and by how much it beat speed * DT (a teleport). */
  maxTickMoveM: number;
  maxExcessMoveM: number;
  car: CarState;
}

/** The Stanley controller's input to follow `path` from path index `idx` (the gate's road follower). */
export function followInput(car: Readonly<CarState>, path: readonly P2[], idx: number, vmax: number): SimInput {
  const len = path.length - 1;
  const a = path[idx]!;
  const b = path[Math.min(len, idx + 2)]!;
  const ph = bearing(b[0] - a[0], b[1] - a[1]);
  const cte = (car.x - a[0]) * Math.cos(ph) + (car.z - a[1]) * Math.sin(ph);
  const v = Math.max(0, car.speed);
  const delta = wrap(ph - car.heading) - Math.atan2(1.2 * cte, v + 1.5);
  const lim = 0.6 / (1 + v / 11);
  let maxTurn = 0;
  const j2 = Math.min(len, idx + 25);
  for (let j = idx; j + 4 <= j2; j += 3) {
    const h1 = bearing(path[j + 1]![0] - path[j]![0], path[j + 1]![1] - path[j]![1]);
    const h2 = bearing(path[j + 4]![0] - path[j + 3]![0], path[j + 4]![1] - path[j + 3]![1]);
    maxTurn = Math.max(maxTurn, Math.abs(wrap(h2 - h1)) / 3);
  }
  const vt = Math.min(vmax, Math.sqrt(4 / Math.max(maxTurn, 1e-4)));
  const input = { throttle: Math.max(-1, Math.min(1, (vt - car.speed) * 0.6)), steer: Math.max(-1, Math.min(1, delta / lim)), brake: 0, actions: 0 };
  if (input.throttle < 0 && car.speed > 0) {
    input.brake = Math.min(1, -input.throttle);
    input.throttle = 0;
  }
  return input;
}

/** Nearest path index to (x, z) at or after `idx`, searching `ahead` samples. */
export function advanceIndex(path: readonly P2[], idx: number, x: number, z: number, ahead = 40): { idx: number; dev: number } {
  let bi = idx;
  let bd = Infinity;
  for (let j = idx; j < Math.min(path.length, idx + ahead); j++) {
    const d = (path[j]![0] - x) ** 2 + (path[j]![1] - z) ** 2;
    if (d < bd) {
      bd = d;
      bi = j;
    }
  }
  return { idx: bi, dev: Math.sqrt(bd) };
}

/** Start pose for a path: its first point, facing 3 samples ahead, on the ground. */
export function carAtPathStart(world: World, path: readonly P2[], speed: number): CarState {
  const k = Math.min(3, path.length - 1);
  const h0 = bearing(path[k]![0] - path[0]![0], path[k]![1] - path[0]![1]);
  return { ...makeCar(path[0]![0], path[0]![1], h0, sim.sampleGround(world, path[0]![0], path[0]![1], h0).h), speed };
}

/** Per-tick bookkeeping shared by the stepCar and step() drivers. */
export class DriveTrack {
  airRun = 0;
  maxAir = 0;
  airTotal = 0;
  maxAbove = 0;
  maxBelow = 0;
  maxLand = 0;
  maxTickMove = 0;
  maxExcess = 0;
  private readonly world: World;
  constructor(world: World) {
    this.world = world;
  }
  tick(prev: Readonly<CarState>, car: Readonly<CarState>): void {
    if (!car.grounded) {
      this.airRun++;
      this.airTotal++;
      if (this.airRun > this.maxAir) this.maxAir = this.airRun;
    } else this.airRun = 0;
    const g = surfaceAt(this.world, car.x, car.z, car.y);
    if (car.y - g > this.maxAbove) this.maxAbove = car.y - g;
    if (g - car.y > this.maxBelow) this.maxBelow = g - car.y;
    if (car.landingSpeed > this.maxLand && car.airTicks === 0 && prev.airTicks > 0) this.maxLand = car.landingSpeed;
    const move = Math.hypot(car.x - prev.x, car.z - prev.z);
    if (move > this.maxTickMove) this.maxTickMove = move;
    const excess = move - Math.max(Math.abs(prev.speed), Math.abs(car.speed), Math.hypot(prev.speed, prev.lateral)) * DT;
    if (excess > this.maxExcess) this.maxExcess = excess;
  }
}

/**
 * Drive the real stepCar along `path` (1 m samples) with the gate's road follower (the critic's
 * Stanley controller). Stuck = throttle held with |v| < 0.5 m/s for 2 s.
 */
export function drivePath(world: World, path: readonly P2[], opts: DriveOptions = {}): DriveResult {
  const vmax = opts.vmax ?? 12;
  let car = carAtPathStart(world, path, opts.startSpeed ?? Math.min(vmax, 8));
  const len = path.length - 1;
  const limit = opts.maxTicks ?? Math.ceil((len / Math.max(3, vmax * 0.5)) * 60) + 600;
  const stuckLimit = opts.stuckTicks ?? 120;
  const track = new DriveTrack(world);
  const hits0 = car.hits;
  let idx = 0;
  let stuckTicks = 0;
  let maxDev = 0;
  let stuckAt: P2 | null = null;
  let reached = false;
  let t = 0;
  for (t = 0; t < limit; t++) {
    const a = advanceIndex(path, idx, car.x, car.z);
    idx = a.idx;
    if (a.dev > maxDev) maxDev = a.dev;
    if (idx >= len - 2) {
      reached = true;
      break;
    }
    const input = followInput(car, path, idx, vmax);
    const prev = car;
    car = stepCar(world, car, input);
    track.tick(prev, car);
    if (input.throttle > 0.5 && Math.abs(car.speed) < 0.5) {
      stuckTicks++;
      if (stuckTicks >= stuckLimit) {
        stuckAt = [car.x, car.z];
        break;
      }
    } else stuckTicks = 0;
  }
  return {
    reached,
    stuck: stuckAt !== null,
    stuckAt,
    ticks: t,
    progressM: idx,
    lenM: len,
    maxAirS: track.maxAir / 60,
    airS: track.airTotal / 60,
    maxAboveM: track.maxAbove,
    maxBelowM: track.maxBelow,
    maxLandMps: track.maxLand,
    hits: car.hits - hits0,
    maxDevM: maxDev,
    maxTickMoveM: track.maxTickMove,
    maxExcessMoveM: track.maxExcess,
    car,
  };
}

/** Is the car's box at the start of `path` inside a building or across a wall? */
export function startBlocked(world: World, path: readonly P2[]): boolean {
  const k = Math.min(3, path.length - 1);
  const h0 = bearing(path[k]![0] - path[0]![0], path[k]![1] - path[0]![1]);
  const y0 = groundHeight(world, path[0]![0], path[0]![1]);
  return sim.boxBlocked(world, { x: path[0]![0], z: path[0]![1], heading: h0, hl: CAR.halfLength, hw: CAR.halfWidth }, y0 + 0.5, []);
}

/**
 * The critic's start rule for an edge drive: when the first pose is blocked, try 4, 8, ... m in
 * (up to 20 m). Returns the path from the first clear start, or null (start-blocked).
 */
export function clearStart(world: World, path: P2[]): P2[] | null {
  if (!startBlocked(world, path)) return path;
  for (let k = 4; k < Math.min(20, path.length - 8); k += 4) if (!startBlocked(world, path.slice(k))) return path.slice(k);
  return null;
}

// ---------------------------------------------------------------- the walker follower

export interface WalkResult {
  reached: boolean;
  stuck: boolean;
  stuckAt: P2 | null;
  ticks: number;
  progressM: number;
  lenM: number;
  /** Largest rise and drop of the walker's y in one tick, metres. */
  maxRiseM: number;
  maxDropM: number;
  /** Mean speed over the walk, m/s. */
  meanSpeed: number;
  foot: FootState;
}

/**
 * Walk the real stepFoot along `path` (0.5 m samples), steering at the centreline 1.5 m ahead.
 * Stuck = under 0.5 m of progress in 4 s. `sprint` holds the brake (sprinting).
 */
export function walkPath(world: World, path: readonly P2[], opts: { sprint?: boolean; maxTicks?: number; stepM?: number } = {}): WalkResult {
  const stepM = opts.stepM ?? 0.5;
  const k0 = Math.min(2, path.length - 1);
  let f = makeFoot(path[0]![0], groundHeight(world, path[0]![0], path[0]![1]), path[0]![1], bearing(path[k0]![0] - path[0]![0], path[k0]![1] - path[0]![1]));
  const len = path.length - 1;
  const limit = opts.maxTicks ?? Math.ceil(((len * stepM) / (opts.sprint ? 1.5 : 0.4)) * 60) + 600;
  let idx = 0;
  let lastProg = 0;
  let lastT = 0;
  let stuckAt: P2 | null = null;
  let maxRise = 0;
  let maxDrop = 0;
  let t = 0;
  let reached = false;
  for (t = 0; t < limit; t++) {
    idx = advanceIndex(path, idx, f.x, f.z, 20).idx;
    if (idx >= len - 2) {
      reached = true;
      break;
    }
    const tgt = path[Math.min(len, idx + Math.round(1.5 / stepM))]!;
    const want = bearing(tgt[0] - f.x, tgt[1] - f.z);
    const steer = Math.max(-1, Math.min(1, wrap(want - f.heading) / 0.25));
    const prevY = f.y;
    f = stepFoot(world, f, { throttle: 1, steer, brake: opts.sprint ? 1 : 0, actions: 0 }, [], []);
    const dy = f.y - prevY;
    if (dy > maxRise) maxRise = dy;
    if (-dy > maxDrop) maxDrop = -dy;
    if (idx > lastProg + 1 / stepM) {
      lastProg = idx;
      lastT = t;
    }
    if (t - lastT > 240) {
      stuckAt = [f.x, f.z];
      break;
    }
  }
  return {
    reached,
    stuck: stuckAt !== null,
    stuckAt,
    ticks: t,
    progressM: idx * stepM,
    lenM: len * stepM,
    maxRiseM: maxRise,
    maxDropM: maxDrop,
    meanSpeed: t > 0 ? (idx * stepM) / (t / 60) : 0,
    foot: f,
  };
}

// ---------------------------------------------------------------- GLB reading (meshopt, quantised)

export interface GlbNode {
  name: string;
  /** World-frame positions (node transform applied), xyz. */
  positions: Float32Array;
  /** Triangle indices (mode 4). */
  indices: Uint32Array;
  /** COLOR_0 as 0..1 floats, 4 per vertex, when present. */
  colors: Float32Array | null;
  /** Other vertex attributes by glTF name (TEXCOORD_0, _FACADE, NORMAL), as floats. */
  attributes: Record<string, { data: Float32Array; size: number }>;
  extras: Record<string, unknown> | null;
}

export interface GlbFile {
  json: GltfDoc;
  nodes: GlbNode[];
  sceneExtras: Record<string, unknown> | null;
}

interface GltfDoc {
  nodes?: Array<{ name?: string; mesh?: number; translation?: number[]; scale?: number[]; rotation?: number[]; extras?: Record<string, unknown> }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number }> }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }> }>;
  scenes?: Array<{ extras?: Record<string, unknown> }>;
  [k: string]: unknown;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** The JSON chunk of a GLB, without decoding anything else. */
export function glbJsonOf(bytes: Uint8Array): GltfDoc {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GltfDoc;
}

/**
 * Read a GLB the way the renderer's loader does (EXT_meshopt_compression, KHR_mesh_quantization):
 * every mesh node (or only `only`) decoded to world-frame positions, triangle indices and float
 * attributes (all of them, or only `attrs`: then POSITION too only when listed). Pure JS plus the
 * meshopt WASM decoder; no three.js.
 */
export async function readGlb(path: string, only?: readonly string[], attrs?: readonly string[]): Promise<GlbFile> {
  await MeshoptDecoder.ready;
  const bytes = new Uint8Array(readFileSync(path.startsWith("/") ? path : join(ROOT, path)));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as GltfDoc;
  const binStart = 20 + jsonLen;
  const bin = binStart + 8 <= bytes.length ? bytes.subarray(binStart + 8, binStart + 8 + dv.getUint32(binStart, true)) : new Uint8Array(0);
  const views = new Map<number, Uint8Array>();
  const view = (i: number): Uint8Array => {
    const hit = views.get(i);
    if (hit) return hit;
    const bv = json.bufferViews![i]!;
    const ext = bv.extensions?.EXT_meshopt_compression;
    let out: Uint8Array;
    if (ext) {
      out = new Uint8Array(ext.count * ext.byteStride);
      const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src, ext.mode, ext.filter);
    } else {
      out = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    }
    views.set(i, out);
    return out;
  };
  const accessor = (i: number): { data: Float32Array; size: number; ints: Uint32Array | null } => {
    const a = json.accessors![i]!;
    const size = COMPONENTS[a.type]!;
    const bv = json.bufferViews![a.bufferView!]!;
    const raw = view(a.bufferView!);
    const elBytes = BYTES[a.componentType]!;
    const stride = bv.extensions?.EXT_meshopt_compression?.byteStride ?? bv.byteStride ?? size * elBytes;
    const rdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const data = new Float32Array(a.count * size);
    const ints = size === 1 && a.componentType !== 5126 ? new Uint32Array(a.count) : null;
    const base = a.byteOffset ?? 0;
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < size; c++) {
        const o = base + k * stride + c * elBytes;
        let v: number;
        switch (a.componentType) {
          case 5120:
            v = rdv.getInt8(o);
            if (a.normalized) v = Math.max(v / 127, -1);
            break;
          case 5121:
            v = rdv.getUint8(o);
            if (a.normalized) v /= 255;
            break;
          case 5122:
            v = rdv.getInt16(o, true);
            if (a.normalized) v = Math.max(v / 32767, -1);
            break;
          case 5123:
            v = rdv.getUint16(o, true);
            if (a.normalized) v /= 65535;
            break;
          case 5125:
            v = rdv.getUint32(o, true);
            break;
          default:
            v = rdv.getFloat32(o, true);
        }
        data[k * size + c] = v;
        if (ints) ints[k] = v;
      }
    }
    return { data, size, ints };
  };
  const nodes: GlbNode[] = [];
  for (const n of json.nodes ?? []) {
    if (n.mesh === undefined) continue;
    const name = n.name ?? "";
    if (only && !only.includes(name)) continue;
    if (n.rotation && (n.rotation[0] !== 0 || n.rotation[1] !== 0 || n.rotation[2] !== 0)) throw new Error(`${path} ${name}: rotated nodes are not supported`);
    const t = n.translation ?? [0, 0, 0];
    const s = n.scale ?? [1, 1, 1];
    const parts: GlbNode[] = [];
    for (const p of json.meshes![n.mesh]!.primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const wantPos = !attrs || attrs.includes("POSITION");
      const count = json.accessors![p.attributes.POSITION!]!.count;
      let positions = new Float32Array(0);
      if (wantPos) {
        const pos = accessor(p.attributes.POSITION!);
        positions = new Float32Array(pos.data.length);
        for (let k = 0; k < pos.data.length; k += 3) {
          positions[k] = pos.data[k]! * s[0]! + t[0]!;
          positions[k + 1] = pos.data[k + 1]! * s[1]! + t[1]!;
          positions[k + 2] = pos.data[k + 2]! * s[2]! + t[2]!;
        }
      }
      const idx = p.indices !== undefined ? accessor(p.indices).ints! : Uint32Array.from({ length: count }, (_, k) => k);
      const attributes: GlbNode["attributes"] = {};
      let colors: Float32Array | null = null;
      for (const [an, ai] of Object.entries(p.attributes)) {
        if (an === "POSITION" || (attrs && !attrs.includes(an))) continue;
        const a = accessor(ai);
        if (an === "COLOR_0") {
          colors = a.size === 4 ? a.data : Float32Array.from({ length: (a.data.length / 3) * 4 }, (_, k) => (k % 4 === 3 ? 1 : a.data[Math.floor(k / 4) * 3 + (k % 4)]!));
        } else attributes[an] = { data: a.data, size: a.size };
      }
      parts.push({ name, positions, indices: idx, colors, attributes, extras: n.extras ?? null });
    }
    if (parts.length === 1) nodes.push(parts[0]!);
    else if (parts.length > 1) nodes.push(mergeParts(parts));
  }
  return { json, nodes, sceneExtras: json.scenes?.[0]?.extras ?? null };
}

function mergeParts(parts: readonly GlbNode[]): GlbNode {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.positions.length / 3;
    ni += p.indices.length;
  }
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(ni);
  const colors = parts.every((p) => p.colors) ? new Float32Array(nv * 4) : null;
  let ov = 0;
  let oi = 0;
  for (const p of parts) {
    positions.set(p.positions, ov * 3);
    if (colors) colors.set(p.colors!, ov * 4);
    for (let k = 0; k < p.indices.length; k++) indices[oi + k] = p.indices[k]! + ov;
    ov += p.positions.length / 3;
    oi += p.indices.length;
  }
  return { name: parts[0]!.name, positions, indices, colors, attributes: {}, extras: parts[0]!.extras };
}

/**
 * Height of the topmost triangle of `node` over (x, z), or null when none covers it. Builds a
 * coarse grid index of the node's triangles on first use (cached on the node).
 */
export function topHeightAt(node: GlbNode, x: number, z: number): number | null {
  const idx = triangleGrid(node);
  const list = idx.cells.get(cellKey(Math.floor(x / idx.size), Math.floor(z / idx.size)));
  if (!list) return null;
  let best: number | null = null;
  const P = node.positions;
  for (const t of list) {
    const a = node.indices[t * 3]! * 3;
    const b = node.indices[t * 3 + 1]! * 3;
    const c = node.indices[t * 3 + 2]! * 3;
    const y = triangleHeight(x, z, P[a]!, P[a + 1]!, P[a + 2]!, P[b]!, P[b + 1]!, P[b + 2]!, P[c]!, P[c + 1]!, P[c + 2]!);
    if (y !== null && (best === null || y > best)) best = y;
  }
  return best;
}

/** Height of the triangle's plane at (x, z) when (x, z) is inside its xz projection, else null. */
export function triangleHeight(x: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number | null {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  const e = -1e-9;
  if (l1 < e || l2 < e || l3 < e) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

const grids = new WeakMap<GlbNode, { size: number; cells: Map<number, number[]> }>();

function triangleGrid(node: GlbNode, size = 10): { size: number; cells: Map<number, number[]> } {
  const hit = grids.get(node);
  if (hit) return hit;
  const cells = new Map<number, number[]>();
  const P = node.positions;
  for (let t = 0; t < node.indices.length / 3; t++) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = node.indices[t * 3 + k]! * 3;
      x0 = Math.min(x0, P[v]!);
      x1 = Math.max(x1, P[v]!);
      z0 = Math.min(z0, P[v + 2]!);
      z1 = Math.max(z1, P[v + 2]!);
    }
    for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) {
      for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
        const key = cellKey(cx, cz);
        let l = cells.get(key);
        if (!l) cells.set(key, (l = []));
        l.push(t);
      }
    }
  }
  const g = { size, cells };
  grids.set(node, g);
  return g;
}
