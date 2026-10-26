// The far layer's seams (src/render/far-layer.ts): its terrain lattice is found among the hulls;
// at the city's outer edge the far quads just outside are hidden and replaced by stitches whose
// inner side follows the streamed tile's ground and whose outer side meets the far lattice (the
// crack there showed the sea at the city limit); and the land at the far terrain's north and
// south ends carries on as an apron.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { APRON_ROWS_M, STITCH_BAND_M, STITCH_SINK_M, farApron, farTerrain, hideTriangles, outerSeams, stitchStrip, type FarTerrain } from "../../src/render/far-layer.ts";

/**
 * A far cell like the pipeline's: a 100 m lattice over x 900..1200, z 9800..10200, two
 * triangles per quad (a, c, b), (b, c, d), stored relative to the node at (1000, 0, 10000);
 * plus one hull triangle off the lattice.
 */
function cell(height: (x: number, z: number) => number): { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  const xs = [900, 1000, 1100, 1200];
  const zs = [9800, 9900, 10000, 10100, 10200];
  const pos: number[] = [];
  const col: number[] = [];
  for (const z of zs) {
    for (const x of xs) {
      pos.push(x - 1000, height(x, z), z - 10000);
      col.push(0.5, 0.5, 0.45, 1);
    }
  }
  const idx: number[] = [];
  const v = (i: number, k: number): number => k * xs.length + i;
  for (let k = 0; k + 1 < zs.length; k++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = v(i, k);
      const b = v(i + 1, k);
      const c = v(i, k + 1);
      const d = v(i + 1, k + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  // A hull wall triangle off the lattice.
  const h = pos.length / 3;
  pos.push(12.5, 5, -40.2, 12.5, 25, -40.2, 30.1, 5, -40.2);
  col.push(0.8, 0.7, 0.6, 1, 0.8, 0.7, 0.6, 1, 0.8, 0.7, 0.6, 1);
  idx.push(h, h + 1, h + 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return { geo, matrix: new THREE.Matrix4().makeTranslation(1000, 0, 10000) };
}

const farH = (x: number, _z: number): number => 5 + 0.02 * (x - 900);
// The streamed tile's 10 m ground wiggles between the far lattice's points.
const ground = (x: number, z: number): number => farH(x, z) + 0.6 * Math.sin(x / 7) + 0.3 * Math.cos(z / 11);
const builtTile = (_ix: number, iz: number): boolean => iz < 20; // the city stops at z = 10000

describe("far layer seams", () => {
  const { geo, matrix } = cell(farH);
  const t: FarTerrain = farTerrain(geo, matrix);

  it("finds the terrain lattice and its edges, not the hulls", () => {
    expect(t.points.size).toBe(20);
    expect(t.colorSize).toBe(4);
    // 3 x 5 east-west edges and 4 x 4 north-south ones; the rim's are shared by one triangle.
    expect(t.edges.size).toBe(31);
    const rim = [...t.edges.values()].filter((e) => e.n === 1).length;
    expect(rim).toBe(14);
    expect(t.points.get("1000,10000")!.y).toBeCloseTo(farH(1000, 10000), 5);
  });

  it("finds the far quads just outside the city's outer edge, and only those", () => {
    const seams = outerSeams(t, { tileSizeM: 500, builtTile });
    // The line z = 10000 is the outer edge (tiles north of it stream in, none south of it); the
    // line x = 1000 has tiles on both sides north of z = 10000 and none south of it: no seam.
    expect(seams.map((q) => `${q.a.x},${q.a.z}-${q.b.x},${q.b.z}`)).toEqual(["1000,10000-1100,10000", "1100,10000-1200,10000", "900,10000-1000,10000"]);
    for (const q of seams) {
      expect(q.a2.z).toBe(10100);
      expect(q.b2.z).toBe(10100);
      expect(q.tris).toHaveLength(2);
    }
  });

  it("stitches each such quad to the tile's ground: every 10 m on the edge, a 10 m band, then the far lattice outside, facing up", () => {
    const seams = outerSeams(t, { tileSizeM: 500, builtTile });
    const s = stitchStrip(seams, ground, t.colorSize);
    // Per seam: ten 10 m facets in the band (two triangles each) and one quad beyond it.
    expect(s.positions.length / 9).toBe(seams.length * (10 * 2 + 2));
    expect(s.colors.length / 4).toBe(s.positions.length / 3);
    const p = s.positions;
    const onEdge = new Set<number>();
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = [p[i]!, p[i + 1]!, p[i + 2]!];
      if (z === 10000) {
        // The inner side is the tile's ground, a hair below it.
        expect(y).toBeCloseTo(ground(x, z) - STITCH_SINK_M, 5);
        onEdge.add(x);
      } else {
        // Everything else lies on the far quad (a plane here: the far terrain is a slope in x).
        expect([10000 + STITCH_BAND_M, 10100]).toContain(z);
        expect(y).toBeCloseTo(farH(x, z), 4);
      }
    }
    expect([...onEdge].sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => 900 + i * 10));
    for (let i = 0; i < p.length; i += 9) {
      const a = new THREE.Vector3(p[i], p[i + 1], p[i + 2]);
      const n = new THREE.Vector3(p[i + 3], p[i + 4], p[i + 5]).sub(a).cross(new THREE.Vector3(p[i + 6], p[i + 7], p[i + 8]).sub(a));
      expect(n.y, "faces up").toBeGreaterThan(0);
    }
  });

  it("hides the replaced far quads: their triangles collapse to points", () => {
    const { geo: g2, matrix: m2 } = cell(farH);
    const t2 = farTerrain(g2, m2);
    const seams = outerSeams(t2, { tileSizeM: 500, builtTile });
    const tris = seams.flatMap((q) => q.tris);
    hideTriangles(g2, tris);
    const index = g2.getIndex()!;
    for (const tr of tris) expect(new Set([index.getX(3 * tr), index.getX(3 * tr + 1), index.getX(3 * tr + 2)]).size).toBe(1);
    // Every other triangle is untouched.
    const kept = t2.tris.filter((tr) => !tris.includes(tr.t));
    for (const tr of kept) expect(new Set([index.getX(3 * tr.t), index.getX(3 * tr.t + 1), index.getX(3 * tr.t + 2)]).size).toBe(3);
  });

  it("carries the land on past the far terrain's north and south ends, easing down, facing up", () => {
    const apron = farApron(t, 9800, 10200);
    const perEdge = (APRON_ROWS_M.length - 1) * 2 * 3;
    // Three rim edges at each end.
    expect(apron.positions.length / 3).toBe(6 * perEdge);
    expect(apron.colors.length / 4).toBe(6 * perEdge);
    const p = apron.positions;
    let maxSouth = -Infinity;
    let minNorth = Infinity;
    for (let i = 0; i < p.length; i += 9) {
      const a = new THREE.Vector3(p[i], p[i + 1], p[i + 2]);
      const b = new THREE.Vector3(p[i + 3], p[i + 4], p[i + 5]);
      const c = new THREE.Vector3(p[i + 6], p[i + 7], p[i + 8]);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      expect(n.y, "faces up").toBeGreaterThan(0);
      for (const v of [a, b, c]) {
        maxSouth = Math.max(maxSouth, v.z);
        minNorth = Math.min(minNorth, v.z);
        // Never above the edge it carries on from.
        expect(v.y).toBeLessThanOrEqual(farH(v.x, 0) + 1e-6);
      }
    }
    expect(maxSouth).toBe(10200 + APRON_ROWS_M[APRON_ROWS_M.length - 1]!);
    expect(minNorth).toBe(9800 - APRON_ROWS_M[APRON_ROWS_M.length - 1]!);
    // The first row is the edge itself.
    for (let i = 0; i < p.length; i += 3) if (p[i + 2] === 10200) expect(p[i + 1]).toBeCloseTo(farH(p[i]!, 0), 5);
  });
});
