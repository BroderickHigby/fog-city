// The ground beyond the pipeline's mesh (src/render/ground-extras.ts, wired by the streamer):
//  - W-11: inland lakes drawn as water at their level, covering the lake samples;
//  - W-18 / W-34: the renderer leaves the pipeline's ground-class colours alone (no district tint
//    turns a lake or a beach into lawn) and draws the foliage nodes as instanced trees;
//  - W-17 / W-40 (render half): skirts under every land border of a streamed tile, and at the
//    three worst near/far borders of the QA report no probe or ray from the streamed side finds the
//    sea through the ring, and the half-metre slit between the near edge and the far terrain
//    (seen from over the far side, where the streamed set has a notch) is closed by the skirt alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { tileId, tileIndexOf, toLocal } from "../../src/geo/project.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { LAKE_LIFT_M, SKIRT_DEPTH_M, groundSkirt, lakeMask, lakeSurface, type CoverHeightfield } from "../../src/render/ground-extras.ts";
import { makeGroundFn } from "../../src/render/ground.ts";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { createNightMaterials } from "../../src/render/props.ts";
import { TileStreamer } from "../../src/render/tile-streamer.ts";
import type { Manifest } from "../../src/render/types.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { ROOT, readJson, worldExists } from "../helpers.ts";

const SF = worldExists("sf");
const loader = createTileLoader();
const sfColliders = new Map<string, TileCollider>();
const collider = (id: string): TileCollider => {
  let c = sfColliders.get(id);
  if (!c) sfColliders.set(id, (c = readJson<TileCollider>(`public/tiles/sf/${id}.collider.json`)));
  return c;
};
const tileAt = (lat: number, lon: number): string => {
  const p = toLocal(lat, lon);
  const t = tileIndexOf(p.x, p.z);
  return tileId(t.ix, t.iz);
};
async function glb(file: string): Promise<GLTF> {
  const b = readFileSync(join(ROOT, "public/tiles/sf", file));
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
}

describe("lakes (W-11)", () => {
  it("a lake quad covers every cell with a lake corner, at that lake's level", () => {
    const g: CoverHeightfield = { x0: 0, z0: 0, cellSizeM: 10, nx: 3, nz: 3, heights: [5, 5, 9, 5, 5, 9, 9, 9, 9], cover: "00u00uuuu" };
    expect([...lakeMask(g)!]).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0]);
    const s = lakeSurface(g)!;
    // Every cell has a lake corner (the top-left sample is in all four).
    expect(s.indices.length / 6).toBe(4);
    for (let i = 1; i < s.positions.length; i += 3) expect(s.positions[i]).toBeCloseTo(5 + LAKE_LIFT_M, 6);
    // Faces up.
    const p = s.positions;
    const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3(p[3 * s.indices[k]!], p[3 * s.indices[k]! + 1], p[3 * s.indices[k]! + 2]));
    expect(b!.clone().sub(a!).cross(c!.clone().sub(a!)).y).toBeGreaterThan(0);
    expect(lakeSurface({ ...g, cover: "uuuuuuuuu" })).toBeNull();
    // The pack's LAKE mask reads the same.
    expect([...lakeMask({ ...g, cover: undefined, lake: [1, 1, 0, 1, 1, 0, 0, 0, 0] })!]).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0]);
  });

  it.skipIf(!SF)("Stow Lake, Spreckels and South Lake Merced: at least 90% of each lake's samples lie under a drawn lake surface at their level", () => {
    const lakes: Array<[string, number, number]> = [
      ["Stow Lake", 37.77018, -122.47738],
      ["Spreckels Lake", 37.77144, -122.49532],
      ["Lake Merced", 37.7191, -122.49611],
      ["Pine Lake", 37.73631, -122.48953],
    ];
    for (const [name, lat, lon] of lakes) {
      const g = collider(tileAt(lat, lon)).ground as CoverHeightfield;
      const mask = lakeMask(g);
      expect(mask, name).not.toBeNull();
      const s = lakeSurface(g)!;
      // Cells drawn, by their north-west corner.
      const drawn = new Map<string, number>();
      for (let q = 0; q < s.positions.length; q += 12) drawn.set(`${s.positions[q]},${s.positions[q + 2]}`, s.positions[q + 1]!);
      let n = 0;
      let covered = 0;
      for (let k = 0; k < g.nz; k++) {
        for (let i = 0; i < g.nx; i++) {
          if (!mask![k * g.nx + i]) continue;
          n++;
          const y = g.heights[k * g.nx + i]!;
          // Some cell touching the sample is drawn at its level.
          const hit = [
            [i, k],
            [i - 1, k],
            [i, k - 1],
            [i - 1, k - 1],
          ].some(([ci, ck]) => {
            const d = drawn.get(`${g.x0 + ci! * g.cellSizeM},${g.z0 + ck! * g.cellSizeM}`);
            return d !== undefined && Math.abs(d - LAKE_LIFT_M - y) < 0.1;
          });
          if (hit) covered++;
        }
      }
      expect(n, name).toBeGreaterThan(50);
      expect(covered / n, name).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe.skipIf(!SF)("the streamed sf tiles: lakes as water, ground colours as the pipeline wrote them, foliage (W-11, W-18, W-34)", () => {
  // Stow Lake (Golden Gate Park), Baker Beach, Ocean Beach.
  const ids = [tileAt(37.77018, -122.47738), tileAt(37.7935, -122.4836), tileAt(37.764, -122.5112)];

  it("adds a lake mesh with the lake material, keeps every ground colour, and draws the foliage nodes instanced", async () => {
    const full = readJson<Manifest>("public/tiles/sf/manifest.json");
    const manifest: Manifest = { ...full, tiles: full.tiles.filter((t) => ids.includes(t.id)) };
    const colliders = new Map(ids.map((id) => [id, collider(id)]));
    const materials = createSharedMaterials();
    const lakeMaterial = new THREE.MeshBasicMaterial({ name: "test-lake" });
    const parent = new THREE.Group();
    const s = new TileStreamer({
      parent,
      manifest,
      base: "",
      colliders,
      roads: null,
      ground: makeGroundFn([...colliders.values()]),
      materials,
      night: createNightMaterials(),
      radius: 50_000,
      loadGltf: (url) => glb(url),
      lakeMaterial,
      bakedGround: true,
      tintGround: () => { throw new Error("Baked ground must not run a legacy tint"); },
    });
    const [x, z] = [(manifest.tiles[0]!.bbox![0] + manifest.tiles[0]!.bbox![2]) / 2, manifest.tiles[0]!.bbox![1]];
    for (let i = 0; i < 4000 && !(i > 0 && s.settled()); i++) {
      s.update(x, z, 50);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(s.stats().ready).toBe(ids.length);
    const tile = (id: string): THREE.Object3D => parent.children.find((o) => o.name === `tile:${id}`)!;

    // Stow Lake's tile carries a lake mesh at Stow's level (87 m) in the lake material.
    const lakes = tile(ids[0]!).getObjectByName("lakes") as THREE.Mesh;
    expect(lakes, "lake mesh").toBeTruthy();
    expect(lakes.material).toBe(lakeMaterial);
    const ys = new Set<number>();
    const lp = lakes.geometry.getAttribute("position");
    for (let i = 0; i < lp.count; i++) ys.add(Math.round((lp.getY(i) - LAKE_LIFT_M) * 10) / 10);
    expect([...ys]).toContain(87);
    // The beaches have none.
    expect(tile(ids[1]!).getObjectByName("lakes")).toBeUndefined();

    for (const id of ids) {
      // Ground colours equal the glb's own COLOR_0: no tint anywhere (the old district tint
      // painted Stow Lake and the Baker and Crissy shores as lawn).
      const ref = await glb(`${id}.glb`);
      let refColors: THREE.BufferAttribute | null = null;
      ref.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.name === "ground") refColors = (o as THREE.Mesh).geometry.getAttribute("color") as THREE.BufferAttribute;
      });
      let drawn: THREE.BufferAttribute | null = null;
      tile(id).traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.name === "ground") drawn = (o as THREE.Mesh).geometry.getAttribute("color") as THREE.BufferAttribute;
      });
      expect(refColors, id).not.toBeNull();
      expect(drawn, id).not.toBeNull();
      expect(Array.from(drawn!.array), id).toEqual(Array.from(refColors!.array));
    }

    // Golden Gate Park's foliage: instanced trees in the shared foliage material.
    const trees: THREE.InstancedMesh[] = [];
    tile(ids[0]!).traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) trees.push(o as THREE.InstancedMesh);
    });
    expect(trees.length).toBeGreaterThanOrEqual(1);
    expect(trees.reduce((n, t) => n + t.count, 0)).toBeGreaterThan(100);
    for (const t of trees) expect(t.material).toBe(materials.foliage);
    s.dispose();
  });


});

describe("skirts (W-17, W-40 render half)", () => {
  it("hang SKIRT_DEPTH_M from every land border sample, and leave sea borders open", () => {
    // 3 x 3 samples; the south row is the sea.
    const g = { x0: 100, z0: 200, cellSizeM: 10, nx: 3, nz: 3, heights: [4, 5, 6, 3, 2, 1, 0, 0, 0] };
    const s = groundSkirt(g)!;
    const p = s.positions;
    const quads = s.indices.length / 6;
    // North 2, west 2 (the lower one has a land end), east 2, south 0.
    expect(quads).toBe(6);
    for (let q = 0; q < quads; q++) {
      const v = 4 * q;
      for (const [top, bottom] of [
        [v, v + 2],
        [v + 1, v + 3],
      ]) {
        const tx = p[3 * top!]!;
        const tz = p[3 * top! + 2]!;
        const i = Math.round((tx - 100) / 10);
        const k = Math.round((tz - 200) / 10);
        expect(p[3 * top! + 1]).toBe(g.heights[k * 3 + i]);
        expect(p[3 * bottom! + 1]).toBeCloseTo(p[3 * top! + 1]! - SKIRT_DEPTH_M, 6);
        expect(p[3 * bottom!]).toBe(tx);
        expect(p[3 * bottom! + 2]).toBe(tz);
        // On the border.
        expect(i === 0 || i === 2 || k === 0 || k === 2).toBe(true);
      }
    }
    expect(groundSkirt({ ...g, heights: g.heights.map(() => 0) })).toBeNull();
  });

  // The QA report's three worst borders (W-17), each seen from both sides at the streaming ring:
  // one tile streamed (its glb ground and its skirt), the neighbour drawn by the far layer (its
  // cells' triangles outside the streamed tile, as the far mask leaves them). Every 5 m along the
  // border where the sim's ground is land: straight-down probes 2 m into either side, and a ray
  // 20 degrees down from the streamed side aimed 3 m past the border at the near ground's height,
  // must hit a drawn surface over the sea.
  const BORDERS: ReadonlyArray<{ name: string; vertical: boolean; at: number; from: number; to: number; tiles: [string, string] }> = [
    { name: "Presidio", vertical: true, at: -7500, from: -500, to: 0, tiles: ["t-16_-1", "t-15_-1"] },
    { name: "Lakeshore bluffs", vertical: false, at: 9000, from: -10000, to: -9500, tiles: ["t-20_17", "t-20_18"] },
    { name: "west of Twin Peaks", vertical: true, at: -4000, from: 6500, to: 7000, tiles: ["t-9_13", "t-8_13"] },
  ];

  it.skipIf(!SF)("at the three worst near/far borders no probe or ray from the streamed side finds the sea", async () => {
    const manifest = readJson<Manifest>("public/tiles/sf/manifest.json");
    const farCells = new Map<string, THREE.Mesh[]>();
    const farMeshes = async (id: string): Promise<THREE.Mesh[]> => {
      let l = farCells.get(id);
      if (l) return l;
      const cell = manifest.far!.find((c) => c.id === id)!;
      const g = await glb(cell.glb);
      g.scene.updateMatrixWorld(true);
      l = [];
      g.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) l!.push(o as THREE.Mesh);
      });
      farCells.set(id, l);
      return l;
    };
    let sea = 0;
    let probes = 0;
    let slitProbes = 0;
    let slitOpen = 0;
    let slitOpenWithoutSkirt = 0;
    for (const b of BORDERS) {
      // The sim's ground around the border (every built tile within 1.5 km).
      const [bx, bz] = b.vertical ? [b.at, (b.from + b.to) / 2] : [(b.from + b.to) / 2, b.at];
      const ground = makeGroundFn(
        manifest.tiles
          .filter((t) => t.bbox && t.bbox[2] > bx - 1500 && t.bbox[0] < bx + 1500 && t.bbox[3] > bz - 1500 && t.bbox[1] < bz + 1500)
          .map((t) => collider(t.id)),
      );
      for (const side of [0, 1] as const) {
        const near = b.tiles[side];
        const spec = manifest.tiles.find((t) => t.id === near)!;
        const [minX, minZ, maxX, maxZ] = spec.bbox!;
        const inNear = (x: number, z: number): boolean => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
        // Near: the glb's ground and the skirt.
        const scene = new THREE.Group();
        const tileGltf = await glb(spec.glb!);
        tileGltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && o.name === "ground") scene.add((o as THREE.Mesh).clone());
        });
        tileGltf.scene.updateMatrixWorld(true);
        scene.children.forEach((m) => m.matrixWorld.copy(tileGltf.scene.getObjectByName("ground")!.matrixWorld));
        const sk = groundSkirt(collider(near).ground!)!;
        const skGeo = new THREE.BufferGeometry();
        skGeo.setAttribute("position", new THREE.BufferAttribute(sk.positions, 3));
        skGeo.setIndex(new THREE.BufferAttribute(sk.indices, 1));
        const skirtMesh = new THREE.Mesh(skGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        scene.add(skirtMesh);
        // Far: every far cell's triangles within 1.5 km of the border, outside the streamed tile.
        const pos: number[] = [];
        const v = new THREE.Vector3();
        for (const cell of manifest.far!) {
          const bb = cell.bbox!;
          const lo = b.vertical ? [b.at - 1500, b.from - 1500] : [b.from - 1500, b.at - 1500];
          const hi = b.vertical ? [b.at + 1500, b.to + 1500] : [b.to + 1500, b.at + 1500];
          if (bb[2] < lo[0]! || bb[0] > hi[0]! || bb[3] < lo[1]! || bb[1] > hi[1]!) continue;
          for (const m of await farMeshes(cell.id)) {
            const p = m.geometry.getAttribute("position");
            const idx = m.geometry.getIndex();
            const n = idx ? idx.count : p.count;
            for (let t = 0; t < n; t += 3) {
              const tri: number[] = [];
              let cx = 0;
              let cz = 0;
              let nearBorder = false;
              for (let k = 0; k < 3; k++) {
                v.fromBufferAttribute(p, idx ? idx.getX(t + k) : t + k).applyMatrix4(m.matrixWorld);
                tri.push(v.x, v.y, v.z);
                cx += v.x / 3;
                cz += v.z / 3;
                if (v.x > lo[0]! && v.x < hi[0]! && v.z > lo[1]! && v.z < hi[1]!) nearBorder = true;
              }
              if (!nearBorder || inNear(cx, cz)) continue;
              pos.push(...tri);
            }
          }
        }
        const farGeo = new THREE.BufferGeometry();
        farGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const farMesh = new THREE.Mesh(farGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        farMesh.updateMatrixWorld(true);
        scene.add(farMesh);
        const ray = new THREE.Raycaster();
        const hitsLand = (o: THREE.Vector3, d: THREE.Vector3): boolean => {
          ray.set(o, d.normalize());
          ray.far = 3000;
          const h = ray.intersectObjects(scene.children, false)[0];
          return !!h && h.point.y > 0.02;
        };
        const out = side === 0 ? 1 : -1;
        const noSkirt = scene.children.filter((o) => o !== skirtMesh);
        for (let s = b.from + 2.5; s < b.to; s += 5) {
          const at = (d: number): [number, number] => (b.vertical ? [b.at + out * d, s] : [s, b.at + out * d]);
          {
            // The half-metre slit between the near ground's edge and the far terrain just below
            // it, seen from over the far side (where the streamed set has a notch, the far tile
            // lies between the viewer and the near tile's edge): only the skirt closes it. A ray
            // 20 degrees down into the slit must stop at the border, not run on under the near
            // ground to whatever lies beyond.
            const [ex, ez] = at(0);
            const hb = ground(ex, ez);
            if (hb > 1) {
              const down = (20 * Math.PI) / 180;
              const dir = new THREE.Vector3(b.vertical ? -out * Math.cos(down) : 0, -Math.sin(down), b.vertical ? 0 : -out * Math.cos(down));
              const target = new THREE.Vector3(ex, hb - 0.25, ez);
              const o = target.clone().addScaledVector(dir, -35);
              ray.set(o, dir);
              ray.far = 3000;
              const first = (objs: THREE.Object3D[]): number => ray.intersectObjects(objs, false)[0]?.distance ?? Infinity;
              // Count only rays that reach the border unobstructed (the slit is in view).
              if (first(noSkirt) > 34 && first(noSkirt.filter((m) => m === farMesh)) > 34) {
                slitProbes++;
                if (first(scene.children) > 36) slitOpen++;
                if (first(noSkirt) > 36) slitOpenWithoutSkirt++;
              }
            }
          }
          for (const d of [-2, 2]) {
            const [px, pz] = at(d);
            if (ground(px, pz) <= 0.5) continue;
            probes++;
            if (!hitsLand(new THREE.Vector3(px, ground(px, pz) + 200, pz), new THREE.Vector3(0, -1, 0))) sea++;
          }
          const nearPt = at(-0.5);
          const target = at(3);
          if (ground(nearPt[0], nearPt[1]) <= 0.5 || ground(target[0], target[1]) <= 0.5) continue;
          const y = ground(nearPt[0], nearPt[1]);
          const down = (20 * Math.PI) / 180;
          const dir = new THREE.Vector3(b.vertical ? out * Math.cos(down) : 0, -Math.sin(down), b.vertical ? 0 : out * Math.cos(down));
          const o = new THREE.Vector3(target[0], y, target[1]).addScaledVector(dir, -35);
          // A ray over a bluff steeper than 20 degrees (the Presidio over Baker Beach) really does
          // reach the sea: count only rays the sim's ground rises to meet before sea level.
          let meets = false;
          for (let t = 35; t < 3000 && !meets; t += 1) {
            const py = o.y + dir.y * t;
            if (py <= 0.02) break;
            if (ground(o.x + dir.x * t, o.z + dir.z * t) >= py) meets = true;
          }
          if (!meets) continue;
          probes++;
          if (!hitsLand(o, dir)) sea++;
        }
      }
    }
    expect(probes).toBeGreaterThan(200);
    expect(sea).toBe(0);
    // The skirt's own proof on the real borders: without it the slit is open, with it closed.
    expect(slitProbes).toBeGreaterThan(50);
    expect(slitOpenWithoutSkirt).toBeGreaterThan(slitProbes / 2);
    expect(slitOpen).toBe(0);
  }, 120_000);
});
