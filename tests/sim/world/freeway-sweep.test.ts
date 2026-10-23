// Every freeway and ramp edge driven at 25 m/s (world QA W-03, W-07, W-14; the gate's nightly
// "freeways-all" suite measures the same runs). Each edge (gradeSeparated, or kind freeway or
// ramp, 12 m or longer) in each allowed direction, from its first point on its road surface (its
// deck, bore floor or the ground), with the road follower of load.ts.
//
// The QA's acceptance is no run that stops, none airborne for more than 0.3 s and no landing
// harder than 3 m/s. The sim's part is done; what is left is Pipeline data, so this file is a
// ratchet: the counts may only fall, and the runs that stop must be among the ones listed here
// with their cause. When Pipeline fixes a cause, lower the bound or drop the entry.
//
// Measured on 2026-10-22 (qa/sim, this world): 220 runs; 10 stop, 41 airborne over 0.3 s, 25 with
// a landing over 3 m/s; longest flight 1.07 s, hardest landing 6.63 m/s. The previous round's sim
// on the same world: 13 stop (I-80 westbound under the eastbound deck at 1st St among them), 35
// airborne, 19 hard. The sim now keeps a car on its own deck where decks overlap, so cars that
// used to snap up onto a neighbouring deck at a crest now fly over their own and land on it; the
// remaining flights leave deck ends the pipeline lays off the ground, steep overpasses, crossing
// decks 0.3 to 4.5 m apart and the 10 m lattice on stretches at grade (W-31), all listed for
// Pipeline. The gate's baseline before this lane was 17 stop, 96 airborne, 76 hard.
import { describe, expect, it } from "vitest";
import { roadSurfaceHeight, surfaceAt, type CarState, type RoadsFile } from "../../../src/sim/index.ts";
import { CITY_MS, SF, drivePath, resample, sfWorld } from "./load.ts";

type Edge = RoadsFile["edges"][number] & { gradeSeparated?: boolean };

/** The runs that stop before the end, and why (all Pipeline data or a span walled until wave 8). */
const KNOWN_STUCK: Record<string, string> = {
  // The Bay Bridge's west span and Treasure Island: the spans over the open Bay are walled until
  // wave 8 models them.
  "c14242000:+": "Bay Bridge span wall (Yerba Buena Island)",
  "c14243000:+": "Bay Bridge span wall (Yerba Buena Island)",
  "c14248000:+": "Bay Bridge span wall (Rincon Point)",
  "c14249000:+": "Bay Bridge span wall (starts on the span)",
  "c14214000:+": "a building (201006.0030303) over the Treasure Island on-ramp's deck",
  // The Golden Gate's approach: its span is walled until wave 8.
  "c19205000:+": "Golden Gate span wall",
  "c19256000:+": "Golden Gate span wall (starts on the span)",
  // Buildings standing on the ramp's road (W-01/W-03 data).
  "c19238000:+": "a building (201006.0007691) on the US-101 S off-ramp",
  "c19244000:+": "buildings (201006.0000553, 201006.0002563) on the US-101 S on-ramp",
  "c19374000:+": "buildings (201006.0000387 and its terraces) on the I-80 W off-ramp",
};

const MAX_AIRBORNE_RUNS = 41;
const MAX_HARD_LANDING_RUNS = 25;
const MAX_AIR_S = 1.1;
const MAX_LANDING_MPS = 6.7;

describe.skipIf(!SF)("every freeway and ramp edge at 25 m/s (W-03, W-07, W-14)", () => {
  it(
    "no run stops except the listed ones; airborne and hard-landing runs no more than measured (the QA's target is 0)",
    () => {
      const { world, roads } = sfWorld();
      const isFwy = (e: Edge): boolean => e.gradeSeparated === true || e.kind === "freeway" || e.kind === "ramp";
      const edges = (roads.edges as Edge[]).filter(isFwy).sort((a, b) => (a.id < b.id ? -1 : 1));
      let runs = 0;
      const stuck: string[] = [];
      const airborne: string[] = [];
      const hard: string[] = [];
      let maxAir = 0;
      let maxLand = 0;
      for (const e of edges) {
        const pts = resample(e.points, 1);
        if (pts.length < 12) continue;
        for (const dir of e.oneway ? [1] : [1, -1]) {
          const path = dir > 0 ? pts : [...pts].reverse();
          const key = `${e.id}:${dir > 0 ? "+" : "-"}`;
          runs++;
          let land = 0;
          let prev: CarState | null = null;
          const [x, z] = path[0]!;
          const r = drivePath(
            world,
            path,
            25,
            20,
            (c) => {
              if (prev && prev.airTicks > 0 && c.airTicks === 0) land = Math.max(land, c.landingSpeed);
              prev = c;
            },
            surfaceAt(world, x, z, roadSurfaceHeight(world, e.id, x, z)).y,
          );
          if (!r.reached) stuck.push(`${key} ${r.progressM} of ${r.lenM} m`);
          if (r.maxAirS > 0.3) airborne.push(`${key} ${r.maxAirS.toFixed(2)} s`);
          if (land > 3) hard.push(`${key} ${land.toFixed(1)} m/s`);
          maxAir = Math.max(maxAir, r.maxAirS);
          maxLand = Math.max(maxLand, land);
        }
      }
      expect(runs).toBeGreaterThan(200);
      expect(stuck.filter((s) => !(s.split(" ")[0]! in KNOWN_STUCK)), "runs that stop, not listed").toEqual([]);
      expect(airborne.length, airborne.join(", ")).toBeLessThanOrEqual(MAX_AIRBORNE_RUNS);
      expect(hard.length, hard.join(", ")).toBeLessThanOrEqual(MAX_HARD_LANDING_RUNS);
      expect(maxAir).toBeLessThanOrEqual(MAX_AIR_S);
      expect(maxLand).toBeLessThanOrEqual(MAX_LANDING_MPS);
    },
    CITY_MS,
  );
});
