// SF's neighbourhoods (DataSF "Analysis Neighborhoods", j2bu-swwd) -> districts.json, and the
// "is this point in San Francisco" test the citywide tile selection uses.
//
// Geometry only: the content track decides which districts are active (content/districts.json).
// Rings are projected to local metres, rounded to cm and simplified (Douglas–Peucker, 2 m);
// outer rings are counter-clockwise on a north-up map (negative shoelace sum in x, z, like
// building footprints) and holes clockwise. Rings are not closed (first != last).

import { toLocal } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import { cleanRing, clipSegment, dropCollinear, isSimpleRing, pointInRing, r2, signedArea, simplifyRing, type P2 } from "./geom.ts";
import type { RawNeighborhood } from "./sources.ts";

export const DISTRICT_SIMPLIFY_M = 2;

export interface District {
  /** Stable slug of the DataSF name, e.g. "financial-district-south-beach". */
  id: string;
  name: string;
  /** MultiPolygon: polygons[p][0] is the outer ring, polygons[p][1..] are holes. */
  polygons: P2[][][];
  bbox: [number, number, number, number];
  areaM2: number;
  /** Built tiles the district overlaps, sorted. */
  tiles: string[];
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Project and simplify; a tolerance that makes the ring self-intersect is halved until it does not. */
function projectRing(ring: Array<[number, number]>): P2[] {
  const local = cleanRing(ring.map(([lon, lat]) => {
    const p = toLocal(lat, lon);
    return [p.x, p.z] as P2;
  }));
  for (let tol = DISTRICT_SIMPLIFY_M; tol >= 0.1; tol /= 2) {
    const s = dropCollinear(cleanRing(simplifyRing(local, tol)), 0.05);
    if (isSimpleRing(s)) return s;
  }
  return local;
}

/** Districts from the raw neighbourhoods, sorted by id. Tiles are filled in by assignTiles(). */
export function buildDistricts(raw: readonly RawNeighborhood[]): District[] {
  const out: District[] = [];
  for (const n of raw) {
    const g = n.the_geom;
    if (!g) continue;
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Array<Array<Array<[number, number]>>>;
    const polygons: P2[][][] = [];
    let area = 0;
    for (const poly of polys) {
      const rings: P2[][] = [];
      poly.forEach((r, i) => {
        const ring = projectRing(r);
        if (ring.length < 3 || Math.abs(signedArea(ring)) < 1) return;
        const outer = i === 0;
        // Outer: negative shoelace (CCW on a north-up map); holes the other way.
        if ((signedArea(ring) > 0) === outer) ring.reverse();
        if (!outer && rings.length === 0) return; // a hole whose outer ring vanished
        rings.push(ring);
        area += outer ? Math.abs(signedArea(ring)) : -Math.abs(signedArea(ring));
      });
      if (rings.length > 0) polygons.push(rings);
    }
    if (polygons.length === 0) continue;
    polygons.sort((a, b) => Math.abs(signedArea(b[0]!)) - Math.abs(signedArea(a[0]!)));
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of polygons) for (const [x, z] of p[0]!) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    out.push({ id: slug(n.nhood), name: n.nhood, polygons, bbox: [r2(minX), r2(minZ), r2(maxX), r2(maxZ)], areaM2: Math.round(area), tiles: [] });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < out.length; i++) if (out[i]!.id === out[i - 1]!.id) throw new Error(`districts: duplicate id ${out[i]!.id}`);
  return out;
}

export function inPolygon(x: number, z: number, poly: readonly P2[][]): boolean {
  if (!pointInRing(x, z, poly[0]!)) return false;
  for (let h = 1; h < poly.length; h++) if (pointInRing(x, z, poly[h]!)) return false;
  return true;
}

/** Which district contains a point (bbox prefilter), or null. */
export class DistrictIndex {
  private readonly ds: readonly District[];
  constructor(ds: readonly District[]) {
    this.ds = ds;
  }
  at(x: number, z: number): District | null {
    for (const d of this.ds) {
      const b = d.bbox;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      for (const p of d.polygons) if (inPolygon(x, z, p)) return d;
    }
    return null;
  }
}

/** True if any part of the polygon set overlaps the tile rectangle. */
function overlapsTile(d: District, t: TileRef): boolean {
  const b = d.bbox;
  const tb = t.bbox;
  if (b[2] < tb[0] || b[0] > tb[2] || b[3] < tb[1] || b[1] > tb[3]) return false;
  for (const poly of d.polygons) {
    const outer = poly[0]!;
    // A ring vertex inside the tile, a ring edge crossing it, or a tile corner inside the polygon.
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i]!;
      const c = outer[(i + 1) % outer.length]!;
      if (clipSegment(a, c, tb)) return true;
    }
    const corners: P2[] = [[tb[0], tb[1]], [tb[2], tb[1]], [tb[0], tb[3]], [tb[2], tb[3]]];
    if (corners.some(([x, z]) => inPolygon(x, z, poly))) return true;
  }
  return false;
}

export function assignTiles(ds: District[], tiles: readonly TileRef[]): void {
  for (const d of ds) d.tiles = tiles.filter((t) => overlapsTile(d, t)).map((t) => t.id).sort();
}
