// W-09 and W-10: the drawn road and the ground disagreed (the car sank into the ribbon, the
// ground mesh poked through it). Road ribbons on the ground are now draped on the ground mesh's
// own triangles (pipeline/lib/mesh.ts drapePolygon), 2 cm over it; on a deck, in a bore
// or an underpass they follow the structure's surface. A triangle with its three corners
// within 10 cm of the ground is draped and must lie within 5 cm of it everywhere; no triangle
// (draped or not) may have the ground more than 2 cm over it outside a bore. Checked on the drawn GLB triangles
// of the tiles holding Filbert St, Twin Peaks Blvd and Kearny St, and every 12th tile.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { describe, expect, it, vi } from "vitest";
import { distToSegment } from "../../pipeline/lib/geom.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import { ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe("sf world: road ribbons lie on the ground (W-09, W-10)", () => {
  const { manifest, pack, roads } = loadSfPack();
  const g = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
  const tileOf = (x: number, z: number): string => `t${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
  const named = new Set<string>();
  for (const e of roads.edges) if (["Filbert St", "Twin Peaks Blvd", "Kearny St"].includes(e.name)) for (const [x, z] of e.points) named.add(tileOf(x, z));
  const tiles = manifest.tiles.filter((t, i) => named.has(t.id) || i % 12 === 0);
  // In a bore or an underpass the ground is over the road by design.
  const under = pack.tiles.flatMap((t) => t.tunnels ?? []);
  const inTunnel = (x: number, z: number): boolean =>
    under.some((u) => u.path.some((p, i) => i > 0 && distToSegment(x, z, [u.path[i - 1]![0], u.path[i - 1]![2]], [p[0], p[2]]).d <= p[3] / 2 + 1));

  it("on a 0.5 m grid over every ribbon triangle, the ground is never more than 2 cm above the ribbon; a draped ribbon is within 5 cm of the ground", async () => {
    expect(named.size).toBeGreaterThan(5);
    const v = [new Vector3(), new Vector3(), new Vector3()];
    const bad: string[] = [];
    let samples = 0;
    let draped = 0;
    for (const t of tiles) {
      const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
      scene.updateMatrixWorld(true);
      for (const name of ["roads", "freeways"]) {
        const node = scene.getObjectByName(name) as Mesh<BufferGeometry> | undefined;
        if (!node) continue;
        const pos = node.geometry.attributes.position as BufferAttribute;
        const idx = node.geometry.index!;
        for (let k = 0; k < idx.count; k += 3) {
          for (let j = 0; j < 3; j++) v[j]!.fromBufferAttribute(pos, idx.getX(k + j)).applyMatrix4(node.matrixWorld);
          const [a, b, c] = v as [Vector3, Vector3, Vector3];
          // A draped triangle has all three corners on the ground; a deck's or a ramp's stands off it.
          const off = (p: Vector3): number => {
            const h = g.meshHeightAt(p.x, p.z);
            return h === null ? Infinity : Math.abs(p.y - h);
          };
          const onGround = off(a) <= 0.1 && off(b) <= 0.1 && off(c) <= 0.1;
          const n = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 0.5));
          for (let p = 0; p <= n; p++) {
            for (let q = 0; q <= n - p; q++) {
              const u = p / n, w = q / n, r = 1 - u - w;
              const x = a.x * r + b.x * u + c.x * w;
              const y = a.y * r + b.y * u + c.y * w;
              const z = a.z * r + b.z * u + c.z * w;
              const h = g.meshHeightAt(x, z);
              if (h === null || (h > y && inTunnel(x, z))) continue;
              samples++;
              if (h > y + 0.02) bad.push(`${t.id} ${name} at ${x.toFixed(2)},${z.toFixed(2)}: ground ${(h - y).toFixed(3)} m over the road`);
              if (onGround) {
                draped++;
                if (y - h > 0.05) bad.push(`${t.id} ${name} at ${x.toFixed(2)},${z.toFixed(2)}: ${(y - h).toFixed(3)} m over the ground`);
              }
              if (bad.length > 20) break;
            }
          }
        }
      }
      if (bad.length > 20) break;
    }
    expect(samples).toBeGreaterThan(100_000);
    expect(draped).toBeGreaterThan(samples * 0.5);
    expect(bad.slice(0, 20)).toEqual([]);
  });
});
