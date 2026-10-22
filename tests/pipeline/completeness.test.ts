// World QA W-04: blocks and towers newer than the footprint layer (a 2016 snapshot measured by
// the 2010 LiDAR) are in the world: the newer-buildings pass (pipeline/lib/newer.ts) and the
// overrides that add the Transbay towers, Fifteen Fifty and Chase Center. Reads the committed
// world and a fixture of the 2025 roll's newer parcel points (pipeline/tools/world-qa-fixtures.ts).
import { describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import { distToRing, interiorPoint, pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { readJson } from "../helpers.ts";
import { loadSf, type SfBuilding } from "./util.ts";

const { colliders } = loadSf();
const all: SfBuilding[] = colliders.flatMap((c) => c.buildings);

/** Records on a 50 m grid by their outline's box. */
const grid = new Map<string, SfBuilding[]>();
for (const b of all) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of b.footprint) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) {
    for (let cz = Math.floor(z0 / 50); cz <= Math.floor(z1 / 50); cz++) (grid.get(`${cx},${cz}`) ?? grid.set(`${cx},${cz}`, []).get(`${cx},${cz}`)!).push(b);
  }
}
const near = (x: number, z: number, r: number): SfBuilding[] => {
  const out = new Set<SfBuilding>();
  for (let cx = Math.floor((x - r) / 50); cx <= Math.floor((x + r) / 50); cx++) {
    for (let cz = Math.floor((z - r) / 50); cz <= Math.floor((z + r) / 50); cz++) for (const b of grid.get(`${cx},${cz}`) ?? []) out.add(b);
  }
  return [...out].filter((b) => pointInRing(x, z, b.footprint as P2[]) || distToRing(x, z, b.footprint as P2[]) <= r);
};
const height = (b: SfBuilding): number => b.topY - b.baseY;

describe("buildings newer than the footprint layer (W-04)", () => {
  const { parcels } = readJson<{ parcels: Array<[string, number, number, number, number]> }>("tests/pipeline/fixtures/world-qa/parcels-newer.json");

  it("at most 10 post-2015 parcel points with storeys lack a record within 25 m, and no 100 m cell holds 3 or more", () => {
    // Points in the strip south of the county line are far scenery (W-42), never near records.
    const missing = parcels.filter(([, x, z]) => z < 9600 && near(x, z, 25).length === 0);
    const cells = new Map<string, number>();
    for (const [, x, z] of missing) cells.set(`${Math.floor(x / 100)},${Math.floor(z / 100)}`, (cells.get(`${Math.floor(x / 100)},${Math.floor(z / 100)}`) ?? 0) + 1);
    const crowded = [...cells].filter(([, n]) => n >= 3);
    expect(parcels.length).toBeGreaterThan(1000);
    expect(missing.length, JSON.stringify(missing.slice(0, 20))).toBeLessThanOrEqual(10);
    expect(crowded, JSON.stringify(crowded)).toEqual([]);
  });

  it("the Hunters Point Shipyard hilltop and Mission Rock have their blocks", () => {
    // Block 4591C (the Shipyard hilltop, built 2016-2023): records from its parcel polygons.
    const hps = all.filter((b) => b.meta.parcel?.startsWith("4591C") && b.meta.outline === "parcel");
    expect(hps.length).toBeGreaterThanOrEqual(10);
    // Mission Rock (block 8719, built 2023-24): the 2025 roll lists four buildings of 8 to 23
    // storeys; an 8-storey building is about 30 m, so 3 of them reach 40 m (the QA report's 4
    // counted that one too).
    const a = toLocal(37.7765, -122.3905), c = toLocal(37.774, -122.3875);
    const inBox = all.filter((b) => {
      const [x, z] = interiorPoint(b.footprint as P2[]);
      return x >= a.x && x <= c.x && z >= a.z && z <= c.z;
    });
    expect(inBox.filter((b) => height(b) >= 40).length).toBeGreaterThanOrEqual(3);
    const parcelsInBox = new Set(inBox.map((b) => b.meta.parcel).filter((p) => p?.startsWith("8719")));
    expect(parcelsInBox.size).toBeGreaterThanOrEqual(4);
  });

  it("published heights within 10%: the towers the LiDAR saw, and the ones added since", () => {
    const towers: Array<{ label: string; lat: number; lon: number; m: number; r?: number; id?: string }> = [
      { label: "415 Mission St", lat: 37.7897, lon: -122.3972, m: 326 },
      { label: "600 Montgomery St pyramid", lat: 37.7952, lon: -122.4028, m: 260 },
      { label: "555 California St", lat: 37.7921, lon: -122.4036, m: 237 },
      { label: "One Rincon Hill", lat: 37.78566, lon: -122.39229, m: 188, r: 20 },
      { label: "Park Tower (250 Howard St)", lat: 37.79043, lon: -122.39418, m: 184.5 },
      { label: "The Avery", lat: 37.78794, lon: -122.39446, m: 188, id: "201006.9900001-tower" },
      { label: "706 Mission St", lat: 37.785971, lon: -122.40322, m: 146 },
      { label: "Fifteen Fifty", lat: 37.7735, lon: -122.41847, m: 116, id: "201006.9900003-tower" },
      { label: "33 Tehama St", lat: 37.78724, lon: -122.39624, m: 120, id: "201006.9900002-tower" },
    ];
    const fails: string[] = [];
    for (const t of towers) {
      const { x, z } = toLocal(t.lat, t.lon);
      const cands = t.id ? all.filter((b) => b.id === t.id) : near(x, z, t.r ?? 10);
      const h = Math.max(0, ...cands.map(height));
      if (Math.abs(h - t.m) > 0.1 * t.m) fails.push(`${t.label}: ${h.toFixed(1)} m, published ${t.m} m`);
    }
    expect(fails).toEqual([]);
    // Fifteen Fifty is looked up by its override id: it is the 1500 Mission redevelopment's lots
    // (block 3506; the 2025 roll lists 3506012 to 3506015, built after its footprint layer, at
    // 37.774186,-122.418127), north-west of Mission St. The QA report's address point
    // (37.77355,-122.41767) lies across Mission St on block 3511, where the 2025 roll still lists
    // the 1906-1927 three-storey buildings (3511033, 3511044 ...) the records there show.
    const ff = all.find((b) => b.id === "201006.9900003-tower")!;
    expect(ff.meta.parcel).toBe("3506012");
    const lot = toLocal(37.774186, -122.418127);
    const [fx, fz] = interiorPoint(ff.footprint as P2[]);
    expect(Math.hypot(fx - lot.x, fz - lot.z)).toBeLessThan(60);
  });

  it("added records carry their provenance and pipeline-only ids, and stand clear of every DataSF record", () => {
    const added = all.filter((b) => b.meta.outline !== undefined);
    expect(added.length).toBeGreaterThan(100);
    const overlaps: string[] = [];
    for (const b of added) {
      expect(b.id, b.id).toMatch(b.meta.outline === "override" ? /^201006\.99\d{5}(-tower)?(-[sb]\d+)?$/ : /^201006\.9\d{6}(-tower)?(-[sb]\d+)?$/);
      // Its interior point is inside no DataSF record (the pass takes the lot less the footprints on it).
      const [x, z] = interiorPoint(b.footprint as P2[]);
      const under = near(x, z, 0).filter((o) => !o.id.startsWith("201006.9") && o.meta.towerOf === undefined && pointInRing(x, z, o.footprint as P2[]));
      if (under.length) overlaps.push(`${b.id} in ${under.map((o) => o.id).join(",")}`);
    }
    expect(overlaps.slice(0, 10)).toEqual([]);
    // Chase Center (an override's block on its lot, crossed by Bridgeview Way) stands: an added
    // record is current, so the clearance pass spans or cuts the streets through it, never drops it.
    expect(all.some((b) => b.id === "201006.9900004")).toBe(true);
    const rep = readJson<{ clearance: { staleDropped: string[] } }>("public/tiles/sf/report.json");
    expect(rep.clearance.staleDropped.filter((id) => /^201006\.9/.test(id))).toEqual([]);
  });
});
