// The clearance soak with a driver that rams robotaxis (impacts.ts) on the real city: the
// knocked robotaxis slide, spin and shove each other through full traffic and crowds, and
// nobody is ever touched (tests/sim/dodge-soak.ts measures contacts against each robotaxi's
// drawn body and the player's car, and clearance from moving vehicles). Skipped until the SF
// world is in the checkout.
import { beforeAll, describe, expect, it } from "vitest";
import type { World } from "../../../src/sim/index.ts";
import { loadWorldFiles } from "../../helpers.ts";
import { CITY_MS, SF, sfWorld } from "../world/load.ts";
import { routeFrom, soak, startNear, type SoakStart } from "../dodge-soak.ts";
import { toLocal } from "../../../src/geo/project.ts";

describe.skipIf(!SF)("ramming robotaxis on the real city", () => {
  let world: World;
  let home: SoakStart;
  beforeAll(() => {
    world = sfWorld().world;
    const spawn = loadWorldFiles("sf").manifest.spawn;
    home = { name: "Ferry Building", ...spawn, route: routeFrom(world.roads!, spawn.x, spawn.z, spawn.heading, 2000, 3) };
  }, CITY_MS);

  it("from the Ferry Building and in Union Square: robotaxis are hit, nobody is touched", () => {
    const union = toLocal(37.7879, -122.4075);
    for (const [start, seed] of [[home, 5], [startNear(world, "Union Square", union.x, union.z), 9]] as const) {
      const r = soak(world, start, "ram", 1500, seed);
      expect(r.contacts, r.name).toBe(0);
      expect(r.failures, `${r.name}: the override gave up`).toBe(0);
      expect(r.unexplained.slice(0, 5), r.name).toEqual([]);
      expect(r.jumps.slice(0, 5), r.name).toEqual([]);
      expect(r.taxiOverrides, `${r.name}: overrides by robotaxis`).toBe(0);
      expect(r.hits, `${r.name}: robotaxis hit`).toBeGreaterThan(2);
    }
  }, 600_000);

  it("flat out at the v12 top speed (starting at 50 m/s) along the Ferry Building route, no brakes: nobody is touched", () => {
    const r = soak(world, { ...home, speed: 50 }, "nobrake", 1200, 13);
    expect(r.contacts, r.name).toBe(0);
    expect(r.failures, `${r.name}: the override gave up`).toBe(0);
    expect(r.unexplained.slice(0, 5), r.name).toEqual([]);
    expect(r.jumps.slice(0, 5), r.name).toEqual([]);
    expect(r.driven, r.name).toBeGreaterThan(300);
  }, 600_000);
});
