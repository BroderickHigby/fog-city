// Goldens on the committed San Francisco world (public/tiles/sf), produced by
// `node pipeline/build-world.ts --world sf`. No network: these read committed files only.
// The citywide goldens (terrain, routing, districts, sidewalks, layers) are in citywide.test.ts.

import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ORIGIN, TILE_SIZE_M, tileId, toLocal } from "../../src/geo/project.ts";
import { DT, buildWorld, createInitialState, groundHeight, pointInPolygon, step, type World } from "../../src/sim/index.ts";
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
      ["boundary", "districts", "fountains", "hydrants", "parking", "sidewalks", "signals", "streetCleaning", "transit"].sort(),
    );
    for (const file of Object.values(manifest.layers)) {
      const lv = v(file.replace(/\.json$/, ""));
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
    const extras = new Set(["manifest.json", "roads.json", "storefronts.json", "report.json", manifest.worldColliders, ...Object.values(manifest.layers), ...manifest.far.map((f) => f.glb)]);
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
    expect(buildings.length).toBeGreaterThan(180000);
  });

  it("golden: the tallest building in the M0 bbox is the 415 Mission St tower, ~326 m (within 10%)", () => {
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
    const h = tallest.topY - tallest.baseY;
    expect(Math.abs(h - 326) / 326).toBeLessThan(0.1);
  });

  it("golden without an override: the 600 Montgomery St pyramid's LiDAR height is ~260 m (within 10%)", () => {
    const p = toLocal(37.7952, -122.4028);
    const recs = buildings.filter((b) => pointInPolygon(p.x, p.z, b.footprint));
    expect(recs.every((b) => b.meta.heightSource === "lidar")).toBe(true);
    const top = Math.max(...recs.map((b) => b.topY - b.baseY));
    expect(Math.abs(top - 260) / 260).toBeLessThan(0.1);
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
    expect(n).toBeGreaterThan(10000);
  });

  it("most buildings carry assessor facts (year, use, storeys) in meta", () => {
    const podiums = buildings.filter((b) => !b.meta.towerOf);
    const withParcel = podiums.filter((b) => b.meta.parcel).length;
    expect(withParcel / podiums.length).toBeGreaterThan(0.9);
    expect(podiums.filter((b) => b.meta.year).length / podiums.length).toBeGreaterThan(0.85);
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

  it("the sim can drive 3 s straight ahead from the spawn without hitting anything", () => {
    let st = createInitialState(world, 1, ["p1"], manifest.spawn);
    for (let i = 0; i < Math.round(3 / DT); i++) st = step(world, st, { p1: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
    const car = st.players.p1!.car;
    expect(car.hits).toBe(0);
    expect(Math.hypot(car.x - manifest.spawn.x, car.z - manifest.spawn.z)).toBeGreaterThan(20);
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
