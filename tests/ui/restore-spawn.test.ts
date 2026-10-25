import { expect, it } from "vitest";
import { sfWorld, CITY_MS } from "../sim/world/load.ts";
import { createInitialState, step, NEUTRAL_INPUT } from "../../src/sim/index.ts";
import { nearestDrivableLane } from "../../src/sim/vehicles/follower.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { restoreSpawn } from "../../src/save/restore-spawn.ts";

/**
 * A loaded save puts the player's car at its safehouse. The FiDi desk pin sits in a 2 m passage
 * 41 m from any lane, so a car placed on the pin could not drive out; it now starts at the curb.
 */
it("starts a loaded save's car on a drivable lane beside every safehouse, and it can drive off", () => {
  const { world } = sfWorld();
  for (const site of DEFAULT_CATALOG.sites.filter(value => value.kind === "safehouse")) {
    const spawn = restoreSpawn(world, site);
    let state = createInitialState(world, 1, ["p1"], spawn);
    const car = state.players.p1!.car;
    expect(nearestDrivableLane(world.roads!, car, car.heading)!.distance, `${site.id} car is off the road`).toBeLessThan(2);
    for (let tick = 0; tick < 180; tick++) state = step(world, state, { p1: { ...NEUTRAL_INPUT, throttle: .5 } });
    const moved = state.players.p1!.car;
    expect(Math.hypot(moved.x - car.x, moved.z - car.z), `${site.id} car cannot drive out`).toBeGreaterThan(5);
  }
}, CITY_MS);
