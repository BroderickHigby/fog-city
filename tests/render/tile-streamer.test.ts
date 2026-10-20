// The streamer end to end in Node (no WebGL needed): collider-built tiles, real glb tiles
// parsed by three's GLTFLoader, landmark building hiding, unload and dispose, and the
// fallback when a glb is broken.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { makeGroundFn } from "../../src/render/ground.ts";
import { createSharedMaterials, materialFor, tileLayer } from "../../src/render/materials.ts";
import { createNightMaterials } from "../../src/render/props.ts";
import { TileStreamer, dropWaterTriangles } from "../../src/render/tile-streamer.ts";
import type { Manifest, RoadGraph } from "../../src/render/types.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { ROOT, readJson } from "../helpers.ts";

function world(name: string) {
  const manifest = readJson<Manifest>(`public/tiles/${name}/manifest.json`);
  const colliders = new Map<string, TileCollider>();
  for (const t of manifest.tiles) colliders.set(t.id, readJson<TileCollider>(`public/tiles/${name}/${t.collider}`));
  const roads = manifest.roads ? readJson<RoadGraph>(`public/tiles/${name}/${manifest.roads}`) : null;
  return { manifest, colliders, roads, ground: makeGroundFn([...colliders.values()]) };
}

/** GLTFLoader reading straight from public/ (URL "/tiles/<world>/<file>"). */
async function loadFromDisk(url: string): Promise<GLTF> {
  const bytes = readFileSync(join(ROOT, "public", url));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new GLTFLoader().parseAsync(ab, "");
}

async function settle(s: TileStreamer, x: number, z: number): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    s.update(x, z, 50);
    if (s.settled()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("streamer never settled");
}

function make(name: string, opts: { radius?: number; loadGltf?: (url: string) => Promise<GLTF> } = {}) {
  const w = world(name);
  const parent = new THREE.Group();
  const materials = createSharedMaterials();
  const streamer = new TileStreamer({
    parent,
    manifest: w.manifest,
    base: `/tiles/${name}/`,
    colliders: w.colliders,
    roads: w.roads,
    ground: w.ground,
    materials,
    night: createNightMaterials(),
    radius: opts.radius ?? 1500,
    loadGltf: opts.loadGltf ?? loadFromDisk,
  });
  return { ...w, parent, materials, streamer };
}

const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};

describe("TileStreamer", () => {
  it("builds a glb: null tile from its collider, with roads and street props", async () => {
    const { streamer, parent, materials } = make("dev");
    await settle(streamer, 0, 0);
    expect(streamer.stats()).toMatchObject({ total: 1, ready: 1, builtReady: 1, glbReady: 0, pending: 0 });
    const tile = parent.getObjectByName("tile:dev")!;
    const names = meshes(tile).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["ground", "buildings", "roads", "lamp-poles", "lamp-heads"]));
    expect((tile.getObjectByName("buildings") as THREE.Mesh).material).toBe(materials.building);
    // Night-only props start hidden and follow the switch.
    const glow = tile.getObjectByName("lamp-glow")!;
    expect(glow.visible).toBe(false);
    streamer.setNight(true);
    expect(glow.visible).toBe(true);
  });

  it("loads dev-city glb tiles near the camera with shared materials, and leaves the rest", async () => {
    const { streamer, parent, materials, manifest } = make("dev-city", { radius: 400 });
    await settle(streamer, manifest.spawn.x, manifest.spawn.z);
    const s = streamer.stats();
    expect(s.ready).toBeGreaterThan(1);
    expect(s.ready).toBeLessThan(s.total);
    expect(s.glbReady).toBe(s.ready);
    const tile = parent.getObjectByName("tile:t-1_0")!;
    const b = tile.getObjectByName("buildings") as THREE.Mesh;
    expect(b.material).toBe(materials.building);
    expect((tile.getObjectByName("roads") as THREE.Mesh).material).toBe(materials.road);
    expect((tile.getObjectByName("ground") as THREE.Mesh).material).toBe(materials.ground);
    expect(Array.isArray(b.geometry.userData.fcBuildings)).toBe(true);
    expect(b.geometry.getAttribute("_facade").itemSize).toBe(4);
    // Quantized positions come back in world metres.
    b.geometry.computeBoundingBox();
    const bb = b.geometry.boundingBox!.clone().applyMatrix4(b.matrixWorld);
    expect(bb.min.x).toBeGreaterThan(-520);
    expect(bb.max.x).toBeLessThan(20);
  });

  it("hides buildings a landmark replaces, in loaded tiles and in tiles loaded later", async () => {
    const { streamer, parent, manifest, colliders } = make("dev-city", { radius: 200 });
    const victim = colliders.get("t-1_0")!.buildings[0]!.id;
    const later = colliders.get("t-2_-1")!.buildings[0]!.id;
    streamer.hideBuildings([victim, later]);
    await settle(streamer, manifest.spawn.x, manifest.spawn.z);
    const check = (tileId: string, id: string): void => {
      const g = (parent.getObjectByName(`tile:${tileId}`)!.getObjectByName("buildings") as THREE.Mesh).geometry;
      const range = (g.userData.fcBuildings as Array<[string, number, number]>).find((r) => r[0] === id)!;
      const idx = g.getIndex()!.array;
      const first = idx[range[1]];
      for (let i = range[1]; i < range[1] + range[2]; i++) expect(idx[i]).toBe(first);
    };
    check("t-1_0", victim);
    await settle(streamer, -600, -300);
    check("t-2_-1", later);
  });

  it("unloads and disposes tiles the camera has left", async () => {
    const { streamer, parent, manifest } = make("dev-city", { radius: 300 });
    await settle(streamer, manifest.spawn.x, manifest.spawn.z);
    const near = parent.getObjectByName("tile:t-1_0")!;
    let disposed = 0;
    for (const m of meshes(near)) m.geometry.addEventListener("dispose", () => disposed++);
    await settle(streamer, -2300, -1300);
    expect(parent.getObjectByName("tile:t-1_0")).toBeUndefined();
    expect(parent.getObjectByName("tile:t-5_-3")).toBeDefined();
    expect(disposed).toBeGreaterThan(2);
  });

  it("builds a tile from its collider when its glb fails to load", async () => {
    const { streamer, parent } = make("dev-city", { radius: 100, loadGltf: () => Promise.reject(new Error("404")) });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await settle(streamer, -55, 300);
    } finally {
      console.warn = warn;
    }
    expect(streamer.stats().ready).toBeGreaterThan(0);
    const names = meshes(parent.getObjectByName("tile:t-1_0")!).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["ground", "buildings", "roads"]));
  });
});

describe("glb layer conventions", () => {
  it("classifies this repo's and the pipeline's mesh names", () => {
    expect(tileLayer("building", "buildings")).toBe("building");
    expect(tileLayer("", "buildings")).toBe("building");
    expect(tileLayer("terrain", "x")).toBe("ground");
    expect(tileLayer("road", "roads")).toBe("road");
    expect(tileLayer("freeway", "freeways")).toBe("freeway");
    expect(tileLayer("foliage", "foliage")).toBe("foliage");
    expect(tileLayer("neon-sign", "storefront_12")).toBeNull();
    expect(tileLayer("roadside-cafe", "x")).toBeNull();
  });

  it("chooses materials by what the geometry carries", () => {
    const m = createSharedMaterials();
    expect(materialFor(m, "building", { hasNormals: false, hasUv: true })).toBe(m.buildingFlat);
    expect(materialFor(m, "road", { hasNormals: true, hasUv: true })).toBe(m.roadUv);
    expect(materialFor(m, "road", { hasNormals: true, hasUv: false })).toBe(m.road);
    expect(materialFor(m, "freeway", { hasNormals: true, hasUv: true })).toBe(m.freewayUv);
  });

  it("drops ground triangles lying on the water plane, keeps the shore", () => {
    const g = new THREE.BufferGeometry();
    // Two water triangles at y = 0, one shore triangle reaching 2 m.
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 20, 2, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 2]);
    expect(dropWaterTriangles(g, new THREE.Matrix4())).toBe(2);
    expect(Array.from(g.getIndex()!.array)).toEqual([1, 4, 2]);
    // World transform counts: lifted 1 m, nothing is under water.
    const h = new THREE.BufferGeometry();
    h.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
    h.setIndex([0, 1, 2]);
    expect(dropWaterTriangles(h, new THREE.Matrix4().makeTranslation(0, 1, 0))).toBe(0);
  });
});
