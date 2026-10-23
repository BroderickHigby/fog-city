import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { GameplayWorldData } from "../../src/sim/gameplay-world.ts";
import type { SidewalkGraph } from "../../pipeline/lib/sidewalks.ts";
import type { RoadGraph } from "../../pipeline/lib/roads.ts";
import { readJson } from "../helpers.ts";

describe("committed SF gameplay handoff", () => {
  const data = readJson<GameplayWorldData>("public/tiles/sf/gameplay.json");
  const manifest = readJson<{ tiles: Array<{ id: string }>; layers: Record<string, string> }>("public/tiles/sf/manifest.json");
  const walk = readJson<SidewalkGraph>("public/tiles/sf/sidewalks.json");
  const roads = readJson<RoadGraph>("public/tiles/sf/roads.json");
  const signals = readJson<{ signals: Array<{ node: string }> }>("public/tiles/sf/signals.json");
  const transit = readJson<{ routes: Array<{ id: string }>; stops: Array<{ id: string }> }>("public/tiles/sf/muni.json");
  const districts = readJson<{ districts: Array<{ id: string }> }>("public/tiles/sf/districts.json");

  it("passes the lane-2 schema and indexes exactly the committed tile set", () => {
    const validate = new Ajv2020({ allErrors: true }).compile(readJson("schemas/tile-gameplay.schema.json"));
    expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.layers.gameplay).toBe("gameplay.json");
    expect(data.tiles.map((t) => t.id).sort()).toEqual(manifest.tiles.map((t) => t.id).sort());
  });

  it("contains no dangling IDs and includes both endpoints with every indexed crossing", () => {
    const refs = {
      sidewalkNodes: new Set(walk.nodes.map((n) => n.id)),
      sidewalkEdges: new Set(walk.edges.map((e) => e.id)),
      refills: new Set(data.refills.map((r) => r.id)), anchors: new Set(data.anchors.map((a) => a.id)),
      signals: new Set(signals.signals.map((s) => s.node)),
      transitStops: new Set(transit.stops.map((s) => s.id)), transitRoutes: new Set(transit.routes.map((r) => r.id)),
    };
    const edges = new Map(walk.edges.map((e) => [e.id, e]));
    for (const t of data.tiles) {
      for (const key of Object.keys(refs) as Array<keyof typeof refs>) {
        const seen = new Set(t[key]);
        expect(seen.size, `${t.id}.${key} duplicates`).toBe(t[key].length);
        for (const id of seen) if (!refs[key].has(id)) throw new Error(`${t.id}.${key}: dangling ${id}`);
      }
      const nodes = new Set(t.sidewalkNodes);
      for (const id of t.sidewalkEdges) {
        const edge = edges.get(id)!;
        if (!nodes.has(edge.a) || !nodes.has(edge.b)) throw new Error(`${t.id}: incomplete ${id}`);
      }
    }
    const roadIds = new Set(roads.nodes.map((n) => n.id));
    const districtIds = new Set(districts.districts.map((d) => d.id));
    for (const a of data.anchors) if (!roadIds.has(a.roadNodeId) || !districtIds.has(a.districtId)) throw new Error(`dangling anchor ${a.id}`);
  });

  it("retains playable data for all design territory rows without activating content", () => {
    expect(data.territories.map((t) => t.step)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9a", "9b"]);
    for (const territory of data.territories) {
      expect(territory.tileIds.length, territory.step).toBeGreaterThan(0);
      const tiles = data.tiles.filter((t) => territory.tileIds.includes(t.id));
      expect(tiles.some((t) => t.sidewalkEdges.length > 0), territory.step).toBe(true);
      expect(tiles.some((t) => t.refills.length > 0), territory.step).toBe(true);
      expect(tiles.some((t) => t.anchors.length > 0), territory.step).toBe(true);
    }
  });
});
