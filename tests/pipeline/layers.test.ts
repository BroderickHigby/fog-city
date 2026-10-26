// The wave-2 layer builders on small synthetic inputs: sidewalk corners and crossings, hydrant
// spacing, street-cleaning sides, parking parsing, transit modes, far-LOD hulls, districts.
// No network, no committed data.
import { describe, expect, it } from "vitest";
import { buildDistricts, inPolygon, slug } from "../../pipeline/lib/districts.ts";
import { convexHull, simplifyConvex } from "../../pipeline/lib/far.ts";
import { buildHydrants, buildStreetCleaning, parkingKind, transitMode } from "../../pipeline/lib/gameplay.ts";
import { isSimpleRing, signedArea, simplifyLine, type P2 } from "../../pipeline/lib/geom.ts";
import type { RoadEdge, RoadGraph, RoadKind } from "../../pipeline/lib/roads.ts";
import { RoadSurface } from "../../pipeline/lib/road-surface.ts";
import { buildSidewalks, SIDEWALK_OFFSET_M, SIDEWALK_ROAD_MARGIN_M } from "../../pipeline/lib/sidewalks.ts";
import type { RawStreet, RawSweep } from "../../pipeline/lib/sources.ts";
import { toLatLon } from "../../src/geo/project.ts";

const edge = (id: string, a: string, b: string, points: P2[], kind: RoadKind = "residential", widthM = 11, oneway = false): RoadEdge => ({
  id, a, b, kind, lanes: 2, oneway, widthM, speedLimitMps: 11, name: "Test St", points, cnn: id.slice(1), classcode: 5,
});

/** A + crossing at the origin: four 100 m arms, 11 m wide (offset 5.5 + 2 = 7.5 m). */
function plus(): RoadGraph {
  return {
    version: 1,
    attribution: "",
    nodes: [
      { id: "n0", x: 0, z: 0, y: 0 },
      { id: "nN", x: 0, z: -100, y: 0 },
      { id: "nE", x: 100, z: 0, y: 0 },
      { id: "nS", x: 0, z: 100, y: 0 },
      { id: "nW", x: -100, z: 0, y: 0 },
    ],
    edges: [
      edge("c1", "n0", "nN", [[0, 0], [0, -100]]),
      edge("c2", "n0", "nE", [[0, 0], [100, 0]]),
      edge("c3", "nS", "n0", [[0, 100], [0, 0]]),
      edge("c4", "n0", "nW", [[0, 0], [-100, 0]]),
    ],
  };
}

describe("sidewalk graph", () => {
  const o = 11 / 2 + SIDEWALK_OFFSET_M;
  const { graph: walk, stats } = buildSidewalks(plus(), () => 0, new Set(["n0"]), new Set());
  const node = (id: string) => walk.nodes.find((n) => n.id === id)!;

  it("puts a corner in each quadrant of an intersection, half the width plus 2 m from both centrelines", () => {
    const corners = walk.nodes.filter((n) => n.road === "n0");
    expect(corners).toHaveLength(4);
    expect(corners.map((c) => [Math.abs(c.x), Math.abs(c.z)])).toEqual(Array(4).fill([o, o]));
    expect(new Set(corners.map((c) => `${Math.sign(c.x)},${Math.sign(c.z)}`)).size).toBe(4);
  });

  it("runs a sidewalk down each side of every edge, from corner to corner, and crosses every arm at the signal", () => {
    expect(stats.sidewalks).toBe(8);
    // Arm c2 runs east; its right side (south, +z) starts at the south-east corner.
    const r = walk.edges.find((e) => e.id === "c2.R")!;
    expect([node(r.a).x, node(r.a).z]).toEqual([o, o]);
    expect(node(r.b).z).toBeCloseTo(o, 6);
    const l = walk.edges.find((e) => e.id === "c2.L")!;
    expect([node(l.a).x, node(l.a).z]).toEqual([o, -o]);
    const crossings = walk.edges.filter((e) => e.kind === "crossing" && e.id.startsWith("n0."));
    expect(crossings).toHaveLength(4);
    for (const c of crossings) {
      expect(c.signal).toBe(true);
      expect(c.marked).toBe(true);
      expect(c.lengthM).toBeCloseTo(2 * o, 6);
    }
    // Dead ends: one crossing around each arm's end; everything is one component.
    expect(walk.edges.filter((e) => e.kind === "crossing").length).toBe(8);
    expect(stats.components).toBe(1);
  });

  it("an edge digitised toward the node (c3, S -> centre) gets the same corners as the others", () => {
    const r = walk.edges.find((e) => e.id === "c3.R")!; // right of northbound travel = east
    expect(node(r.b).x).toBeCloseTo(o, 6);
    expect(node(r.b).z).toBeCloseTo(o, 6);
  });

  it("freeways get no sidewalks; hydrants keep 120 m apart, on land only", () => {
    const g = plus();
    g.edges.push(edge("c9", "nE", "nW", [[100, 0], [100, 50], [-100, 50], [-100, 0]], "freeway"));
    expect(buildSidewalks(g, () => 0, new Set(), new Set()).graph.edges.some((e) => e.road === "c9" && e.kind === "sidewalk")).toBe(false);
    const deg = (n: string): number => (n === "n0" ? 4 : 1);
    const hs = buildHydrants(walk, deg, () => true, () => 0);
    for (const a of hs) for (const b of hs) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(120);
    expect(hs.some((h) => h.at.startsWith("n0."))).toBe(true);
    expect(buildHydrants(walk, deg, () => false, () => 0)).toEqual([]);
    // Within a metre of a kerb (or on a road) is no place for a hydrant.
    expect(buildHydrants(walk, deg, () => true, () => 0, () => 0.9)).toEqual([]);
    expect(buildHydrants(walk, deg, () => true, () => 0, () => 1)).toHaveLength(hs.length);
  });

  it("a road crossing a sidewalk's line without a junction (a freeway overhead) cuts it, and a crossing bridges the cut", () => {
    const g = plus();
    // A 24.6 m freeway across the south arm at z = 50, with no node there.
    g.edges.push(edge("c9", "nE", "nW", [[100, 0], [100, 50], [-100, 50], [-100, 0]], "freeway", 24.6));
    const { graph: w, stats: st } = buildSidewalks(g, () => 0, new Set(), new Set());
    const surface = new RoadSurface(g.edges);
    for (const side of ["L", "R"]) {
      expect(w.edges.some((e) => e.id === `c3.${side}`), side).toBe(false);
      const pieces = w.edges.filter((e) => e.id.startsWith(`c3.${side}.`) && e.kind === "sidewalk");
      expect(pieces.map((e) => e.id).sort()).toEqual([`c3.${side}.0`, `c3.${side}.1`]);
      const bridge = w.edges.find((e) => e.id === `c3.${side}.x0`)!;
      expect(bridge.kind).toBe("crossing");
      expect(bridge.road).toBe("c9");
      expect(bridge.lengthM).toBeGreaterThan(24.6 + 2 * SIDEWALK_ROAD_MARGIN_M);
      expect(bridge.lengthM).toBeLessThan(24.6 + 2 * SIDEWALK_ROAD_MARGIN_M + 2.5);
    }
    for (const n of w.nodes) expect(surface.clearance(n.x, n.z), n.id).toBeGreaterThanOrEqual(SIDEWALK_ROAD_MARGIN_M);
    expect(st.bridges).toBeGreaterThanOrEqual(2);
    expect(st.components).toBe(1);
  });

  it("divided road: no sidewalk down a median too narrow for one; the crossing spans both carriageways", () => {
    // Two one-way carriageways 8 m wide, centrelines 8 m apart (z = -4 and z = 4), crossed by
    // an 11 m street at x = 0. Each carriageway's inner sidewalk (6 m off) would lie on the other.
    const one = (id: string, a: string, b: string, pts: P2[]): RoadEdge => ({ ...edge(id, a, b, pts, "arterial", 8, true) });
    const g: RoadGraph = {
      version: 1,
      attribution: "",
      nodes: [
        { id: "nA", x: 0, z: -4, y: 0 }, { id: "nB", x: 0, z: 4, y: 0 },
        { id: "nAw", x: -100, z: -4, y: 0 }, { id: "nAe", x: 100, z: -4, y: 0 },
        { id: "nBw", x: -100, z: 4, y: 0 }, { id: "nBe", x: 100, z: 4, y: 0 },
        { id: "nN", x: 0, z: -100, y: 0 }, { id: "nS", x: 0, z: 100, y: 0 },
      ],
      edges: [
        one("c1", "nAw", "nA", [[-100, -4], [0, -4]]), one("c2", "nA", "nAe", [[0, -4], [100, -4]]),
        one("c3", "nBe", "nB", [[100, 4], [0, 4]]), one("c4", "nB", "nBw", [[0, 4], [-100, 4]]),
        edge("c5", "nN", "nA", [[0, -100], [0, -4]]), edge("c6", "nA", "nB", [[0, -4], [0, 4]]), edge("c7", "nB", "nS", [[0, 4], [0, 100]]),
      ],
    };
    const { graph: w, stats: st } = buildSidewalks(g, () => 0, new Set(), new Set());
    const surface = new RoadSurface(g.edges);
    for (const n of w.nodes) expect(surface.clearance(n.x, n.z), n.id).toBeGreaterThanOrEqual(SIDEWALK_ROAD_MARGIN_M);
    // Only the outer sides keep sidewalks: north of A (left of eastbound c1/c2), south of B.
    const sides = w.edges.filter((e) => e.kind === "sidewalk" && ["c1", "c2", "c3", "c4"].includes(e.road)).map((e) => e.id).sort();
    expect(sides).toEqual(["c1.L", "c2.L", "c3.L", "c4.L"]);
    expect(w.edges.some((e) => e.road === "c6" && e.kind === "sidewalk")).toBe(false);
    // One crossing on each side of the cross street, from z = -10 (north of A) to z = 10 (south of B)
    // (the dead ends at x = +-100 get one each too).
    const pos = new Map(w.nodes.map((n) => [n.id, n]));
    const spans = w.edges
      .filter((e) => e.kind === "crossing")
      .map((e) => [pos.get(e.a)!, pos.get(e.b)!].sort((p, q) => p.z - q.z))
      .filter(([p, q]) => p!.z < -9 && q!.z > 9 && Math.abs(p!.x) < 50)
      .map(([p]) => Math.sign(p!.x));
    expect(spans.sort()).toEqual([-1, 1]);
    expect(st.cornersOnRoad).toBe(8); // 4 median corners at the junction, 4 at the dead ends
    expect(st.crossingsExtended).toBeGreaterThanOrEqual(2);
    expect(st.components).toBe(1);
  });
});

describe("gameplay parsing", () => {
  it("street cleaning sides follow the road edge's direction, flipped for reversed one-ways", () => {
    const g = plus();
    const streets: RawStreet[] = [{ cnn: "2", oneway: "B" }, { cnn: "3", oneway: "T" }];
    const sweep = (cnn: string, lr: string): RawSweep => ({ cnn, cnnrightleft: lr, weekday: "Tues", fromhour: "8", tohour: "10", week1: "1", week3: "1", holidays: "0" });
    const rules = buildStreetCleaning([sweep("2", "L"), sweep("3", "L"), sweep("99", "R")], streets, g);
    expect(rules).toEqual([
      { edge: "c2", side: "L", day: 2, fromHour: 8, toHour: 10, weeks: [1, 3], holidays: false },
      { edge: "c3", side: "R", day: 2, fromHour: 8, toHour: 10, weeks: [1, 3], holidays: false },
    ]);
  });

  it("normalises parking regulation kinds and transit modes", () => {
    expect(parkingKind("Time Limited")).toBe("time-limited");
    expect(parkingKind("Time LImited")).toBe("time-limited");
    expect(parkingKind("No Parking Anytime")).toBe("no-parking-any-time");
    expect(parkingKind("No parking any time")).toBe("no-parking-any-time");
    expect(parkingKind("Paid + Permit")).toBe("pay-or-permit");
    expect(parkingKind(undefined)).toBe("unknown");
    expect(["PH", "PM", "CA", "F", "N", "014"].map(transitMode)).toEqual(["cable", "cable", "cable", "streetcar", "rail", "bus"]);
  });
});

describe("far-LOD hulls", () => {
  it("convex hull is counter-clockwise on a north-up map; simplification keeps the largest shape", () => {
    const pts: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, -0.2], [10.1, 5]];
    const h = convexHull(pts);
    expect(signedArea(h)).toBeLessThan(0);
    expect(h).toHaveLength(6);
    const s = simplifyConvex(h, 4);
    expect(s).toHaveLength(4);
    expect(Math.abs(signedArea(s))).toBeGreaterThan(99);
  });
});

describe("districts", () => {
  const ll = (x: number, z: number): [number, number] => {
    const p = toLatLon(x, z);
    return [p.lon, p.lat];
  };
  it("project, orient (outer counter-clockwise, holes clockwise), slug and contain", () => {
    const outer = [ll(0, 0), ll(0, 100), ll(100, 100), ll(100, 0), ll(0, 0)];
    const hole = [ll(40, 40), ll(60, 40), ll(60, 60), ll(40, 60), ll(40, 40)];
    const [d] = buildDistricts([{ nhood: "Castro/Upper Market", the_geom: { type: "MultiPolygon", coordinates: [[outer, hole]] } }]);
    expect(d!.id).toBe("castro-upper-market");
    expect(signedArea(d!.polygons[0]![0]!)).toBeLessThan(0);
    expect(signedArea(d!.polygons[0]![1]!)).toBeGreaterThan(0);
    expect(d!.areaM2).toBeCloseTo(100 * 100 - 20 * 20, -1);
    expect(inPolygon(10, 10, d!.polygons[0]!)).toBe(true);
    expect(inPolygon(50, 50, d!.polygons[0]!)).toBe(false);
    expect(slug("Financial District/South Beach")).toBe("financial-district-south-beach");
  });

  it("geometry helpers: simple-ring test and open-polyline simplification", () => {
    expect(isSimpleRing([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(true);
    expect(isSimpleRing([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(false);
    expect(simplifyLine([[0, 0], [5, 0.1], [10, 0], [10, 10]], 0.5)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
});
