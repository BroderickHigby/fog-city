// Sidewalks for the sf tiles (W-45): a drawn band on every side where sidewalks.json has a
// sidewalk, from the street's kerb outwards, on the drawn ground, never over a road's centreline;
// and the streamer adds the bands to tiles whose roads come from their glb.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { tileId, tileIndexOf, toLocal } from "../../src/geo/project.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { makeDrawnGroundFn, makeGroundFn } from "../../src/render/ground.ts";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { createNightMaterials } from "../../src/render/props.ts";
import { SIDEWALK_LIFT_M, SIDEWALK_OUTER_M, sidewalkMesh, sidewalksByTile, type SidewalkGraph } from "../../src/render/sidewalks.ts";
import { TileStreamer } from "../../src/render/tile-streamer.ts";
import type { Manifest, RoadEdge, RoadGraph } from "../../src/render/types.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { ROOT, readJson, worldExists } from "../helpers.ts";

/** Is (x, z) inside any triangle of the mesh (seen from above)? Returns the triangle's height there, or null. */
function heightOver(m: { positions: Float32Array; indices: Uint32Array }, x: number, z: number): number | null {
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const ax = p[3 * a]!, az = p[3 * a + 2]!, bx = p[3 * b]!, bz = p[3 * b + 2]!, cx = p[3 * c]!, cz = p[3 * c + 2]!;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w = 1 - u - v;
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * p[3 * a + 1]! + v * p[3 * b + 1]! + w * p[3 * c + 1]!;
  }
  return null;
}

describe("sidewalk bands on a made-up street", () => {
  // A 10 m street along z = 0; its sidewalks 7 m either side (half width + 2 m), as the pipeline puts them.
  const road: RoadEdge = { id: "r", a: "A", b: "B", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[0, 0], [60, 0]] };
  const graph: SidewalkGraph = {
    nodes: [
      { id: "l0", x: 0, z: -7 },
      { id: "l1", x: 60, z: -7 },
      { id: "r0", x: 60, z: 7 },
      { id: "r1", x: 0, z: 7 },
      { id: "x0", x: 0, z: -7 },
    ],
    edges: [
      { id: "r.L", a: "l0", b: "l1", kind: "sidewalk", road: "r" },
      { id: "r.R", a: "r0", b: "r1", kind: "sidewalk", road: "r" },
      { id: "x", a: "x0", b: "r1", kind: "crossing", road: "r" },
    ],
  };
  const ground = (x: number, z: number): number => 3 + 0.05 * x + 0.01 * z;
  const lines = sidewalksByTile(graph).get("t0_-1")!.concat(sidewalksByTile(graph).get("t0_0") ?? []);

  it("draws both sidewalks (not the crossing) from the kerb to 1.5 m past the walk line, on the ground", () => {
    expect(lines.map((l) => l.id).sort()).toEqual(["r.L", "r.R"]);
    const m = sidewalkMesh(lines, new Map([["r", road]]), ground)!;
    for (const side of [-1, 1]) {
      for (const x of [1, 17.3, 30, 59]) {
        for (const off of [5.05, 6, 7, 8, 7 + SIDEWALK_OUTER_M - 0.05]) {
          const h = heightOver(m, x, side * off);
          expect(h, `${x},${side * off}`).not.toBeNull();
          expect(h!).toBeCloseTo(ground(x, side * off) + SIDEWALK_LIFT_M, 4);
        }
        // Not on the carriageway, not past the outer edge.
        expect(heightOver(m, x, side * 4.9)).toBeNull();
        expect(heightOver(m, x, side * (7 + SIDEWALK_OUTER_M + 0.1))).toBeNull();
      }
    }
    // Faces up.
    const p = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!].map((i) => new THREE.Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]));
      expect(b!.clone().sub(a!).cross(c!.clone().sub(a!)).y).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!worldExists("sf"))("sidewalks in the sf world (W-45)", () => {
  const graph = worldExists("sf") ? readJson<SidewalkGraph>("public/tiles/sf/sidewalks.json") : null;
  const roads = worldExists("sf") ? readJson<RoadGraph>("public/tiles/sf/roads.json") : null;
  const places: Array<[string, number, number]> = [
    ["Castro", 37.7609, -122.435],
    ["Outer Sunset", 37.7535, -122.4945],
    ["Mission", 37.7599, -122.4148],
    ["Financial District", 37.7935, -122.4005],
  ];

  it("a drawn band on every side where sidewalks.json has a sidewalk, never over a road's centreline", () => {
    const byTile = sidewalksByTile(graph!);
    const roadById = new Map(roads!.edges.map((e) => [e.id, e]));
    const manifest = readJson<{ tiles: Array<{ id: string; collider: string }> }>("public/tiles/sf/manifest.json");
    const files = new Map(manifest.tiles.map((t) => [t.id, t.collider]));
    for (const [name, lat, lon] of places) {
      const p = toLocal(lat, lon);
      const t = tileIndexOf(p.x, p.z);
      const id = tileId(t.ix, t.iz);
      const tiles: TileCollider[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const f = files.get(tileId(t.ix + dx, t.iz + dz));
        if (f) tiles.push(readJson<TileCollider>(`public/tiles/sf/${f}`));
      }
      const ground = makeDrawnGroundFn(tiles);
      const lines = byTile.get(id)!;
      expect(lines.length, name).toBeGreaterThan(40);
      const m = sidewalkMesh(lines, roadById, ground)!;
      let checked = 0;
      for (const l of lines) {
        // The walk line's middle vertex or segment midpoint, and a point 1 m towards its street.
        const k = Math.floor((l.points.length - 1) / 2);
        const a = l.points[k]!;
        const b = l.points[k + 1]!;
        const mx = (a[0] + b[0]) / 2;
        const mz = (a[1] + b[1]) / 2;
        const h = heightOver(m, mx, mz);
        expect(h, `${name}: sidewalk ${l.id} not drawn at ${mx.toFixed(1)},${mz.toFixed(1)}`).not.toBeNull();
        expect(h!).toBeCloseTo(ground(mx, mz) + SIDEWALK_LIFT_M, 1);
        checked++;
      }
      // No band covers a road's centreline (sampled every 2 m), carriageways' own ribbons show there.
      let onCentre = 0;
      let samples = 0;
      for (const e of roads!.edges) {
        if (e.pedestrian || e.points.length < 2) continue;
        const mid = e.points[Math.floor(e.points.length / 2)]!;
        if (Math.floor(mid[0] / 500) !== t.ix || Math.floor(mid[1] / 500) !== t.iz) continue;
        for (let i = 1; i < e.points.length; i++) {
          const [ax, az] = e.points[i - 1]!;
          const [bx, bz] = e.points[i]!;
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
          for (let s = 0; s <= n; s++) {
            samples++;
            if (heightOver(m, ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n) !== null) onCentre++;
          }
        }
      }
      expect(checked).toBe(lines.length);
      expect(samples, name).toBeGreaterThan(200);
      // A band's cut end can reach a crossing street's centre where the graph's piece stops 0.5 m off its kerb.
      expect(onCentre / samples, `${name}: centreline samples under a band`).toBeLessThan(0.01);
    }
  }, 120_000);

  it("the streamer adds the bands to a glb tile once the graph arrives", async () => {
    const full = readJson<Manifest>("public/tiles/sf/manifest.json");
    const p = toLocal(37.7609, -122.435);
    const ti = tileIndexOf(p.x, p.z);
    const id = tileId(ti.ix, ti.iz);
    const manifest: Manifest = { ...full, tiles: full.tiles.filter((t) => t.id === id) };
    const collider = readJson<TileCollider>(`public/tiles/sf/${manifest.tiles[0]!.collider}`);
    const loader = createTileLoader();
    const parent = new THREE.Group();
    const s = new TileStreamer({
      parent,
      manifest,
      base: "",
      colliders: new Map([[id, collider]]),
      roads: roads!,
      ground: makeGroundFn([collider]),
      materials: createSharedMaterials(),
      night: createNightMaterials(),
      radius: 5000,
      loadGltf: async (url): Promise<GLTF> => {
        const b = readFileSync(join(ROOT, "public/tiles/sf", url));
        return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
      },
    });
    for (let i = 0; i < 2000 && !(i > 0 && s.settled()); i++) {
      s.update(p.x, p.z, 50);
      await new Promise((r) => setTimeout(r, 0));
    }
    const tile = parent.getObjectByName(`tile:${id}`)!;
    expect(tile.getObjectByName("sidewalks")).toBeUndefined();
    s.setSidewalks(graph);
    const band = tile.getObjectByName("sidewalks") as THREE.Mesh;
    expect(band).toBeTruthy();
    expect(band.geometry.getIndex()!.count / 3).toBeGreaterThan(1000);
    s.dispose();
  }, 120_000);
});
