// City life tuning (content/city-life.json): how many robots, people and robotaxis each district
// holds by hour, how often the Ambient Director stages an incident, and the extra director cards
// for street incidents (owner feedback, 2026-10-23: "more robots, a little more action").
//
// Pure lookups; the sim reads them through the game composition (src/sim/game-systems.ts).

import cityLifeJson from "../../content/city-life.json" with { type: "json" };
import { DIRECTOR_CARDS, checkDirectorCards, type DirectorCard, type DirectorCardsFile } from "./directorCards.ts";
import { BASELINE_BAD_RATE, DISTRICTS, badRobotRate, districtsAt, protectedAreaAt, type LatLon } from "./places.ts";

export type PopulationKind = "robotaxi" | "errandRobot" | "sidewalkBot" | "person";
export const POPULATION_KINDS: readonly PopulationKind[] = ["robotaxi", "errandRobot", "sidewalkBot", "person"];
export type PopulationScale = Record<PopulationKind, number>;

export interface CityLifeFile {
  version: 1;
  population: {
    maxScale: number;
    /** Multiplies the bad-robot share outside protected areas. */
    badScale: number;
    base: PopulationScale;
    hours: Array<{ from: number; to: number; scale: PopulationScale }>;
    districts: Record<string, Partial<PopulationScale>>;
  };
  director: {
    /** Seconds between incidents while the player has nothing else on: [min, max]. */
    idleWindowS: [number, number];
    /** Seconds an incident stays staged before the director looks again. */
    stagedS: number;
    /** An incident is staged this far from the player, metres: [min, max]. */
    stageM: [number, number];
    /** Pick weight by card id (1 when absent). */
    weights: Record<string, number>;
  };
  incidents: DirectorCard[];
}

export const CITY_LIFE = cityLifeJson as unknown as CityLifeFile;

/** Every card the director picks from: the hand-written director cards, then the city-life incidents. */
export const CITY_DIRECTOR_CARDS: readonly DirectorCard[] = Object.freeze([...DIRECTOR_CARDS.cards, ...CITY_LIFE.incidents]);

/** A card's pick weight. */
export function cardWeight(id: string, f: CityLifeFile = CITY_LIFE): number {
  return f.director.weights[id] ?? 1;
}

/**
 * The density multiplier of each kind for an area owned by a player standing at `p` at game
 * hour `hour` (0..23): base x the hour band x the district's own factor (the first district
 * holding the point; none outside the game districts), capped at maxScale.
 */
export function populationScale(p: LatLon, hour: number, f: CityLifeFile = CITY_LIFE): PopulationScale {
  const pop = f.population;
  const band = pop.hours.find((h) => hour >= h.from && hour < h.to);
  const district = districtsAt(p)[0];
  const local = district ? pop.districts[district.id] : undefined;
  const out = {} as PopulationScale;
  for (const k of POPULATION_KINDS) out[k] = Math.min(pop.maxScale, pop.base[k] * (band?.scale[k] ?? 1) * (local?.[k] ?? 1));
  return out;
}

/**
 * The bad-robot share at a point (places.ts badRobotRate x badScale), never above 30%; in a
 * protected area it stays the baseline, never more (docs/design.md, The living city).
 */
export function cityBadRate(p: LatLon, f: CityLifeFile = CITY_LIFE): number {
  if (protectedAreaAt(p)) return BASELINE_BAD_RATE;
  return Math.min(0.3, badRobotRate(p) * f.population.badScale);
}

/** Every rule beyond the schema. Empty means shippable. */
export function checkCityLife(f: CityLifeFile = CITY_LIFE): string[] {
  const errs: string[] = [];
  const pop = f.population;
  // The hour bands cover the day once, in order.
  let at = 0;
  for (const h of pop.hours) {
    if (h.from !== at) errs.push(`hours: band ${h.from}-${h.to} should start at ${at}`);
    if (h.to <= h.from) errs.push(`hours: band ${h.from}-${h.to} is empty`);
    at = h.to;
  }
  if (at !== 24) errs.push(`hours: the bands end at ${at}, not 24`);
  const districtIds = new Set(DISTRICTS.map((d) => d.id));
  for (const id of Object.keys(pop.districts).sort()) if (!districtIds.has(id)) errs.push(`districts: unknown district ${id}`);
  const [lo, hi] = f.director.idleWindowS;
  if (!(lo > 0 && hi >= lo)) errs.push(`director: idle window ${lo}-${hi} s`);
  const [near, far] = f.director.stageM;
  if (!(near >= 20 && far >= near && far <= 150)) errs.push(`director: stage distance ${near}-${far} m (at least 20 m off, within 150 m)`);
  const all = new Set(CITY_DIRECTOR_CARDS.map((c) => c.id));
  for (const id of Object.keys(f.director.weights).sort()) if (!all.has(id)) errs.push(`director: weight for unknown card ${id}`);
  for (const c of f.incidents) if (DIRECTOR_CARDS.cards.some((d) => d.id === c.id)) errs.push(`incident ${c.id}: already a director card`);
  const asCards: DirectorCardsFile = { ...DIRECTOR_CARDS, cards: f.incidents };
  errs.push(...checkDirectorCards(asCards));
  return errs;
}
