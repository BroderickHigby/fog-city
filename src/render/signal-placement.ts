// Fill missing rendered heads from the same controlled approaches used by the cars.
// Runs once at street-detail admission; source records and simulation data stay unchanged.
import type { BuildingCollider, TileCollider } from "../sim/world.ts";
import type { TrafficSignalControls } from "../sim/traffic-signals.ts";
import { pointAt, polylineLength, roadHalfWidth, sidewalkWidth } from "./roads.ts";
import type { SignalRecord } from "./street-furniture.ts";
import type { GroundFn, RoadEdge, RoadGraph } from "./types.ts";

type Point = readonly [number, number];
type Bounds = [number, number, number, number];
type Obstacle = { kind: "road"; a: Point; b: Point; radius: number }
  | { kind: "building"; building: BuildingCollider }
  | { kind: "pole"; x: number; z: number };
const CELL = 64, SEARCH_M = 48, POLE_RADIUS = .35;
const key = (x: number, z: number): string => `${x},${z}`;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const validPoint = (p: Point): boolean => p.length === 2 && p.every(v => Number.isFinite(v) && Math.abs(v) <= 100_000);
const edgeValid = (e: RoadEdge): boolean => e.points.length >= 2 && e.points.length <= 20_000 && e.points.every(validPoint)
  && e.points.some((p, i) => i > 0 && Math.hypot(p[0] - e.points[i - 1]![0], p[1] - e.points[i - 1]![1]) > .01)
  && Number.isFinite(roadHalfWidth(e)) && roadHalfWidth(e) > 0 && roadHalfWidth(e) < 100;
const pedestrian = (e: RoadEdge): boolean => Boolean((e as RoadEdge & { pedestrian?: boolean }).pedestrian);

export interface SignalPlacementOptions {
  roads?: RoadGraph | null;
  controls?: TrafficSignalControls;
  ground: GroundFn;
  colliders?: ReadonlyMap<string, TileCollider>;
}
export interface MissingSignal {
  node: string;
  edge: string;
  reason: "missing-road" | "unsupported-approach" | "no-safe-position";
}
export interface SignalSupplement {
  signals: SignalRecord[];
  unplaced: MissingSignal[];
}

function distanceToSegment(x: number, z: number, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
  const t = length2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length2)) : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function insideBuilding(x: number, z: number, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    if (distanceToSegment(x, z, a, b) <= POLE_RADIUS) return true;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Return only additions, with explicit reasons for approaches that cannot be placed safely. */
export function supplementalSignals(existing: readonly SignalRecord[], opts: SignalPlacementOptions): SignalSupplement {
  const result: SignalSupplement = { signals: [], unplaced: [] };
  if (!opts.roads || !opts.controls?.size) return result;
  const graph = opts.roads, nodes = new Map(graph.nodes.map(n => [n.id, n])), edges = new Map(graph.edges.map(e => [e.id, e]));
  const ids = new Set(existing.map(s => s.id));
  const missing = [...opts.controls.values()].sort((a, b) => compare(a.node, b.node)).flatMap(control =>
    [...control.approaches.entries()].sort(([a], [b]) => compare(a, b)).filter(([edge]) => !ids.has(`sig:${control.node}:${edge}`))
      .map(([edge, group]) => ({ node: control.node, edge, group })));
  if (!missing.length) return result;
  // Only index neighbourhoods with absent heads; most city furniture is already authored.
  const wanted = new Set<string>(), cells: Array<[number, number]> = [];
  for (const item of missing) {
    const n = nodes.get(item.node);
    if (!n || !validPoint([n.x, n.z])) continue;
    for (let x = Math.floor((n.x - 160) / CELL); x <= Math.floor((n.x + 160) / CELL); x++)
      for (let z = Math.floor((n.z - 160) / CELL); z <= Math.floor((n.z + 160) / CELL); z++) {
        const k = key(x, z); if (!wanted.has(k)) { wanted.add(k); cells.push([x, z]); }
      }
  }
  const buckets = new Map<string, Obstacle[]>();
  const add = (obstacle: Obstacle, [x0, z0, x1, z1]: Bounds): void => {
    const ax = Math.floor(x0 / CELL), az = Math.floor(z0 / CELL), bx = Math.floor(x1 / CELL), bz = Math.floor(z1 / CELL);
    const insert = (x: number, z: number): void => {
      const k = key(x, z); if (!wanted.has(k)) return;
      const bucket = buckets.get(k); if (bucket) bucket.push(obstacle); else buckets.set(k, [obstacle]);
    };
    if ((bx - ax + 1) * (bz - az + 1) > 4096) {
      for (const [x, z] of cells) if (x >= ax && x <= bx && z >= az && z <= bz) insert(x, z);
    } else for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) insert(x, z);
  };
  const halfAtNode = new Map<string, number>();
  for (const e of graph.edges) {
    if (!edgeValid(e) || pedestrian(e)) continue;
    const radius = roadHalfWidth(e) + POLE_RADIUS;
    for (const node of [e.a, e.b]) halfAtNode.set(node, Math.max(halfAtNode.get(node) ?? 0, roadHalfWidth(e)));
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!, b = e.points[i]!;
      add({ kind: "road", a, b, radius }, [Math.min(a[0], b[0]) - radius, Math.min(a[1], b[1]) - radius,
        Math.max(a[0], b[0]) + radius, Math.max(a[1], b[1]) + radius]);
    }
  }
  for (const tile of opts.colliders?.values() ?? []) for (const building of tile.buildings) {
    if (building.footprint.length < 3 || building.footprint.length > 20_000 || !building.footprint.every(validPoint)) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of building.footprint) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    add({ kind: "building", building }, [x0 - POLE_RADIUS, z0 - POLE_RADIUS, x1 + POLE_RADIUS, z1 + POLE_RADIUS]);
  }
  const addPole = (p: SignalRecord): void => {
    if (validPoint([p.x, p.z])) add({ kind: "pole", x: p.x, z: p.z }, [p.x - 1, p.z - 1, p.x + 1, p.z + 1]);
  };
  existing.forEach(addPole);
  const clear = (x: number, y: number, z: number): boolean => {
    for (const obstacle of buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      if (obstacle.kind === "road" && distanceToSegment(x, z, obstacle.a, obstacle.b) <= obstacle.radius) return false;
      if (obstacle.kind === "pole" && Math.hypot(x - obstacle.x, z - obstacle.z) < 1) return false;
      if (obstacle.kind === "building") {
        const b = obstacle.building;
        if (b.topY < y || b.baseY > y + 5 || b.underY !== undefined && b.underY >= y + 5) continue;
        if (insideBuilding(x, z, b.footprint)) return false;
      }
    }
    return true;
  };
  for (const item of missing) {
    const e = edges.get(item.edge), n = nodes.get(item.node);
    if (!e || !n) { result.unplaced.push({ ...item, reason: "missing-road" }); continue; }
    if (!edgeValid(e) || !validPoint([n.x, n.z]) || pedestrian(e) || e.kind === "freeway" || e.kind === "ramp"
      || e.a === e.b || !(e.b === n.id || e.a === n.id && !e.oneway)) {
      result.unplaced.push({ ...item, reason: "unsupported-approach" }); continue;
    }
    const points = e.a === n.id ? e.points : [...e.points].reverse(), half = roadHalfWidth(e);
    if (Math.hypot(points[0]![0] - n.x, points[0]![1] - n.z) > 5) {
      result.unplaced.push({ ...item, reason: "unsupported-approach" }); continue;
    }
    const from = Math.max(6, (halfAtNode.get(n.id) ?? half) + .8), to = Math.min(SEARCH_M, polylineLength(points) - 1);
    let placed: SignalRecord | undefined;
    for (let t = from; t <= to && !placed; t += 1) {
      const p = pointAt(points, t);
      for (const offset of [.8, 1.3, 1.8].filter(v => v < sidewalkWidth(e))) {
        const x = Math.round((p.x + p.dz * (half + offset)) * 100) / 100;
        const z = Math.round((p.z - p.dx * (half + offset)) * 100) / 100;
        const y = opts.ground(x, z);
        if (!Number.isFinite(y) || y <= .1 || !clear(x, y, z)) continue;
        const heading = (Math.atan2(p.dx, -p.dz) + Math.PI * 2) % (Math.PI * 2);
        // The legacy display field is binary; the head reads its actual group from controls.
        placed = { id: `sig:${n.id}:${e.id}`, node: n.id, x, z, heading, group: item.group === 0 ? 0 : 1, arm: 0, ped: null };
        result.signals.push(placed); addPole(placed); break;
      }
    }
    if (!placed) result.unplaced.push({ ...item, reason: "no-safe-position" });
  }
  return result;
}
