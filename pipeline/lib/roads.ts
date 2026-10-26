// Street centerlines (DataSF 3psu-pn9h) -> the world road graph (schemas/roads.schema.json).
//
// Nodes are the centerline network's intersection CNNs (f_node_cnn / t_node_cnn), placed at
// the mean of the segment endpoints that name them. Edges are segments; a one-way segment
// is oriented so traffic flows a -> b. See docs/data-sources.md for the classcode mapping.

import { toLocal } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import { r2, type P2 } from "./geom.ts";
import type { RawStreet } from "./sources.ts";

export type RoadKind = "freeway" | "arterial" | "collector" | "residential" | "alley" | "ramp" | "other";

export interface RoadNode {
  id: string;
  x: number;
  z: number;
  y: number;
}

export interface RoadEdge {
  id: string;
  a: string;
  b: string;
  kind: RoadKind;
  lanes: number;
  oneway: boolean;
  widthM: number;
  speedLimitMps: number;
  name: string;
  points: P2[];
  /** Source segment (DataSF CNN) and classcode, for tracing back. */
  cnn: string;
  classcode: number | null;
  /** Pedestrian-only street (layer STREETS_PEDESTRI): not for vehicles. */
  pedestrian?: boolean;
  /**
   * A freeway (classcode 1): limited access, crossing other streets on a viaduct, in a cut
   * or in a tunnel. The source has no deck heights, so its points and node y are the ground
   * under it, not the roadway. Surface traffic should not be routed onto it.
   */
  gradeSeparated?: boolean;
  /** Part of the edge crosses open water (the Bay Bridge approach): a deck the source gives no height for. */
  bridge?: boolean;
}

export interface RoadGraph {
  version: 1;
  attribution: string;
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** Layers that are not real, open streets. */
export const EXCLUDED_LAYERS = new Set(["PAPER", "PAPER_FWYS", "PAPER_WATER", "PRIVATE_PARKING", "PSEUDO", "UPROW"]);

const MPH = 0.44704;

/** classcode -> kind. 2 (major street/highway) and 3 (arterial) are both "arterial". */
export function kindOf(classcode: number | null, stType: string | undefined, layer: string | undefined): RoadKind {
  if (layer === "STREETS_PEDESTRI") return "other";
  const alley = stType === "AL" || stType === "ALY";
  switch (classcode) {
    case 1: return "freeway";
    case 6: return "ramp";
    case 2: case 3: return "arterial";
    case 4: return "collector";
    case 5: return alley ? "alley" : "residential";
    case 0: return alley ? "alley" : "other";
    default: return alley ? "alley" : "other";
  }
}

/** Total lanes on the edge (all directions), widths (kerb to kerb incl. parking) and limits. */
export const KIND_TABLE: Record<RoadKind, { lanesTwoWay: number; lanesOneWay: number; laneM: number; extraM: number; mph: number }> = {
  freeway: { lanesTwoWay: 6, lanesOneWay: 3, laneM: 3.6, extraM: 3.0, mph: 50 },
  ramp: { lanesTwoWay: 2, lanesOneWay: 1, laneM: 3.8, extraM: 2.0, mph: 35 },
  arterial: { lanesTwoWay: 4, lanesOneWay: 3, laneM: 3.3, extraM: 4.8, mph: 25 },
  collector: { lanesTwoWay: 2, lanesOneWay: 2, laneM: 3.3, extraM: 4.8, mph: 25 },
  residential: { lanesTwoWay: 2, lanesOneWay: 1, laneM: 3.2, extraM: 4.6, mph: 25 },
  alley: { lanesTwoWay: 1, lanesOneWay: 1, laneM: 4.0, extraM: 0.5, mph: 15 },
  other: { lanesTwoWay: 2, lanesOneWay: 1, laneM: 3.0, extraM: 0.5, mph: 15 },
};

function nodeCnn(v: string | undefined): string | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `n${Math.round(n)}`;
}

/** "THE EMBARCADERO" -> "The Embarcadero", "03RD ST" -> "3rd St" (DataSF zero-pads numbered streets). */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[0-9]/.test(w) ? w.replace(/^0+(?=\d)/, "") : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/** True when the polyline has a stretch (two consecutive samples ~10 m apart) over water. */
function crossesWater(points: readonly P2[], waterAt: (x: number, z: number) => boolean): boolean {
  let prev = false;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      const w = waterAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
      if (w && prev) return true;
      prev = w;
    }
  }
  return false;
}

function lineStrings(line: RawStreet["line"]): Array<Array<[number, number]>> {
  if (!line) return [];
  const c = line.coordinates as unknown;
  if (line.type === "LineString") return [c as Array<[number, number]>];
  if (line.type === "MultiLineString") return c as Array<Array<[number, number]>>;
  return [];
}

function inWorld(p: P2, tiles: TileRef[]): boolean {
  for (const t of tiles) if (p[0] >= t.bbox[0] && p[0] <= t.bbox[2] && p[1] >= t.bbox[1] && p[1] <= t.bbox[3]) return true;
  return false;
}

export interface RoadStats {
  raw: number;
  excludedLayer: number;
  outside: number;
  degenerate: number;
  edges: number;
  nodes: number;
  synthesizedNodes: number;
  byKind: Record<string, number>;
  /** Edges flagged bridge (a stretch over open water). */
  bridges: number;
  components: number;
  largestComponentNodes: number;
}

/**
 * heightAt: ground height in metres at a local point (the sim's ground inside the world, the
 * DEM outside); waterAt: whether the ground there is open water.
 */
export function buildRoads(
  raw: RawStreet[],
  tiles: TileRef[],
  heightAt: (x: number, z: number) => number,
  waterAt: (x: number, z: number) => boolean = () => false,
): { graph: RoadGraph; stats: RoadStats } {
  const stats: RoadStats = {
    raw: raw.length, excludedLayer: 0, outside: 0, degenerate: 0, edges: 0, nodes: 0, synthesizedNodes: 0,
    byKind: {}, bridges: 0, components: 0, largestComponentNodes: 0,
  };
  interface Pending { seg: RawStreet; part: number; pts: P2[]; fNode: string; tNode: string }
  const pending: Pending[] = [];
  const endpointSums = new Map<string, { x: number; z: number; n: number }>();
  const addEnd = (id: string, p: P2): void => {
    const s = endpointSums.get(id) ?? { x: 0, z: 0, n: 0 };
    s.x += p[0];
    s.z += p[1];
    s.n++;
    endpointSums.set(id, s);
  };

  const sorted = [...raw].sort((a, b) => Number(a.cnn) - Number(b.cnn));
  for (const seg of sorted) {
    if (EXCLUDED_LAYERS.has(seg.layer ?? "")) {
      stats.excludedLayer++;
      continue;
    }
    const parts = lineStrings(seg.line);
    parts.forEach((ls, part) => {
      const pts: P2[] = [];
      for (const [lon, lat] of ls) {
        const p = toLocal(lat, lon);
        const q: P2 = [r2(p.x), r2(p.z)];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      if (pts.length < 2) {
        stats.degenerate++;
        return;
      }
      // Keep a segment if any point along it lies in the world's tiles.
      let inside = false;
      for (let i = 0; i < pts.length && !inside; i++) {
        if (inWorld(pts[i]!, tiles)) inside = true;
        if (i > 0) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          if (inWorld([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], tiles)) inside = true;
        }
      }
      if (!inside) {
        stats.outside++;
        return;
      }
      const single = parts.length === 1;
      const synth = (p: P2): string => {
        stats.synthesizedNodes++;
        return `p${Math.round(p[0])}_${Math.round(p[1])}`;
      };
      const fNode = (single ? nodeCnn(seg.f_node_cnn) : null) ?? synth(pts[0]!);
      const tNode = (single ? nodeCnn(seg.t_node_cnn) : null) ?? synth(pts[pts.length - 1]!);
      addEnd(fNode, pts[0]!);
      addEnd(tNode, pts[pts.length - 1]!);
      pending.push({ seg, part, pts, fNode, tNode });
    });
  }

  const nodes = new Map<string, RoadNode>();
  for (const id of [...endpointSums.keys()].sort()) {
    const s = endpointSums.get(id)!;
    const x = r2(s.x / s.n);
    const z = r2(s.z / s.n);
    nodes.set(id, { id, x, z, y: r2(heightAt(x, z)) });
  }

  const edges: RoadEdge[] = [];
  for (const { seg, part, pts, fNode, tNode } of pending) {
    const classcode = seg.classcode !== undefined && seg.classcode !== "" ? Number(seg.classcode) : null;
    const kind = kindOf(classcode, seg.st_type, seg.layer);
    const ow = (seg.oneway ?? "B").toUpperCase();
    const oneway = ow === "F" || ow === "T";
    let a = fNode;
    let b = tNode;
    let points = pts.map((p) => [p[0], p[1]] as P2);
    if (ow === "T") {
      a = tNode;
      b = fNode;
      points.reverse();
    }
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    points[0] = [na.x, na.z];
    points[points.length - 1] = [nb.x, nb.z];
    // Snapping can make the first/last interior points coincide with the ends.
    points = points.filter((p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1]);
    if (points.length < 2) {
      points = [[na.x, na.z], [nb.x, nb.z]];
    }
    const t = KIND_TABLE[kind];
    const lanes = oneway ? t.lanesOneWay : t.lanesTwoWay;
    const e: RoadEdge = {
      id: part === 0 ? `c${seg.cnn}` : `c${seg.cnn}-${part}`,
      a,
      b,
      kind,
      lanes,
      oneway,
      widthM: r2(lanes * t.laneM + t.extraM),
      speedLimitMps: r2(t.mph * MPH),
      name: titleCase(seg.streetname ?? [seg.street, seg.st_type].filter(Boolean).join(" ")),
      points,
      cnn: seg.cnn,
      classcode,
    };
    if (seg.layer === "STREETS_PEDESTRI") e.pedestrian = true;
    if (kind === "freeway") e.gradeSeparated = true;
    if (crossesWater(points, waterAt)) {
      e.bridge = true;
      stats.bridges++;
    }
    edges.push(e);
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  }
  edges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // Connectivity (undirected) for the report.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const id of nodes.keys()) parent.set(id, id);
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const sizes = new Map<string, number>();
  for (const id of nodes.keys()) {
    const r = find(id);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  stats.components = sizes.size;
  stats.largestComponentNodes = Math.max(0, ...sizes.values());
  stats.edges = edges.length;
  stats.nodes = nodes.size;

  return {
    graph: {
      version: 1,
      attribution: "Street centerlines: City and County of San Francisco, DataSF (3psu-pn9h), ODC PDDL 1.0",
      nodes: [...nodes.values()],
      edges,
    },
    stats,
  };
}
