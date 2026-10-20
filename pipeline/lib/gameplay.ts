// Gameplay data layers built from DataSF (all PDDL 1.0) or procedurally where no open dataset
// exists. Every layer is plain JSON in the world frame (local metres), one record per line.
// See docs/data-sources.md, "Gameplay data", for each dataset's id, licence and fallback.

import { createHash } from "node:crypto";
import { toLocal } from "../../src/geo/project.ts";
import { distToSegment, pointInRing, r2, simplifyLine, type P2 } from "./geom.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";
import type { SidewalkGraph } from "./sidewalks.ts";
import type { RawCrosswalk, RawFountain, RawMuniRoute, RawMuniStop, RawParking, RawSignal, RawStreet, RawSweep } from "./sources.ts";

const sha = (s: string, n = 10): string => createHash("sha256").update(s).digest("hex").slice(0, n);
const local = (lon: number, lat: number): P2 => {
  const p = toLocal(lat, lon);
  return [p.x, p.z];
};

/** Lines of a GeoJSON LineString / MultiLineString, in local metres. */
function lines(g: { type: string; coordinates: unknown } | undefined): P2[][] {
  if (!g) return [];
  if (g.type === "LineString") return [(g.coordinates as Array<[number, number]>).map(([lon, lat]) => local(lon, lat))];
  if (g.type === "MultiLineString") return (g.coordinates as Array<Array<[number, number]>>).map((l) => l.map(([lon, lat]) => local(lon, lat)));
  return [];
}

/** Spatial hash of road-edge segments (non-freeway) for nearest-edge queries. */
export class EdgeIndex {
  private cells = new Map<string, Array<{ e: RoadEdge; i: number }>>();
  private static readonly C = 50;
  constructor(edges: readonly RoadEdge[]) {
    for (const e of edges) {
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        for (let cx = Math.floor(Math.min(a[0], b[0]) / EdgeIndex.C); cx <= Math.floor(Math.max(a[0], b[0]) / EdgeIndex.C); cx++) {
          for (let cz = Math.floor(Math.min(a[1], b[1]) / EdgeIndex.C); cz <= Math.floor(Math.max(a[1], b[1]) / EdgeIndex.C); cz++) {
            const k = `${cx},${cz}`;
            let l = this.cells.get(k);
            if (!l) this.cells.set(k, (l = []));
            l.push({ e, i });
          }
        }
      }
    }
  }
  /** Every edge with a segment within r metres. */
  within(x: number, z: number, r: number): Set<RoadEdge> {
    const out = new Set<RoadEdge>();
    const C = EdgeIndex.C;
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
      for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
        for (const { e, i } of this.cells.get(`${cx},${cz}`) ?? []) {
          if (!out.has(e) && distToSegment(x, z, e.points[i - 1]!, e.points[i]!).d <= r) out.add(e);
        }
      }
    }
    return out;
  }

  /** Nearest edge within r metres, with the signed side of the point (R = right of a -> b). */
  nearest(x: number, z: number, r: number, accept: (e: RoadEdge) => boolean = () => true): { e: RoadEdge; d: number; side: "L" | "R" } | null {
    let best: { e: RoadEdge; d: number; side: "L" | "R" } | null = null;
    const C = EdgeIndex.C;
    for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) {
      for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) {
        for (const { e, i } of this.cells.get(`${cx},${cz}`) ?? []) {
          if (!accept(e)) continue;
          const a = e.points[i - 1]!, b = e.points[i]!;
          const s = distToSegment(x, z, a, b);
          if (s.d > r) continue;
          if (!best || s.d < best.d - 1e-9 || (Math.abs(s.d - best.d) <= 1e-9 && e.id < best.e.id)) {
            // Right of travel on a north-up map is (-dz, dx).
            const dx = b[0] - a[0], dz = b[1] - a[1];
            const side = (x - a[0]) * -dz + (z - a[1]) * dx >= 0 ? "R" : "L";
            best = { e, d: s.d, side };
          }
        }
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ signals and crosswalks

export interface Signal {
  node: string;
  x: number;
  z: number;
  y: number;
  kind: "signal" | "beacon";
  /** Pedestrian signal heads on all or some phases. */
  ped: boolean;
}

/** Working traffic signals and beacons at road-graph nodes (pending, future and speed signs are left out). */
export function buildSignals(raw: readonly RawSignal[], graph: RoadGraph): Signal[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Signal>();
  for (const s of raw) {
    const t = (s.type ?? "").toUpperCase();
    const kind = t === "SIGNAL" || t.startsWith("CALTRANS") ? "signal" : t === "BEACON" || t === "BEACON - RRFB" ? "beacon" : null;
    if (!kind || !s.cnn) continue;
    const id = `n${Math.round(Number(s.cnn))}`;
    const n = nodes.get(id);
    if (!n) continue;
    const ped = /^(ALL|SOME PHASES)$/i.test(s.ped_signal ?? "");
    const prev = out.get(id);
    if (prev && prev.kind === "signal") continue;
    out.set(id, { node: id, x: n.x, z: n.z, y: n.y, kind, ped });
  }
  return [...out.values()].sort((a, b) => (a.node < b.node ? -1 : 1));
}

/** Road nodes with a painted crosswalk (DataSF "Continental Crosswalks" lists every crosswalk it surveyed). */
export function crosswalkNodes(raw: readonly RawCrosswalk[], graph: RoadGraph): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const out = new Set<string>();
  for (const c of raw) {
    if (!c.cnn) continue;
    const id = `n${Math.round(Number(c.cnn))}`;
    if (ids.has(id)) out.add(id);
  }
  return out;
}

// ------------------------------------------------------------------ hydrants (procedural)

export const HYDRANT_SPACING_M = 120;
/** A hydrant stands at least this far outside every road's kerb line (it is on the pavement). */
export const HYDRANT_ROAD_CLEARANCE_M = 1;

export interface Hydrant {
  id: string;
  x: number;
  z: number;
  y: number;
  /** The sidewalk corner node it stands at, or the sidewalk edge it stands on. */
  at: string;
}

/**
 * No open hydrant dataset exists (the fire department's hydrant map is not on DataSF), so
 * hydrants are procedural: sidewalk corners at intersections (3+ edges), taken greedily in id
 * order when no hydrant stands within HYDRANT_SPACING_M; then points along long sidewalks so no
 * stretch of sidewalk is further than that from one. Never on water, inside a building or
 * within HYDRANT_ROAD_CLEARANCE_M of a road (roadClearance: metres outside the nearest road's
 * kerb line, negative inside it; see road-surface.ts).
 */
export function buildHydrants(
  walk: SidewalkGraph,
  degreeOf: (roadNode: string) => number,
  isLand: (x: number, z: number) => boolean,
  heightAt: (x: number, z: number) => number,
  roadClearance: (x: number, z: number) => number = () => Infinity,
): Hydrant[] {
  const ok = (x: number, z: number): boolean => roadClearance(x, z) >= HYDRANT_ROAD_CLEARANCE_M && isLand(x, z);
  const out: Hydrant[] = [];
  const grid = new Map<string, P2[]>();
  const C = HYDRANT_SPACING_M;
  const near = (x: number, z: number): boolean => {
    for (let cx = Math.floor(x / C) - 1; cx <= Math.floor(x / C) + 1; cx++) {
      for (let cz = Math.floor(z / C) - 1; cz <= Math.floor(z / C) + 1; cz++) {
        for (const [px, pz] of grid.get(`${cx},${cz}`) ?? []) if (Math.hypot(px - x, pz - z) < C) return true;
      }
    }
    return false;
  };
  const put = (x: number, z: number, at: string): void => {
    const k = `${Math.floor(x / C)},${Math.floor(z / C)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push([x, z]);
    out.push({ id: `h-${sha(at, 10)}`, x: r2(x), z: r2(z), y: r2(heightAt(x, z)), at });
  };
  for (const n of walk.nodes) {
    if (n.edge !== undefined || degreeOf(n.road) < 3 || near(n.x, n.z) || !ok(n.x, n.z)) continue;
    put(n.x, n.z, n.id);
  }
  const pos = new Map(walk.nodes.map((n) => [n.id, n]));
  for (const e of walk.edges) {
    if (e.kind !== "sidewalk" || e.lengthM < C) continue;
    const a = pos.get(e.a)!, b = pos.get(e.b)!;
    const pts: P2[] = [[a.x, a.z], ...(e.points ?? []), [b.x, b.z]];
    let s = 0;
    let next = C / 2;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!, q = pts[i]!;
      const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      while (next <= s + seg && next < e.lengthM - C / 4) {
        const t = (next - s) / seg;
        const x = p[0] + (q[0] - p[0]) * t, z = p[1] + (q[1] - p[1]) * t;
        if (!near(x, z) && ok(x, z)) put(x, z, `${e.id}@${Math.round(next)}`);
        next += C / 2;
      }
      s += seg;
    }
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

// ------------------------------------------------------------------ fountains

export interface Fountain {
  id: string;
  x: number;
  z: number;
  y: number;
  bottleFiller: boolean;
  dogBowl: boolean;
}

/** Public drinking-water points (DataSF "San Francisco Public Bathrooms and Water Fountains"). No names. */
export function buildFountains(raw: readonly RawFountain[], inWorld: (x: number, z: number) => boolean, heightAt: (x: number, z: number) => number): Fountain[] {
  const out: Fountain[] = [];
  for (const f of raw) {
    const lat = Number(f.latitude), lon = Number(f.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const [x, z] = local(lon, lat);
    if (!inWorld(x, z)) continue;
    out.push({ id: `fn-${sha(f.uid)}`, x: r2(x), z: r2(z), y: r2(heightAt(x, z)), bottleFiller: f.bottle_filler === "1", dogBowl: f.dog_fountain === "1" });
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

// ------------------------------------------------------------------ transit

export type TransitMode = "bus" | "rail" | "streetcar" | "cable";

export interface TransitRoute {
  id: string;
  /** Public line designation, e.g. "14", "N", "PH". */
  line: string;
  mode: TransitMode;
  direction: "inbound" | "outbound";
  /** Owl (night) or other non-base pattern. */
  night: boolean;
  lengthM: number;
  /** Polyline(s), local metres, simplified to 1 m. */
  paths: P2[][];
}

export interface TransitStop {
  id: string;
  x: number;
  z: number;
  y: number;
  /** Street names (public), title case. */
  on: string;
  at: string;
  /** Route ids passing within STOP_ROUTE_M. */
  routes: string[];
}

const STOP_ROUTE_M = 25;
const CABLE = new Set(["PH", "PM", "CA"]);
const RAIL = new Set(["J", "K", "L", "M", "N", "T", "S", "KT", "LOWL", "NOWL"]);

export function transitMode(lineabbr: string): TransitMode {
  if (CABLE.has(lineabbr)) return "cable";
  if (lineabbr === "F" || lineabbr === "E") return "streetcar";
  if (RAIL.has(lineabbr)) return "rail";
  return "bus";
}

const titleCase = (s: string): string =>
  s.toLowerCase().split(/\s+/).filter(Boolean).map((w) => (/^[0-9]/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");

export function buildTransit(
  routesRaw: readonly RawMuniRoute[],
  stopsRaw: readonly RawMuniStop[],
  inWorld: (x: number, z: number) => boolean,
  heightAt: (x: number, z: number) => number,
): { routes: TransitRoute[]; stops: TransitStop[] } {
  const routes: TransitRoute[] = [];
  const seen = new Map<string, number>();
  for (const r of routesRaw) {
    const paths = lines(r.shape)
      .map((l) => simplifyLine(l, 1).map(([x, z]) => [r2(x), r2(z)] as P2))
      .filter((l) => l.length >= 2);
    if (paths.length === 0) continue;
    const dir = (r.direction ?? "").toUpperCase() === "I" ? "inbound" : "outbound";
    const night = (r.pattern_type ?? "F").toUpperCase() !== "F";
    let id = `${r.lineabbr}-${dir === "inbound" ? "in" : "out"}${night ? "-owl" : ""}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}`;
    let len = 0;
    for (const p of paths) for (let i = 1; i < p.length; i++) len += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
    routes.push({ id, line: r.route_name ?? r.lineabbr, mode: transitMode(r.lineabbr), direction: dir, night, lengthM: r2(len), paths });
  }
  routes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idx = new EdgeIndex(
    routes.flatMap((r) => r.paths.map((p, k) => ({ id: `${r.id}#${k}`, a: "", b: "", kind: "other", lanes: 1, oneway: false, widthM: 0, speedLimitMps: 0, name: r.id, points: p, cnn: "", classcode: null }) as RoadEdge)),
  );
  const stops: TransitStop[] = [];
  for (const s of stopsRaw) {
    const g = s.shape?.coordinates;
    if (!g) continue;
    const [x, z] = local(g[0], g[1]);
    if (!inWorld(x, z)) continue;
    const near = new Set<string>();
    for (const e of idx.within(x, z, STOP_ROUTE_M)) near.add(e.name);
    stops.push({ id: `s${s.stopid}`, x: r2(x), z: r2(z), y: r2(heightAt(x, z)), on: titleCase(s.onstreet ?? ""), at: titleCase(s.atstreet ?? ""), routes: [...near].sort() });
  }
  stops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { routes, stops };
}

// ------------------------------------------------------------------ street cleaning

export interface CleaningRule {
  edge: string;
  /** Side of the road edge, relative to its a -> b direction in roads.json. */
  side: "L" | "R";
  /** ISO weekday 1 (Mon) .. 7 (Sun); 0 = public holidays only. */
  day: number;
  fromHour: number;
  toHour: number;
  /** Weeks of the month (1-5) the rule applies. */
  weeks: number[];
  holidays: boolean;
}

const DAYS: Record<string, number> = { mon: 1, tues: 2, tue: 2, wed: 3, thu: 4, thur: 4, fri: 5, sat: 6, sun: 7, holiday: 0 };

/** DataSF "Street Sweeping Schedule" joined to road edges by CNN; sides re-expressed for reversed one-ways. */
export function buildStreetCleaning(raw: readonly RawSweep[], streets: readonly RawStreet[], graph: RoadGraph): CleaningRule[] {
  const reversed = new Set(streets.filter((s) => (s.oneway ?? "B").toUpperCase() === "T").map((s) => s.cnn));
  const edgesByCnn = new Map<string, string[]>();
  for (const e of graph.edges) {
    let l = edgesByCnn.get(e.cnn);
    if (!l) edgesByCnn.set(e.cnn, (l = []));
    l.push(e.id);
  }
  const out: CleaningRule[] = [];
  const keys = new Set<string>();
  for (const r of raw) {
    const cnn = String(Math.round(Number(r.cnn)));
    const edges = edgesByCnn.get(cnn);
    const day = DAYS[(r.weekday ?? "").toLowerCase()];
    const lr = (r.cnnrightleft ?? "").toUpperCase();
    if (!edges || day === undefined || (lr !== "L" && lr !== "R")) continue;
    const side: "L" | "R" = reversed.has(cnn) ? (lr === "L" ? "R" : "L") : lr;
    const weeks = [r.week1, r.week2, r.week3, r.week4, r.week5].flatMap((w, i) => (w === "1" ? [i + 1] : []));
    const fromHour = Number(r.fromhour), toHour = Number(r.tohour);
    if (!Number.isFinite(fromHour) || !Number.isFinite(toHour) || weeks.length === 0) continue;
    for (const edge of edges) {
      const rule: CleaningRule = { edge, side, day, fromHour, toHour, weeks, holidays: r.holidays === "1" };
      const k = JSON.stringify(rule);
      if (keys.has(k)) continue;
      keys.add(k);
      out.push(rule);
    }
  }
  const key = (r: CleaningRule): string => JSON.stringify([r.edge, r.side, r.day, r.fromHour, r.toHour, r.weeks, r.holidays]);
  return out
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.r);
}

// ------------------------------------------------------------------ parking regulations

export interface ParkingRule {
  id: string;
  edge: string;
  side: "L" | "R";
  kind: string;
  /** ISO weekdays the rule applies (empty = not stated). */
  days: number[];
  /** Minutes after midnight; null when not stated. */
  from: number | null;
  to: number | null;
  hourLimit: number | null;
  /** Residential permit areas exempt from the limit. */
  permitAreas: string[];
  lengthM: number;
}

const PARK_MATCH_M = 25;

function parseDays(s: string | undefined): number[] {
  const t = (s ?? "").toUpperCase().replace(/\s+/g, "");
  if (t === "M-F") return [1, 2, 3, 4, 5];
  if (t === "M-SA" || t === "M-S") return [1, 2, 3, 4, 5, 6];
  if (t === "M-SU") return [1, 2, 3, 4, 5, 6, 7];
  if (t === "SA") return [6];
  if (t === "SU") return [7];
  if (t === "M,TH") return [1, 4];
  return [];
}

function parseHhmm(s: string | undefined): number | null {
  if (!s || !/^\d{1,4}$/.test(s.trim())) return null;
  const v = Number(s);
  return Math.floor(v / 100) * 60 + (v % 100);
}

export function parkingKind(reg: string | undefined): string {
  const r = (reg ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!r) return "unknown";
  if (r.startsWith("time limited")) return "time-limited";
  if (r === "paid + permit" || r === "pay or permit") return "pay-or-permit";
  return r.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^no-parking-anytime$/, "no-parking-any-time");
}

/** DataSF "Parking regulations" lines matched to the nearest street edge (by midpoint) and side. */
export function buildParking(raw: readonly RawParking[], graph: RoadGraph): ParkingRule[] {
  const idx = new EdgeIndex(graph.edges.filter((e) => e.kind !== "freeway" && e.kind !== "ramp" && !e.pedestrian));
  const out: ParkingRule[] = [];
  for (const p of raw) {
    const ls = lines(p.shape).filter((l) => l.length >= 2);
    if (ls.length === 0) continue;
    // Midpoint along the longest line.
    const l = ls.sort((a, b) => b.length - a.length)[0]!;
    let total = 0;
    for (let i = 1; i < l.length; i++) total += Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]);
    let s = 0;
    let mid: P2 = l[0]!;
    for (let i = 1; i < l.length; i++) {
      const seg = Math.hypot(l[i]![0] - l[i - 1]![0], l[i]![1] - l[i - 1]![1]);
      if (s + seg >= total / 2) {
        const t = seg > 0 ? (total / 2 - s) / seg : 0;
        mid = [l[i - 1]![0] + (l[i]![0] - l[i - 1]![0]) * t, l[i - 1]![1] + (l[i]![1] - l[i - 1]![1]) * t];
        break;
      }
      s += seg;
    }
    const hit = idx.nearest(mid[0], mid[1], PARK_MATCH_M);
    if (!hit) continue;
    const lim = Number(p.hrlimit);
    out.push({
      id: `pk-${p.objectid}`,
      edge: hit.e.id,
      side: hit.side,
      kind: parkingKind(p.regulation),
      days: parseDays(p.days),
      from: parseHhmm(p.hrs_begin),
      to: parseHhmm(p.hrs_end),
      hourLimit: Number.isFinite(lim) && lim > 0 ? lim : null,
      permitAreas: [p.rpparea1, p.rpparea2].filter((a): a is string => !!a && /^[A-Z]{1,2}$/.test(a.trim())).map((a) => a.trim()).sort(),
      lengthM: r2(total),
    });
  }
  return out.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
}

/** True when the point is inside any footprint (used to keep hydrants out of buildings). */
export function insideAny(x: number, z: number, near: (x: number, z: number) => ReadonlyArray<{ footprint: readonly P2[] }>): boolean {
  for (const b of near(x, z)) if (pointInRing(x, z, b.footprint)) return true;
  return false;
}
