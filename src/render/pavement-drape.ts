// Repair coarse, ground-level road ribbons once at tile admission. Their 8 m samples can
// bridge a 10 m terrain peak: splitting on the terrain lattice keeps paving above that peak.
import * as THREE from "three";
import { heightOnField, type Heightfield } from "../sim/world.ts";

const EPS = 1e-7;
const HEIGHT_EPS = .002;
const MIN_LIFT = .02;
const MAX_PIECES = 1000;
const MAX_VERTICES = 600_000;
type V = { x: number; z: number; a: number; b: number; y: number };
type Source = { ids: [number, number, number]; vertices: V[] };
type BoxedField = { field: Heightfield; x1: number; z1: number };

/** Keep the positive side of a line, carrying original-triangle interpolation weights. */
function clip(poly: readonly V[], ax: number, az: number, bx: number, bz: number): V[] {
  const out: V[] = [];
  const side = (p: V): number => (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!, dp = side(p), dq = side(q);
    if (dp >= -EPS) out.push(p);
    if (dp > EPS && dq < -EPS || dp < -EPS && dq > EPS) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t,
        a: p.a + (q.a - p.a) * t, b: p.b + (q.b - p.b) * t, y: 0 });
    }
  }
  return out;
}

function area(a: V, b: V, c: V): number { return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); }
function value(p: V, values: readonly number[]): number { return p.a * values[0]! + p.b * values[1]! + (1 - p.a - p.b) * values[2]!; }

/**
 * Return owned replacement geometry only when ground-level paving needs repair. Input
 * geometry is never changed or disposed. Bridges, walls, missing terrain and unsupported
 * morph geometry stay as supplied. Attributes are interpolated in their original triangle;
 * indexed input becomes non-indexed so material groups and discontinuous paint stay intact.
 */
export function drapePavement(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4,
  fields: readonly Heightfield[]): THREE.BufferGeometry | null {
  const position = geometry.getAttribute("position"), index = geometry.getIndex();
  const count = index?.count ?? position?.count ?? 0;
  if (!position || position.itemSize !== 3 || !count || count % 3 || count > MAX_VERTICES ||
    !matrixWorld.elements.every(Number.isFinite) || Math.abs(matrixWorld.determinant()) < EPS ||
    Object.values(geometry.morphAttributes).some(attributes => attributes?.length)) return null;
  const attributes = Object.entries(geometry.attributes);
  if (attributes.some(([, attr]) => attr.count !== position.count || (attr as THREE.InstancedBufferAttribute).isInstancedBufferAttribute)) return null;
  const boxed: BoxedField[] = fields.filter(f => Number.isFinite(f.x0) && Number.isFinite(f.z0) &&
    Number.isFinite(f.cellSizeM) && f.cellSizeM > 0 && Number.isInteger(f.nx) && Number.isInteger(f.nz) && f.nx > 1 && f.nz > 1)
    .map(field => ({ field, x1: field.x0 + (field.nx - 1) * field.cellSizeM, z1: field.z0 + (field.nz - 1) * field.cellSizeM }));
  if (!boxed.length) return null;
  const groupBounds = geometry.groups.flatMap(g => [g.start, Math.min(count, g.start + g.count)]);
  const drawEnd = Math.min(count, geometry.drawRange.start + geometry.drawRange.count);
  if ([geometry.drawRange.start, drawEnd, ...groupBounds].some(n => !Number.isInteger(n) || n < 0 || n > count || n % 3)) return null;
  const inverse = matrixWorld.clone().invert(), world = new THREE.Vector3(), sources: Source[] = [], offsets = [0];
  let changed = false, outputCount = 0;
  for (let start = 0; start < count; start += 3) {
    const ids = [0, 1, 2].map(k => index ? index.getX(start + k) : start + k) as [number, number, number];
    if (ids.some(i => !Number.isInteger(i) || i < 0 || i >= position.count)) return null;
    const original: V[] = ids.map((id, k) => {
      world.fromBufferAttribute(position, id).applyMatrix4(matrixWorld);
      return { x: world.x, y: world.y, z: world.z, a: k === 0 ? 1 : 0, b: k === 1 ? 1 : 0 };
    });
    if (original.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) return null;
    const signedArea = area(original[0]!, original[1]!, original[2]!);
    let vertices = original;
    if (Math.abs(signedArea) > EPS) {
      const lifts = original.map(p => {
        const f = boxed.find(({ field, x1, z1 }) => p.x >= field.x0 - EPS && p.z >= field.z0 - EPS && p.x <= x1 + EPS && p.z <= z1 + EPS);
        return f ? p.y - heightOnField(f.field, Math.max(f.field.x0, Math.min(f.x1, p.x)), Math.max(f.field.z0, Math.min(f.z1, p.z))) : NaN;
      });
      if (lifts.every(lift => Number.isFinite(lift) && lift >= -.2 && lift <= 1)) {
        const lift = lifts.map(h => Math.max(MIN_LIFT, h)), originalHeights = original.map(p => p.y);
        const x0 = Math.min(...original.map(p => p.x)), z0 = Math.min(...original.map(p => p.z));
        const x1 = Math.max(...original.map(p => p.x)), z1 = Math.max(...original.map(p => p.z));
        const pieces: V[] = [];
        let covered = 0, modified = false, overflow = false;
        for (const { field: f, x1: fx1, z1: fz1 } of boxed) {
          if (fx1 < x0 || f.x0 > x1 || fz1 < z0 || f.z0 > z1) continue;
          const s = f.cellSizeM, ix0 = Math.max(0, Math.floor((x0 - f.x0) / s)), iz0 = Math.max(0, Math.floor((z0 - f.z0) / s));
          const ix1 = Math.min(f.nx - 2, Math.floor((x1 - f.x0) / s)), iz1 = Math.min(f.nz - 2, Math.floor((z1 - f.z0) / s));
          if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > MAX_PIECES) { overflow = true; break; }
          for (let ix = ix0; ix <= ix1 && !overflow; ix++) for (let iz = iz0; iz <= iz1 && !overflow; iz++) {
            const x = f.x0 + ix * s, z = f.z0 + iz * s;
            let square = clip(original, x, z + s, x, z);
            square = clip(square, x + s, z, x + s, z + s);
            square = clip(square, x, z, x + s, z);
            square = clip(square, x + s, z + s, x, z + s);
            for (const side of [1, -1]) {
              const poly = side === 1 ? clip(square, x + s, z, x, z + s) : clip(square, x, z + s, x + s, z);
              for (let i = 1; i + 1 < poly.length; i++) {
                const triangle = [poly[0]!, poly[i]!, poly[i + 1]!];
                const size = Math.abs(area(...triangle as [V, V, V]));
                if (size < EPS) continue;
                covered += size;
                for (const p of triangle) {
                  const y = heightOnField(f, Math.max(f.x0, Math.min(fx1, p.x)), Math.max(f.z0, Math.min(fz1, p.z))) + value(p, lift);
                  if (!Number.isFinite(y)) { overflow = true; break; }
                  if (Math.abs(y - value(p, originalHeights)) > HEIGHT_EPS) modified = true;
                  pieces.push({ ...p, y });
                }
                if (pieces.length / 3 > MAX_PIECES) overflow = true;
              }
            }
          }
        }
        // Never replace a triangle by partial coverage (or by overlapping terrain fields).
        if (!overflow && modified && Math.abs(covered - Math.abs(signedArea)) <= Math.max(EPS, Math.abs(signedArea) * 1e-6)) {
          vertices = pieces; changed = true;
        }
      }
    }
    outputCount += vertices.length;
    if (outputCount > MAX_VERTICES) return null;
    sources.push({ ids, vertices }); offsets.push(outputCount);
  }
  if (!changed) return null;
  const out = new THREE.BufferGeometry(); out.name = geometry.name; out.userData = { ...geometry.userData };
  for (const [name, attr] of attributes) {
    const asFloat = name === "position" || attr instanceof THREE.Float16BufferAttribute;
    const ArrayType = asFloat ? Float32Array : attr.array.constructor as { new(length: number): THREE.TypedArray };
    const result = new THREE.BufferAttribute(new ArrayType(outputCount * attr.itemSize), attr.itemSize, asFloat ? false : attr.normalized);
    result.name = attr.name;
    if (attr instanceof THREE.BufferAttribute) { result.setUsage(attr.usage); result.gpuType = attr.gpuType; }
    else result.setUsage(attr.data.usage);
    let vertex = 0;
    for (const source of sources) for (const p of source.vertices) {
      for (let k = 0; k < attr.itemSize; k++) result.setComponent(vertex, k,
        p.a * attr.getComponent(source.ids[0], k) + p.b * attr.getComponent(source.ids[1], k) + (1 - p.a - p.b) * attr.getComponent(source.ids[2], k));
      if (name === "position") { world.set(p.x, p.y, p.z).applyMatrix4(inverse); result.setXYZ(vertex, world.x, world.y, world.z); }
      if (name === "normal") { world.fromBufferAttribute(result, vertex).normalize(); result.setXYZ(vertex, world.x, world.y, world.z); }
      vertex++;
    }
    out.setAttribute(name, result);
  }
  for (const g of geometry.groups) {
    const start = offsets[g.start / 3]!, end = offsets[Math.min(count, g.start + g.count) / 3]!;
    out.addGroup(start, end - start, g.materialIndex);
  }
  out.setDrawRange(offsets[geometry.drawRange.start / 3]!, offsets[drawEnd / 3]! - offsets[geometry.drawRange.start / 3]!);
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}
