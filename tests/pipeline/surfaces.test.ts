// The reference road-surface lookup (pipeline/lib/surfaces.ts) over the committed sf pack: what
// the sim's surfaceHeight must do with decks and tunnels (schemas/world-colliders.md).

import { describe, expect, it, vi } from "vitest";
import { SurfaceIndex } from "../../pipeline/lib/surfaces.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("sf world: road surfaces with decks and tunnels", () => {
  const { pack, roads, heightAt } = loadSfPack();
  const idx = new SurfaceIndex(pack);
  const decks = pack.tiles.flatMap((t) => t.decks ?? []);
  const tunnels = pack.tiles.flatMap((t) => t.tunnels ?? []);

  it("on an elevated freeway deck a car stands on the deck; on the street under it, on the ground", () => {
    let n = 0;
    for (const d of decks.filter((q) => q.kind === "freeway")) {
      for (const [x, y, z] of d.path) {
        const g = heightAt(x, z);
        if (y - g < 8) continue;
        const up = idx.surfaceAt(x, z, y + 0.1);
        // The highest deck under the feet: this one, or a wider neighbour overlapping it.
        expect(up.kind, d.id).toBe("deck");
        expect(up.y).toBeGreaterThanOrEqual(y - 0.01);
        expect(up.y).toBeLessThanOrEqual(y + 0.6);
        // At the ground under it: the ground (or a ramp's deck as low, at its foot), never the
        // viaduct overhead.
        const down = idx.surfaceAt(x, z, g + 0.1);
        expect(down.y, d.id).toBeLessThanOrEqual(g + 0.6);
        expect(down.y, d.id).toBeGreaterThanOrEqual(g - 0.01);
        if (down.kind !== "ground") expect(down.kind, d.id).toBe("deck");
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });

  it("in the Broadway Tunnel a car stands on the bore's floor under its ceiling; on Russian Hill above, on the ground", () => {
    const bores = tunnels.filter((t) => roads.edges.find((e) => e.id === t.edge)?.name === "Robert C Levy Tunl");
    expect(bores.length).toBeGreaterThan(0);
    let n = 0;
    for (const t of bores) {
      for (const [x, y, z] of t.path) {
        const g = heightAt(x, z);
        if (g - y < t.clearanceM + 2) continue;
        const inBore = idx.surfaceAt(x, z, y + 0.1);
        // This bore's floor, or its twin's beside it (the two Broadway bores overlap at the edges).
        expect(inBore.kind, t.id).toBe("tunnel");
        expect(Math.abs(inBore.y - y)).toBeLessThan(0.5);
        expect(inBore.ceiling! - inBore.y).toBeCloseTo(t.clearanceM, 1);
        const above = idx.surfaceAt(x, z, g + 0.1);
        expect(above.kind, t.id).toBe("ground");
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});
