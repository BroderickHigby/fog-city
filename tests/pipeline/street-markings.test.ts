// Junction paint (pipeline/lib/street-markings.ts): crosswalks square across each leg, stop
// bars on the controlled approaches, and a patch over the junction box that hides the
// overlapping road ribbons. Regression for the "sideways X" crosswalks: the ribbons of every
// leg ran through the box and each painted its own dashes there. Synthetic graphs plus the
// committed sf output on Chestnut St. No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeJunction } from "../../pipeline/build-street-detail.ts";
import { distToRing, pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import type { RoadEdge, RoadGraph, RoadKind } from "../../pipeline/lib/roads.ts";
import {
  buildMarkings,
  CROSSWALK_DEPTH_M,
  insideRibbon,
  ribbonHit,
  stopApproaches,
  type Junction,
  type MarkingFacts,
} from "../../pipeline/lib/street-markings.ts";
import { continentalBars, decodeJunction, type MarkingJunction, type MarkingLeg } from "../../src/render/street-markings.ts";
import { ROOT } from "../helpers.ts";

const edge = (id: string, a: string, b: string, points: P2[], kind: RoadKind = "residential", widthM = 11, oneway = false): RoadEdge => ({
  id, a, b, kind, lanes: 2, oneway, widthM, speedLimitMps: 11, name: "Test St", points, cnn: id.slice(1), classcode: 5,
});

/** A + crossing at the origin with four 100 m arms; c3 runs north into the node. */
function plus(oneway = false): RoadGraph {
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
      edge("c1", "n0", "nN", [[0, 0], [0, -100]], "residential", 11, oneway),
      edge("c2", "n0", "nE", [[0, 0], [100, 0]], "arterial", 15),
      edge("c3", "nS", "n0", [[0, 100], [0, 0]], "residential", 11, oneway),
      edge("c4", "n0", "nW", [[0, 0], [-100, 0]], "arterial", 15),
    ],
  };
}

const none: MarkingFacts = { continental: new Set(), signals: new Set(), stopApproaches: new Set() };
const flat = (): number => 0;

/** World point at distance t along leg l from the junction's node, offset v across it. */
const at = (j: { x: number; z: number }, l: { ux: number; uz: number; ox: number; oz: number }, t: number, v: number): P2 => [j.x + l.ox + l.ux * t - l.uz * v, j.z + l.oz + l.uz * t + l.ux * v];

/** Corners of every painted rectangle of a leg (bars, lines, stop bar), as the renderer lays them. */
function paintQuads(j: MarkingJunction, l: MarkingLeg): P2[][] {
  const rects: Array<[number, number, number, number]> = [];
  const inner = l.half - 0.4;
  if (l.style === "c") for (const c of continentalBars(l.half)) rects.push([l.from, l.to, c - 0.3, c + 0.3]);
  if (l.style === "s") rects.push([l.from, l.from + 0.3, -inner, inner], [l.to - 0.3, l.to, -inner, inner]);
  if (l.stopAt > 0) rects.push([l.stopAt, l.stopAt + 0.45, l.stopV0, l.stopV1]);
  return rects.map(([t0, t1, v0, v1]) => [at(j, l, t0, v0), at(j, l, t0, v1), at(j, l, t1, v1), at(j, l, t1, v0)]);
}

/** Distance from p to leg l's centreline ray (from the node outward). */
function lateral(j: { x: number; z: number }, l: { ux: number; uz: number }, p: P2): { t: number; v: number } {
  const dx = p[0] - j.x, dz = p[1] - j.z;
  return { t: dx * l.ux + dz * l.uz, v: -dx * l.uz + dz * l.ux };
}

function decoded(j: Junction): MarkingJunction {
  return decodeJunction(JSON.parse(JSON.stringify(encodeJunction(j))))!;
}

describe("junction paint on a + crossing", () => {
  it("lays continental bars along each leg, square across it, outside the cross street's kerb line", () => {
    const { junctions, stats } = buildMarkings(plus(), { ...none, continental: new Set(["n0"]) }, flat);
    expect(junctions).toHaveLength(1);
    const j = decoded(junctions[0]!);
    expect(j.legs.map((l) => [l.edge, l.style])).toEqual([["c1", "c"], ["c2", "c"], ["c3", "c"], ["c4", "c"]]);
    expect(stats.crosswalks.continental).toBe(4);
    for (const l of j.legs) {
      const crossHalf = l.edge === "c1" || l.edge === "c3" ? 7.5 : 5.5;
      expect(l.from).toBeGreaterThanOrEqual(crossHalf);
      expect(l.to - l.from).toBeCloseTo(CROSSWALK_DEPTH_M, 6);
      // Every bar edge runs along the leg: the two long sides are parallel to (ux, uz).
      for (const q of paintQuads(j, l)) {
        const along = [q[3]![0] - q[0]![0], q[3]![1] - q[0]![1]];
        const len = Math.hypot(along[0]!, along[1]!);
        expect(Math.abs((along[0]! * l.ux + along[1]! * l.uz) / len)).toBeCloseTo(1, 6);
        for (const p of q) expect(Math.abs(lateral(j, l, p).v)).toBeLessThanOrEqual(l.half);
      }
    }
  });

  it("covers every overlap of the leg ribbons with the patch, so no leg's dashes show in the box", () => {
    const { junctions } = buildMarkings(plus(), none, flat);
    const j = junctions[0]!;
    const legs = j.legs;
    for (let x = -12; x <= 12; x += 0.5) {
      for (let z = -12; z <= 12; z += 0.5) {
        const inside = legs.filter((l) => {
          const { t, v } = lateral(j, l, [x, z]);
          return t >= 0 && Math.abs(v) < l.half;
        });
        if (inside.length >= 2) expect(pointInRing(x, z, j.ring), `(${x}, ${z})`).toBe(true);
      }
    }
  });

  it("paints standard crosswalks at a signal and nothing at an uncontrolled corner", () => {
    expect(buildMarkings(plus(), { ...none, signals: new Set(["n0"]) }, flat).stats.crosswalks).toEqual({ continental: 0, standard: 4 });
    expect(buildMarkings(plus(), none, flat).stats.crosswalks).toEqual({ continental: 0, standard: 0 });
  });

  it("puts stop bars across the approach lanes only, and none on a one-way leaving the node", () => {
    const two = decoded(buildMarkings(plus(), { ...none, signals: new Set(["n0"]) }, flat).junctions[0]!);
    for (const l of two.legs) {
      expect(l.stopAt).toBeGreaterThan(l.to);
      expect(l.stopV1).toBeLessThan(0); // traffic approaching drives on the leg's anticlockwise side
    }
    const one = decoded(buildMarkings(plus(true), { ...none, signals: new Set(["n0"]) }, flat).junctions[0]!);
    const c1 = one.legs.find((l) => l.edge === "c1")!; // one-way away from the node
    const c3 = one.legs.find((l) => l.edge === "c3")!; // one-way into the node: the whole width
    expect(c1.stopAt).toBe(0);
    expect(c3.stopV0).toBeLessThan(0);
    expect(c3.stopV1).toBeGreaterThan(0);
  });

  it("matches a stop sign row to the approach it faces", () => {
    const g = plus();
    g.nodes[0]!.id = "n123";
    for (const e of g.edges) {
      if (e.a === "n0") e.a = "n123";
      if (e.b === "n0") e.b = "n123";
    }
    expect(stopApproaches([{ cnn: "999", street: "TEST", st_facing: "NB" }], g).unmatched).toBe(1);
    const nb = stopApproaches([{ cnn: "123", street: "TEST", st_facing: "NB" }], g);
    // Northbound traffic arrives from the south leg (c3).
    expect([...nb.approaches]).toEqual(["n123|c3"]);
    const wb = stopApproaches([{ cnn: "123", street: "TEST", st_facing: "WB" }], g);
    expect([...wb.approaches]).toEqual(["n123|c2"]);
  });
});

describe("Chestnut St junctions in the committed sf data (regression: no sideways X)", () => {
  const dir = join(ROOT, "public/tiles/sf");
  const doc = JSON.parse(readFileSync(join(dir, "street-markings.json"), "utf8")) as { junctions: unknown[] };
  const roads = JSON.parse(readFileSync(join(dir, "roads.json"), "utf8")) as RoadGraph;
  const edges = new Map(roads.edges.map((e) => [e.id, e]));
  const junctions = doc.junctions.map((r) => decodeJunction(r)!);
  const chestnut = junctions.filter((j) => j.legs.some((l) => edges.get(l.edge)?.name === "Chestnut St"));

  it("has painted junctions all along Chestnut St, Fillmore to Scott included", () => {
    expect(chestnut.length).toBeGreaterThanOrEqual(12);
    for (const id of ["n26763000", "n26771000", "n26972000"]) {
      const j = chestnut.find((c) => c.id === id)!;
      expect(j, id).toBeTruthy();
      expect(j.legs.filter((l) => l.style !== "").length, id).toBeGreaterThanOrEqual(3);
    }
  });

  it("lays every crosswalk square across its own leg, along the real street", () => {
    let checked = 0;
    for (const j of chestnut) {
      for (const l of j.legs) {
        if (l.style === "") continue;
        const e = edges.get(l.edge)!;
        const pts = e.a === j.id ? e.points : [...e.points].reverse();
        // The street's own direction (the centreline segment) at the middle of the crosswalk.
        const mid = (l.from + l.to) / 2;
        let acc = 0, k = 1;
        for (; k < pts.length - 1; k++) {
          const s = Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
          if (acc + s >= mid) break;
          acc += s;
        }
        const dx = pts[k]![0] - pts[k - 1]![0], dz = pts[k]![1] - pts[k - 1]![1];
        const d = Math.hypot(dx, dz);
        expect((dx * l.ux + dz * l.uz) / d, `${j.id} ${l.edge}`).toBeGreaterThan(Math.cos((8 * Math.PI) / 180));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  /** The leg's centreline from the node, truncated at `reach` metres. */
  function legLine(j: MarkingJunction, edgeId: string, reach = Infinity): P2[] {
    const e = edges.get(edgeId)!;
    const raw = e.a === j.id ? e.points : [...e.points].reverse();
    const pts: P2[] = [[j.x, j.z]];
    let acc = 0;
    for (let i = 1; i < raw.length; i++) {
      const a = pts[pts.length - 1]!, b = raw[i]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + l >= reach) {
        const t = (reach - acc) / l;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        return pts;
      }
      pts.push([b[0], b[1]]);
      acc += l;
    }
    return pts;
  }

  it("keeps each leg's paint out of every other leg's carriageway (no crossing stripes)", () => {
    let painted = 0;
    for (const j of chestnut) {
      for (const l of j.legs) {
        for (const q of paintQuads(j, l)) {
          painted++;
          for (const p of q) {
            for (const o of j.legs) {
              if (o === l) continue;
              // A carriageway running alongside (a divided street's other half) is not a cross street.
              const d = ribbonHit(p[0], p[1], legLine(j, o.edge, 80), o.half - 0.05);
              const crossing = d !== null && Math.abs(d[0] * l.ux + d[1] * l.uz) < Math.cos((15 * Math.PI) / 180);
              expect(crossing, `${j.id}: ${l.edge} paint inside ${o.edge}`).toBe(false);
            }
          }
        }
      }
    }
    expect(painted).toBeGreaterThan(200);
  });

  it("covers the junction box with the patch wherever two legs' ribbons overlap", () => {
    for (const j of chestnut) {
      const ring: P2[] = [];
      for (let i = 0; i < j.ring.length; i += 2) ring.push([j.ring[i]!, j.ring[i + 1]!]);
      const heads = j.legs.map((l) => ({ pts: legLine(j, l.edge, l.mouth), half: l.half }));
      const reach = Math.max(...j.legs.map((l) => l.mouth + l.half));
      for (let dx = -reach; dx <= reach; dx += 0.5) {
        for (let dz = -reach; dz <= reach; dz += 0.5) {
          const p: P2 = [j.x + dx, j.z + dz];
          const inside = heads.filter((h) => insideRibbon(p[0], p[1], h.pts, h.half - 0.1)).length;
          if (inside >= 2 && !pointInRing(p[0], p[1], ring)) {
            expect(distToRing(p[0], p[1], ring), `${j.id} (${dx}, ${dz})`).toBeLessThan(0.3);
          }
        }
      }
    }
  });
});
