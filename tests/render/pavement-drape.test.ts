import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { drapePavement } from "../../src/render/pavement-drape.ts";
import { heightOnField, type Heightfield } from "../../src/sim/world.ts";

const hill: Heightfield = { x0: 0, z0: 0, cellSizeM: 10, nx: 4, nz: 3,
  heights: [2, 2, 2, 2, 2, 5, 2, 2, 2, 2, 2, 2] };
const identity = new THREE.Matrix4();
function pavement(indexed = true, lift: (x: number) => number = () => .15): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 2 + lift(0), 8, 30, 2 + lift(30), 8, 0, 2 + lift(0), 12, 30, 2 + lift(30), 12], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setAttribute("color", new THREE.Uint8BufferAttribute([0, 64, 255, 255, 64, 255, 0, 64, 255, 255, 64, 255], 3, true));
  g.setIndex([0, 2, 1, 2, 3, 1]);
  if (indexed) return g;
  const out = g.toNonIndexed(); g.dispose(); return out;
}
function height(g: THREE.BufferGeometry, x: number, z: number, matrix = identity): number {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  m.matrixAutoUpdate = false; m.matrix.copy(matrix); m.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0)).intersectObject(m)[0];
  m.material.dispose(); return hit?.point.y ?? NaN;
}

describe("pavement draping", () => {
  it.each([true, false])("repairs an indexed=%s road over a terrain peak without moving its footprint", indexed => {
    const g = pavement(indexed), original = Array.from(g.getAttribute("position").array);
    expect(height(g, 10, 10)).toBeLessThan(heightOnField(hill, 10, 10));
    const out = drapePavement(g, identity, [hill]);
    expect(out).not.toBeNull();
    expect(height(out!, 10, 10)).toBeCloseTo(5.15, 5);
    const p = out!.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      expect(p.getX(i)).toBeGreaterThanOrEqual(-1e-6); expect(p.getX(i)).toBeLessThanOrEqual(30.000001);
      expect(p.getZ(i)).toBeGreaterThanOrEqual(7.999999); expect(p.getZ(i)).toBeLessThanOrEqual(12.000001);
      expect(p.getY(i)).toBeCloseTo(heightOnField(hill, p.getX(i), p.getZ(i)) + .15, 5);
    }
    for (let i = 0; i < p.count; i += 3) {
      const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
      const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
      const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      expect(y).toBeCloseTo(heightOnField(hill, x, z) + .15, 5);
      const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
      expect(b.sub(a).cross(c.sub(a)).y).toBeGreaterThan(0);
    }
    expect(Array.from(g.getAttribute("position").array)).toEqual(original);
    expect(drapePavement(out!, identity, [hill])).toBeNull();
    out!.dispose(); g.dispose();
  });

  it("interpolates paint, UVs, normals and the original varying curb lift", () => {
    const g = pavement(true, x => .1 + x / 150), out = drapePavement(g, identity, [hill])!;
    const p = out.getAttribute("position"), uv = out.getAttribute("uv"), c = out.getAttribute("color"), n = out.getAttribute("normal");
    expect(c.normalized).toBe(true); expect(c.array).toBeInstanceOf(Uint8Array);
    for (let i = 0; i < p.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(p.getX(i) / 30, 5); expect(uv.getY(i)).toBeCloseTo((p.getZ(i) - 8) / 4, 5);
      expect(c.getX(i)).toBeCloseTo(p.getX(i) / 30, 2); expect(c.getY(i)).toBeCloseTo(64 / 255, 5); expect(c.getZ(i)).toBe(1);
      expect(n.getX(i)).toBe(0); expect(n.getY(i)).toBe(1); expect(n.getZ(i)).toBe(0);
      expect(p.getY(i)).toBeCloseTo(heightOnField(hill, p.getX(i), p.getZ(i)) + .1 + p.getX(i) / 150, 5);
    }
    out.dispose(); g.dispose();
  });

  it("transforms the repair back into a translated mesh's local frame", () => {
    const g = pavement(), matrix = new THREE.Matrix4().makeTranslation(100, 7, -50);
    g.translate(-100, -7, 50);
    const out = drapePavement(g, matrix, [hill])!;
    expect(height(out, 10, 10, matrix)).toBeCloseTo(5.15, 5);
    expect(out.getAttribute("position").getX(0)).toBeLessThan(-69);
    out.dispose(); g.dispose();
  });

  it("preserves normalized interleaved attributes without retaining their source buffer", () => {
    const g = pavement(), bytes = new Uint8Array([0, 64, 255, 17, 255, 64, 255, 17, 0, 64, 255, 17, 255, 64, 255, 17]);
    g.setAttribute("color", new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(bytes, 4), 3, 0, true));
    const out = drapePavement(g, identity, [hill])!, color = out.getAttribute("color"), position = out.getAttribute("position");
    expect(color.normalized).toBe(true); expect(color.array).not.toBe(bytes);
    bytes.fill(0);
    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBeCloseTo(position.getX(i) / 30, 2);
      expect(color.getY(i)).toBeCloseTo(64 / 255, 5); expect(color.getZ(i)).toBe(1);
    }
    out.dispose(); g.dispose();
  });

  it("maps material groups and draw ranges onto all generated triangles", () => {
    const g = pavement(); g.addGroup(0, 3, 4); g.addGroup(3, 3, 9); g.setDrawRange(3, 3);
    const out = drapePavement(g, identity, [hill])!;
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0]!.materialIndex).toBe(4); expect(out.groups[1]!.materialIndex).toBe(9);
    expect(out.groups[0]!.count).toBeGreaterThan(3); expect(out.groups[1]!.count).toBeGreaterThan(3);
    expect(out.groups[1]!.start).toBe(out.groups[0]!.count);
    expect(out.drawRange).toEqual({ start: out.groups[1]!.start, count: out.groups[1]!.count });
    out.dispose(); g.dispose();
  });

  it("joins adjacent heightfields without cracks or duplicate surface area", () => {
    const left: Heightfield = { x0: 0, z0: 0, cellSizeM: 10, nx: 2, nz: 3, heights: [2, 2, 2, 5, 2, 2] };
    const right: Heightfield = { x0: 10, z0: 0, cellSizeM: 10, nx: 3, nz: 3, heights: [2, 2, 2, 5, 2, 2, 2, 2, 2] };
    const g = pavement(), out = drapePavement(g, identity, [left, right])!;
    expect(height(out, 10, 10)).toBeCloseTo(5.15, 5);
    const p = out.getAttribute("position"); let area = 0;
    for (let i = 0; i < p.count; i += 3) area += Math.abs((p.getX(i + 1) - p.getX(i)) * (p.getZ(i + 2) - p.getZ(i)) - (p.getZ(i + 1) - p.getZ(i)) * (p.getX(i + 2) - p.getX(i))) / 2;
    expect(area).toBeCloseTo(120, 4); out.dispose(); g.dispose();
  });

  it("leaves already conforming pavement, elevated decks and vertical faces untouched", () => {
    const flat = { ...hill, heights: hill.heights.map(() => 2) }, g = pavement();
    expect(drapePavement(g, identity, [flat])).toBeNull();
    g.translate(0, 20, 0); expect(drapePavement(g, identity, [hill])).toBeNull(); g.dispose();
    const wall = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([10, 2, 9, 10, 5, 9, 10, 2, 11], 3));
    expect(drapePavement(wall, identity, [hill])).toBeNull(); wall.dispose();
  });

  it("repairs only ground-level faces of a mesh that also contains an elevated section", () => {
    const source = pavement(false), a = source.getAttribute("position");
    const points = [...a.array, 0, 24, 8, 0, 24, 12, 30, 24, 8];
    const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const out = drapePavement(g, identity, [hill])!, p = out.getAttribute("position");
    expect(height(out, 10, 10)).toBe(24);
    expect(Array.from(p.array).slice(-9)).toEqual(points.slice(-9));
    source.dispose(); out.dispose(); g.dispose();
  });

  it("lifts slightly embedded source pavement clear of the ground", () => {
    const g = pavement(true, () => -.1), out = drapePavement(g, identity, [hill])!;
    expect(height(out, 10, 10)).toBeCloseTo(5.02, 5); out.dispose(); g.dispose();
  });

  it("leaves an unexpectedly huge triangle intact instead of expanding it without bound", () => {
    const field: Heightfield = { x0: 0, z0: 0, nx: 101, nz: 101, cellSizeM: 10, heights: Array(10201).fill(2) };
    field.heights[5050] = 20;
    const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 2.15, 0, 0, 2.15, 1000, 1000, 2.15, 0], 3));
    expect(drapePavement(g, identity, [field])).toBeNull();
    expect(g.getAttribute("position").count).toBe(3); g.dispose();
  });

  it("does not create holes when terrain coverage or geometry is incomplete", () => {
    const g = pavement(); expect(drapePavement(g, identity, [])).toBeNull();
    expect(drapePavement(g, identity, [{ ...hill, nx: 2, heights: [2, 2, 2, 5, 2, 2] }])).toBeNull();
    expect(drapePavement(g, new THREE.Matrix4().makeScale(0, 1, 1), [hill])).toBeNull();
    g.dispose(); expect(drapePavement(new THREE.BufferGeometry(), identity, [hill])).toBeNull();
  });
});
