// The long clearance soak, the long no-touch fuzz and the optimiser search (nightly: `pnpm
// soak:nightly`, config tests/sim/nightly.vitest.config.ts; never part of `pnpm test` or `pnpm
// verify`). The soak: chase, weave, no-brake and rival drivers from five busy places (the Ferry
// Building, Union Square, Chinatown, the Mission, the Castro) and chase and weave drivers in the
// four narrow places (Ross Alley, Spofford Alley, Waverly Place, Lombard's crooked block), and a
// jump driver over each of the six sharpest clear crests, 60 s each, two seeds. The fuzz:
// seeded scenes 161-2000 (the per-PR test runs 1-160). The optimiser (tests/sim/dodge-
// optimiser.ts): a seeded search for a driver who can touch someone, in the open, against a
// wall, in a corner, down an alley and onto a deck. Zero contacts always, and the override
// never gives up. Clearance >= 0.75 m except in counted override episodes: always in the soak;
// in the fuzz, at most one scene in 500 may pass closer (every one is printed, and none may come
// within the override clearance itself). Robotaxis never set the override off, and it is at
// most a tenth of the dodges in a soak run (docs/testing.md).
import { beforeAll, describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import type { World } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { SF, sfWorld } from "./world/load.ts";
import { NARROW_PLACES, crestStart, findCrests, routeFrom, soak, startNear, type SoakResult, type SoakStart } from "./dodge-soak.ts";
import { makeScene, run } from "./dodge-scenes.ts";
import { search, type Family } from "./dodge-optimiser.ts";

/** At most this share of a soak run's dodges may be the override's (at most 2 in a run with few). */
const OVERRIDE_SHARE = 0.1;

function problems(r: SoakResult, seed: number): string[] {
  const out: string[] = [];
  if (r.contacts > 0) out.push(`${r.name} seed ${seed}: ${r.contacts} contacts`);
  if (r.failures > 0) out.push(`${r.name} seed ${seed}: the override gave up ${r.failures} times`);
  if (r.taxiOverrides > 0) out.push(`${r.name} seed ${seed}: ${r.taxiOverrides} overrides by robotaxis`);
  if (r.overrides > Math.max(2, Math.ceil(r.dives * OVERRIDE_SHARE))) out.push(`${r.name} seed ${seed}: ${r.overrides} overrides for ${r.dives} dives`);
  out.push(...r.unexplained.slice(0, 3).map((u) => `seed ${seed}: ${u}`), ...r.jumps.slice(0, 3));
  return out;
}

const PLACES: Array<[string, number, number]> = [
  ["Union Square", 37.788, -122.4075],
  ["Chinatown", 37.7941, -122.4078],
  ["the Mission", 37.765, -122.4194],
  ["the Castro", 37.7609, -122.435],
];

describe.skipIf(!SF)("the clearance soak on the real city (nightly)", () => {
  let world: World;
  const starts: SoakStart[] = [];
  const narrow: SoakStart[] = [];
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
    for (const [name, lat, lon] of NARROW_PLACES) {
      const p = toLocal(lat, lon);
      narrow.push(startNear(world, name, p.x, p.z));
    }
  }, 600_000);

  it("chase, weave, no-brake and rival drivers, 60 s each from five places, two seeds", () => {
    const bad: string[] = [];
    for (const seed of [1, 2]) {
      for (const st of starts) {
        for (const driver of ["chase", "weave", "nobrake", "rival"] as const) {
          const r = soak(world, st, driver, 3600, seed);
          console.info(`[soak] ${r.name} seed ${seed}: ${r.dives} dives, ${r.overrides} overrides, min ${r.minCar.toFixed(2)} m (car) ${r.minTaxi.toFixed(2)} m (robotaxi), ${r.peopleNear} people near, ${r.driven.toFixed(0)} m`);
          bad.push(...problems(r, seed));
        }
      }
    }
    expect(bad).toEqual([]);
  }, 3_600_000);

  it("chase and weave drivers in the narrow places (Chinatown's alleys, Lombard's crooked block), 60 s each, three seeds", () => {
    const bad: string[] = [];
    for (const seed of [3, 7, 8]) {
      for (const st of narrow) {
        for (const driver of ["chase", "weave"] as const) {
          const r = soak(world, st, driver, 3600, seed);
          console.info(`[soak] ${r.name} seed ${seed}: ${r.dives} dives, ${r.overrides} overrides, min ${r.minCar.toFixed(2)} m (car) ${r.minTaxi.toFixed(2)} m (robotaxi), ${r.peopleNear} people near, ${r.driven.toFixed(0)} m`);
          bad.push(...problems(r, seed));
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
        bad.push(...problems(r, seed));
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

describe("the optimiser's search for a driver who touches someone (nightly)", () => {
  const FAMILIES: Array<[Family, number]> = [
    ["flat", 3],
    ["wall", 4],
    ["corner", 4],
    ["alley", 3],
    ["deck", 2],
  ];
  it("1500 evaluations in each of the open, a wall, a corner, an alley and a deck: no contact, the override never gives up", () => {
    const bad: string[] = [];
    for (const [family, people] of FAMILIES) {
      const r = search(family, 2026, 1500, people);
      console.info(`[optimiser] ${family}: ${r.evals} drivers, ${r.found} touched someone, ${r.overrides} overrides, closest reach ${r.best.reach.toFixed(3)} m, least clearance ${r.best.minClear.toFixed(3)} m`);
      if (r.found > 0) bad.push(`${family}: ${r.found} drivers touched someone; first: ${JSON.stringify(r.hits[0])}`);
    }
    expect(bad).toEqual([]);
  }, 3_600_000);
});
