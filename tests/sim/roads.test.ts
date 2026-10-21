// The static road graph: lanes, sidewalks, connectors and spawn areas built from roads.json.
import { describe, expect, it } from "vitest";
import {
  AREA_M,
  KEEP_RIGHT_M,
  buildRoadGraph,
  buildWorld,
  circleBlocked,
  connector,
  connectorPath,
  groundHeight,
  lanePath,
  laneOffset,
  pathPoint,
  projectOnPath,
  sameCorner,
  walkPath,
  type RoadsFile,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";
import { loadWorld, readJson } from "../helpers.ts";
import { gridCity, loadDevWorldWithRoads } from "./fixtures.ts";

function edge(world: World, id: string) {
  const g = world.roads!;
  return g.edges[g.edgeIndex.get(id)!]!;
}

describe("buildWorld and roads", () => {
  it("roads are optional: the plain dev world has none", () => {
    expect(loadWorld("dev").world.roads).toBeNull();
    expect(loadDevWorldWithRoads().world.roads).not.toBeNull();
  });

  it("the road graph never ends up in SimState (it is static, behind world.roads)", () => {
    const { world } = loadDevWorldWithRoads();
    expect(world.roads!.edges.length).toBe(4);
    expect(world.roads!.nodes.length).toBe(4);
    expect(world.roads!.edgeIndex instanceof Map).toBe(true);
  });

  it("ground lookups through the index match a linear scan over tiles (first tile in id order wins)", () => {
    const mk = (tileId: string, x0: number, z0: number, h: number): TileCollider => ({
      tileId,
      buildings: [],
      ground: { x0, z0, cellSizeM: 10, nx: 31, nz: 31, heights: Array.from({ length: 31 * 31 }, (_, i) => h + (i % 31) * 0.1) },
    });
    // Overlapping heightfields: "a" covers [0,300]^2, "b" covers [200,500]^2.
    const world = buildWorld([mk("b", 200, 200, 50), mk("a", 0, 0, 10)]);
    // Reference: a linear scan over tiles in id order, each cell two triangles split along its
    // (i+1, k)-(i, k+1) diagonal as the ground mesh is drawn (SIM_VERSION 3; bilinear before).
    const linear = (x: number, z: number): number => {
      for (const t of world.tiles) {
        const g = t.ground!;
        const fx = (x - g.x0) / g.cellSizeM;
        const fz = (z - g.z0) / g.cellSizeM;
        if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
        const ix = Math.min(Math.floor(fx), g.nx - 2);
        const iz = Math.min(Math.floor(fz), g.nz - 2);
        const tx = fx - ix;
        const tz = fz - iz;
        const h = (i: number, j: number) => g.heights[j * g.nx + i]!;
        if (tx + tz <= 1) return h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * tx + (h(ix, iz + 1) - h(ix, iz)) * tz;
        return h(ix + 1, iz + 1) + (h(ix, iz + 1) - h(ix + 1, iz + 1)) * (1 - tx) + (h(ix + 1, iz) - h(ix + 1, iz + 1)) * (1 - tz);
      }
      return 0;
    };
    for (let x = -50; x <= 550; x += 13.7) for (let z = -50; z <= 550; z += 17.3) expect(groundHeight(world, x, z)).toBe(linear(x, z));
    expect(groundHeight(world, 250, 250)).toBeLessThan(40); // "a" wins in the overlap
  });
});

describe("dev loop road graph", () => {
  const { world } = loadDevWorldWithRoads();
  const n = edge(world, "n"); // (-50,-50) -> (50,-50), 10 m wide, two-way, 2 lanes

  it("two-way, two-lane edges get one lane each way, right-hand traffic", () => {
    expect(n.laneCount).toEqual([1, 1]);
    expect(n.drivable).toBe(true);
    // a -> b runs east: its lane is right of travel = south (+z) of the centre line.
    const east = lanePath(n, 1, 0);
    const west = lanePath(n, -1, 0);
    expect(pathPoint(east, east.len / 2).z).toBeCloseTo(-50 + laneOffset(n, 1, 0), 9);
    expect(pathPoint(west, west.len / 2).z).toBeCloseTo(-50 - laneOffset(n, -1, 0), 9);
    expect(laneOffset(n, 1, 0)).toBeGreaterThan(1);
    expect(laneOffset(n, 1, 0)).toBeLessThan(n.widthM / 2);
  });

  it("lanes stop short of the corners so turns happen on connectors", () => {
    const east = lanePath(n, 1, 0);
    expect(east.len).toBeLessThan(n.center.len - 2 * 5);
    const start = pathPoint(east, 0);
    expect(start.x).toBeGreaterThan(-50 + 5);
  });

  it("sidewalks run beyond the kerb on both sides, keeping right per walking direction", () => {
    for (const side of [1, -1] as const) {
      for (const dir of [1, -1] as const) {
        const p = walkPath(n, dir, side);
        const mid = pathPoint(p, p.len / 2);
        // Distance from the centre line: kerb + sidewalk offset, shifted KEEP_RIGHT_M to the
        // walker's right (toward the road on one direction, away from it on the other).
        const line = n.widthM / 2 + n.sidewalkM[side === 1 ? 0 : 1];
        const d = Math.abs(mid.z + 50);
        expect(Math.abs(d - line)).toBeCloseTo(KEEP_RIGHT_M, 9);
        // Side +1 is right of a -> b (east): south, +z.
        expect(Math.sign(mid.z + 50)).toBe(side);
      }
    }
    expect(n.walkClear.flat().every(Boolean)).toBe(true);
  });

  it("each corner node knows its streets' bearings; sameCorner separates the corners", () => {
    const g = world.roads!;
    const ne = g.nodes[g.nodeIndex.get("ne")!]!;
    expect(ne.degree).toBe(2);
    expect(ne.bearings.length).toBe(2);
    // Inside the loop (south-west of the node) vs outside (north-east): different corners.
    expect(sameCorner(ne, 45, -45, 44, -44)).toBe(true);
    expect(sameCorner(ne, 45, -45, 55, -55)).toBe(false);
  });

  it("every area with road has the right pieces and lengths", () => {
    const g = world.roads!;
    let drive = 0;
    for (const a of g.areas) {
      drive += a.driveLen;
      expect(a.cx).toBe((a.ax + 0.5) * AREA_M);
      expect(a.driveCum[a.driveCum.length - 1]).toBeCloseTo(a.driveLen, 9);
    }
    expect(drive).toBeCloseTo(360, 6); // the loop is 2 x 100 + 2 x 80 m
  });
});

describe("grid city road graph", () => {
  const world = gridCity();

  it("one-way streets have lanes in one direction only", () => {
    const v = edge(world, "v10");
    expect(v.oneway).toBe(true);
    expect(v.laneCount).toEqual([2, 0]);
    expect(v.lanePaths[1].length).toBe(0);
    const g = world.roads!;
    const top = g.nodes[g.nodeIndex.get("g11")!]!;
    // From g11 you can go down v11 (a -> b) but never back up v10 against the flow.
    expect(top.out.some((o) => g.edges[o.edge]!.id === "v10")).toBe(false);
    expect(top.out.some((o) => g.edges[o.edge]!.id === "v11" && o.dir === 1)).toBe(true);
  });

  it("the four-lane arterial has two lanes each way, inside its width", () => {
    const h = edge(world, "h12");
    expect(h.laneCount).toEqual([2, 2]);
    for (const dir of [1, -1] as const) {
      for (let k = 0; k < 2; k++) {
        const o = laneOffset(h, dir, k);
        expect(o).toBeGreaterThan(0);
        expect(o + h.laneWidthM / 2).toBeLessThanOrEqual(h.widthM / 2 + 1e-9);
      }
    }
  });

  it("a sidewalk that runs into a building is refused; the other side stays usable", () => {
    const h = edge(world, "h10"); // z = 0, the intruder pokes onto its south (+z) sidewalk
    // a -> b runs east, so its right side (+1, sideIndex 0) is south.
    expect(h.walkClear[0][0]).toBe(false);
    expect(h.walkClear[1][0]).toBe(false);
    expect(h.walkClear[0][1]).toBe(true);
    expect(h.walkClear[1][1]).toBe(true);
    // Where an awning narrows a sidewalk, the walking line moves toward the kerb instead.
    const h2 = edge(world, "h20");
    expect(h2.sidewalkM[1]).toBe(1);
    expect(h2.walkClear[0][1] && h2.walkClear[1][1]).toBe(true);
    expect(h2.sidewalkM[0]).toBe(2);
    // Every usable path really is clear of buildings.
    for (const e of world.roads!.edges) {
      for (const di of [0, 1] as const) {
        e.lanePaths[di].forEach((p, k) => {
          if (!e.laneClear[di][k]) return;
          for (let s = 0; s <= p.len; s += 1) expect(circleBlocked(world, pathPoint(p, s).x, pathPoint(p, s).z, 0.3)).toBe(false);
        });
      }
    }
  });

  it("inside an acute corner, offset paths end before they would cross", () => {
    const g = world.roads!;
    const n00 = g.nodes[g.nodeIndex.get("g00")!]!;
    expect(n00.sharp).toBeGreaterThan(1.5); // ~49 degrees between north and diag
    const diag = edge(world, "diag");
    const north = edge(world, "north");
    // Both run away from g00; their inner-side sidewalks must not overlap near the node.
    const p = walkPath(diag, 1, -1);
    const q = walkPath(north, 1, 1);
    const p0 = pathPoint(p, 0);
    const q0 = pathPoint(q, 0);
    expect(projectOnPath(north.center, p0.x, p0.z).dist).toBeGreaterThan(north.widthM / 2);
    expect(projectOnPath(diag.center, q0.x, q0.z).dist).toBeGreaterThan(diag.widthM / 2);
  });

  it("connectors join a lane end to the next lane start, tangent at both ends", () => {
    const from = lanePath(edge(world, "h00"), 1, 0); // east along z = 0
    const to = lanePath(edge(world, "v10"), 1, 0); // south along x = 100 (one-way)
    const a = pathPoint(from, from.len);
    const b = pathPoint(to, 0);
    const cp = connector(a.x, a.z, a.tx, a.tz, b.x, b.z, b.tx, b.tz, 0.56);
    const path = connectorPath(cp);
    expect(path.xs[0]).toBe(a.x);
    expect(path.zs[path.zs.length - 1]).toBe(b.z);
    const s0 = pathPoint(path, 0.01);
    const s1 = pathPoint(path, path.len - 0.01);
    // (Sampled with 8 segments, so the end segments are within ~10 degrees of the tangent.)
    expect(s0.tx * a.tx + s0.tz * a.tz).toBeGreaterThan(0.98);
    expect(s1.tx * b.tx + s1.tz * b.tz).toBeGreaterThan(0.98);
    // A right turn stays near the corner: never farther than the lane ends are from the node.
    for (let i = 0; i < path.xs.length; i++) expect(Math.hypot(path.xs[i]! - 100, path.zs[i]! - 0)).toBeLessThan(12);
  });

  it("keeps traffic off a freeway and every ramp that leads to one, through ramp-only junctions, up to the first surface street", () => {
    // Freeway F (f1 - f2). Off ramp in two pieces: r1 from f2 to a ramp-only split k, r2 from k
    // to the surface street at s1. A second piece r3 leaves the same split for another surface
    // node s3. A slip road r4 joins two surface streets and touches no freeway.
    const nodes: RoadsFile["nodes"] = [
      { id: "f1", x: 0, z: 0 },
      { id: "f2", x: 200, z: 0 },
      { id: "k", x: 260, z: 40 },
      { id: "s1", x: 320, z: 80 },
      { id: "s2", x: 420, z: 80 },
      { id: "s3", x: 320, z: 160 },
      { id: "s4", x: 420, z: 160 },
    ];
    const ed = (id: string, a: string, b: string, kind: string, extra: Partial<RoadsFile["edges"][number]> = {}): RoadsFile["edges"][number] => {
      const pa = nodes.find((n) => n.id === a)!;
      const pb = nodes.find((n) => n.id === b)!;
      return { id, a, b, kind, lanes: 2, oneway: kind === "ramp", widthM: 8, points: [[pa.x, pa.z], [pb.x, pb.z]], ...extra };
    };
    const roads: RoadsFile = {
      version: 1,
      nodes,
      edges: [
        ed("F", "f1", "f2", "freeway", { gradeSeparated: true }),
        ed("r1", "f2", "k", "ramp"),
        ed("r2", "k", "s1", "ramp"),
        ed("r3", "k", "s3", "ramp"),
        ed("street", "s1", "s2", "residential"),
        ed("street2", "s3", "s4", "residential"),
        ed("cross", "s2", "s4", "residential"),
        ed("r4", "s1", "s3", "ramp"),
      ],
    };
    const g = buildRoadGraph(roads);
    const drivable = (id: string): boolean => g.edges[g.edgeIndex.get(id)!]!.drivable;
    expect(drivable("F")).toBe(false);
    expect(drivable("r1"), "joins the freeway").toBe(false);
    expect(drivable("r2"), "joins it through the ramp-only split").toBe(false);
    expect(drivable("r3"), "the other branch of the same split").toBe(false);
    expect(drivable("r4"), "the exclusion stops at surface streets").toBe(true);
    expect(drivable("street")).toBe(true);
  });

  it("is deterministic: the same roads.json in any order builds the same graph", () => {
    const roads = readJson<RoadsFile>("public/tiles/dev/roads.json");
    const shuffled: RoadsFile = { ...roads, nodes: [...roads.nodes].reverse(), edges: [...roads.edges].reverse() };
    const a = buildRoadGraph(roads);
    const b = buildRoadGraph(shuffled);
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
    expect(JSON.stringify(a.edges.map((e) => e.lanePaths))).toBe(JSON.stringify(b.edges.map((e) => e.lanePaths)));
    expect(JSON.stringify(a.areas)).toBe(JSON.stringify(b.areas));
  });
});
