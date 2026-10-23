// Static geometry cache only: simulation/replay state never stores this index.
import type { SidewalkGraph, SidewalkNode } from "./navigation.ts";

export interface SidewalkQueryPoint {
  readonly x: number;
  readonly z: number;
}

interface NodeBranch {
  readonly node: SidewalkNode;
  readonly left: NodeBranch | null;
  readonly right: NodeBranch | null;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly minId: string;
}
interface NavigationIndex { readonly root: NodeBranch | null }

// Graph identity is the cache key. Callers replace the graph object when geometry changes.
const indices = new WeakMap<SidewalkGraph, NavigationIndex>();
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function validatePoint(point: SidewalkQueryPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) throw new RangeError("Invalid sidewalk query point");
}

function makeBranch(nodes: SidewalkNode[]): NodeBranch | null {
  if (nodes.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minId = nodes[0]!.id;
  for (const node of nodes) {
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minZ = Math.min(minZ, node.z); maxZ = Math.max(maxZ, node.z);
    if (node.id < minId) minId = node.id;
  }
  const splitX = maxX - minX >= maxZ - minZ;
  nodes.sort((a, b) => (splitX ? a.x - b.x || a.z - b.z : a.z - b.z || a.x - b.x) || compareId(a.id, b.id));
  const middle = Math.floor(nodes.length / 2);
  return { node: nodes[middle]!, left: makeBranch(nodes.slice(0, middle)), right: makeBranch(nodes.slice(middle + 1)),
    minX, maxX, minZ, maxZ, minId };
}

function indexOf(graph: SidewalkGraph): NavigationIndex {
  const cached = indices.get(graph);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    validatePoint(node);
    if (ids.has(node.id)) throw new RangeError("Duplicate sidewalk node id");
    ids.add(node.id);
  }
  const index: NavigationIndex = { root: makeBranch([...graph.nodes]) };
  indices.set(graph, index);
  return index;
}

function distance(a: SidewalkQueryPoint, b: SidewalkQueryPoint): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function lowerBound(branch: NodeBranch, point: SidewalkQueryPoint): number {
  const dx = point.x < branch.minX ? branch.minX - point.x : point.x > branch.maxX ? point.x - branch.maxX : 0;
  const dz = point.z < branch.minZ ? branch.minZ - point.z : point.z > branch.maxZ ? point.z - branch.maxZ : 0;
  // The original callers compare rounded metre distances, not their squares. Using the
  // same operation here keeps a sqrt-rounded tie eligible for its lexicographic ID.
  return Math.sqrt(dx * dx + dz * dz);
}

/** Exact nearest node under the existing metre-distance/ID ordering; null for an empty graph. */
export function nearestSidewalkNode(graph: SidewalkGraph, point: SidewalkQueryPoint): SidewalkNode | null {
  validatePoint(point);
  const root = indexOf(graph).root;
  if (!root) return null;
  let best: SidewalkNode | null = null, bestDistance = Infinity;
  const visit = (branch: NodeBranch, bound: number): void => {
    if (bound > bestDistance || (bound === bestDistance && best !== null && branch.minId >= best.id)) return;
    const score = distance(branch.node, point);
    if (best === null || score < bestDistance || (score === bestDistance && branch.node.id < best.id)) {
      best = branch.node; bestDistance = score;
    }
    const left = branch.left, right = branch.right;
    const leftBound = left ? lowerBound(left, point) : Infinity, rightBound = right ? lowerBound(right, point) : Infinity;
    if (left && right) {
      if (leftBound < rightBound || (leftBound === rightBound && left.minId < right.minId)) {
        visit(left, leftBound); visit(right, rightBound);
      } else { visit(right, rightBound); visit(left, leftBound); }
    } else if (left) visit(left, leftBound);
    else if (right) visit(right, rightBound);
  };
  visit(root, lowerBound(root, point));
  return best;
}

/** Inclusive radius query, sorted by metre distance then code-unit ID, with original node references. */
export function sidewalkNodesWithin(graph: SidewalkGraph, point: SidewalkQueryPoint, radius: number): SidewalkNode[] {
  validatePoint(point);
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError("Invalid sidewalk query radius");
  const root = indexOf(graph).root;
  if (!root) return [];
  const found: { readonly node: SidewalkNode; readonly distance: number }[] = [];
  const visit = (branch: NodeBranch): void => {
    if (lowerBound(branch, point) > radius) return;
    const score = distance(branch.node, point);
    if (score <= radius) found.push({ node: branch.node, distance: score });
    if (branch.left) visit(branch.left);
    if (branch.right) visit(branch.right);
  };
  visit(root);
  found.sort((a, b) => a.distance - b.distance || compareId(a.node.id, b.node.id));
  return found.map((item) => item.node);
}
