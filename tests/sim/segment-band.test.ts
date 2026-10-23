import { describe, expect, it } from "vitest";
import { buildWorld, segmentBlocked, segmentBlockedBand, type BuildingCollider } from "../../src/sim/index.ts";

function worldWith(building: BuildingCollider) {
  return buildWorld([{ tileId: "t0_0", ground: null, buildings: [building] }]);
}

describe("height-aware building segment queries", () => {
  const span: BuildingCollider = { id: "span", footprint: [[4, -2], [6, -2], [6, 2], [4, 2]], baseY: 0, underY: 5, topY: 20 };

  it("allows a body under a span while rejecting the same sweep inside its solid height band", () => {
    const world = worldWith(span);
    expect(segmentBlockedBand(world, 0, 0, 10, 0, .5, 2)).toBe(false);
    expect(segmentBlockedBand(world, 0, 0, 10, 0, .5, 5)).toBe(false);
    expect(segmentBlockedBand(world, 0, 0, 10, 0, .5, 5.01)).toBe(true);
    expect(segmentBlockedBand(world, 0, 0, 10, 0, 7, 9)).toBe(true);
    expect(segmentBlockedBand(world, 0, 0, 10, 0, 20, 22)).toBe(false);
    expect(segmentBlocked(world, 0, 0, 10, 0)).toBe(false);
  });

  it("tests the polygon, including endpoint-inside and boundary contacts, rather than its enclosing rectangle", () => {
    const world = worldWith({ id: "L", baseY: 0, topY: 20, footprint: [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]] });
    expect(segmentBlockedBand(world, 4, 5, 9, 5, .5, 2)).toBe(false);
    expect(segmentBlockedBand(world, -1, 2, 9, 2, .5, 2)).toBe(true);
    expect(segmentBlockedBand(world, 1, 5, 2, 5, .5, 2)).toBe(true);
    expect(segmentBlockedBand(world, 1, 5, 1, 5, .5, 2)).toBe(true);
    expect(segmentBlockedBand(world, 4, 3, 9, 3, .5, 2)).toBe(true);
    expect(segmentBlockedBand(world, -1, 2, 9, 2, 20, 22)).toBe(false);
  });

  it("ignores flat records at every band", () => {
    const world = worldWith({ ...span, underY: undefined, baseY: 20, topY: 20 });
    expect(segmentBlockedBand(world, 0, 0, 10, 0, 1, 2)).toBe(false);
  });
});
