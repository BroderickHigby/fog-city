import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GrassLayer, GRASS_BLADE_CAP, GRASS_SURFACE_CAP, grassShapes, subtractGrassMask } from "../../src/render/grass.ts";
import { heightOnField, pointInPolygon, type TileCollider } from "../../src/sim/world.ts";
import type { RoadGraph } from "../../src/render/types.ts";

const ring = [0, 0, 20, 0, 20, 20, 0, 20];
const doc = (rings: number[][] = [ring]) => ({ grass: [{ id: "lawn:one", kind: "lawn", rings }] });
const mesh = (l: GrassLayer, name: string) => l.group.getObjectByName(name) as THREE.Mesh;
function settle(l: GrassLayer, x = 10, z = 10): void { for (let i = 0; i < 3000; i++) { l.update(x, z, 2); if (l.settled()) return; } throw new Error("grass did not settle"); }
const flat = (): GrassLayer => new GrassLayer({ ground: () => 2 });
function centres(g: THREE.BufferGeometry): Array<[number, number]> {
  const pos = g.getAttribute("position"), out: Array<[number, number]> = [];
  for (let i = 0; i < pos.count; i += 3) out.push([(pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3]);
  return out;
}
function area(g: THREE.BufferGeometry): number {
  const p = g.getAttribute("position"); let a = 0;
  for (let i = 0; i < p.count; i += 3) a += Math.abs((p.getX(i + 1) - p.getX(i)) * (p.getZ(i + 2) - p.getZ(i)) - (p.getZ(i + 1) - p.getZ(i)) * (p.getX(i + 2) - p.getX(i))) / 2;
  return a;
}

describe("DataSF grass", () => {
  it("reads finite literal lawn polygons and keeps holes; malformed/unknown kinds stay absent", () => {
    expect(grassShapes(null)).toEqual([]);
    expect(grassShapes({ grass: [{ id: "x", kind: "meadow", rings: [ring] }] })).toEqual([]);
    expect(grassShapes(doc([[0, 0, Infinity, 3, 4, 0]]))).toEqual([]);
    expect(grassShapes(doc([[0, 0, 500, 0, 500, 500, 0, 500]]))).toEqual([]);
    expect(grassShapes(doc([ring, [5, 5, 15, 5, 15, 15, 5, 15]]))[0]!.rings).toHaveLength(2);
  });

  it("subtracts road-shaped masks in either winding without overlapping output", () => {
    const square: Array<[number, number]> = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const cut: Array<[number, number]> = [[8, -10], [12, -10], [12, 30], [8, 30]];
    for (const mask of [cut, [...cut].reverse()]) {
      const pieces = subtractGrassMask(square, mask);
      expect(pieces).toHaveLength(2);
      expect(pieces.every(p => p.every(v => v[0] <= 8.00001 || v[0] >= 11.99999))).toBe(true);
    }
  });

  it("exactly retains polygon holes and the surrounding lawn area", () => {
    const l = flat(); l.setData(doc([ring, [5, 5, 15, 5, 15, 15, 5, 15]])); settle(l);
    const g = mesh(l, "grass-surface").geometry;
    expect(area(g)).toBeCloseTo(300, 3);
    expect(centres(g).every(([x, z]) => !(x > 5 && x < 15 && z > 5 && z < 15))).toBe(true);
    expect(l.info().blades).toBeGreaterThan(0);
    l.dispose();
  });

  it("keeps turf and every blade vertex out of raised sidewalks, carriageways and buildings", () => {
    const roads: RoadGraph = { version: 1, nodes: [], edges: [{ id: "r", a: "a", b: "b", kind: "residential", widthM: 4, lanes: 1, oneway: false, points: [[10, -20], [10, 40]] }] };
    const footprint: Array<[number, number]> = [[1, 1], [6, 1], [6, 6], [1, 6]];
    const tile: TileCollider = { tileId: "t", ground: null, buildings: [{ id: "b", baseY: 2, topY: 20, footprint }] };
    const l = new GrassLayer({ ground: () => 2, roads, colliders: new Map([["t", tile]]) }); l.setData(doc()); settle(l);
    for (const name of ["grass-surface", "grass-blades"]) {
      expect(centres(mesh(l, name).geometry).every(([x, z]) => (x < 4.75001 || x > 15.24999) && !pointInPolygon(x, z, footprint))).toBe(true);
      const p = mesh(l, name).geometry.getAttribute("position");
      for (let i = 0; i < p.count; i++) expect(p.getX(i) < 4.75001 || p.getX(i) > 15.24999).toBe(true);
    }
    expect(area(mesh(l, "grass-surface").geometry)).toBeCloseTo(171.25, 3);
    l.dispose();
  });

  it("follows each real heightfield triangle instead of bridging bilinear saddle terrain", () => {
    const ground = { x0: 0, z0: 0, nx: 3, nz: 3, cellSizeM: 10, heights: [2, 5, 2, 5, 2, 5, 2, 5, 2] };
    const l = new GrassLayer({ ground: () => 99, colliders: new Map([["t", { tileId: "t", ground, buildings: [] }]]) }); l.setData(doc()); settle(l);
    const p = mesh(l, "grass-surface").geometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(heightOnField(ground, p.getX(i), p.getZ(i)) + .018, 4);
    for (let i = 0; i < p.count; i += 3) {
      const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
      const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      expect(y).toBeCloseTo(heightOnField(ground, x, z) + .018, 4);
    }
    l.dispose();
  });

  it("excludes water and malformed/missing optional data without blocking streaming", () => {
    const l = new GrassLayer({ ground: () => 0 }); expect(l.settled()).toBe(true); l.setData(doc()); settle(l);
    expect(l.info()).toMatchObject({ loaded: true, patches: 0, blades: 0, surfaceTriangles: 0, drawCalls: 0, pending: false });
    l.setData(null); settle(l); expect(l.info().areas).toBe(0); l.dispose();
  });

  it("is deterministic, bounded, incremental and disposes replaced geometry", () => {
    const l = flat(), other = flat(); l.setData(doc()); other.setData(doc());
    l.update(10, 10, 0); expect(l.info().pending).toBe(true);
    settle(l); settle(other);
    expect(Array.from(mesh(l, "grass-blades").geometry.getAttribute("position").array)).toEqual(Array.from(mesh(other, "grass-blades").geometry.getAttribute("position").array));
    expect(l.info().surfaceTriangles).toBeLessThanOrEqual(GRASS_SURFACE_CAP); expect(l.info().blades).toBeLessThanOrEqual(GRASS_BLADE_CAP); expect(l.info().drawCalls).toBe(2);
    const g = mesh(l, "grass-surface").geometry; let disposed = false; g.addEventListener("dispose", () => { disposed = true; });
    settle(l, 5000, 5000); expect(disposed).toBe(true); expect(l.info().drawCalls).toBe(0);
    settle(l); expect(l.info().patches).toBe(1); expect(l.group.children).toHaveLength(2);
    l.dispose(); other.dispose(); expect(l.group.parent).toBeNull();
  });

  it("caps dense nearby blades and lawn pieces independently of input size", () => {
    const grass = Array.from({ length: 110 }, (_, i) => {
      const x = (i % 11) * 22 - 110, z = Math.floor(i / 11) * 22 - 100;
      return { id: `lawn:${i}`, kind: "lawn", rings: [[x, z, x + 20, z, x + 20, z + 20, x, z + 20]] };
    });
    const l = flat(); l.setData({ grass }); settle(l, 0, 0);
    expect(l.info().patches).toBe(96);
    expect(l.info().bladeTriangles).toBeGreaterThan(GRASS_BLADE_CAP - 6);
    expect(l.info().bladeTriangles).toBeLessThanOrEqual(GRASS_BLADE_CAP);
    expect(l.info().blades).toBe(l.info().bladeTriangles / 2);
    expect(l.info().surfaceTriangles).toBeLessThanOrEqual(GRASS_SURFACE_CAP);
    expect(l.info().drawCalls).toBe(2);
    l.dispose();
  });

  it("finishes its global obstacle index while the camera keeps changing neighborhoods", () => {
    const roads: RoadGraph = { version: 1, nodes: [], edges: Array.from({ length: 5000 }, (_, i) => ({
      id: `r${i}`, a: "a", b: "b", kind: "residential", widthM: 4, lanes: 1, oneway: false, points: [[1000 + i * .01, 1000], [1000 + i * .01, 1001]] as Array<[number, number]>,
    })) };
    const l = new GrassLayer({ ground: () => 2, roads }); l.setData(doc());
    // Every thirty zero-budget calls the old combined task restarted before its 40+ index
    // yields finished. Camera-independent preprocessing must retain that progress.
    for (let i = 0; i < 150; i++) l.update(Math.floor(i / 30) % 2 ? 31 : 10, 10, 0);
    expect(l.info()).toMatchObject({ pending: false, patches: 1 });
    expect(l.info().surfaceTriangles).toBeGreaterThan(0);
    l.dispose();
  });

  it("re-assembles a camera move from its per-lawn cache, as a fresh build would", () => {
    const grass = Array.from({ length: 110 }, (_, i) => {
      const x = (i % 11) * 22 - 110, z = Math.floor(i / 11) * 22 - 100;
      return { id: `lawn:${i}`, kind: "lawn", rings: [[x, z, x + 20, z, x + 20, z + 20, x, z + 20]] };
    });
    const moved = flat(), fresh = flat();
    moved.setData({ grass }); fresh.setData({ grass });
    settle(moved, 0, 0); settle(moved, 60, 30); settle(fresh, 60, 30);
    for (const name of ["grass-surface", "grass-blades"]) for (const attr of ["position", "color", "normal"]) {
      expect(Array.from(mesh(moved, name).geometry.getAttribute(attr).array), `${name} ${attr}`).toEqual(Array.from(mesh(fresh, name).geometry.getAttribute(attr).array));
    }
    expect(moved.info()).toMatchObject({ patches: fresh.info().patches, blades: fresh.info().blades });
    // One lawn, all cached: a 25 m move only re-assembles (the blades, then their copy into the
    // mesh), two zero-budget updates, and builds nothing.
    const one = flat(); one.setData(doc()); settle(one);
    const cached = one.info().cachedLawns;
    one.update(35, 10, 0);
    one.update(35, 10, 0);
    expect(one.settled()).toBe(true);
    expect(one.info().cachedLawns).toBe(cached);
    expect(one.info().blades).toBeGreaterThan(0);
    moved.dispose(); fresh.dispose(); one.dispose();
  });

  it("spreads the assembly over frames under a zero budget and still ends with the same meshes", () => {
    const grass = Array.from({ length: 110 }, (_, i) => {
      const x = (i % 11) * 22 - 110, z = Math.floor(i / 11) * 22 - 100;
      return { id: `lawn:${i}`, kind: "lawn", rings: [[x, z, x + 20, z, x + 20, z + 20, x, z + 20]] };
    });
    const slow = flat(), fast = flat();
    slow.setData({ grass }); fast.setData({ grass });
    for (let i = 0; i < 20000; i++) { slow.update(0, 0, 0); if (slow.settled()) break; }
    settle(fast, 0, 0);
    // A 20 m move with every lawn cached: the re-assembly takes several zero-budget frames.
    let frames = 0;
    do { slow.update(20, 5, 0); frames++; } while (!slow.settled() && frames < 1000);
    expect(slow.settled()).toBe(true);
    expect(frames).toBeGreaterThan(1);
    // Moving again half way through an assembly starts it over from the new place.
    slow.update(0, 0, 0); slow.update(0, 0, 0);
    expect(slow.settled()).toBe(false);
    slow.update(-30, 10, 0);
    for (let i = 0; i < 1000 && !slow.settled(); i++) slow.update(-30, 10, 0);
    settle(fast, -30, 10);
    for (const name of ["grass-surface", "grass-blades"]) for (const attr of ["position", "color", "normal"]) {
      expect(Array.from(mesh(slow, name).geometry.getAttribute(attr).array), `${name} ${attr}`).toEqual(Array.from(mesh(fast, name).geometry.getAttribute(attr).array));
    }
    expect(slow.info()).toMatchObject({ patches: fast.info().patches, blades: fast.info().blades });
    slow.dispose(); fast.dispose();
  });

  it("draws short bent leaves in small tufts with separate leaf and triangle counts", () => {
    const l = flat(); l.setData(doc()); settle(l);
    const g = mesh(l, "grass-blades").geometry, p = g.getAttribute("position"), roots = g.getAttribute("_grassRoot");
    expect(l.info().blades).toBeGreaterThan(0);
    expect(l.info().bladeTriangles).toBe(l.info().blades * 2);
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i) - roots.getX(i)).toBeLessThanOrEqual(.10001);
      expect(p.getY(i) - roots.getX(i)).toBeGreaterThanOrEqual(-.00301);
    }
    l.dispose();
  });
});
