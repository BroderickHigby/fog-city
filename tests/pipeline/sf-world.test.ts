// Goldens on the committed San Francisco world (public/tiles/sf), produced by
// `node pipeline/build-world.ts --world sf`. No network: these read committed files only.
// The citywide goldens (terrain, routing, districts, sidewalks, layers) are in citywide.test.ts.

import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ORIGIN, TILE_SIZE_M, tileId, toLocal } from "../../src/geo/project.ts";
import { DT, buildWorld, createInitialState, groundHeight, pointInPolygon, step, type World } from "../../src/sim/index.ts";
import { CANOPY_MAX_STORIES, isLidarSpike, outlierRoof } from "../../pipeline/lib/buildings.ts";
import { areaTileRect, loadWorldConfig } from "../../pipeline/lib/config.ts";
import { interiorPoint, signedArea } from "../../pipeline/lib/geom.ts";
import { isStorefrontNaics } from "../../pipeline/lib/storefronts.ts";
import { ROOT, readJson } from "../helpers.ts";
import { groundIndex, loadSf, type SfBuilding, type SfCollider, type SfManifest, type SfRoads, type SfStorefronts } from "./util.ts";

// Whole-city checks: generous timeouts, since the suite shares the CPU with other workers.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DIR = join(ROOT, "public/tiles/sf");
let manifest: SfManifest;
let colliders: SfCollider[];
let roads: SfRoads;
let storefronts: SfStorefronts;
let world: World;
let buildings: SfBuilding[];
/** The sim's ground (src/sim/world.ts groundHeight), looked up by tile index for speed. */
let ground: (x: number, z: number) => number;

beforeAll(() => {
  ({ manifest, colliders, roads, storefronts } = loadSf());
  world = buildWorld(colliders);
  buildings = colliders.flatMap((c) => c.buildings);
  ground = groundIndex(colliders);
});

let tileIds: Set<string>;
const insideWorld = (x: number, z: number): boolean => {
  tileIds ??= new Set(manifest.tiles.map((t) => t.id));
  return tileIds.has(tileId(Math.floor(x / TILE_SIZE_M), Math.floor(z / TILE_SIZE_M)));
};

describe("sf world: schemas and layout", () => {
  it("manifest, colliders, roads and every data layer validate against their schemas", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const v = (name: string) => ajv.compile(readJson(`schemas/${name}.schema.json`));
    const mv = v("tile-manifest");
    expect(mv(manifest), ajv.errorsText(mv.errors)).toBe(true);
    const rv = v("roads");
    expect(rv(roads), ajv.errorsText(rv.errors)).toBe(true);
    const cv = v("tile-collider");
    for (const c of colliders) expect(cv(c), `${c.tileId}: ${ajv.errorsText(cv.errors)}`).toBe(true);
    expect(Object.keys(manifest.layers).sort()).toEqual(
      ["boundary", "districts", "fountains", "gameplay", "hydrants", "parking", "sidewalks", "signals", "streetCleaning", "transit"].sort(),
    );
    for (const [layer, file] of Object.entries(manifest.layers)) {
      const lv = v(layer === "gameplay" ? "tile-gameplay" : file.replace(/\.json$/, ""));
      expect(lv(readJson(`public/tiles/sf/${file}`)), `${file}: ${ajv.errorsText(lv.errors)}`).toBe(true);
    }
  });

  it("manifest: world sf, the shared origin, 500 m tiles on the grid, roads.json, attribution", () => {
    expect(manifest.world).toBe("sf");
    expect(manifest.origin).toEqual({ lat: ORIGIN.lat, lon: ORIGIN.lon });
    expect(manifest.tileSizeM).toBe(TILE_SIZE_M);
    expect(manifest.roads).toBe("roads.json");
    expect(manifest.attribution.join(" ")).toMatch(/DataSF/);
    expect(manifest.attribution.join(" ")).toMatch(/3DEP/);
    const ids = new Set<string>();
    for (const t of manifest.tiles) {
      expect(t.id).toBe(tileId(t.ix, t.iz));
      expect(t.bbox).toEqual([t.ix * 500, t.iz * 500, (t.ix + 1) * 500, (t.iz + 1) * 500]);
      expect(t.collider).toBe(`${t.id}.collider.json`);
      expect(t.glb).toBe(`${t.id}.glb`);
      expect(existsSync(join(DIR, t.collider))).toBe(true);
      expect(existsSync(join(DIR, t.glb))).toBe(true);
      ids.add(t.id);
    }
    expect(ids.size).toBe(manifest.tiles.length);
    // No stray files: everything in the directory is referenced by the manifest or a known extra.
    // Street detail (pipeline/build-street-detail.ts) is its own index plus the layers it lists.
    const detail = existsSync(join(DIR, "street-detail.json"))
      ? (JSON.parse(readFileSync(join(DIR, "street-detail.json"), "utf8")) as { layers: Record<string, string> })
      : null;
    const detailFiles = detail ? ["street-detail.json", ...Object.values(detail.layers)] : [];
    const extras = new Set(["manifest.json", "roads.json", "storefronts.json", "report.json", manifest.worldColliders, ...Object.values(manifest.layers), ...manifest.far.map((f) => f.glb), ...detailFiles]);
    for (const f of readdirSync(DIR)) {
      expect(extras.has(f) || manifest.tiles.some((t) => t.collider === f || t.glb === f), f).toBe(true);
    }
    // Water-only tiles, and land tiles outside the world, have no files and no manifest entry.
    for (const id of [...manifest.water.tiles, ...manifest.outside.tiles.map((t) => t.id)]) {
      expect(ids.has(id), id).toBe(false);
      expect(existsSync(join(DIR, `${id}.glb`)), id).toBe(false);
    }
  });

  it("every tile touched by every wave-1 area in pipeline/areas.json is present, or listed as open water (M0 and M1)", () => {
    const cfg = loadWorldConfig(ROOT, "sf");
    expect(cfg.areas.map((a) => a.id)).toEqual(["downtown", "north-beach", "embarcadero-north", "marina", "dogpatch"]);
    const have = new Set(manifest.tiles.map((t) => t.id));
    const water = new Set(manifest.water.tiles);
    for (const a of cfg.areas) {
      const r = areaTileRect(a);
      for (let ix = r.ix0; ix <= r.ix1; ix++) {
        for (let iz = r.iz0; iz <= r.iz1; iz++) expect(have.has(tileId(ix, iz)) || water.has(tileId(ix, iz)), `${a.id} ${tileId(ix, iz)}`).toBe(true);
      }
    }
  });
});

describe("sf world: terrain", () => {
  it("is a few metres above sea level at the origin (Ferry Building), on land", () => {
    const h = groundHeight(world, 0, 0);
    expect(ground(0, 0)).toBe(h);
    expect(h).toBeGreaterThan(1);
    expect(h).toBeLessThan(10);
  });

  it("the bay east of the Ferry Building is water at sea level", () => {
    const t = colliders.find((c) => c.tileId === "t1_0")!;
    const g = t.ground;
    // x = 600, z = 100: open water off Pier 14.
    const i = (600 - g.x0) / g.cellSizeM;
    const k = (100 - g.z0) / g.cellSizeM;
    expect(g.water[k * g.nx + i]).toBe(1);
    expect(g.heights[k * g.nx + i]).toBe(0);
  });

  it("Telegraph Hill rises well above downtown", () => {
    const coit = toLocal(37.8024, -122.4058);
    expect(groundHeight(world, coit.x, coit.z)).toBeGreaterThan(60);
    expect(ground(coit.x, coit.z)).toBe(groundHeight(world, coit.x, coit.z));
  });

  it("each tile's heightfield covers it on a 10 m lattice, and neighbours share their border exactly", () => {
    const byId = new Map(colliders.map((c) => [c.tileId, c]));
    for (const t of manifest.tiles) {
      const g = byId.get(t.id)!.ground;
      expect([g.x0, g.z0, g.cellSizeM, g.nx, g.nz]).toEqual([t.bbox[0], t.bbox[1], 10, 51, 51]);
      expect(g.heights).toHaveLength(51 * 51);
      expect(g.water).toHaveLength(51 * 51);
      const east = byId.get(tileId(t.ix + 1, t.iz))?.ground;
      if (east) for (let k = 0; k < 51; k++) expect(east.heights[k * 51]).toBe(g.heights[k * 51 + 50]);
      const south = byId.get(tileId(t.ix, t.iz + 1))?.ground;
      if (south) for (let i = 0; i < 51; i++) expect(south.heights[i]).toBe(g.heights[50 * 51 + i]);
    }
  });
});

describe("sf world: buildings", () => {
  it("ids are unique, footprints are simple rings counter-clockwise on a north-up map", () => {
    const ids = new Set<string>();
    for (const b of buildings) {
      expect(ids.has(b.id), b.id).toBe(false);
      ids.add(b.id);
      expect(b.footprint.length).toBeGreaterThanOrEqual(3);
      expect(signedArea(b.footprint)).toBeLessThan(0);
      expect(b.topY).toBeGreaterThan(b.baseY);
    }
    expect(buildings.length).toBeGreaterThan(175000);
  });

  // The 2010 LiDAR saw a construction site here (median 0.24 m), so this golden checks the
  // public-record override in pipeline/overrides.json, not the LiDAR scaling. The LiDAR-only
  // goldens below check that.
  it("golden, with its public-record override: the tallest building in the M0 bbox is the 415 Mission St tower, ~326 m (within 10%)", () => {
    const nw = toLocal(37.805, -122.405);
    const se = toLocal(37.78, -122.385);
    const inM0 = buildings.filter((b) => {
      const [x, z] = interiorPoint(b.footprint);
      return x >= nw.x && x <= se.x && z >= nw.z && z <= se.z;
    });
    expect(inM0.length).toBeGreaterThan(1500);
    const tallest = inM0.reduce((m, b) => (b.topY - b.baseY > m.topY - m.baseY ? b : m));
    const p = toLocal(37.7897, -122.3972);
    expect(pointInPolygon(p.x, p.z, tallest.footprint)).toBe(true);
    expect(tallest.meta.parcel).toBe("3720009");
    expect(tallest.meta.heightSource).toBe("override");
    const h = tallest.topY - tallest.baseY;
    expect(Math.abs(h - 326) / 326).toBeLessThan(0.1);
  });

  // LiDAR-only goldens: well-known towers that stood in June 2010, against their public-record
  // roof heights. A building is every record containing the point plus their towers.
  const lidarGoldens: Array<[string, number, number, number]> = [
    ["600 Montgomery St pyramid", 37.7952, -122.4028, 260],
    ["555 California St", 37.792, -122.4037, 237],
    ["101 California St", 37.7928, -122.3979, 183],
    ["301 Mission St", 37.7905, -122.3962, 197],
  ];
  for (const [label, lat, lon, roofM] of lidarGoldens) {
    it(`golden without an override: ${label} stands ~${roofM} m from the LiDAR alone (within 10%)`, () => {
      const p = toLocal(lat, lon);
      const byId = new Map(buildings.map((b) => [b.id, b]));
      const recs = buildings.filter((b) => pointInPolygon(p.x, p.z, b.footprint));
      expect(recs.length).toBeGreaterThan(0);
      for (const b of [...recs]) if (b.meta.tower) recs.push(byId.get(b.meta.tower)!);
      expect(recs.every((b) => b.meta.heightSource === "lidar")).toBe(true);
      const top = Math.max(...recs.map((b) => b.topY - b.baseY));
      expect(Math.abs(top - roofM) / roofM).toBeLessThan(0.1);
    });
  }

  // Condominium towers that stood in June 2010. Their unit parcels list 1-2 storeys, so the
  // canopy guard (a residential building of at most 4 storeys) once took them for houses under
  // trees and flattened them: One Rincon Hill was an 18.8 m prism. A condo's storeys are its
  // units', never the building's, so condos skip that guard. Roofs as the 2010 LiDAR measured
  // them (One Rincon Hill's public-record roof is 188 m).
  const condoGoldens: Array<[string, string, number, number, number]> = [
    ["One Rincon Hill", "201006.0000534", 37.78598, -122.39219, 182],
    ["757 Market St", "201006.0000321", 37.78621, -122.40405, 130],
    ["The Watermark, 501 Beale St", "201006.0001143", 37.78625, -122.38906, 73],
  ];
  for (const [label, id, lat, lon, roofM] of condoGoldens) {
    it(`golden, a condominium tower: ${label} keeps its ~${roofM} m LiDAR tower (within 10%)`, () => {
      const byId = new Map(buildings.map((b) => [b.id, b]));
      const pod = byId.get(id)!;
      expect(pod.meta).toMatchObject({ condo: true, heightSource: "lidar", tower: `${id}-tower` });
      expect(pod.meta.stories ?? 0).toBeLessThanOrEqual(2);
      const tower = byId.get(`${id}-tower`)!;
      const p = toLocal(lat, lon);
      expect(pointInPolygon(p.x, p.z, tower.footprint)).toBe(true);
      expect(Math.abs(tower.topY - tower.baseY - roofM) / roofM).toBeLessThan(0.1);
    });
  }

  it("every tower wave 1's last fix (eb3e8e3) built still stands, unless a wave-2 guard explains its removal", () => {
    const fx = readJson("tests/pipeline/wave1-towers.json") as { towers: string[]; dropped: Record<string, "canopy" | "spike"> };
    const byId = new Map(buildings.map((b) => [b.id, b]));
    expect(fx.towers).toHaveLength(631);
    expect(Object.keys(fx.dropped).every((id) => fx.towers.includes(id))).toBe(true);
    const lost: string[] = [];
    for (const id of fx.towers) {
      const why = fx.dropped[id];
      if (!why) {
        if (!byId.has(id)) lost.push(id);
        continue;
      }
      expect(byId.has(id), `${id} is listed as dropped (${why}) but stands`).toBe(false);
      const b = byId.get(id.slice(0, -"-tower".length))!;
      const [med, max] = b.meta.lidarM;
      expect(b.meta.tower, id).toBeUndefined();
      expect(b.meta.heightM, id).toBeCloseTo(outlierRoof(med, max), 1);
      if (why === "canopy") {
        // A low house under trees: never a condominium (their storeys are the units').
        expect(b.meta.condo, id).toBeUndefined();
        expect(b.meta.use?.toLowerCase(), id).toContain("residential");
        expect(b.meta.stories, id).toBeLessThanOrEqual(CANOPY_MAX_STORIES);
        expect(max, id).toBeGreaterThan(b.meta.stories! * 4.5 + 8);
      } else {
        // A thin tower its storeys contradict (its area, under 60 m², is not in the output).
        expect(isLidarSpike(0, med, max, b.meta.stories ?? Number.NaN), id).toBe(true);
      }
    }
    expect(lost).toEqual([]);
    // 13 canopy and 14 spike drops. The guards only ever remove a tower, so this list can
    // only shrink; a new entry needs a reason in docs/data-sources.md.
    expect(Object.keys(fx.dropped)).toHaveLength(27);
  });

  it("no needles: every tower covers at least 20 m² and rises at most ~10x its width above its podium", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    const bad: string[] = [];
    for (const b of buildings) {
      if (!b.meta.towerOf) continue;
      const area = Math.abs(signedArea(b.footprint));
      const rise = b.topY - byId.get(b.meta.towerOf)!.topY;
      if ((area < 20 && rise > 30) || rise > 10.6 * Math.sqrt(area)) bad.push(`${b.id} ${area.toFixed(0)} m² +${rise.toFixed(0)} m`);
    }
    expect(bad).toEqual([]);
  });

  it("Sutro Tower is no solid block: its probe's records stay low until a landmark replaces them", () => {
    const report = readJson("public/tiles/sf/report.json") as { probes: Array<{ id: string; buildings: string[] }> };
    const ids = report.probes.find((p) => p.id === "sutro-tower")!.buildings;
    const byId = new Map(buildings.map((b) => [b.id, b]));
    const recs = ids.map((id) => byId.get(id)!);
    expect(recs).toHaveLength(6);
    // The LiDAR fills the lattice's upper structure (683 m² at a 210 m median); overrides
    // make those three footprints 3 m plinths. The rest are the equipment buildings.
    expect(recs.filter((b) => b.meta.heightSource === "override").map((b) => b.id)).toEqual(["201006.0009087", "201006.0062170", "201006.0168289"]);
    for (const b of recs) expect(b.topY - b.baseY, b.id).toBeLessThan(20);
  });

  it("the pipeline writes no x- keys: the schemas' experiment prefix is never in shipped data", () => {
    const xKeys = (o: object | null | undefined): string[] => Object.keys(o ?? {}).filter((k) => k.startsWith("x-"));
    const found = [
      ...xKeys(roads),
      ...roads.nodes.flatMap(xKeys),
      ...roads.edges.flatMap(xKeys),
      ...colliders.flatMap((c) => [...xKeys(c), ...xKeys(c.ground), ...c.buildings.flatMap(xKeys)]),
    ];
    expect(found).toEqual([]);
  });

  it("placeholder plinths carry no storeys, use or units: a facade must not draw the building they stand in for", () => {
    const file = readJson("pipeline/overrides.json") as { buildings: Array<{ id: string; placeholder?: boolean; heightM?: number }> };
    const ids = file.buildings.filter((o) => o.placeholder).map((o) => o.id);
    expect(ids).toEqual(["201006.0009087", "201006.0062170", "201006.0168289"]);
    const byId = new Map(buildings.map((b) => [b.id, b]));
    for (const id of ids) {
      const b = byId.get(id)!;
      expect(b.meta, id).toMatchObject({ heightSource: "override", heightM: 3, parcel: "2724003" });
      expect([b.meta.stories, b.meta.use, b.meta.units, b.meta.condo], id).toEqual([undefined, undefined, undefined, undefined]);
    }
    // The real-height override keeps its parcel's facts: 415 Mission St's 63 storeys.
    expect(byId.get("201006.0000548")!.meta).toMatchObject({ heightSource: "override", stories: 63, use: "Commercial Office" });
  });

  it("Mission Dolores keeps its bell tower: the one keepTower override against the spike check", () => {
    const file = readJson("pipeline/overrides.json") as { buildings: Array<{ id: string; keepTower?: boolean }> };
    expect(file.buildings.filter((o) => o.keepTower).map((o) => o.id)).toEqual(["201006.0001563"]);
    const byId = new Map(buildings.map((b) => [b.id, b]));
    const nave = byId.get("201006.0001563")!;
    const tower = byId.get("201006.0001563-tower")!;
    expect(nave.meta).toMatchObject({ heightSource: "lidar", parcel: "3566001", tower: tower.id });
    expect(nave.meta.heightM).toBeCloseTo(14.1, 1);
    expect(tower.meta.heightM).toBeCloseTo(39.0, 1);
    // A thin tower the 1 assessor storey contradicts: exactly what the spike check drops.
    expect(isLidarSpike(Math.abs(signedArea(tower.footprint)), nave.meta.heightM, tower.meta.heightM, 1)).toBe(true);
    // 1 storey cannot describe a 39 m tower, so meta leaves it out (plausibleStories).
    expect(nave.meta.stories).toBeUndefined();
    const report = readJson("public/tiles/sf/report.json") as {
      buildings: { spikeTowersKept: number; spikeTowersDropped: number; spikeTowersDroppedByUse: Record<string, number> };
      probes: Array<{ id: string; buildings: string[] }>;
    };
    expect(report.probes.find((p) => p.id === "mission-dolores")!.buildings).toEqual([nave.id, tower.id]);
    expect(report.buildings.spikeTowersKept).toBe(1);
    // Every spike drop is attributed to its parcel's use code ("none": no parcel joined).
    const byUse = report.buildings.spikeTowersDroppedByUse;
    expect(Object.values(byUse).reduce((a, b) => a + b, 0)).toBe(report.buildings.spikeTowersDropped);
  });

  it("the review's needle examples are single prisms near their median roof", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    for (const id of ["201006.0024724", "201006.0001118", "201006.0001964", "201006.0171380"]) {
      const b = byId.get(id)!;
      expect(b.meta.tower, id).toBeUndefined();
      expect(byId.has(`${id}-tower`), id).toBe(false);
      const [med, max] = b.meta.lidarM;
      expect(b.meta.heightM, id).toBeLessThan(med + Math.max(3, 0.1 * med) + 0.01);
      expect(b.meta.heightM, id).toBeLessThan(max);
    }
  });

  it("buildings do not float: baseY is within 1 m of the terrain under the centroid", () => {
    const bad: string[] = [];
    for (const b of buildings) {
      const [x, z] = interiorPoint(b.footprint);
      if (Math.abs(ground(x, z) - b.baseY) > 1) bad.push(b.id);
    }
    expect(bad).toEqual([]);
  });

  it("no gap on slopes: walls start (meta.footY) at or below the ground at every footprint vertex", () => {
    const bad: string[] = [];
    for (const b of buildings) {
      expect(b.meta.footY).toBeLessThanOrEqual(b.baseY);
      for (const [x, z] of b.footprint) {
        if (!insideWorld(x, z)) continue; // past the world's edge there is no ground at all
        if (b.meta.footY > ground(x, z) + 0.01) bad.push(b.id);
      }
    }
    expect(bad).toEqual([]);
  });

  it("two-tier records pair up: every -tower names its podium and sits on its roof", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    let n = 0;
    for (const b of buildings) {
      if (!b.meta.towerOf) continue;
      n++;
      const pod = byId.get(b.meta.towerOf)!;
      expect(pod.meta.tower).toBe(b.id);
      expect(b.meta.podiumTopY).toBe(pod.topY);
      expect(b.topY).toBeGreaterThan(pod.topY);
    }
    expect(n).toBeGreaterThan(2000);
  });

  it("most buildings carry assessor facts (year, use, storeys) in meta", () => {
    const podiums = buildings.filter((b) => !b.meta.towerOf);
    const withParcel = podiums.filter((b) => b.meta.parcel).length;
    expect(withParcel / podiums.length).toBeGreaterThan(0.9);
    expect(podiums.filter((b) => b.meta.year).length / podiums.length).toBeGreaterThan(0.85);
  });

  it("storeys in meta agree with the LiDAR height; condo towers do not read as one-storey houses", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    const bad: string[] = [];
    for (const b of buildings) {
      if (b.meta.towerOf || !b.meta.stories || b.meta.heightSource !== "lidar") continue;
      const h = b.meta.tower ? byId.get(b.meta.tower)!.meta.heightM : b.meta.heightM;
      if (b.meta.stories * 6 + 15 < h || b.meta.stories * 2.4 > h + 10) bad.push(`${b.id} ${b.meta.stories} storeys, ${h} m`);
    }
    expect(bad).toEqual([]);
    // A 94 m Russian Hill tower joined to one condo unit's parcel ("Single Family Residential", 1 storey).
    const ru = byId.get("201006.0002073")!;
    expect(ru.meta).toMatchObject({ condo: true, use: "Residential Condominium", units: 112 });
    expect(ru.meta.stories).toBeUndefined();
    // Near North Point and Van Ness: a unit parcel records the building's 20 storeys.
    expect(byId.get("201006.0003524")!.meta).toMatchObject({ condo: true, stories: 20 });
  });
});

describe("sf world: roads", () => {
  it("every edge references existing nodes and its polyline starts at a and ends at b", () => {
    const nodes = new Map(roads.nodes.map((n) => [n.id, n]));
    expect(nodes.size).toBe(roads.nodes.length);
    const ids = new Set<string>();
    for (const e of roads.edges) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      expect(a, `${e.id}.a=${e.a}`).toBeDefined();
      expect(b, `${e.id}.b=${e.b}`).toBeDefined();
      expect(e.points[0]).toEqual([a!.x, a!.z]);
      expect(e.points[e.points.length - 1]).toEqual([b!.x, b!.z]);
      expect(e.lanes).toBeGreaterThanOrEqual(1);
      expect(e.widthM).toBeGreaterThan(0);
    }
    expect(roads.edges.length).toBeGreaterThan(15000);
  });

  it("every node is used by an edge", () => {
    const used = new Set(roads.edges.flatMap((e) => [e.a, e.b]));
    for (const n of roads.nodes) expect(used.has(n.id), n.id).toBe(true);
  });

  it("The Embarcadero near the Ferry Building is a divided arterial: one-way carriageways both ways", () => {
    const emb = roads.edges.filter((e) => e.name === "The Embarcadero" && e.points.some(([x, z]) => Math.hypot(x, z) < 1000));
    expect(emb.length).toBeGreaterThan(10);
    expect(emb.every((e) => e.kind === "arterial" && e.oneway)).toBe(true);
    // Both directions of travel are present (north-westbound and south-eastbound).
    const bearings = emb.map((e) => {
      const [ax, az] = e.points[0]!;
      const [bx, bz] = e.points[e.points.length - 1]!;
      return Math.atan2(bx - ax, -(bz - az));
    });
    expect(bearings.some((b) => Math.cos(b) > 0.3)).toBe(true);
    expect(bearings.some((b) => Math.cos(b) < -0.3)).toBe(true);
  });

  it("numbered streets are named without DataSF's zero padding", () => {
    const names = new Set(roads.edges.map((e) => e.name));
    for (const n of names) expect(n, n).not.toMatch(/(^|\s)0\d/);
    for (const n of ["1st St", "2nd St", "3rd St"]) expect(names.has(n), n).toBe(true);
  });

  it("freeways are flagged grade-separated; the Bay Bridge and Golden Gate approaches are flagged as bridges", () => {
    for (const e of roads.edges) expect(e.gradeSeparated === true, e.id).toBe(e.kind === "freeway");
    expect(roads.edges.filter((e) => e.gradeSeparated).length).toBeGreaterThan(100);
    const bridges = roads.edges.filter((e) => e.bridge);
    const i80 = bridges.filter((e) => e.name.startsWith("I-80"));
    expect([...new Set(i80.map((e) => e.name))].sort()).toEqual(["I-80 Eastbound", "I-80 Westbound"]);
    // Citywide, the Bay Bridge's west span reaches Yerba Buena Island in both directions...
    const length = (e: (typeof roads.edges)[number]): number =>
      e.points.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - e.points[i]![0], p[1] - e.points[i]![1]), 0);
    expect(i80.filter((e) => length(e) > 2500).map((e) => e.name).sort()).toEqual(["I-80 Eastbound", "I-80 Westbound"]);
    // ...and the Golden Gate Bridge's approach leaves the toll plaza over the water.
    expect([...new Set(bridges.filter((e) => e.name.startsWith("Hwy 101")).map((e) => e.name))].sort()).toEqual(["Hwy 101 Northbound", "Hwy 101 Southbound"]);
    // Every bridge edge passes over the bay (sampled every 10 m): past the world's tiles or on water inside them.
    const overWater = (e: (typeof roads.edges)[number]): boolean =>
      e.points.slice(1).some(([bx, bz], i) => {
        const [ax, az] = e.points[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
        for (let k = 0; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n;
          const z = az + ((bz - az) * k) / n;
          if (!insideWorld(x, z) || ground(x, z) === 0) return true;
        }
        return false;
      });
    for (const e of bridges) expect(overWater(e), e.id).toBe(true);
  });

  it("kinds cover the classcode mapping", () => {
    const kinds = new Set(roads.edges.map((e) => e.kind));
    for (const k of ["freeway", "ramp", "arterial", "collector", "residential", "alley"]) expect(kinds.has(k), k).toBe(true);
  });
});

describe("sf world: spawn", () => {
  it("is on The Embarcadero near the Ferry Building, heading along the road", () => {
    const s = manifest.spawn;
    expect(Math.hypot(s.x, s.z)).toBeLessThan(150);
    let best = { d: Infinity, bearing: 0 };
    for (const e of roads.edges.filter((r) => r.name === "The Embarcadero")) {
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!;
        const [bx, bz] = e.points[i]!;
        const ex = bx - ax, ez = bz - az;
        const t = Math.max(0, Math.min(1, ((s.x - ax) * ex + (s.z - az) * ez) / (ex * ex + ez * ez)));
        const d = Math.hypot(ax + ex * t - s.x, az + ez * t - s.z);
        if (d < best.d) best = { d, bearing: Math.atan2(ex, -ez) };
      }
    }
    expect(best.d).toBeLessThan(0.5);
    const diff = Math.abs(((s.heading - best.bearing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(diff).toBeLessThan(0.01);
    for (const b of buildings) expect(pointInPolygon(s.x, s.z, b.footprint), b.id).toBe(false);
  });

  it("the sim can drive 4 s straight ahead from the spawn without hitting anything", () => {
    let st = createInitialState(world, 1, ["p1"], manifest.spawn);
    for (let i = 0; i < Math.round(4 / DT); i++) st = step(world, st, { p1: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
    const car = st.players.p1!.car;
    expect(car.hits).toBe(0);
    expect(Math.hypot(car.x - manifest.spawn.x, car.z - manifest.spawn.z)).toBeGreaterThan(20);
  });
});

describe("sf world: landmarks replace the right records", () => {
  it("every replacesBuildingIds id in content/landmarks.json is a record of this world, and each landmark replaces its probed records", () => {
    const doc = readJson<{ landmarks: Array<{ id: string; replacesBuildingIds?: string[] }> }>("content/landmarks.json");
    const report = readJson<{ probes: Array<{ id: string; buildings: string[] }> }>("public/tiles/sf/report.json");
    const ids = new Set(buildings.map((b) => b.id));
    let checked = 0;
    for (const l of doc.landmarks) {
      for (const id of l.replacesBuildingIds ?? []) expect(ids.has(id), `${l.id} replaces ${id}`).toBe(true);
      const probe = report.probes.find((p) => p.id === l.id);
      if (probe && l.replacesBuildingIds) {
        if (l.id === "palace-of-fine-arts") {
          // This point probe covers the rotunda. The authored model also replaces the
          // neighboring colonnade hulls; landmark-mask.test.ts keeps the separate hall.
          expect(l.replacesBuildingIds, l.id).toHaveLength(6);
          expect(l.replacesBuildingIds, l.id).toEqual(expect.arrayContaining(probe.buildings));
        } else expect([...l.replacesBuildingIds].sort(), l.id).toEqual(probe.buildings);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("sf world: storefronts", () => {
  it("are storefront NAICS only, on a ground-floor wall of an existing building, facing out", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    expect(storefronts.storefronts.length).toBeGreaterThan(10000);
    for (const s of storefronts.storefronts) {
      expect(isStorefrontNaics(s.naics), s.naics).toBe(true);
      expect(Object.keys(s).sort()).toEqual(["buildingId", "category", "heading", "id", "naics", "x", "y", "z"]);
      const b = byId.get(s.buildingId)!;
      expect(b, s.buildingId).toBeDefined();
      expect(b.meta.towerOf).toBeUndefined();
      expect(pointInPolygon(s.x, s.z, b.footprint)).toBe(false);
      // One metre further along the heading is still outside; one metre back is inside or on the wall.
      expect(pointInPolygon(s.x + Math.sin(s.heading), s.z - Math.cos(s.heading), b.footprint)).toBe(false);
      expect(pointInPolygon(s.x - Math.sin(s.heading) * 0.6, s.z + Math.cos(s.heading) * 0.6, b.footprint)).toBe(true);
    }
  });

  it("carry no business names or registry ids", () => {
    const doc = JSON.parse(readFileSync(join(DIR, "storefronts.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["attribution", "description", "storefronts", "version", "world"]);
    const text = JSON.stringify(doc.storefronts);
    expect(text).not.toMatch(/"(dba_name|ownership_name|uniqueid|certificate_number|ttxid|full_business_address)"/);
    // Ids are hashes, not registry numbers.
    for (const s of storefronts.storefronts) expect(s.id).toMatch(/^sf-[0-9a-f]{12}$/);
  });
});
