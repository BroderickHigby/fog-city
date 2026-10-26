import { datan2 } from "../sim/dmath.ts";
import { lanePath, pathPoint } from "../sim/roads.ts";
import { nearestDrivableLane } from "../sim/vehicles/follower.ts";
import type { World } from "../sim/world.ts";

/** Safehouse markers can sit inside blocks; restore the car on the nearest clear lane. */
export function restoreSpawn(world: World, site: { x: number; z: number }): { x: number; z: number; heading: number } {
  const roads = world.roads;
  const lane = roads ? nearestDrivableLane(roads, site) : null;
  if (!roads || !lane) return { x: site.x, z: site.z, heading: 0 };
  const at = pathPoint(lanePath(roads.edges[lane.edge]!, lane.dir, 0), lane.s);
  return { x: at.x, z: at.z, heading: datan2(at.tx, -at.tz) };
}
