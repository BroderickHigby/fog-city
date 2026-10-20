// Raw inputs -> every file of public/tiles/<world>/, in memory. Pure apart from CPU time:
// the same inputs give byte-identical files.

import { ORIGIN, TILE_SIZE_M, toLocal } from "../../src/geo/project.ts";
import type { Spawn } from "../../src/sim/contract.ts";
import { buildBuildings, type Building, type BuildingStats, type Override } from "./buildings.ts";
import { worldTiles, type Probe, type TileRef, type WorldConfig } from "./config.ts";
import { bearing, distToRing, distToSegment, pointInRing, r2 } from "./geom.ts";
import { tileGlb } from "./glb.ts";
import { buildingMesh, groundMesh, roadMeshes } from "./mesh.ts";
import { jsonLines, jsonPretty, utf8 } from "./output.ts";
import { buildRoads, titleCase, type RoadEdge, type RoadGraph, type RoadStats } from "./roads.ts";
import type { RawInputs } from "./sources.ts";
import { buildStorefronts, type StorefrontStats } from "./storefronts.ts";
import { Elevation, Ground, tileHeightfield, type Heightfield } from "./terrain.ts";

export const ATTRIBUTION = [
  "Building footprints and LiDAR heights: City and County of San Francisco, DataSF \"Building Footprints\" (ynuv-fyni), Open Data Commons Public Domain Dedication and License (PDDL) 1.0.",
  "Street centerlines: City and County of San Francisco, DataSF \"Streets – Active and Retired\" (3psu-pn9h), ODC PDDL 1.0.",
  "Building year, use and storeys: San Francisco Office of the Assessor-Recorder via DataSF \"Assessor Historical Secured Property Tax Rolls\" (wv5m-vpq2), ODC PDDL 1.0.",
  "Storefront positions (no names): San Francisco Treasurer & Tax Collector via DataSF \"Registered Business Locations\" (g8m3-pdis), ODC PDDL 1.0.",
  "Elevation: U.S. Geological Survey, 3D Elevation Program (3DEP) bare-earth DEM, public domain.",
  "Height corrections for buildings newer than the 2010 LiDAR: public records, listed in pipeline/overrides.json.",
];

export interface Report {
  world: string;
  areas: Array<{ id: string; milestone: string; tiles: number }>;
  tiles: number;
  buildings: BuildingStats;
  overridesApplied: string[];
  roads: RoadStats;
  storefronts: StorefrontStats;
  terrain: { minY: number; maxY: number; waterSamples: number; samples: number };
  spawn: Spawn & { edge: string; y: number };
  /** Building records at each configured probe point (for landmarks' replacesBuildingIds). */
  probes: Array<{ id: string; label: string; x: number; z: number; buildings: string[]; nearestM: number }>;
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

/** Records containing the probe point (a podium and its tower), else the nearest within 30 m. */
function probeBuildings(pr: Probe, buildings: readonly Building[]): Report["probes"][number] {
  const { x, z } = toLocal(pr.lat, pr.lon);
  const inside = buildings.filter((b) => pointInRing(x, z, b.footprint)).map((b) => b.id);
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
  return { id: pr.id, label: pr.label, x: r2(x), z: r2(z), buildings: ids.sort(), nearestM: r2(Number.isFinite(nearestM) ? nearestM : -1) };
}

export async function buildWorldFiles(cfg: WorldConfig, raw: RawInputs, overrides: Override[]): Promise<BuildOutput> {
  const tiles = worldTiles(cfg);
  const elev = new Elevation(raw.dems.map((d) => d.raster));
  const fields = new Map<string, Heightfield>();
  for (const t of tiles) fields.set(t.id, tileHeightfield(t, elev));
  const ground = new Ground(tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: fields.get(t.id)! })));

  // Outside the world's tiles (far ends of boundary-crossing roads): the DEM, else the nearest tile edge.
  const heightAnywhere = (x: number, z: number): number => {
    const g = ground.heightAt(x, z);
    if (g !== null) return g;
    try {
      return elev.sample(x, z).h;
    } catch {
      let bestT: TileRef = tiles[0]!;
      let bestD = Infinity;
      for (const t of tiles) {
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

  // Open water: the world's water flags inside the tiles, the DEM outside them.
  const waterAnywhere = (x: number, z: number): boolean => {
    if (ground.field(x, z)) return ground.waterAt(x, z);
    try {
      return elev.sample(x, z).water;
    } catch {
      return false;
    }
  };

  const { buildings, stats: bStats, overridesApplied } = buildBuildings(raw.buildings, raw.parcels, overrides, tiles, ground);
  const { graph, stats: rStats } = buildRoads(raw.streets, tiles, heightAnywhere, waterAnywhere);
  const { storefronts, stats: sStats } = buildStorefronts(raw.businesses, buildings, graph.edges, ground);
  const spawn = chooseSpawn(cfg, graph, buildings);

  const files = new Map<string, Uint8Array>();
  const byTile = new Map<string, Building[]>();
  for (const b of buildings) {
    let l = byTile.get(b.tile);
    if (!l) byTile.set(b.tile, (l = []));
    l.push(b);
  }
  const edgeBoxes = graph.edges.map((e) => ({ e, box: edgeBox(e) }));

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
        buildings: tb.map((b) => ({ id: b.id, footprint: b.footprint, baseY: b.baseY, topY: b.topY, meta: b.meta })),
      },
      ["buildings"],
    );
    files.set(`${t.id}.collider.json`, utf8(collider));

    const tileEdges = edgeBoxes.filter(({ box }) => overlaps(box, t.bbox)).map(({ e }) => e);
    const { roads, freeways } = roadMeshes(tileEdges, t, ground);
    const { mesh, ranges } = buildingMesh(tb);
    const glb = await tileGlb(cfg.id, t, {
      ground: groundMesh(field, ground),
      roads,
      freeways,
      buildings: mesh,
      buildingRanges: ranges,
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

  const manifest = {
    version: 1,
    world: cfg.id,
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: TILE_SIZE_M,
    spawn: { x: spawn.x, z: spawn.z, heading: spawn.heading },
    attribution: ATTRIBUTION,
    tiles: manifestTiles,
    roads: "roads.json",
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
      return { id: a.id, milestone: a.milestone, tiles: set.length };
    }),
    tiles: tiles.length,
    buildings: bStats,
    overridesApplied,
    roads: rStats,
    storefronts: sStats,
    terrain: { minY, maxY, waterSamples, samples },
    spawn: { ...spawn, y: r2(ground.heightAt(spawn.x, spawn.z) ?? 0) },
    probes: (cfg.probes?.points ?? []).map((pr) => probeBuildings(pr, buildings)),
    tallest,
  };
  files.set("report.json", utf8(jsonPretty(report)));
  return { files, report };
}
