// three.js glue for the house kit: prepares a tile's buildings geometry for the facade shader
// (house-kit.ts prepareFacades) and attaches the per-wall and per-building attributes.

import * as THREE from "three";
import { prepareFacades, WALL_FRONT, WALL_PARTY, WALL_REAR, type FacadeMeshOut, type FrontRow, type LookFn } from "./house-kit.ts";

/**
 * Give a buildings geometry its house-kit attributes (_wall, _kit), re-order its wall triangles
 * and recolour its walls with `look`. A mesh whose walls carry no classes (the dev-city tiles and
 * the collider fallback build: every wall 0) has every wall drawn as a front. Returns null when the
 * geometry lacks what the kit reads (an index, uv and _facade).
 */
export function applyHouseKit(
  geo: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  ranges: ReadonlyArray<readonly [string, number, number]>,
  fronts: readonly FrontRow[],
  look?: LookFn,
): FacadeMeshOut | null {
  const index = geo.index;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  const uv = flat(geo, "uv");
  const fac = flat(geo, "_facade");
  if (!index || !pos || !uv || !fac || !(fac.array instanceof Uint8Array)) return null;
  if (!(index.array instanceof Uint16Array) && !(index.array instanceof Uint32Array)) return null;
  const facade = fac.array;
  let classed = false;
  for (let i = 3; i < facade.length; i += 4) {
    const w = facade[i]!;
    if (w === WALL_FRONT || w === WALL_PARTY) {
      classed = true;
      break;
    }
  }
  if (!classed) {
    for (let i = 3; i < facade.length; i += 4) if (facade[i] === WALL_REAR) facade[i] = WALL_FRONT;
    fac.needsUpdate = true;
  }
  const color = flat(geo, "color");
  const colorArr = color && (color.array instanceof Uint8Array || color.array instanceof Uint16Array || color.array instanceof Float32Array) ? color.array : null;
  const out = prepareFacades({
    index: index.array,
    position: (pos instanceof THREE.InterleavedBufferAttribute ? pos.data.array : pos.array) as ArrayLike<number>,
    positionStride: pos instanceof THREE.InterleavedBufferAttribute ? pos.data.stride : pos.itemSize,
    positionOffset: pos instanceof THREE.InterleavedBufferAttribute ? pos.offset : 0,
    matrix: matrix.elements,
    uv: uv.array as ArrayLike<number>,
    facade,
    color: colorArr,
    colorItemSize: color?.itemSize ?? 4,
    ranges: ranges.length > 0 ? ranges : [["", 0, index.count]],
    fronts,
    look,
  });
  index.needsUpdate = true;
  if (color) color.needsUpdate = true;
  geo.setAttribute("_wall", new THREE.BufferAttribute(out.wall, 4, false));
  geo.setAttribute("_kit", new THREE.BufferAttribute(out.kit, 4, false));
  return out;
}

/** A geometry attribute as a plain BufferAttribute (an interleaved one is copied out and replaced). */
function flat(geo: THREE.BufferGeometry, name: string): THREE.BufferAttribute | undefined {
  const a = geo.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (!a || !(a instanceof THREE.InterleavedBufferAttribute)) return a;
  const src = a.data.array as unknown as { constructor: new (n: number) => THREE.TypedArray } & ArrayLike<number>;
  const out = new src.constructor(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = src[i * a.data.stride + a.offset + c]!;
  const b = new THREE.BufferAttribute(out, a.itemSize, a.normalized);
  geo.setAttribute(name, b);
  return b;
}
