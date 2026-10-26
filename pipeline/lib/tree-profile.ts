import type * as THREE from "three";

/** Conservative radial extent of rendered tree triangles in local-height bands. */
export interface TreeProfile {
  readonly minY: number;
  readonly maxY: number;
  readonly radius: number;
  radiusBetween(low: number, high: number): number | null;
}

const CACHE_LIMIT = 128;

class TriangleProfile implements TreeProfile {
  readonly minY: number;
  readonly maxY: number;
  readonly radius: number;
  private readonly triangles: Float64Array;
  private readonly bands = new Map<string, number | null>();

  constructor(triangles: Float64Array, minY: number, maxY: number, radius: number) {
    this.triangles = triangles;
    this.minY = minY;
    this.maxY = maxY;
    this.radius = radius;
  }

  radiusBetween(low: number, high: number): number | null {
    if (Number.isNaN(low) || Number.isNaN(high) || low > high) throw new RangeError("Invalid tree height band");
    if (!this.triangles.length || high < this.minY || low > this.maxY) return null;
    // Exact keys preserve null in gaps between triangles. Clamping also makes
    // unbounded queries safe and lets equivalent outside ranges share a result.
    const start = Math.max(low, this.minY);
    const end = Math.min(high, this.maxY);
    const key = `${start}:${end}`;
    if (this.bands.has(key)) return this.bands.get(key)!;
    let radius: number | null = null;
    const triangles = this.triangles;
    for (let i = 0; i < triangles.length; i += 3) {
      if (triangles[i]! <= end && triangles[i + 1]! >= start) radius = Math.max(radius ?? 0, triangles[i + 2]!);
    }
    if (this.bands.size >= CACHE_LIMIT) this.bands.delete(this.bands.keys().next().value!);
    this.bands.set(key, radius);
    return radius;
  }
}

/**
 * Snapshot only numeric triangle bounds. Geometry, GPU buffers and their ownership stay
 * with the caller. Combining near and far LODs prevents a lower far crown entering a lane.
 */
export function treeProfile(geometries: readonly THREE.BufferGeometry[]): TreeProfile {
  let capacity = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (position) capacity += Math.floor((geometry.getIndex()?.count ?? position.count) / 3);
  }
  const triangles = new Float64Array(capacity * 3);
  let used = 0, minY = Infinity, maxY = -Infinity, radius = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (!position) continue;
    const index = geometry.getIndex(), count = index?.count ?? position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      let low = Infinity, high = -Infinity, radial = 0;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = index ? index.getX(i + corner) : i + corner;
        if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) throw new RangeError("Invalid tree geometry index");
        const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
        const r = Math.hypot(x, z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(r)) {
          throw new RangeError("Tree geometry requires finite positions");
        }
        low = Math.min(low, y); high = Math.max(high, y); radial = Math.max(radial, r);
      }
      triangles[used++] = low; triangles[used++] = high; triangles[used++] = radial;
      minY = Math.min(minY, low); maxY = Math.max(maxY, high); radius = Math.max(radius, radial);
    }
  }
  return new TriangleProfile(triangles.subarray(0, used), minY, maxY, radius);
}
