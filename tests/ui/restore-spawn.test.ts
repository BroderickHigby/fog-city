import { describe, expect, it } from "vitest";
import { sfWorld, CITY_MS } from "../sim/world/load.ts";
import { buildWorld, createInitialState, step, NEUTRAL_INPUT } from "../../src/sim/index.ts";
import { nearestDrivableLane } from "../../src/sim/vehicles/follower.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { restoreSpawn } from "../../src/save/restore-spawn.ts";

describe("loaded-save vehicle placement", () => {
  it("preserves the site position in a world without roads", () => {
    expect(restoreSpawn(buildWorld([]), { x: 10, z: -20 })).toEqual({ x: 10, z: -20, heading: 0 });
  });

  it("places every real-SF safehouse car on a clear drivable lane facing along it", () => {
    const { world } = sfWorld();
    const sites = DEFAULT_CATALOG.sites.filter(site => site.kind === "safehouse");
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const spawn = restoreSpawn(world, site);
      let state = createInitialState(world, 1, ["p1"], spawn);
      const start = { ...state.players.p1!.car };
      expect(nearestDrivableLane(world.roads!, start, start.heading)!.distance, `${site.id}: car is off the road`).toBeLessThan(2);
      for (let tick = 0; tick < 180; tick++) {
        state = step(world, state, { p1: { ...NEUTRAL_INPUT, throttle: 0.5 } });
      }
      const end = state.players.p1!.car;
      expect(Math.hypot(end.x - start.x, end.z - start.z), `${site.id}: car cannot drive out`).toBeGreaterThan(5);
    }
  }, CITY_MS);
});
