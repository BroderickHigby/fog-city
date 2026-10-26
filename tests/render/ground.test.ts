// The renderer's indexed ground lookup must agree with the sim's groundHeight exactly,
// or cars would float above or sink into the drawn terrain.
import { describe, expect, it } from "vitest";
import { makeGroundFn, makeTerrainGroundFn } from "../../src/render/ground.ts";
import { groundHeight, heightOnField, type TileCollider } from "../../src/sim/world.ts";
import { mulberry32 } from "../../src/render/hash.ts";
import { loadWorld } from "../helpers.ts";

describe("makeGroundFn", () => {
  it("matches the sim over dev-city, including tile edges and outside the world", () => {
    const { world } = loadWorld("dev-city");
    const fn = makeGroundFn(world.tiles);
    const rnd = mulberry32(7);
    for (let i = 0; i < 4000; i++) {
      const x = -2700 + rnd() * 3400;
      const z = -1700 + rnd() * 2900;
      expect(fn(x, z)).toBe(groundHeight(world, x, z));
    }
    for (const [x, z] of [
      [-500, 0],
      [-1000, -500],
      [0, 0],
      [500, 1000],
      [-2500, -1500],
    ] as const) {
      expect(fn(x, z)).toBe(groundHeight(world, x, z));
    }
  });

  it("returns 0 where no tile has a heightfield", () => {
    const t: TileCollider = { tileId: "a", buildings: [], ground: null };
    expect(makeGroundFn([t])(10, 10)).toBe(0);
  });

  it("uses drawn terrain planes for pavement while preserving the bilinear lookup", () => {
    const ground = {x0:0,z0:0,cellSizeM:10,nx:2,nz:2,heights:[2,8,8,2]};
    const tile: TileCollider = {tileId:"saddle",ground,buildings:[]};
    const mesh = makeTerrainGroundFn([tile]);
    for (const [x,z] of [[0,0],[5,5],[2,7],[8,6],[10,10]]) expect(mesh(x!,z!)).toBe(heightOnField(ground,x!,z!));
    expect(mesh(5,5)).not.toBe(makeGroundFn([tile])(5,5));
    expect(mesh(30,30)).toBe(0);
  });

  it("lets the first tile by id win where heightfields overlap, like the sim", () => {
    const a: TileCollider = { tileId: "b", buildings: [], ground: { x0: 0, z0: 0, cellSizeM: 10, nx: 2, nz: 2, heights: [5, 5, 5, 5] } };
    const b: TileCollider = { tileId: "a", buildings: [], ground: { x0: 0, z0: 0, cellSizeM: 10, nx: 2, nz: 2, heights: [9, 9, 9, 9] } };
    expect(makeGroundFn([a, b])(5, 5)).toBe(9);
  });
});
