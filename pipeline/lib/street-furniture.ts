// Traffic signals and stop signs at junctions, placed from SFMTA data on the junction paint
// (street-markings.ts). Render-only: no colliders (a collidable pole is a separate,
// SIM_VERSION-bumping change).
//
// Signals (SFMTA Traffic Signals ybh5-27n2, via signals.json): one pole on the near-right
// corner of every approach into a signalised node, just short of the crosswalk, with a head
// facing the approaching traffic. On wide approaches (half-width >= MAST_ARM_MIN_HALF_M) the
// pole carries a mast arm reaching over the lanes with a second head, as on SF's arterials.
// Approaches split into two phase groups by axis (the first approach's axis is group 0), so
// a renderer can cycle them; signal timing is not published, so the phase is the renderer's.
// Where the node has pedestrian heads (`ped`), each pole also gets one facing across its own
// leg's crosswalk to the far corner.
//
// Stop signs (SFMTA Stop Signs 4542-gpa3): one post on the near-right corner of each approach
// a sign faces, just short of the stop bar; `allWay` when every approach into the node is
// stop-controlled (the "ALL WAY" plaque).
//
// Ids are `sig:<node>:<edge>` and `stop:<node>:<edge>`, stable across rebuilds.

import type { Junction } from "./street-markings.ts";
import type { RoadGraph } from "./roads.ts";
import { bearing } from "./geom.ts";
import { insideRibbon } from "./street-markings.ts";

/** From the kerb to the pole, metres. */
export const POLE_OFFSET_M = 0.8;
export const MAST_ARM_MIN_HALF_M = 6;

export interface SignalPole {
  id: string;
  node: string;
  x: number;
  z: number;
  /** Compass bearing the vehicle head faces (toward the approaching traffic). */
  heading: number;
  /** Phase group: 0 or 1 (approaches on one axis share a group). */
  group: 0 | 1;
  /** Mast-arm length over the lanes, metres (0 = a post-top head only). */
  arm: number;
  /** Compass bearing of the pedestrian head (across this leg's crosswalk), or null. */
  ped: number | null;
}

export interface StopSign {
  id: string;
  node: string;
  x: number;
  z: number;
  /** Compass bearing the sign face looks toward (the approaching traffic). */
  heading: number;
  allWay: boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Which legs carry traffic into the node (a one-way leaving it does not). */
function inboundEdges(graph: RoadGraph, node: string): Set<string> {
  const out = new Set<string>();
  for (const e of graph.edges) {
    if (e.pedestrian) continue;
    if (e.b === node || (e.a === node && !e.oneway)) out.add(e.id);
  }
  return out;
}

export function buildFurniture(
  graph: RoadGraph,
  junctions: readonly Junction[],
  signals: ReadonlyMap<string, { ped: boolean }>,
  stopApproaches: ReadonlySet<string>,
): { signals: SignalPole[]; stopSigns: StopSign[] } {
  const poles: SignalPole[] = [];
  const stops: StopSign[] = [];
  const nodeEdges = new Map<string, Set<string>>();
  // Streets by 100 m cell of their bounding boxes, for clearing poles off every carriageway.
  const grid = new Map<string, RoadGraph["edges"]>();
  for (const e of graph.edges) {
    if (e.pedestrian) continue;
    const xs = e.points.map((p) => p[0]), zs = e.points.map((p) => p[1]);
    const pad = e.widthM / 2 + 1;
    for (let cx = Math.floor((Math.min(...xs) - pad) / 100); cx <= Math.floor((Math.max(...xs) + pad) / 100); cx++) {
      for (let cz = Math.floor((Math.min(...zs) - pad) / 100); cz <= Math.floor((Math.max(...zs) + pad) / 100); cz++) {
        const k = `${cx},${cz}`;
        const l = grid.get(k);
        if (l) l.push(e);
        else grid.set(k, [e]);
      }
    }
  }
  const nearby = (x: number, z: number): RoadGraph["edges"] => {
    const out = new Set<RoadGraph["edges"][number]>();
    for (let cx = Math.floor(x / 100) - 1; cx <= Math.floor(x / 100) + 1; cx++) {
      for (let cz = Math.floor(z / 100) - 1; cz <= Math.floor(z / 100) + 1; cz++) for (const e of grid.get(`${cx},${cz}`) ?? []) out.add(e);
    }
    return [...out];
  };
  for (const j of junctions) {
    const signal = signals.get(j.id);
    const controlled = j.legs.filter((l) => stopApproaches.has(`${j.id}|${l.edge}`));
    if (!signal && !controlled.length) continue;
    let inbound = nodeEdges.get(j.id);
    if (!inbound) nodeEdges.set(j.id, (inbound = inboundEdges(graph, j.id)));
    // The corner point of a leg: on its approach side (v < 0), just off the kerb, `t` along it,
    // stepped out along the leg until it stands clear of every street meeting there.
    const streets = nearby(j.x, j.z);
    const at = (l: Junction["legs"][number], t0: number): { x: number; z: number } => {
      const v = -(l.half + POLE_OFFSET_M);
      let p = { x: 0, z: 0 };
      for (let t = t0; t < t0 + 30; t += 0.5) {
        p = { x: r2(j.x + l.ox + l.ux * t - l.uz * v), z: r2(j.z + l.oz + l.uz * t + l.ux * v) };
        if (!streets.some((e) => insideRibbon(p.x, p.z, e.points, e.widthM / 2 + 0.3))) break;
      }
      return p;
    };
    if (signal) {
      const approaches = j.legs.filter((l) => inbound!.has(l.edge));
      const a0 = approaches[0] ? Math.atan2(approaches[0].ux, -approaches[0].uz) : 0;
      for (const l of approaches) {
        const t = l.crosswalk ? l.crosswalk.from : l.stop ? l.stop.at : l.mouth;
        const a = Math.atan2(l.ux, -l.uz);
        const group: 0 | 1 = Math.abs(Math.sin(a - a0)) < Math.SQRT1_2 ? 0 : 1;
        poles.push({
          id: `sig:${j.id}:${l.edge}`,
          node: j.id,
          ...at(l, Math.max(0, t - 0.3)),
          heading: r4(bearing(l.ux, l.uz)),
          group,
          arm: l.half >= MAST_ARM_MIN_HALF_M ? r2(l.half + POLE_OFFSET_M - 1.5) : 0,
          ped: signal.ped ? r4(bearing(-l.uz, l.ux)) : null,
        });
      }
    }
    const allWay = controlled.length > 0 && [...inbound].every((e) => j.legs.every((l) => l.edge !== e) || stopApproaches.has(`${j.id}|${e}`));
    for (const l of controlled) {
      const t = l.stop ? l.stop.at : l.crosswalk ? l.crosswalk.to : l.mouth;
      stops.push({ id: `stop:${j.id}:${l.edge}`, node: j.id, ...at(l, Math.max(0, t - 0.2)), heading: r4(bearing(l.ux, l.uz)), allWay });
    }
  }
  return { signals: poles, stopSigns: stops };
}
