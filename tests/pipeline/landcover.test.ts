// Land cover (pipeline/lib/landcover.ts): grass polygons clipped to cells with their holes,
// OSM tag classes, multipolygon joining, and the committed sf output around Fort Mason and the
// Marina. Synthetic OSM data; no network, no OSM extract needed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { barrierKind, CELL_M, clipToCells, grassKind, osmLandcover, type GrassPiece } from "../../pipeline/lib/landcover.ts";
import { pointInRing, signedArea, type P2 } from "../../pipeline/lib/geom.ts";
import type { OsmData } from "../../pipeline/lib/osm-pbf.ts";
import { toLatLon } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";
import { barrierPieces, buildGrass, GRASS_LIFT_M } from "../../src/render/street-landcover.ts";

const ringOf = (flat: number[]): P2[] => {
  const out: P2[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
};

describe("grass clipped to cells", () => {
  it("cuts a 250 m square into cell pieces that keep its area, and carries holes", () => {
    const out: GrassPiece[] = [];
    const sq = (x0: number, z0: number, s: number): P2[] => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
    clipToCells("t", "lawn", sq(10, 10, 250), [sq(40, 40, 20)], out);
    const area = out.reduce((a, p) => a + Math.abs(signedArea(ringOf(p.rings[0]!))), 0);
    expect(area).toBeCloseTo(250 * 250, 0);
    expect(out.length).toBe(9);
    for (const p of out) {
      for (const [x, z] of ringOf(p.rings[0]!)) {
        const [cx, cz] = p.id.split("@")[1]!.split(",").map(Number);
        expect(x).toBeGreaterThanOrEqual(cx! * CELL_M - 1e-6);
        expect(z).toBeLessThanOrEqual((cz! + 1) * CELL_M + 1e-6);
      }
    }
    expect(out.find((p) => p.id === "t@0,0")!.rings).toHaveLength(2);
  });

  it("drapes grass over the ground, leaving the hole bare", () => {
    const out: GrassPiece[] = [];
    clipToCells("t", "lawn", [[0, 0], [30, 0], [30, 30], [0, 30]], [[[10, 10], [20, 10], [20, 20], [10, 20]]], out);
    const ground = (x: number, z: number): number => 0.1 * x + 0.05 * z;
    const m = buildGrass(out, ground);
    const p = m.positions;
    expect(p.length).toBeGreaterThan(0);
    for (let i = 0; i < p.length; i += 3) expect(p[i + 1]!).toBeCloseTo(ground(p[i]!, p[i + 2]!) + GRASS_LIFT_M, 4);
    // No triangle centroid inside the hole.
    const idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const cx = (p[idx[t]! * 3]! + p[idx[t + 1]! * 3]! + p[idx[t + 2]! * 3]!) / 3;
      const cz = (p[idx[t]! * 3 + 2]! + p[idx[t + 1]! * 3 + 2]! + p[idx[t + 2]! * 3 + 2]!) / 3;
      expect(cx > 10.01 && cx < 19.99 && cz > 10.01 && cz < 19.99).toBe(false);
    }
  });
});

describe("OpenStreetMap classes", () => {
  it("reads grass and barrier tags", () => {
    expect(grassKind({ landuse: "grass" })).toBe("lawn");
    expect(grassKind({ leisure: "pitch", surface: "artificial_turf" })).toBeNull();
    expect(grassKind({ leisure: "park" })).toBeNull();
    expect(barrierKind({ barrier: "fence" })).toBe("fence");
    expect(barrierKind({ barrier: "kerb" })).toBeNull();
  });

  it("joins multipolygon members into rings and keeps the inner as a hole", () => {
    const ll = (x: number, z: number): [number, number] => {
      const p = toLatLon(x, z);
      return [p.lon, p.lat];
    };
    const nodes = new Map<number, [number, number]>([
      [1, ll(0, 0)], [2, ll(40, 0)], [3, ll(40, 40)], [4, ll(0, 40)],
      [5, ll(10, 10)], [6, ll(20, 10)], [7, ll(20, 20)], [8, ll(10, 20)],
      [9, ll(60, 60)], [10, ll(70, 60)],
    ]);
    const osm: OsmData = {
      nodes,
      taggedNodes: [],
      ways: [
        { id: 11, tags: {}, refs: [1, 2, 3] },
        { id: 12, tags: {}, refs: [3, 4, 1] },
        { id: 13, tags: {}, refs: [5, 6, 7, 8, 5] },
        { id: 14, tags: { barrier: "fence", height: "2" }, refs: [9, 10] },
      ],
      relations: [{ id: 99, tags: { type: "multipolygon", landuse: "grass" }, members: [
        { type: "way", ref: 11, role: "outer" }, { type: "way", ref: 12, role: "outer" }, { type: "way", ref: 13, role: "inner" },
      ] }],
    };
    const r = osmLandcover(osm);
    expect(r.grass).toHaveLength(1);
    expect(r.grass[0]!.id).toBe("osm:r99:0@0,0");
    expect(r.grass[0]!.rings).toHaveLength(2);
    expect(Math.abs(signedArea(ringOf(r.grass[0]!.rings[0]!)))).toBeCloseTo(1600, -1);
    expect(r.barriers).toEqual([{ id: "osm:w14", kind: "fence", h: 2, pts: [60, 60, 70, 60] }]);
    expect(barrierPieces({ ...r.barriers[0]!, pts: [0, 0, 10, 0] }).length).toBe(3);
  });
});

describe("sf land cover around the Marina and Fort Mason", () => {
  const dir = join(ROOT, "public/tiles/sf");
  const osm = JSON.parse(readFileSync(join(dir, "street-osm.json"), "utf8")) as { license: string; grass: GrassPiece[]; barriers: Array<{ id: string; kind: string; pts: number[] }>; piers: unknown[] };
  const rpd = JSON.parse(readFileSync(join(dir, "street-landcover.json"), "utf8")) as { grass: GrassPiece[] };
  const covered = (pieces: GrassPiece[], x: number, z: number): boolean =>
    pieces.some((p) => pointInRing(x, z, ringOf(p.rings[0]!)) && !p.rings.slice(1).some((h) => pointInRing(x, z, ringOf(h))));

  it("grasses Fort Mason's Great Meadow (OpenStreetMap) and the Marina Green lawns (Rec and Park)", () => {
    // Great Meadow, Upper Fort Mason; Marina Green east lawn.
    expect(covered(osm.grass, -3264, -1067)).toBe(true);
    expect([...rpd.grass, ...osm.grass].some((p) => p.id.startsWith("rpd:"))).toBe(true);
    expect(covered(rpd.grass, -3950, -1240)).toBe(true);
    expect(osm.license).toMatch(/ODbL/);
  });

  it("has fences and walls at Fort Mason, and the Marina's piers", () => {
    const fm = osm.barriers.filter((b) => b.pts.some((v, i) => i % 2 === 0 && v > -3400 && v < -2900 && b.pts[i + 1]! > -1250 && b.pts[i + 1]! < -840));
    expect(fm.length).toBeGreaterThan(5);
    expect(osm.piers.length).toBeGreaterThan(100);
  });
});
