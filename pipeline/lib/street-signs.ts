// Street-name blades, one-way signs and kerbside parking signs from SFMTA Street Signs
// (m48z-6ji4), placed on the junction paint (street-markings.ts) and the road graph.
// Render-only (no colliders).
//
//   - Corner signs (STREET NAME, ONE WAY): the row names the node (`cnn`) and the corner
//     ("NORTH EAST CORNER, ..."). All the rows on one corner share one post, standing on the
//     sidewalk off the kerb return between the two legs nearest that compass corner. A blade
//     lies along the street it names (matched by name to a leg); a one-way sign lies along the
//     one-way leg named by `streetname`, its arrow pointing the way the traffic flows.
//   - Junctions with two or more street names and no STREET NAME row get one inferred post (the
//     dataset covers part of the city): blades for every name, on the corner nearest north-east.
//   - Kerbside signs (STREET CLEANING, PARKING, PARKING:RPP, PARKING:NPRK ANY TIME, TOW): the row
//     names the block (`cnn` = road edge) and the side ("EAST SIDE"); the post stands on that
//     side's sidewalk at the row's point projected onto the block, facing along the street.
//     Legends are not reproduced; each sign shows its kind's generic face.
//
// Ids: `corner:<node>:<k>` (k = the corner's index clockwise from the first leg) and
// `curb:<objectid>`, stable across rebuilds.

import { toLocal } from "../../src/geo/project.ts";
import { bearing, type P2 } from "./geom.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";
import { offStreet, streetIndex } from "./street-furniture.ts";
import type { Junction, JunctionLeg } from "./street-markings.ts";

/** From the kerb to a post, metres. */
export const POST_OFFSET_M = 1.0;
/** At most this many blades on one post. */
const MAX_BLADES = 3;

export type CurbKind = "cleaning" | "permit" | "time" | "noParking" | "tow";

export interface CornerPost {
  id: string;
  node: string;
  x: number;
  z: number;
  /** Street names as signed (DataSF legend, or the road name in capitals when inferred), each lying along `heading`. */
  blades: Array<{ name: string; heading: number }>;
  /** One-way arrows: compass bearing the arrow points (the traffic's direction). */
  oneWay: number[];
  /** True when no STREET NAME row covers this junction (placed from the road names). */
  inferred: boolean;
}

export interface CurbSign {
  id: string;
  x: number;
  z: number;
  /** Compass bearing the sign faces (along the street). */
  heading: number;
  kind: CurbKind;
}

export interface SignRow {
  objectid?: string;
  sign_category?: string;
  legend?: string;
  streetname?: string;
  corner_side_facing?: string;
  cnn?: string;
  shape?: { type: "Point"; coordinates: [number, number] };
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

const COMPASS: Record<string, number> = { NORTH: 0, EAST: Math.PI / 2, SOUTH: Math.PI, WEST: (3 * Math.PI) / 2 };

const CORNERS: Record<string, number> = { "NORTH EAST": Math.PI / 4, "SOUTH EAST": (3 * Math.PI) / 4, "SOUTH WEST": (5 * Math.PI) / 4, "NORTH WEST": (7 * Math.PI) / 4 };

/** "NORTH EAST CORNER, WESTBOUND TRAFFIC" -> bearing of the corner (π/4); null when there is none. */
export function cornerBearing(text: string | undefined): number | null {
  const m = /^(NORTH|SOUTH)\s+(EAST|WEST)\s+CORNER/.exec((text ?? "").toUpperCase().trim());
  return m ? CORNERS[`${m[1]} ${m[2]}`]! : null;
}

/** "EAST SIDE" -> bearing of that side; null otherwise. */
export function sideBearing(text: string | undefined): number | null {
  const m = /^(NORTH|SOUTH|EAST|WEST)\s+SIDE/.exec((text ?? "").toUpperCase().trim());
  return m ? COMPASS[m[1]!]! : null;
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * The post spot on corner k (between leg k and the next leg clockwise): where the two legs'
 * lines offset to the sidewalk (half + POST_OFFSET_M) cross, or, for a flat or reflex corner,
 * just off leg k's kerb at its mouth.
 */
function cornerSpot(j: Junction, k: number): P2 {
  const a = j.legs[k]!, b = j.legs[(k + 1) % j.legs.length]!;
  const oa = a.half + POST_OFFSET_M, ob = b.half + POST_OFFSET_M;
  // a: (ox, oz) + oa r_a + t u_a ; b: (ox, oz) - ob r_b + s u_b ; r = (-uz, ux)
  const cx = b.ox + ob * b.uz - (a.ox - oa * a.uz);
  const cz = b.oz - ob * b.ux - (a.oz + oa * a.ux);
  const det = a.ux * -b.uz - a.uz * -b.ux;
  const gap = (((bearing(b.ux, b.uz) - bearing(a.ux, a.uz)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (Math.abs(det) > 0.2 && gap < (160 * Math.PI) / 180) {
    const t = (cx * -b.uz - cz * -b.ux) / det;
    if (t > 0 && t < a.mouth + 6) return [j.x + a.ox + a.ux * t - a.uz * oa, j.z + a.oz + a.uz * t + a.ux * oa];
  }
  const t = a.mouth;
  return [j.x + a.ox + a.ux * t - a.uz * oa, j.z + a.oz + a.uz * t + a.ux * oa];
}

/** The corner whose spot lies nearest the compass bearing `b` from the node. */
function nearestCorner(j: Junction, b: number): number {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < j.legs.length; k++) {
    const p = cornerSpot(j, k);
    const d = angleDiff(bearing(p[0] - j.x, p[1] - j.z), b);
    if (d < bestD - 1e-9) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

export function buildStreetSigns(
  graph: RoadGraph,
  junctions: readonly Junction[],
  rows: readonly SignRow[],
): { corners: CornerPost[]; curb: CurbSign[]; stats: { cornerRows: number; curbRows: number; unplaced: number; inferred: number } } {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const byNode = new Map(junctions.map((j) => [j.id, j]));
  const legEdge = (l: JunctionLeg): RoadEdge => edges.get(l.edge)!;
  const nearby = streetIndex(graph);
  // A corner post steps out from the node, away from the streets, until it is on the sidewalk.
  const clear = (j: Junction, p: P2): P2 | null => {
    const dx = p[0] - j.x, dz = p[1] - j.z;
    const d = Math.hypot(dx, dz) || 1;
    for (let s = 0; s < 12; s += 0.25) {
      const q: P2 = [p[0] + (dx / d) * s, p[1] + (dz / d) * s];
      if (offStreet(nearby, q[0], q[1])) return q;
    }
    return null;
  };
  const posts = new Map<string, CornerPost>();
  const curb: CurbSign[] = [];
  const named = new Set<string>();
  let cornerRows = 0, curbRows = 0, unplaced = 0;

  const sorted = [...rows].sort((p, q) => Number(p.objectid ?? 0) - Number(q.objectid ?? 0));
  for (const r of sorted) {
    const cat = (r.sign_category ?? "").toUpperCase();
    if (cat === "STREET NAME" || cat.startsWith("ONE WAY")) {
      const j = r.cnn ? byNode.get(`n${Math.round(Number(r.cnn))}`) : undefined;
      const cb = cornerBearing(r.corner_side_facing);
      if (!j || cb === null) {
        unplaced++;
        continue;
      }
      const k = nearestCorner(j, cb);
      const id = `corner:${j.id}:${k}`;
      let post = posts.get(id);
      if (!post) {
        const p = clear(j, cornerSpot(j, k));
        if (!p) {
          unplaced++;
          continue;
        }
        posts.set(id, (post = { id, node: j.id, x: r2(p[0]), z: r2(p[1]), blades: [], oneWay: [], inferred: false }));
      }
      if (cat === "STREET NAME") {
        const name = norm(r.legend ?? "");
        if (!name || post.blades.some((b) => b.name === name) || post.blades.length >= MAX_BLADES) continue;
        // Lie along the leg the legend names; else across the post's first leg.
        const leg = j.legs.find((l) => norm(legEdge(l).name).startsWith(name.split(" ")[0]!) && norm(legEdge(l).name) === name)
          ?? j.legs.find((l) => norm(legEdge(l).name).startsWith(name.split(" ")[0]!));
        const along = leg ?? j.legs[k]!;
        post.blades.push({ name, heading: r4(bearing(along.ux, along.uz) % Math.PI) });
        named.add(j.id);
      } else {
        // The one-way leg: named by `streetname`, one-way, at this node.
        const street = norm(r.streetname ?? "");
        const leg = j.legs.find((l) => legEdge(l).oneway && norm(legEdge(l).name) === street) ?? j.legs.find((l) => legEdge(l).oneway);
        if (!leg) {
          unplaced++;
          continue;
        }
        const e = legEdge(leg);
        // Traffic flows a -> b: away from the node when the node is a.
        const away = e.a === j.id;
        const h = r4(bearing(away ? leg.ux : -leg.ux, away ? leg.uz : -leg.uz));
        if (!post.oneWay.some((o) => angleDiff(o, h) < 0.3) && post.oneWay.length < 2) post.oneWay.push(h);
      }
      cornerRows++;
      continue;
    }
    // Kerbside signs.
    const kind: CurbKind | null =
      cat === "STREET CLEANING" ? "cleaning" : cat === "PARKING:RPP" ? "permit" : cat === "PARKING" ? "time" : cat === "PARKING:NPRK ANY TIME" ? "noParking" : cat.startsWith("TOW") ? "tow" : null;
    const e = r.cnn ? edges.get(`c${Math.round(Number(r.cnn))}`) : undefined;
    const side = sideBearing(r.corner_side_facing);
    if (!kind || !e || side === null || !r.shape) {
      unplaced++;
      continue;
    }
    const [lon, lat] = r.shape.coordinates;
    const p = toLocal(lat, lon);
    const f = project(e.points, p.x, p.z);
    if (!f) {
      unplaced++;
      continue;
    }
    // The normal toward the named side.
    let nx = -f.tz, nz = f.tx;
    if (angleDiff(bearing(nx, nz), side) > Math.PI / 2) {
      nx = -nx;
      nz = -nz;
    }
    let off = e.widthM / 2 + POST_OFFSET_M * 0.6;
    while (off < e.widthM / 2 + 6 && !offStreet(nearby, f.x + nx * off, f.z + nz * off)) off += 0.25;
    if (!offStreet(nearby, f.x + nx * off, f.z + nz * off)) {
      unplaced++;
      continue;
    }
    curb.push({ id: `curb:${r.objectid}`, x: r2(f.x + nx * off), z: r2(f.z + nz * off), heading: r4(bearing(f.tx, f.tz)), kind });
    curbRows++;
  }

  // Junctions the dataset does not cover: one inferred post with every name meeting there.
  let inferred = 0;
  for (const j of junctions) {
    if (named.has(j.id)) continue;
    const names = new Map<string, JunctionLeg>();
    for (const l of j.legs) {
      const e = legEdge(l);
      if (e.kind === "alley" || !e.name) continue;
      const n = norm(e.name);
      if (!names.has(n)) names.set(n, l);
    }
    if (names.size < 2) continue;
    const k = nearestCorner(j, Math.PI / 4);
    const id = `corner:${j.id}:${k}`;
    let post = posts.get(id);
    if (!post) {
      const p = clear(j, cornerSpot(j, k));
      if (!p) continue;
      posts.set(id, (post = { id, node: j.id, x: r2(p[0]), z: r2(p[1]), blades: [], oneWay: [], inferred: true }));
    }
    for (const [name, l] of [...names].slice(0, MAX_BLADES)) post.blades.push({ name, heading: r4(bearing(l.ux, l.uz) % Math.PI) });
    inferred++;
  }
  const corners = [...posts.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  curb.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return { corners, curb, stats: { cornerRows, curbRows, unplaced, inferred } };
}

/** Nearest point on a polyline to (x, z), with the unit tangent there. */
function project(pts: readonly P2[], x: number, z: number): { x: number; z: number; tx: number; tz: number } | null {
  let best: { x: number; z: number; tx: number; tz: number; d: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez;
    if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2));
    const px = a[0] + ex * t, pz = a[1] + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) {
      const l = Math.sqrt(l2);
      best = { x: px, z: pz, tx: ex / l, tz: ez / l, d };
    }
  }
  return best && best.d < 60 ? best : null;
}
