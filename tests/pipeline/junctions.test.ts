// W-32: where streets met, their ribbons overlapped (and z-fought): 6.2% of the drawn road area
// was covered twice. Ribbons now stop at each junction's radius and one junction polygon covers
// the crossing (pipeline/lib/mesh.ts junctionPolygons). Checked on the drawn GLB triangles of the
// tiles holding Filbert St, Twin Peaks Blvd and Kearny St, and every 12th tile: road area (a
// 0.5 m raster, cell centres strictly inside a triangle) covered by two or more triangles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { describe, expect, it, vi } from "vitest";
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
