import { afterEach, describe, expect, it, vi } from "vitest";
import * as projection from "../../src/geo/project.ts";
import { DISTRICTS, PROTECTED_AREAS, pointInPolygon, type LatLon, type Polygon } from "../../src/content/places.ts";

afterEach(() => vi.restoreAllMocks());
type MutablePoint = [number, number];
const at = (x: number, z: number): MutablePoint => {
  const point = projection.toLatLon(x, z);
  return [point.lat, point.lon];
};
const square = (): MutablePoint[] => [at(0, 0), at(10, 0), at(10, 10), at(0, 10)];

/** Original uncached implementation: retain its exact projection and even/odd edge arithmetic. */
function reference(p: LatLon, poly: Polygon): boolean {
  const { x, z } = projection.toLocal(p[0], p[1]);
  const ring = poly.map(vertex => projection.toLocal(vertex[0], vertex[1]));
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function equivalent(poly: Polygon, probes: readonly LatLon[]): void {
  for (const p of probes) expect(pointInPolygon(p, poly), `${p} in ${JSON.stringify(poly)}`).toBe(reference(p, poly));
}

describe("cached polygon projections", () => {
  it("projects an unchanged ring once and reprojects after a numeric vertex edit", () => {
    const poly = square(), point = at(5, 5), project = vi.spyOn(projection, "toLocal");
    expect(pointInPolygon(point, poly)).toBe(true);
    expect(project).toHaveBeenCalledTimes(5); // Query point and the four new ring vertices.
    expect(pointInPolygon(point, poly)).toBe(true);
    expect(project).toHaveBeenCalledTimes(6); // Only the query point is new.
    poly[1]![1] = at(30, 0)[1];
    expect(pointInPolygon(point, poly)).toBe(reference(point, poly));
    expect(project).toHaveBeenCalledTimes(16); // Five production projections plus five reference projections.
  });

  it("reflects in-place coordinate edits, replacement, push, pop and reorder without mutating input", () => {
    const poly = square(), probes = [at(5, 5), at(20, 5), at(-5, 5), ...square()];
    equivalent(poly, probes);
    expect(pointInPolygon(at(20, 5), poly)).toBe(false);
    poly[1]![1] = at(30, 0)[1]; poly[2]![1] = at(30, 10)[1];
    expect(pointInPolygon(at(20, 5), poly)).toBe(true);
    equivalent(poly, probes);
    poly[1] = at(10, 0); poly[2] = at(10, 10);
    expect(pointInPolygon(at(20, 5), poly)).toBe(false);
    equivalent(poly, probes);
    poly.push(at(-10, 5)); equivalent(poly, probes);
    poly.pop(); equivalent(poly, probes);
    poly.reverse(); equivalent(poly, probes);
    poly.splice(1, 1); equivalent(poly, probes);
    const before = JSON.stringify(poly); equivalent(poly, probes); expect(JSON.stringify(poly)).toBe(before);
  });

  it("keeps the projection's numeric origin in the cache identity", () => {
    const poly = square(), point = at(5, 5);
    const origin = projection.ORIGIN as unknown as { lat: number; lon: number }, longitude = origin.lon;
    expect(pointInPolygon(point, poly)).toBe(true);
    try {
      origin.lon += .01;
      expect(pointInPolygon(point, poly)).toBe(true);
      expect(pointInPolygon(point, poly)).toBe(reference(point, poly));
    } finally { origin.lon = longitude; }
    expect(pointInPolygon(point, poly)).toBe(true);
  });

  it("matches authored polygons at vertices, edge midpoints and nearby grid probes", () => {
    for (const poly of [...DISTRICTS.map(d => d.polygon), ...PROTECTED_AREAS.map(a => a.polygon)]) {
      const probes: LatLon[] = [...poly];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        const midpoint: MutablePoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        probes.push(midpoint, [midpoint[0] + 1e-8, midpoint[1]], [midpoint[0] - 1e-8, midpoint[1]]);
      }
      equivalent(poly, probes); equivalent(poly, probes);
    }
  });

  it("retains degenerate, crossing and non-finite numeric behavior", () => {
    const probes = [at(0, 0), at(5, 5), at(10, 10), at(5, 0), at(-1, 5), [NaN, Infinity] as LatLon];
    const polygons: MutablePoint[][] = [[], [at(0, 0)], [at(0, 0), at(10, 0)],
      [at(0, 0), at(10, 10), at(0, 10), at(10, 0)], [at(0, 0), at(10, 0), at(10, 0), at(0, 10)],
      [[NaN, -122.4], [37.8, Infinity], [37.7, -122.3]],
    ];
    for (const poly of polygons) { equivalent(poly, probes); equivalent(poly, probes); }
    const poly = square(); pointInPolygon(at(5, 5), poly);
    poly[0]![0] = NaN; equivalent(poly, probes); equivalent(poly, probes);
  });
});
