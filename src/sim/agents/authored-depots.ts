import { boxBlocked } from "../collide.ts";
import { datan2 } from "../dmath.ts";
import { lanePath, pathPoint, projectOnPath } from "../roads.ts";
import { meshGroundHeight, type World } from "../world.ts";
import type { FleetDepot } from "./runtime-services.ts";

/** Original game location, not a claim about an existing real-world facility.
 * The point is on the existing northbound Embarcadero lane, 130 road metres
 * upstream of the Ferry spawn projection. Vehicles still follow that road.
 */
export const SF_FERRY_STANDBY = {
  id: "moat-ferry-standby",
  kind: "depot",
  x: 92.9624379333549,
  z: 169.69796957431421,
  source: "game-authored-original",
  roadEdgeId: "c12553201",
  direction: 1,
  lane: 0,
} as const;

const depotsByWorld = new WeakMap<World, readonly FleetDepot[]>();

function matchingStandbyDepots(world: World): FleetDepot[] {
  const site = SF_FERRY_STANDBY;
  const edge = world.roads?.edges.find((value) => value.id === site.roadEdgeId);
  if (!edge?.drivable || !edge.oneway || edge.laneCount[0] !== 3 || !edge.laneSafe[0][site.lane]) return [];
  const path = lanePath(edge, site.direction, site.lane);
  const projection = projectOnPath(path, site.x, site.z);
  if (projection.dist > 0.05 || projection.s < 5 || projection.s > path.len - 5) return [];
  const point = pathPoint(path, projection.s);
  if (boxBlocked(world, { x: site.x, z: site.z, heading: datan2(point.tx, -point.tz), hl: 2.6, hw: 1.1 }, meshGroundHeight(world, site.x, site.z))) return [];
  return [{ id: site.id, kind: site.kind, x: site.x, z: site.z }];
}

/** Install this location only on the matching immutable SF road, never on a foreign map. */
export function authoredStandbyDepots(world: World): readonly FleetDepot[] {
  let depots = depotsByWorld.get(world);
  if (depots === undefined) {
    depots = matchingStandbyDepots(world);
    depotsByWorld.set(world, depots);
  }
  return depots;
}
