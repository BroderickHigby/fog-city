// Procedural traffic phases shared by the simulation and rendered signal heads.
// No live timing feed: the source layer says which SF nodes are signal-controlled.
import { TICK_HZ } from "./contract.ts";
import { datan2, PI } from "./dmath.ts";
import type { RoadEdgeInfo, RoadGraph } from "./roads.ts";

export type TrafficSignalAspect = "green" | "yellow" | "red";
export interface TrafficSignalFile {
  signals: readonly { node: string; kind: string; ped?: boolean }[];
}
export interface TrafficSignalJunction {
  readonly node: string;
  readonly groupCount: number;
  readonly approaches: ReadonlyMap<string, number>;
}
export type TrafficSignalControls = ReadonlyMap<string, TrafficSignalJunction>;

export const SIGNAL_GREEN_S = 27;
export const SIGNAL_YELLOW_S = 3;
export const SIGNAL_ALL_RED_S = 2;
export const SIGNAL_SLOT_S = SIGNAL_GREEN_S + SIGNAL_YELLOW_S + SIGNAL_ALL_RED_S;
const AXIS_TOLERANCE = 25 * PI / 180;

function hashId(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The direction of the approach's centreline at this node, modulo half a turn. */
function approachAxis(edge: RoadEdgeInfo, start: boolean): number | null {
  const path = edge.center, end = start ? 0 : path.xs.length - 1;
  for (let i = start ? 1 : end - 1; start ? i < path.xs.length : i >= 0; i += start ? 1 : -1) {
    const dx = path.xs[i]! - path.xs[end]!, dz = path.zs[i]! - path.zs[end]!;
    if (dx * dx + dz * dz < 1e-8) continue;
    const angle = datan2(dx, -dz);
    return angle - PI * Math.floor(angle / PI);
  }
  return null;
}
const axisDistance = (a: number, b: number): number => Math.min(Math.abs(a - b), PI - Math.abs(a - b));

/** Build once from valid incoming road approaches; source display groups are not trusted. */
export function buildTrafficSignals(graph: RoadGraph, file: TrafficSignalFile): TrafficSignalControls {
  const controlled = new Set(file.signals.filter(signal => signal.kind === "signal").map(signal => signal.node));
  const incoming = new Map<string, Array<{ edge: string; axis: number }>>();
  const add = (edge: RoadEdgeInfo, node: string, start: boolean): void => {
    if (!controlled.has(node)) return;
    const axis = approachAxis(edge, start);
    if (axis === null) return;
    const rows = incoming.get(node) ?? [];
    rows.push({ edge: edge.id, axis }); incoming.set(node, rows);
  };
  for (const edge of graph.edges) {
    if (!edge.drivable) continue;
    if (edge.laneCount[1] > 0) add(edge, graph.nodes[edge.a]!.id, true);
    if (edge.laneCount[0] > 0) add(edge, graph.nodes[edge.b]!.id, false);
  }
  const controls = new Map<string, TrafficSignalJunction>();
  for (const node of [...incoming.keys()].sort()) {
    const rows = incoming.get(node)!.sort((a, b) => a.axis - b.axis || (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
    const groups: typeof rows[] = [];
    for (const row of rows) {
      // Complete-link grouping prevents a chain of skew streets collapsing into one phase.
      const group = groups.find(candidate => candidate.every(other => axisDistance(row.axis, other.axis) <= AXIS_TOLERANCE));
      if (group) group.push(row); else groups.push([row]);
    }
    const approaches = new Map<string, number>();
    groups.forEach((group, index) => group.forEach(row => approaches.set(row.edge, index)));
    controls.set(node, { node, groupCount: groups.length, approaches });
  }
  return controls;
}

/** One group owns its green/amber slot; every transition has a two-second all-red gap. */
export function signalPhase(node: string, group: number, tick: number, groupCount: number): { aspect: TrafficSignalAspect; walk: boolean } {
  if (!Number.isInteger(groupCount) || groupCount < 1 || !Number.isInteger(group) || group < 0 || group >= groupCount || !Number.isFinite(tick)) return { aspect: "red", walk: false };
  const slot = SIGNAL_SLOT_S * TICK_HZ, cycle = slot * groupCount;
  const now = ((tick + hashId(node) % cycle) % cycle + cycle) % cycle;
  const active = Math.floor(now / slot), within = now - active * slot;
  const aspect: TrafficSignalAspect = active !== group ? "red" : within < SIGNAL_GREEN_S * TICK_HZ ? "green" : within < (SIGNAL_GREEN_S + SIGNAL_YELLOW_S) * TICK_HZ ? "yellow" : "red";
  // A head's WALK crosses its own vehicle approach during another axis's green.
  return { aspect, walk: groupCount > 1 && active !== group && within < 20 * TICK_HZ };
}

export function signalAspect(controls: TrafficSignalControls | undefined, node: string, edgeId: string, tick: number): TrafficSignalAspect | null {
  const control = controls?.get(node), group = control?.approaches.get(edgeId);
  return control && group !== undefined ? signalPhase(node, group, tick, control.groupCount).aspect : null;
}
