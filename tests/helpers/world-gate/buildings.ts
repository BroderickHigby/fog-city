// Gate suite A: buildings and landmarks (docs/qa/world-continuity-gate.md, section A).
// Reads the collider records with their metadata, the collider pack's world, report.json, the
// GLBs' facade attributes and content/landmarks.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RoadSurface, trafficEdges } from "../../../pipeline/lib/road-surface.ts";
import type { RoadEdge as PipelineRoadEdge } from "../../../pipeline/lib/roads.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { circleTouchesPolygon, closestOnBoundary, groundHeight, nearbyBuildings, pointInPolygon, type BuildingCollider } from "../../../src/sim/index.ts";
import { ROOT, readJson } from "../../helpers.ts";
import {
  bbox,
  centroid,
  colliderRecords,
  forRasterInside,
  ll,
  r2,
  r3,
  readGlb,
  resample,
  surfaceAt,
  type GameWorld,
  type SfRecord,
} from "../world.ts";
import { Measured } from "./measured.ts";

const FIX = join(ROOT, "tests/helpers/world-gate/fixtures");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;
const local = (lat: number, lon: number): { x: number; z: number } => toLocal(lat, lon);

/** Published heights (metres above the street) of towers the 2010 LiDAR missed or must keep (W-04). */
export const PUBLISHED: ReadonlyArray<{ name: string; lat: number; lon: number; m: number }> = [
  { name: "Salesforce Tower", lat: 37.78971, lon: -122.39701, m: 326 },
  { name: "Transamerica Pyramid", lat: 37.79518, lon: -122.40278, m: 260 },
  { name: "555 California St", lat: 37.7921, lon: -122.4037, m: 237 },
  { name: "One Rincon Hill", lat: 37.78585, lon: -122.39235, m: 188 },
  { name: "250 Howard St (roof)", lat: 37.790398, lon: -122.394263, m: 167.6 },
  { name: "The Avery", lat: 37.787902, lon: -122.39436, m: 188 },
  { name: "706 Mission St (roof)", lat: 37.785971, lon: -122.40322, m: 146 },
  { name: "33 Tehama St", lat: 37.78726, lon: -122.396264, m: 120 },
  { name: "Fifteen Fifty (1550 Mission St)", lat: 37.77355, lon: -122.41767, m: 116 },
];

/** Landmark records and assets (W-16, W-24 to W-27). */
const FORT_POINT = "201006.0000856";
const COIT = "201006.0006230";
/** Records this close to Sutro Tower are its plinths and equipment buildings (W-26). */
const SUTRO_AREA_M = 60;
const SUTRO_AT = { lat: 37.7552, lon: -122.4528 };
/** report.json probes that are hero landmarks: each needs a model or an interim shape with no office window grid (W-27). */
const HERO_PROBES = ["600-montgomery", "coit-tower", "saints-peter-and-paul", "palace-of-fine-arts", "city-hall", "grace-cathedral", "mission-dolores", "conservatory-of-flowers"];
/** Hero landmarks with no footprint record: each needs a landmarks.json entry (W-27). */
const HERO_MODELS_ONLY = ["dragon-gate", "sutro-baths"];

interface Landmark {
  id: string;
  model: string;
  lat: number;
  lon: number;
  scale?: number;
  replacesBuildingIds?: string[];
}

/** Height of a landmark model's top above its origin, metres (the GLB's POSITION max, scaled). */
async function modelTopM(l: Landmark): Promise<number> {
  const g = await readGlb(join(ROOT, "public", l.model));
  let top = 0;
  for (const n of g.nodes) for (let k = 1; k < n.positions.length; k += 3) top = Math.max(top, n.positions[k]!);
  return top * (l.scale ?? 1);
}

function landmarks(): Landmark[] {
  return readJson<{ landmarks: Landmark[] }>("content/landmarks.json").landmarks;
}

/** The facade code the GLB draws each building with: storey height (m) and glazing, by record id. */
export async function drawnFacades(gw: GameWorld, tiles?: ReadonlySet<string>): Promise<Map<string, { storeyM: number; glazing: number }>> {
  const out = new Map<string, { storeyM: number; glazing: number }>();
  for (const t of gw.manifest.tiles) {
    if (!t.glb || (tiles && !tiles.has(t.id))) continue;
    const g = await readGlb(`public/tiles/${gw.name}/${t.glb}`, ["buildings"], ["_FACADE"]);
    const node = g.nodes[0];
    if (!node) continue;
    const ranges = (node.extras?.buildings ?? []) as Array<[string, number, number]>;
    const fac = node.attributes._FACADE;
    if (!fac) continue;
    for (const [id, first] of ranges) {
      const v = node.indices[first]!;
      out.set(id, { storeyM: fac.data[v * fac.size]! * 8, glazing: fac.data[v * fac.size + 1]! });
    }
  }
  return out;
}

/**
 * Ground under a footprint: the highest ground on a 1 m raster inside it (cell centres; the QA's
 * interior raster), and the min and max over that raster and the footprint's vertices (relief).
 */
function groundRange(gw: GameWorld, fp: ReadonlyArray<readonly [number, number]>): { min: number; max: number; insideMax: number } {
  let min = Infinity;
  let max = -Infinity;
  let insideMax = -Infinity;
  forRasterInside(fp, 1, (x, z) => {
    const h = groundHeight(gw.world, x, z);
    if (h < min) min = h;
    if (h > max) max = h;
    if (h > insideMax) insideMax = h;
  });
  for (const [x, z] of fp) {
    const h = groundHeight(gw.world, x, z);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max, insideMax };
}

/** Minimum ground along a footprint's walls, sampled every 0.5 m. */
function minGroundAlongWalls(gw: GameWorld, fp: ReadonlyArray<readonly [number, number]>): number {
  let min = Infinity;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [ax, az] = fp[j]!;
    const [bx, bz] = fp[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let k = 0; k <= n; k++) min = Math.min(min, groundHeight(gw.world, ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n));
  }
  return min;
}

/** Does the ring cross itself (two non-adjacent edges meet)? */
export function selfIntersects(fp: ReadonlyArray<readonly [number, number]>): boolean {
  const n = fp.length;
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  for (let i = 0; i < n; i++) {
    const a = fp[i]!;
    const b = fp[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = fp[j]!;
      const d = fp[(j + 1) % n]!;
      const d1 = cross(c[0], c[1], d[0], d[1], a[0], a[1]);
      const d2 = cross(c[0], c[1], d[0], d[1], b[0], b[1]);
      const d3 = cross(a[0], a[1], b[0], b[1], c[0], c[1]);
      const d4 = cross(a[0], a[1], b[0], b[1], d[0], d[1]);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

/**
 * Overlapping footprint pairs on a 0.5 m raster per tile (the QA's buildings/05-overlaps method):
 * a record's own podium/tower partner is excluded. Duplicates: overlap of at least 90% of the
 * smaller footprint. Coplanar roofs: overlap of 2 m2 or more with roofs within 0.1 m (z-fighting).
 */
function overlaps(recs: readonly SfRecord[]): { duplicates: Array<[string, string]>; coplanar: Array<[string, string]> } {
  const idx = new Map(recs.map((r, i) => [r.id, i]));
  const area = recs.map((r) => {
    let a = 0;
    const fp = r.footprint;
    for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) a += fp[j]![0] * fp[i]![1] - fp[i]![0] * fp[j]![1];
    return Math.abs(a) / 2;
  });
  const bbs = recs.map((r) => bbox(r.footprint));
  const C = 0.5;
  const N = 1000;
  const byTile = new Map<string, number[]>();
  recs.forEach((_, i) => {
    const b = bbs[i]!;
    for (let tx = Math.floor(b[0] / 500); tx <= Math.floor(b[2] / 500); tx++) {
      for (let tz = Math.floor(b[1] / 500); tz <= Math.floor(b[3] / 500); tz++) {
        const k = `${tx},${tz}`;
        let l = byTile.get(k);
        if (!l) byTile.set(k, (l = []));
        l.push(i);
      }
    }
  });
  const owner = new Int32Array(N * N);
  const pairs = new Map<string, number>();
  for (const k of [...byTile.keys()].sort()) {
    const list = byTile.get(k)!;
    const [tx, tz] = k.split(",").map(Number) as [number, number];
    owner.fill(-1);
    for (const i of list) {
      const r = recs[i]!;
      const fp = r.footprint;
      const b = bbs[i]!;
      const partner = r.meta.tower ? idx.get(r.meta.tower) : r.meta.towerOf ? idx.get(r.meta.towerOf) : -2;
      const k0 = Math.max(0, Math.floor((b[1] - tz * 500) / C));
      const k1 = Math.min(N - 1, Math.floor((b[3] - tz * 500) / C));
      for (let kk = k0; kk <= k1; kk++) {
        const z = tz * 500 + (kk + 0.5) * C;
        const xs: number[] = [];
        for (let a = 0, p = fp.length - 1; a < fp.length; p = a++) {
          const [x1, z1] = fp[p]!;
          const [x2, z2] = fp[a]!;
          if (z1 > z !== z2 > z) xs.push(x1 + ((z - z1) * (x2 - x1)) / (z2 - z1));
        }
        xs.sort((u, v) => u - v);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((xs[q]! - tx * 500) / C - 0.5));
          const i1 = Math.min(N - 1, Math.floor((xs[q + 1]! - tx * 500) / C - 0.5));
          for (let ii = i0; ii <= i1; ii++) {
            const c = kk * N + ii;
            const o = owner[c]!;
            if (o === -1) {
              owner[c] = i;
              continue;
            }
            if (o === partner || o === i) continue;
            const key = o < i ? `${o},${i}` : `${i},${o}`;
            pairs.set(key, (pairs.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }
  const duplicates: Array<[string, string]> = [];
  const coplanar: Array<[string, string]> = [];
  for (const [key, cells] of [...pairs].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
    const ov = cells * C * C;
    if (ov < 1) continue;
    const [i, j] = key.split(",").map(Number) as [number, number];
    const a = recs[i]!;
    const b = recs[j]!;
    if (ov / Math.min(area[i]!, area[j]!) >= 0.9) duplicates.push([a.id, b.id]);
    if (Math.abs(a.topY - b.topY) < 0.1 && ov >= 2) coplanar.push([a.id, b.id]);
  }
  return { duplicates, coplanar };
}

/** The tallest record whose footprint holds (x, z) or lies within r metres: its height above the ground at the point. */
function tallestNear(gw: GameWorld, x: number, z: number, r: number): { id: string; h: number } | null {
  let best: { id: string; h: number } | null = null;
  const g = groundHeight(gw.world, x, z);
  for (const b of nearbyBuildings(gw.world, x, z, r)) {
    const inside = pointInPolygon(x, z, b.footprint);
    if (!inside && closestOnBoundary(x, z, b.footprint).d2 > r * r) continue;
    const h = b.topY - g;
    if (!best || h > best.h) best = { id: b.id, h };
  }
  return best;
}

export async function measureBuildings(gw: GameWorld): Promise<Measured> {
  const m = new Measured("buildings", "pr");
  const recs = colliderRecords(gw);
  const world = gw.world;

  // ---- accounting (report.json): every source footprint present or dropped for a counted reason
  {
    const rep = readJson<{ buildings: Record<string, number> }>(`public/tiles/${gw.name}/report.json`).buildings;
    const unexplained = rep.parts! - rep.kept! - (rep.droppedSmall ?? 0) - (rep.droppedLow ?? 0) - (rep.droppedOutside ?? 0);
    m.metric({ id: "A.accounting.unexplained", target: 0, better: "lower", unit: "footprints", defects: [], desc: "source footprint parts neither kept nor dropped for a counted reason (report.json)" }, unexplained, rep);
    const plain = recs.filter((r) => !r.id.endsWith("-tower")).length;
    m.metric({ id: "A.accounting.keptMatchesRecords", target: 0, better: "lower", unit: "footprints", defects: [], desc: "|report.json kept - footprint records in the colliders| (the report and the tiles agree)" }, Math.abs(rep.kept! - plain), { kept: rep.kept, records: plain });
  }

  m.lap("accounting");
  // ---- the pack and the per-tile JSON agree (the sim boots from the pack)
  {
    const byId = gw.byId;
    let mismatches = 0;
    const first: string[] = [];
    for (const r of recs) {
      const p = byId.get(r.id);
      const same = p && p.baseY === r.baseY && p.topY === r.topY && p.footprint.length === r.footprint.length && p.footprint.every((v, k) => v[0] === r.footprint[k]![0] && v[1] === r.footprint[k]![1]);
      if (!same) {
        mismatches++;
        if (first.length < 10) first.push(r.id);
      }
    }
    mismatches += Math.abs(byId.size - recs.length);
    m.metric({ id: "A.pack.recordMismatches", target: 0, better: "lower", unit: "records", defects: [], desc: "building records whose collider-pack copy differs from the tile JSON (footprint, baseY, topY)" }, mismatches, first);
  }

  m.lap("pack");
  // ---- newer buildings (W-04)
  {
    const pts = fixture<{ points: Array<{ parcel: string; at: [number, number] }> }>("newer-parcels.json").points;
    const unmatched: Array<{ parcel: string; x: number; z: number }> = [];
    for (const p of pts) {
      const { x, z } = local(p.at[0], p.at[1]);
      const hit = nearbyBuildings(world, x, z, 25).some((b) => pointInPolygon(x, z, b.footprint) || closestOnBoundary(x, z, b.footprint).d2 <= 625);
      if (!hit) unmatched.push({ parcel: p.parcel, x, z });
    }
    const cells = new Map<string, number>();
    for (const u of unmatched) {
      const k = `${Math.floor(u.x / 100)},${Math.floor(u.z / 100)}`;
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
    m.metric({ id: "A.newer.unmatched", target: 10, better: "lower", unit: "parcel points", defects: ["W-04"], desc: "post-2015 assessor parcel points with storeys and no building record within 25 m" }, unmatched.length, unmatched.slice(0, 20).map((u) => `${u.parcel} ${ll(u.x, u.z)}`));
    m.metric({ id: "A.newer.cells3", target: 0, better: "lower", unit: "100 m cells", defects: ["W-04"], desc: "100 m cells holding 3 or more of those unmatched parcel points (a missing block)" }, [...cells.values()].filter((n) => n >= 3).length);
  }
  {
    const a = local(37.7765, -122.3905);
    const b = local(37.774, -122.3875);
    let tall = 0;
    for (const t of gw.tiles) {
      for (const r of t.buildings) {
        const [cx, cz] = centroid(r.footprint);
        if (cx < a.x || cx > b.x || cz < a.z || cz > b.z) continue;
        if (r.topY - groundHeight(world, cx, cz) >= 40) tall++;
      }
    }
    m.metric({ id: "A.newer.missionRockTall", target: 4, better: "higher", unit: "records", defects: ["W-04"], desc: "records 40 m or taller in the Mission Rock box (37.7740-37.7765, -122.3905..-122.3875)" }, tall);
  }
  {
    const fails: string[] = [];
    const seen: Record<string, number> = {};
    for (const p of PUBLISHED) {
      const { x, z } = local(p.lat, p.lon);
      const t = tallestNear(gw, x, z, 30);
      const h = t?.h ?? 0;
      seen[p.name] = r2(h);
      if (Math.abs(h - p.m) > 0.1 * p.m) fails.push(`${p.name}: ${r2(h)} m against ${p.m} m`);
    }
    m.metric({ id: "A.newer.publishedHeightFails", target: 0, better: "lower", unit: "towers", defects: ["W-04"], desc: "towers whose tallest record within 30 m is not within 10% of the published height (Salesforce, Transamerica, 555 California, One Rincon Hill, 250 Howard, The Avery, 706 Mission, 33 Tehama, Fifteen Fifty)" }, fails.length, { fails, seen });
  }

  m.lap("newer");
  // ---- grounding (W-05, W-28, L-03): 1 m raster under every footprint
  {
    let roofUnder = 0;
    let lowRoof = 0;
    let relief10 = 0;
    let footAbove = 0;
    const worstUnder: Array<{ id: string; over: number }> = [];
    const worstRelief: Array<{ id: string; relief: number }> = [];
    const footFails: string[] = [];
    for (const r of recs) {
      const gr = groundRange(gw, r.footprint);
      const over = gr.insideMax - r.topY;
      if (over > 0) {
        roofUnder++;
        worstUnder.push({ id: r.id, over: r2(over) });
      }
      const height = r.meta.heightM ?? r.topY - r.baseY;
      if (height >= 4 && Number.isFinite(gr.insideMax) && r.topY - gr.insideMax < 2) lowRoof++;
      const relief = gr.max - gr.min;
      if (relief > 10) {
        relief10++;
        worstRelief.push({ id: r.id, relief: r2(relief) });
      }
      const footY = r.meta.footY;
      if (footY !== undefined && footY > minGroundAlongWalls(gw, r.footprint) + 0.3) {
        footAbove++;
        footFails.push(r.id);
      }
    }
    worstUnder.sort((p, q) => q.over - p.over);
    worstRelief.sort((p, q) => q.relief - p.relief);
    m.metric({ id: "A.ground.roofUnderGround", target: 0, better: "lower", unit: "records", defects: ["W-05"], desc: "records with the ground above the roof anywhere inside the footprint (1 m raster)" }, roofUnder, worstUnder.slice(0, 10));
    m.metric({ id: "A.ground.lowAboveGround", target: 0, better: "lower", unit: "records", defects: ["W-05"], desc: "records 4 m or taller whose roof stands less than 2 m above the highest ground under them" }, lowRoof);
    m.metric({ id: "A.ground.relief10", target: 0, better: "lower", unit: "records", defects: ["W-28"], desc: "drawn parts with more than 10 m of ground relief under one roof" }, relief10, worstRelief.slice(0, 10));
    m.metric({ id: "A.ground.wallBottomAboveGround", target: 0, better: "lower", unit: "records", defects: ["L-03"], desc: "records whose wall bottom (meta.footY) is more than 0.3 m above the lowest ground along their walls (0.5 m samples)" }, footAbove, footFails.slice(0, 10));
  }

  m.lap("grounding");
  // ---- rings (W-30, L-01)
  {
    const bad = recs.filter((r) => selfIntersects(r.footprint)).map((r) => r.id);
    m.metric({ id: "A.rings.nonSimple", target: 0, better: "lower", unit: "rings", defects: ["W-30"], desc: "footprint and tower rings that cross themselves (double roofs, slabs outside the walls)" }, bad.length, bad.slice(0, 10));
    const ov = overlaps(recs);
    m.metric({ id: "A.rings.duplicates", target: 0, better: "lower", unit: "pairs", defects: ["L-01"], desc: "footprint pairs overlapping by 90% or more of the smaller one (0.5 m raster; a podium and its own tower excluded)" }, ov.duplicates.length, ov.duplicates.slice(0, 10));
    m.metric({ id: "A.rings.coplanarRoofs", target: 0, better: "lower", unit: "pairs", defects: ["L-01"], desc: "overlapping footprint pairs (2 m2 or more) whose roofs are within 0.1 m: z-fighting roofs" }, ov.coplanar.length, ov.coplanar.slice(0, 10));
  }

  m.lap("rings");
  // ---- facades (W-15, W-29): what the GLB draws
  {
    const fac = await drawnFacades(gw);
    let res = 0;
    let tall = 0;
    for (const r of recs) {
      if (r.id.endsWith("-tower") || !/residential/i.test(r.meta.use ?? "")) continue;
      const f = fac.get(r.id);
      if (!f) continue;
      res++;
      if (f.storeyM >= 5 - 1e-6) tall++;
    }
    m.metric({ id: "A.facade.storeys5m", target: 0.02, better: "lower", unit: "share of residential records", defects: ["W-15"], desc: "residential records the GLB draws with storeys of 5 m or more (_FACADE storey height)" }, r3(tall / Math.max(1, res)), { residential: res, tall });
    // Street-facing buildings: a wall sample within 4 m of a traffic ribbon (pipeline RoadSurface).
    // The facade's first-storey line is meta.streetY when the pipeline writes it, else baseY.
    const surf = new RoadSurface(trafficEdges(gw.roads.edges as unknown as PipelineRoadEdge[]), 6);
    let facing = 0;
    let off = 0;
    for (const r of recs) {
      if (r.id.endsWith("-tower")) continue;
      const P = r.footprint;
      let best = Infinity;
      let bx = 0;
      let bz = 0;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, az] = P[j]!;
        const [cx, cz] = P[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(cx - ax, cz - az)));
        for (let s = 0; s <= n; s++) {
          const x = ax + ((cx - ax) * s) / n;
          const z = az + ((cz - az) * s) / n;
          const c = surf.clearance(x, z);
          if (c < best) {
            best = c;
            bx = x;
            bz = z;
          }
        }
      }
      if (!(best <= 4)) continue;
      facing++;
      const line = typeof r.meta.streetY === "number" ? (r.meta.streetY as number) : r.baseY;
      if (Math.abs(line - groundHeight(world, bx, bz)) > 1.5) off++;
    }
    m.metric({ id: "A.facade.firstStoreyOffStreet", target: 0.01, better: "lower", unit: "share of street-facing records", defects: ["W-29"], desc: "street-facing buildings whose first-storey line (meta.streetY, else baseY) is more than 1.5 m off the ground at the wall nearest the street" }, r3(off / Math.max(1, facing)), { facing, off });
  }

  m.lap("facades");
  // ---- phantom towers (W-16)
  {
    const tallOnRoad = new Set<string>();
    for (const e of gw.roads.edges) {
      if (e.pedestrian || e.gradeSeparated) continue;
      for (const [x, z] of resample(e.points, 2)) {
        for (const b of nearbyBuildings(world, x, z, 0.5)) {
          if (tallOnRoad.has(b.id) || !pointInPolygon(x, z, b.footprint)) continue;
          const under = (b as BuildingCollider & { underY?: number }).underY;
          const surface = surfaceAt(world, x, z);
          if (under !== undefined && under >= surface + 4.5) continue;
          if (b.topY - surface > 30) tallOnRoad.add(b.id);
        }
      }
    }
    m.metric({ id: "A.phantom.tallOnStreet", target: 0, better: "lower", unit: "records", defects: ["W-16"], desc: "records more than 30 m tall standing on a surface street's centreline (no underside clearing the road)" }, tallOnRoad.size, [...tallOnRoad].sort());
    let fort = 0;
    for (const r of recs) {
      if (!r.id.startsWith(FORT_POINT)) continue;
      const [cx, cz] = centroid(r.footprint);
      fort = Math.max(fort, r.topY - groundHeight(world, cx, cz));
    }
    m.metric({ id: "A.phantom.fortPointHeight", target: 25, better: "lower", unit: "m above ground", defects: ["W-16"], desc: `Fort Point (${FORT_POINT} and its tower): roof above the ground at the centroid (the LiDAR caught the bridge deck above it)` }, r2(fort));
  }

  m.lap("phantom");
  // ---- landmarks (W-24 to W-27)
  {
    const lms = landmarks();
    const lmIds = new Set(lms.map((l) => l.id));
    // Sutro Tower (W-26 fixed: no slab): every footprint record within SUTRO_AREA_M of the tower,
    // whatever its id, so a slab coming back under a new id is caught. The real buildings there
    // are the three low plinths and the tower's equipment buildings (the tallest 13.6 m at 544f67c).
    const sp = local(SUTRO_AT.lat, SUTRO_AT.lon);
    let slab = 0;
    const near: string[] = [];
    for (const b of recs) {
      const [cx, cz] = centroid(b.footprint);
      const d = Math.min(Math.hypot(cx - sp.x, cz - sp.z), ...b.footprint.map(([x, z]) => Math.hypot(x - sp.x, z - sp.z)));
      if (d > SUTRO_AREA_M) continue;
      const h = b.topY - groundHeight(world, cx, cz);
      near.push(`${b.id} ${r2(h)} m`);
      slab = Math.max(slab, h);
    }
    m.metric({ id: "A.landmark.sutroAreaTallestM", target: 20, better: "lower", unit: "m above ground", defects: ["W-26"], desc: `the tallest footprint record (any id) with its centroid or a corner within ${SUTRO_AREA_M} m of Sutro Tower (37.7552,-122.4528), above the ground at its centroid: the plinths and the tower's equipment buildings, never the solid 231 m slab` }, r2(slab), near);
    let sutroTop = 0;
    for (const l of lms) {
      if (!/sutro-tower/.test(l.id)) continue;
      const p = local(l.lat, l.lon);
      if (Math.hypot(p.x - sp.x, p.z - sp.z) > 100) continue;
      sutroTop = Math.max(sutroTop, await modelTopM(l));
    }
    m.metric({ id: "A.landmark.sutroTowerTopM", target: 290, better: "higher", unit: "m above ground", defects: ["W-25"], desc: "a sutro-tower landmark at 37.7552,-122.4528 whose model top is 290 m or more above its ground" }, r2(sutroTop));
    m.metric({ id: "A.landmark.bridgesMissing", target: 0, better: "lower", unit: "landmarks", defects: ["W-24"], desc: "of golden-gate-bridge and bay-bridge-west, entries missing from content/landmarks.json" }, ["golden-gate-bridge", "bay-bridge-west"].filter((id) => !lmIds.has(id)).length);
    // Coit Tower: the taller of its records and a coit-tower model, above the ground (published 64 m).
    let coit = 0;
    for (const r of recs) {
      if (!r.id.startsWith(COIT)) continue;
      const [cx, cz] = centroid(r.footprint);
      coit = Math.max(coit, r.topY - groundHeight(world, cx, cz));
    }
    for (const l of lms) if (l.id === "coit-tower") coit = Math.max(coit, await modelTopM(l));
    m.metric({ id: "A.landmark.coitHeightError", target: 0.05, better: "lower", unit: "share of 64 m", defects: ["W-27"], desc: "Coit Tower's height against the published 64 m" }, r3(Math.abs(coit - 64) / 64), { coitM: r2(coit) });
    // Hero landmarks: a model (a landmarks.json entry replacing their records) or records drawn with no window grid.
    const probes = readJson<{ probes: Array<{ id: string; buildings: string[] }> }>(`public/tiles/${gw.name}/report.json`).probes;
    const replaced = new Set(lms.flatMap((l) => l.replacesBuildingIds ?? []));
    const heroTiles = new Set<string>();
    for (const p of probes) if (HERO_PROBES.includes(p.id)) for (const id of p.buildings) heroTiles.add(gw.byId.get(id)?.tile ?? "");
    const fac = await drawnFacades(gw, heroTiles);
    const plain: string[] = [];
    for (const p of probes) {
      if (!HERO_PROBES.includes(p.id) || lmIds.has(p.id)) continue;
      const glazed = p.buildings.filter((id) => !replaced.has(id) && (fac.get(id)?.glazing ?? 0) > 0);
      if (glazed.length) plain.push(p.id);
    }
    for (const id of HERO_MODELS_ONLY) if (!lmIds.has(id)) plain.push(id);
    m.lap("landmarks");
    m.metric({ id: "A.landmark.heroWithoutShape", target: 0, better: "lower", unit: "landmarks", defects: ["W-27"], desc: "hero landmarks (Transamerica, Coit, Saints Peter and Paul, Palace of Fine Arts, City Hall, Grace Cathedral, Mission Dolores, the Conservatory, Dragon Gate, Sutro Baths) with neither a model nor an interim shape without the office window grid" }, plain.length, plain);
  }
  return m;
}

/** For callers that want a probe's circle test (props, clearance). */
export function touches(b: BuildingCollider, x: number, z: number, r: number): boolean {
  return circleTouchesPolygon(x, z, r * r, b.footprint);
}
