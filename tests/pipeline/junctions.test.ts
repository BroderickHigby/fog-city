// W-32: where streets met, their ribbons overlapped (and z-fought): 6.2% of the drawn road area
// was covered twice. Each ribbon now stops where it clears the other streets' ribbons and the
// junction polygon, and one junction polygon covers the crossing (pipeline/lib/mesh.ts
// junctionRadii, junctionPolygons). Checked on the drawn GLB triangles of the tiles holding
// Filbert St, Twin Peaks Blvd and Kearny St, and every 12th tile: road area (a 0.5 m raster,
// cell centres strictly inside a triangle) covered by two or more triangles. On made-up
// junctions (acute forks, a skewed T, a curved approach), the trimmed ribbons and the junction
// polygon also cover everything the untrimmed ribbons did: trimming leaves no holes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { describe, expect, it, vi } from "vitest";
import type { P2 } from "../../pipeline/lib/geom.ts";
import { junctionPolygons, junctionRadii, roadMeshes, type MeshData } from "../../pipeline/lib/mesh.ts";
import type { RoadEdge } from "../../pipeline/lib/roads.ts";
import { Ground, GROUND_CELL_M } from "../../pipeline/lib/terrain.ts";
import { ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe("sf world: junctions (W-32)", () => {
  const { manifest, roads } = loadSfPack();
  const tileOf = (x: number, z: number): string => `t${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
  const named = new Set<string>();
  for (const e of roads.edges) if (["Filbert St", "Twin Peaks Blvd", "Kearny St"].includes(e.name)) for (const [x, z] of e.points) named.add(tileOf(x, z));
  const tiles = manifest.tiles.filter((t, i) => named.has(t.id) || i % 12 === 0);

  it("at most 0.5% of the drawn street area is covered by two ribbons at once", async () => {
    let covered = 0;
    let double = 0;
    const v = [new Vector3(), new Vector3(), new Vector3()];
    for (const t of tiles) {
      const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
      scene.updateMatrixWorld(true);
      const node = scene.getObjectByName("roads") as Mesh<BufferGeometry> | undefined;
      if (!node) continue;
      const pos = node.geometry.attributes.position as BufferAttribute;
      const idx = node.geometry.index!;
      const [x0, z0] = t.bbox;
      const counts = new Uint8Array(1000 * 1000);
      for (let k = 0; k < idx.count; k += 3) {
        for (let j = 0; j < 3; j++) v[j]!.fromBufferAttribute(pos, idx.getX(k + j)).applyMatrix4(node.matrixWorld);
        const [a, b, c] = v as [Vector3, Vector3, Vector3];
        const den = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(den) < 1e-9) continue;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) * 2)), i1 = Math.min(999, Math.floor((Math.max(a.x, b.x, c.x) - x0) * 2));
        const k0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) * 2)), k1 = Math.min(999, Math.floor((Math.max(a.z, b.z, c.z) - z0) * 2));
        for (let kk = k0; kk <= k1; kk++) {
          for (let ii = i0; ii <= i1; ii++) {
            const x = x0 + (ii + 0.5) / 2, z = z0 + (kk + 0.5) / 2;
            const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / den;
            const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / den;
            if (l1 <= 1e-7 || l2 <= 1e-7 || 1 - l1 - l2 <= 1e-7) continue;
            const q = kk * 1000 + ii;
            if (counts[q]! < 255) counts[q] = counts[q]! + 1;
          }
        }
      }
      for (let q = 0; q < counts.length; q++) {
        if (counts[q]! >= 1) covered++;
        if (counts[q]! >= 2) double++;
      }
    }
    expect(covered).toBeGreaterThan(200_000);
    expect(double / covered).toBeLessThanOrEqual(0.005);
  });
});

describe("junction trims on made-up junctions (W-32)", () => {
  const n = 500 / GROUND_CELL_M + 1;
  // A gentle slope, so ribbons are drawn whole on it.
  const heights = Array.from({ length: n * n }, (_, i) => (i % n) * 0.2);
  const ground = new Ground([{ ix: 0, iz: 0, field: { x0: 0, z0: 0, cellSizeM: GROUND_CELL_M, nx: n, nz: n, heights, water: new Array<number>(n * n).fill(0) } }]);
  const tile = { id: "t0_0", ix: 0, iz: 0, bbox: [0, 0, 500, 500] as [number, number, number, number] };
  let ids = 0;
  const street = (a: string, b: string, points: P2[], widthM: number): RoadEdge => ({
    id: `e${ids++}`, a, b, kind: "residential", lanes: 2, oneway: false, widthM, speedLimitMps: 11, name: "Test St", points, cnn: "0", classcode: 5,
  });
  /** A street from the node at (cx, cz) on compass bearing `deg` (0 = north, -z), `len` metres long. */
  const spoke = (node: string, cx: number, cz: number, deg: number, widthM: number, len = 120, bend = 0): RoadEdge => {
    const pts: P2[] = [[cx, cz]];
    let h = (deg * Math.PI) / 180, x = cx, z = cz;
    for (let s = 4; s <= len; s += 4) {
      h += (bend * Math.PI) / 180;
      x += Math.sin(h) * 4;
      z -= Math.cos(h) * 4;
      pts.push([x, z]);
    }
    return street(node, `${node}-${ids}`, pts, widthM);
  };
  const junctionsOf = (edges: RoadEdge[]): RoadEdge[] => edges;
  const cases: Array<[string, RoadEdge[]]> = [
    ["an acute fork", junctionsOf([spoke("y", 250, 250, 0, 11), spoke("y", 250, 250, 25, 7.8), spoke("y", 250, 250, 180, 11)])],
    ["a skewed T", junctionsOf([spoke("t", 250, 250, 90, 11), spoke("t", 250, 250, 270, 11), spoke("t", 250, 250, 30, 7.8)])],
    ["a curved approach to a crossing", junctionsOf([spoke("x", 250, 250, 0, 11, 120, 3), spoke("x", 250, 250, 90, 11), spoke("x", 250, 250, 180, 7.8), spoke("x", 250, 250, 270, 11, 120, -2)])],
    ["a five-way junction", junctionsOf([0, 50, 120, 200, 290].map((d, i) => spoke("f", 250, 250, d, i % 2 ? 7.8 : 11)))],
  ];
  /** Cells of a 0.25 m raster (sample points off the lattice) covered by each mesh, counted. */
  const raster = (meshes: MeshData[]): Uint8Array => {
    const counts = new Uint8Array(2000 * 2000);
    for (const m of meshes) {
      const P = m.positions, I = m.indices;
      for (let k = 0; k < I.length; k += 3) {
        const a = [P[I[k]! * 3]!, P[I[k]! * 3 + 2]!], b = [P[I[k + 1]! * 3]!, P[I[k + 1]! * 3 + 2]!], c = [P[I[k + 2]! * 3]!, P[I[k + 2]! * 3 + 2]!];
        const den = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!);
        if (Math.abs(den) < 1e-9) continue;
        const i0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!) * 4)), i1 = Math.min(1999, Math.floor(Math.max(a[0]!, b[0]!, c[0]!) * 4));
        const k0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!) * 4)), k1 = Math.min(1999, Math.floor(Math.max(a[1]!, b[1]!, c[1]!) * 4));
        for (let kk = k0; kk <= k1; kk++) {
          for (let ii = i0; ii <= i1; ii++) {
            const x = (ii + 0.5) / 4 + 0.0123, z = (kk + 0.5) / 4 + 0.0087;
            const l1 = ((b[1]! - c[1]!) * (x - c[0]!) + (c[0]! - b[0]!) * (z - c[1]!)) / den;
            const l2 = ((c[1]! - a[1]!) * (x - c[0]!) + (a[0]! - c[0]!) * (z - c[1]!)) / den;
            if (l1 <= 0 || l2 <= 0 || 1 - l1 - l2 <= 0) continue;
            const q = kk * 2000 + ii;
            if (counts[q]! < 255) counts[q] = counts[q]! + 1;
          }
        }
      }
    }
    return counts;
  };

  for (const [name, edges] of cases) {
    it(`${name}: the ribbons stop short of the node, cover it once with the junction polygon, and leave no hole`, () => {
      const radii = junctionRadii(edges);
      const nodes = new Map([[edges[0]!.a, { x: 250, z: 250 }]]);
      const polys = [...junctionPolygons(edges, radii, nodes).values()];
      expect(polys).toHaveLength(1);
      for (const e of edges) expect(radii.get(`${e.id}|a`), e.id).toBeGreaterThan(0);
      const drawn = raster([...edges.map((e) => roadMeshes([e], tile, ground, () => null, radii, [], new Map()).roads), roadMeshes([], tile, ground, () => null, radii, polys, new Map()).roads]);
      const bare = raster(edges.map((e) => roadMeshes([e], tile, ground, () => null, new Map(), [], new Map()).roads));
      let covered = 0, double = 0, road = 0, holes = 0, bareDouble = 0;
      for (let q = 0; q < drawn.length; q++) {
        if (drawn[q]! >= 1) covered++;
        if (drawn[q]! >= 2) double++;
        if (bare[q]! >= 1) road++;
        if (bare[q]! >= 2) bareDouble++;
        if (bare[q]! >= 1 && drawn[q] === 0) holes++;
      }
      expect(bareDouble, "the untrimmed ribbons overlap at the node").toBeGreaterThan(200);
      expect(double / covered).toBeLessThanOrEqual(0.002);
      expect(holes / road).toBeLessThanOrEqual(0.0005);
    });
  }
});
