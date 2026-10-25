import { datan2 } from "../sim/dmath.ts";
import { lanePath, pathPoint } from "../sim/roads.ts";
import { nearestDrivableLane } from "../sim/vehicles/follower.ts";
import type { World } from "../sim/world.ts";

/**
 * Where a loaded save puts the player's car: at the curb of the drivable lane nearest the
 * safehouse, facing along it. A safehouse pin can sit inside a block (the FiDi desk is 41 m from
 * the nearest lane, in a 2 m passage), and a car placed there cannot drive out.
 */
export function restoreSpawn(world: World, site: { x: number; z: number }): { x: number; z: number; heading: number } {
  const lane = world.roads ? nearestDrivableLane(world.roads, site) : null;
  if (!lane || !world.roads) return { x: site.x, z: site.z, heading: 0 };
  const at = pathPoint(lanePath(world.roads.edges[lane.edge]!, lane.dir, 0), lane.s);
  return { x: at.x, z: at.z, heading: datan2(at.tx, -at.tz) };
}
