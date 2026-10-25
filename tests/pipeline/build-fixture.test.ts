import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {rebuildGameplay} from "../../pipeline/build-gameplay.ts";
// The whole build, end to end, on a small synthetic world (two tiles, made-up records in
// the same shapes DataSF and 3DEP return). No network, no cache: proves determinism and the
// modelling rules independently of the committed sf data.

import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { toLatLon } from "../../src/geo/project.ts";
import { buildWorldFiles, type BuildOutput } from "../../pipeline/lib/build.ts";
import { checkOverrides, isLidarSpike, outlierRoof, plausibleTower, towerFraction, type Override } from "../../pipeline/lib/buildings.ts";
import { worldTiles, type WorldConfig } from "../../pipeline/lib/config.ts";
import { Elevation, Ground, tileHeightfield } from "../../pipeline/lib/terrain.ts";
import type { GeoRaster } from "../../pipeline/lib/geotiff.ts";
import { signedArea } from "../../pipeline/lib/geom.ts";
import { KIND_TABLE, kindOf, titleCase } from "../../pipeline/lib/roads.ts";
import type { RawBuilding, RawBusiness, RawInputs, RawParcel, RawStreet } from "../../pipeline/lib/sources.ts";
import { categoryOf, isStorefrontNaics } from "../../pipeline/lib/storefronts.ts";
import { readJson } from "../helpers.ts";
import { loadGlbWithThree, validateGlb, type SfBuilding, type SfCollider, type SfRoads, type SfStorefronts } from "./util.ts";

const ll = (x: number, z: number): [number, number] => {
  const p = toLatLon(x, z);
  return [p.lon, p.lat];
};
const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [ll(x0, z0), ll(x1, z0), ll(x1, z1), ll(x0, z1), ll(x0, z0)];
const pt = (x: number, z: number) => ({ type: "Point" as const, coordinates: ll(x, z) });

/** Ground: 2 m rising 3 % eastward to x = 800, a step down to the bay (water) from x = 850. */
function terrain(x: number): number {
  return x < 850 ? 2 + 0.03 * Math.min(x, 800) : -1;
}

function dem(): GeoRaster {
  const d = 0.00005;
  const [west, north] = ll(-200, -200);
  const [east, south] = ll(1200, 700);
  const width = Math.ceil((east - west) / d);
  const height = Math.ceil((north - south) / d);
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const lon = west + (c + 0.5) * d;
      data[r * width + c] = terrain((lon - -122.3937) * 88075.7734);
    }
  }
  return { width, height, data, west, north, dLon: d, dLat: d, noData: null };
}

const bldg = (id: string, rings: Array<Array<[number, number]>>, h: { med: number; max: number; mean: number; gnd: number; std?: number }, mblr?: string): RawBuilding => ({
  sf16_bldgid: id,
  mblr,
  hgt_mediancm: String(h.med * 100),
  hgt_maxcm: String(h.max * 100),
  hgt_meancm: String(h.mean * 100),
  ...(h.std === undefined ? {} : { hgt_stdcm: String(h.std * 100) }),
  gnd_mediancm: String(h.gnd * 100),
  shape: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
});

const street = (cnn: number, name: string, stType: string, classcode: string, oneway: string, pts: Array<[number, number]>, f: number | null, t: number | null, layer = "STREETS"): RawStreet => ({
  cnn: String(cnn),
  street: name,
  st_type: stType,
  streetname: `${name} ${stType}`,
  classcode,
  oneway,
  layer,
  f_node_cnn: f === null ? undefined : `${f}.0`,
  t_node_cnn: t === null ? undefined : `${t}.0`,
  line: { type: "LineString", coordinates: pts.map(([x, z]) => ll(x, z)) },
});

function fixture(): { cfg: WorldConfig; raw: RawInputs; overrides: Override[] } {
  const [west, north] = ll(20, 20);
  const [east, south] = ll(980, 480);
  const [slon, slat] = ll(300, 90);
  const [tlon, tlat] = ll(600, 90);
  const [plon, plat] = ll(110, 110);
  const cfg: WorldConfig = {
    id: "fixture",
    title: "Fixture",
    areas: [{ id: "only", milestone: "T", name: "Two tiles", north, west, south, east }],
    spawn: { street: "TEST ST", lat: slat, lon: slon, towardLat: tlat, towardLon: tlon },
    probes: { points: [{ id: "b1", label: "Building one", lat: plat, lon: plon }] },
    sources: { buildings: "-", streets: "-", assessor: "-", assessorRollYear: 2025, businesses: "-" },
  };
  const g = (x: number) => terrain(x);
  const buildings: RawBuilding[] = [
    bldg("201006.0000001", [rect(100, 100, 120, 120)], { med: 14, max: 15, mean: 14.2, gnd: g(110) }, "SF0001001"),
    bldg("201006.0000002", [rect(600, 200, 640, 240)], { med: 20, max: 120, mean: 35, gnd: g(620) }, "SF0001002"),
    bldg("201006.0000003", [rect(300, 300, 330, 330)], { med: 0.3, max: 50, mean: 2, gnd: g(315) }, "SF0001003"),
    bldg("201006.0000004", [rect(400, 100, 420, 130)], { med: 10, max: 11, mean: 10, gnd: g(410) }, "SF0001004"),
    bldg("201006.0000005", [rect(150, 300, 250, 320)], { med: 9, max: 10, mean: 9, gnd: g(200) }, "SF0009999"),
    bldg("201006.0000006", [rect(500, 400, 501, 401)], { med: 5, max: 5, mean: 5, gnd: g(500) }),
    bldg("201006.0000007", [rect(1100, 100, 1120, 120)], { med: 5, max: 5, mean: 5, gnd: g(1110) }),
    bldg("201006.0000008", [rect(700, 400, 720, 420)], { med: 1, max: 3, mean: 1, gnd: g(710) }),
    bldg("201006.0000009", [rect(200, 150, 220, 170), rect(230, 150, 240, 160)], { med: 6, max: 7, mean: 6, gnd: g(210) }),
    // A 3-storey house whose LiDAR max is one stray return 128 m above its roof.
    bldg("201006.0000010", [rect(40, 400, 70, 430)], { med: 12, max: 140, mean: 12.5, std: 6, gnd: g(55) }, "SF0001010"),
    // A condominium tower joined to one unit's parcel.
    bldg("201006.0000011", [rect(380, 380, 410, 410)], { med: 60, max: 62, mean: 60, std: 1, gnd: g(395) }, "SF0002001"),
    // A 90 m building whose parcel says 2 storeys.
    bldg("201006.0000012", [rect(600, 300, 630, 330)], { med: 88, max: 90, mean: 88, std: 1, gnd: g(615) }, "SF0001012"),
    // A 2-storey house under trees: 30 % of it reads 18 m above the roof (a plausible tower
    // to the moment model; the canopy check removes it).
    bldg("201006.0000013", [rect(150, 420, 180, 450)], { med: 7, max: 25, mean: 7 + 0.3 * 18, std: 18 * Math.sqrt(0.3 * 0.7), gnd: g(165) }, "SF0001013"),
    // A 3-storey office whose max is a 45 m² sliver 48 m above its roof (the spike check removes it).
    bldg("201006.0000014", [rect(750, 150, 780, 180)], { med: 12, max: 60, mean: 12 + 0.05 * 48, std: 48 * Math.sqrt(0.05 * 0.95), gnd: g(765) }, "SF0001014"),
    // A condominium tower (One Rincon Hill's shape): a 15 m podium, a quarter of it 150 m tall,
    // whose unit parcels all list 1-2 storeys. The units say nothing about the building, so
    // the canopy check (residential, at most 4 storeys) must not take the tower for trees.
    bldg("201006.0000015", [rect(440, 280, 480, 320)], { med: 15, max: 150, mean: 15 + 0.25 * 135, std: 135 * Math.sqrt(0.25 * 0.75), gnd: g(460) }, "SF0003001"),
  ];
  const parcel = (n: string, x: number, z: number, year: number, stories: number, use: string, useCode?: string): RawParcel => ({
    parcel_number: n, block: n.slice(0, 4), lot: n.slice(4), year_property_built: String(year),
    number_of_stories: `${stories}.0`, use_definition: use, use_code: useCode, the_geom: pt(x, z),
  });
  const parcels: RawParcel[] = [
    parcel("0001001", 110, 110, 1925, 4, "Commercial Retail"),
    parcel("0001003", 315, 315, 2018, 20, "Commercial Office"),
    parcel("0001004", 410, 115, 1980, 8, "Commercial Office"),
    parcel("0001005", 200, 310, 1910, 3, "Multi-Family Residential"),
    parcel("0001010", 55, 415, 1908, 3, "Multi-Family Residential", "MRES"),
    parcel("0001012", 615, 315, 1975, 2, "Commercial Office", "COMO"),
    parcel("0001013", 165, 435, 1925, 2, "Single Family Residential", "SRES"),
    parcel("0001014", 765, 165, 1931, 3, "Commercial Office", "COMO"),
    // Condo units: one point, the units' own storeys, and one row of data-entry noise.
    parcel("0002001", 395, 395, 1999, 1, "Single Family Residential", "SRES"),
    parcel("0002002", 395, 395, 1999, 2, "Single Family Residential", "SRES"),
    parcel("0002003", 395, 395, 1999, 18, "Single Family Residential", "SRES"),
    parcel("0002004", 395, 395, 1999, 591, "Single Family Residential", "SRES"),
    parcel("0003001", 460, 300, 2008, 1, "Single Family Residential", "SRES"),
    parcel("0003002", 460, 300, 2008, 2, "Single Family Residential", "SRES"),
    parcel("0003003", 460, 300, 2008, 1, "Single Family Residential", "SRES"),
    parcel("0003004", 460, 300, 2008, 2, "Single Family Residential", "SRES"),
  ];
  const streets: RawStreet[] = [
    street(1001, "TEST", "ST", "5", "B", [[20, 90], [500, 90], [980, 90]], 9001, 9002),
    street(1002, "ONE WAY", "ST", "3", "T", [[520, 20], [520, 480]], 9003, 9004),
    street(1003, "PAPER", "ST", "5", "B", [[50, 250], [450, 250]], 9010, 9011, "PAPER"),
    street(1004, "TEST", "AL", "5", "B", [[100, 200], [300, 200]], 9005, 9006),
    street(1005, "FREEWAY", "", "1", "F", [[700, 450], [990, 450]], 9007, 9008, "FREEWAYS"),
    street(1006, "RAMP", "", "6", "F", [[700, 450], [650, 470]], 9007, 9009, "FREEWAYS"),
    street(1007, "MIDDLE", "ST", "4", "B", [[300, 90], [300, 200]], null, 9006),
    street(1008, "WALK", "WAY", "0", "B", [[100, 200], [100, 280]], 9005, 9012, "STREETS_PEDESTRI"),
  ];
  const businesses: RawBusiness[] = [
    { uniqueid: "U-1", self_reported_naics_code: "722511", location: pt(110, 110) },
    { uniqueid: "U-2", self_reported_naics_code: "454110", location: pt(110, 112) },
    { uniqueid: "U-3", self_reported_naics_code: "541110", location: pt(112, 110) },
    { uniqueid: "U-4", self_reported_naics_code: "722511", location: pt(800, 300) },
    { uniqueid: "U-5", self_reported_naics_code: "812111", location: pt(111, 111) },
  ];
  const overrides: Override[] = [{ id: "201006.0000004", parcel: "0001004", label: "fixture", heightM: 100, source: "test" }];
  return { cfg, raw: { buildings, streets, parcels, businesses, dems: [{ areaId: "only", raster: dem() }] }, overrides };
}

const text = (o: BuildOutput, f: string): string => new TextDecoder().decode(o.files.get(f)!);
const json = <T>(o: BuildOutput, f: string): T => JSON.parse(text(o, f)) as T;

let out: BuildOutput;
let all: SfBuilding[];
const byId = (id: string): SfBuilding | undefined => all.find((b) => b.id === id);

beforeAll(async () => {
  const f = fixture();
  out = await buildWorldFiles(f.cfg, f.raw, f.overrides);
  all = ["t0_0", "t1_0"].flatMap((t) => json<SfCollider>(out, `${t}.collider.json`).buildings);
});

describe("fixture build: determinism and files", () => {
  it("the same inputs give byte-identical files", async () => {
    const f = fixture();
    const again = await buildWorldFiles(f.cfg, f.raw, f.overrides);
    expect([...again.files.keys()]).toEqual([...out.files.keys()]);
    for (const [k, v] of out.files) {
      const h = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
      expect(h(again.files.get(k)!), k).toBe(h(v));
    }
  });

  it("writes exactly the manifest, graph, storefronts, report, boundary, two tiles, the collider pack and one far-LOD cell", () => {
    expect([...out.files.keys()].sort()).toEqual(
      [
        "boundary.json",
        "f0_0.glb",
        "manifest.json",
        "report.json",
        "roads.json",
        "storefronts.json",
        "t0_0.collider.json",
        "t0_0.glb",
        "t1_0.collider.json",
        "t1_0.glb",
        "world.colliders.bin",
      ].sort(),
    );
  });

  it("outputs validate against the schemas", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
    const check = (schema: string, data: unknown) => {
      if (!compiled.has(schema)) compiled.set(schema, ajv.compile(readJson(`schemas/${schema}.schema.json`)));
      const v = compiled.get(schema)!;
      expect(v(data), ajv.errorsText(v.errors)).toBe(true);
    };
    check("tile-manifest", json(out, "manifest.json"));
    check("roads", json(out, "roads.json"));
    check("tile-collider", json(out, "t0_0.collider.json"));
    check("tile-collider", json(out, "t1_0.collider.json"));
    check("boundary", json(out, "boundary.json"));
  });
});

describe("fixture build: world edge and shore", () => {
  interface B { edges: Array<{ kind: string; closed: boolean; points: Array<[number, number]> }>; shore: Array<{ closed: boolean; points: Array<[number, number]> }> }
  it("outlines the two tiles (land on the slope, water over the bay) and draws the shore with land on its left", () => {
    const b = json<B>(out, "boundary.json");
    let perimeter = 0;
    for (const e of b.edges) {
      const pts = e.closed ? [...e.points, e.points[0]!] : e.points;
      for (let i = 1; i < pts.length; i++) perimeter += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    }
    expect(perimeter).toBeCloseTo(3000, 6);
    const kindAt = (x: number, z: number): string[] =>
      b.edges.filter((e) => e.points.some(([px, pz], i) => {
        const [qx, qz] = e.points[i + 1] ?? (e.closed ? e.points[0]! : [px, pz]);
        return Math.min(px, qx) <= x && x <= Math.max(px, qx) && Math.min(pz, qz) <= z && z <= Math.max(pz, qz);
      })).map((e) => e.kind);
    expect(kindAt(0, 250)).toEqual(["land"]); // the west side, up the slope
    expect(kindAt(1000, 250)).toEqual(["water"]); // the east side, in the bay
    expect(b.shore).toHaveLength(1);
    const s = b.shore[0]!;
    expect(s.closed).toBe(false);
    // Land (west) on the left of travel: the line runs north, from z = 500 to z = 0.
    expect(s.points[0]![1]).toBe(500);
    expect(s.points[s.points.length - 1]![1]).toBe(0);
    for (const [x] of s.points) {
      expect(x).toBeGreaterThan(520);
      expect(x).toBeLessThan(950);
    }
  });
});

describe("fixture build: terrain", () => {
  it("neighbouring heightfields share their border, water is clamped to 0 and marked", () => {
    const a = json<SfCollider>(out, "t0_0.collider.json").ground;
    const b = json<SfCollider>(out, "t1_0.collider.json").ground;
    for (let k = 0; k < 51; k++) expect(b.heights[k * 51]).toBe(a.heights[k * 51 + 50]);
    // x = 950 (bay) is water at 0; x = 520 is land at about 2 + 0.03 * 520.
    expect(b.water[10 * 51 + 45]).toBe(1);
    expect(b.heights[10 * 51 + 45]).toBe(0);
    expect(b.water[10 * 51 + 2]).toBe(0);
    expect(b.heights[10 * 51 + 2]).toBeCloseTo(2 + 0.03 * 520, 1);
  });
});

describe("terrain sampling", () => {
  it("a point on the far border of the outermost tile still has ground (no drop to 0 at the world's edge)", () => {
    const f = fixture();
    const elev = new Elevation(f.raw.dems.map((d) => d.raster));
    const tiles = worldTiles(f.cfg);
    const ground = new Ground(tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: tileHeightfield(t, elev) })));
    // x = 1000 is the east edge of t1_0 (no t2_0); z = 500 is the south edge of both tiles.
    expect(ground.heightAt(1000, 100)).toBe(0); // bay
    expect(ground.heightAt(700, 500)).toBeCloseTo(2 + 0.03 * 700, 1);
    expect(ground.meshHeightAt(700, 500)).toBeCloseTo(2 + 0.03 * 700, 1);
    expect(ground.heightAt(1000.01, 100)).toBeNull();
    // Bilinear (sim) and planar-triangle (mesh) heights agree on lattice points.
    expect(ground.meshHeightAt(300, 200)).toBeCloseTo(ground.heightAt(300, 200)!, 6);
  });
});

describe("fixture build: buildings", () => {
  it("a LiDAR prism takes the max height and joins its parcel by block/lot", () => {
    const b = byId("201006.0000001")!;
    expect(b.meta.heightSource).toBe("lidar");
    expect(b.meta.heightM).toBe(15);
    expect(b.topY - terrain(110)).toBeCloseTo(15, 1);
    expect(b.meta).toMatchObject({ parcel: "0001001", year: 1925, stories: 4, use: "Commercial Retail" });
  });

  it("a tower on a podium becomes a podium record and a slimmer -tower record", () => {
    const pod = byId("201006.0000002")!;
    const tower = byId("201006.0000002-tower")!;
    expect(pod.meta.tower).toBe(tower.id);
    expect(tower.meta.towerOf).toBe(pod.id);
    expect(pod.topY - terrain(620)).toBeCloseTo(20, 0);
    expect(tower.topY - terrain(620)).toBeCloseTo(120, 0);
    expect(tower.meta.podiumTopY).toBe(pod.topY);
    // (mean - median) / (max - median) = 0.15 of the footprint area.
    expect(Math.abs(signedArea(tower.footprint)) / Math.abs(signedArea(pod.footprint))).toBeCloseTo(0.15, 1);
  });

  it("a stray LiDAR max makes no tower: one prism at the median plus a rooftop allowance", () => {
    const b = byId("201006.0000010")!;
    expect(byId("201006.0000010-tower")).toBeUndefined();
    expect(b.meta.tower).toBeUndefined();
    expect(b.meta.heightM).toBe(12 + 3);
    expect(b.meta.lidarM).toEqual([12, 140]);
    expect(b.meta).toMatchObject({ stories: 3, use: "Multi-Family Residential" });
  });

  it("tree canopy over a low house makes no tower, even when the moment model would accept one", () => {
    const b = byId("201006.0000013")!;
    expect(towerFraction(7, 25, 7 + 0.3 * 18, 18 * Math.sqrt(0.3 * 0.7))).toBeCloseTo(0.3, 3);
    expect(byId("201006.0000013-tower")).toBeUndefined();
    expect(b.meta.tower).toBeUndefined();
    expect(b.meta.heightM).toBe(outlierRoof(7, 25));
    expect(b.meta.heightM).toBe(10);
    expect(b.meta).toMatchObject({ stories: 2, use: "Single Family Residential" });
  });

  it("a thin tower the assessor's storeys contradict is a LiDAR spike: one prism, like any outlier", () => {
    const b = byId("201006.0000014")!;
    expect(plausibleTower(900, towerFraction(12, 60, 12 + 0.05 * 48, 48 * Math.sqrt(0.05 * 0.95)), 48)).toBe(true);
    expect(isLidarSpike(45, 12, 60, 3)).toBe(true);
    expect(byId("201006.0000014-tower")).toBeUndefined();
    expect(b.meta.tower).toBeUndefined();
    expect(b.meta.heightM).toBe(15);
    expect(b.meta).toMatchObject({ stories: 3, use: "Commercial Office" });
  });

  it("a condominium joined to one unit's parcel reports the building, not the unit", () => {
    const b = byId("201006.0000011")!;
    expect(b.meta).toMatchObject({ parcel: "0002001", condo: true, use: "Residential Condominium", stories: 18, units: 4 });
    expect(b.meta.heightM).toBe(62);
  });

  it("a condominium whose units list 1-2 storeys keeps its tall tower: the canopy check skips condos", () => {
    const pod = byId("201006.0000015")!;
    const tower = byId("201006.0000015-tower")!;
    expect(plausibleTower(1600, towerFraction(15, 150, 15 + 0.25 * 135, 135 * Math.sqrt(0.25 * 0.75)), 135)).toBe(true);
    expect(pod.meta).toMatchObject({ parcel: "0003001", condo: true, units: 4, use: "Residential Condominium", tower: tower.id });
    // 2 storeys (the most any unit lists) cannot describe 150 m: left out of meta.
    expect(pod.meta.stories).toBeUndefined();
    expect(pod.topY - terrain(460)).toBeCloseTo(15, 0);
    expect(tower.topY - terrain(460)).toBeCloseTo(150, 0);
    expect(tower.meta.heightM).toBe(150);
    expect(Math.abs(signedArea(tower.footprint)) / Math.abs(signedArea(pod.footprint))).toBeCloseTo(0.25, 1);
  });

  it("assessor storeys that contradict the LiDAR height are left out of meta", () => {
    const b = byId("201006.0000012")!;
    expect(b.meta.heightM).toBe(90);
    expect(b.meta.parcel).toBe("0001012");
    expect(b.meta.stories).toBeUndefined();
  });

  it("a building newer than the 2010 LiDAR takes its height from the assessor's storeys", () => {
    const b = byId("201006.0000003")!;
    expect(b.meta.heightSource).toBe("assessor-stories");
    expect(b.meta.heightM).toBe(20 * 4 + 1.5);
  });

  it("an override wins and is applied exactly", () => {
    const b = byId("201006.0000004")!;
    expect(b.meta.heightSource).toBe("override");
    expect(b.topY - terrain(410)).toBeCloseTo(100, 1);
    expect(out.report.overridesApplied).toEqual(["201006.0000004"]);
  });

  it("on a slope: baseY is the ground at the centroid, footY the lowest ground under the footprint", () => {
    const b = byId("201006.0000005")!;
    expect(b.baseY).toBeCloseTo(terrain(200), 1);
    expect(b.meta.footY).toBeLessThanOrEqual(terrain(150) - 0.04);
    expect(b.meta.footY).toBeGreaterThan(terrain(150) - 0.2);
    // No block/lot match, so the parcel point inside the footprint joins it.
    expect(b.meta.parcel).toBe("0001005");
  });

  it("drops tiny footprints, footprints outside the world and ones the LiDAR barely saw", () => {
    expect(byId("201006.0000006")).toBeUndefined();
    expect(byId("201006.0000007")).toBeUndefined();
    expect(byId("201006.0000008")).toBeUndefined();
    expect(out.report.buildings).toMatchObject({
      droppedSmall: 1, droppedOutside: 1, droppedLow: 1, heightOverride: 1, twoTier: 2, maxOutlier: 1, condo: 2, storiesImplausible: 2,
      canopyTowersDropped: 1, spikeTowersDropped: 1, thinTowers: 0, spikeTowersKept: 0,
    });
    // Spike drops by the parcel's assessor use_code: the roll has no religious or civic code.
    expect(out.report.buildings.spikeTowersDroppedByUse).toEqual({ COMO: 1 });
  });

  it("splits a multipart footprint into one record per part, largest first", () => {
    expect(byId("201006.0000009")).toBeDefined();
    expect(byId("201006.0000009-1")).toBeDefined();
    expect(Math.abs(signedArea(byId("201006.0000009")!.footprint))).toBeGreaterThan(Math.abs(signedArea(byId("201006.0000009-1")!.footprint)));
  });

  it("reports the building under each probe point", () => {
    expect(out.report.probes).toEqual([expect.objectContaining({ id: "b1", buildings: ["201006.0000001"] })]);
  });
});

describe("fixture build: placeholder and keepTower overrides", () => {
  let alt: BuildOutput;
  let recs: SfBuilding[];
  const rec = (id: string): SfBuilding | undefined => recs.find((b) => b.id === id);
  const placeholder: Override = { id: "201006.0000001", parcel: "0001001", label: "plinth", heightM: 3, placeholder: true, source: "test" };
  const keep: Override = { id: "201006.0000014", parcel: "0001014", label: "steeple", keepTower: true, source: "test" };
  beforeAll(async () => {
    const f = fixture();
    alt = await buildWorldFiles(f.cfg, f.raw, [...f.overrides, placeholder, keep]);
    recs = ["t0_0", "t1_0"].flatMap((t) => json<SfCollider>(alt, `${t}.collider.json`).buildings);
  });

  it("a placeholder plinth keeps its parcel and year but no storeys, use or units: they describe a building not drawn", () => {
    const b = rec("201006.0000001")!;
    expect(b.meta).toMatchObject({ heightSource: "override", heightM: 3, parcel: "0001001", year: 1925 });
    expect(b.meta.stories).toBeUndefined();
    expect(b.meta.use).toBeUndefined();
    expect(b.meta.units).toBeUndefined();
    expect(b.topY - b.baseY).toBeCloseTo(3, 0);
    // Without the placeholder flag the same parcel reports its storeys and use.
    expect(byId("201006.0000001")!.meta).toMatchObject({ stories: 4, use: "Commercial Retail" });
  });

  it("keepTower keeps the tower the spike check would drop, and counts it", () => {
    const pod = rec("201006.0000014")!;
    const tower = rec("201006.0000014-tower")!;
    expect(pod.meta).toMatchObject({ heightSource: "lidar", heightM: 12, tower: tower.id });
    // The 3 storeys cannot describe a 60 m tower, so meta leaves them out (plausibleStories).
    expect(pod.meta.stories).toBeUndefined();
    expect(tower.meta).toMatchObject({ heightSource: "lidar", heightM: 60, towerOf: pod.id });
    expect(alt.report.buildings).toMatchObject({ spikeTowersDropped: 0, spikeTowersKept: 1, spikeTowersDroppedByUse: {} });
    expect(alt.report.overridesApplied).toEqual(["201006.0000001", "201006.0000004", "201006.0000014"]);
  });

  it("keepTower on a building that ends without a tower fails the build loudly", async () => {
    const f = fixture();
    const bad: Override = { id: "201006.0000001", parcel: "0001001", label: "flat roof", keepTower: true, source: "test" };
    await expect(buildWorldFiles(f.cfg, f.raw, [...f.overrides, bad])).rejects.toThrow(/keepTower, but the building has no tower/);
  });

  it("every override sets exactly one of heightM and keepTower, placeholder only with a height, each id once", () => {
    const o = { id: "x", label: "x", source: "x" };
    expect(() => checkOverrides([{ ...o, heightM: 10 }, { ...o, id: "y", keepTower: true }, { ...o, id: "z", heightM: 3, placeholder: true }])).not.toThrow();
    expect(() => checkOverrides([{ ...o }])).toThrow(/exactly one/);
    expect(() => checkOverrides([{ ...o, heightM: 10, keepTower: true }])).toThrow(/exactly one/);
    expect(() => checkOverrides([{ ...o, standing: true }])).not.toThrow();
    expect(() => checkOverrides([{ ...o, heightM: 10, standing: true }])).toThrow(/exactly one/);
    expect(() => checkOverrides([{ ...o, keepTower: true, standing: true }])).toThrow(/exactly one/);
    expect(() => checkOverrides([{ ...o, keepTower: true, placeholder: true }])).toThrow(/placeholder needs heightM/);
    expect(() => checkOverrides([{ ...o, heightM: 10 }, { ...o, heightM: 20 }])).toThrow(/listed twice/);
    expect(() => checkOverrides([{ ...o, heightM: 0, keepTower: true }])).toThrow(/positive number/);
    expect(() => checkOverrides([{ ...o, heightM: Number.NaN }])).toThrow(/positive number/);
  });

  it("pipeline/overrides.json passes the same check", () => {
    const file = readJson("pipeline/overrides.json") as { buildings: Override[] };
    expect(() => checkOverrides(file.buildings)).not.toThrow();
  });
});

describe("fixture build: roads", () => {
  let roads: SfRoads;
  beforeAll(() => {
    roads = json<SfRoads>(out, "roads.json");
  });
  const edge = (cnn: string) => roads.edges.find((e) => e.cnn === cnn);

  it("orients one-way 'T' segments so traffic flows a -> b, and drops paper streets", () => {
    const e = edge("1002")!;
    expect(e.oneway).toBe(true);
    expect([e.a, e.b]).toEqual(["n9004", "n9003"]);
    expect(e.points[0]![1]).toBeGreaterThan(e.points[e.points.length - 1]![1]);
    expect(edge("1003")).toBeUndefined();
  });

  it("maps classcodes to kinds, lanes and widths", () => {
    expect(edge("1001")).toMatchObject({ kind: "residential", lanes: 2, oneway: false, name: "Test St" });
    expect(edge("1002")).toMatchObject({ kind: "arterial", lanes: 3 });
    expect(edge("1004")).toMatchObject({ kind: "alley", lanes: 1 });
    expect(edge("1005")).toMatchObject({ kind: "freeway", oneway: true });
    expect(edge("1006")).toMatchObject({ kind: "ramp" });
    expect(edge("1007")).toMatchObject({ kind: "collector" });
    expect(edge("1008")).toMatchObject({ kind: "other", pedestrian: true });
    expect(edge("1001")!.gradeSeparated).toBeUndefined();
    const r = edge("1001")!;
    expect(r.widthM).toBeCloseTo(2 * KIND_TABLE.residential.laneM + KIND_TABLE.residential.extraM, 5);
  });

  it("flags freeways as grade-separated and edges that run over open water as bridges", () => {
    // The freeway (x 700 -> 990) and Test St (x 20 -> 980) both run past the shore at x = 850.
    expect(edge("1005")).toMatchObject({ kind: "freeway", gradeSeparated: true, bridge: true });
    expect(edge("1001")).toMatchObject({ bridge: true });
    for (const cnn of ["1002", "1004", "1006", "1007", "1008"]) {
      expect(edge(cnn)!.bridge, cnn).toBeUndefined();
      expect(edge(cnn)!.gradeSeparated, cnn).toBeUndefined();
    }
    expect(out.report.roads.bridges).toBe(2);
  });

  it("synthesises a node for a segment end with no CNN, and every edge meets its nodes", () => {
    expect(edge("1007")!.a).toMatch(/^p300_90$/);
    const nodes = new Map(roads.nodes.map((n) => [n.id, n]));
    for (const e of roads.edges) {
      expect(e.points[0]).toEqual([nodes.get(e.a)!.x, nodes.get(e.a)!.z]);
      expect(e.points[e.points.length - 1]).toEqual([nodes.get(e.b)!.x, nodes.get(e.b)!.z]);
    }
  });

  it("puts the spawn on the configured street, heading toward the configured point", () => {
    const m = json<{ spawn: { x: number; z: number; heading: number } }>(out, "manifest.json");
    expect(m.spawn.x).toBeCloseTo(300, 1);
    expect(m.spawn.z).toBeCloseTo(90, 1);
    expect(m.spawn.heading).toBeCloseTo(Math.PI / 2, 3);
  });
});

describe("fixture build: storefronts", () => {
  it("keeps only storefront NAICS inside a building, on its street-facing wall, with no names or ids", () => {
    const s = json<SfStorefronts>(out, "storefronts.json").storefronts;
    expect(s.map((x) => x.naics).sort()).toEqual(["722511", "812111"]);
    for (const x of s) {
      expect(x.buildingId).toBe("201006.0000001");
      expect(x.z).toBeCloseTo(99.7, 1); // the north wall (z = 100), 0.3 m out
      expect(Math.cos(x.heading)).toBeCloseTo(1, 3); // facing north, toward Test St
      expect(x.id).toMatch(/^sf-[0-9a-f]{12}$/);
    }
    expect(Math.abs(s[0]!.x - s[1]!.x)).toBeGreaterThanOrEqual(4.9);
    expect(text(out, "storefronts.json")).not.toMatch(/U-[0-9]/);
    expect(out.report.storefronts).toMatchObject({ raw: 5, notStorefrontNaics: 2, noBuilding: 1, kept: 2 });
  });

  it("NAICS filter and categories", () => {
    for (const c of ["722511", "722410", "445110", "448120", "812111", "812320", "4451", "459310"]) expect(isStorefrontNaics(c), c).toBe(true);
    for (const c of ["454110", "722310", "541110", "531120", "44-45", "", undefined]) expect(isStorefrontNaics(c), String(c)).toBe(false);
    expect(categoryOf("722515")).toBe("cafe");
    expect(categoryOf("812111")).toBe("barber");
  });
});

describe("fixture build: GLB tiles", () => {
  it("validate with the Khronos glTF validator (no errors, no warnings)", async () => {
    for (const t of ["t0_0.glb", "t1_0.glb"]) {
      const r = await validateGlb(out.files.get(t)!);
      expect(r.messages, t).toEqual([]);
      expect(r.errors + r.warnings).toBe(0);
    }
  });

  it("load in three.js with the documented nodes, and building ranges in collider order", async () => {
    const scene = await loadGlbWithThree(out.files.get("t1_0.glb")!);
    const names = scene.children.map((c) => c.name);
    // structures (deck sides and columns, glb.ts) only where a tile has an elevated deck.
    expect(names.filter((n) => n !== "structures")).toEqual(["ground", "roads", "freeways", "buildings"]);
    const collider = json<SfCollider>(out, "t1_0.collider.json");
    const ranges = scene.getObjectByName("buildings")!.userData.buildings as Array<[string, number, number]>;
    expect(ranges.map((r) => r[0])).toEqual(collider.buildings.map((b) => b.id));
    // The freeway over the bay (x > 850) is not drawn. Positions are quantised: read them
    // through the node's dequantising transform.
    scene.updateMatrixWorld(true);
    const fw = scene.getObjectByName("freeways") as unknown as Mesh<BufferGeometry>;
    const pos = fw.geometry.attributes.position as BufferAttribute;
    const v = new Vector3();
    let maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) maxX = Math.max(maxX, v.fromBufferAttribute(pos, i).applyMatrix4(fw.matrixWorld).x);
    expect(maxX).toBeLessThan(870);
    expect(maxX).toBeGreaterThan(690);
  });
});

describe("road helpers", () => {
  it("kindOf and titleCase", () => {
    expect(kindOf(1, "", "FREEWAYS")).toBe("freeway");
    expect(kindOf(2, "ST", "STREETS")).toBe("arterial");
    expect(kindOf(5, "AL", "STREETS")).toBe("alley");
    expect(kindOf(0, "ST", "PRIVATE")).toBe("other");
    expect(kindOf(null, "ST", "STREETS")).toBe("other");
    expect(titleCase("THE EMBARCADERO")).toBe("The Embarcadero");
    // DataSF zero-pads numbered streets ("03RD ST"); the padding is dropped, other zeros kept.
    expect(titleCase("03RD ST")).toBe("3rd St");
    expect(titleCase("01ST ST")).toBe("1st St");
    expect(titleCase("10TH ST")).toBe("10th St");
    expect(titleCase("UNNAMED 042")).toBe("Unnamed 42");
  });
});

describe("fixture build: gameplay publication", () => {
  it("emits the shared gameplay layer from full-build inputs as well as standalone indexing", async () => {
    const f = fixture();
    f.raw.extras = { neighborhoods: [], fountains: [], muniStops: [], muniRoutes: [], signals: [], crosswalks: [], sweeping: [], parking: [] };
    const built = await buildWorldFiles(f.cfg, f.raw, f.overrides);
    const data = json<Record<string, unknown>>(built, "gameplay.json");
    const validate = new Ajv2020({ allErrors: true }).compile(readJson("schemas/tile-gameplay.schema.json"));
    expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    expect(json<{ layers: Record<string, string> }>(built, "manifest.json").layers.gameplay).toBe("gameplay.json");
    expect(data.tiles).toHaveLength(2);
    expect(data.territories).toEqual([]);
    const dir=mkdtempSync(join(tmpdir(),'fog-gameplay-roundtrip-'));
    try {
      for(const [name,bytes] of built.files){mkdirSync(dirname(join(dir,name)),{recursive:true});writeFileSync(join(dir,name),bytes);}
      expect(()=>rebuildGameplay(dir,f.cfg.sources.snapshotDate??'unversioned',true)).not.toThrow();
      rebuildGameplay(dir,f.cfg.sources.snapshotDate??'unversioned');
      for(const name of ['gameplay.json','manifest.json','report.json'])expect(readFileSync(join(dir,name))).toEqual(Buffer.from(built.files.get(name)!));
    } finally {rmSync(dir,{recursive:true,force:true});}

  });
});
