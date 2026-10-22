// What a streamed tile adds to its ground beyond the pipeline's mesh, built from the tile's
// heightfield (the collider pack's, or a collider JSON's) once when the tile loads:
//
//  - Lakes (W-11): the inland lakes the pipeline flattened to their level (the pack's LAKE mask,
//    or a collider JSON's ground.cover digits) are drawn as water at that level with the water
//    shader, never as ground. One quad per lattice cell with a lake corner, a few centimetres over
//    the flattened ground, so the rising bank cuts the shore line out of it by depth.
//  - Skirts (W-17, W-40): a curtain hanging from every land border of the tile's ground. Where the
//    streaming ring stops, the far terrain meets the near ground's border from below (the pipeline
//    lowers it 0.5 m and shares the border's samples), so a ray that would slip through the crack
//    between them, or under a tile whose neighbour is not drawn yet, finds the curtain instead of
//    the sea plane far below.
//
// Pure geometry (world coordinates, no transform), deterministic; tests/render/ground-extras.test.ts.

import type { Heightfield } from "../sim/world.ts";

/** A lake is drawn this far over its flattened ground (the ground there is the lake's level). */
export const LAKE_LIFT_M = 0.06;
/** How far a skirt hangs below the border it follows. */
export const SKIRT_DEPTH_M = 40;
/** Border samples at or below this height are the sea: the sea plane shows there, no skirt. */
export const SEA_Y = 0.02;

/** A heightfield as the renderer gets it: the pack's lake mask, or a collider JSON's cover string. */
export type CoverHeightfield = Heightfield & { lake?: ArrayLike<number>; cover?: string };

export interface SimpleMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface ColoredMesh extends SimpleMesh {
  colors: Float32Array;
}

/** 1 where a sample is an inland lake's water. Null when the tile has no lake. */
export function lakeMask(g: CoverHeightfield): Uint8Array | null {
  const n = g.nx * g.nz;
  const out = new Uint8Array(n);
  let any = false;
  if (g.lake && g.lake.length === n) {
    for (let i = 0; i < n; i++) if (g.lake[i]) out[i] = 1;
  } else if (typeof g.cover === "string" && g.cover.length === n) {
    for (let i = 0; i < n; i++) {
      const c = g.cover.charCodeAt(i);
      if (c >= 48 && c <= 57) out[i] = 1;
    }
  }
  for (let i = 0; i < n && !any; i++) any = out[i] === 1;
  return any ? out : null;
}

/** The lake surfaces of a tile: a quad per cell with a lake corner, at that lake's level. Null when none. */
export function lakeSurface(g: CoverHeightfield): SimpleMesh | null {
  const mask = lakeMask(g);
  if (!mask) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  const { nx, nz, x0, z0, cellSizeM: c } = g;
  for (let k = 0; k + 1 < nz; k++) {
    for (let i = 0; i + 1 < nx; i++) {
      let level = -Infinity;
      for (const s of [k * nx + i, k * nx + i + 1, (k + 1) * nx + i, (k + 1) * nx + i + 1]) {
        if (mask[s]) level = Math.max(level, g.heights[s] ?? 0);
      }
      if (level === -Infinity) continue;
      const y = level + LAKE_LIFT_M;
      const xa = x0 + i * c;
      const za = z0 + k * c;
      const v = pos.length / 3;
      pos.push(xa, y, za, xa + c, y, za, xa, y, za + c, xa + c, y, za + c);
      // Counter-clockwise seen from above (+y up, +z south): faces up.
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  return { positions: new Float32Array(pos), normals, indices: new Uint32Array(idx) };
}

/** Linear RGB of a skirt: the colour of cut earth. */
const SKIRT_TOP: readonly [number, number, number] = [0.2, 0.17, 0.13];
const SKIRT_BOTTOM: readonly [number, number, number] = [0.08, 0.07, 0.06];

/**
 * Curtains hanging SKIRT_DEPTH_M from the four borders of a tile's ground, wherever the border is
 * land (a segment with both ends on the sea is left open: the sea plane is the surface there).
 * Each quad's top edge is exactly the border's samples, so it meets the ground mesh's edge.
 * Normals face out of the tile; the material draws both sides.
 */
export function groundSkirt(g: Heightfield, depthM = SKIRT_DEPTH_M): ColoredMesh | null {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const { nx, nz, x0, z0, cellSizeM: c } = g;
  if (nx < 2 || nz < 2) return null;
  const h = (i: number, k: number): number => g.heights[k * nx + i] ?? 0;
  const side = (pts: Array<[number, number, number]>, out: [number, number]): void => {
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s]!;
      const b = pts[s + 1]!;
      if (a[1] <= SEA_Y && b[1] <= SEA_Y) continue;
      const v = pos.length / 3;
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], a[0], a[1] - depthM, a[2], b[0], b[1] - depthM, b[2]);
      for (let q = 0; q < 4; q++) nrm.push(out[0], 0, out[1]);
      col.push(...SKIRT_TOP, ...SKIRT_TOP, ...SKIRT_BOTTOM, ...SKIRT_BOTTOM);
      // Front faces look out of the tile: (b - a) x down has the outward sign.
      const outward = (b[2] - a[2]) * out[0] - (b[0] - a[0]) * out[1];
      if (outward >= 0) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      else idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  };
  const north: Array<[number, number, number]> = [];
  const south: Array<[number, number, number]> = [];
  for (let i = 0; i < nx; i++) {
    north.push([x0 + i * c, h(i, 0), z0]);
    south.push([x0 + i * c, h(i, nz - 1), z0 + (nz - 1) * c]);
  }
  const west: Array<[number, number, number]> = [];
  const east: Array<[number, number, number]> = [];
  for (let k = 0; k < nz; k++) {
    west.push([x0, h(0, k), z0 + k * c]);
    east.push([x0 + (nx - 1) * c, h(nx - 1, k), z0 + k * c]);
  }
  side(north, [0, -1]);
  side(south, [0, 1]);
  side(west, [-1, 0]);
  side(east, [1, 0]);
  if (idx.length === 0) return null;
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), colors: new Float32Array(col), indices: new Uint32Array(idx) };
}
