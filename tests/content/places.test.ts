// Map data: district polygons, protected areas, the bad-robot rate and its clamp, geometry helpers.
import { describe, expect, it } from "vitest";
import {
  BASELINE_BAD_RATE, DISTRICTS, MOAT_SITES, PROTECTED_AREAS, SITES, areaM2, badRobotRate, distanceM, distanceToPolygonM, districtsAt,
  pointInPolygon, polygonsIntersect, protectedAreaAt, type LatLon,
} from "../../src/content/places.ts";

const hub = (id: string): LatLon => {
  const d = DISTRICTS.find((x) => x.id === id)!;
  return [d.hub.lat, d.hub.lon];
};

describe("districts", () => {
  it("each hub lies inside its own district, and districts are plausibly sized", () => {
    for (const d of DISTRICTS) {
      expect(districtsAt([d.hub.lat, d.hub.lon]).map((x) => x.id), d.id).toContain(d.id);
      const km2 = areaM2(d.polygon) / 1e6;
      expect(km2, d.id).toBeGreaterThan(0.05);
      expect(km2, d.id).toBeLessThan(5);
    }
  });

  it("no district hub lies in a protected area", () => {
    for (const d of DISTRICTS) expect(protectedAreaAt([d.hub.lat, d.hub.lon]), d.id).toBeUndefined();
  });

  it("names fit the district label slot", () => {
    for (const d of DISTRICTS) expect(d.name.length, d.id).toBeLessThanOrEqual(22);
  });
});

describe("the bad-robot rate (design.md, The living city)", () => {
  it("is about 6% near Moat Labs HQ in SoMa, 3-4% in FiDi and 2% in North Beach and the Marina", () => {
    expect(badRobotRate(hub("soma"))).toBeGreaterThan(0.05);
    expect(badRobotRate(hub("soma"))).toBeLessThan(0.075);
    expect(badRobotRate([37.7905, -122.4015])).toBeGreaterThanOrEqual(0.03); // FiDi coworking desk
    expect(badRobotRate([37.7905, -122.4015])).toBeLessThanOrEqual(0.04);
    expect(badRobotRate(hub("north-beach"))).toBeCloseTo(BASELINE_BAD_RATE, 6);
    expect(badRobotRate(hub("marina"))).toBeCloseTo(BASELINE_BAD_RATE, 6);
  });

  it("is clamped to the baseline in every protected area, even 500 m from HQ", () => {
    const sixth: LatLon = [37.78097, -122.40871]; // 6th St & Mission St
    expect(protectedAreaAt(sixth)?.id).toBe("sixth-street");
    expect(distanceM(sixth, [MOAT_SITES[0]!.lat, MOAT_SITES[0]!.lon])).toBeLessThan(800);
    expect(badRobotRate(sixth)).toBe(BASELINE_BAD_RATE);
    for (const a of PROTECTED_AREAS) {
      const c = a.polygon.reduce((s, p) => [s[0] + p[0] / a.polygon.length, s[1] + p[1] / a.polygon.length], [0, 0]) as unknown as LatLon;
      if (pointInPolygon(c, a.polygon)) expect(badRobotRate(c), a.id).toBe(BASELINE_BAD_RATE);
    }
  });

  it("the site list is HQ, the convention center and two depots (bridge touchdown and Mission Bay)", () => {
    expect(MOAT_SITES.map((s) => s.kind).sort()).toEqual(["conventionCenter", "depot", "depot", "hq"]);
    const hq = MOAT_SITES.find((s) => s.kind === "hq")!;
    expect(hq.term).toBe(0.04);
    expect(hq.falloffM).toBe(1500);
    for (const s of MOAT_SITES.filter((x) => x.kind !== "hq")) {
      expect(s.term).toBe(0.02);
      expect(s.falloffM).toBe(600);
    }
    expect(districtsAt([hq.lat, hq.lon]).map((d) => d.id)).toContain("soma");
  });
});

describe("geometry", () => {
  const sq: LatLon[] = [[37.79, -122.40], [37.79, -122.39], [37.78, -122.39], [37.78, -122.40]];
  it("point in polygon, distance to polygon and intersection", () => {
    expect(pointInPolygon([37.785, -122.395], sq)).toBe(true);
    expect(pointInPolygon([37.795, -122.395], sq)).toBe(false);
    expect(distanceToPolygonM([37.785, -122.395], sq)).toBe(0);
    expect(distanceToPolygonM([37.791, -122.395], sq)).toBeCloseTo(111, 0);
    const shifted = sq.map(([a, b]) => [a + 0.005, b] as LatLon);
    expect(polygonsIntersect(sq, shifted)).toBe(true);
    const far = sq.map(([a, b]) => [a + 0.02, b] as LatLon);
    expect(polygonsIntersect(sq, far)).toBe(false);
    const inner: LatLon[] = [[37.786, -122.396], [37.786, -122.394], [37.784, -122.394], [37.784, -122.396]];
    expect(polygonsIntersect(sq, inner)).toBe(true);
  });

  it("every site has a label and none sits in an excluded area", () => {
    for (const s of SITES) {
      expect(s.label.length).toBeGreaterThan(5);
      for (const a of PROTECTED_AREAS.filter((x) => x.excluded)) expect(pointInPolygon([s.lat, s.lon], a.polygon), `${s.id} in ${a.id}`).toBe(false);
    }
  });
});
