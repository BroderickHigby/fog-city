// The two-tier rule on real DataSF LiDAR statistics (hgt_* of sf16 footprints, metres;
// footprint areas after simplification). Which footprints get a tower, and which LiDAR
// maxima are outliers that must not become needles.

import { describe, expect, it } from "vitest";
import { plausibleStories, plausibleTower, towerFraction } from "../../pipeline/lib/buildings.ts";

interface Case {
  id: string;
  what: string;
  area: number;
  med: number;
  max: number;
  mean: number;
  std: number;
}

const tower = (c: Case): boolean => plausibleTower(c.area, towerFraction(c.med, c.max, c.mean, c.std), c.max - c.med);

describe("two-tier massing: real towers keep their tower", () => {
  const real: Case[] = [
    { id: "201006.0000687", what: "600 Montgomery St pyramid", area: 2986, med: 67.83, max: 258.53, mean: 84.52, std: 70.26 },
    { id: "201006.0000058", what: "Ferry Building clock tower on its long hall", area: 10272, med: 15.24, max: 71.43, mean: 16.25, std: 5.48 },
    { id: "201006.0006230", what: "Coit Tower on its hilltop base", area: 539, med: 6.0, max: 51.27, mean: 14.24, std: 16.2 },
    // Mean below median (courtyards and low wings), yet a tower: the low part is modelled.
    { id: "201006.0000422", what: "Russ Building, 31-storey centre on lower wings", area: 3987, med: 64.94, max: 135.94, mean: 62.24, std: 39.03 },
    { id: "201006.0000158", what: "a 127 m office slab on a plaza podium", area: 7073, med: 11.2, max: 127.3, mean: 48.2, std: 50.6 },
  ];
  for (const c of real) {
    it(`${c.what} (${c.id})`, () => {
      expect(tower(c)).toBe(true);
    });
  }

  it("the tower's area fraction is the two-level estimate when nothing is below the roof", () => {
    // 15 % of the footprint at the max, the rest at the median: mean = med + 0.15 d, std = d·√(0.15·0.85).
    const d = 100;
    expect(towerFraction(20, 120, 20 + 0.15 * d, d * Math.sqrt(0.15 * 0.85))).toBeCloseTo(0.15, 3);
  });
});

describe("two-tier massing: an outlier max never becomes a needle", () => {
  const outliers: Case[] = [
    { id: "201006.0024724", what: "3-storey 1908 house with a 144 m LiDAR max, no tall neighbour", area: 200, med: 13.2, max: 143.8, mean: 15.5, std: 12.8 },
    { id: "201006.0001118", what: "40 m building beside a 178 m tower (mean below median)", area: 2093, med: 39.7, max: 168.6, mean: 38.6, std: 13.6 },
    { id: "201006.0001964", what: "24 m podium wing beside its parcel's 146 m tower", area: 1383, med: 24.5, max: 135.8, mean: 29.8, std: 20.6 },
    { id: "201006.0171380", what: "10 m² fragment with a 104 m max", area: 10, med: 24.1, max: 103.9, mean: 35.0, std: 27.8 },
    { id: "201006.0000435", what: "11-storey 1917 office beside a 172 m tower", area: 3899, med: 46.1, max: 114.9, mean: 45.7, std: 5.6 },
  ];
  for (const c of outliers) {
    it(`${c.what} (${c.id})`, () => {
      expect(tower(c)).toBe(false);
    });
  }
});

describe("assessor storeys against the measured height", () => {
  it("keeps storeys that fit and drops a condo unit's storeys on a tower", () => {
    expect(plausibleStories(48, 258.6)).toBe(true);
    expect(plausibleStories(3, 12)).toBe(true);
    // 201006.0002073: a 94 m Russian Hill tower whose joined unit parcel says 1 storey.
    expect(plausibleStories(1, 93.7)).toBe(false);
    // A low wing (28 m) carrying its parcel's 33 storeys.
    expect(plausibleStories(33, 27.9)).toBe(false);
  });
});
