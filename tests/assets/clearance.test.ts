// The road-clearance check itself (tests/assets/clearance.ts), on made-up geometry over flat
// ground: what it must find (a block on the road, a thin strut across it, a road wholly inside a
// solid, a beam too low) and what it must not (a beam above the clearance, a wall beside the road).

import { describe, expect, it } from "vitest";
import { toLatLon } from "../../src/geo/project.ts";
import { clearanceHits, triangleOverlapsBox, type RoadEdge } from "./clearance.ts";
import type { V3 } from "./glb.ts";

type Tri = [V3, V3, V3];
const FLAT = (): null => null; // no tiles: the sim's ground is 0 everywhere
const at = toLatLon(0, 0);
const PLACE = { lat: at.lat, lon: at.lon, headingDeg: 0 };
// a road running north (world -z) along x = 0, 8 m wide, from z = 50 to z = -50
const ROAD: RoadEdge = { id: "r1", name: "Test St", kind: "residential", widthM: 8, points: [[0, 50], [0, -50]] };

/** An axis-aligned box as 12 outward-facing triangles (model frame = world frame here). */
function cube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, bottom = false): Tri[] {
  const P: V3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 7, 6, 5], // top (+y)
    [0, 4, 5, 1], // -z
    [2, 6, 7, 3], // +z
    [0, 3, 7, 4], // -x
    [1, 5, 6, 2], // +x
  ];
  if (bottom) quads.push([0, 1, 2, 3]);
  return quads.flatMap(([a, b, c, d]) => [[P[a!]!, P[b!]!, P[c!]!], [P[a!]!, P[c!]!, P[d!]!]] as Tri[]);
}

const hits = (tris: Tri[]) => clearanceHits(FLAT, PLACE, tris, [ROAD]);

describe("road clearance check", () => {
  it("finds a block standing on the road", () => {
    expect(hits(cube(-2, -1, -3, 2, 6, 3)).length).toBeGreaterThan(4);
  });

  it("finds a road wholly inside a solid (no surface crosses the clearance)", () => {
    const h = hits(cube(-20, -2, -10, 20, 40, 10));
    expect(h.length).toBeGreaterThanOrEqual(19);
    // the boxes away from the block's ends meet no surface: found by the inside test alone
    expect(h.filter((x) => x.lowM === 0.3 && x.highM === 4.5).length).toBeGreaterThanOrEqual(17);
  });

  it("finds a thin strut across the road at 2 m, and a beam whose underside is at 4 m", () => {
    expect(hits(cube(-6, 1.9, -0.1, 6, 2.1, 0.1)).length).toBeGreaterThan(0);
    expect(hits(cube(-6, 4.0, -1, 6, 5.0, 1)).length).toBeGreaterThan(0);
  });

  it("leaves a beam 4.6 m up, a wall beside the road and a portal over it alone", () => {
    expect(hits(cube(-6, 4.6, -1, 6, 5.6, 1))).toEqual([]);
    expect(hits(cube(4.2, -1, -20, 6, 8, 20))).toEqual([]);
    const portal = [...cube(-12, -2, -10, -4.5, 20, 10), ...cube(4.5, -2, -10, 12, 20, 10), ...cube(-4.5, 5.0, -10, 4.5, 20, 10, true)];
    expect(hits(portal)).toEqual([]);
  });

  it("follows the placement: the same block turned off the road is clear", () => {
    const block = cube(10, -1, -3, 14, 6, 3);
    expect(hits(block)).toEqual([]);
    // heading 90: model +x points south (world +z), so the block lands on the road at z 10..14
    expect(clearanceHits(FLAT, { ...PLACE, headingDeg: 90 }, block, [ROAD]).length).toBeGreaterThan(2);
  });

  it("triangle-box overlap: separating axes", () => {
    const h: V3 = [1, 1, 1];
    expect(triangleOverlapsBox([-5, 0, -5], [5, 0, -5], [0, 0, 5], h)).toBe(true); // a floor through the box
    expect(triangleOverlapsBox([-5, 1.2, -5], [5, 1.2, -5], [0, 1.2, 5], h)).toBe(false); // above it
    expect(triangleOverlapsBox([1.5, -3, 0], [3, 3, 0], [3, -3, 0], h)).toBe(false); // beside a corner
    expect(triangleOverlapsBox([0.5, -1.5, 0], [3, 3, 0], [3, -3, 0], h)).toBe(true); // cuts the corner
  });
});
