// Raw inputs -> every file of public/tiles/<world>/, in memory. Pure apart from CPU time:
// the same inputs give byte-identical files.

import { ORIGIN, TILE_SIZE_M, toLatLon, toLocal } from "../../src/geo/project.ts";
import type { Spawn } from "../../src/sim/contract.ts";
import { buildBoundary, type BoundaryStats } from "./boundary.ts";
import { buildBuildings, minGroundUnder, type Building, type BuildingStats, type Override } from "./buildings.ts";
import { candidateTiles, worldTiles, type Probe, type TileRef, type WorldConfig } from "./config.ts";
import { assignTiles, buildDistricts, DistrictIndex, type District } from "./districts.ts";
import { bearing, centroid, cleanRing, clipSegment, distToRing, distToSegment, dropCollinear, interiorPoint, isSimpleRing, pointInRing, r2, signedArea, type P2 } from "./geom.ts";
import { intersectPolys, largest, polyArea, unionRings } from "./polygon.ts";
import { buildFarLod, FAR_CELL_M } from "./far.ts";
import {
  buildFountains,
  buildHydrants,
  buildParking,
  buildSignals,
  buildStreetCleaning,
  buildTransit,
  crosswalkNodes,
  insideAny,
} from "./gameplay.ts";
import { tileGlb } from "./glb.ts";
import { RoadSurface, trafficEdges } from "./road-surface.ts";
import { buildSidewalks, type SidewalkStats } from "./sidewalks.ts";
import type { Deck, Movable, Tunnel } from "./structures.ts";
import { encodeWorldColliders } from "./world-colliders.ts";
import { buildingMesh, deckMesh, groundMesh, junctionPolygons, junctionRadii, partyWalls, roadMeshes } from "./mesh.ts";
import { terraceBuildings, type TerraceStats } from "./terrace.ts";
import { clearCorridors, type ClearanceStats } from "./clearance.ts";
import { findTunnels, tunnelRibbons, undersideOverBores, type Bore } from "./tunnels.ts";
import { buildDecks, type DeckStats } from "./decks.ts";
import { jsonLines, jsonPretty, utf8 } from "./output.ts";
import { buildRoads, crossesWater, titleCase, type RoadEdge, type RoadGraph, type RoadStats } from "./roads.ts";
import { raisePiers, rebaseOnDecks, type PierStats } from "./piers.ts";
import type { RawInputs } from "./sources.ts";
import { BuildingIndex, buildStorefronts, type StorefrontStats } from "./storefronts.ts";
import { Elevation, Ground, tileHeightfield, type Heightfield } from "./terrain.ts";

export const ATTRIBUTION = [
  "Building footprints and LiDAR heights: City and County of San Francisco, DataSF \"Building Footprints\" (ynuv-fyni), Open Data Commons Public Domain Dedication and License (PDDL) 1.0.",
  "Street centerlines: City and County of San Francisco, DataSF \"Streets – Active and Retired\" (3psu-pn9h), ODC PDDL 1.0.",
  "Building year, use and storeys: San Francisco Office of the Assessor-Recorder via DataSF \"Assessor Historical Secured Property Tax Rolls\" (wv5m-vpq2), ODC PDDL 1.0.",
  "Storefront positions (no names): San Francisco Treasurer & Tax Collector via DataSF \"Registered Business Locations\" (g8m3-pdis), ODC PDDL 1.0.",
  "Elevation: U.S. Geological Survey, 3D Elevation Program (3DEP) bare-earth DEM, public domain.",
  "Height corrections, listed in pipeline/overrides.json: public records for buildings newer than the 2010 LiDAR; a placeholder plinth where the LiDAR filled Sutro Tower's open lattice as a solid block; a LiDAR bell tower kept where the assessor's storey count contradicts it.",
  "District boundaries: City and County of San Francisco, DataSF \"Analysis Neighborhoods\" (j2bu-swwd), ODC PDDL 1.0.",
  "Transit routes and stops, traffic signals, crosswalks, parking regulations: SFMTA via DataSF (9exe-acju, i28k-bkz6, ybh5-27n2, g9zy-srvv, hi6h-neyh), ODC PDDL 1.0.",
  "Street cleaning schedules: San Francisco Public Works via DataSF \"Street Sweeping Schedule\" (yhqp-riqs), ODC PDDL 1.0.",
  "Drinking fountains: DataSF \"San Francisco Public Bathrooms and Water Fountains\" (wfq4-upmv), ODC PDDL 1.0.",
];

export interface TileSelection {
  candidates: number;
  built: number;
  /** Candidates with no file because every sample is open water (listed in manifest water.tiles). */
  water: number;
  /** Candidates with land but no SF buildings, roads or neighbourhood land (listed in manifest outside). */
  outside: number;
  withBuildings: number;
  withRoads: number;
  withLand: number;
}

export interface Report {
  world: string;
  areas: Array<{ id: string; milestone: string; tiles: number; built: number }>;
  tiles: number;
  selection: TileSelection;
  buildings: BuildingStats;
  /** Hillside terracing and roof clearance (terrace.ts). */
  terrace: TerraceStats;
  /** Street and path clearance (clearance.ts). */
  clearance: ClearanceStats;
  /** Tunnel bores (tunnels.ts) and the buildings over them that got an underside. */
  tunnels: { bores: Bore[]; buildingsOver: string[]; droppedInPortalCuts: string[] };
  /** Pier decks raised out of the bay (piers.ts). */
  piers: PierStats;
  /** Freeway, overpass, underpass and bridge decks (decks.ts). */
  decks: DeckStats;
  overridesApplied: string[];
  roads: RoadStats;
  storefronts: StorefrontStats;
  sidewalks: SidewalkStats | null;
  layers: Record<string, number>;
  /** Land tiles with no file, by area (manifest outside.tiles). */
  outside: Record<string, string[]>;
  boundary: BoundaryStats;
  colliderPack: { bytes: number; tiles: number; buildings: number };
  far: { cells: number; triangles: number; records: number; bytes: number };
  terrain: { minY: number; maxY: number; waterSamples: number; samples: number };
  spawn: Spawn & { edge: string; y: number };
  /** Building records at each configured probe point (for landmarks' replacesBuildingIds). */
  probes: Array<{ id: string; label: string; x: number; z: number; radiusM?: number; buildings: string[]; nearestM: number }>;
  tallest: Array<{ id: string; heightM: number; topY: number; parcel?: string; source: string }>;
}

export interface BuildOutput {
  /** Path relative to public/tiles/<world>/ -> bytes. */
  files: Map<string, Uint8Array>;
  report: Report;
}

function edgeBox(e: RoadEdge): [number, number, number, number] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of e.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const pad = e.widthM;
  return [minX - pad, minZ - pad, maxX + pad, maxZ + pad];
}

const overlaps = (a: readonly number[], b: readonly number[]): boolean => a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;

export type OutsideArea = "alcatraz" | "marin" | "san-mateo-county" | "pacific-shore" | "other";

const OUTSIDE_DESCRIPTION =
  "Candidate tiles with land but no file: land outside the city (Marin across the Golden Gate, San Mateo County south of the city limit), Alcatraz (San Francisco, but no footprint, street or neighbourhood data covers it) and a strip of Ocean Beach sand west of the last built tile. Draw far-LOD terrain here, never sea. The sim has no ground here: boundary.json edges of kind land wall the world off from it.";

/** Alcatraz Island, padded (lat/lon box). */
const ALCATRAZ = { north: 37.8292, south: 37.8245, west: -122.4265, east: -122.4195 };

/** Which area a land tile with no file lies in, from its position. */
export function outsideArea(t: TileRef): OutsideArea {
  const nw = toLatLon(t.bbox[0], t.bbox[1]);
  const se = toLatLon(t.bbox[2], t.bbox[3]);
  if (nw.lat >= ALCATRAZ.south && se.lat <= ALCATRAZ.north && nw.lon <= ALCATRAZ.east && se.lon >= ALCATRAZ.west) return "alcatraz";
  const c = toLatLon((t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2);
  if (c.lat > 37.812 && c.lon < -122.46) return "marin";
  if (c.lat < 37.72) return "san-mateo-county";
  // Ocean Beach sand west of the last built tile (outside the neighbourhood polygons).
  if (c.lon < -122.5) return "pacific-shore";
  return "other";
}

/** Spawn on the configured street at the point nearest the configured lat/lon, heading along it. */
export function chooseSpawn(cfg: WorldConfig, roads: RoadGraph, buildings: readonly Building[]): Spawn & { edge: string } {
  const want = titleCase(cfg.spawn.street);
  const p = toLocal(cfg.spawn.lat, cfg.spawn.lon);
  const toward = toLocal(cfg.spawn.towardLat, cfg.spawn.towardLon);
  const wantBearing = bearing(toward.x - p.x, toward.z - p.z);
  let best: { x: number; z: number; heading: number; d: number; edge: string } | null = null;
  for (const e of roads.edges) {
    if (e.name !== want) continue;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!;
      const b = e.points[i]!;
      const s = distToSegment(p.x, p.z, a, b);
      let h = bearing(b[0] - a[0], b[1] - a[1]);
      let diff = Math.abs(((h - wantBearing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      if (!e.oneway && diff > Math.PI / 2) {
        h = (h + Math.PI) % (2 * Math.PI);
        diff = Math.PI - diff;
      }
      if (diff > Math.PI / 2) continue; // one-way the wrong way
      if (!best || s.d < best.d) best = { x: s.x, z: s.z, heading: h, d: s.d, edge: e.id };
    }
  }
  if (!best) throw new Error(`spawn: no edge named "${want}" runs toward the configured point`);
  for (const bl of buildings) {
    if (pointInRing(best.x, best.z, bl.footprint)) throw new Error(`spawn (${best.x}, ${best.z}) is inside building ${bl.id}`);
  }
  return { x: r2(best.x), z: r2(best.z), heading: Math.round(best.heading * 10000) / 10000, edge: best.edge };
}

/**
 * Records containing the probe point (a podium and its tower), else the nearest within 30 m.
 * With radiusM, every record whose footprint comes within that many metres of the point (a
 * landmark the data splits into several records, e.g. Sutro Tower's legs).
 */
function probeBuildings(pr: Probe, buildings: readonly Building[]): Report["probes"][number] {
  const { x, z } = toLocal(pr.lat, pr.lon);
  const inside = buildings
    .filter((b) => pointInRing(x, z, b.footprint) || (pr.radiusM !== undefined && distToRing(x, z, b.footprint) <= pr.radiusM))
    .map((b) => b.id);
  let nearest = "";
  let nearestM = 0;
  if (inside.length === 0) {
    nearestM = Infinity;
    for (const b of buildings) {
      const d = distToRing(x, z, b.footprint);
      if (d < nearestM) {
        nearestM = d;
        nearest = b.id;
      }
    }
    if (nearestM > 30) nearest = "";
  }
  const ids = inside.length ? inside : nearest ? [nearest] : [];
  // A podium's tower travels with it.
  for (const id of [...ids]) {
    const t = buildings.find((b) => b.id === id)?.meta.tower;
    if (t && !ids.includes(t)) ids.push(t);
  }
  const out: Report["probes"][number] = { id: pr.id, label: pr.label, x: r2(x), z: r2(z), buildings: ids.sort(), nearestM: r2(Number.isFinite(nearestM) ? nearestM : -1) };
  if (pr.radiusM !== undefined) out.radiusM = pr.radiusM;
  return out;
}

/** True when any segment of the polyline passes through the tile's rectangle. */
function polylineCrosses(points: readonly [number, number][], box: TileRef["bbox"]): boolean {
  for (let i = 1; i < points.length; i++) if (clipSegment(points[i - 1]!, points[i]!, box)) return true;
  return false;
}

/** A building as the tile collider (and, without meta, the pack) holds it. */
function colliderBuilding(b: Building, withMeta: boolean): { id: string; footprint: Building["footprint"]; baseY: number; topY: number; underY?: number; meta?: Building["meta"] } {
  const out: { id: string; footprint: Building["footprint"]; baseY: number; topY: number; underY?: number; meta?: Building["meta"] } = {
    id: b.id,
    footprint: b.footprint,
    baseY: b.baseY,
    topY: b.topY,
  };
  if (b.underY !== undefined) out.underY = b.underY;
  if (withMeta) out.meta = b.meta;
  return out;
}

/** A tile's decks, tunnels and movable spans, each key present only when the tile has any. */
function tileStructures(s: TileStructures, tile: string): { decks?: Deck[]; tunnels?: Tunnel[]; movable?: Movable[] } {
  const out: { decks?: Deck[]; tunnels?: Tunnel[]; movable?: Movable[] } = {};
  const d = s.decks.get(tile);
  const u = s.tunnels.get(tile);
  const m = s.movable.get(tile);
  if (d?.length) out.decks = d;
  if (u?.length) out.tunnels = u;
  if (m?.length) out.movable = m;
  return out;
}

/** Per-tile street structures (structures.ts), keyed by tile id. */
export interface TileStructures {
  decks: Map<string, Deck[]>;
  tunnels: Map<string, Tunnel[]>;
  movable: Map<string, Movable[]>;
}

/**
 * Towers whose podium is gone are dropped; every other tower's podiumTopY is its podium's roof,
 * and it stands inside its podium: where a pass cut the podium back (from a street or a path the
 * tower overhung), the tower is cut to what is left, or dropped if little is.
 */
function reconcileTowers(list: readonly Building[], groundUnder: (ring: readonly P2[]) => { at: number; min: number } | null): Building[] {
  const byId = new Map(list.map((b) => [b.id, b]));
  // A podium is its record and its terrace strips (not its spans over streets).
  const strips = new Map<string, P2[][]>();
  for (const b of list) if (b.meta.piece === "strip" && b.meta.pieceOf) (strips.get(b.meta.pieceOf) ?? strips.set(b.meta.pieceOf, []).get(b.meta.pieceOf)!).push(b.footprint);
  const towers = new Map<string, Building>(); // kept towers, as they will be written
  for (const b of list) {
    if (b.meta.towerOf === undefined) continue;
    const pod = byId.get(b.meta.towerOf);
    if (!pod || pod.meta.tower !== b.id) continue;
    const parts = [pod.footprint, ...(strips.get(pod.id) ?? [])];
    const inside = (x: number, z: number): boolean => parts.some((r) => pointInRing(x, z, r) || distToRing(x, z, r) <= 0.02);
    let footprint = b.footprint;
    let baseY = b.baseY;
    let footY = b.meta.footY;
    // Inside: every vertex in a part, and (but for the centimetre seams between terrace strips)
    // no gap between parts under it: a street or a path the passes cut.
    const area = Math.abs(signedArea(b.footprint));
    const union = unionRings(parts);
    const overlap = (ring: readonly P2[]): number => intersectPolys(ring, union).reduce((a, q) => a + polyArea(q), 0);
    const within = b.footprint.every(([x, z]) => inside(x, z)) && overlap(b.footprint) >= 0.99 * area;
    if (!within) {
      const rise = b.topY - pod.topY;
      const needle = (a: number): boolean => a < TOWER_MIN_M2 || (a < 20 && rise > 30) || rise > 10.6 * Math.sqrt(a);
      const clip = (ring: readonly P2[]): P2[] | null => {
        const part = largest(intersectPolys(ring, union));
        let r = part ? dropCollinear(cleanRing(part.outer), 0.005) : [];
        if (r.length >= 3 && Math.sign(signedArea(r)) !== Math.sign(signedArea(b.footprint))) r = r.reverse();
        return r.length >= 3 && isSimpleRing(r) && !needle(Math.abs(signedArea(r))) ? r : null;
      };
      // The tower is the model's (centred on its podium, buildings.ts): cut to the podium, or,
      // where that leaves a needle, moved onto the podium's largest part and cut there; else it
      // is no tower.
      let ring = clip(b.footprint);
      if (!ring) {
        const host = largest(union);
        if (host) {
          const [cx, cz] = centroid(b.footprint);
          const [hx, hz] = interiorPoint(host.outer);
          ring = clip(b.footprint.map(([x, z]): P2 => [x - cx + hx, z - cz + hz]));
        }
      }
      if (!ring) continue;
      footprint = ring;
      // Its own street level and foot, as the tower rule sets them (buildings.ts).
      const under = groundUnder(ring);
      if (under) {
        baseY = Math.floor(under.at * 100) / 100;
        footY = Math.min(baseY, Math.floor((under.min - 0.05) * 100) / 100);
      }
    }
    const topY = b.meta.podiumTopY === pod.topY && b.topY > pod.topY ? b.topY : Math.max(b.topY, r2(pod.topY + 2.5));
    towers.set(b.id, { ...b, footprint, baseY, topY, meta: { ...b.meta, footY, podiumTopY: pod.topY } });
  }
  const out: Building[] = [];
  for (const b of list) {
    if (b.meta.towerOf !== undefined) {
      const t = towers.get(b.id);
      if (t) out.push(t);
      continue;
    }
    if (b.meta.tower !== undefined && !towers.has(b.meta.tower)) {
      const meta = { ...b.meta };
      delete meta.tower;
      out.push({ ...b, meta });
    } else out.push(b);
  }
  return out;
}
/** A tower cut to less than this (m²) inside its podium is dropped. */
const TOWER_MIN_M2 = 4;

/** Two clearance passes' statistics as one. */
function mergeClearance(a: ClearanceStats, b: ClearanceStats): ClearanceStats {
  const u = (p: string[], q: string[]): string[] => [...new Set([...p, ...q])].sort();
  return {
    towersOnStreets: u(a.towersOnStreets, b.towersOnStreets),
    staleDropped: u(a.staleDropped, b.staleDropped),
    reregistered: u(a.reregistered, b.reregistered),
    spans: u(a.spans, b.spans),
    cut: a.cut + b.cut,
    stairsDropped: u(a.stairsDropped, b.stairsDropped),
    slivers: a.slivers + b.slivers,
  };
}

export async function buildWorldFiles(cfg: WorldConfig, raw: RawInputs, overrides: Override[]): Promise<BuildOutput> {
  const t0 = Date.now();
  const lap = (what: string): void => {
    if (process.env.FC_BUILD_TIMES) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);
  };
  // Every tile the build considers, with its heightfield. Which get files is decided below.
  const candidates = candidateTiles(cfg);
  const elev = new Elevation(raw.dems.map((d) => d.raster));
  const fields = new Map<string, Heightfield>();
  for (const t of candidates) fields.set(t.id, tileHeightfield(t, elev));
  const ground = new Ground(candidates.map((t) => ({ ix: t.ix, iz: t.iz, field: fields.get(t.id)! })));

  // Outside the candidate tiles (far ends of boundary-crossing roads): the DEM, else the nearest tile edge.
  const heightAnywhere = (x: number, z: number): number => {
    const g = ground.heightAt(x, z);
    if (g !== null) return g;
    try {
      return elev.sample(x, z).h;
    } catch {
      let bestT: TileRef = candidates[0]!;
      let bestD = Infinity;
      for (const t of candidates) {
        const cx = Math.min(Math.max(x, t.bbox[0]), t.bbox[2]);
        const cz = Math.min(Math.max(z, t.bbox[1]), t.bbox[3]);
        const d = Math.hypot(cx - x, cz - z);
        if (d < bestD) {
          bestD = d;
          bestT = t;
        }
      }
      const cx = Math.min(Math.max(x, bestT.bbox[0]), bestT.bbox[2] - 0.01);
      const cz = Math.min(Math.max(z, bestT.bbox[1]), bestT.bbox[3] - 0.01);
      return ground.heightAt(cx, cz) ?? 0;
    }
  };

  // Open water: the candidate tiles' water flags inside them, the DEM outside them.
  const waterAnywhere = (x: number, z: number): boolean => {
    if (ground.field(x, z)) return ground.waterAt(x, z);
    try {
      return elev.sample(x, z).water;
    } catch {
      return false;
    }
  };

  const districts: District[] = raw.extras ? buildDistricts(raw.extras.neighborhoods) : [];
  lap("terrain");
  const built = buildBuildings(raw.buildings, raw.parcels, overrides, candidates, ground);
  lap("buildings");
  const { stats: bStats, overridesApplied } = built;
  const { graph, stats: rStats, optionalStairs } = buildRoads(raw.streets, candidates, heightAnywhere, waterAnywhere);
  // Pier decks (W-13): raise the piers out of the hydro-flattened bay before anything else reads
  // the ground, then put the road nodes and the pier buildings on them.
  const piers = raisePiers(built.buildings, graph, fields, ground);
  for (const n of graph.nodes) n.y = r2(heightAnywhere(n.x, n.z));
  for (const e of graph.edges) {
    if (crossesWater(e.points, waterAnywhere)) e.bridge = true;
    else delete e.bridge;
  }
  rStats.bridges = graph.edges.filter((e) => e.bridge).length;
  built.buildings = rebaseOnDecks(built.buildings, piers.decks, (ring) => minGroundUnder(ring, ground));
  lap("piers");
  // Tunnels first (their bores pass under buildings), then clear every street and path corridor
  // (W-01, W-39, W-43, W-16), then terrace hillside buildings (W-05, W-28), then give the
  // buildings over a bore an underside.
  lap("roads");
  const tunnels = findTunnels(graph, heightAnywhere, (lat, lon) => toLocal(lat, lon));
  const cleared = clearCorridors(built.buildings, graph, raw.streetDates, ground, { skip: tunnels.skip, keepCentreline: tunnels.edges, optionalStairs });
  lap("clearance");
  // The records under a landmark probe keep their one prism: the landmark replaces them whole.
  const probed = new Set((cfg.probes?.points ?? []).flatMap((pr) => probeBuildings(pr, cleared.buildings).buildings));
  const terraced = terraceBuildings(cleared.buildings, ground, (b) => probed.has(b.id));
  lap("terraces");
  // Terracing lifts roofs that were under the hill: clear the corridors once more for those.
  const recleared = clearCorridors(terraced.buildings, graph, raw.streetDates, ground, { skip: tunnels.skip, keepCentreline: tunnels.edges, optionalStairs });
  lap("clearance again");
  // Decks (W-03, W-07, W-12, W-14): freeway viaducts, overpasses, creek bridges; and the freeway
  // bores they line through their zones (W-02). Before the undersides, which read the final bores.
  const decked = buildDecks(graph, recleared.buildings, heightAnywhere, waterAnywhere, tunnels.bores, (lat, lon) => toLocal(lat, lon));
  lap("decks");
  const bored = undersideOverBores(recleared.buildings, graph, decked.bores, heightAnywhere);
  lap("tunnels");
  // Two-tier records after every pass: a tower stands on its podium record's roof; a tower whose
  // podium a pass removed goes with it.
  const buildings = reconcileTowers(bored.buildings, (ring) => minGroundUnder(ring, ground));

  // Tile selection: a tile is built when it holds a building, a road passes through it, or it
  // has land (citywide: land inside San Francisco's neighbourhoods). Open water gets no file.
  const byTile = new Map<string, Building[]>();
  for (const b of buildings) {
    let l = byTile.get(b.tile);
    if (!l) byTile.set(b.tile, (l = []));
    l.push(b);
  }
  const edgeBoxes = graph.edges.map((e) => ({ e, box: edgeBox(e) }));
  const inSf = districts.length > 0 ? new DistrictIndex(districts) : null;
  const sel: TileSelection = { candidates: candidates.length, built: 0, water: 0, outside: 0, withBuildings: 0, withRoads: 0, withLand: 0 };
  const tiles: TileRef[] = [];
  const waterTiles: string[] = [];
  const outsideTiles: Array<{ id: string; area: OutsideArea }> = [];
  for (const t of candidates) {
    const f = fields.get(t.id)!;
    const hasBuildings = (byTile.get(t.id)?.length ?? 0) > 0;
    const hasRoads = edgeBoxes.some(({ e, box }) => overlaps(box, t.bbox) && polylineCrosses(e.points, t.bbox));
    let hasLand = false;
    let anyLand = false;
    for (let k = 0; k < f.nz && !hasLand; k++) {
      for (let i = 0; i < f.nx && !hasLand; i++) {
        if (f.water[k * f.nx + i] === 1) continue;
        anyLand = true;
        const x = f.x0 + i * f.cellSizeM;
        const z = f.z0 + k * f.cellSizeM;
        if (!inSf || inSf.at(x, z)) hasLand = true;
      }
    }
    if (hasBuildings) sel.withBuildings++;
    if (hasRoads) sel.withRoads++;
    if (hasLand) sel.withLand++;
    if (hasBuildings || hasRoads || hasLand) tiles.push(t);
    else if (anyLand) {
      sel.outside++;
      outsideTiles.push({ id: t.id, area: outsideArea(t) });
    }
    else waterTiles.push(t.id);
  }
  sel.built = tiles.length;
  sel.water = waterTiles.length;
  if (tiles.length === 0) throw new Error("no tile has buildings, roads or land");
  assignTiles(districts, tiles);
  let candMinX = Infinity, candMinZ = Infinity, candMaxX = -Infinity, candMaxZ = -Infinity;
  for (const t of candidates) {
    candMinX = Math.min(candMinX, t.bbox[0]); candMinZ = Math.min(candMinZ, t.bbox[1]);
    candMaxX = Math.max(candMaxX, t.bbox[2]); candMaxZ = Math.max(candMaxZ, t.bbox[3]);
  }
  // The sim's ground: built tiles only (open water and land outside the city are 0 / absent).
  const simGround = new Ground(tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: fields.get(t.id)! })));

  const { storefronts, stats: sStats } = buildStorefronts(raw.businesses, buildings, graph.edges, simGround);
  const spawn = chooseSpawn(cfg, graph, buildings);

  const files = new Map<string, Uint8Array>();
  const boundary = buildBoundary(tiles, fields);
  const structures: TileStructures = { decks: new Map(), tunnels: new Map(), movable: new Map() };
  for (const { tile, tunnel } of tunnelRibbons(graph, decked.bores, heightAnywhere)) {
    const l = structures.tunnels.get(tile);
    if (l) l.push(tunnel);
    else structures.tunnels.set(tile, [tunnel]);
  }
  for (const { tile, deck } of decked.decks) (structures.decks.get(tile) ?? structures.decks.set(tile, []).get(tile)!).push(deck);
  for (const { tile, tunnel } of decked.tunnels) (structures.tunnels.get(tile) ?? structures.tunnels.set(tile, []).get(tile)!).push(tunnel);
  for (const { tile, movable } of decked.movable) (structures.movable.get(tile) ?? structures.movable.set(tile, []).get(tile)!).push(movable);
  for (const m of [structures.decks, structures.tunnels, structures.movable] as Array<Map<string, Array<{ id: string }>>>) {
    for (const l of m.values()) l.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Junction polygons (W-32): ribbons stop short of a node where three or more streets meet.
  const radii = junctionRadii(graph.edges);
  const junctions = junctionPolygons(graph.edges, radii, new Map(graph.nodes.map((n) => [n.id, n])));
  const nodeAt = new Map(graph.nodes.map((n) => [n.id, n]));

  // Walls two records share exactly hide each other where both stand (W-36): not drawn.
  const party = partyWalls(buildings);
  let minY = Infinity, maxY = -Infinity, waterSamples = 0, samples = 0;
  const manifestTiles: unknown[] = [];
  for (const t of tiles) {
    const field = fields.get(t.id)!;
    for (let i = 0; i < field.heights.length; i++) {
      minY = Math.min(minY, field.heights[i]!);
      maxY = Math.max(maxY, field.heights[i]!);
      waterSamples += field.water[i]!;
      samples++;
    }
    const tb = byTile.get(t.id) ?? [];
    const collider = jsonLines(
      {
        tileId: t.id,
        ground: field,
        buildings: tb.map((b) => colliderBuilding(b, true)),
        ...tileStructures(structures, t.id),
      },
      ["buildings", "decks", "tunnels", "movable"],
    );
    files.set(`${t.id}.collider.json`, utf8(collider));

    const tileEdges = edgeBoxes.filter(({ box }) => overlaps(box, t.bbox)).map(({ e }) => e);
    const tileJunctions = [...junctions]
      .filter(([n]) => {
        const p = nodeAt.get(n)!;
        return p.x >= t.bbox[0] && p.x < t.bbox[2] && p.z >= t.bbox[1] && p.z < t.bbox[3];
      })
      .map(([, poly]) => poly);
    const { roads, freeways } = roadMeshes(tileEdges, t, ground, decked.surface, radii, tileJunctions);
    const { mesh, ranges } = buildingMesh(tb, party);
    const glb = await tileGlb(cfg.id, t, {
      ground: groundMesh(field, ground),
      roads,
      freeways,
      buildings: mesh,
      buildingRanges: ranges,
      structures: deckMesh(structures.decks.get(t.id) ?? [], ground),
    });
    files.set(`${t.id}.glb`, glb);
    const water = field.water.reduce((s, v) => s + v, 0) / field.water.length;
    manifestTiles.push({
      id: t.id,
      ix: t.ix,
      iz: t.iz,
      bbox: t.bbox,
      collider: `${t.id}.collider.json`,
      glb: `${t.id}.glb`,
      stats: {
        buildings: tb.length,
        roadEdges: tileEdges.length,
        waterFraction: r2(water),
        maxTopY: r2(tb.reduce((m, b) => Math.max(m, b.topY), 0)),
      },
    });
  }

  files.set(
    "roads.json",
    utf8(jsonLines({ version: graph.version, attribution: graph.attribution, nodes: graph.nodes, edges: graph.edges }, ["nodes", "edges"])),
  );
  files.set(
    "storefronts.json",
    utf8(
      jsonLines(
        {
          version: 1,
          world: cfg.id,
          description:
            "Storefront anchors: active registered business locations with a storefront NAICS code, snapped to a street-facing ground-floor wall of the containing building. No names. heading = compass bearing the shopfront faces.",
          attribution: ATTRIBUTION[3],
          storefronts,
        },
        ["storefronts"],
      ),
    ),
  );

  // The binary citywide collider pack: what the sim should load at boot.
  const pack = encodeWorldColliders({
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: TILE_SIZE_M,
    tiles: tiles.map((t) => ({
      tileId: t.id,
      ix: t.ix,
      iz: t.iz,
      ground: fields.get(t.id)!,
      buildings: (byTile.get(t.id) ?? []).map((b) => colliderBuilding(b, false)),
      ...tileStructures(structures, t.id),
    })),
  });
  files.set("world.colliders.bin", pack);

  lap("tiles");
  // Far-LOD massing over the whole candidate rectangle (the DEM reaches it all).
  const far = await buildFarLod(cfg.id, {
    buildings,
    terrain: (x, z) => {
      try {
        return elev.sample(x, z);
      } catch {
        return null;
      }
    },
    bounds: [candMinX, candMinZ, candMaxX, candMaxZ],
  });
  for (const c of far) files.set(`${c.id}.glb`, c.glb);

  // Gameplay layers (citywide worlds only: they need the extra DataSF datasets).
  const layers: Record<string, string> = {};
  const layerCounts: Record<string, number> = {};
  let sidewalkStats: SidewalkStats | null = null;
  const builtIds = new Set(tiles.map((t) => t.id));
  const inWorld = (x: number, z: number): boolean => builtIds.has(`t${Math.floor(x / TILE_SIZE_M)}_${Math.floor(z / TILE_SIZE_M)}`);
  const heightOr0 = (x: number, z: number): number => simGround.heightAt(x, z) ?? 0;
  const layer = (name: string, file: string, description: string, attribution: string, key: string, rows: unknown[], extra: Record<string, unknown> = {}): void => {
    files.set(file, utf8(jsonLines({ version: 1, world: cfg.id, description, attribution, ...extra, [key]: rows }, [key])));
    layers[name] = file;
    layerCounts[name] = rows.length;
  };
  files.set(
    "boundary.json",
    utf8(
      jsonLines(
        {
          version: 1,
          world: cfg.id,
          description:
            "The world's edge and shore, local metres. edges: the outline of the built tiles (built tiles on the left of travel, +x east, +z south); kind land = the world stops on dry ground (wall it: there is no ground beyond), kind water = the outline crosses open water. shore: the land/water line inside the built tiles (10 m ground lattice water flags, marching squares, simplified 2.5 m; land on the left of travel): the sea-wall line and the Bay-edge refill zone. Sea level y = 0.",
          attribution: "Derived from USGS 3DEP elevation (public domain) and the built tile set.",
          seaLevelY: 0,
          edges: boundary.edges,
          shore: boundary.shore,
        },
        ["edges", "shore"],
      ),
    ),
  );
  layers.boundary = "boundary.json";
  layerCounts.boundaryEdges = boundary.edges.length;
  layerCounts.shoreLines = boundary.shore.length;
  if (districts.length > 0) {
    layer(
      "districts",
      "districts.json",
      "San Francisco's Analysis Neighborhoods as polygons in local metres (outer rings counter-clockwise on a north-up map, holes clockwise, not closed), with the built tiles each overlaps. Geometry only: which districts are active is content's decision.",
      ATTRIBUTION[6]!,
      "districts",
      districts,
    );
  }
  if (raw.extras) {
    const x = raw.extras;
    const signals = buildSignals(x.signals, graph);
    const signalNodes = new Set(signals.filter((q) => q.kind === "signal").map((q) => q.node));
    const painted = crosswalkNodes(x.crosswalks, graph);
    const { graph: walk, stats: wStats } = buildSidewalks(graph, heightOr0, signalNodes, painted);
    sidewalkStats = wStats;
    files.set(
      "sidewalks.json",
      utf8(
        jsonLines(
          {
            version: 1,
            world: cfg.id,
            description:
              "Sidewalk navigation graph: sidewalks offset from each road edge by half its width plus 2 m, corner nodes where they meet, crossings at intersections, signals, crosswalks and dead ends. Procedural from roads.json. One graph for the whole world.",
            attribution: graph.attribution,
            nodes: walk.nodes,
            edges: walk.edges,
          },
          ["nodes", "edges"],
        ),
      ),
    );
    layers.sidewalks = "sidewalks.json";
    layerCounts.sidewalkNodes = walk.nodes.length;
    layerCounts.sidewalkEdges = walk.edges.length;

    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.kind === "freeway" || e.kind === "ramp") continue;
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const bidx = new BuildingIndex(buildings);
    const surface = new RoadSurface(trafficEdges(graph.edges));
    const isLand = (px: number, pz: number): boolean =>
      inWorld(px, pz) && !simGround.waterAt(px, pz) && !insideAny(px, pz, (qx, qz) => bidx.near(qx, qz, 1));
    layer(
      "hydrants",
      "hydrants.json",
      "Procedural fire hydrants (no open dataset exists): sidewalk corners at intersections about every 120 m, plus points along long sidewalks. Water refills.",
      "Procedural, from the sidewalk graph (derived from DataSF 3psu-pn9h, ODC PDDL 1.0).",
      "hydrants",
      buildHydrants(walk, (n) => degree.get(n) ?? 0, isLand, heightOr0, (px, pz) => surface.clearance(px, pz)),
    );
    layer("fountains", "fountains.json", "Public drinking-water points (no names). Water refills.", ATTRIBUTION[9]!, "fountains", buildFountains(x.fountains, inWorld, heightOr0));
    const transit = buildTransit(x.muniRoutes, x.muniStops, inWorld, heightOr0);
    files.set(
      "muni.json",
      utf8(
        jsonLines(
          {
            version: 1,
            world: cfg.id,
            description:
              "Public transit route patterns (bus, rail, streetcar and the three cable car lines: mode \"cable\" is the cable car track) and stops, local metres. Route paths may run outside the built tiles; stops are inside them. Liveries are the game's own.",
            attribution: ATTRIBUTION[7]!,
            routes: transit.routes,
            stops: transit.stops,
          },
          ["routes", "stops"],
        ),
      ),
    );
    layers.transit = "muni.json";
    layerCounts.transitRoutes = transit.routes.length;
    layerCounts.transitStops = transit.stops.length;
    layer("signals", "signals.json", "Working traffic signals and beacons at road-graph nodes. Phases are the sim's (procedural).", ATTRIBUTION[7]!, "signals", signals);
    layer(
      "streetCleaning",
      "street-cleaning.json",
      "Street Cleaning rules per road edge and side (side relative to the edge's a -> b direction in roads.json). day: ISO weekday 1-7, 0 = holidays only; weeks: weeks of the month.",
      ATTRIBUTION[8]!,
      "rules",
      buildStreetCleaning(x.sweeping, raw.streets, graph),
    );
    layer(
      "parking",
      "parking.json",
      "Parking regulations per road edge and side (matched by midpoint within 25 m). from/to: minutes after midnight; days: ISO weekdays.",
      ATTRIBUTION[7]!,
      "rules",
      buildParking(x.parking, graph),
    );
  }

  const manifest = {
    version: 1,
    world: cfg.id,
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: TILE_SIZE_M,
    spawn: { x: spawn.x, z: spawn.z, heading: spawn.heading },
    attribution: ATTRIBUTION,
    tiles: manifestTiles,
    roads: "roads.json",
    water: { y: 0, bbox: [candMinX, candMinZ, candMaxX, candMaxZ], tiles: waterTiles },
    outside: {
      description: OUTSIDE_DESCRIPTION,
      tiles: outsideTiles,
    },
    worldColliders: "world.colliders.bin",
    farCellSizeM: FAR_CELL_M,
    far: far.map((c) => ({ id: c.id, cx: c.cx, cz: c.cz, bbox: c.bbox, glb: `${c.id}.glb`, stats: c.stats })),
    ...(Object.keys(layers).length ? { layers } : {}),
  };
  files.set("manifest.json", utf8(jsonPretty(manifest)));

  const tallest = [...buildings]
    .sort((a, b) => b.topY - b.baseY - (a.topY - a.baseY) || (a.id < b.id ? -1 : 1))
    .slice(0, 10)
    .map((b) => ({ id: b.id, heightM: r2(b.topY - b.baseY), topY: b.topY, parcel: b.meta.parcel, source: b.meta.heightSource }));
  const report: Report = {
    world: cfg.id,
    areas: cfg.areas.map((a) => {
      const set = worldTiles({ ...cfg, areas: [a] });
      const built = new Set(tiles.map((t) => t.id));
      return { id: a.id, milestone: a.milestone, tiles: set.length, built: set.filter((t) => built.has(t.id)).length };
    }),
    tiles: tiles.length,
    selection: sel,
    buildings: bStats,
    terrace: terraced.stats,
    clearance: mergeClearance(cleared.stats, recleared.stats),
    tunnels: { bores: decked.bores, buildingsOver: bored.ids, droppedInPortalCuts: bored.dropped },
    piers: piers.stats,
    decks: decked.stats,
    overridesApplied,
    roads: rStats,
    storefronts: sStats,
    sidewalks: sidewalkStats,
    layers: layerCounts,
    outside: Object.fromEntries(
      [...new Set(outsideTiles.map((t) => t.area))].sort().map((a) => [a, outsideTiles.filter((t) => t.area === a).map((t) => t.id)]),
    ),
    boundary: boundary.stats,
    colliderPack: { bytes: pack.byteLength, tiles: tiles.length, buildings: buildings.length },
    far: {
      cells: far.length,
      triangles: far.reduce((a, c) => a + c.stats.triangles, 0),
      records: far.reduce((a, c) => a + c.stats.records, 0),
      bytes: far.reduce((a, c) => a + c.glb.byteLength, 0),
    },
    terrain: { minY, maxY, waterSamples, samples },
    spawn: { ...spawn, y: r2(simGround.heightAt(spawn.x, spawn.z) ?? 0) },
    probes: (cfg.probes?.points ?? []).map((pr) => probeBuildings(pr, buildings)),
    tallest,
  };
  files.set("report.json", utf8(jsonPretty(report)));
  return { files, report };
}
