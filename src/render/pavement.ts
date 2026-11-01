// Shared pavement exclusion for park tint and grass. Read-only geometry, built once
// from the road graph and building footprints; no renderer or per-frame scene work.
import type { TileCollider } from "../sim/world.ts";
import { roadHalfWidth, sidewalkWidth } from "./roads.ts";
import type { RoadGraph } from "./types.ts";

type Point = readonly [number, number];
type Bounds = readonly [number, number, number, number];
interface Polygon { points: readonly Point[]; bounds: Bounds }

export interface PavementMask {
  contains(x: number, z: number): boolean;
  intersectsTriangle(a: Point, b: Point, c: Point): boolean;
  addPolygon(points: ReadonlyArray<Point>): void;
  polygonsIn(bounds: Bounds): ReadonlyArray<readonly Point[]>;
}

const CELL_M = 100;
const MAX_BUCKETS = 4096;
const MAX_COORDINATE = 100000;
const EPSILON = 1e-7;
const key = (x: number, z: number): string => `${x},${z}`;
const finite = (p: Point): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= MAX_COORDINATE && Math.abs(p[1]) <= MAX_COORDINATE;
const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const overlaps = (a: Bounds, b: Bounds): boolean => a[0] <= b[2] + EPSILON && a[2] + EPSILON >= b[0] && a[1] <= b[3] + EPSILON && a[3] + EPSILON >= b[1];

function bounds(points: readonly Point[]): Bounds {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0, z0, x1, z1];
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  const tolerance = EPSILON * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
  return Math.abs(cross(a, b, p)) <= tolerance && p[0] >= Math.min(a[0], b[0]) - EPSILON && p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON && p[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) && ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function inPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!;
    if (onSegment(a, b, p)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  if (onSegment(a, b, p) || onSegment(b, c, p) || onSegment(c, a, p)) return true;
  if (Math.abs(cross(a, b, c)) <= EPSILON) return false;
  const x = cross(a, b, p), y = cross(b, c, p), z = cross(c, a, p);
  return (x > 0 && y > 0 && z > 0) || (x < 0 && y < 0 && z < 0);
}

class IndexedPavement implements PavementMask {
  private readonly buckets = new Map<string, Polygon[]>();
  private readonly polygons: Polygon[] = [];
  private readonly large: Polygon[] = [];
  private readonly regions: readonly Bounds[] | undefined;
  private readonly regionBuckets = new Map<string, Bounds[]>();
  private readonly largeRegions: Bounds[] = [];

  constructor(regions?: readonly Bounds[]) {
    this.regions = regions?.filter(b => b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3])
      .map(b => [b[0], b[1], b[2], b[3]] as const);
    for (const b of this.regions ?? []) {
      const [x0,z0,x1,z1] = this.cellBounds(b);
      if((x1-x0+1)*(z1-z0+1)>MAX_BUCKETS){this.largeRegions.push(b);continue;}
      for (let x=x0; x<=x1; x++) for (let z=z0; z<=z1; z++) {
        const k=key(x,z), list=this.regionBuckets.get(k);
        if(list) list.push(b); else this.regionBuckets.set(k,[b]);
      }
    }
  }

  addPolygon(input: ReadonlyArray<Point>): void {
    if (input.length < 3 || input.length > 20000 || !input.every(finite)) return;
    const box = bounds(input);
    // Park tint only needs nearby pavement. Reject whole-city roads/buildings before
    // copying their vertices or allocating buckets; late junctions obey the same limit.
    if (this.regions && !this.inRegion(box)) return;
    const points: Point[] = [];
    for (const p of input) if (!points.length || !same(points.at(-1)!, p)) points.push([p[0], p[1]]);
    if (points.length > 1 && same(points[0]!, points.at(-1)!)) points.pop();
    if (points.length < 3) return;
    let twiceArea = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i]!, b = points[(i + 1) % points.length]!; twiceArea += a[0] * b[1] - b[0] * a[1]; }
    if (Math.abs(twiceArea) <= EPSILON) return;
    const polygon = { points, bounds: box };
    this.polygons.push(polygon);
    const [x0, z0, x1, z1] = this.cellBounds(polygon.bounds);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_BUCKETS) { this.large.push(polygon); return; }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = key(x, z), list = this.buckets.get(k);
      if (list) list.push(polygon); else this.buckets.set(k, [polygon]);
    }
  }

  contains(x: number, z: number): boolean {
    const p: Point = [x, z];
    if (!finite(p)) return false;
    // Point queries dominate park-vertex tinting; avoid constructing a candidate Set
    // and arrays for every vertex. Polygon buckets already include their boundaries.
    for (const polygon of this.buckets.get(key(Math.floor(x / CELL_M), Math.floor(z / CELL_M))) ?? []) {
      if (inPolygon(p, polygon.points)) return true;
    }
    for (const polygon of this.large) if (inPolygon(p, polygon.points)) return true;
    return false;
  }

  /** Read-only candidates for exact lawn clipping; holes and concave buildings stay intact. */
  polygonsIn(box: Bounds): ReadonlyArray<readonly Point[]> {
    return this.candidates(box).map(p => p.points);
  }

  private inRegion(box: Bounds): boolean {
    if(this.largeRegions.some(r=>overlaps(r,box))) return true;
    const [x0,z0,x1,z1]=this.cellBounds(box);
    if((x1-x0+1)*(z1-z0+1)>MAX_BUCKETS) return this.regions!.some(r=>overlaps(r,box));
    for(let x=x0;x<=x1;x++) for(let z=z0;z<=z1;z++) {
      if(this.regionBuckets.get(key(x,z))?.some(r=>overlaps(r,box))) return true;
    }
    return false;
  }

  intersectsTriangle(a: Point, b: Point, c: Point): boolean {
    if (!finite(a) || !finite(b) || !finite(c)) return false;
    const triangle = [a, b, c] as const;
    for (const polygon of this.candidates(bounds(triangle))) {
      if (triangle.some(p => inPolygon(p, polygon.points)) || polygon.points.some(p => inTriangle(p, a, b, c))) return true;
      for (let i = 0; i < polygon.points.length; i++) {
        const p = polygon.points[i]!, q = polygon.points[(i + 1) % polygon.points.length]!;
        if (segmentsIntersect(a, b, p, q) || segmentsIntersect(b, c, p, q) || segmentsIntersect(c, a, p, q)) return true;
      }
    }
    return false;
  }

  private cellBounds(box: Bounds): Bounds {
    return [Math.floor((box[0] - EPSILON) / CELL_M), Math.floor((box[1] - EPSILON) / CELL_M), Math.floor((box[2] + EPSILON) / CELL_M), Math.floor((box[3] + EPSILON) / CELL_M)];
  }

  private candidates(box: Bounds): Polygon[] {
    const [x0, z0, x1, z1] = this.cellBounds(box);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_BUCKETS) return this.polygons.filter(p => overlaps(box, p.bounds));
    const found = new Set(this.large);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const p of this.buckets.get(key(x, z)) ?? []) found.add(p);
    return [...found].filter(p => overlaps(box, p.bounds));
  }
}

export function createPavementMask(roads: RoadGraph | null | undefined, colliders?: ReadonlyMap<string, TileCollider>, regions?: readonly Bounds[]): PavementMask {
  const mask = new IndexedPavement(regions);
  const junctions = new Map<string, { count: number; halfWidth: number }>();
  for (const edge of roads?.edges ?? []) {
    const width = roadHalfWidth(edge) + sidewalkWidth(edge) + .25;
    if (!Number.isFinite(width) || width <= 0 || width > 1000) continue;
    if (edge.points.length < 2 || edge.points.length > 20000 || !edge.points.every(finite)) continue;
    if (!edge.points.some((p, i) => i > 0 && Math.hypot(p[0] - edge.points[i - 1]![0], p[1] - edge.points[i - 1]![1]) >= .01)) continue;
    for (const id of [edge.a, edge.b]) {
      const junction = junctions.get(id);
      if (junction) { junction.count++; junction.halfWidth = Math.max(junction.halfWidth, width); }
      else junctions.set(id, { count: 1, halfWidth: width });
    }
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1]!, b = edge.points[i]!;
      if (!finite(a) || !finite(b)) continue;
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length < .01) continue;
      const tx = dx / length, tz = dz / length, nx = -tz * width, nz = tx * width;
      const ax = a[0] - tx * width, az = a[1] - tz * width, bx = b[0] + tx * width, bz = b[1] + tz * width;
      mask.addPolygon([[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]);
    }
  }
  for (const node of roads?.nodes ?? []) {
    const junction = junctions.get(node.id);
    if (!junction || junction.count < 2 || !finite([node.x, node.z])) continue;
    const r = junction.halfWidth * 2;
    mask.addPolygon([[node.x - r, node.z - r], [node.x + r, node.z - r], [node.x + r, node.z + r], [node.x - r, node.z + r]]);
  }
  for (const tile of colliders?.values() ?? []) for (const building of tile.buildings) mask.addPolygon(building.footprint);
  return mask;
}
