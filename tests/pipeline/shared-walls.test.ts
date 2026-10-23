// W-36: footprint simplification must not open cracks between row houses. The fixture
// (pipeline/tools/shared-walls-fixture.ts) lists, from the raw DataSF footprints, every pair
// whose walls touch (under 5 cm apart) in the houses audit's four sample boxes, and the
// citywide number of 5 to 60 cm cracks in the source. In the built world no touching pair may
// become a crack, and the city may have no more cracks than its source data.

import { describe, expect, it, vi } from "vitest";
import { simplifyRing, type P2 } from "../../pipeline/lib/geom.ts";
import { simplifySharedRings } from "../../pipeline/lib/shared-walls.ts";
import { countCracks, TOUCH_M, wallContacts, type Footprint } from "../../pipeline/lib/wall-contacts.ts";
import { readJson } from "../helpers.ts";
import { baseId, loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Fixture {
  touching: Record<string, Array<[string, string, P2]>>;
  rawCracksCitywide: number;
  footprints: number;
}

const gap = (a: readonly P2[], b: readonly P2[]): number => {
  const c = wallContacts([{ id: "a", ring: a }, { id: "b", ring: b }]).get("a|b");
  return c ? c.gap : Infinity;
};

describe("simplifySharedRings (unit)", () => {
  // Two row houses 6 m wide and 20 m deep sharing the wall x = 6, which DataSF draws with
  // centimetre jitter (the kind of detail a 45 cm simplification removes).
  const wall: P2[] = [[6, 0], [6.03, 4], [5.98, 8], [6.02, 12], [5.99, 16], [6, 20]];
  const west: P2[] = [[0, 0], ...wall, [0, 20]];
  const east: P2[] = [[12, 0], [12, 20], ...[...wall].reverse()];

  it("a party wall stays one wall: both sides keep the same polyline, with no crack", () => {
    const [w, e] = simplifySharedRings([west, east], 0.45);
    // Simplified each on its own, the jitter goes and the two sides can differ.
    const onWall = (r: readonly P2[]): string[] => r.filter(([x]) => Math.abs(x - 6) < 0.1).map((p) => p.join(",")).sort();
    expect(onWall(w!)).toEqual(onWall(e!));
    expect(gap(w!, e!)).toBeLessThan(TOUCH_M);
  });

  it("walls that nearly touch in the source (8 cm) are welded together, not opened further", () => {
    const a: P2[] = [[0, 0], [6, 0], [6, 20], [0, 20]];
    const b: P2[] = [[6.08, 0.5], [12, 0.5], [12, 19.5], [6.08, 19.5]];
    expect(gap(a, b)).toBeGreaterThan(TOUCH_M);
    const [sa, sb] = simplifySharedRings([a, b], 0.45);
    expect(gap(sa!, sb!)).toBeLessThan(TOUCH_M);
  });

  it("a corner near another footprint's wall is not inserted into it (it would fold the wall back)", () => {
    // B shares A's wall x = 6 from z = 0 to 10; A has a 10 cm jog at that wall's end.
    const a: P2[] = [[0, 0], [6, 0], [6, 10], [6.1, 10.02], [6.1, 20], [0, 20]];
    const b: P2[] = [[6, 0], [12, 0], [12, 10], [6, 10]];
    const [sa, sb] = simplifySharedRings([a, b], 0.45);
    expect(sb!.some(([x, z]) => Math.abs(x - 6.1) < 0.01 && Math.abs(z - 10.02) < 0.01)).toBe(false);
    expect(gap(sa!, sb!)).toBeLessThan(TOUCH_M);
  });

  it("a footprint with no neighbour is simplified exactly as on its own", () => {
    const lone: P2[] = [[100, 100], [110, 100.2], [120, 100], [120, 110], [100, 110]];
    expect(simplifySharedRings([lone], 0.45)[0]).toEqual(simplifyRing(lone, 0.45));
  });
});

describe("sf world: no cracks between row houses (W-36)", () => {
  const fx = readJson<Fixture>("tests/pipeline/fixtures/shared-walls.json");
  const { buildings } = loadSfPack();
  // Every non-tower record under its footprint's id (terrace strips, spans and parts of one
  // footprint are one building; a tower stands inside its podium).
  const footprints: Footprint[] = buildings.filter((b) => !b.id.includes("-tower")).map((b) => ({ id: baseId(b.id), ring: b.footprint }));
  const built = new Set(footprints.map((f) => f.id));

  for (const [box, pairs] of Object.entries(fx.touching)) {
    it(`${box}: every pair that touches in DataSF still touches (${pairs.length} pairs)`, () => {
      expect(pairs.length).toBeGreaterThan(250);
      // A footprint the pipeline leaves out for other reasons (under 4 m², not standing in the
      // LiDAR, replaced by a landmark, redeveloped) has no wall left to crack.
      const kept = pairs.filter(([a, b]) => built.has(a) && built.has(b));
      expect(kept.length).toBeGreaterThan(pairs.length * 0.97);
      const want = new Set(kept.flatMap(([a, b]) => [a, b]));
      const contacts = wallContacts(footprints.filter((f) => want.has(f.id)));
      const cracked = kept
        .filter(([a, b]) => (contacts.get(`${a}|${b}`)?.gap ?? Infinity) >= TOUCH_M)
        .map(([a, b, at]) => `${a}|${b} at ${at.join(",")}: ${contacts.get(`${a}|${b}`)?.gap.toFixed(3) ?? "no contact"}`);
      expect(cracked).toEqual([]);
    });
  }

  it("the city has no more 5-60 cm cracks between footprints than its source data", () => {
    const n = countCracks(wallContacts(footprints));
    expect(n).toBeLessThanOrEqual(fx.rawCracksCitywide);
  });
});
