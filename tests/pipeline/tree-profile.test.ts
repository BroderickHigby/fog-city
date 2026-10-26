import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createFoliagePrototype } from "../../src/render/foliage.ts";
import { treeProfile } from "../../pipeline/lib/tree-profile.ts";

function triangle(points: number[], indexed = false): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  if (indexed) geometry.setIndex([0, 1, 2]);
  return geometry;
}

type P = [number, number, number];
/** Independent exact clipping oracle: the maximum radius lies at a clipped polygon vertex. */
function clippedRadius(points: P[], low: number, high: number): number | null {
  for (const [level, sign] of [[low, 1], [high, -1]]) {
    const out: P[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      const insideA = (a[1] - level!) * sign! >= 0, insideB = (b[1] - level!) * sign! >= 0;
      if (insideA) out.push(a);
      if (insideA !== insideB) {
        const t = (level! - a[1]) / (b[1] - a[1]);
        out.push([a[0] + (b[0] - a[0]) * t, level!, a[2] + (b[2] - a[2]) * t]);
      }
    }
    points = out;
  }
  return points.length ? Math.max(...points.map(p => Math.hypot(p[0], p[2]))) : null;
}

describe("tree geometry clearance profile", () => {
  it("covers a tilted triangle crossing a band with no vertex in the band", () => {
    const crossing = triangle([-2, -1, 0, 2, 2, 0, 0, 2, 2], true);
    const upper = triangle([5, 8, 0, 0, 9, 3, -4, 8, 0]);
    const profile = treeProfile([crossing, upper]);
    expect(profile.minY).toBe(-1); expect(profile.maxY).toBe(9); expect(profile.radius).toBe(5);
    expect(profile.radiusBetween(0, 1)).toBeGreaterThanOrEqual(4 / 3);
    expect(profile.radiusBetween(0, 1)).toBeLessThanOrEqual(2);
    expect(profile.radiusBetween(3, 6)).toBeNull();
    expect(profile.radiusBetween(-1, -.5)).toBe(2);
    expect(profile.radiusBetween(9, 10)).toBe(5);
    expect(profile.radiusBetween(-Infinity, Infinity)).toBe(5);
    crossing.dispose(); upper.dispose();
  });

  it("does not fill narrow empty bands when caching adjacent triangle ranges", () => {
    const lower = triangle([1, 0, 0, 1, .1, 0, 0, 0, 1]);
    const upper = triangle([2, .2, 0, 2, .3, 0, 0, .2, 2]);
    const profile = treeProfile([lower, upper]);
    expect(profile.radiusBetween(0, .1)).toBe(1);
    expect(profile.radiusBetween(.12, .18)).toBeNull();
    expect(profile.radiusBetween(.2, .3)).toBe(2);
    expect(profile.radiusBetween(.12, .18)).toBeNull();
    lower.dispose(); upper.dispose();
  });

  it("reads normalized interleaved positions and uses only indexed triangles", () => {
    const geometry = new THREE.BufferGeometry();
    const storage = new THREE.InterleavedBuffer(new Int16Array([
      32767, -32767, 0, 123, 0, 32767, 32767, 456, -32767, 32767, 0, 789,
      32767, 32767, 32767, 0,
    ]), 4);
    geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(storage, 3, 0, true));
    geometry.setIndex([2, 1, 0]);
    const profile = treeProfile([geometry]);
    expect(profile.minY).toBe(-1); expect(profile.maxY).toBe(1); expect(profile.radius).toBe(1);
    expect(profile.radiusBetween(-.1, .1)).toBe(1);
    geometry.dispose();
  });

  it("ignores empty geometry and returns no footprint outside the geometry", () => {
    const empty = treeProfile([new THREE.BufferGeometry(), triangle([])]);
    expect(empty.minY).toBe(Infinity); expect(empty.maxY).toBe(-Infinity); expect(empty.radius).toBe(0);
    expect(empty.radiusBetween(-Infinity, Infinity)).toBeNull();
    const shape = triangle([1, 2, 0, 2, 3, 0, 0, 2, 2]);
    const profile = treeProfile([shape]);
    expect(profile.radiusBetween(-5, 1.99)).toBeNull();
    expect(profile.radiusBetween(3.01, 20)).toBeNull();
    expect(() => profile.radiusBetween(NaN, 1)).toThrow();
    expect(() => profile.radiusBetween(3, 2)).toThrow();
    shape.dispose();
  });

  it("owns a numeric snapshot without disposing or reading the source again", () => {
    const shape = triangle([1, 0, 0, 2, 3, 0, 0, 0, 2]);
    let disposals = 0; shape.addEventListener("dispose", () => disposals++);
    const profile = treeProfile([shape]);
    expect(disposals).toBe(0);
    shape.getAttribute("position").setXYZ(0, 1000, 1000, 1000);
    shape.dispose();
    expect(disposals).toBe(1);
    expect(profile.radius).toBe(2); expect(profile.maxY).toBe(3);
    expect(profile.radiusBetween(0, .1)).toBe(2);
  });

  it("rejects invalid used position coordinates and indices", () => {
    const invalid = triangle([0, 0, 0, Infinity, 1, 0, 0, 1, 1]);
    expect(() => treeProfile([invalid])).toThrow(/finite/i);
    const invalidIndex = triangle([0, 0, 0, 1, 1, 0, 0, 1, 1]); invalidIndex.setIndex([0, 1, 8]);
    expect(() => treeProfile([invalidIndex])).toThrow(/index/i);
    invalid.dispose(); invalidIndex.dispose();
  });

  it("bounds both real foliage LODs across negative, road-height and crown bands", () => {
    for (const species of [0, 1] as const) {
      const models = [createFoliagePrototype(species, false), createFoliagePrototype(species, true)];
      const geometries = models.flatMap(model => [model.bark, model.leaves]);
      const profile = treeProfile(geometries);
      expect(profile.maxY).toBeCloseTo(species === 0 ? 6.6 : 10.5, 3);
      expect(profile.radius).toBeGreaterThan(1);
      for (const [low, high] of [[-1, 0], [0, 4.5], [1.8, 2.2], [3.3, 4.7], [5, 9], [11, 12]]) {
        const radius = profile.radiusBetween(low!, high!);
        let maximum: number | null = null;
        for (const geometry of geometries) {
          const positions = geometry.getAttribute("position"), index = geometry.getIndex();
          for (let i = 0; i + 2 < (index?.count ?? positions.count); i += 3) {
            const points: P[] = [];
            for (let j = 0; j < 3; j++) {
              const id = index ? index.getX(i + j) : i + j;
              points.push([positions.getX(id), positions.getY(id), positions.getZ(id)]);
            }
            const clipped = clippedRadius(points, low!, high!);
            if (clipped !== null) maximum = Math.max(maximum ?? 0, clipped);
          }
        }
        if (maximum === null) expect(radius).toBeNull();
        else { expect(radius).not.toBeNull(); expect(radius!).toBeGreaterThanOrEqual(maximum - 1e-9); }
      }
      for (const geometry of geometries) geometry.dispose();
      expect(profile.radiusBetween(0, 4.5)).not.toBeNull();
    }
  });
});
