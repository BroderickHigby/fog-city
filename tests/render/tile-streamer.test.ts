// The streamer end to end in Node (no WebGL needed): collider-built tiles, real glb tiles
// parsed by three's GLTFLoader, the pipeline's meshopt-compressed sf tiles through the
// streamer's own loader, landmark building hiding, unload and dispose, the one retry and then
// the fallback when a glb is broken, and the failed state when a tile has nothing to show.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
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

function make(
  name: string,
  opts: { radius?: number; glbRetryMs?: number; loadGltf?: (url: string) => Promise<GLTF>; fallbackCollider?: (id: string) => Promise<TileCollider | null> } = {},
) {
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
    glbRetryMs: opts.glbRetryMs,
    loadGltf: opts.loadGltf ?? loadFromDisk,
    fallbackCollider: opts.fallbackCollider,
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
    const { streamer, parent, manifest, materials } = make("dev-city", { radius: 300 });
    await settle(streamer, manifest.spawn.x, manifest.spawn.z);
    const near = parent.getObjectByName("tile:t-1_0")!;
    let disposed = 0, sharedMaterialDisposals = 0;
    const retired = new Set<THREE.Mesh>(), tileMeshes = meshes(near);
    for (const m of tileMeshes) {
      m.geometry.addEventListener("dispose", () => disposed++);
      m.addEventListener("dispose", () => retired.add(m));
    }
    for (const material of materials.all) material.addEventListener("dispose", () => sharedMaterialDisposals++);
    await settle(streamer, -2300, -1300);
    expect(parent.getObjectByName("tile:t-1_0")).toBeUndefined();
    expect(parent.getObjectByName("tile:t-5_-3")).toBeDefined();
    expect(disposed).toBeGreaterThan(2);
    expect(retired.size).toBe(tileMeshes.length);
    expect(sharedMaterialDisposals).toBe(0);
  });

  it("builds a tile from its collider when its glb fails to load twice", async () => {
    const { streamer, parent } = make("dev-city", { radius: 100, glbRetryMs: 1, loadGltf: () => Promise.reject(new Error("404")) });
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

  it("builds a failed glb's tile from the tile's own collider when fallbackCollider gives one (the pack's has no meta)", async () => {
    const asked: string[] = [];
    const { streamer, parent, colliders } = make("dev-city", {
      radius: 100,
      glbRetryMs: 1,
      loadGltf: () => Promise.reject(new Error("404")),
      // The tile's "own" collider here has no buildings at all, so a build from it is told apart.
      fallbackCollider: async (id) => (asked.push(id), { ...colliders.get(id)!, buildings: [] }),
    });
    expect(colliders.get("t-1_0")!.buildings.length).toBeGreaterThan(0);
    await quietly(() => settle(streamer, -55, 300));
    expect(asked).toContain("t-1_0");
    expect(streamer.stats().ready).toBeGreaterThan(0);
    const names = meshes(parent.getObjectByName("tile:t-1_0")!).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["ground", "roads"]));
    expect(names).not.toContain("buildings");
  });
});

/** Silence the streamer's console.warn for a test that provokes it; returns the messages. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

describe("TileStreamer: a tile with nothing to show fails", () => {
  // One dev-city tile's spec under a made-up id: the streamer has its bounds but no collider.
  function ghost(glb: string | null, loadGltf: (url: string) => Promise<GLTF>, glbRetryMs = 1) {
    const w = world("dev-city");
    const spec = { ...w.manifest.tiles.find((t) => t.id === "t-1_0")!, id: "ghost", glb };
    const parent = new THREE.Group();
    const streamer = new TileStreamer({
      parent,
      manifest: { ...w.manifest, tiles: [spec] },
      base: "/tiles/dev-city/",
      colliders: new Map(),
      roads: null,
      ground: w.ground,
      materials: createSharedMaterials(),
      night: createNightMaterials(),
      radius: 1500,
      glbRetryMs,
      loadGltf,
    });
    return { streamer, parent };
  }

  it("no glb and no collider: failed, not ready, and nothing added to the scene", async () => {
    const { streamer, parent } = ghost(null, loadFromDisk);
    const { warnings } = await quietly(() => settle(streamer, -250, 250));
    expect(streamer.stats()).toMatchObject({ total: 1, ready: 0, failed: 1, pending: 0 });
    expect(parent.getObjectByName("tile:ghost")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/ghost: failed/);
  });

  it("a glb that fails to load twice and no collider to fall back on: failed after exactly two fetches", async () => {
    let calls = 0;
    const { streamer } = ghost("t-1_0.glb", () => (calls++, Promise.reject(new Error("404"))));
    await quietly(() => settle(streamer, -250, 250));
    expect(streamer.stats()).toMatchObject({ ready: 0, failed: 1, pending: 0 });
    expect(calls).toBe(2);
  });

  it("a glb that fails once is fetched again after the backoff: ready from the glb, nothing failed", async () => {
    const urls: string[] = [];
    const flaky = (url: string): Promise<GLTF> => {
      urls.push(url);
      return urls.length === 1 ? Promise.reject(new Error("connection reset")) : loadFromDisk(url);
    };
    const { streamer } = ghost("t-1_0.glb", flaky, 20);
    const t0 = performance.now();
    const { warnings } = await quietly(() => settle(streamer, -250, 250));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(15);
    expect(urls).toEqual(["/tiles/dev-city/t-1_0.glb", "/tiles/dev-city/t-1_0.glb"]);
    expect(streamer.stats()).toMatchObject({ ready: 1, glbReady: 1, failed: 0, pending: 0 });
    expect(warnings).toEqual([]);
  });

  it("a tile unloaded during the backoff is never fetched again", async () => {
    let calls = 0;
    const { streamer } = ghost("t-1_0.glb", () => (calls++, Promise.reject(new Error("404"))), 30);
    streamer.update(-250, 250);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    expect(streamer.settled()).toBe(false);
    streamer.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  it("a glb that loads needs no collider: ready", async () => {
    const { streamer } = ghost("t-1_0.glb", loadFromDisk);
    await settle(streamer, -250, 250);
    expect(streamer.stats()).toMatchObject({ ready: 1, glbReady: 1, failed: 0 });
  });
});

describe("TileStreamer: the pipeline's compressed sf tiles", () => {
  // The spawn tile (the Ferry Building) and its neighbours: meshopt-compressed, quantised.
  const SF_IDS = ["t-1_-1", "t-1_0", "t0_-1", "t0_0", "t0_1", "t1_0"];
  const sfTile = (id: string): Uint8Array => new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", `${id}.glb`)));
  const buffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

  it("the committed tiles need the meshopt decoder: plain GLTFLoader refuses, createTileLoader() decodes", async () => {
    const bytes = sfTile("t0_0");
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true))));
    expect(json.extensionsRequired).toEqual(expect.arrayContaining(["EXT_meshopt_compression", "KHR_mesh_quantization"]));
    await expect(new GLTFLoader().parseAsync(buffer(bytes), "")).rejects.toThrow(/setMeshoptDecoder/);
    const gltf = await createTileLoader().parseAsync(buffer(bytes), "");
    const names = meshes(gltf.scene).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["ground", "buildings", "roads"]));
    // Quantised positions come back in world metres through the node transforms.
    gltf.scene.updateMatrixWorld(true);
    const b = gltf.scene.getObjectByName("buildings") as THREE.Mesh;
    b.geometry.computeBoundingBox();
    const bb = b.geometry.boundingBox!.clone().applyMatrix4(b.matrixWorld);
    expect(bb.min.x).toBeGreaterThan(-60);
    expect(bb.max.x).toBeLessThan(560);
    expect(bb.min.z).toBeGreaterThan(-60);
    expect(bb.max.z).toBeLessThan(560);
    expect(bb.max.y).toBeGreaterThan(20);
  });

  // The streamer's default loader (no test seam), fetching over a loopback HTTP server.
  // three's FileLoader reports download progress with the DOM's ProgressEvent, which Node lacks.
  let server: Server;
  let origin = "";
  const g = globalThis as { ProgressEvent?: unknown };
  const hadProgressEvent = "ProgressEvent" in g;
  beforeAll(async () => {
    if (!hadProgressEvent) {
      g.ProgressEvent = class extends Event {
        readonly lengthComputable: boolean;
        readonly loaded: number;
        readonly total: number;
        constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
          super(type);
          this.lengthComputable = init.lengthComputable ?? false;
          this.loaded = init.loaded ?? 0;
          this.total = init.total ?? 0;
        }
      };
    }
    const pub = join(ROOT, "public");
    server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^([/\\])+/, "");
      const file = join(pub, path);
      if (!file.startsWith(pub)) return void res.writeHead(403).end();
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": extname(file) === ".glb" ? "model/gltf-binary" : "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (!hadProgressEvent) delete g.ProgressEvent;
  });

  it("streams them through its own loader: every tile ready from its glb, none rebuilt, none failed", async () => {
    const manifest = readJson<Manifest>("public/tiles/sf/manifest.json");
    const tiles = manifest.tiles.filter((t) => SF_IDS.includes(t.id));
    expect(tiles.map((t) => t.id).sort()).toEqual([...SF_IDS].sort());
    const colliders = new Map<string, TileCollider>();
    for (const t of tiles) colliders.set(t.id, readJson<TileCollider>(`public/tiles/sf/${t.collider}`));
    const parent = new THREE.Group();
    const materials = createSharedMaterials();
    const streamer = new TileStreamer({
      parent,
      manifest: { ...manifest, tiles },
      base: `${origin}/tiles/sf/`,
      colliders,
      roads: null,
      ground: makeGroundFn([...colliders.values()]),
      materials,
      night: createNightMaterials(),
      radius: 2000,
    });
    const { warnings } = await quietly(() => settle(streamer, 0, 0));
    expect(warnings).toEqual([]);
    expect(streamer.stats()).toMatchObject({ total: SF_IDS.length, ready: SF_IDS.length, glbReady: SF_IDS.length, builtReady: 0, failed: 0 });
    // The Ferry Building's tile: the glb's own layers with the shared materials, ranges matching the collider.
    const tile = parent.getObjectByName("tile:t0_-1")!;
    const b = tile.getObjectByName("buildings") as THREE.Mesh;
    // The pipeline's building meshes carry no normals (flat-shaded facades).
    expect(b.material).toBe(materials.buildingFlat);
    expect((tile.getObjectByName("ground") as THREE.Mesh).material).toBe(materials.ground);
    const ranges = b.geometry.userData.fcBuildings as Array<[string, number, number]>;
    expect(ranges.map((r) => r[0])).toEqual(colliders.get("t0_-1")!.buildings.map((x) => x.id));
    expect(ranges.map((r) => r[0])).toContain("201006.0000058-tower");
    streamer.dispose();
  }, 60_000);
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
    expect(tileLayer("", "buildings_1")).toBe("building");
    expect(tileLayer("Ground.001", "")).toBe("ground");
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
