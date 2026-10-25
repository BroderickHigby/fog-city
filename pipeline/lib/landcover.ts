// Land cover and barriers for the street-detail layers: grass (lawns, meadows, playing fields),
// fences, walls and hedges, and piers. Render-only (no colliders).
//
// Sources, kept apart by licence:
//   - DataSF (PDDL 1.0): Recreation and Parks "Functional Areas" (38b7-6db3) Lawn,
//     Non-landscaped Greenspace and Natural Area polygons; "Linear Assets" (rny7-88gk) Fence and
//     Gate lines. -> street-landcover.json
//   - OpenStreetMap (ODbL 1.0, © OpenStreetMap contributors), the pinned SF extract: grass
//     (landuse=grass|meadow|village_green, landcover=grass, natural=grassland, leisure=pitch on
//     grass), barriers (fence, wall, retaining_wall, hedge, guard_rail), piers (man_made=pier). Fort Mason's Great
//     Meadow, the Presidio and other non-city land are only in OSM. -> street-osm.json, which is
//     a derivative database under the ODbL.
//
// Polygons are clipped to CELL_M squares (so the renderer streams them by cell and a huge park
// never becomes one mesh); outer rings counter-clockwise on a north-up map, holes clockwise.

import { toLocal } from "../../src/geo/project.ts";
import { clipToConvex, signedArea, simplifyLine, type P2 } from "./geom.ts";
import type { OsmData } from "./osm-pbf.ts";

export const CELL_M = 100;

export type GrassKind = "lawn" | "meadow" | "pitch" | "natural";
export type BarrierKind = "fence" | "wall" | "hedge" | "rail";

export interface GrassPiece {
  id: string;
  kind: GrassKind;
  /** Outer ring, then holes: flat [x, z, ...] arrays in local metres. */
  rings: number[][];
}

export interface Barrier {
  id: string;
  kind: BarrierKind;
  /** Height, metres. */
  h: number;
  pts: number[];
}

export interface Pier {
  id: string;
  /** Deck outline (area piers) or centreline with width (linear piers). */
  ring?: number[];
  line?: number[];
  width?: number;
  floating: boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const flat = (ring: readonly P2[]): number[] => ring.flatMap(([x, z]) => [r2(x), r2(z)]);

const local = (lon: number, lat: number): P2 => {
  const p = toLocal(lat, lon);
  return [p.x, p.z];
};

/** Drop a closing duplicate and points closer than 5 cm. */
function tidy(ring: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= 0.05) out.pop();
  return out;
}

/** Orient a ring: counter-clockwise on a north-up map (+x east, +z south) when `outer`. */
function orient(ring: P2[], outer: boolean): P2[] {
  // signedArea > 0 is counter-clockwise in x/z with z down the page, i.e. clockwise on a north-up map.
  const ccwNorthUp = signedArea(ring) < 0;
  return ccwNorthUp === outer ? ring : [...ring].reverse();
}

/** Clip a polygon (outer + holes) to the CELL_M grid; one piece per non-empty cell. */
export function clipToCells(id: string, kind: GrassKind, outer: P2[], holes: P2[][], out: GrassPiece[]): void {
  if (outer.length < 3) return;
  const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1]);
  for (let cx = Math.floor(Math.min(...xs) / CELL_M); cx <= Math.floor(Math.max(...xs) / CELL_M); cx++) {
    for (let cz = Math.floor(Math.min(...zs) / CELL_M); cz <= Math.floor(Math.max(...zs) / CELL_M); cz++) {
      const x0 = cx * CELL_M, z0 = cz * CELL_M;
      const box: P2[] = [[x0, z0], [x0 + CELL_M, z0], [x0 + CELL_M, z0 + CELL_M], [x0, z0 + CELL_M]];
      const o = tidy(clipToConvex(outer, box));
      if (o.length < 3 || Math.abs(signedArea(o)) < 1) continue;
      const hs = holes.map((h) => tidy(clipToConvex(h, box))).filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= 0.5);
      out.push({ id: `${id}@${cx},${cz}`, kind, rings: [flat(orient(o, true)), ...hs.map((h) => flat(orient(h, false)))] });
    }
  }
}

type Geo = { type: string; coordinates: unknown };

/** Polygons of a GeoJSON (Multi)Polygon: [outer, ...holes] in local metres. */
function polygonsOf(g: Geo | undefined): P2[][][] {
  if (!g) return [];
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
  return polys.map((poly) => poly.map((ring) => tidy(ring.map(([lon, lat]) => local(lon!, lat!)))));
}

/** Lines of a GeoJSON (Multi)LineString in local metres. */
function linesOf(g: Geo | undefined): P2[][] {
  if (!g) return [];
  const lines = g.type === "LineString" ? [g.coordinates as number[][]] : g.type === "MultiLineString" ? (g.coordinates as number[][][]) : [];
  return lines.map((l) => l.map(([lon, lat]) => local(lon!, lat!)));
}

export interface RpdRows {
  areas: Array<{ funcarea_id?: string; objectid?: string; functional_area_type?: string; shape?: Geo }>;
  linear: Array<{ asset_id?: string; objectid?: string; asset_type?: string; asset_subtype?: string; shape?: Geo }>;
}

/** Lawns and fences from the Recreation and Parks datasets (DataSF). */
export function rpdLandcover(rows: RpdRows): { grass: GrassPiece[]; barriers: Barrier[] } {
  const grass: GrassPiece[] = [];
  const kinds: Record<string, GrassKind> = { Lawn: "lawn", "Non-landscaped Greenspace": "meadow", "Natural Area": "natural" };
  const areas = [...rows.areas].sort((a, b) => Number(a.objectid ?? 0) - Number(b.objectid ?? 0));
  for (const r of areas) {
    const kind = kinds[r.functional_area_type ?? ""];
    if (!kind) continue;
    polygonsOf(r.shape).forEach((poly, i) => clipToCells(`rpd:${r.funcarea_id ?? r.objectid}:${i}`, kind, poly[0]!, poly.slice(1), grass));
  }
  const barriers: Barrier[] = [];
  const linear = [...rows.linear].sort((a, b) => Number(a.objectid ?? 0) - Number(b.objectid ?? 0));
  const seen = new Set<string>();
  for (const r of linear) {
    const t = r.asset_type ?? "";
    if (t !== "Fence" && t !== "Gate") continue;
    const id = `rpd:${r.asset_id ?? r.objectid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const sub = (r.asset_subtype ?? "").toLowerCase();
    linesOf(r.shape).forEach((line, i) => {
      const pts = simplifyLine(line, 0.2);
      if (pts.length >= 2) barriers.push({ id: `${id}:${i}`, kind: "fence", h: sub.includes("split rail") ? 1.1 : sub.includes("wood") ? 1.5 : 1.8, pts: flat(pts) });
    });
  }
  return { grass, barriers };
}

/** OSM tags of the grass, barrier and pier features this producer keeps. */
export const OSM_FILTER = {
  way: (t: Record<string, string>): boolean => grassKind(t) !== null || barrierKind(t) !== null || t.man_made === "pier",
  relation: (t: Record<string, string>): boolean => t.type === "multipolygon" && grassKind(t) !== null,
};

export function grassKind(t: Record<string, string>): GrassKind | null {
  if (t.landuse === "grass" || t.landuse === "village_green" || t.landcover === "grass") return "lawn";
  if (t.landuse === "meadow") return "meadow";
  if (t.natural === "grassland") return "natural";
  if (t.leisure === "pitch" && (t.surface === "grass" || t.surface === undefined)) return "pitch";
  return null;
}

export function barrierKind(t: Record<string, string>): BarrierKind | null {
  switch (t.barrier) {
    case "fence":
      return "fence";
    case "wall":
    case "retaining_wall":
      return "wall";
    case "hedge":
      return "hedge";
    case "guard_rail":
      return "rail";
    default:
      return null;
  }
}

const DEFAULT_H: Record<BarrierKind, number> = { fence: 1.5, wall: 1.2, hedge: 1.3, rail: 0.8 };

function heightOf(t: Record<string, string>, kind: BarrierKind): number {
  const h = parseFloat(t.height ?? "");
  if (Number.isFinite(h) && h > 0.3 && h < 6) return Math.round(h * 10) / 10;
  // A retaining wall shows as a low parapet above the higher ground.
  return t.barrier === "retaining_wall" ? 0.8 : DEFAULT_H[kind];
}

/** Grass, barriers and piers from an OSM extract, ids `osm:w<way>` / `osm:r<relation>`. */
export function osmLandcover(osm: OsmData): { grass: GrassPiece[]; barriers: Barrier[]; piers: Pier[] } {
  const grass: GrassPiece[] = [];
  const barriers: Barrier[] = [];
  const piers: Pier[] = [];
  const wayPts = (refs: readonly number[]): P2[] | null => {
    const out: P2[] = [];
    for (const r of refs) {
      const n = osm.nodes.get(r);
      if (!n) return null;
      out.push(local(n[0], n[1]));
    }
    return out;
  };
  const ways = [...osm.ways].sort((a, b) => a.id - b.id);
  const byId = new Map(ways.map((w) => [w.id, w]));
  for (const w of ways) {
    const pts = wayPts(w.refs);
    if (!pts || pts.length < 2) continue;
    const closed = w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
    const gk = grassKind(w.tags);
    if (gk && closed) clipToCells(`osm:w${w.id}`, gk, tidy(pts), [], grass);
    const bk = barrierKind(w.tags);
    if (bk) {
      const line = simplifyLine(pts, 0.15);
      if (line.length >= 2) barriers.push({ id: `osm:w${w.id}`, kind: bk, h: heightOf(w.tags, bk), pts: flat(line) });
    }
    if (w.tags.man_made === "pier") {
      const floating = w.tags.floating === "yes";
      if (closed && w.tags.area !== "no") piers.push({ id: `osm:w${w.id}`, ring: flat(orient(tidy(pts), true)), floating });
      else {
        const width = parseFloat(w.tags.width ?? "");
        piers.push({ id: `osm:w${w.id}`, line: flat(simplifyLine(pts, 0.1)), width: Number.isFinite(width) && width > 0.5 && width < 40 ? width : floating ? 1.8 : 3, floating });
      }
    }
  }
  // Multipolygon relations: outer and inner rings joined from their member ways.
  for (const rel of [...osm.relations].sort((a, b) => a.id - b.id)) {
    const kind = grassKind(rel.tags);
    if (!kind) continue;
    const outers = joinRings(rel.members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => byId.get(m.ref)?.refs ?? []), wayPts);
    const inners = joinRings(rel.members.filter((m) => m.type === "way" && m.role === "inner").map((m) => byId.get(m.ref)?.refs ?? []), wayPts);
    outers.forEach((o, i) => clipToCells(`osm:r${rel.id}:${i}`, kind, o, inners, grass));
  }
  return { grass, barriers, piers };
}

/** Join member ways (node-id lists) end to end into closed rings. */
function joinRings(parts: number[][], wayPts: (refs: readonly number[]) => P2[] | null): P2[][] {
  const left = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: P2[][] = [];
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i]!;
        const end = ring[ring.length - 1]!;
        if (p[0] === end) ring = ring.concat(p.slice(1));
        else if (p[p.length - 1] === end) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length > 3 && ring[0] === ring[ring.length - 1]) {
      const pts = wayPts(ring);
      if (pts) rings.push(tidy(pts));
    }
  }
  return rings;
}
