// The clearance soak on the real city, per PR (tests/sim/dodge-soak.ts has the drivers and the
// measures; tests/sim/dodge-soak.nightly.ts the long one): from the spawn by the Ferry Building
// a chase driver (with three players joining on the people nearest it), a no-brake driver and a
// car driven flat out at a rival player on foot, 20 s each; chase and weave drivers in the narrow places the review found (Chinatown's alleys,
// Lombard's crooked block), 20 s each; and a jump driver flat out over one of the city's
// sharpest clear crests. In full traffic: zero contacts (a robotaxi measured by its drawn body),
// the override never giving up, nobody closer than 0.75 m to a moving car or a closing robotaxi
// except in a counted override episode, no override set off by a robotaxi, overrides at most a
// tenth of the dodges, and no walker jumping back onto its path after a dodge. Skipped until the
// SF world is in the checkout.
import { beforeAll, describe, expect, it } from "vitest";
import type { World } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { CITY_MS, SF, sfWorld } from "./world/load.ts";
import { toLocal } from "../../src/geo/project.ts";
import { NARROW_PLACES, crestStart, findCrests, routeFrom, soak, startNear, type SoakResult, type SoakStart } from "./dodge-soak.ts";

/** At most this share of the dodges in a run may be the override's (and never more than 2 in a run with few). */
const OVERRIDE_SHARE = 0.1;

describe.skipIf(!SF)("the clearance soak on the real city (per PR)", () => {
  let world: World;
  let home: SoakStart;
  beforeAll(() => {
    world = sfWorld().world;
    const spawn = loadWorldFiles("sf").manifest.spawn;
    home = { name: "Ferry Building", ...spawn, route: routeFrom(world.roads!, spawn.x, spawn.z, spawn.heading, 2000, 3) };
  }, CITY_MS);

  const check = (r: SoakResult, minDriven = 80): void => {
    expect(r.contacts, r.name).toBe(0);
    expect(r.failures, `${r.name}: the override gave up`).toBe(0);
    expect(r.unexplained.slice(0, 5), r.name).toEqual([]);
    expect(r.jumps.slice(0, 5), r.name).toEqual([]);
    // The override is the backstop, not how people get clear: robotaxis (which keep their berth)
    // set it off never, and the player's car rarely.
    expect(r.taxiOverrides, `${r.name}: overrides by robotaxis`).toBe(0);
    expect(r.overrides, `${r.name}: overrides (${r.dives} dives)`).toBeLessThanOrEqual(Math.max(2, Math.ceil(r.dives * OVERRIDE_SHARE)));
    // It really tested something: people dived out of its way, and it drove.
    expect(r.dives, r.name).toBeGreaterThan(0);
    expect(r.driven, r.name).toBeGreaterThan(minDriven);
  };

  it(
    "chase, no-brake and rival drivers from the Ferry Building (three players joining on the crowd during the chase): zero contacts, clearance >= 0.75 m except counted overrides",
    () => {
      for (const driver of ["chase", "nobrake", "rival"] as const) {
        const r = soak(world, home, driver, 1200, 5, driver === "chase" ? { joins: [240, 600, 960] } : {});
        check(r);
        // A car driven along its route, swerving at people but never chasing them: people on foot
        // always get clear without the override (v11, the dodge stream).
        if (driver === "nobrake") expect(r.overrides, "nobrake: overrides").toBe(0);
        if (driver === "chase") expect(r.players, "the joins happened").toBe(4);
      }
    },
    CITY_MS,
  );

  it(
    "chase and weave drivers in the narrow places (Ross Alley, Spofford Alley, Waverly Place, Lombard's crooked block): zero contacts, clearance >= 0.75 m except counted overrides, few overrides",
    () => {
      for (const [name, lat, lon] of NARROW_PLACES) {
        const p = toLocal(lat, lon);
        const st = startNear(world, name, p.x, p.z);
        // (The review's seeds: Spofford Alley's 0.70 m pass was chase on seed 8, Ross Alley's overrides weave on 7.)
        for (const [driver, seed] of [["chase", 8], ["weave", 7]] as const) check(soak(world, st, driver, 1200, seed), 30);
      }
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
