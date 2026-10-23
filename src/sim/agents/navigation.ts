// Immutable pedestrian navigation. The graph belongs to world data, not saved agent state.
import { datan2, PI, TAU } from "../dmath.ts";
import { buildRoadGraph, makePath, pathPoint } from "../roads.ts";
import type { Path, RoadGraph, RoadsFile } from "../roads.ts";

export interface SidewalkNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

export interface SidewalkEdgeInput {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly kind: "sidewalk" | "crosswalk" | "stairs" | "freeway" | "ramp";
  readonly bidirectional?: boolean;
  readonly gradeSeparated?: boolean;
  readonly roadId?: string;
}

export interface SidewalkGraphInput {
  readonly nodes: ReadonlyArray<SidewalkNode>;
  readonly edges: ReadonlyArray<SidewalkEdgeInput>;
}

export interface SidewalkEdge {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly kind: "sidewalk" | "crosswalk" | "stairs";
  readonly roadId: string | null;
  readonly path: Path;
}

export interface SidewalkTraversal {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly reverse: boolean;
}

export interface SidewalkGraph {
  readonly nodes: ReadonlyArray<SidewalkNode>;
  readonly edges: ReadonlyArray<SidewalkEdge>;
  readonly nodeById: ReadonlyMap<string, SidewalkNode>;
  readonly edgeById: ReadonlyMap<string, SidewalkEdge>;
  readonly outgoing: ReadonlyMap<string, ReadonlyArray<SidewalkTraversal>>;
}

export interface SidewalkRoute {
  readonly nodeIds: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<SidewalkTraversal>;
  readonly lengthM: number;
}

/** Query can also gate crosswalks using the current signal phase and vehicle gap. */
export type BlockedSidewalkQuery = (edge: SidewalkEdge, traversal: SidewalkTraversal) => boolean;

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function samePoint(a: readonly [number, number], b: SidewalkNode): boolean {
  return Math.abs(a[0] - b.x) <= 1e-6 && Math.abs(a[1] - b.z) <= 1e-6;
}

/** Consume Lane 1's explicit sidewalk/crosswalk graph; reject disconnected path endpoints. */
export function buildSidewalkGraph(input: SidewalkGraphInput): SidewalkGraph {
  const nodes = [...input.nodes].map((n) => ({ ...n })).sort((a, b) => compareId(a.id, b.id));
  const nodeById = new Map<string, SidewalkNode>();
  const outgoing = new Map<string, SidewalkTraversal[]>();
  for (const node of nodes) {
    if (nodeById.has(node.id) || !Number.isFinite(node.x) || !Number.isFinite(node.z)) {
      throw new Error(`Invalid sidewalk node: ${node.id}`);
    }
    nodeById.set(node.id, node);
    outgoing.set(node.id, []);
  }
  const edges: SidewalkEdge[] = [];
  const edgeById = new Map<string, SidewalkEdge>();
  for (const raw of [...input.edges].sort((a, b) => compareId(a.id, b.id))) {
    if (raw.kind === "freeway" || raw.kind === "ramp" || raw.gradeSeparated) continue;
    const a = nodeById.get(raw.a);
    const b = nodeById.get(raw.b);
    if (edgeById.has(raw.id) || !a || !b || raw.points.length < 2 ||
      raw.points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])) ||
      !samePoint(raw.points[0]!, a) || !samePoint(raw.points[raw.points.length - 1]!, b)) {
      throw new Error(`Invalid sidewalk edge: ${raw.id}`);
    }
    const path = makePath(raw.points.map((p) => p[0]), raw.points.map((p) => p[1]));
    if (path.len <= 0) throw new Error(`Zero length sidewalk edge: ${raw.id}`);
    const edge: SidewalkEdge = { id: raw.id, a: raw.a, b: raw.b, kind: raw.kind, roadId: raw.roadId ?? null, path };
    edges.push(edge);
    edgeById.set(edge.id, edge);
    outgoing.get(edge.a)!.push({ edgeId: edge.id, from: edge.a, to: edge.b, reverse: false });
    if (raw.bidirectional !== false) {
      outgoing.get(edge.b)!.push({ edgeId: edge.id, from: edge.b, to: edge.a, reverse: true });
    }
  }
  return { nodes, edges, nodeById, edgeById, outgoing };
}

/**
 * Offset fallback reuses the road graph's building-cleared walkPaths. Junction endpoints form
 * a ring: only neighbors connect, and a crossing may span at most one street mouth. Missing
 * sidewalks therefore cannot create a diagonal shortcut across several streets.
 */
export function buildFallbackSidewalkGraph(roads: RoadGraph | RoadsFile): SidewalkGraph {
  const graph = "nodeIndex" in roads ? roads : buildRoadGraph(roads);
  const nodes: SidewalkNode[] = [];
  const edges: SidewalkEdgeInput[] = [];
  const ends = new Map<number, SidewalkNode[]>();
  for (const road of [...graph.edges].sort((a, b) => compareId(a.id, b.id))) {
    if (!road.walkable || road.kind === "freeway" || road.kind === "ramp") continue;
    for (const side of [0, 1] as const) {
      const path = road.walkPaths[0][side];
      if (path.len <= 0) continue;
      const first = pathPoint(path, 0);
      const last = pathPoint(path, path.len);
      const a = { id: JSON.stringify(["end", road.id, side, graph.nodes[road.a]!.id]), x: first.x, z: first.z };
      const b = { id: JSON.stringify(["end", road.id, side, graph.nodes[road.b]!.id, ...(road.a === road.b ? ["return"] : [])]), x: last.x, z: last.z };
      nodes.push(a, b);
      for (const [index, node] of [[road.a, a], [road.b, b]] as const) {
        const list = ends.get(index) ?? [];
        list.push(node);
        ends.set(index, list);
      }
      // A blocked mid-block sidewalk must not erase the corner/crosswalk topology.
      if (road.walkClear[0][side] && road.walkClear[1][side]) {
        edges.push({ id: JSON.stringify(["walk", road.id, side]), a: a.id, b: b.id,
          kind: "sidewalk", roadId: road.id, points: path.xs.map((x, i) => [x, path.zs[i]!] as const) });
      }
    }
  }
  for (const index of [...ends.keys()].sort((a, b) => a - b)) {
    const junction = graph.nodes[index]!;
    const angle = (n: SidewalkNode): number => datan2(n.x - junction.x, -(n.z - junction.z));
    const list = ends.get(index)!.sort((a, b) => angle(a) - angle(b) || compareId(a.id, b.id));
    const pairs = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const b = list[(i + 1) % list.length]!;
      if (a.id === b.id) continue;
      const start = angle(a);
      const span = (angle(b) - start + TAU) % TAU;
      // A chord follows the short arc. Never label a chord using the opposite long arc,
      // particularly at a dead end where that could turn a crosswalk into a sidewalk.
      if (span > PI) continue;
      const crossed = junction.bearings.filter((bearing) => {
        const delta = (bearing - start + TAU) % TAU;
        return delta > 1e-7 && delta < span - 1e-7;
      }).length;
      if (crossed > 1) continue;
      const pair = JSON.stringify([a.id, b.id].sort(compareId));
      if (pairs.has(pair) || (a.x === b.x && a.z === b.z)) continue;
      pairs.add(pair);
      edges.push({ id: JSON.stringify(["junction", junction.id, pair]), a: a.id, b: b.id,
        kind: crossed === 0 ? "sidewalk" : "crosswalk", points: [[a.x, a.z], [b.x, b.z]] });
    }
  }
  return buildSidewalkGraph({ nodes, edges });
}

interface Frontier { id: string; distance: number; estimate: number; key: string }
const compareFrontier = (a: Frontier, b: Frontier): number =>
  a.estimate - b.estimate || a.distance - b.distance || compareId(a.key, b.key) || compareId(a.id, b.id);

function pushHeap(heap: Frontier[], value: Frontier): void {
  heap.push(value);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (compareFrontier(heap[parent]!, value) <= 0) break;
    heap[at] = heap[parent]!;
    at = parent;
  }
  heap[at] = value;
}

function popHeap(heap: Frontier[]): Frontier {
  const result = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return result;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && compareFrontier(heap[child + 1]!, heap[child]!) < 0) child++;
    if (compareFrontier(last, heap[child]!) <= 0) break;
    heap[at] = heap[child]!;
    at = child;
  }
  heap[at] = last;
  return result;
}

const traversalKeys = new WeakMap<SidewalkTraversal, string>();
function traversalKey(step: SidewalkTraversal): string {
  let key = traversalKeys.get(step);
  if (key === undefined) { key = `${JSON.stringify([step.edgeId, step.to])}\n`; traversalKeys.set(step, key); }
  return key;
}

/** Geometric A*; exact length ties choose the same lexicographic path as Dijkstra. */
export function shortestSidewalkRoute(
  graph: SidewalkGraph, start: string, target: string, isBlocked?: BlockedSidewalkQuery,
): SidewalkRoute | null {
  if (!graph.nodeById.has(start) || !graph.nodeById.has(target)) return null;
  const best = new Map<string, Frontier>();
  const previous = new Map<string, SidewalkTraversal>();
  const destination = graph.nodeById.get(target)!;
  const remaining = (id: string): number => {
    const node = graph.nodeById.get(id)!;
    const dx = node.x - destination.x, dz = node.z - destination.z;
    // Conservatively round below the Euclidean lower bound, including near ties.
    return Math.sqrt(dx * dx + dz * dz) * 0.999999999;
  };
  const initial = { id: start, distance: 0, estimate: remaining(start), key: "" };
  best.set(start, initial);
  const heap = [initial];
  while (heap.length > 0) {
    const current = popHeap(heap);
    if (best.get(current.id) !== current) continue;
    if (current.id === target) {
      const steps: SidewalkTraversal[] = [];
      let id = target;
      while (id !== start) {
        const step = previous.get(id)!;
        steps.push(step);
        id = step.from;
      }
      steps.reverse();
      return { nodeIds: [start, ...steps.map((step) => step.to)], steps, lengthM: current.distance };
    }
    for (const step of graph.outgoing.get(current.id)!) {
      const edge = graph.edgeById.get(step.edgeId)!;
      if (isBlocked?.(edge, step)) continue;
      const distance = current.distance + edge.path.len;
      const candidate = { id: step.to, distance, estimate: distance + remaining(step.to),
        key: current.key + traversalKey(step) };
      const prior = best.get(step.to);
      if (!prior || compareFrontier(candidate, prior) < 0) {
        best.set(step.to, candidate);
        previous.set(step.to, step);
        pushHeap(heap, candidate);
      }
    }
  }
  return null;
}

export interface SidewalkCursor { readonly stepIndex: number; readonly distanceM: number }
export interface SidewalkAdvance {
  readonly cursor: SidewalkCursor;
  readonly point: { x: number; z: number };
  readonly movedM: number;
  readonly finished: boolean;
  readonly blockedEdgeId: string | null;
}

/** Proposes movement along connected geometry; the clearance/dodge owner decides whether to apply it. */
export function advanceSidewalkRoute(
  graph: SidewalkGraph, route: SidewalkRoute, cursor: SidewalkCursor, distanceM: number,
  isBlocked?: BlockedSidewalkQuery,
): SidewalkAdvance {
  if (!Number.isFinite(distanceM) || distanceM < 0 || !Number.isInteger(cursor.stepIndex) ||
    cursor.stepIndex < 0 || cursor.stepIndex > route.steps.length ||
    !Number.isFinite(cursor.distanceM) || cursor.distanceM < 0) throw new Error("Invalid sidewalk advance");
  let stepIndex = cursor.stepIndex;
  let along = cursor.distanceM;
  let remaining = distanceM;
  let blockedEdgeId: string | null = null;
  while (stepIndex < route.steps.length) {
    const step = route.steps[stepIndex]!;
    const edge = graph.edgeById.get(step.edgeId)!;
    if (along > edge.path.len) throw new Error("Cursor exceeds sidewalk edge");
    if (isBlocked?.(edge, step)) { blockedEdgeId = edge.id; break; }
    const travel = Math.min(remaining, edge.path.len - along);
    along += travel;
    remaining -= travel;
    if (along < edge.path.len) break;
    stepIndex++;
    along = 0;
    if (remaining === 0) break;
  }
  let point: { x: number; z: number };
  if (stepIndex === route.steps.length) {
    const end = graph.nodeById.get(route.nodeIds[route.nodeIds.length - 1]!)!;
    point = { x: end.x, z: end.z };
  } else {
    const step = route.steps[stepIndex]!;
    const path = graph.edgeById.get(step.edgeId)!.path;
    const p = pathPoint(path, step.reverse ? path.len - along : along);
    point = { x: p.x, z: p.z };
  }
  return { cursor: { stepIndex, distanceM: along }, point, movedM: distanceM - remaining,
    finished: stepIndex === route.steps.length, blockedEdgeId };
}
