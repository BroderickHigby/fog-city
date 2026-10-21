// The long clearance soak and the long no-touch fuzz (nightly: `pnpm soak:nightly`, config
// tests/sim/nightly.vitest.config.ts; never part of `pnpm test` or `pnpm verify`). The soak:
// chase, no-brake and rival drivers from five busy places (the Ferry Building, Union Square,
// Chinatown, the Mission, the Castro) and a jump driver over each of the six sharpest clear
// crests, 60 s each, two seeds. The fuzz: seeded scenes 161-2000 (the per-PR test runs 1-160).
// Zero contacts always. Clearance >= 0.75 m except in counted override episodes: always in the
// soak; in the fuzz, at most one scene in 500 may pass closer (every one is printed, and none
// may come within the override clearance itself), a known edge: someone backed into a corner
// or against a wall as a car crashes in beside them (docs/testing.md).
import { beforeAll, describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import type { World } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { SF, sfWorld } from "./world/load.ts";
import { crestStart, findCrests, routeFrom, soak, type SoakStart } from "./dodge-soak.ts";
import { makeScene, run } from "./dodge-scenes.ts";

const PLACES: Array<[string, number, number]> = [
  ["Union Square", 37.788, -122.4075],
  ["Chinatown", 37.7941, -122.4078],
  ["the Mission", 37.765, -122.4194],
  ["the Castro", 37.7609, -122.435],
];

describe.skipIf(!SF)("the clearance soak on the real city (nightly)", () => {
  let world: World;
  const starts: SoakStart[] = [];
  beforeAll(() => {
    world = sfWorld().world;
    const spawn = loadWorldFiles("sf").manifest.spawn;
    starts.push({ name: "Ferry Building", ...spawn, route: routeFrom(world.roads!, spawn.x, spawn.z, spawn.heading, 3000, 3) });
    for (const [name, lat, lon] of PLACES) {
      const p = toLocal(lat, lon);
      const route = routeFrom(world.roads!, p.x, p.z, 0, 3000, 11);
      const [x, z] = route[0]!;
      const [x1, z1] = route[3]!;
      starts.push({ name, x, z, heading: Math.atan2(x1 - x, -(z1 - z)), route });
    }
  }, 600_000);

  it("chase, no-brake and rival drivers, 60 s each from five places, two seeds", () => {
    const bad: string[] = [];
    for (const seed of [1, 2]) {
      for (const st of starts) {
        for (const driver of ["chase", "nobrake", "rival"] as const) {
          const r = soak(world, st, driver, 3600, seed);
          console.info(`[soak] ${r.name} seed ${seed}: ${r.dives} dives, ${r.overrides} overrides, min ${r.minCar.toFixed(2)} m (car) ${r.minTaxi.toFixed(2)} m (robotaxi), ${r.peopleNear} people near, ${r.driven.toFixed(0)} m`);
          if (r.contacts > 0) bad.push(`${r.name} seed ${seed}: ${r.contacts} contacts`);
          bad.push(...r.unexplained.slice(0, 3), ...r.jumps.slice(0, 3));
        }
      }
    }
    expect(bad).toEqual([]);
  }, 3_600_000);

  it("a jump driver over each of the six sharpest clear crests, two seeds", () => {
    const crests = findCrests(world, 6);
    expect(crests.length).toBeGreaterThan(2);
    const bad: string[] = [];
    let flew = 0;
    for (const seed of [1, 2]) {
      crests.forEach((c, i) => {
        const r = soak(world, crestStart(c, `crest ${i}`), "jump", 1800, seed);
        console.info(`[soak] ${r.name} seed ${seed}: ${r.maxAirS.toFixed(2)} s airborne, ${r.dives} dives, ${r.overrides} overrides`);
        if (r.maxAirS > 0.25) flew++;
        if (r.contacts > 0) bad.push(`${r.name} seed ${seed}: ${r.contacts} contacts`);
        bad.push(...r.unexplained.slice(0, 3), ...r.jumps.slice(0, 3));
      });
    }
    expect(bad).toEqual([]);
    expect(flew).toBeGreaterThan(2);
  }, 3_600_000);
});

describe("the no-touch fuzz, long (nightly)", () => {
  it("seeded scenes 161-2000: zero contacts; close passes in at most one scene in 500, none within the override clearance", () => {
    let contacts = 0;
    let overrides = 0;
    let dives = 0;
    const closeScenes: string[] = [];
    let worst = Infinity;
    for (let seed = 161; seed <= 2000; seed++) {
      const r = run(makeScene(seed));
      contacts += r.contacts;
      overrides += r.overrides;
      dives += r.dives;
      if (r.unexplained.length > 0) {
        closeScenes.push(r.unexplained[0]!);
        worst = Math.min(worst, r.minClear);
      }
    }
    console.info(`[fuzz nightly] 1840 scenes: ${dives} dives, ${overrides} overrides, ${closeScenes.length} with a close pass${closeScenes.length ? `: ${closeScenes.join("; ")}` : ""}`);
    expect(contacts).toBe(0);
    expect(closeScenes.length).toBeLessThanOrEqual(Math.floor(1840 / 500));
    if (closeScenes.length > 0) expect(worst).toBeGreaterThan(0.3);
    expect(overrides).toBeLessThan(dives * 0.05);
  }, 3_600_000);
});
