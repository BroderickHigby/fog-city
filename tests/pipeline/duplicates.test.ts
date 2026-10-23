// L-01 and W-41 (units): no record is generated twice (a part nested in its own footprint, a
// building outlined twice, a newer-parcel building over the footprints already on its lot), and a
// tall record's far hull stands over the points that place it (its centroids, even in a notch).
import { describe, expect, it } from "vitest";
import { toLatLon } from "../../src/geo/project.ts";
import { dropEnclosedDuplicates, type Building } from "../../pipeline/lib/buildings.ts";
import { farHulls, recordMarks } from "../../pipeline/lib/far.ts";
import { pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { newerBuildings } from "../../pipeline/lib/newer.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import type { RawParcel, RawParcelShape } from "../../pipeline/lib/sources.ts";

const rect = (x0: number, z0: number, x1: number, z1: number): P2[] => [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
const rec = (id: string, footprint: P2[], topY: number, meta: Partial<Building["meta"]> = {}): Building => ({
  id,
  tile: "t0_0",
  footprint,
  baseY: 0,
  topY,
  meta: { footY: 0, heightM: topY, heightSource: "lidar", lidarM: [topY, topY], ...meta },
});

describe("records inside a larger record and no taller are dropped (L-01)", () => {
  it("drops a nested part and a lower record inside another; keeps a taller roof structure, an override and a tower", () => {
    const main = rec("201006.1", rect(0, 0, 20, 20), 13);
    const nested = rec("201006.1-1", rect(2, 2, 5, 8), 13);
    const lower = rec("201006.2", rect(10, 10, 15, 15), 9);
    const roof = rec("201006.3", rect(4, 12, 7, 15), 16);
    const placed = rec("201006.4", rect(14, 2, 18, 6), 3, { heightSource: "override" });
    const tower = rec("201006.1-tower", rect(6, 6, 9, 9), 12, { towerOf: "201006.1" });
    const outside = rec("201006.5", rect(18, 18, 26, 26), 10);
    const { buildings, dropped } = dropEnclosedDuplicates([main, nested, lower, roof, placed, tower, outside]);
    expect(dropped).toEqual(["201006.1-1", "201006.2"]);
    expect(buildings.map((b) => b.id)).toEqual(["201006.1", "201006.3", "201006.4", "201006.1-tower", "201006.5"]);
  });
});

describe("a tall record's far hull stands over its marks (W-41)", () => {
  it("an L-shaped strip with its centroids in its own notch takes a hull over them", () => {
    // A 2 m wide strip bent round a corner: its vertex mean and area centroid lie in the notch.
    const strip: P2[] = [[0, 0], [0, 20], [20, 20], [20, 18], [2, 18], [2, 0]];
    const marks = recordMarks(strip);
    expect(marks.slice(1).some(([x, z]) => !pointInRing(x, z, strip))).toBe(true);
    const [h] = farHulls([rec("201006.10", strip, 60)]);
    for (const [x, z] of marks) expect(pointInRing(x, z, h!.ring)).toBe(true);
  });

  it("a wedge whose convex hull has fewer vertices than the cap (201006.0002073-s37) takes that hull", () => {
    const wedge: P2[] = [[-1914.26, -337.1], [-1908.93, -347.22], [-1911.87, -346.78], [-1912.7, -345.27], [-1912.2, -342.51], [-1915.07, -342.05]];
    const [h] = farHulls([rec("201006.12", wedge, 184)]);
    for (const [x, z] of recordMarks(wedge)) expect(pointInRing(x, z, h!.ring)).toBe(true);
  });

  it("... but not over a neighbour of another height standing there", () => {
    const strip: P2[] = [[0, 0], [0, 20], [20, 20], [20, 18], [2, 18], [2, 0]];
    const shed = rec("201006.11", rect(6, 6, 12, 12), 8);
    const hulls = farHulls([rec("201006.10", strip, 60), shed]);
    const tall = hulls.find((h) => h.top === 60)!;
    expect(pointInRing(9, 9, tall.ring)).toBe(false);
  });
});

describe("a newer-parcel building retires the footprints standing inside its lot (L-01)", () => {
  it("takes the lot, less nothing, and retires the two fragments it encloses", () => {
    const n = 21;
    const ground = new Ground([{ ix: 0, iz: 0, field: { x0: 0, z0: 0, cellSizeM: 10, nx: n, nz: n, heights: new Array(n * n).fill(5), water: new Array(n * n).fill(0) } }]);
    const lot = rect(100, 100, 150, 180);
    const ll = (p: P2): [number, number] => {
      const q = toLatLon(p[0], p[1]);
      return [q.lon, q.lat];
    };
    const shapes: RawParcelShape[] = [{ blklot: "9999001", active: true, shape: { type: "Polygon", coordinates: [[...lot, lot[0]!].map(ll)] } }];
    const pt = toLatLon(125, 170);
    const parcels: RawParcel[] = [
      { parcel_number: "9999001", block: "9999", year_property_built: "2023", number_of_stories: "4", number_of_units: "141", use_definition: "Miscellaneous/Mixed-Use", the_geom: { type: "Point", coordinates: [pt.lon, pt.lat] } },
    ];
    // Two small footprints in the lot's middle, away from its edges and from the parcel point.
    const a = rec("201006.20", rect(110, 110, 124, 128), 16);
    const b = rec("201006.21", rect(126, 110, 140, 128), 16);
    const out = newerBuildings([a, b], parcels, shapes, [], ground, new Set(["t0_0"]));
    expect(out.added.map((r) => r.id)).toEqual(["201006.9000001"]);
    const added = out.added[0]!;
    for (const r of [a, b]) for (const [x, z] of r.footprint) expect(pointInRing(x, z, added.footprint)).toBe(true);
    expect([...out.retired].sort()).toEqual(["201006.20", "201006.21"]);
    expect(out.stats.enclosedRetired).toEqual(["201006.20", "201006.21"]);
  });
});
