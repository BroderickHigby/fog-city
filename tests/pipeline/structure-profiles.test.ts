// Profiles of street structures, as pure functions (W-02, W-22): a surface tunnel's straight
// line from end to end through its open cuts, and an overpass's line over a cut from lip to lip.

import { describe, expect, it } from "vitest";
import { upperHull } from "../../pipeline/lib/decks.ts";
import { CUT_TOLERANCE_M, throughCut } from "../../pipeline/lib/tunnels.ts";

/** A profile every metre from a ground function. */
const prof = (L: number, h: (s: number) => number): Array<{ s: number; h: number }> => Array.from({ length: L + 1 }, (_, s) => ({ s, h: h(s) }));

describe("throughCut: a surface tunnel's bore through its approach cuts", () => {
  it("runs end to end when the straight line stays under the ground (Broadway: a trench from Larkin St, under Hyde St, into the hill)", () => {
    // 51 m at one end, 37 m at the other; the ground rises over the line all the way between.
    const p = prof(880, (s) => 51 - (14 * s) / 880 + 40 * Math.sin((Math.PI * s) / 880));
    expect(throughCut(p)).toEqual({ i0: 0, i1: 880, y0: p[0]!.h, y1: p[880]!.h });
  });

  it("allows the line CUT_TOLERANCE_M over the ground near an end, not more", () => {
    const dip = (d: number) => prof(400, (s) => (s === 5 ? -d : 20 * Math.sin((Math.PI * s) / 400)));
    expect(throughCut(dip(CUT_TOLERANCE_M - 0.01))).not.toBeNull();
    expect(throughCut(dip(CUT_TOLERANCE_M + 0.05))).toBeNull();
  });

  it("is null where an approach is at grade below the line (Stockton: its north approach), or the line is steeper than a tunnel", () => {
    const stockton = prof(420, (s) => (s < 85 ? 27 + 0.02 * s : 28.7 + 20 * Math.sin((Math.PI * (s - 85)) / 335) + (0.04 * (s - 85))));
    expect(throughCut(stockton)).toBeNull();
    expect(throughCut(prof(100, (s) => 0.1 * s + 10 * Math.sin((Math.PI * s) / 100)))).toBeNull();
  });
});

describe("upperHull: an overpass over a cut", () => {
  it("leaves each lip of a trench on the line between the lips, not down the trench's side to a chord between the ends", () => {
    // Flat at 30 m for 10 m, a trench down to 22 m, and up to 27 m, then falling away to the far end.
    const ground = (S: number): number => (S <= 10 ? 30 - 0.01 * S : S < 20 ? 29.9 - 0.8 * (S - 10) : S < 55 ? 22 : S < 65 ? 22 + 0.5 * (S - 55) : 27 - 0.1 * (S - 65));
    const hull = upperHull(0, 85, ground);
    // Never under the ground, and through the lips.
    for (let S = 0; S <= 85; S += 0.5) expect(hull(S)).toBeGreaterThanOrEqual(ground(S) - 1e-9);
    expect(hull(10)).toBeCloseTo(ground(10), 6);
    expect(hull(65)).toBeCloseTo(ground(65), 6);
    // Straight between the lips: no grade change between them.
    const g1 = hull(20) - hull(15), g2 = hull(60) - hull(55);
    expect(g1).toBeCloseTo(g2, 6);
    // The ends are the ground.
    expect(hull(0)).toBeCloseTo(30, 6);
    expect(hull(85)).toBeCloseTo(ground(85), 6);
  });

  it("is the chord where the ground under the span is concave", () => {
    const hull = upperHull(10, 50, (S) => 0.01 * (S - 30) * (S - 30));
    for (let S = 10; S <= 50; S += 5) expect(hull(S)).toBeCloseTo(4, 6);
  });
});
