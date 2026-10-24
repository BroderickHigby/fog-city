// Gate suite C: streets and structures (docs/qa/world-continuity-gate.md, section C): carriageway
// and path clearance, tunnels, freeway decks, bridges, piers, road profiles, stairs, street props
// and sidewalks. Heights are read through surfaceAt, so decks and tunnels count once the sim has them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RoadSurface, trafficEdges } from "../../../pipeline/lib/road-surface.ts";
import type { RoadEdge as PipelineRoadEdge } from "../../../pipeline/lib/roads.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { nodeClearance, streetTreeSpots, streetlightSpots } from "../../../src/render/roads.ts";
import type { RoadEdge as RenderRoadEdge, RoadGraph as RenderRoadGraph } from "../../../src/render/types.ts";
import { circleTouchesPolygon, groundWater, nearbyBuildings, pointInPolygon, roadSurfaceHeight, type BuildingCollider, type World } from "../../../src/sim/index.ts";
import { ROOT } from "../../helpers.ts";
import {
  bbox,
  distToSegment,
  drivePath,
  glbJsonOf,
  ll,
  r2,
  r3,
  rasterInside,
  resample,
  surfaceAt,
  type GameWorld,
  type P2,
  type RoadEdge,
} from "../world.ts";
import { Measured } from "./measured.ts";
import { gradeStats, surfaceProfile } from "./terrain.ts";

const FIX = join(ROOT, "tests/helpers/world-gate/fixtures");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;

/** Roof this far above the road blocks it... */
export const ROOF_CLEAR_M = 0.5;
/** ...unless its underside (collider `underY`, when the pipeline writes one) is at least this far above the road. */
export const UNDERSIDE_CLEAR_M = 4.5;
/** The car's half width, and a walker's clearance. */
export const CAR_HALF_W = 0.95;
export const WALK_HALF_W = 0.75;

/** Does building b stand in the way of a body on the surface `y` at (x, z)? */
export function blocksAt(b: BuildingCollider, y: number): boolean {
  if (b.topY <= b.baseY || b.topY - y <= ROOF_CLEAR_M) return false;
  const under = (b as BuildingCollider & { underY?: number }).underY;
  return under === undefined || under < y + UNDERSIDE_CLEAR_M;
}

/** Centreline samples (1 m) of an edge within `r` of a blocking footprint, and metres inside one. */
export function edgeClearance(world: World, e: RoadEdge, r: number): { near: number; insideM: number; first: P2 | null } {
  let near = 0;
  let inside = 0;
  let first: P2 | null = null;
  const pts = resample(e.points, 1);
  // Followed from the edge's own surface at its first point (a viaduct, a bore, the ground),
  // never from the ground under or over it.
  let y: number | undefined = pts.length ? roadSurfaceHeight(world, e.id, pts[0]![0], pts[0]![1]) : undefined;
  for (const [x, z] of pts) {
    y = surfaceAt(world, x, z, y);
    let isNear = false;
    let isIn = false;
    for (const b of nearbyBuildings(world, x, z, r + 0.5)) {
      if (!blocksAt(b, y)) continue;
      if (!isIn && pointInPolygon(x, z, b.footprint)) isIn = isNear = true;
      else if (!isNear && circleTouchesPolygon(x, z, r * r, b.footprint)) isNear = true;
      if (isIn) break;
    }
    if (isNear) {
      near++;
      if (!first) first = [x, z];
    }
    if (isIn) inside++;
  }
  return { near, insideM: inside, first };
}

const isTunnel = (e: RoadEdge): boolean => e.tunnel === true || e.kind === "tunnel";
const isStairs = (e: RoadEdge): boolean => e.stairs === true || e.kind === "stairs";

/** The named tunnels: surface edges by id, freeway tunnels by name near their two portals. */
export const TUNNELS: ReadonlyArray<{ name: string; ids?: string[]; street?: RegExp; portals?: [[number, number], [number, number]] }> = [
  { name: "Broadway Tunnel (Robert C Levy Tunl)", ids: ["c3186101", "c3186201"] },
  { name: "Stockton Tunnel", ids: ["c12225000"] },
  { name: "Toll Plaza Tunnel", ids: ["c19939000"] },
  { name: "MacArthur Tunnel (Hwy 1)", street: /^Hwy 1 (North|South)bound$/, portals: [[37.7935, -122.4718], [37.798, -122.474]] },
  { name: "Yerba Buena Island tunnel (I-80)", street: /^I-80 (East|West)bound$/, portals: [[37.81, -122.366], [37.8105, -122.3615]] },
  { name: "Presidio Parkway Battery Tunnel (Hwy 101)", street: /^Hwy 101 (North|South)bound$/, portals: [[37.8012, -122.46], [37.8018, -122.464]] },
  { name: "Presidio Parkway Main Post Tunnel (Hwy 101)", street: /^Hwy 101 (North|South)bound$/, portals: [[37.8025, -122.453], [37.8027, -122.4565]] },
];

/**
 * Edges of a tunnel: by id, or the named freeway edges nearest the tunnel's midpoint (the portal
 * points are approximate: every edge of that name within 60 m of the nearest one, up to 350 m).
 */
export function tunnelEdges(gw: GameWorld, t: (typeof TUNNELS)[number]): RoadEdge[] {
  if (t.ids) return t.ids.map((id) => gw.edges.get(id)).filter((e): e is RoadEdge => !!e);
  const a = toLocal(t.portals![0][0], t.portals![0][1]);
  const b = toLocal(t.portals![1][0], t.portals![1][1]);
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const near: Array<{ e: RoadEdge; d: number }> = [];
  for (const e of gw.roads.edges as RoadEdge[]) {
    if (!t.street!.test(e.name ?? "")) continue;
    let d = Infinity;
    for (let i = 1; i < e.points.length; i++) d = Math.min(d, distToSegment(mx, mz, e.points[i - 1]![0]!, e.points[i - 1]![1]!, e.points[i]![0]!, e.points[i]![1]!));
    near.push({ e, d });
  }
  const best = Math.min(...near.map((q) => q.d));
  return near.filter((q) => q.d <= Math.min(350, best + 60)).map((q) => q.e).sort((p, q) => (p.id < q.id ? -1 : 1));
}

/**
 * A bridge's edges chained into one 1 m path, carried 30 m on past each end along its end
 * direction (onto the banks), and its floor: the lower bank's surface - 0.2 m.
 */
export function bridgePath(gw: GameWorld, ids: readonly string[]): { path: P2[]; floor: number; deck: [number, number] } | null {
  const pts: P2[] = [];
  for (const id of ids) {
    const e = gw.edges.get(id);
    if (!e) return null;
    for (const p of resample(e.points, 1)) if (!pts.length || Math.hypot(pts[pts.length - 1]![0] - p[0], pts[pts.length - 1]![1] - p[1]) > 0.5) pts.push(p);
  }
  if (pts.length < 4) return null;
  const ext = (a: P2, b: P2): P2[] => {
    const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const ux = (a[0] - b[0]) / L;
    const uz = (a[1] - b[1]) / L;
    return Array.from({ length: 30 }, (_, k) => [a[0] + ux * (k + 1), a[1] + uz * (k + 1)] as P2);
  };
  const before = ext(pts[0]!, pts[3]!).reverse();
  const after = ext(pts[pts.length - 1]!, pts[pts.length - 4]!);
  const path = [...before, ...pts, ...after];
  const bankA = surfaceAt(gw.world, path[0]![0], path[0]![1]);
  const bankB = surfaceAt(gw.world, path[path.length - 1]![0], path[path.length - 1]![1]);
  return { path, floor: Math.min(bankA, bankB) - 0.2, deck: [before.length, before.length + pts.length - 1] };
}

/** The four creek bridges (W-12) and the four pier streets (W-13). */
export const CREEK_BRIDGES: ReadonlyArray<{ name: string; ids: string[] }> = [
  { name: "3rd St (Lefty O'Doul) over Mission Creek", ids: ["c182000", "c183000"] },
  { name: "4th St over Mission Creek", ids: ["c270002", "c271000"] },
  { name: "3rd St over Islais Creek", ids: ["c197101", "c197201"] },
  { name: "Illinois St over Islais Creek", ids: ["c15166000"] },
];
export const PIER_STREETS: ReadonlyArray<{ name: string; id: string }> = [
  { name: "Al Scoma Way", id: "c15207000" },
  { name: "Pier 45 Vly", id: "c15356000" },
  { name: "Pier 50 Vly", id: "c15358000" },
  { name: "Unnamed 42 (Pier 70)", id: "c12929000" },
];

/** Six public stairways (streets audit): the street name in roads.json and a point on the steps. */
export const STAIRWAYS: ReadonlyArray<{ name: string; street: RegExp; at: [number, number]; r: number }> = [
  { name: "Filbert Steps (Telegraph Hill)", street: /^Filbert St$/, at: [37.802, -122.4045], r: 400 },
  { name: "Greenwich Steps (Telegraph Hill)", street: /^Greenwich St$/, at: [37.8029, -122.4045], r: 200 },
  { name: "Lyon St steps", street: /^Lyon St$/, at: [37.7937, -122.4466], r: 120 },
  { name: "16th Ave tiled steps", street: /^16th Ave$/, at: [37.7564, -122.4733], r: 120 },
  { name: "Vulcan Stairway", street: /^Vulcan Stwy$/, at: [37.7635, -122.4411], r: 120 },
  { name: "Harry St steps (Glen Park)", street: /^Harry St$/, at: [37.7401, -122.4312], r: 120 },
];

export function stairEdges(gw: GameWorld, s: (typeof STAIRWAYS)[number]): RoadEdge[] {
  const p = toLocal(s.at[0], s.at[1]);
  return (gw.roads.edges as RoadEdge[]).filter((e) => e.pedestrian && s.street.test(e.name ?? "") && e.points.some(([x, z]) => Math.hypot(x! - p.x, z! - p.z) < s.r));
}

/** The height a body reaches at sample `upto` driving along `pts` from the start (surface followed). */
function surfaceAlong(gw: GameWorld, pts: readonly P2[], upto: number): number {
  let y: number | undefined;
  for (let i = 0; i <= upto; i++) y = surfaceAt(gw.world, pts[i]![0], pts[i]![1], y);
  return y ?? 0;
}

function nearestIndex(pts: readonly P2[], x: number, z: number): { i: number; d: number } {
  let best = { i: 0, d: Infinity };
  pts.forEach(([px, pz], i) => {
    const d = Math.hypot(px - x, pz - z);
    if (d < best.d) best = { i, d };
  });
  return best;
}

export async function measureStreets(gw: GameWorld): Promise<Measured> {
  const m = new Measured("streets", "pr");
  const world = gw.world;
  const edges = gw.roads.edges as RoadEdge[];

  // ---- carriageway and path clearance (W-01, W-43, W-39)
  {
    const blocked: string[] = [];
    let lombard = 0;
    for (const e of edges) {
      if (e.pedestrian || e.gradeSeparated || isTunnel(e)) continue;
      const c = edgeClearance(world, e, CAR_HALF_W);
      if (c.near > 0) {
        blocked.push(e.id);
        if (e.id === "c8448000" || e.id === "c8449000") lombard++;
      }
    }
    m.metric({ id: "C.clearance.carriagewayEdges", target: 0, better: "lower", unit: "edges", defects: ["W-01"], desc: "surface street edges with a centreline sample within 0.95 m (the car's half width) of a footprint whose roof is over 0.5 m above the road and whose underside is under road + 4.5 m" }, blocked.length, blocked.slice(0, 30));
    m.metric({ id: "C.clearance.lombardEdges", target: 0, better: "lower", unit: "edges", defects: ["W-43"], desc: "of Lombard St c8448000 (the crooked block) and c8449000 (the approach from Hyde), edges whose centreline passes within 0.95 m of a house" }, lombard);
    const ped: string[] = [];
    for (const e of edges) {
      if (!e.pedestrian) continue;
      if (edgeClearance(world, e, WALK_HALF_W).near > 0) ped.push(e.id);
    }
    m.metric({ id: "C.clearance.pedestrianEdges", target: 0, better: "lower", unit: "edges", defects: ["W-39"], desc: "pedestrian edges (stairways, paths) with a centreline sample within 0.75 m of a blocking footprint" }, ped.length, ped.slice(0, 30));
  }

  // ---- tunnels (W-02)
  {
    let unflagged = 0;
    let insideM = 0;
    let hump = 0;
    const seen: Record<string, unknown> = {};
    for (const t of TUNNELS) {
      const es = tunnelEdges(gw, t);
      if (es.length === 0 || !es.every(isTunnel)) unflagged++;
      if (!t.ids) continue;
      for (const e of es) {
        insideM += edgeClearance(world, e, 0).insideM;
        if (t.ids[0] === "c3186101") {
          const h = surfaceProfile(gw, resample(e.points, 1));
          const n = h.length - 1;
          for (let i = 0; i <= n; i++) hump = Math.max(hump, h[i]! - (h[0]! + ((h[n]! - h[0]!) * i) / n));
        }
      }
      seen[t.name] = es.map((e) => e.id);
    }
    m.metric({ id: "C.tunnels.unflagged", target: 0, better: "lower", unit: "tunnels", defects: ["W-02"], desc: "of Broadway, Stockton, Toll Plaza, MacArthur, YBI and the two Presidio Parkway tunnels, those whose road edges are not all flagged as tunnels" }, unflagged, seen);
    m.metric({ id: "C.tunnels.broadwayAbovePortalLineM", target: 1, better: "lower", unit: "m", defects: ["W-02"], desc: "how far the Broadway Tunnel's road surface rises above the straight line between its ends (it is draped over Russian Hill)" }, r2(hump));
    m.metric({ id: "C.tunnels.insideFootprintsM", target: 0, better: "lower", unit: "m", defects: ["W-02"], desc: "metres of Broadway, Stockton and Toll Plaza tunnel centreline inside footprints that block the road surface" }, insideM);
  }

  // ---- freeway decks (W-03)
  {
    let insideM = 0;
    let steep = 0;
    let steepAt = "";
    const worst: Record<string, number> = {};
    for (const e of edges) {
      if (!e.gradeSeparated && e.kind !== "ramp" && e.kind !== "freeway") continue;
      const c = edgeClearance(world, e, 0);
      if (c.insideM > 0) worst[e.id] = c.insideM;
      insideM += c.insideM;
      if (e.kind !== "freeway") continue;
      const pts = resample(e.points, 1);
      const g = gradeStats(surfaceProfile(gw, pts, roadSurfaceHeight(world, e.id, pts[0]![0], pts[0]![1])));
      if (g.steep10 > steep) {
        steep = g.steep10;
        steepAt = `${e.id} ${ll(pts[g.steepAt]![0], pts[g.steepAt]![1])}`;
      }
    }
    m.metric({ id: "C.freeway.insideFootprintsM", target: 0, better: "lower", unit: "m", defects: ["W-03"], desc: "metres of freeway and ramp centreline inside footprints that block its surface" }, insideM, worst);
    m.metric({ id: "C.freeway.maxGradePct", target: 6, better: "lower", unit: "%", defects: ["W-03"], desc: "steepest 10 m along any freeway (ramps excluded) on its drivable surface" }, r2(steep), steepAt);
    // Street-over-freeway crossings: the freeway's surface and the street's, each followed along its own road.
    const crossings = fixture<{ crossings: Array<{ edge: string; at: [number, number] }> }>("grade-crossings.json").crossings;
    const fwys = edges.filter((e) => e.gradeSeparated || e.kind === "ramp");
    let separated = 0;
    let n = 0;
    for (const c of crossings) {
      const se = gw.edges.get(c.edge);
      if (!se) continue;
      const p = toLocal(c.at[0], c.at[1]);
      let fe: { e: RoadEdge; pts: P2[]; i: number; d: number } | null = null;
      for (const e of fwys) {
        const [x0, z0, x1, z1] = bbox(e.points);
        if (p.x < x0 - 15 || p.x > x1 + 15 || p.z < z0 - 15 || p.z > z1 + 15) continue;
        const pts = resample(e.points, 1);
        const k = nearestIndex(pts, p.x, p.z);
        if (k.d < 15 && (!fe || k.d < fe.d)) fe = { e, pts, i: k.i, d: k.d };
      }
      if (!fe) continue;
      const spts = resample(se.points, 1);
      const si = nearestIndex(spts, p.x, p.z).i;
      n++;
      if (Math.abs(surfaceAlong(gw, fe.pts, fe.i) - surfaceAlong(gw, spts, si)) >= 5) separated++;
    }
    m.metric({ id: "C.freeway.separatedCrossingsShare", target: 1, better: "higher", unit: "share", defects: ["W-03", "W-14"], desc: "share of street-over-freeway crossings where the freeway's surface and the street's are at least 5 m apart (a deck or a cut, not an at-grade junction)" }, r3(n ? separated / n : 0), { crossings: n, separated });
  }

  // ---- bridges and piers (W-12, W-13)
  {
    const fails: string[] = [];
    for (const b of CREEK_BRIDGES) {
      const bp = bridgePath(gw, b.ids);
      if (!bp) {
        fails.push(`${b.name}: missing`);
        continue;
      }
      const h = surfaceProfile(gw, bp.path);
      const low = Math.min(...h.slice(bp.deck[0], bp.deck[1] + 1));
      if (low < bp.floor) fails.push(`${b.name}: deck down to ${r2(low)} m, banks at ${r2(bp.floor + 0.2)} m or more`);
    }
    m.metric({ id: "C.bridges.dippingDecks", target: 0, better: "lower", unit: "bridges", defects: ["W-12"], desc: "of the 3rd St, 4th St, 3rd St (Islais) and Illinois St creek bridges, those whose road surface dips more than 0.2 m below the lower bank (no deck)" }, fails.length, fails);
    const atSea: string[] = [];
    for (const p of PIER_STREETS) {
      const e = gw.edges.get(p.id);
      if (!e || surfaceProfile(gw, resample(e.points, 1)).some((y) => y < 0.5)) atSea.push(p.name);
    }
    m.metric({ id: "C.piers.streetsAtSeaLevel", target: 0, better: "lower", unit: "streets", defects: ["W-13"], desc: "of Al Scoma Way, Pier 45 Vly, Pier 50 Vly and Unnamed 42, pier streets with road surface under 0.5 m (no pier deck)" }, atSea.length, atSea);
    let onWater = 0;
    const examples: string[] = [];
    for (const t of gw.tiles) {
      if (!t.ground?.water?.some((w) => w === 1)) continue;
      for (const b of t.buildings) {
        if (b.id.endsWith("-tower") || b.baseY >= 1) continue;
        const pts = rasterInside(b.footprint, 2);
        if (pts.length === 0) continue;
        const wet = pts.filter(([x, z]) => groundWater(world, x, z)).length;
        if (wet / pts.length >= 0.5) {
          onWater++;
          if (examples.length < 10) examples.push(b.id);
        }
      }
    }
    m.metric({ id: "C.piers.buildingsOnWater", target: 0, better: "lower", unit: "buildings", defects: ["W-13"], desc: "buildings at least half over open water with no deck under them (baseY under 1 m)" }, onWater, examples);
  }

  // ---- road profiles (W-09, W-31)
  {
    const drivable = edges.filter((e) => !e.pedestrian);
    const without = drivable.filter((e) => e.profile === undefined).length;
    m.metric({ id: "C.profile.edgesWithoutProfile", target: 0, better: "lower", unit: "share of drivable edges", defects: ["W-09", "W-31"], desc: "drivable edges without a 2 m road profile in roads.json (one surface for the sim and the drawn ribbon)" }, r3(without / Math.max(1, drivable.length)));
  }

  // ---- stairs (W-33)
  {
    const missing: string[] = [];
    const notStairs: string[] = [];
    const climbable: string[] = [];
    for (const s of STAIRWAYS) {
      const es = stairEdges(gw, s);
      if (es.length === 0) {
        missing.push(s.name);
        continue;
      }
      if (!es.every(isStairs)) notStairs.push(s.name);
      // A car driven up (and down) each stair edge must not get to the end.
      for (const e of es) {
        const pts = resample(e.points, 1);
        if (pts.length < 12) continue;
        const up = drivePath(world, pts, { vmax: 8, startSpeed: 4 });
        const down = drivePath(world, [...pts].reverse(), { vmax: 8, startSpeed: 4 });
        if (up.reached || down.reached) {
          climbable.push(`${s.name} ${e.id}`);
          break;
        }
      }
    }
    m.metric({ id: "C.stairs.missing", target: 0, better: "lower", unit: "stairways", defects: ["W-33"], desc: "of the Filbert, Greenwich, Lyon, 16th Ave, Vulcan and Harry St stairways, those with no pedestrian edge in roads.json" }, missing.length, missing);
    m.metric({ id: "C.stairs.notMarkedStairs", target: 0, better: "lower", unit: "stairways", defects: ["W-33"], desc: "of those present, stairways whose edges are not marked as stairs" }, notStairs.length, notStairs);
    m.metric({ id: "C.stairs.carDrivable", target: 0, better: "lower", unit: "stairways", defects: ["W-33"], desc: "of those present, stairways the car can drive end to end (the steps are drawn and driven as a smooth ramp)" }, climbable.length, climbable);
  }

  // ---- street trees and lamps (W-44): the renderer's own spot lists, against ribbons and footprints
  {
    const graph = gw.roads as unknown as RenderRoadGraph;
    const surf = new RoadSurface(trafficEdges(gw.roads.edges as unknown as PipelineRoadEdge[]), 1);
    const clearance = nodeClearance(graph);
    const re = graph.edges as RenderRoadEdge[];
    const lamps = streetlightSpots(re, clearance);
    const trees = streetTreeSpots(re, clearance);
    const onRoad = (s: { x: number; z: number }): boolean => surf.clearance(s.x, s.z) < 0.5;
    const inBuilding = (s: { x: number; z: number }): boolean => nearbyBuildings(world, s.x, s.z, 0.5).some((b) => b.topY > b.baseY && pointInPolygon(s.x, s.z, b.footprint));
    m.metric({ id: "C.props.treesOnRoad", target: 0, better: "lower", unit: "share of street trees", defects: ["W-44"], desc: "street trees standing on a road ribbon (+0.5 m), from the renderer's streetTreeSpots" }, r3(trees.filter(onRoad).length / Math.max(1, trees.length)), { trees: trees.length });
    m.metric({ id: "C.props.treesInBuildings", target: 0, better: "lower", unit: "share of street trees", defects: ["W-44"], desc: "street trees standing inside a building footprint" }, r3(trees.filter(inBuilding).length / Math.max(1, trees.length)));
    m.metric({ id: "C.props.lampsOnRoad", target: 0, better: "lower", unit: "share of streetlights", defects: ["W-44"], desc: "streetlights standing on a road ribbon (+0.5 m), from the renderer's streetlightSpots" }, r3(lamps.filter(onRoad).length / Math.max(1, lamps.length)), { lamps: lamps.length });
  }

  // ---- sidewalks drawn (W-45): every tile with streets draws sidewalks (a GLB node, read from the JSON chunk)
  {
    let missing = 0;
    let withRoads = 0;
    for (const t of gw.manifest.tiles) {
      if (!t.glb || !(t.stats?.roadEdges && t.stats.roadEdges > 0)) continue;
      withRoads++;
      const json = glbJsonOf(new Uint8Array(readFileSync(join(ROOT, "public/tiles", gw.name, t.glb))));
      if (!(json.nodes ?? []).some((n) => /sidewalk/i.test(n.name ?? ""))) missing++;
    }
    m.metric({ id: "C.sidewalks.tilesWithoutSidewalks", target: 0, better: "lower", unit: "tiles", defects: ["W-45"], desc: "tiles with streets whose GLB draws no sidewalk geometry (no sidewalks node)" }, missing, { withRoads });
  }
  return m;
}
