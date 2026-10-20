// The committed sf GLB tiles: valid glTF, loadable by three.js, consistent with the colliders.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSf, validateGlb } from "./util.ts";

const DIR = join(ROOT, "public/tiles/sf");
const { manifest, colliders } = loadSf();

describe("sf GLB tiles", () => {
  it("every tile passes the Khronos glTF validator with no errors or warnings", async () => {
    for (const t of manifest.tiles) {
      const r = await validateGlb(new Uint8Array(readFileSync(join(DIR, t.glb))));
      expect(r.messages, t.glb).toEqual([]);
      expect(r.errors + r.warnings, t.glb).toBe(0);
    }
  });

  it("every tile loads in three.js; meshes sit inside the tile; building ranges match the collider", async () => {
    for (const [i, t] of manifest.tiles.entries()) {
      const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(DIR, t.glb))));
      expect(scene.userData).toMatchObject({ world: "sf", tile: t.id });
      type Attr = { count: number; getX(i: number): number; getZ(i: number): number };
      const ground = scene.getObjectByName("ground") as unknown as { geometry: { attributes: Record<string, Attr> } };
      expect(ground, t.id).toBeDefined();
      expect(ground.geometry.attributes.normal).toBeDefined();
      // Ground vertices lie on the tile's 10 m lattice, inside its bbox. (Attributes are
      // interleaved in the GLB, so read through the accessor, not .array.)
      const p = ground.geometry.attributes.position!;
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k);
        const z = p.getZ(k);
        expect(x >= t.bbox[0] && x <= t.bbox[2] && z >= t.bbox[1] && z <= t.bbox[3] && x % 10 === 0 && z % 10 === 0, `${t.id} ${x},${z}`).toBe(true);
      }
      const ids = colliders[i]!.buildings.map((b) => b.id);
      const node = scene.getObjectByName("buildings");
      if (ids.length === 0) {
        expect(node).toBeUndefined();
        continue;
      }
      const ranges = node!.userData.buildings as Array<[string, number, number]>;
      expect(ranges.map((r) => r[0])).toEqual(ids);
      const geo = (node as unknown as { geometry: { index: { count: number }; attributes: Record<string, unknown> } }).geometry;
      const last = ranges[ranges.length - 1]!;
      expect(last[1] + last[2]).toBe(geo.index.count);
      expect(Object.keys(geo.attributes).sort()).toEqual(["_facade", "color", "position", "uv"]);
    }
  });
});
