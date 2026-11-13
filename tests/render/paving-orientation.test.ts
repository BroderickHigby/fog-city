// The street-direction map the pavement's joints follow (src/render/paving-orientation.ts).
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers.ts";
import { ORIENTATION_CELL_M, orientationGrid, type OrientationRoads } from "../../src/render/paving-orientation.ts";

const roads = readJson<OrientationRoads>("public/tiles/sf/roads.json");
const grid = orientationGrid(roads);
const at = (x: number, z: number): number => grid.data[Math.floor((z - grid.z0) / ORIENTATION_CELL_M) * grid.w + Math.floor((x - grid.x0) / ORIENTATION_CELL_M)]!;
/** Difference of two directions modulo 90 degrees. */
const off = (a: number, b: number): number => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); };

describe("paving orientation", () => {
  it("follows each street, not the compass", () => {
    // Lombard St runs a little north of west; Market St diagonally; the two differ by far more than a slab joint could hide.
    const lombard = at(-3600, -490), market = at(-42, 52);
    expect(off(lombard, 81)).toBeLessThanOrEqual(3);
    expect(off(market, 54)).toBeLessThanOrEqual(4);
    expect(off(lombard, market)).toBeGreaterThan(15);
  });

  it("gives every cell a direction, plazas and parks included, in whole degrees below 90", () => {
    expect(grid.w * grid.h).toBe(grid.data.length);
    let max = 0;
    for (const v of grid.data) max = Math.max(max, v);
    expect(max).toBeLessThan(90);
    // A cell far from any street (inside a large park) still has the nearest street's direction.
    expect(at(-7821, 3119)).toBeGreaterThanOrEqual(0);
  });

  it("is a nearest-street map: sidewalk cells along one street agree", () => {
    // Mid-block on Lombard's south sidewalk (10 m off the centreline from Fillmore at -3585,-505), away from cross streets.
    const along = [-3512, -3657, -3802, -3947].map((x) => at(x, -505 - (x + 3585) * 0.159 + 10));
    for (const a of along) expect(off(a, along[0]!)).toBeLessThanOrEqual(2);
  });
});
