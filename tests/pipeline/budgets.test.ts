// The shipped world's budgets (tests/pipeline/budgets.json). No network: committed files only.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";
import type { SfManifest } from "./util.ts";

interface Budget {
  tileGlbMaxBytes: number;
  tileColliderJsonMaxBytes: number;
  worldTotalMaxBytes: number;
  tileGlbTotalMaxBytes: number;
  tileColliderJsonTotalMaxBytes: number;
  bootColliderMaxBytes: number;
  farTotalMaxBytes: number;
  farMaxCells: number;
  farMaxTriangles: number;
  layerMaxBytes: number;
}

const budgets = readJson<{ worlds: Record<string, Budget> }>("tests/pipeline/budgets.json").worlds;

for (const [world, b] of Object.entries(budgets)) {
  describe(`budgets: ${world}`, () => {
    const dir = join(ROOT, "public/tiles", world);
    const m = readJson<SfManifest>(`public/tiles/${world}/manifest.json`);
    const size = (f: string): number => statSync(join(dir, f)).size;
    const mb = (n: number): string => `${(n / 1e6).toFixed(2)} MB`;

    it(`every tile glb is at most ${mb(b.tileGlbMaxBytes)}, and all of them at most ${mb(b.tileGlbTotalMaxBytes)}`, () => {
      let total = 0;
      for (const t of m.tiles) {
        const s = size(t.glb);
        expect(s, t.glb).toBeLessThanOrEqual(b.tileGlbMaxBytes);
        total += s;
      }
      expect(total).toBeLessThanOrEqual(b.tileGlbTotalMaxBytes);
    });

    it(`every tile collider JSON is at most ${mb(b.tileColliderJsonMaxBytes)}, and all of them at most ${mb(b.tileColliderJsonTotalMaxBytes)}`, () => {
      let total = 0;
      for (const t of m.tiles) {
        const s = size(t.collider);
        expect(s, t.collider).toBeLessThanOrEqual(b.tileColliderJsonMaxBytes);
        total += s;
      }
      expect(total).toBeLessThanOrEqual(b.tileColliderJsonTotalMaxBytes);
    });

    it(`the boot collider pack is at most ${mb(b.bootColliderMaxBytes)}`, () => {
      expect(m.worldColliders).toBeTruthy();
      expect(size(m.worldColliders)).toBeLessThanOrEqual(b.bootColliderMaxBytes);
    });

    it(`the far-LOD layer: at most ${b.farMaxCells} cells (draw calls), ${b.farMaxTriangles} triangles and ${mb(b.farTotalMaxBytes)}`, () => {
      expect(m.far.length).toBeGreaterThan(0);
      expect(m.far.length).toBeLessThanOrEqual(b.farMaxCells);
      expect(m.far.reduce((s, c) => s + c.stats.triangles!, 0)).toBeLessThanOrEqual(b.farMaxTriangles);
      expect(m.far.reduce((s, c) => s + size(c.glb), 0)).toBeLessThanOrEqual(b.farTotalMaxBytes);
    });

    it(`every data layer is at most ${mb(b.layerMaxBytes)}`, () => {
      for (const f of [m.roads, "storefronts.json", ...Object.values(m.layers ?? {})]) expect(size(f), f).toBeLessThanOrEqual(b.layerMaxBytes);
    });

    it(`the whole world directory is at most ${mb(b.worldTotalMaxBytes)}`, () => {
      let total = 0;
      for (const f of readdirSync(dir)) total += size(f);
      expect(total).toBeLessThanOrEqual(b.worldTotalMaxBytes);
    });
  });
}
