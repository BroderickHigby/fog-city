// W-16: phantom LiDAR towers. The two-tier rule turned overhead structure returns into towers:
// the Golden Gate Bridge's south approach over Fort Point became a 65 m block, and a crane
// over the Transbay pit a 68 m tower on 1st St. A tower that a road crosses over is dropped
// (pipeline/lib/clearance.ts, step 1), and the Transit Center is an override (its roof park
// about 20 m up, a deck over 1st St: tests/pipeline/carriageway-clearance.test.ts).

import { describe, expect, it, vi } from "vitest";
import { pointInRing } from "../../pipeline/lib/geom.ts";
import { readJson } from "../helpers.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("sf world: no phantom towers (W-16)", () => {
  const { roads, buildings, heightAt } = loadSfPack();
  const ids = new Set(buildings.map((b) => b.id));

  it("Fort Point keeps its ~15.7 m podium: its roof is no more than 25 m above its ground, with no tower record", () => {
    const fort = buildings.filter((b) => b.id.startsWith("201006.0000856"));
    expect(fort.length).toBeGreaterThan(0);
    expect(ids.has("201006.0000856-tower")).toBe(false);
    for (const b of fort) expect(b.topY - b.baseY, b.id).toBeLessThanOrEqual(25);
  });

  it("the 68 m Transbay crane return is gone: no 201006.0000060-tower, and the Transit Center stands about 20 m", () => {
    expect(ids.has("201006.0000060-tower")).toBe(false);
    const tc = buildings.filter((b) => b.id.startsWith("201006.0000060"));
    expect(tc.length).toBeGreaterThan(0);
    for (const b of tc) expect(b.topY - b.baseY, b.id).toBeLessThan(28);
    const ov = readJson<{ buildings: Array<{ id: string; heightM?: number }> }>("pipeline/overrides.json").buildings.find((o) => o.id === "201006.0000060");
    expect(ov?.heightM).toBeGreaterThanOrEqual(18);
  });

  it("no record taller than 30 m stands on a drivable centreline (one over a street is a span with a passable underside)", () => {
    const tall = buildings.filter((b) => b.topY - b.baseY > 30);
    // A 20 m grid of the tall records' boxes.
    const grid = new Map<number, number[]>();
    const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
    tall.forEach((b, j) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cx = Math.floor(x0 / 20); cx <= Math.floor(x1 / 20); cx++) {
        for (let cz = Math.floor(z0 / 20); cz <= Math.floor(z1 / 20); cz++) {
          const l = grid.get(key(cx, cz));
          if (l) l.push(j);
          else grid.set(key(cx, cz), [j]);
        }
      }
    });
    const bad = new Set<string>();
    for (const e of roads.edges) {
      if (e.pedestrian || e.stairs || e.tunnel) continue;
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!;
        const [bx, bz] = e.points[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
        for (let k = 0; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n;
          const z = az + ((bz - az) * k) / n;
          for (const j of grid.get(key(Math.floor(x / 20), Math.floor(z / 20))) ?? []) {
            const b = tall[j]!;
            if (!pointInRing(x, z, b.footprint)) continue;
            if (b.underY !== undefined && b.underY >= heightAt(x, z) + 4.5) continue;
            bad.add(`${b.id} on ${e.id} ${e.name}`);
          }
        }
      }
    }
    expect(tall.length).toBeGreaterThan(1000);
    expect([...bad].sort()).toEqual([]);
  });
});
