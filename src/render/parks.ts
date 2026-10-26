// Green parks: the ground of the city's big parks (Golden Gate Park, the Presidio, McLaren Park,
// Lincoln Park, from districts.json's neighbourhood polygons) tinted grass green, on the
// streamed tiles' ground and on the far-LOD terrain. The pipeline colours all land one warm
// grey, which made Golden Gate Park read as a desert.
//
// Pure geometry work on vertex colours (COLOR_0), once per tile when it loads; nothing per frame.

import * as THREE from "three";

/** District names (districts.json `name`) whose ground is park. */
export const PARK_DISTRICTS: readonly string[] = ["Golden Gate Park", "Presidio", "McLaren Park", "Lincoln Park"];

/** Linear-space grass colours, mixed per vertex for a little variation. */
const GRASS_A = new THREE.Color(0x4a8a36).convertSRGBToLinear();
const GRASS_B = new THREE.Color(0x5e9842).convertSRGBToLinear();
/** How far a park vertex moves toward the grass colour. */
const TINT = 0.9;
/** Vertices this close to sea level are water or beach: left alone. */
const SHORE_Y = 1.5;

interface Ring {
  pts: Array<[number, number]>;
}

export interface ParkShape {
  bbox: [number, number, number, number];
  outer: Ring;
  holes: Ring[];
}

interface DistrictsDoc {
  districts?: Array<{ name?: string; polygons?: Array<Array<Array<[number, number]>>> }>;
}

/** The park polygons of a districts.json document (empty when absent or malformed). */
export function parkShapes(doc: unknown, names: readonly string[] = PARK_DISTRICTS): ParkShape[] {
  const out: ParkShape[] = [];
  const list = (doc as DistrictsDoc | null)?.districts;
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    if (!d.name || !names.includes(d.name) || !Array.isArray(d.polygons)) continue;
    for (const poly of d.polygons) {
      if (!Array.isArray(poly) || poly.length === 0) continue;
      const outer = poly[0]!;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of outer) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      out.push({ bbox: [minX, minZ, maxX, maxZ], outer: { pts: outer }, holes: poly.slice(1).map((pts) => ({ pts })) });
    }
  }
  return out;
}

function inRing(x: number, z: number, pts: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!;
    const [xj, zj] = pts[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Is (x, z) inside any park? */
export function inPark(parks: readonly ParkShape[], x: number, z: number): boolean {
  for (const p of parks) {
    const b = p.bbox;
    if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
    if (!inRing(x, z, p.outer.pts)) continue;
    if (p.holes.some((h) => inRing(x, z, h.pts))) continue;
    return true;
  }
  return false;
}

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Tint the vertex colours of a ground mesh inside the parks. `only` filters vertices (world
 * position): the far layer passes its terrain lattice test so building hulls keep their colour.
 * Returns how many vertices changed.
 */
export function tintParks(
  geo: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  parks: readonly ParkShape[],
  only: (x: number, y: number, z: number) => boolean = () => true,
): number {
  if (parks.length === 0) return 0;
  const pos = geo.getAttribute("position");
  const col = geo.getAttribute("color");
  if (!pos || !col) return 0;
  // Quick reject: the mesh's bounds against every park's box.
  geo.computeBoundingBox();
  const box = geo.boundingBox!.clone().applyMatrix4(matrixWorld);
  if (!parks.some((p) => !(box.max.x < p.bbox[0] || box.min.x > p.bbox[2] || box.max.z < p.bbox[1] || box.min.z > p.bbox[3]))) return 0;
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
    if (_v.y < SHORE_Y || !only(_v.x, _v.y, _v.z) || !inPark(parks, _v.x, _v.z)) continue;
    // A stable per-vertex mix of the two greens.
    const h = Math.abs(Math.sin(_v.x * 0.0123 + _v.z * 0.0371) * 43758.5453) % 1;
    _c.fromBufferAttribute(col as THREE.BufferAttribute, i);
    _c.lerp(h < 0.5 ? GRASS_A : GRASS_B, TINT);
    col.setXYZ(i, _c.r, _c.g, _c.b);
    n++;
  }
  if (n > 0) col.needsUpdate = true;
  return n;
}
