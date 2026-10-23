// World QA W-42 (the report's acceptance test): every built tile with buildings has a drivable
// street, or is listed here as reached only on foot or by water; and no solid record stands on
// the streetless Daly City strip past the county line. The strip's records past the county-line
// wall are scenery (the tile glb's buildings-scenery node and the far layer); only those in the
// pocket round a San Francisco street that carries on past the line stay solid, and each of them
// reaches that street's pocket.
import { describe, expect, it } from "vitest";
import { COUNTY_POCKET_M, SOUTH_CROP_Z } from "../../pipeline/lib/build.ts";
import { inPolygon } from "../../pipeline/lib/districts.ts";
import { interiorPoint, type P2 } from "../../pipeline/lib/geom.ts";
import { readJson } from "../helpers.ts";
import { loadSf } from "./util.ts";

/**
 * San Francisco tiles whose buildings no drivable centreline reaches (pier ends, the Presidio's
 * shore, the Hunters Point shoreline): on foot or by water. A tile joins this list only with a
 * reason; the Daly City strip's tiles never do.
 */
const NO_STREET: Record<string, string> = {
  "t-3_-4": "Fisherman's Wharf: the seaward pier ends",
  "t-13_-3": "the Presidio's Crissy Field shore",
  "t0_-1": "the Embarcadero north of the Ferry Building: the seaward pier ends",
  "t2_4": "Mission Bay: the seaward pier ends",
  "t2_5": "Mission Bay: the seaward pier ends further south",
  "t6_14": "Hunters Point Shipyard: the shoreline",
  "t5_15": "Hunters Point Shipyard: the south yard",
  "t6_15": "Hunters Point Shipyard: the south yard's shore",
  "t3_16": "Candlestick Point: the shore",
  "t4_16": "Candlestick Point: the old stadium lot",
  "t5_16": "Candlestick Point: the shore",
  "t4_17": "Candlestick Point State Recreation Area",
  "t5_17": "Candlestick Point State Recreation Area",
};

describe("street network reach (W-42)", () => {
  const { manifest, colliders, roads } = loadSf();
  type Edge = { kind: string; pedestrian?: boolean; widthM: number; points: P2[] };
  const edges = roads.edges as unknown as Edge[];
  const drivable = edges.filter((e) => !e.pedestrian && e.kind !== "freeway" && e.kind !== "ramp");

  it("every built tile with buildings has a drivable street through it, or is listed as reached on foot", () => {
    const reached = new Set<string>();
    for (const e of drivable) {
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!, [bx, bz] = e.points[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5));
        for (let k = 0; k <= n; k++) reached.add(`t${Math.floor((ax + ((bx - ax) * k) / n) / 500)}_${Math.floor((az + ((bz - az) * k) / n) / 500)}`);
      }
    }
    const without = colliders.filter((c) => c.buildings.length > 0 && !reached.has(c.tileId)).map((c) => c.tileId).sort();
    expect(without).toEqual(Object.keys(NO_STREET).sort());
    // None of them is in the last built row (the Daly City strip's).
    for (const id of without) expect(Number(/_(-?\d+)$/.exec(id)![1]), id).toBeLessThan(19);
    expect(manifest.tiles.length).toBeGreaterThan(500);
  });

  it("no solid record stands on the streetless strip past the county line: each one there reaches a street's pocket", () => {
    const { districts } = readJson<{ districts: Array<{ polygons: P2[][][] }> }>("public/tiles/sf/districts.json");
    const inSf = (x: number, z: number): boolean => districts.some((d) => d.polygons.some((poly) => inPolygon(x, z, poly)));
    // Distance from a point to the nearest kerb (negative inside a ribbon), over every edge near the line.
    const south = edges.filter((e) => e.points.some(([, z]) => z > SOUTH_CROP_Z - 1000));
    const kerb = (x: number, z: number): number => {
      let best = Infinity;
      for (const e of south) {
        for (let i = 1; i < e.points.length; i++) {
          const [ax, az] = e.points[i - 1]!, [bx, bz] = e.points[i]!;
          const ex = bx - ax, ez = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
          best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t) - e.widthM / 2);
        }
      }
      return best;
    };
    // A strip record (interior point past the line; a tower goes with its podium) is solid only
    // if it reaches a 10 m lattice cell inside the wall: its interior point, a vertex or a point
    // every 5 m along a side in a cell whose centre is north of SOUTH_CROP_Z, in San Francisco,
    // or within COUNTY_POCKET_M of a kerb.
    const reaches = new Map<string, boolean>();
    const pastIds: Array<[string, string]> = [];
    for (const c of colliders) {
      for (const b of c.buildings) {
        const ring = b.footprint as P2[];
        // The strip: records whose interior point is past the line (as the pipeline classes them).
        const [ix, iz] = interiorPoint(ring);
        if (b.id.endsWith("-tower") || !(iz > SOUTH_CROP_Z && !inSf(ix, iz))) continue;
        pastIds.push([c.tileId, b.id]);
        const inWall = (x: number, z: number): boolean => {
          const cx = (Math.floor(x / 10) + 0.5) * 10, cz = (Math.floor(z / 10) + 0.5) * 10;
          return cz <= SOUTH_CROP_Z || inSf(cx, cz) || kerb(cx, cz) < COUNTY_POCKET_M;
        };
        let ok = inWall(ix, iz);
        for (let i = 0; i < ring.length && !ok; i++) {
          const [ax, az] = ring[i]!, [bx, bz] = ring[(i + 1) % ring.length]!;
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5));
          for (let k = 0; k <= n && !ok; k++) {
            if (inWall(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)) ok = true;
          }
        }
        reaches.set(b.id, ok);
      }
    }
    const past = pastIds.length;
    const stranded = pastIds.filter(([, id]) => !reaches.get(id)).map(([t, id]) => `${t} ${id}`);
    expect(stranded.slice(0, 10)).toEqual([]);
    // Before the county-line wall about 3,000 strip records were solid; now only the pockets' few hundred.
    expect(past).toBeLessThan(600);
    const report = readJson<{ farOnly: { records: number; drawnInTiles: number } }>("public/tiles/sf/report.json");
    expect(report.farOnly.drawnInTiles).toBeGreaterThan(2000);
  }, 120_000);
});
