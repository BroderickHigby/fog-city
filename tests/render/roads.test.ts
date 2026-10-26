import { describe, expect, it } from "vitest";
import {
  assignEdgesToTiles,
  edgeMidpoint,
  nodeClearance,
  nodeDegrees,
  roadHalfWidth,
  sidewalkWidth,
  streetTreeSpots,
  streetlightSpots,
} from "../../src/render/roads.ts";
import { tileBounds } from "../../src/render/tile-select.ts";
import type { Manifest, RoadGraph } from "../../src/render/types.ts";
import { readJson } from "../helpers.ts";

describe("road widths", () => {
  it("uses widthM when given, else lanes (plus parking on city streets)", () => {
    expect(roadHalfWidth({ widthM: 12, lanes: 9, kind: "freeway" })).toBe(6);
    expect(roadHalfWidth({ lanes: 2, kind: "freeway" })).toBeCloseTo(3.3, 9);
    expect(roadHalfWidth({ lanes: 2, kind: "residential" })).toBeCloseTo(5.7, 9);
    expect(sidewalkWidth({ kind: "freeway" })).toBe(0);
    expect(sidewalkWidth({ kind: "residential" })).toBeGreaterThan(2);
  });
});

for (const world of ["dev", "dev-city"]) {
  describe(`road graph of ${world}`, () => {
    const m = readJson<Manifest>(`public/tiles/${world}/manifest.json`);
    const g = readJson<RoadGraph>(`public/tiles/${world}/${m.roads}`);
    const bounds = m.tiles.map((t) => tileBounds(t, m.tileSizeM ?? 500, readJson(`public/tiles/${world}/${t.collider}`)));

    it("gives every edge to exactly one tile", () => {
      const by = assignEdgesToTiles(g.edges, bounds);
      const all = [...by.values()].flat().map((e) => e.id).sort();
      expect(all).toEqual(g.edges.map((e) => e.id).sort());
    });

    it("prefers the tile that contains the edge midpoint", () => {
      const by = assignEdgesToTiles(g.edges, bounds);
      for (const [id, edges] of by) {
        const b = bounds.find((q) => q.id === id)!;
        for (const e of edges) {
          const [x, z] = edgeMidpoint(e);
          const inside = x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
          const anyInside = bounds.some((q) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ);
          if (anyInside) expect(inside).toBe(true);
        }
      }
    });

    it("places lamps and trees deterministically, clear of intersections", () => {
      const clr = nodeClearance(g);
      const lamps = streetlightSpots(g.edges, clr);
      expect(lamps.length).toBeGreaterThan(0);
      expect(streetlightSpots(g.edges, clr)).toEqual(lamps);
      const deg = nodeDegrees(g);
      const junctions = g.nodes.filter((n) => (deg.get(n.id) ?? 0) >= 3);
      let closest = Infinity;
      for (const l of lamps) for (const n of junctions) closest = Math.min(closest, Math.hypot(l.x - n.x, l.z - n.z));
      expect(closest).toBeGreaterThan(3);
      expect(streetTreeSpots(g.edges, clr)).toEqual(streetTreeSpots(g.edges, clr));
    });
  });
}
