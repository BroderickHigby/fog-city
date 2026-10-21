// The clearance soak on the real city, per PR (tests/sim/dodge-soak.ts has the drivers and the
// measures; tests/sim/dodge-soak.nightly.ts the long one): from the spawn by the Ferry Building
// a chase driver, a no-brake driver and a car driven flat out at a rival player on foot, and a
// jump driver flat out over one of the city's sharpest clear crests, 20 s each in full traffic.
// Zero contacts, nobody closer than 0.75 m to a moving car or a closing robotaxi except in a
// counted override episode, and no walker jumping back onto its path after a dodge. Skipped until the SF world is in the checkout.
import { beforeAll, describe, expect, it } from "vitest";
import type { World } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { CITY_MS, SF, sfWorld } from "./world/load.ts";
import { crestStart, findCrests, routeFrom, soak, type SoakResult, type SoakStart } from "./dodge-soak.ts";

describe.skipIf(!SF)("the clearance soak on the real city (per PR)", () => {
  let world: World;
  let home: SoakStart;
  beforeAll(() => {
    world = sfWorld().world;
    const spawn = loadWorldFiles("sf").manifest.spawn;
    home = { name: "Ferry Building", ...spawn, route: routeFrom(world.roads!, spawn.x, spawn.z, spawn.heading, 2000, 3) };
  }, CITY_MS);

  const check = (r: SoakResult): void => {
    expect(r.contacts, r.name).toBe(0);
    expect(r.unexplained.slice(0, 5), r.name).toEqual([]);
    expect(r.jumps.slice(0, 5), r.name).toEqual([]);
    // It really tested something: people dived out of its way, and it drove.
    expect(r.dives, r.name).toBeGreaterThan(0);
    expect(r.driven, r.name).toBeGreaterThan(80);
  };

  it(
    "chase, no-brake and rival drivers from the Ferry Building: zero contacts, clearance >= 0.75 m except counted overrides",
    () => {
      for (const driver of ["chase", "nobrake", "rival"] as const) check(soak(world, home, driver, 1200, 5));
    },
    CITY_MS,
  );

  it(
    "a jump driver flat out over a sharp clear crest: it flies, and nobody is touched on landing",
    () => {
      const crest = findCrests(world, 6).find((c) => c.route.length >= 150);
      expect(crest, "a crest with a clear run in the street grid").toBeDefined();
      const r = soak(world, crestStart(crest!, "crest"), "jump", 900, 5);
      check(r);
      expect(r.maxAirS, "seconds airborne").toBeGreaterThan(0.25);
    },
    CITY_MS,
  );
});
