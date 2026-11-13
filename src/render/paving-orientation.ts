// Which way the pavement's joints run: a coarse map of the city that stores, for each 12 m cell,
// the direction of the nearest street (modulo 90 degrees, so a corner of two crossing streets on
// the same grid agrees). The paving shader (node-materials.ts pavingSurface) turns its slab grid
// to it, so sidewalk and plaza joints run along and across the kerb instead of the compass.
// Built once from the road graph at load; render-only.
import * as THREE from "three";

export interface OrientationRoads {
  nodes: readonly { id: string; x: number; z: number }[];
  edges: readonly { a: string; b: string; points?: readonly (readonly number[])[] }[];
}

export interface PavingOrientation {
  texture: THREE.DataTexture;
  /** World x and z of the map's corner, metres. */
  originX: number;
  originZ: number;
  /** Map size in metres. */
  sizeX: number;
  sizeZ: number;
  cellM: number;
}

export const ORIENTATION_CELL_M = 12;

/**
 * Street direction per cell, in whole degrees 0-89, as bytes. Pure: tests call it directly.
 * `cells` is filled from each street segment outward, then into the gaps (plazas, parks, blocks)
 * from the nearest filled cell, so every cell has a direction.
 */
export function orientationGrid(roads: OrientationRoads, cellM = ORIENTATION_CELL_M): { data: Uint8Array; w: number; h: number; x0: number; z0: number } {
  const nodes = new Map(roads.nodes.map((n) => [n.id, n]));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const n of roads.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); z0 = Math.min(z0, n.z); z1 = Math.max(z1, n.z); }
  if (!Number.isFinite(x0)) return { data: new Uint8Array(1), w: 1, h: 1, x0: 0, z0: 0 };
  x0 -= 200; z0 -= 200; x1 += 200; z1 += 200;
  const w = Math.max(1, Math.ceil((x1 - x0) / cellM)), h = Math.max(1, Math.ceil((z1 - z0) / cellM));
  const dist = new Float32Array(w * h).fill(Infinity);
  const angle = new Uint8Array(w * h);
  const reach = 24;
  const stamp = (ax: number, az: number, bx: number, bz: number): void => {
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return;
    let deg = Math.round(Math.atan2(dx, -dz) * 180 / Math.PI);
    deg = ((deg % 90) + 90) % 90;
    const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cellM)), cx1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cellM));
    const cz0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / cellM)), cz1 = Math.min(h - 1, Math.floor((Math.max(az, bz) + reach - z0) / cellM));
    for (let cz = cz0; cz <= cz1; cz++) {
      const pz = z0 + (cz + 0.5) * cellM;
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = x0 + (cx + 0.5) * cellM;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
        const ex = ax + dx * t - px, ez = az + dz * t - pz, d = Math.hypot(ex, ez);
        const i = cz * w + cx;
        if (d < dist[i]!) { dist[i] = d; angle[i] = deg; }
      }
    }
  };
  for (const e of roads.edges) {
    const pts = e.points && e.points.length >= 2 ? e.points
      : [nodes.get(e.a), nodes.get(e.b)].every(Boolean) ? [[nodes.get(e.a)!.x, nodes.get(e.a)!.z], [nodes.get(e.b)!.x, nodes.get(e.b)!.z]] : [];
    for (let k = 1; k < pts.length; k++) stamp(pts[k - 1]![0]!, pts[k - 1]![1]!, pts[k]![0]!, pts[k]![1]!);
  }
  // Fill the rest from the nearest stamped cell: two chamfer sweeps carrying the direction along.
  const step = cellM, diag = cellM * Math.SQRT2;
  const relax = (i: number, j: number, cost: number): void => {
    if (dist[j]! + cost < dist[i]!) { dist[i] = dist[j]! + cost; angle[i] = angle[j]!; }
  };
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x;
    if (x > 0) relax(i, i - 1, step);
    if (z > 0) { relax(i, i - w, step); if (x > 0) relax(i, i - w - 1, diag); if (x < w - 1) relax(i, i - w + 1, diag); }
  }
  for (let z = h - 1; z >= 0; z--) for (let x = w - 1; x >= 0; x--) {
    const i = z * w + x;
    if (x < w - 1) relax(i, i + 1, step);
    if (z < h - 1) { relax(i, i + w, step); if (x < w - 1) relax(i, i + w + 1, diag); if (x > 0) relax(i, i + w - 1, diag); }
  }
  return { data: angle, w, h, x0, z0 };
}

/** The orientation map as a texture the paving shader samples (nearest: a cell is one direction). */
export function buildPavingOrientation(roads: OrientationRoads): PavingOrientation {
  const g = orientationGrid(roads);
  const texture = new THREE.DataTexture(g.data, g.w, g.h, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, originX: g.x0, originZ: g.z0, sizeX: g.w * ORIENTATION_CELL_M, sizeZ: g.h * ORIENTATION_CELL_M, cellM: ORIENTATION_CELL_M };
}

let active: PavingOrientation | null = null;
/** The map paving materials built from now on turn their joints to; null keeps the compass grid. */
export function setPavingOrientation(o: PavingOrientation | null): void { active = o; }
export function pavingOrientation(): PavingOrientation | null { return active; }
