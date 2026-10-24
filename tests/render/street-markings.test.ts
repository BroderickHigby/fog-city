// Junction paint meshes (src/render/street-markings.ts) from street-markings.json records: the
// patch covers the ring above the road ribbons, paint sits above the patch, and every bar is
// square to its leg. No browser.
import { describe, expect, it } from "vitest";
import {
  PAINT_LIFT_M,
  PATCH_LIFT_M,
  buildMarkingMeshes,
  continentalBars,
  decodeJunction,
} from "../../src/render/street-markings.ts";

/** A + crossing record as the pipeline writes it: 11 m streets, continental on every leg. */
const plus = {
  id: "n1",
  x: 100,
  z: -50,
  k: "residential",
  ring: [-5.5, -9, 5.5, -9, 5.5, -5.5, 9, -5.5, 9, 5.5, 5.5, 5.5, 5.5, 9, -5.5, 9, -5.5, 5.5, -9, 5.5, -9, -5.5, -5.5, -5.5],
  legs: [
    ["c1", 0, -1, 0, 0, 5.5, 11, "c", 6.1, 9.1, 10.3, -5.1, -0.15],
    ["c2", 1, 0, 0, 0, 5.5, 9.1, "c", 6.1, 9.1, 0, 0, 0],
    ["c3", 0, 1, 0, 0, 5.5, 9.1, "s", 6.1, 9.1, 0, 0, 0],
    ["c4", -1, 0, 0, 0, 5.5, 5.5, "", 0, 0, 0, 0, 0],
  ],
};

const slope = (x: number, z: number): number => 10 + 0.05 * x - 0.02 * z;

describe("junction paint meshes", () => {
  const j = decodeJunction(plus)!;

  it("decodes a record: ring in world coordinates, legs in order", () => {
    expect(j.ring.slice(0, 2)).toEqual([94.5, -59]);
    expect(j.legs.map((l) => [l.edge, l.style])).toEqual([["c1", "c"], ["c2", "c"], ["c3", "s"], ["c4", ""]]);
    expect(decodeJunction({ id: 3 })).toBeNull();
  });

  it("centres continental bars across the carriageway, inside the gutters", () => {
    const bars = continentalBars(5.5);
    expect(bars.length).toBe(9);
    expect(bars[0]! + bars[bars.length - 1]!).toBeCloseTo(0, 9);
    expect(bars[bars.length - 1]! + 0.3).toBeLessThanOrEqual(5.5 - 0.4 + 1e-9);
  });

  it("lifts the patch and the paint above the ground, following its slope", () => {
    const m = buildMarkingMeshes([j], slope);
    expect(m.crosswalks).toBe(3);
    expect(m.stopBars).toBe(1);
    for (const [mesh, lift] of [[m.patch, PATCH_LIFT_M], [m.paint, PAINT_LIFT_M]] as const) {
      const p = mesh.positions;
      expect(p.length).toBeGreaterThan(0);
      for (let i = 0; i < p.length; i += 3) expect(p[i + 1]!).toBeCloseTo(slope(p[i]!, p[i + 2]!) + lift, 4);
      // Every triangle faces up.
      const idx = mesh.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
        const ux = p[b]! - p[a]!, uz = p[b + 2]! - p[a + 2]!, vx = p[c]! - p[a]!, vz = p[c + 2]! - p[a + 2]!;
        expect(uz * vx - ux * vz).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the paint on its legs, out of the box", () => {
    const m = buildMarkingMeshes([j], () => 0);
    const p = m.paint.positions;
    for (let i = 0; i < p.length; i += 3) {
      const dx = p[i]! - j.x, dz = p[i + 2]! - j.z;
      // Outside the 11 m x 11 m box: beyond 6 m from the node along x or z.
      expect(Math.max(Math.abs(dx), Math.abs(dz))).toBeGreaterThanOrEqual(6.1 - 1e-4);
    }
  });
});
