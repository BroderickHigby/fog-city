// W-30: no self-intersecting footprint anywhere (they drew double roofs and roof slabs outside
// the walls). Every collider ring is simple; a tower stands inside its podium. The GLB walls
// and roofs are extruded from these same rings (pipeline/lib/mesh.ts), and
// tests/pipeline/world-colliders.test.ts proves the pack equal to the JSON colliders.

import { describe, expect, it, vi } from "vitest";
import { towerFootprint, simpleRing } from "../../pipeline/lib/buildings.ts";
import { distToSegment, isSimpleRing, pointInRing, signedArea, type P2 } from "../../pipeline/lib/geom.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const inside = (p: P2, ring: readonly P2[], tol: number): boolean => {
  if (pointInRing(p[0], p[1], ring)) return true;
  for (let i = 0; i < ring.length; i++) if (distToSegment(p[0], p[1], ring[i]!, ring[(i + 1) % ring.length]!).d <= tol) return true;
  return false;
};

describe("ring repair (unit)", () => {
  it("a bow tie becomes its largest simple part; a simple source is kept as it is", () => {
    const bow: P2[] = [[0, 0], [10, 10], [10, 0], [0, 10]];
    expect(isSimpleRing(bow)).toBe(false);
    const fixed = simpleRing(bow, bow);
    expect(fixed.length).toBeGreaterThanOrEqual(3);
    expect(isSimpleRing(fixed)).toBe(true);
    const square: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(simpleRing(bow, square)).toEqual(square);
  });

  it("a tower clipped from a U-shaped footprint is one simple piece inside it (no bridge across the courtyard)", () => {
    // A U: two 8 m arms around a 10 m courtyard open to the south (+z). The tower's square,
    // centred over the courtyard, straddles both arms: Sutherland-Hodgman joined the pieces
    // with zero-width bridges along the courtyard walls.
    const u: P2[] = [[0, 0], [26, 0], [26, 30], [18, 30], [18, 8], [8, 8], [8, 30], [0, 30]];
    const t = towerFootprint(u, [13, 22], 0.3);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(isSimpleRing(t)).toBe(true);
    expect(signedArea(t)).toBeLessThan(0);
    for (const p of t) expect(inside(p, u, 0.02), p.join(",")).toBe(true);
  });
});

describe("sf world: every footprint is a simple ring (W-30)", () => {
  const { buildings } = loadSfPack();

  it("no collider ring crosses itself, and every ring has 3+ vertices and an area", () => {
    const bad = buildings.filter((b) => b.footprint.length < 3 || signedArea(b.footprint) === 0 || !isSimpleRing(b.footprint)).map((b) => b.id);
    expect(buildings.length).toBeGreaterThan(175000);
    expect(bad).toEqual([]);
  });

  it("every tower stands inside its podium (no roof slab outside the walls)", () => {
    const byPodium = new Map<string, Array<readonly P2[]>>();
    for (const b of buildings) {
      if (b.id.includes("-tower")) continue;
      const key = b.id.replace(/-[sb]\d+$/, "");
      const l = byPodium.get(key);
      if (l) l.push(b.footprint);
      else byPodium.set(key, [b.footprint]);
    }
    const bad: string[] = [];
    let towers = 0;
    for (const b of buildings) {
      if (!b.id.endsWith("-tower")) continue;
      towers++;
      const podium = byPodium.get(b.id.slice(0, -"-tower".length));
      if (!podium) {
        bad.push(`${b.id}: no podium`);
        continue;
      }
      const out = b.footprint.filter((p) => !podium.some((r) => inside(p, r, 0.05)));
      if (out.length) bad.push(`${b.id}: ${out.length} vertices outside, e.g. ${out[0]!.join(",")}`);
    }
    expect(towers).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });
});
