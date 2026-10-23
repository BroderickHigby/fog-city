// Street props citywide (W-44): over the whole sf world, built the way the streamer builds them
// (one PropClearance over every road and every tile collider, tilePropSpots over the graph), no
// lamp or street tree stands on a carriageway or inside a building footprint. The checks here are
// independent of PropClearance: a 50 m grid of road segments and footprints, as the QA report
// measured it. On the old placement (every edge's kerb spots, unfiltered) 8.45% of lamps and 4.15%
// of trees stood on a carriageway and 3.67% and 5.70% inside a footprint; the test asserts that the
// unfiltered spots still show that, so it can tell a broken filter from a broken check.
import { describe, expect, it } from "vitest";
import { PropClearance } from "../../src/render/prop-clearance.ts";
import { nodeClearance, roadHalfWidth, streetlightSpots, streetTreeSpots } from "../../src/render/roads.ts";
import { tilePropSpots } from "../../src/render/tile-streamer.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import { pointInPolygon, type TileCollider } from "../../src/sim/world.ts";
import { readJson, worldExists } from "../helpers.ts";

type P = readonly [number, number];
const CELL = 50;
const key = (x: number, z: number): string => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

describe.skipIf(!worldExists("sf"))("street props citywide (W-44)", () => {
  it("no lamp or tree in the whole city stands on a carriageway or in a building", () => {
    const roads = readJson<RoadGraph>("public/tiles/sf/roads.json");
    const manifest = readJson<{ tiles: Array<{ collider: string }> }>("public/tiles/sf/manifest.json");
    const tiles = manifest.tiles.map((t) => readJson<TileCollider>(`public/tiles/sf/${t.collider}`));

    const segs = new Map<string, Array<[P, P, number]>>();
    for (const e of roads.edges) {
      if (e.pedestrian) continue;
      const hw = roadHalfWidth(e);
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!;
        const b = e.points[i]!;
        for (let x = Math.floor((Math.min(a[0], b[0]) - hw) / CELL); x <= Math.floor((Math.max(a[0], b[0]) + hw) / CELL); x++) {
          for (let z = Math.floor((Math.min(a[1], b[1]) - hw) / CELL); z <= Math.floor((Math.max(a[1], b[1]) + hw) / CELL); z++) {
            const k = `${x},${z}`;
            (segs.get(k) ?? segs.set(k, []).get(k)!).push([a, b, hw]);
          }
        }
      }
    }
    const feet = new Map<string, Array<ReadonlyArray<P>>>();
    for (const t of tiles) {
      for (const b of t.buildings) {
        if (b.footprint.length < 3) continue;
        const xs = b.footprint.map((p) => p[0]);
        const zs = b.footprint.map((p) => p[1]);
        for (let x = Math.floor(Math.min(...xs) / CELL); x <= Math.floor(Math.max(...xs) / CELL); x++) {
          for (let z = Math.floor(Math.min(...zs) / CELL); z <= Math.floor(Math.max(...zs) / CELL); z++) {
            const k = `${x},${z}`;
            (feet.get(k) ?? feet.set(k, []).get(k)!).push(b.footprint);
          }
        }
      }
    }
    const onRibbon = (x: number, z: number): boolean => {
      for (const [a, b, hw] of segs.get(key(x, z)) ?? []) {
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)) : 0;
        if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < hw) return true;
      }
      return false;
    };
    const inFoot = (x: number, z: number): boolean => (feet.get(key(x, z)) ?? []).some((f) => pointInPolygon(x, z, f));
    const count = (spots: ReadonlyArray<{ x: number; z: number }>) => {
      let ribbon = 0;
      let foot = 0;
      for (const s of spots) {
        if (onRibbon(s.x, s.z)) ribbon++;
        if (inFoot(s.x, s.z)) foot++;
      }
      return { n: spots.length, ribbon, foot };
    };

    const nodeClear = nodeClearance(roads);
    // The old placement: the checks above do see the problem.
    const oldLamps = count(streetlightSpots(roads.edges, nodeClear));
    const oldTrees = count(streetTreeSpots(roads.edges, nodeClear));
    expect(oldLamps.ribbon / oldLamps.n).toBeGreaterThan(0.02);
    expect(oldTrees.foot / oldTrees.n).toBeGreaterThan(0.02);

    // The streamer's placement.
    const clearance = new PropClearance(roads.edges, tiles);
    const { lamps, trees } = tilePropSpots(roads.edges, nodeClear, clearance);
    const l = count(lamps);
    const t = count(trees);
    expect(l.n).toBeGreaterThan(20_000);
    expect(t.n).toBeGreaterThan(40_000);
    expect(l, "lamps").toEqual({ n: l.n, ribbon: 0, foot: 0 });
    expect(t, "trees").toEqual({ n: t.n, ribbon: 0, foot: 0 });
    for (const s of [...lamps, ...trees]) if (clearance.onWater(s.x, s.z)) throw new Error(`spot on water at ${s.x},${s.z}`);
  }, 180_000);
});
