// World QA W-18 and W-34: the ground has classes. Rec and Park land is grass or forest, beaches
// are sand (and never lawn), the parks the QA report found bare have trees (instanced foliage
// nodes) over their canopy, and the glb's ground colours follow the classes.
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, EXTMeshoptCompression, KHRMeshQuantization, type InstancedMesh } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import { pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { readJson, ROOT } from "../helpers.ts";
import { loadSf } from "./util.ts";

const { manifest, colliders } = loadSf();
type Ground = (typeof colliders)[number]["ground"] & { cover?: string };
const byTile = new Map(colliders.map((c) => [`${Math.round(c.ground.x0 / 500)},${Math.round(c.ground.z0 / 500)}`, c.ground as Ground]));
const at = (x: number, z: number): { cls: string; h: number; water: boolean } | null => {
  const g = byTile.get(`${Math.floor(x / 500)},${Math.floor(z / 500)}`);
  if (!g?.cover) return null;
  const i = Math.round((z - g.z0) / 10) * g.nx + Math.round((x - g.x0) / 10);
  return { cls: g.cover[i]!, h: g.heights[i]!, water: g.water[i] === 1 };
};

describe("ground classes (W-18, W-34)", () => {
  const { parks } = readJson<{ parks: Array<{ id: string; name: string; type: string; polygons: Array<Array<Array<[number, number]>>> }> }>("tests/pipeline/fixtures/world-qa/parks.json");

  it("every sample has a class; urban, grass, forest, sand, sea and lakes all occur", () => {
    const counts: Record<string, number> = {};
    for (const c of colliders) {
      const g = c.ground as Ground;
      expect(g.cover?.length, c.tileId).toBe(g.heights.length);
      for (let i = 0; i < g.cover!.length; i++) {
        const ch = g.cover![i]!;
        counts[/[0-9]/.test(ch) ? "lake" : ch] = (counts[/[0-9]/.test(ch) ? "lake" : ch] ?? 0) + 1;
        expect(ch === "w", `${c.tileId} sample ${i}`).toBe(g.water[i] === 1);
      }
    }
    for (const k of ["u", "g", "f", "s", "w", "lake"]) expect(counts[k] ?? 0, k).toBeGreaterThan(5000);
  });

  it("at least 90% of Rec and Park land is grass or forest, and no property with 10 samples or more is under 10% green", () => {
    let land = 0, green = 0;
    const bare: string[] = [];
    for (const p of parks) {
      let n = 0, g = 0;
      for (const poly of p.polygons) {
        const outer = poly[0]! as P2[];
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of outer) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
        for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) {
          for (let z = Math.ceil(z0 / 10) * 10; z <= z1; z += 10) {
            if (!pointInRing(x, z, outer) || poly.slice(1).some((h) => pointInRing(x, z, h as P2[]))) continue;
            const s = at(x, z);
            if (!s || s.water || /[0-9]/.test(s.cls) || s.cls === "s") continue;
            n++;
            if (s.cls === "g" || s.cls === "f") g++;
          }
        }
      }
      land += n;
      green += g;
      if (n >= 10 && g / n < 0.1) bare.push(`${p.name}: ${g} of ${n}`);
    }
    expect(land).toBeGreaterThan(100_000);
    expect(green / land).toBeGreaterThanOrEqual(0.9);
    expect(bare).toEqual([]);
  });

  it("at least 90% of Ocean Beach, Baker Beach, China Beach and the Crissy Field beach is sand", () => {
    // Ocean Beach: each 10 m row's westernmost land samples (within 40 m of the shoreline, below 12 m).
    let n = 0, sand = 0;
    const north = toLocal(37.778, -122.51), south = toLocal(37.735, -122.51);
    for (let z = Math.ceil(north.z / 10) * 10; z <= south.z; z += 10) {
      let shore: number | null = null;
      for (let x = -11000; x < -9000; x += 10) {
        const s = at(x, z);
        if (s && !s.water) {
          shore = x;
          break;
        }
      }
      if (shore === null) continue;
      for (let x = shore; x <= shore + 40; x += 10) {
        const s = at(x, z);
        if (!s || s.water || s.h > 12) continue;
        n++;
        if (s.cls === "s") sand++;
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(sand / n, "Ocean Beach").toBeGreaterThanOrEqual(0.9);
    // The coves: land samples beside the water (one sample away), below 4 m, in each box.
    for (const [name, [la0, lo0, la1, lo1]] of Object.entries<[number, number, number, number]>({
      "Baker Beach": [37.799, -122.488, 37.787, -122.48],
      "China Beach": [37.7895, -122.4935, 37.787, -122.4895],
      "Crissy Field beach": [37.8105, -122.475, 37.803, -122.447],
    })) {
      const a = toLocal(la0, lo0), b = toLocal(la1, lo1);
      let m = 0, s = 0;
      for (let x = Math.ceil(a.x / 10) * 10; x <= b.x; x += 10) {
        for (let z = Math.ceil(a.z / 10) * 10; z <= b.z; z += 10) {
          const q = at(x, z);
          if (!q || q.water || /[0-9]/.test(q.cls) || q.h > 4) continue;
          if (![[10, 0], [-10, 0], [0, 10], [0, -10]].some(([dx, dz]) => at(x + dx!, z + dz!)?.water)) continue;
          m++;
          if (q.cls === "s") s++;
        }
      }
      expect(m, name).toBeGreaterThan(5);
      expect(s / m, name).toBeGreaterThanOrEqual(0.9);
    }
  });

  describe("foliage (W-18)", () => {
    const trees = new Map<string, Array<[number, number]>>();
    /** Every tree's base, [x, y, z] in world metres, by tile. */
    const bases = new Map<string, Array<[number, number, number]>>();
    beforeAll(async () => {
      await MeshoptDecoder.ready;
      const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, EXTMeshGPUInstancing]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
      for (const t of manifest.tiles) {
        const doc = await io.readBinary(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
        const list: Array<[number, number]> = [];
        const feet: Array<[number, number, number]> = [];
        for (const node of doc.getRoot().listNodes()) {
          const inst = node.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
          if (!inst) continue;
          expect(node.getName()).toMatch(/^foliage-(broadleaf|conifer)$/);
          const tr = inst.getAttribute("TRANSLATION")!;
          const [cx, cy, cz] = node.getTranslation();
          const el = [0, 0, 0];
          for (let i = 0; i < tr.getCount(); i++) {
            tr.getElement(i, el);
            list.push([el[0]! + cx, el[2]! + cz]);
            feet.push([el[0]! + cx, el[1]! + cy, el[2]! + cz]);
          }
        }
        if (list.length) trees.set(t.id, list);
        if (feet.length) bases.set(t.id, feet);
      }
    }, 300_000);

    const PARKS: Record<string, [number, number]> = {
      "Golden Gate Park": [37.7694, -122.4862],
      Presidio: [37.7989, -122.4662],
      "McLaren Park": [37.7186, -122.4196],
      "Lincoln Park": [37.7846, -122.5005],
      "Buena Vista Park": [37.7684, -122.4411],
      "Glen Canyon": [37.7403, -122.4419],
      "Sutro Forest": [37.7585, -122.456],
      "Mount Davidson": [37.7385, -122.4545],
    };

    it("every listed park's tile has trees, and its forest is within 30 m of one at least 85% of the time", () => {
      expect([...trees.values()].reduce((s, l) => s + l.length, 0)).toBeGreaterThan(50_000);
      for (const [name, [lat, lon]] of Object.entries(PARKS)) {
        const p = toLocal(lat, lon);
        const id = `t${Math.floor(p.x / 500)}_${Math.floor(p.z / 500)}`;
        expect(trees.get(id)?.length ?? 0, `${name} (${id})`).toBeGreaterThan(20);
        // Forest samples of the tile and its neighbours against the trees drawn there.
        const [ix, iz] = [Math.floor(p.x / 500), Math.floor(p.z / 500)];
        const near: Array<[number, number]> = [];
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) near.push(...(trees.get(`t${ix + dx}_${iz + dz}`) ?? []));
        const g = byTile.get(`${ix},${iz}`)!;
        let forest = 0, far = 0;
        for (let i = 0; i < g.cover!.length; i++) {
          if (g.cover![i] !== "f") continue;
          forest++;
          const x = g.x0 + (i % g.nx) * 10, z = g.z0 + Math.floor(i / g.nx) * 10;
          if (!near.some(([tx, tz]) => (tx - x) ** 2 + (tz - z) ** 2 <= 900)) far++;
        }
        if (forest > 0) expect(far / forest, name).toBeLessThan(0.15);
      }
    });

    it("no tree stands in a building or on a road ribbon", () => {
      const { roads } = loadSf();
      const segs = roads.edges.flatMap((e) => e.points.slice(1).map((b, i) => [e.points[i]!, b, e.widthM / 2] as const));
      const cells = new Map<string, Array<(typeof segs)[number]>>();
      for (const s of segs) {
        const [a, b] = s;
        for (let cx = Math.floor((Math.min(a[0], b[0]) - 20) / 50); cx <= Math.floor((Math.max(a[0], b[0]) + 20) / 50); cx++) {
          for (let cz = Math.floor((Math.min(a[1], b[1]) - 20) / 50); cz <= Math.floor((Math.max(a[1], b[1]) + 20) / 50); cz++) (cells.get(`${cx},${cz}`) ?? cells.set(`${cx},${cz}`, []).get(`${cx},${cz}`)!).push(s);
        }
      }
      const onRoad: string[] = [];
      const inBuilding: string[] = [];
      for (const c of colliders) {
        for (const [x, z] of trees.get(c.tileId) ?? []) {
          for (const [a, b, hw] of cells.get(`${Math.floor(x / 50)},${Math.floor(z / 50)}`) ?? []) {
            const ex = b[0] - a[0], ez = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
            if (Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t) < hw + 0.5) {
              onRoad.push(`${c.tileId} ${x},${z}`);
              break;
            }
          }
          if (c.buildings.some((b) => pointInRing(x, z, b.footprint as P2[]))) inBuilding.push(`${c.tileId} ${x},${z}`);
        }
      }
      expect(onRoad.slice(0, 10)).toEqual([]);
      expect(inBuilding.slice(0, 10)).toEqual([]);
    }, 120_000);

    it("every tree stands on the drawn ground: its base within 0.3 m below it, never above it", () => {
      // The drawn ground: the tile's lattice in planar triangles split along the (i+1, k)-(i, k+1)
      // diagonal, exactly as the glb's ground mesh is built (not the bilinear surface, which
      // differs by up to a metre or two in steep twisted cells). A tree's base is sunk 0.15 m.
      const drawn = (g: Ground, x: number, z: number): number => {
        const fx = (x - g.x0) / 10, fz = (z - g.z0) / 10;
        const i = Math.min(Math.floor(fx), g.nx - 2), k = Math.min(Math.floor(fz), g.nz - 2);
        const tx = fx - i, tz = fz - k;
        const h = (a: number, b: number): number => g.heights[(k + b) * g.nx + i + a]!;
        if (tx + tz <= 1) return h(0, 0) + (h(1, 0) - h(0, 0)) * tx + (h(0, 1) - h(0, 0)) * tz;
        return h(1, 1) + (h(0, 1) - h(1, 1)) * (1 - tx) + (h(1, 0) - h(1, 1)) * (1 - tz);
      };
      let n = 0;
      const off: string[] = [];
      for (const c of colliders) {
        const g = c.ground as Ground;
        for (const [x, y, z] of bases.get(c.tileId) ?? []) {
          n++;
          const d = y - drawn(g, x, z);
          if (d > 0.02 || d < -0.3) off.push(`${c.tileId} ${x.toFixed(2)},${z.toFixed(2)}: ${d.toFixed(2)} m`);
        }
      }
      expect(n).toBeGreaterThan(50_000);
      expect(off.slice(0, 10)).toEqual([]);
    });
  });
});
