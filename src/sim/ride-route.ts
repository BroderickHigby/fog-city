// Rider destinations use the legal road graph. The nearest reachable point can require
// driving away from the goal first; choosing the nearest next junction can loop forever.
import { dirIndex, endNode, projectOnPath, type DirEdge, type RoadGraph } from "./roads.ts";

const routes = new WeakMap<RoadGraph, Map<string, DirEdge | null>>();
const ROUTE_CACHE_LIMIT = 256;

/** First edge of the shortest legal route to the road point nearest the destination. */
export function rideRouteNext(graph: RoadGraph, from: number, goal: { x: number; z: number }): DirEdge | null {
  let cache = routes.get(graph);
  if (!cache) { cache = new Map(); routes.set(graph, cache); }
  const key = `${from}:${goal.x},${goal.z}`;
  if (cache.has(key)) return cache.get(key)!;
  const n = graph.nodes.length;
  const costs = new Float64Array(n).fill(Infinity);
  const previous: (DirEdge | null)[] = new Array(n).fill(null);
  const parents = new Int32Array(n).fill(-1);
  const heap: Array<{ node: number; cost: number }> = [];
  const less = (a: { node: number; cost: number }, b: { node: number; cost: number }): boolean =>
    a.cost < b.cost || a.cost === b.cost && graph.nodes[a.node]!.id < graph.nodes[b.node]!.id;
  const push = (node: number, cost: number): void => {
    const value = { node, cost };
    let at = heap.length;
    heap.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!less(value, heap[parent]!)) break;
      heap[at] = heap[parent]!; at = parent;
    }
    heap[at] = value;
  };
  const pop = (): { node: number; cost: number } => {
    const result = heap[0]!, last = heap.pop()!;
    if (!heap.length) return result;
    let at = 0;
    while (2 * at + 1 < heap.length) {
      let child = 2 * at + 1;
      if (child + 1 < heap.length && less(heap[child + 1]!, heap[child]!)) child++;
      if (!less(heap[child]!, last)) break;
      heap[at] = heap[child]!; at = child;
    }
    heap[at] = last;
    return result;
  };
  costs[from] = 0; push(from, 0);
  let closest = Infinity, shortest = Infinity;
  let final: { node: number; edge: DirEdge } | null = null;
  while (heap.length) {
    const current = pop();
    if (current.cost !== costs[current.node]) continue;
    // out is stable by edge index/direction; equal-cost paths keep their first predecessor.
    for (const next of graph.nodes[current.node]!.out) {
      const edge = graph.edges[next.edge]!;
      if (!edge.drivable || next.dir === -1 && edge.oneway || !edge.laneClear[dirIndex(next.dir)].some(Boolean)) continue;
      const projection = projectOnPath(edge.center, goal.x, goal.z);
      const travel = current.cost + (next.dir === 1 ? projection.s : edge.center.len - projection.s);
      if (projection.dist < closest || projection.dist === closest && travel < shortest) {
        closest = projection.dist; shortest = travel; final = { node: current.node, edge: next };
      }
      const node = endNode(edge, next.dir), cost = current.cost + edge.center.len;
      if (cost >= costs[node]!) continue;
      costs[node] = cost; previous[node] = next; parents[node] = current.node; push(node, cost);
    }
  }
  let result: DirEdge | null = final?.edge ?? null;
  if (final) {
    for (let node = final.node; node !== from; node = parents[node]!) result = previous[node]!;
  }
  if (cache.size >= ROUTE_CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
