import * as THREE from "three";

const CELL_M = 8;
const MAX_LIFT_M = 0.35;
const MAX_CELLS_PER_TRIANGLE = 4096;
interface FloorTriangle {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  denominator: number;
  minY: number; maxY: number;
}

function floorMaterial(material: THREE.Material | undefined): boolean {
  return !!material && material.visible && (material.name === "fc:ground"
    || material.name.startsWith("fc:road") || material.name.startsWith("fc:freeway"));
}
const cellKey = (x: number, z: number): string => `${x},${z}`;

/**
 * Match a rendered avatar to nearby, actually drawn ground/road triangles. The sim stays
 * unchanged: only upward corrections of at most 35 cm are allowed. Loaded tile lifetimes
 * own the index; a frame queries one 8 m cell rather than scanning the world.
 */
export class AvatarGround {
  private readonly cells = new Map<string, Map<string, FloorTriangle[]>>();
  private readonly tileCells = new Map<string, Set<string>>();

  addTile(group: THREE.Object3D): void {
    if (!group.name.startsWith("tile:") || group.name.length === 5) return;
    const id = group.name.slice(5);
    this.removeTile(id);
    const buckets = new Map<string, FloorTriangle[]>();
    group.updateWorldMatrix(true, true);
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || (object as THREE.SkinnedMesh).isSkinnedMesh || (object as THREE.InstancedMesh).isInstancedMesh) return;
      const geometry = mesh.geometry;
      const positions = geometry.getAttribute("position");
      if (!positions) return;
      const total = geometry.index?.count ?? positions.count;
      const drawStart = geometry.drawRange.start;
      const drawEnd = Math.min(total, drawStart + geometry.drawRange.count);
      const materials = mesh.material;
      const ranges = Array.isArray(materials)
        ? geometry.groups.filter(range => floorMaterial(materials[range.materialIndex ?? 0]))
        : floorMaterial(materials) ? [{ start: 0, count: total }] : [];
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (const range of ranges) {
        const start = Math.max(drawStart, range.start), end = Math.min(drawEnd, range.start + range.count);
        for (let at = start; at + 2 < end; at += 3) {
          a.fromBufferAttribute(positions, geometry.index ? geometry.index.getX(at) : at).applyMatrix4(mesh.matrixWorld);
          b.fromBufferAttribute(positions, geometry.index ? geometry.index.getX(at + 1) : at + 1).applyMatrix4(mesh.matrixWorld);
          c.fromBufferAttribute(positions, geometry.index ? geometry.index.getX(at + 2) : at + 2).applyMatrix4(mesh.matrixWorld);
          if (![a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].every(Number.isFinite)) continue;
          const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
          const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
          const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
          // Reject walls, degenerate faces and grades steeper than 45 degrees.
          if (![nx, ny, nz].every(Number.isFinite) || Math.abs(ny) < 1e-9 || nx * nx + nz * nz > ny * ny) continue;
          const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
          if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) continue;
          const x0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL_M), x1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL_M);
          const z0 = Math.floor(Math.min(a.z, b.z, c.z) / CELL_M), z1 = Math.floor(Math.max(a.z, b.z, c.z) / CELL_M);
          if (![x0, x1, z0, z1].every(Number.isSafeInteger)) continue;
          if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS_PER_TRIANGLE) continue;
          const triangle: FloorTriangle = { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
            cx: c.x, cy: c.y, cz: c.z, denominator, minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y) };
          for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
            const key = cellKey(x, z), bucket = buckets.get(key);
            if (bucket) bucket.push(triangle);
            else buckets.set(key, [triangle]);
          }
        }
      }
    });
    this.tileCells.set(id, new Set(buckets.keys()));
    for (const [key, triangles] of buckets) {
      let cell = this.cells.get(key);
      if (!cell) { cell = new Map(); this.cells.set(key, cell); }
      cell.set(id, triangles);
    }
  }

  removeTile(id: string): void {
    for (const key of this.tileCells.get(id) ?? []) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (!cell?.size) this.cells.delete(key);
    }
    this.tileCells.delete(id);
  }

  heightAt(x: number, y: number, z: number): number {
    return this.sampleAt(x, y, z, y) ?? y;
  }

  /** The actual local floor under a shoe probe, including a downhill point below the body. */
  surfaceAt(x: number, referenceY: number, z: number): number | undefined {
    return this.sampleAt(x, referenceY, z, referenceY - MAX_LIFT_M);
  }

  private sampleAt(x: number, y: number, z: number, minimum: number): number | undefined {
    if (![x, y, z].every(Number.isFinite)) return undefined;
    const cell = this.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (!cell) return undefined;
    let height: number | undefined;
    for (const triangles of cell.values()) for (const triangle of triangles) {
      if (triangle.maxY < (height ?? minimum) || triangle.minY > y + MAX_LIFT_M) continue;
      const a = ((triangle.bz - triangle.cz) * (x - triangle.cx) + (triangle.cx - triangle.bx) * (z - triangle.cz)) / triangle.denominator;
      const b = ((triangle.cz - triangle.az) * (x - triangle.cx) + (triangle.ax - triangle.cx) * (z - triangle.cz)) / triangle.denominator;
      const c = 1 - a - b;
      if (Math.min(a, b, c) < -1e-8) continue;
      const candidate = a * triangle.ay + b * triangle.by + c * triangle.cy;
      if (candidate >= (height ?? minimum) && candidate <= y + MAX_LIFT_M) height = candidate;
    }
    return height;
  }

  clear(): void { this.cells.clear(); this.tileCells.clear(); }
}
