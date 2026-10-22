// Street props (W-44): the streamer's lamps and street trees stand on no carriageway, inside no
// building and on no water, in the QA report's sample places (Mission St under the Central
// Freeway, the Market St median at Castro, Mission Bay, Ortega St, Pine St, Broadway at the
// tunnel) and on a synthetic crossing; and the renderer stands them on the ground as drawn (W-22).
import { describe, expect, it } from "vitest";
import { tileId, tileIndexOf, toLocal } from "../../src/geo/project.ts";
import { makeDrawnGroundFn, makeGroundFn } from "../../src/render/ground.ts";
import { PropClearance, ROAD_MARGIN_M } from "../../src/render/prop-clearance.ts";
import { nodeClearance, roadHalfWidth } from "../../src/render/roads.ts";
import { tilePropSpots } from "../../src/render/tile-streamer.ts";
import type { RoadEdge, RoadGraph } from "../../src/render/types.ts";
import { pointInPolygon, type TileCollider } from "../../src/sim/world.ts";
import { readJson, worldExists } from "../helpers.ts";

function segDist(px: number, pz: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L2)) : 0;
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

/** How far (x, z) is inside the nearest carriageway (> 0 = on it). */
function onRibbon(edges: readonly RoadEdge[], x: number, z: number): number {
  let worst = -Infinity;
  for (const e of edges) {
    if (e.pedestrian) continue;
    const hw = roadHalfWidth(e);
    for (let i = 1; i < e.points.length; i++) worst = Math.max(worst, hw - segDist(x, z, e.points[i - 1]!, e.points[i]!));
  }
  return worst;
}

describe("prop clearance on a made-up crossing", () => {
  // Two 10 m streets crossing at the origin, a building in the north-east block, the Bay south of z = 60.
  const edges: RoadEdge[] = [
    { id: "ew", a: "w", b: "e", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[-100, 0], [100, 0]] },
    { id: "ns", a: "n", b: "s", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[0, -100], [0, 50]] },
  ];
  const tile: TileCollider = {
    tileId: "t0_0",
    buildings: [{ id: "b", footprint: [[20, -40], [60, -40], [60, -10], [20, -10]], baseY: 0, topY: 10 }],
    ground: { x0: -100, z0: -100, cellSizeM: 10, nx: 21, nz: 21, heights: new Array(441).fill(5), water: Array.from({ length: 441 }, (_, i) => (Math.floor(i / 21) >= 17 ? 1 : 0)) },
  };
  const c = new PropClearance(edges, [tile]);

  it("rejects the carriageways with a margin, buildings, water; accepts the sidewalk", () => {
    expect(c.clear(30, 7)).toBe(true); // sidewalk south of the east-west street
    expect(c.clear(30, 5.2)).toBe(false); // within the margin of its kerb
    expect(c.clear(30, 2)).toBe(false); // in its lane
    expect(c.clear(2, -30)).toBe(false); // in the north-south street
    expect(c.clear(40, -20)).toBe(false); // inside the building
    expect(c.clear(40, -9.8)).toBe(false); // against its wall
    expect(c.clear(-40, 80)).toBe(false); // the Bay
    expect(c.clear(500, 500)).toBe(false); // off every tile: open water
    expect(c.roadClearance(30, 7)).toBeCloseTo(2, 6);
  });

  it("a kerb spot of one street that lies in the other street is dropped", () => {
    const nodeClear = new Map<string, number>(); // no intersection gaps: spots run right through the crossing
    const { lamps, trees } = tilePropSpots(edges, nodeClear, c);
    for (const s of [...lamps, ...trees]) {
      expect(onRibbon(edges, s.x, s.z)).toBeLessThan(-ROAD_MARGIN_M + 1e-9);
      expect(pointInPolygon(s.x, s.z, tile.buildings[0]!.footprint)).toBe(false);
    }
    expect(lamps.length).toBeGreaterThan(5);
  });
});

describe.skipIf(!worldExists("sf"))("street props in the sf world (W-44)", () => {
  const places: Array<[string, number, number]> = [
    ["Mission St at 13th under the Central Freeway", 37.76975, -122.42001],
    ["Market St at Castro", 37.76267, -122.43519],
    ["Mission Bay", 37.7705, -122.3915],
    ["Ortega St", 37.7525, -122.4945],
    ["Pine St", 37.7895, -122.4215],
    ["Broadway at the tunnel", 37.7973, -122.4138],
  ];

  it("no lamp or tree stands on a carriageway, in a building or on water; they stand on the drawn ground", () => {
    const roads = readJson<RoadGraph>("public/tiles/sf/roads.json");
    const nodeClear = nodeClearance(roads);
    const manifest = readJson<{ tiles: Array<{ id: string; ix: number; iz: number; collider: string }> }>("public/tiles/sf/manifest.json");
    const byId = new Map(manifest.tiles.map((t) => [t.id, t]));
    let total = 0;
    for (const [name, lat, lon] of places) {
      const p = toLocal(lat, lon);
      const t = tileIndexOf(p.x, p.z);
      // The tile and its neighbours (props near a border look across it).
      const tiles: TileCollider[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const s = byId.get(tileId(t.ix + dx, t.iz + dz));
        if (s) tiles.push(readJson<TileCollider>(`public/tiles/sf/${s.collider}`));
      }
      const x0 = t.ix * 500;
      const z0 = t.iz * 500;
      const inTile = (e: RoadEdge): boolean => {
        const m = e.points[Math.floor(e.points.length / 2)]!;
        return m[0] >= x0 && m[0] < x0 + 500 && m[1] >= z0 && m[1] < z0 + 500;
      };
      const near = roads.edges.filter((e) => e.points.some(([x, z]) => x > x0 - 200 && x < x0 + 700 && z > z0 - 200 && z < z0 + 700));
      const clearance = new PropClearance(near, tiles);
      const { lamps, trees } = tilePropSpots(near.filter(inTile), nodeClear, clearance);
      const spots = [...lamps, ...trees];
      expect(spots.length, name).toBeGreaterThan(20);
      const drawn = makeDrawnGroundFn(tiles);
      const bilinear = makeGroundFn(tiles);
      for (const s of spots) {
        expect(onRibbon(near, s.x, s.z), `${name}: spot on a carriageway at ${s.x.toFixed(1)},${s.z.toFixed(1)}`).toBeLessThan(0);
        for (const tc of tiles) for (const b of tc.buildings) {
          if (pointInPolygon(s.x, s.z, b.footprint)) throw new Error(`${name}: spot inside ${b.id} at ${s.x},${s.z}`);
        }
        expect(clearance.onWater(s.x, s.z), name).toBe(false);
        expect(Number.isFinite(drawn(s.x, s.z))).toBe(true);
      }
      total += spots.length;
      // The drawn ground is the mesh's triangles: on a cell's diagonal both planes agree, and
      // at a corner it is the sample itself, like the bilinear one.
      const g = tiles[0]!.ground!;
      expect(drawn(g.x0 + 10, g.z0 + 10)).toBeCloseTo(bilinear(g.x0 + 10, g.z0 + 10), 9);
    }
    expect(total).toBeGreaterThan(300);
  });

  it("the drawn ground follows the mesh's triangle split, not the bilinear surface", () => {
    const g = { x0: 0, z0: 0, cellSizeM: 10, nx: 2, nz: 2, heights: [0, 0, 0, 4] };
    const tile: TileCollider = { tileId: "t", buildings: [], ground: g };
    const drawn = makeDrawnGroundFn([tile]);
    const bilinear = makeGroundFn([tile]);
    // Cell centre: on the (1,0)-(0,1) diagonal the mesh is 0, bilinear is 1.
    expect(drawn(5, 5)).toBeCloseTo(0, 9);
    expect(bilinear(5, 5)).toBeCloseTo(1, 9);
    expect(drawn(7.5, 7.5)).toBeCloseTo(2, 9);
  });
});
