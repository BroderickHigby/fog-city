// The follower's indexed lane search and heap Dijkstra must give exactly what the original
// brute-force scan and sort-every-pop queue gave: same lanes, same routes, same visit budget.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, datan2, drivableNodeRoute, endNode, followerRoute, lanePath, nearestDrivableLane,
  pathPoint, projectOnPath, startNode, wrapAngle, type Dir, type RoadGraph, type RoadsFile,
} from "../../src/sim/index.ts";
import { ROOT, readJson } from "../helpers.ts";
import { gridCity, loadDevWorldWithRoads, SF_RUN_MS } from "./fixtures.ts";

/** The pre-index nearest lane: every edge, both directions. */
function referenceLane(graph: RoadGraph, point: { x: number; z: number }, heading?: number) {
  let best: { edge: number; dir: Dir; s: number; distance: number } | null = null;
  let score = Infinity;
  for (const edge of graph.edges) {
    if (!edge.drivable) continue;
    for (const dir of [1, -1] as const) {
      if (edge.laneCount[dir === 1 ? 0 : 1] === 0 || !edge.laneClear[dir === 1 ? 0 : 1][0]) continue;
      const path = lanePath(edge, dir, 0), p = projectOnPath(path, point.x, point.z), at = pathPoint(path, p.s);
      const cost = p.dist + (heading === undefined ? 0 : Math.abs(wrapAngle(datan2(at.tx, -at.tz) - heading)) * 2);
      if (cost < score || cost === score && best !== null && edge.id < graph.edges[best.edge]!.id) {
        score = cost; best = { edge: edge.index, dir, s: p.s, distance: p.dist };
      }
    }
  }
  return best;
}

/** The pre-heap search: re-sort the whole queue on every pop. */
function referenceRoute(graph: RoadGraph, from: number, to: number) {
  const costs = new Map<number, number>([[from, 0]]);
  const previous = new Map<number, { node: number; edge: number; dir: Dir }>();
  const queue: { node: number; cost: number }[] = [{ node: from, cost: 0 }];
  let visits = 0;
  while (queue.length && visits++ < graph.nodes.length * 4) {
    queue.sort((a, b) => a.cost - b.cost || (graph.nodes[a.node]!.id < graph.nodes[b.node]!.id ? -1 : graph.nodes[a.node]!.id > graph.nodes[b.node]!.id ? 1 : 0));
    const current = queue.shift()!;
    if (current.cost !== costs.get(current.node)) continue;
    if (current.node === to) {
      const route: { edge: number; dir: Dir }[] = [];
      let node = to;
      while (node !== from) { const p = previous.get(node)!; route.push({ edge: p.edge, dir: p.dir }); node = p.node; }
      return route.reverse();
    }
    const outgoing = [...graph.nodes[current.node]!.out].sort((a, b) => graph.edges[a.edge]!.id < graph.edges[b.edge]!.id ? -1 : graph.edges[a.edge]!.id > graph.edges[b.edge]!.id ? 1 : 0);
    for (const next of outgoing) {
      const edge = graph.edges[next.edge]!;
      if (!edge.drivable || !edge.laneClear[next.dir === 1 ? 0 : 1][0]) continue;
      const node = endNode(edge, next.dir), cost = current.cost + edge.center.len;
      if (cost >= (costs.get(node) ?? Infinity)) continue;
      costs.set(node, cost); previous.set(node, { node: current.node, edge: next.edge, dir: next.dir }); queue.push({ node, cost });
    }
  }
  return null;
}

/** xorshift32 points over (and a little beyond) the graph's extent. */
function samplePoints(graph: RoadGraph, count: number, seed: number) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const node of graph.nodes) { minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x); minZ = Math.min(minZ, node.z); maxZ = Math.max(maxZ, node.z); }
  let s = seed >>> 0;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const pad = 300;
  return Array.from({ length: count }, () => ({
    x: minX - pad + next() * (maxX - minX + 2 * pad), z: minZ - pad + next() * (maxZ - minZ + 2 * pad), heading: (next() - 0.5) * 2 * Math.PI,
  }));
}

function expectSameAsReference(graph: RoadGraph, count: number, seed: number): void {
  const points = samplePoints(graph, count, seed);
  for (const point of points) {
    expect(nearestDrivableLane(graph, point, point.heading)).toEqual(referenceLane(graph, point, point.heading));
    // Twice without a heading: the second answer comes from the per-goal cache.
    expect(nearestDrivableLane(graph, point)).toEqual(referenceLane(graph, point));
    expect(nearestDrivableLane(graph, point)).toEqual(referenceLane(graph, point));
  }
  for (let i = 0; i + 1 < points.length; i += 2) {
    const a = referenceLane(graph, points[i]!, points[i]!.heading), b = referenceLane(graph, points[i + 1]!);
    if (!a || !b) continue;
    const from = endNode(graph.edges[a.edge]!, a.dir), to = startNode(graph.edges[b.edge]!, b.dir);
    expect(drivableNodeRoute(graph, from, to)).toEqual(referenceRoute(graph, from, to));
    expect(drivableNodeRoute(graph, from, to)).toEqual(referenceRoute(graph, from, to));
  }
}

describe("follower route planning", () => {
  it("matches the exhaustive lane scan and full-sort Dijkstra on the grid city", () => {
    expectSameAsReference(gridCity().roads!, 400, 0x9e3779b9);
  });

  it("matches on the dev world and gives the same polyline for the same goal", () => {
    const { world } = loadDevWorldWithRoads();
    expectSameAsReference(world.roads!, 200, 12345);
    const body = { x: 5, z: -40, heading: 1, speed: 0 }, target = { x: -60, z: 30 };
    const route = followerRoute(world, body, target);
    expect(route.length).toBeGreaterThan(2);
    expect(followerRoute(world, body, target)).toEqual(route);
  });

  it("breaks exact score ties by lowest edge id, then the a -> b direction", () => {
    const roads: RoadsFile = { version: 1, nodes: [{ id: "n0", x: 0, z: 0 }, { id: "n1", x: 100, z: 0 }, { id: "n2", x: 0, z: 100 }, { id: "n3", x: 100, z: 100 }],
      edges: [
        { id: "z-top", a: "n0", b: "n1", kind: "residential", lanes: 2, oneway: false, points: [[0, 0], [100, 0]] },
        { id: "a-bottom", a: "n2", b: "n3", kind: "residential", lanes: 2, oneway: false, points: [[0, 100], [100, 100]] },
      ] };
    const graph = buildRoadGraph(roads);
    for (const point of [{ x: 50, z: 50 }, { x: -500, z: 50 }, { x: 50, z: 1e4 }]) {
      expect(nearestDrivableLane(graph, point)).toEqual(referenceLane(graph, point));
    }
  });

  const sfRoads = join(ROOT, "public/tiles/sf/roads.json");
  it.skipIf(!existsSync(sfRoads))("matches on the real San Francisco road graph", () => {
    const graph = buildRoadGraph(readJson<RoadsFile>("public/tiles/sf/roads.json"));
    expect(graph.edges.length).toBeGreaterThan(10_000);
    expectSameAsReference(graph, 60, 2026);
  }, SF_RUN_MS);
});
