// W-01, W-39, W-43: no building footprint walls a real street or a public path. Every
// centreline sample (1 m apart) of every drivable edge must be at least a car's half width
// (0.95 m) from any footprint that blocks it: one whose roof stands more than 0.5 m over the
// road and whose underside (underY, for a structure spanning the street) is below the road plus
// the sim's 4.5 m clearance. Paths and stairs get the same check at a walker's reach.
// Allow-list: freeways and ramps are the deck layer's (tests/pipeline/freeway-decks.test.ts);
// the stretches in a tunnel bore or underpass pass under the buildings over them
// (tests/pipeline/tunnels.test.ts).

import { describe, expect, it, vi } from "vitest";
import { distToSegment, pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import type { PackBuilding } from "../../pipeline/lib/world-colliders.ts";
import { toLatLon } from "../../src/geo/project.ts";
import { loadSfPack, type SfRoads } from "./util.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** A car's half width (the sim's car is 1.9 m wide). */
const CAR_HALF_M = 0.95;
/** A walker's reach from a path's centreline. */
const WALK_M = 0.75;
/** The sim passes a body under a structure whose underside is this far over its feet. */
const UNDER_M = 4.5;
/** A roof this low over the road is a kerb or a step, not a wall. */
const ROOF_M = 0.5;

type Edge = SfRoads["edges"][number];
const drivable = (e: Edge): boolean => !e.pedestrian && !e.stairs;
const deckLayer = (e: Edge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";

class Grid {
  private cells = new Map<number, number[]>();
  readonly list: readonly PackBuilding[];
  constructor(list: readonly PackBuilding[]) {
    this.list = list;
    list.forEach((b, i) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cx = Math.floor(x0 / 20); cx <= Math.floor(x1 / 20); cx++) {
        for (let cz = Math.floor(z0 / 20); cz <= Math.floor(z1 / 20); cz++) {
          const k = (cx + 4096) * 8192 + cz + 4096;
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
      }
    });
  }
  /** Buildings whose footprint is within r of (x, z) (r ≤ 20). */
  near(x: number, z: number, r: number): PackBuilding[] {
    const out = new Set<number>();
    for (let cx = Math.floor((x - r) / 20); cx <= Math.floor((x + r) / 20); cx++) {
      for (let cz = Math.floor((z - r) / 20); cz <= Math.floor((z + r) / 20); cz++) {
        for (const i of this.cells.get((cx + 4096) * 8192 + cz + 4096) ?? []) out.add(i);
      }
    }
    return [...out].map((i) => this.list[i]!).filter((b) => dist(x, z, b.footprint) <= r);
  }
}

function dist(x: number, z: number, ring: readonly P2[]): number {
  if (pointInRing(x, z, ring)) return 0;
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(x, z, ring[i]!, ring[(i + 1) % ring.length]!).d);
  return d;
}

function samples(points: ReadonlyArray<[number, number]>, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[points[0]![0], points[0]![1]]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

const ll = (x: number, z: number): string => {
  const p = toLatLon(x, z);
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
};

describe("sf world: carriageway and path clearance (W-01, W-39, W-43)", () => {
  const { pack, roads, buildings, heightAt } = loadSfPack();
  const grid = new Grid(buildings);
  // Tunnel bores (and underpasses) per edge, as 2-D segments: their samples are the tunnels test's.
  const bores = new Map<string, Array<[P2, P2]>>();
  for (const t of pack.tiles.flatMap((q) => q.tunnels ?? [])) {
    if (!t.edge) continue;
    const l = bores.get(t.edge) ?? bores.set(t.edge, []).get(t.edge)!;
    for (let i = 1; i < t.path.length; i++) l.push([[t.path[i - 1]![0], t.path[i - 1]![2]], [t.path[i]![0], t.path[i]![2]]]);
  }
  const inBore = (e: Edge, x: number, z: number): boolean => (bores.get(e.id) ?? []).some(([a, b]) => distToSegment(x, z, a, b).d < 0.5);
  const blocks = (b: PackBuilding, roadY: number): boolean => b.topY > roadY + ROOF_M && (b.underY === undefined || b.underY < roadY + UNDER_M);
  /** Per edge: the samples where a blocking footprint is within r, as "id at lat,lon". */
  const blockedOn = (e: Edge, r: number): string[] => {
    const out: string[] = [];
    for (const [x, z] of samples(e.points, 1)) {
      if (e.tunnel && inBore(e, x, z)) continue;
      const y = heightAt(x, z);
      for (const b of grid.near(x, z, r)) if (blocks(b, y)) out.push(`${b.id} at ${ll(x, z)}`);
    }
    return out;
  };
  const byId = new Map(roads.edges.map((e) => [e.id, e]));

  it("no drivable centreline sample is within a car's half width of a blocking footprint", () => {
    const bad: string[] = [];
    let n = 0;
    for (const e of roads.edges) {
      if (!drivable(e) || deckLayer(e)) continue;
      n++;
      const b = blockedOn(e, CAR_HALF_M);
      if (b.length) bad.push(`${e.id} ${e.name}: ${b.length} m, e.g. ${b[0]}`);
    }
    expect(n).toBeGreaterThan(14000);
    expect(bad).toEqual([]);
  });

  it("no path or stairway centreline sample is within a walker's reach of a blocking footprint", () => {
    const bad: string[] = [];
    let n = 0;
    for (const e of roads.edges) {
      if (drivable(e)) continue;
      n++;
      const b = blockedOn(e, WALK_M);
      if (b.length) bad.push(`${e.id} ${e.name}: ${b.length} m, e.g. ${b[0]}`);
    }
    expect(n).toBeGreaterThan(150);
    expect(bad).toEqual([]);
  });

  it("the report's walled streets are open: 1st, Howard, Kearny, Upper Market, Battery, Elk, Mason, Lundeen, Houston, Crescent, Winston, Walnut", () => {
    const ids = ["c105000", "c7038000", "c7759000", "c7752000", "c8776102", "c8776203", "c2757000", "c5152000", "c5153000", "c19523000", "c19524000", "c19781000", "c7026000", "c4495000", "c4496000", "c13686101", "c13686201", "c15354000"];
    for (const id of ids) {
      const e = byId.get(id);
      expect(e, id).toBeDefined();
      expect(drivable(e!), id).toBe(true);
      expect(blockedOn(e!, CAR_HALF_M), `${id} ${e!.name}`).toEqual([]);
    }
  });

  it("the report's blocked paths are open: Pemberton Pl, Vista Ln, Cottage Row, Hyde St steps, Moraga St steps", () => {
    for (const id of ["c10324000", "c10325000", "c13334000", "c4461000", "c7153000", "c7154000", "c9332000"]) {
      const e = byId.get(id);
      expect(e, id).toBeDefined();
      expect(blockedOn(e!, WALK_M), `${id} ${e!.name}`).toEqual([]);
    }
  });

  it("Lombard St (the Hyde approach and the crooked block): 1.5 m of clearance from the centreline on both edges", () => {
    for (const id of ["c8449000", "c8448000"]) {
      const e = byId.get(id)!;
      expect(e.name).toBe("Lombard St");
      expect(blockedOn(e, 1.5), id).toEqual([]);
    }
  });

  it("structures spanning a street are spans: an underside at least 4.5 m over the road, structure above it", () => {
    const spans = buildings.filter((b) => /-b\d+$/.test(b.id));
    expect(spans.length).toBeGreaterThan(20);
    for (const s of spans) {
      expect(s.underY, s.id).toBeDefined();
      expect(s.topY - s.underY!, s.id).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("1st St runs under the Transit Center: a span of 201006.0000060 over the street, its roof about 20 m up (W-01, W-16)", () => {
    const first = byId.get("c105000")!;
    let under = 0;
    for (const [x, z] of samples(first.points, 1)) {
      const y = heightAt(x, z);
      for (const b of grid.near(x, z, 0)) {
        if (!b.id.startsWith("201006.0000060")) continue;
        expect(b.underY, b.id).toBeGreaterThanOrEqual(y + UNDER_M);
        expect(b.topY - y).toBeGreaterThan(15);
        expect(b.topY - y).toBeLessThan(28);
        under++;
      }
    }
    expect(under).toBeGreaterThan(20);
  });
});
