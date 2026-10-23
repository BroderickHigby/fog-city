import { expect, it } from "vitest";
import { sfWorld, CITY_MS } from "../world/load.ts";
import { circleBlocked } from "../../../src/sim/world.ts";
import { nearestDrivableLane } from "../../../src/sim/vehicles/follower.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";

/**
 * Every checkpoint of an activity the game offers must be a place a player can stand in the real
 * city: open ground at its centre, and a street within reach. Hand-placed points once sat inside
 * blocks or in China Basin, which made those routes impossible to finish.
 */
it("puts every offered activity checkpoint on reachable open ground in SF", () => {
  const { world } = sfWorld();
  const offered = DEFAULT_CATALOG.activities.filter(activity => activity.checkpoints?.length);
  expect(offered.length).toBeGreaterThan(0);
  for (const activity of offered) for (const point of activity.checkpoints!) {
    const where = `${activity.id}:${point.id}`;
    expect(circleBlocked(world, point.x, point.z, .5), `${where} centre is inside a building or water`).toBe(false);
    expect(nearestDrivableLane(world.roads!, point)!.distance, `${where} is far from any street`).toBeLessThan(25);
  }
}, CITY_MS);
