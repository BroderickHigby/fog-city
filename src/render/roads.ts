// Road graph helpers for drawing: widths, per-tile assignment, intersection trims and
// where street furniture goes. Pure and deterministic (tests/render/roads.test.ts).

import { rand01 } from "./hash.ts";
import { distanceToBounds, type TileBounds } from "./tile-select.ts";
import type { RoadEdge, RoadGraph } from "./types.ts";

export const LANE_M = 3.3;

/** Half the paved width (kerb to kerb). */
export function roadHalfWidth(e: Pick<RoadEdge, "widthM" | "lanes" | "kind">): number {
  if (typeof e.widthM === "number" && e.widthM > 0) return e.widthM / 2;
  const lanes = Math.max(1, e.lanes | 0);
  const parking = e.kind === "residential" || e.kind === "collector" || e.kind === "arterial" ? 2 * 2.4 : 0;
  return (lanes * LANE_M + parking) / 2;
}

/** Sidewalk width on each side; 0 where there is none. */
export function sidewalkWidth(e: Pick<RoadEdge, "kind">): number {
  switch (e.kind) {
    case "freeway":
    case "ramp":
      return 0;
    case "alley":
      return 0.8;
    case "arterial":
      return 4;
    default:
      return 3;
  }
}

export function nodeDegrees(g: Pick<RoadGraph, "edges">): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of g.edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  return deg;
}

/**
 * For each node, the largest road half-width among its edges. An edge's markings stop this
 * far (plus a margin) from an intersection so they never paint across the crossing street.
 */
export function nodeClearance(g: Pick<RoadGraph, "edges">): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of g.edges) {
    const w = roadHalfWidth(e) + sidewalkWidth(e);
    out.set(e.a, Math.max(out.get(e.a) ?? 0, w));
    out.set(e.b, Math.max(out.get(e.b) ?? 0, w));
  }
  return out;
}

/** For each node, the largest carriageway half-width among its edges (the intersection box). */
export function nodeHalfWidth(g: Pick<RoadGraph, "edges">): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of g.edges) {
    const w = roadHalfWidth(e);
    out.set(e.a, Math.max(out.get(e.a) ?? 0, w));
    out.set(e.b, Math.max(out.get(e.b) ?? 0, w));
  }
  return out;
}

/** Node elevations given by the graph (bridges, viaducts). */
export function nodeElevations(g: Pick<RoadGraph, "nodes">): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of g.nodes) if (typeof n.y === "number" && Number.isFinite(n.y)) out.set(n.id, n.y);
  return out;
}

export function polylineLength(pts: ReadonlyArray<readonly [number, number]>): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Point and unit direction at arc length s along a polyline (clamped to its ends). */
export function pointAt(
  pts: ReadonlyArray<readonly [number, number]>,
  s: number,
): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 1e-9) continue;
    if (acc + len >= s || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, (s - acc) / len));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / len, dz: (b[1] - a[1]) / len };
    }
    acc += len;
  }
  const p = pts[0] ?? [0, 0];
  return { x: p[0], z: p[1], dx: 0, dz: -1 };
}

/** The point halfway along an edge's polyline. */
export function edgeMidpoint(e: Pick<RoadEdge, "points">): [number, number] {
  const p = pointAt(e.points, polylineLength(e.points) / 2);
  return [p.x, p.z];
}

/**
 * Give every edge to exactly one tile: the tile whose rectangle contains the edge's midpoint,
 * else the nearest tile. Uses a coarse grid so it stays fast for a whole city.
 */
export function assignEdgesToTiles(edges: readonly RoadEdge[], bounds: readonly TileBounds[]): Map<string, RoadEdge[]> {
  const out = new Map<string, RoadEdge[]>();
  for (const b of bounds) out.set(b.id, []);
  if (bounds.length === 0) return out;
  const CELL = 250;
  const grid = new Map<string, TileBounds[]>();
  for (const b of bounds) {
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
      for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
        const k = `${cx},${cz}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(b);
      }
    }
  }
  for (const e of edges) {
    if (!e.points || e.points.length < 2) continue;
    const [mx, mz] = edgeMidpoint(e);
    let best: TileBounds | null = null;
    let bestD = Infinity;
    for (const b of grid.get(`${Math.floor(mx / CELL)},${Math.floor(mz / CELL)}`) ?? []) {
      const d = distanceToBounds(b, mx, mz);
      if (d < bestD || (d === bestD && best !== null && b.id < best.id)) {
        best = b;
        bestD = d;
      }
    }
    if (!best || bestD > 0) {
      for (const b of bounds) {
        const d = distanceToBounds(b, mx, mz);
        if (d < bestD || (d === bestD && best !== null && b.id < best.id)) {
          best = b;
          bestD = d;
        }
      }
    }
    out.get(best!.id)!.push(e);
  }
  return out;
}

export interface Spot {
  x: number;
  z: number;
  /** Compass heading the prop faces (towards the road for lamps). */
  heading: number;
  /** 0..1 per-prop variation. */
  v: number;
}

function headingOf(dx: number, dz: number): number {
  // Compass bearing of direction (dx, dz): clockwise from north (-z).
  return Math.atan2(dx, -dz);
}

/**
 * Streetlight positions: every `spacing` metres along each edge, alternating sides, at the
 * kerb. None on freeways, ramps or alleys, none closer than `clearance` to an intersection.
 */
export function streetlightSpots(
  edges: readonly RoadEdge[],
  clearance: ReadonlyMap<string, number>,
  spacing = 34,
): Spot[] {
  const out: Spot[] = [];
  for (const e of edges) {
    if (e.kind === "freeway" || e.kind === "ramp" || e.kind === "alley") continue;
    const L = polylineLength(e.points);
    const s0 = (clearance.get(e.a) ?? 0) + 3;
    const s1 = L - (clearance.get(e.b) ?? 0) - 3;
    if (s1 <= s0) continue;
    const off = roadHalfWidth(e) + 0.7;
    const n = Math.max(1, Math.floor((s1 - s0) / spacing) + 1);
    const step = n > 1 ? (s1 - s0) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const s = n > 1 ? s0 + i * step : (s0 + s1) / 2;
      const p = pointAt(e.points, s);
      const side = (i + (rand01(e.id) < 0.5 ? 0 : 1)) % 2 === 0 ? 1 : -1;
      // Right-hand normal of the direction (dx, dz) in the x/z plane is (-dz, dx).
      const nx = -p.dz * side;
      const nz = p.dx * side;
      out.push({ x: p.x + nx * off, z: p.z + nz * off, heading: headingOf(-nx, -nz), v: rand01(e.id, i) });
    }
  }
  return out;
}

/**
 * Street trees on both sidewalks of residential and collector streets, with gaps near
 * intersections and around streetlights. Deterministic per edge id.
 */
export function streetTreeSpots(
  edges: readonly RoadEdge[],
  clearance: ReadonlyMap<string, number>,
  spacing = 15,
  density = 0.6,
): Spot[] {
  const out: Spot[] = [];
  for (const e of edges) {
    if (e.kind !== "residential" && e.kind !== "collector") continue;
    const sw = sidewalkWidth(e);
    if (sw < 2) continue;
    const L = polylineLength(e.points);
    const s0 = (clearance.get(e.a) ?? 0) + 6;
    const s1 = L - (clearance.get(e.b) ?? 0) - 6;
    if (s1 <= s0) continue;
    const off = roadHalfWidth(e) + sw * 0.55;
    let k = 0;
    for (let s = s0 + spacing * 0.5; s <= s1; s += spacing) {
      for (const side of [1, -1]) {
        k++;
        if (rand01(e.id, 1000 + k) > density) continue;
        // Keep clear of the lamp rhythm (every 34 m starting at s0 - 3).
        const p = pointAt(e.points, s + (rand01(e.id, 2000 + k) - 0.5) * 3);
        out.push({ x: p.x - p.dz * side * off, z: p.z + p.dx * side * off, heading: rand01(e.id, 3000 + k) * Math.PI * 2, v: rand01(e.id, 4000 + k) });
      }
    }
  }
  return out;
}
