// W-33: public stairways were dropped (DataSF files many under the UPROW and PAPER layers the
// road graph excluded) or drawn as smooth ramps a car could drive. Now every stairway is a
// pedestrian `stairs` edge, closed to vehicles and joined to the walk graph.

import { describe, expect, it } from "vitest";
import { isStairway, STAIR_GRADE_UPROW } from "../../pipeline/lib/roads.ts";
import type { RawStreet } from "../../pipeline/lib/sources.ts";
import { readJson } from "../helpers.ts";
import type { SfRoads } from "./util.ts";

const roads = readJson<SfRoads>("public/tiles/sf/roads.json");
const byId = new Map(roads.edges.map((e) => [e.id, e]));

/** Nodes reachable from `start` over every edge (the walk graph: streets, paths and stairs). */
function component(start: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of roads.edges) {
    for (const [p, q] of [[e.a, e.b], [e.b, e.a]] as const) {
      const l = adj.get(p);
      if (l) l.push(q);
      else adj.set(p, [q]);
    }
  }
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) for (const q of adj.get(stack.pop()!) ?? []) if (!seen.has(q)) seen.add(q), stack.push(q);
  return seen;
}

describe("isStairway (unit)", () => {
  const seg = (layer: string): RawStreet => ({ cnn: "1", layer, streetname: "TEST ST" }) as unknown as RawStreet;
  it("an UPROW right of way steeper than its grade is a stairway; a gentle one is not", () => {
    const pts: Array<[number, number]> = [[0, 0], [40, 0]];
    expect(isStairway(seg("UPROW"), pts, (x) => x * (STAIR_GRADE_UPROW + 0.05))).toBe(true);
    expect(isStairway(seg("UPROW"), pts, (x) => x * 0.05)).toBe(false);
  });
});

describe("sf world: stairways (W-33)", () => {
  const stairs = roads.edges.filter((e) => e.stairs);

  it("the Filbert, Greenwich, Lyon, 16th Avenue tiled (Moraga St), Vulcan and Harry steps are pedestrian stairs edges joined to the walk graph", () => {
    const named: Record<string, string[]> = {
      "Filbert St": ["c5491001", "c5492000", "c5493000", "c5494001", "c5494002"],
      "Greenwich St": ["c6487000", "c6488001", "c6489000"],
      "Lyon St": ["c8575000", "c8576000"],
      "Moraga St": ["c9341000"],
      "Vulcan Stwy": ["c13341000"],
      "Harry St": ["c6765000"],
    };
    // The walk graph's main component: the one holding the spawn's street (The Embarcadero).
    const main = component(roads.edges.find((e) => e.name === "The Embarcadero")!.a);
    for (const [name, ids] of Object.entries(named)) {
      for (const id of ids) {
        const e = byId.get(id);
        expect(e, id).toBeDefined();
        expect(e!.name, id).toBe(name);
        expect(e!.stairs, id).toBe(true);
        expect(e!.pedestrian, id).toBe(true);
        expect(main.has(e!.a) && main.has(e!.b), `${id} joined`).toBe(true);
      }
    }
  });

  it("no stair edge is drivable: every one is pedestrian, two-way and one lane", () => {
    expect(stairs.length).toBeGreaterThan(100);
    for (const e of stairs) {
      expect(e.pedestrian, e.id).toBe(true);
      expect(e.oneway, e.id).toBe(false);
      expect(e.lanes, e.id).toBe(1);
    }
  });
});
