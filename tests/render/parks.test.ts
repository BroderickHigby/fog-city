// Park ground tint (src/render/parks.ts) and the far layer's tile grid (src/render/far-layer.ts):
// only vertices inside a park polygon (not in its holes, not at the shore) turn green; the far
// layer's terrain lattice filter keeps building hulls their colour; the committed districts
// file names every park the renderer greens.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { onFarLattice, tileGrid } from "../../src/render/far-layer.ts";
import { PARK_DISTRICTS, inPark, parkShapes, parkPavementRegions, tintParks } from "../../src/render/parks.ts";
import { createPavementMask } from "../../src/render/pavement.ts";
import type { Manifest } from "../../src/render/types.ts";
import { readJsonIfExists } from "../helpers.ts";

const doc = {
  districts: [
    {
      name: "Golden Gate Park",
      polygons: [
        [
          [[0, 0], [100, 0], [100, 100], [0, 100]],
          [[40, 40], [60, 40], [60, 60], [40, 60]],
        ],
      ],
    },
    { name: "Mission", polygons: [[[[200, 0], [300, 0], [300, 100], [200, 100]]]] },
  ],
};

describe("park tint", () => {
  const parks = parkShapes(doc);

  it("reads the park districts only, with their holes", () => {
    expect(parks).toHaveLength(1);
    expect(inPark(parks, 10, 10)).toBe(true);
    expect(inPark(parks, 50, 50)).toBe(false);
    expect(inPark(parks, 250, 50)).toBe(false);
    expect(parkShapes(null)).toEqual([]);
    expect(parkShapes({ districts: "nope" })).toEqual([]);
  });

  it("greens vertices inside the park only, leaves the shore and the hole alone", () => {
    const pts: Array<[number, number, number]> = [
      [10, 5, 10], // park
      [50, 5, 50], // hole
      [250, 5, 50], // another district
      [20, 0.2, 20], // park, at the shore
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(pts.flatMap(() => [0.5, 0.45, 0.4]), 3));
    const n = tintParks(geo, new THREE.Matrix4(), parks);
    expect(n).toBe(1);
    const c = geo.getAttribute("color");
    expect(c.getY(0)).toBeGreaterThan(c.getX(0));
    expect(c.getY(0)).toBeGreaterThan(c.getZ(0));
    for (const i of [1, 2, 3]) expect([c.getX(i), c.getY(i), c.getZ(i)].map((v) => Math.round(v * 100))).toEqual([50, 45, 40]);
  });

  it("the far layer tints only its 100 m terrain lattice, not the hulls", () => {
    expect(onFarLattice(-5600, 3, 2700)).toBe(true);
    expect(onFarLattice(-5612.5, 3, 2700)).toBe(false);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 5, 0, 12.5, 9, 30], 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 3));
    expect(tintParks(geo, new THREE.Matrix4().makeTranslation(0, 0, 0), parks, onFarLattice)).toBe(1);
  });

  it("keeps an entire paved terrain triangle neutral, including crossings between vertices", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
      10, 5, 10, 90, 5, 10, 10, 5, 30,
      10, 5, 70, 30, 5, 70, 10, 5, 90,
    ], 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(Array(6).fill([.5,.45,.4]).flat(), 3));
    // A narrow road crosses the first triangle between its vertices. The second is lawn.
    const pavement = { intersectsTriangle: (a: readonly number[], b: readonly number[], c: readonly number[]) => Math.max(a[0]!,b[0]!,c[0]!) > 50 };
    expect(tintParks(geo, new THREE.Matrix4(), parks, () => true, pavement)).toBe(3);
    const colors = geo.getAttribute("color");
    for (let i = 0; i < 3; i++) expect([colors.getX(i),colors.getY(i),colors.getZ(i)]).toEqual([.5,Math.fround(.45),Math.fround(.4)]);
    for (let i = 3; i < 6; i++) expect(colors.getY(i)).toBeGreaterThan(colors.getX(i));
    geo.dispose();
  });

  it("blocks interpolation onto paving just outside the park's own bounds", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([90,5,90,120,5,90,120,5,120],3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute([.5,.45,.4,.5,.45,.4,.5,.45,.4],3));
    const roads = {version:1,nodes:[],edges:[{id:"outside",a:"a",b:"b",kind:"residential" as const,lanes:1,oneway:false,widthM:4,points:[[108,60],[108,140]] as Array<[number,number]>}]};
    const mask = createPavementMask(roads, undefined, parkPavementRegions(parks));
    expect(tintParks(geo,new THREE.Matrix4(),parks,undefined,mask)).toBe(0);
    expect(geo.getAttribute("color").getX(0)).toBe(.5);
    geo.dispose();
  });

  it("the committed sf districts name every park the renderer greens", () => {
    const sf = readJsonIfExists<{ districts: Array<{ name: string }> }>("public/tiles/sf/districts.json");
    if (!sf) return;
    const names = sf.districts.map((d) => d.name);
    for (const p of PARK_DISTRICTS) expect(names, p).toContain(p);
    expect(parkShapes(sf).length).toBeGreaterThanOrEqual(PARK_DISTRICTS.length);
  });
});

describe("far layer tile grid", () => {
  it("one mask texel per manifest tile, from ix/iz or the bbox", () => {
    const m = {
      version: 1,
      world: "w",
      spawn: { x: 0, z: 0, heading: 0 },
      tiles: [
        { id: "t-2_3", ix: -2, iz: 3, collider: "", glb: null },
        { id: "t1_5", collider: "", glb: null, bbox: [500, 2500, 1000, 3000] },
      ],
    } as Manifest;
    const g = tileGrid(m);
    expect([g.ix0, g.iz0, g.nx, g.nz]).toEqual([-2, 3, 4, 3]);
    expect(g.index.get("t-2_3")).toBe(0);
    expect(g.index.get("t1_5")).toBe(2 * 4 + 3);
  });
});
