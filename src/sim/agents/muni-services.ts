import { makePath, projectOnPath, subPath } from "../roads.ts";
import type { Path } from "../roads.ts";
import { parseFleetTransitLayer } from "../transit.ts";
import type { FleetTransitLayer } from "../transit.ts";
export type { FleetTransitLayer, FleetTransitRoute, FleetTransitStop } from "../transit.ts";

export const MUNI_FERRY_STOP_RADIUS_M = 100;
export const MUNI_ROAD_STOP_RADIUS_M = 30;
export const MAX_MUNI_LOCAL_CANDIDATES = 8;
export type MuniFallbackReason = "transit-unavailable" | "transit-invalid" | "no-ferry-bus-route" | "no-local-stop-pair" | "no-legal-local-segment";
export interface MuniLocalStop { readonly id: string; readonly x: number; readonly z: number }
export interface MuniLocalSegment {
  readonly sourceRouteId: string;
  readonly line: string;
  readonly direction: "inbound" | "outbound";
  readonly night: boolean;
  readonly sourcePathIndex: number;
  readonly sourcePath: Path;
  readonly stops: readonly [MuniLocalStop, MuniLocalStop];
}
export interface MuniLocalCandidates { readonly segments: readonly MuniLocalSegment[]; readonly fallbackReason: MuniFallbackReason | null }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const distance2 = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
  const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz;
};
const cache = new WeakMap<FleetTransitLayer, { x: number; z: number; result: MuniLocalCandidates }>();
function copyCandidates(value: MuniLocalCandidates): MuniLocalCandidates {
  return { fallbackReason: value.fallbackReason, segments: value.segments.map(segment => ({ ...segment,
    sourcePath: { ...segment.sourcePath, xs: [...segment.sourcePath.xs], zs: [...segment.sourcePath.zs], cum: [...segment.sourcePath.cum],
      ...(segment.sourcePath.bez ? { bez: [...segment.sourcePath.bez] } : {}) },
    stops: [{ ...segment.stops[0] }, { ...segment.stops[1] }] })) };
}

/** A source stop pair supplies the forward local segment. The fleet adapter must
 * separately prove legal lane geometry, full bus clearance and a closed return leg.
 */
export function muniLocalCandidates(input: Readonly<FleetTransitLayer> | null | undefined, ferry: { x: number; z: number }): MuniLocalCandidates {
  if (!input) return { segments: [], fallbackReason: "transit-unavailable" };
  let transit: FleetTransitLayer;
  try { transit = parseFleetTransitLayer(input); }
  catch { return { segments: [], fallbackReason: "transit-invalid" }; }
  const previous = cache.get(transit);
  if (previous && previous.x === ferry.x && previous.z === ferry.z) return copyCandidates(previous.result);
  const segments: (MuniLocalSegment & { ferryDistance2: number; lengthM: number })[] = [];
  let nearFerry = false;
  for (const route of [...transit.routes].filter(route => route.mode === "bus").sort((a, b) => compare(a.id, b.id))) {
    const stops = transit.stops.filter(stop => stop.routes.includes(route.id));
    if (!stops.some(stop => distance2(stop, ferry) <= MUNI_FERRY_STOP_RADIUS_M * MUNI_FERRY_STOP_RADIUS_M)) continue;
    nearFerry = true;
    for (let pathIndex = 0; pathIndex < route.paths.length; pathIndex++) {
      const points = route.paths[pathIndex]!, path = makePath(points.map(point => point[0]), points.map(point => point[1]));
      if (path.len < 60) continue;
      const ordered = stops.map(stop => ({ stop, projection: projectOnPath(path, stop.x, stop.z) }))
        .filter(value => value.projection.dist <= MUNI_ROAD_STOP_RADIUS_M).sort((a, b) => a.projection.s - b.projection.s || compare(a.stop.id, b.stop.id));
      for (const from of ordered.filter(value => distance2(value.stop, ferry) <= MUNI_FERRY_STOP_RADIUS_M * MUNI_FERRY_STOP_RADIUS_M)) {
        for (const to of ordered) {
          const lengthM = to.projection.s - from.projection.s;
          if (lengthM < 60 || lengthM > 650) continue;
          segments.push({ sourceRouteId: route.id, line: route.line, direction: route.direction, night: route.night,
            sourcePathIndex: pathIndex, sourcePath: subPath(path, from.projection.s, to.projection.s, 0.000001),
            stops: [{ id: from.stop.id, x: from.stop.x, z: from.stop.z }, { id: to.stop.id, x: to.stop.x, z: to.stop.z }],
            ferryDistance2: distance2(from.stop, ferry), lengthM });
        }
      }
    }
  }
  segments.sort((a, b) => a.ferryDistance2 - b.ferryDistance2 || Number(a.night) - Number(b.night) ||
    compare(a.sourceRouteId, b.sourceRouteId) || a.lengthM - b.lengthM || a.sourcePathIndex - b.sourcePathIndex || compare(a.stops[1].id, b.stops[1].id));
  const result: MuniLocalCandidates = { segments: segments.slice(0, MAX_MUNI_LOCAL_CANDIDATES).map(({ ferryDistance2: _distance, lengthM: _length, ...segment }) => segment),
    fallbackReason: segments.length ? null : nearFerry ? "no-local-stop-pair" : "no-ferry-bus-route" };
  cache.set(transit, { x: ferry.x, z: ferry.z, result });
  return copyCandidates(result);
}
