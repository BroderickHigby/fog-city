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

  it("keeps turf and blades out of the actual carriageway and building footprint", () => {
    const roads: RoadGraph = { version: 1, nodes: [], edges: [{ id: "r", a: "a", b: "b", kind: "residential", widthM: 4, lanes: 1, oneway: false, points: [[10, -20], [10, 40]] }] };
    const footprint: Array<[number, number]> = [[1, 1], [6, 1], [6, 6], [1, 6]];
    const tile: TileCollider = { tileId: "t", ground: null, buildings: [{ id: "b", baseY: 2, topY: 20, footprint }] };
    const l = new GrassLayer({ ground: () => 2, roads, colliders: new Map([["t", tile]]) }); l.setData(doc()); settle(l);
    for (const name of ["grass-surface", "grass-blades"]) {
      expect(centres(mesh(l, name).geometry).every(([x, z]) => (x < 7.75001 || x > 12.24999) && !pointInPolygon(x, z, footprint))).toBe(true);
    }
    expect(area(mesh(l, "grass-surface").geometry)).toBeCloseTo(400 - 90 - 25, 3);
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
    expect(l.info().blades).toBe(GRASS_BLADE_CAP);
    expect(l.info().surfaceTriangles).toBeLessThanOrEqual(GRASS_SURFACE_CAP);
    expect(l.info().drawCalls).toBe(2);
    l.dispose();
  });
});
