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
import { LawnTerrain } from "../../src/render/lawn-terrain.ts";
import { createPavementMask } from "../../src/render/pavement.ts";
import { createSharedMaterials, materialFor, tileLayer } from "../../src/render/materials.ts";
import { createNightMaterials } from "../../src/render/props.ts";
import { TileStreamer, dropWaterTriangles } from "../../src/render/tile-streamer.ts";
import type { Manifest, RoadGraph } from "../../src/render/types.ts";
import { heightOnField, type TileCollider, type Heightfield } from "../../src/sim/world.ts";
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

describe("asynchronous fallback lawn admission",()=>{
  function fallback(glb:string|null) {
    const parent=new THREE.Group(),materials=createSharedMaterials();
    const collider:TileCollider={tileId:"lawn",buildings:[],ground:{x0:0,z0:0,nx:2,nz:2,cellSizeM:100,heights:[3,3,3,3]}};
    const lawns=new LawnTerrain({grass:[{id:"rpd:test:0@0,0",kind:"lawn",rings:[[10,10,20,10,20,20,10,20]]}]}),pavement=createPavementMask(null);
    let release!:()=>void,prepared:THREE.BufferGeometry|undefined,current:()=>boolean=()=>false,disposed=0,ready=0;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const streamer=new TileStreamer({parent,materials,night:createNightMaterials(),colliders:new Map([["lawn",collider]]),roads:null,ground:()=>3,
      base:"/fallback/",radius:60,hysteresis:0,glbRetryMs:0,
      manifest:{version:1,world:"fallback-lawn",spawn:{x:10,z:10,heading:0},tiles:[{id:"lawn",bbox:[0,0,100,100],collider:"unused.json",glb}]},
      loadGltf:async()=>{throw new Error("fixture failed GLB");},onReady:()=>{ready++;},
      prepareFallbackGround:async(geo,matrix,isCurrent)=>{
        prepared=geo;current=isCurrent;geo.addEventListener("dispose",()=>{disposed++;});
        await gate;
        await lawns.paintAsync(geo,matrix,pavement,undefined,isCurrent);
      },
    });
    const start=async()=>{await quietly(async()=>{for(let i=0;i<12;i++){streamer.update(10,10,50);await new Promise(resolve=>setTimeout(resolve,0));}});expect(prepared).toBeDefined();};
    return {streamer,parent,start,release,geo:()=>prepared!,current:()=>current(),disposed:()=>disposed,ready:()=>ready};
  }
  it.each([null,"failed.glb"])("keeps %s fallback pending and off-scene until mapped lawn preparation finishes",async glb=>{
    const f=fallback(glb);
    try {
      await f.start();expect(f.streamer.stats()).toMatchObject({ready:0,pending:1});expect(f.parent.getObjectByName("tile:lawn")).toBeUndefined();expect(f.ready()).toBe(0);
      f.release();await settle(f.streamer,10,10);
      expect(f.streamer.stats()).toMatchObject({ready:1,pending:0});expect(f.ready()).toBe(1);
      const geo=f.geo(),color=geo.getAttribute("color");expect(geo.userData.fcLawnTerrain).toBe(true);
      const green=new THREE.Color(0x426e30);
      expect(Array.from({length:color.count},(_,i)=>i).some(i=>Math.abs(color.getX(i)-green.r)<1e-6&&Math.abs(color.getY(i)-green.g)<1e-6)).toBe(true);
    } finally {f.release();f.streamer.dispose();}
  });
  it("cancels and disposes fallback ground unloaded during preparation without admitting stale geometry",async()=>{
    const f=fallback(null);
    try {
      await f.start();const geo=f.geo(),position=geo.getAttribute("position"),index=geo.index;
      f.streamer.update(10000,10000,50);expect(f.current()).toBe(false);expect(f.disposed()).toBe(1);
      f.release();for(let i=0;i<12;i++)await Promise.resolve();
      expect(geo.getAttribute("position")).toBe(position);expect(geo.index).toBe(index);expect(geo.userData.fcLawnTerrain).toBeUndefined();
      expect(f.parent.getObjectByName("tile:lawn")).toBeUndefined();expect(f.ready()).toBe(0);expect(f.disposed()).toBe(1);
    } finally {f.release();f.streamer.dispose();}
  });
});

describe("pavement repair at tile admission", () => {
  it("drapes long fallback roads using distinct packed and fallback copies of terrain", async () => {
    const field = (x0: number): Heightfield => ({ x0, z0: 0, nx: 4, nz: 3, cellSizeM: 10,
      heights: [2,2,2,2, 2,5,2,2, 2,2,2,2] });
    const fields = [field(0),field(30),field(60)];
    const colliders = new Map(fields.map((ground,i) => [`t${i}`,{tileId:`t${i}`,ground,buildings:[]} as TileCollider]));
    const parent = new THREE.Group(), materials = createSharedMaterials();
    const roads: RoadGraph = {version:1,nodes:[],edges:[{id:"long",a:"a",b:"b",kind:"residential",lanes:1,oneway:false,widthM:4,points:[[0,10],[80,10]]}]};
    const streamer = new TileStreamer({ parent, materials, night:createNightMaterials(), colliders, roads,
      ground:makeGroundFn([...colliders.values()]), base:"/test/", radius:200, glbRetryMs:0,
      manifest:{version:1,world:"repair",spawn:{x:10,z:10,heading:0},tiles:[{id:"t0",bbox:[0,0,30,20],collider:"unused.json",glb:"bad.glb"}]},
      loadGltf:async()=>{throw new Error("fixture uses fallback");},
      fallbackCollider:async()=>structuredClone(colliders.get("t0")!),
    });
    try {
      await quietly(()=>settle(streamer,10,10));
      parent.updateMatrixWorld(true);
      const road = parent.getObjectByName("roads") as THREE.Mesh;
      expect(road).toBeDefined();
      for (const [x,f] of [[10,fields[0]!],[70,fields[2]!]] as const) {
        const hit = new THREE.Raycaster(new THREE.Vector3(x,20,10),new THREE.Vector3(0,-1,0)).intersectObject(road)[0];
        expect(hit, `pavement at ${x}`).toBeDefined();
        expect(hit!.point.y).toBeGreaterThan(heightOnField(f,x,10)+.01);
      }
    } finally { streamer.dispose(); }
  });
});

describe("TileStreamer startup surface readiness", () => {
  const tile = (id: string, bbox: [number, number, number, number]) => ({ id, bbox, glb: `${id}.glb`, collider: `${id}.json` });
  const near = tile("near", [0, 0, 100, 100]);
  function setup(tiles: Manifest["tiles"], radius = 400, colliders: ReadonlyMap<string, TileCollider> = new Map()) {
    const pending = new Map<string, { resolve: (gltf: GLTF) => void; reject: (error: Error) => void }>();
    const parent = new THREE.Group();
    const streamer = new TileStreamer({
      parent, manifest: { version: 1, world: "startup-test", spawn: { x: 10, z: 10, heading: 0 }, tiles },
      base: "/startup/", colliders, roads: null, ground: () => 3,
      materials: createSharedMaterials(), night: createNightMaterials(), radius, maxConcurrent: 4, glbRetryMs: 0,
      loadGltf: url => new Promise((resolve, reject) => { pending.set(url, { resolve, reject }); }),
    });
    const resolve = async (id: string): Promise<void> => {
      const scene = new THREE.Group();
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ name: "fc:ground" }));
      ground.position.y = 3; ground.name = "ground"; scene.add(ground);
      pending.get(`/startup/${id}.glb`)!.resolve({ scene } as GLTF);
      await Promise.resolve();
    };
    return { streamer, parent, pending, resolve };
  }

  it("waits for every nearby real tile while unrelated downloads remain pending", async () => {
    const { streamer, pending, resolve } = setup([near, tile("west", [-100, 0, 0, 100]), tile("far", [200, 0, 300, 100])]);
    expect(streamer.startupSurfaceReady(10, 10)).toBe(false);
    streamer.update(10, 10);
    expect(pending.size).toBe(3);
    await resolve("near");
    expect(streamer.startupSurfaceReady(10, 10)).toBe(false);
    await resolve("west");
    expect(streamer.startupSurfaceReady(10, 10)).toBe(true);
    expect(streamer.stats().pending).toBe(1);
    expect(streamer.settled()).toBe(false);
    streamer.dispose();
  });

  it("counts the 60m boundary but ignores a tile beyond it", async () => {
    const { streamer, resolve } = setup([near, tile("edge", [70, 0, 100, 50]), tile("outside", [70.01, 0, 100.01, 50])]);
    streamer.update(10, 10);
    await resolve("near");
    expect(streamer.startupSurfaceReady(10, 10)).toBe(false);
    await resolve("edge");
    expect(streamer.startupSurfaceReady(10, 10)).toBe(true);
    expect(streamer.stats().pending).toBe(1);
    streamer.dispose();
  });

  it("uses a smaller configured streaming radius rather than waiting for unrequested tiles", async () => {
    const { streamer, pending, resolve } = setup([near, tile("outside-radius", [30, 0, 100, 50])], 10);
    streamer.update(10, 10);
    expect(pending.size).toBe(1);
    await resolve("near");
    expect(streamer.startupSurfaceReady(10, 10)).toBe(true);
    streamer.dispose();
  });

  it("waits for collider fallback geometry, not just completion of a failed download", async () => {
    const collider: TileCollider = { tileId: "near", buildings: [], ground: { x0: 0, z0: 0, cellSizeM: 100, nx: 2, nz: 2, heights: [3, 3, 3, 3] } };
    const { streamer, parent, pending } = setup([near], 60, new Map([["near", collider]]));
    streamer.update(10, 10);
    await quietly(async () => {
      pending.get("/startup/near.glb")!.reject(new Error("unavailable tile"));
      await Promise.resolve();
      expect(streamer.startupSurfaceReady(10, 10)).toBe(false);
      for (let i = 0; i < 10 && !streamer.startupSurfaceReady(10, 10); i++) streamer.update(10, 10, 50);
    });
    expect(streamer.startupSurfaceReady(10, 10)).toBe(true);
    const ground = parent.getObjectByName("tile:near")?.getObjectByName("ground") as THREE.Mesh;
    expect(ground.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(streamer.stats()).toMatchObject({ ready: 1, pending: 0 });
    streamer.dispose();
  });

  it("does not expose a failed critical tile as ready", async () => {
    const { streamer, pending } = setup([near]);
    streamer.update(10, 10);
    await quietly(async () => { pending.get("/startup/near.glb")!.reject(new Error("no tile and no fallback")); await Promise.resolve(); });
    expect(streamer.stats().failed).toBe(1);
    expect(streamer.startupSurfaceReady(10, 10)).toBe(false);
    streamer.dispose();
  });

  it("does not wait for the entire world when no manifest tile covers the starting neighborhood", () => {
    const { streamer } = setup([tile("distant", [500, 500, 600, 600])]);
    expect(streamer.startupSurfaceReady(10, 10)).toBe(true);
    expect(streamer.startupSurfaceReady(NaN, 10)).toBe(false);
    streamer.dispose();
  });
});

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
