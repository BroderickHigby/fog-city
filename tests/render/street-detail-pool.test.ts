// Street-detail cells share draws (src/render/street-detail.ts, instance-pool.ts): however many
// cells stream in and out, the layer keeps one InstancedMesh per kind, because every new
// InstancedMesh is a new shader build in the node renderer. Blades share the atlas pages'
// materials. No browser.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { StreetDetailLayer } from "../../src/render/street-detail.ts";
import { BladeAtlas, MAX_PAGES, PAGE_ROWS } from "../../src/render/street-signs.ts";

/** Six cells in a row along x (200 m cells), each with signals, stop signs, signs, shops and a palm. */
function docs(): Record<string, unknown> {
  const xs = [0, 1, 2, 3, 4, 5].map(k => 100 + 200 * k);
  return {
    "w/street-detail.json": { layers: { furniture: "f.json", signs: "s.json", storefronts: "shop.json", trees: "t.json" } },
    "w/f.json": {
      signals: xs.map((x, k) => ({ id: `sig:n${k}:e`, node: `n${k}`, x, z: 100, heading: 0, group: 0, arm: k % 2 ? 6 : 0, ped: Math.PI })),
      stopSigns: xs.map((x, k) => ({ id: `stop:${k}`, node: `m${k}`, x: x + 20, z: 100, heading: 1, allWay: k % 2 === 0 })),
    },
    "w/s.json": {
      corners: xs.map((x, k) => ({ id: `c${k}`, x: x + 30, z: 100, blades: [{ name: `STREET ${k} ST`, heading: 0 }, { name: "MARKET ST", heading: 1.5 }], oneWay: [0] })),
      curb: xs.map((x, k) => ({ id: `curb${k}`, x: x + 40, z: 100, heading: 0, kind: k % 2 ? "tow" : "cleaning" })),
    },
    "w/shop.json": { storefronts: xs.map((x, k) => ({ id: `shop${k}`, x: x + 50, z: 100, heading: 0, category: k % 2 ? "bar" : "barber" })) },
    "w/t.json": { classes: ["broadleaf", "conifer", "palm"], trees: xs.map((x, k) => [k, x + 60, 100, 2, 9]) },
  };
}

function layer(): StreetDetailLayer {
  const files = docs();
  return new StreetDetailLayer({ base: "w/", json: async <T>(path: string) => { if (!(path in files)) throw new Error(`absent ${path}`); return files[path] as T; }, ground: () => 2, materials: createSharedMaterials() });
}
function settle(l: StreetDetailLayer, x: number, tick = 0): void { for (let i = 0; i < 200; i++) { l.update(x, 100, tick, 0); if (i > 1 && l.settled()) return; } throw new Error("street detail did not settle"); }
function instanced(root: THREE.Object3D): Set<THREE.InstancedMesh> {
  const out = new Set<THREE.InstancedMesh>();
  root.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) out.add(o as THREE.InstancedMesh); });
  return out;
}

describe("street detail shared draws", () => {
  it("keeps one InstancedMesh per kind while cells stream in and out", async () => {
    const l = layer();
    await l.load();
    settle(l, 100);
    const first = instanced(l.group), cells = l.info().cellsBuilt;
    expect(cells).toBeGreaterThanOrEqual(3);
    expect(first.size).toBeLessThanOrEqual(l.poolInfo().meshes);
    // Each kind holds every built cell's instances: one signal pole or mast per cell.
    const signals = [...first].filter(m => m.name === "signal poles" || m.name === "signal mast poles").reduce((n, m) => n + m.count, 0);
    expect(signals).toBe(l.info().signals);
    settle(l, 1100);
    settle(l, 100);
    const again = instanced(l.group);
    expect(l.info().cellsBuilt).toBeGreaterThanOrEqual(cells);
    // The same mesh objects: no new InstancedMesh, so no new shader build.
    for (const mesh of again) expect(first.has(mesh)).toBe(true);
    expect(l.poolInfo().grown).toBe(0);
    l.dispose();
  });

  it("lights pooled signal lenses from the sim tick", async () => {
    const l = layer();
    await l.load();
    settle(l, 100, 0);
    const lenses = [...instanced(l.group)].find(m => m.name === "signal lenses")!;
    const c = new THREE.Color();
    let lit = 0;
    for (let i = 0; i < lenses.count; i++) { lenses.getColorAt(i, c); if (c.r + c.g + c.b > .5) lit++; }
    // Each head shows one aspect and each ped head one of walk/hand.
    expect(lit).toBeGreaterThan(0);
    l.dispose();
  });

  it("draws every cell's blades with the shared atlas pages' materials", async () => {
    const l = layer();
    await l.load();
    settle(l, 1100);
    const materials = new Set<THREE.Material>();
    l.group.traverse(o => { if (o.name === "street-name blades") materials.add((o as THREE.Mesh).material as THREE.Material); });
    expect(materials.size).toBeGreaterThan(0);
    expect(materials.size).toBeLessThanOrEqual(2);
    expect(l.info().blades).toBe(2 * l.info().signPosts);
    l.dispose();
  });
});

describe("street-name atlas", () => {
  it("draws a name once, shares its row, and reuses the oldest free row first", () => {
    const atlas = new BladeAtlas(null);
    const a = atlas.acquire("A ST")!, again = atlas.acquire("A ST")!;
    expect(again).toBe(a);
    expect(atlas.drawn).toBe(1);
    const names = Array.from({ length: PAGE_ROWS * MAX_PAGES - 1 }, (_, i) => `N${i}`);
    const slots = names.map(n => atlas.acquire(n)!);
    expect(atlas.pageCount).toBe(MAX_PAGES);
    expect(atlas.acquire("FULL")).toBeNull();
    atlas.release(slots[5]!); atlas.release(slots[2]!);
    const reused = atlas.acquire("NEW ST")!;
    expect([reused.page, reused.row]).toEqual([slots[5]!.page, slots[5]!.row]);
    // "A ST" was acquired twice: one release leaves it held, so it is not reused.
    atlas.release(a);
    expect(atlas.acquire("B ST")).toMatchObject({ page: slots[2]!.page, row: slots[2]!.row });
    expect(atlas.material(0)).toBe(atlas.material(0));
  });
});
