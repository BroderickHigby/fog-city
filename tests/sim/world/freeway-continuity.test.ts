// W-07: freeways are never cut by an invisible sea wall. Every freeway or ramp that crosses the
// shore between two ends on land (I-280 and its ramps over Mission Creek and Islais Creek) has a
// corridor through it: no wall crosses its centreline. The only freeway edges a wall still
// crosses run out over the open Bay (the Bay Bridge's west span from Rincon Hill to Yerba Buena
// Island, and the Golden Gate and Bay Bridge approaches with an end over the water), whose decks
// are not modelled. I-280 is driven northbound from the Alemany interchange to King St and
// southbound back at 25 m/s: no wall touches it on the way. (Driving them end to end on their
// decks, W-03, is tests/sim/world/structures.test.ts.)
import { describe, expect, it } from "vitest";
import { MAX_INLET_M, onWater, segmentCrossesWall, wallsNear, wallSide, type RoadsFile, type World } from "../../../src/sim/index.ts";
import { CITY_MS, SF, drivePath, resample, sfWorld } from "./load.ts";

/** Is any wall (not a building) within reach of the car body at (x, z)? */
function wallContact(world: World, x: number, z: number): boolean {
  for (const k of wallsNear(world.walls!, x, z, 4)) {
    const d = wallSide(world.walls!.segments[k]!, x, z);
    if (d !== null && Math.abs(d) < 2.2 + 0.3) return true;
  }
  return false;
}

/** The route along a chain of edges, every metre. */
function route(roads: RoadsFile, ids: readonly string[]): Array<[number, number]> {
  const byId = new Map(roads.edges.map((e) => [e.id, e]));
  const out: Array<[number, number]> = [];
  for (const id of ids) {
    const pts = resample(byId.get(id)!.points, 1);
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

describe.skipIf(!SF)("freeway continuity across the creeks (W-07)", () => {
  it(
    "no wall crosses a freeway or ramp with both ends on land, except the Bay Bridge's west span over the open Bay",
    () => {
      const { world, roads } = sfWorld();
      const w = world.walls!;
      const crossing: string[] = [];
      for (const e of roads.edges) {
        if (e.gradeSeparated !== true && e.kind !== "ramp") continue;
        const a = e.points[0]!;
        const b = e.points[e.points.length - 1]!;
        if (onWater(w.shore, a[0]!, a[1]!) || onWater(w.shore, b[0]!, b[1]!)) continue;
        for (let i = 1; i < e.points.length; i++) {
          if (segmentCrossesWall(w, e.points[i - 1]![0]!, e.points[i - 1]![1]!, e.points[i]![0]!, e.points[i]![1]!)) {
            crossing.push(`${e.id} ${e.name}`);
            break;
          }
        }
      }
      // c14248000 / c14249000: I-80 between Rincon Hill and Yerba Buena Island, over more than
      // MAX_INLET_M of open Bay.
      expect(crossing.sort()).toEqual(["c14248000 I-80 Eastbound", "c14249000 I-80 Westbound"]);
      expect(MAX_INLET_M).toBeLessThan(296);
      // I-280 and its ramps over both creeks have corridors.
      const corridors = new Set(w.corridors.map((c) => c.edgeId));
      for (const id of ["c19300000", "c19338000", "c19298000", "c19288000", "c19330000"]) expect(corridors.has(id), id).toBe(true);
    },
    CITY_MS,
  );

  it(
    "the three I-280 edges that stopped at the creek walls are driven across the creeks at 25 m/s with no wall contact",
    () => {
      const { world, roads } = sfWorld();
      const w = world.walls!;
      for (const id of ["c19300000", "c19298000", "c19338000"]) {
        const path = route(roads, [id]);
        // The last metre of the edge over the water: the far bank of the creek.
        let farBank = -1;
        path.forEach(([x, z], i) => {
          if (onWater(w.shore, x, z)) farBank = i;
        });
        expect(farBank, id).toBeGreaterThan(0);
        let walls = 0;
        const r = drivePath(world, path, 25, 20, (c) => {
          if (wallContact(world, c.x, c.z)) walls++;
        });
        expect(walls, id).toBe(0);
        // At 54ee728 they stopped dead at the wall: c19300000 at 280 m, c19298000 at 613 m,
        // c19338000 at 561 m. Now each carries on across the creek and up the far bank.
        expect(r.progressM, `${id} stopped at ${r.progressM} of ${r.lenM} m`).toBeGreaterThan(farBank + 50);
      }
      // Mission Creek both ways: to the end of the edge.
      for (const id of ["c19300000", "c19338000"]) expect(drivePath(world, route(roads, [id]), 25, 20).reached, id).toBe(true);
    },
    CITY_MS,
  );

  it(
    "I-280 northbound from the Alemany interchange to King St and southbound back: no wall contact",
    () => {
      const { world, roads } = sfWorld();
      const nb = route(roads, ["c19304000", "c19298000", "c19303000", "c19302000", "c19301000", "c19300000"]);
      const sb = route(roads, ["c19338000", "c19339000", "c19340000", "c19341000", "c19342000", "c19343000"]);
      for (const [name, path] of [
        ["northbound", nb],
        ["southbound", sb],
      ] as const) {
        let walls = 0;
        drivePath(world, path, 25, 20, (c) => {
          if (wallContact(world, c.x, c.z)) walls++;
        });
        expect(walls, name).toBe(0);
      }
    },
    CITY_MS,
  );
});
