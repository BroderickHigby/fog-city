// W-12 (and W-14's creek crossings): the street bridges over Mission Creek and Islais Creek dipped
// to sea level. Every surface street over water now has a bridge deck on the straight line
// between its banks (decks.ts), and the Lefty O'Doul Bridge is a bascule.

import { describe, expect, it, vi } from "vitest";
import type { Deck } from "../../pipeline/lib/structures.ts";
import { toLocal } from "../../src/geo/project.ts";
import { loadSfPack, type SfRoads } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Edge = SfRoads["edges"][number];
const isFreeway = (e: Edge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";

describe("sf world: street bridges (W-12)", () => {
  const { pack, roads, heightAt } = loadSfPack();
  const decks = pack.tiles.flatMap((t) => t.decks ?? []);
  const bridgeDecks = decks.filter((d) => d.kind === "bridge");
  const of = (edge: string): Deck[] => bridgeDecks.filter((d) => d.edge === edge);

  it("every surface street over water has a bridge deck", () => {
    const wet = roads.edges.filter((e) => e.bridge && !isFreeway(e) && !e.pedestrian);
    expect(wet.length).toBeGreaterThanOrEqual(4);
    for (const e of wet) {
      expect(of(e.id).length, `${e.id} ${e.name}`).toBeGreaterThan(0);
      expect(e.deck, e.id).toBe(true);
    }
  });

  it("3rd St (Mission Creek and Islais Creek), 4th St (Mission Creek) and Illinois St (Islais Creek) cross on decks that never dip under their lower abutment", () => {
    for (const name of ["3rd St", "4th St", "Illinois St"]) {
      const ds = bridgeDecks.filter((d) => roads.edges.find((e) => e.id === d.edge)!.name === name);
      expect(ds.length, name).toBeGreaterThan(0);
      // Each bridge (by its source id before the tile split) is a straight line between its banks.
      const byBridge = new Map<string, Deck[]>();
      for (const d of ds) {
        const k = d.id.split("~")[0]!;
        (byBridge.get(k) ?? byBridge.set(k, []).get(k)!).push(d);
      }
      for (const [k, pieces] of byBridge) {
        const path = pieces.sort((a, b) => Number(a.id.split("~")[1]) - Number(b.id.split("~")[1])).flatMap((p, i) => (i ? p.path.slice(1) : p.path));
        const lo = Math.min(path[0]![1], path[path.length - 1]![1]);
        for (const [x, y, z] of path) expect(y, `${k} at ${x},${z}`).toBeGreaterThanOrEqual(lo - 0.2);
        // Over the water, the deck stands well above it.
        expect(Math.min(...path.map(([, y]) => y)), k).toBeGreaterThan(1);
      }
    }
    // Two 3rd St bridges: Mission Creek and Islais Creek.
    const third = new Set(bridgeDecks.filter((d) => roads.edges.find((e) => e.id === d.edge)!.name === "3rd St").map((d) => d.id.split("~")[0]));
    expect(third.size).toBeGreaterThanOrEqual(2);
  });

  it("the bridge decks meet the street at their banks", () => {
    for (const d of bridgeDecks) {
      const all = decks.filter((q) => q.id.split("~")[0] === d.id.split("~")[0]);
      const ends = [d.path[0]!, d.path[d.path.length - 1]!];
      for (const [x, y, z] of ends) {
        // An end shared with the next piece of the same bridge is not a bank.
        const shared = all.some((q) => q !== d && q.path.some(([qx, , qz]) => Math.hypot(qx - x, qz - z) < 0.05));
        if (shared) continue;
        const h = heightAt(x, z);
        if (h <= 0.1) continue; // a dead end over water holds its bank height
        expect(Math.abs(y - h), `${d.id} end at ${x},${z}`).toBeLessThan(0.3);
      }
    }
  });

  it("the Lefty O'Doul Bridge (3rd St over Mission Creek) is a bascule on its deck", () => {
    const m = pack.tiles.flatMap((t) => t.movable ?? []);
    const leaf = m.find((q) => q.kind === "bascule");
    expect(leaf).toBeDefined();
    const deck = decks.find((d) => d.id === leaf!.deck);
    expect(deck).toBeDefined();
    expect(roads.edges.find((e) => e.id === deck!.edge)!.name).toBe("3rd St");
    const at = toLocal(37.7766, -122.3906);
    const [x, , z] = deck!.path[deck!.path.length >> 1]!;
    expect(Math.hypot(x - at.x, z - at.z)).toBeLessThan(250);
    expect(leaf!.openRad).toBeGreaterThan(0.5);
  });
});
