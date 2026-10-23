// World QA W-11: the inland lakes are water at their own level, not dry land: the lattice samples
// inside each listed lake's NHD outline are lake samples (ground.cover digits) at the lake's level,
// no hydro-flattened surface is left as land, the pack's LAKE section says the same as the JSON,
// and the glb draws lake samples as water, never lawn. The sim half: boundary.json rings every
// lake with a shore line tagged with it, so the sim's shore walls stop a car at the bank, as at
// the Bay: the QA's drive across South Lake Merced (C4, 625 m on the water) stops at the shore.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { COVER_COLOURS, groundColour } from "../../pipeline/lib/mesh.ts";
import { PIER_Y_M } from "../../pipeline/lib/piers.ts";
import { readJson, ROOT } from "../helpers.ts";
import { toLocal } from "../../src/geo/project.ts";
import { buildWorld, makeCar, onWater, stepCar, type BoundaryFile, type RoadsFile, type TileCollider } from "../../src/sim/index.ts";
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

  const boundary = readJson<BoundaryFile & { shore: Array<{ closed: boolean; points: P2[]; lake?: string }> }>("public/tiles/sf/boundary.json");

  it("boundary.json rings every lake with a closed shore line tagged with it, water on its right", () => {
    const report = readJson<{ landcover: { lakes: Array<{ id: string; name: string; samples: number }> } }>("public/tiles/sf/report.json");
    const rings = new Map<string, number>();
    for (const l of boundary.shore) if (l.lake !== undefined) rings.set(l.lake, (rings.get(l.lake) ?? 0) + 1);
    // Every lake of 20 samples or more (0.2 ha) has its ring, unless its water meets the sea's
    // (then the sea's line goes round it): the Crissy Field marsh and the India Basin pond.
    const missing = report.landcover.lakes.filter((l) => l.samples >= 20 && !rings.has(l.id)).map((l) => l.name);
    expect(missing.filter((n) => !/Crissy Field marsh|India Basin pond/.test(n))).toEqual([]);
    expect(rings.size).toBeGreaterThanOrEqual(20);
    for (const name of ["Lake Merced (North Lake)", "Lake Merced (South Lake)", "Stow Lake", "Spreckels Lake", "Pine Lake", "Mountain Lake", "Palace of Fine Arts lagoon", "Laguna Honda Reservoir"]) {
      const l = report.landcover.lakes.find((q) => q.name === name)!;
      expect(rings.has(l.id), name).toBe(true);
    }
    // Land on the left of travel, the lake's water on the right (probed 6 m either side).
    let agree = 0, total = 0;
    for (const l of boundary.shore) {
      if (l.lake === undefined) continue;
      expect(l.closed, l.lake).toBe(true);
      const pts = [...l.points, l.points[0]!];
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 8) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, ux = (bx - ax) / len, uz = (bz - az) / len;
        const lakeAt = (x: number, z: number): boolean => {
          const q = sample(Math.round(x / 10) * 10, Math.round(z / 10) * 10);
          return !!q && /[0-9]/.test(q.g.cover?.[q.i] ?? "");
        };
        total++;
        if (!lakeAt(mx + uz * 6, mz - ux * 6) && lakeAt(mx - uz * 6, mz + ux * 6)) agree++;
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(agree / total).toBeGreaterThan(0.9);
  });

  it("a car driven from the bank across South Lake Merced (the QA's C4) stops at the shore and never gets onto the water", () => {
    // The game's world round the lake: the tiles within 1.5 km, the whole road graph, the boundary.
    const mid = toLocal(37.719, -122.496);
    const near = colliders.filter((c) => Math.abs(c.ground.x0 + 250 - mid.x) < 1500 && Math.abs(c.ground.z0 + 250 - mid.z) < 1500);
    const roads = readJson<RoadsFile>("public/tiles/sf/roads.json");
    const world = buildWorld(near as unknown as TileCollider[], roads, boundary);
    const shore = world.walls!.shore;
    // Along z = 37.719: the South Lake's east and west banks, by the lattice.
    const isLake = (x: number): boolean => {
      const q = sample(Math.round(x / 10) * 10, Math.round(mid.z / 10) * 10);
      return !!q && /[0-9]/.test(q.g.cover?.[q.i] ?? "");
    };
    expect(isLake(mid.x), "the QA's point is on the lake").toBe(true);
    let east = mid.x, west = mid.x;
    while (isLake(east + 10)) east += 10;
    while (isLake(west - 10)) west -= 10;
    expect(east - west, "the lake is hundreds of metres across here").toBeGreaterThan(300);
    for (const [name, x0, heading] of [["from the east bank, west", east + 35, (3 * Math.PI) / 2], ["from the west bank, east", west - 35, Math.PI / 2]] as const) {
      let c = makeCar(x0, mid.z, heading);
      expect(onWater(shore, c.x, c.z), `${name}: starts on land`).toBe(false);
      let wet = 0, maxRun = 0;
      for (let t = 0; t < 900; t++) {
        c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
        if (onWater(shore, c.x, c.z)) wet++;
        maxRun = Math.max(maxRun, Math.abs(c.x - x0));
      }
      expect(wet, `${name}: ticks with the car's centre on the water`).toBe(0);
      // It reached the bank (it was not stopped by something else first) and went no further.
      expect(maxRun, `${name}: distance driven`).toBeGreaterThan(25);
      expect(maxRun, `${name}: distance driven`).toBeLessThan(50);
    }
  }, 120_000);
});
