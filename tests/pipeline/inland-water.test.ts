// World QA W-11: the inland lakes are water at their own level, not dry land: the lattice samples
// inside each listed lake's NHD outline are lake samples (ground.cover digits) at the lake's level,
// no hydro-flattened surface is left as land, the pack's LAKE section says the same as the JSON,
// and the glb draws lake samples as water, never lawn.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { COVER_COLOURS, groundColour } from "../../pipeline/lib/mesh.ts";
import { PIER_Y_M } from "../../pipeline/lib/piers.ts";
import { readJson, ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSf, loadSfPack } from "./util.ts";
import type { BufferAttribute, BufferGeometry, Mesh } from "three";
import { Vector3 } from "three";

const { manifest, colliders } = loadSf();
const byTile = new Map(colliders.map((c) => [`${Math.round(c.ground.x0 / 500)},${Math.round(c.ground.z0 / 500)}`, c]));
type Ground = (typeof colliders)[number]["ground"] & { cover?: string; lakes?: Array<{ id: string; name: string; y: number }> };
/** A lattice sample: its tile ground and index, or null outside the world. */
function sample(x: number, z: number): { g: Ground; i: number } | null {
  const c = byTile.get(`${Math.floor(x / 500)},${Math.floor(z / 500)}`);
  if (!c) return null;
  const g = c.ground as Ground;
  return { g, i: Math.round((z - g.z0) / 10) * g.nx + Math.round((x - g.x0) / 10) };
}

describe("inland lakes (W-11)", () => {
  const { lakes } = readJson<{ lakes: Array<{ id: string; name: string; polygons: Array<Array<Array<[number, number]>>> }> }>("tests/pipeline/fixtures/world-qa/lakes.json");

  it("at least 90% of the lattice samples inside each lake's outline are that lake's water at its level", () => {
    const bad: string[] = [];
    let total = 0;
    for (const lake of lakes) {
      let n = 0, wet = 0;
      for (const poly of lake.polygons) {
        const outer = poly[0]! as P2[];
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of outer) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
        for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) {
          for (let z = Math.ceil(z0 / 10) * 10; z <= z1; z += 10) {
            if (!pointInRing(x, z, outer) || poly.slice(1).some((h) => pointInRing(x, z, h as P2[]))) continue;
            const s = sample(x, z);
            if (!s || s.g.water[s.i] === 1) continue;
            n++;
            const ch = s.g.cover?.[s.i];
            if (ch === undefined || !/[0-9]/.test(ch)) continue;
            const l = s.g.lakes?.[Number(ch)];
            if (l && l.id === lake.id && Math.abs(s.g.heights[s.i]! - l.y) < 0.005) wet++;
          }
        }
      }
      total += n;
      if (n >= 5 && wet / n < 0.9) bad.push(`${lake.name}: ${wet} of ${n}`);
    }
    expect(lakes.length).toBeGreaterThanOrEqual(25);
    expect(total).toBeGreaterThan(14_000);
    expect(bad).toEqual([]);
  });

  it("Lake Merced, Stow, Spreckels, Mountain Lake and the Palace of Fine Arts lagoon are water at their measured levels", () => {
    const want: Record<string, number> = { "Lake Merced (South Lake)": 5.25, "Stow Lake": 87, "Spreckels Lake": 40.9, "Mountain Lake": 41.66, "Palace of Fine Arts lagoon": 1.4 };
    const seen = new Map<string, number>();
    for (const c of colliders) for (const l of (c.ground as Ground).lakes ?? []) seen.set(l.name, l.y);
    for (const [name, y] of Object.entries(want)) expect(seen.get(name), name).toBeCloseTo(y, 1);
  });

  it("no hydro-flattened land of 0.5 ha or more is left: every flat basin the DEM flattened is a lake", () => {
    // Samples whose 4-neighbours all lie within 5 cm of them, not sea and not lake, grouped. Pier
    // decks (the lattice set to PIER_Y_M, W-13) are flat by construction. A hydro-flattened water
    // surface is a basin: within 30 m of it the ground never drops below its level, and stands
    // 0.3 m higher on at least a quarter of its rim (the flat pieces a tile border splits a lake
    // into border each other); a flat roof the DEM kept (a covered reservoir) or a flat fill lot by
    // the Bay drops away somewhere.
    const flat = new Set<string>();
    const heightAt = new Map<string, number>();
    for (const c of colliders) {
      const g = c.ground as Ground;
      for (let k = 1; k < g.nz - 1; k++) {
        for (let i = 1; i < g.nx - 1; i++) {
          const q = k * g.nx + i;
          heightAt.set(`${g.x0 + i * 10},${g.z0 + k * 10}`, g.heights[q]!);
          if (g.water[q] === 1 || /[0-9]/.test(g.cover?.[q] ?? "") || g.heights[q]! <= 0.5 || g.heights[q] === PIER_Y_M) continue;
          const h = g.heights[q]!;
          if ([q - 1, q + 1, q - g.nx, q + g.nx].every((o) => Math.abs(g.heights[o]! - h) <= 0.05 && g.water[o] === 0)) flat.add(`${g.x0 + i * 10},${g.z0 + k * 10}`);
        }
      }
    }
    const seen = new Set<string>();
    const regions: string[] = [];
    for (const start of flat) {
      if (seen.has(start)) continue;
      let n = 0;
      const stack = [start];
      seen.add(start);
      const level = heightAt.get(start)!;
      let rim = 0, higher = 0, lower = 0;
      while (stack.length) {
        const [x, z] = stack.pop()!.split(",").map(Number) as [number, number];
        n++;
        for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]] as const) {
          const k = `${x + dx},${z + dz}`;
          if (flat.has(k)) {
            if (!seen.has(k)) {
              seen.add(k);
              stack.push(k);
            }
            continue;
          }
          // The rim: up to 30 m straight out from the region (its first sample often still sits
          // at the water's edge, within a few centimetres of the level).
          const out = [1, 2, 3].map((m) => heightAt.get(`${x + dx * m},${z + dz * m}`)).filter((h): h is number => h !== undefined);
          if (out.length === 0) continue;
          rim++;
          if (Math.max(...out) > level + 0.3) higher++;
          if (Math.min(...out) < level - 0.1) lower++;
        }
      }
      if (n >= 50 && lower === 0 && higher >= 0.25 * rim) regions.push(`${start}: ${n} samples at ${level} m, rim ${higher} of ${rim} higher, none lower`);
    }
    expect(regions).toEqual([]);
  });

  it("the collider pack's LAKE section flags exactly the JSON's lake samples", () => {
    const { pack } = loadSfPack();
    let tiles = 0;
    for (const t of pack.tiles) {
      const json = byTile.get(`${t.ix},${t.iz}`)!.ground as Ground;
      const want = [...(json.cover ?? "")].map((ch) => (/[0-9]/.test(ch) ? 1 : 0));
      if (want.some((v) => v === 1)) {
        tiles++;
        expect(t.ground.lake, t.tileId).toEqual(want);
      } else expect(t.ground.lake, t.tileId).toBeUndefined();
    }
    expect(tiles).toBeGreaterThanOrEqual(15);
  });

  it("the ground mesh draws every lake sample in the water colour, never a grass colour", async () => {
    const water = groundColour(40, true, undefined);
    expect(groundColour(87, false, "0")).toEqual(water);
    const grass = groundColour(1, false, "g");
    expect(water.slice(0, 3)).not.toEqual(grass.slice(0, 3));
    const v = new Vector3();
    let checked = 0;
    for (const t of manifest.tiles) {
      const g = byTile.get(`${t.ix},${t.iz}`)!.ground as Ground;
      if (!g.cover || !/[0-9]/.test(g.cover)) continue;
      const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
      scene.updateMatrixWorld(true);
      const ground = scene.getObjectByName("ground") as Mesh<BufferGeometry>;
      const pos = ground.geometry.attributes.position as BufferAttribute;
      const col = ground.geometry.attributes.color as BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(ground.matrixWorld);
        const i = Math.round((v.z - g.z0) / 10) * g.nx + Math.round((v.x - g.x0) / 10);
        if (!/[0-9]/.test(g.cover[i]!)) continue;
        const rgb = [0, 1, 2].map((c) => Math.round(col.getComponent(k, c) * 255));
        expect(rgb, `${t.id} ${v.x},${v.z}`).toEqual(water.slice(0, 3));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(COVER_COLOURS.lake).toBeDefined();
  }, 120_000);
});
