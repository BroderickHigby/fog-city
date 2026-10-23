// The far layer's terrain (src/render/far-layer.ts): its lattice is found among the hulls, and
// the land at the far terrain's north and south ends carries on as an apron.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { APRON_ROWS_M, farApron, farTerrain, tileGrid, type FarTerrain } from "../../src/render/far-layer.ts";
import type { Manifest } from "../../src/render/types.ts";

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
describe("far layer tile grid", () => {
  it("one mask texel per manifest tile, from ix/iz or the bbox", () => {
    const m = {
      version: 1,
      world: "w",
      spawn: { x: 0, z: 0, heading: 0 },
      tiles: [
        { id: "t-2_3", ix: -2, iz: 3, collider: "", glb: null },
        { id: "t1_5", collider: "", glb: null, bbox: [500, 2500, 1000, 3000] },
      ],
    } as Manifest;
    const g = tileGrid(m);
    expect([g.ix0, g.iz0, g.nx, g.nz]).toEqual([-2, 3, 4, 3]);
    expect(g.index.get("t-2_3")).toBe(0);
    expect(g.index.get("t1_5")).toBe(2 * 4 + 3);
  });
});
