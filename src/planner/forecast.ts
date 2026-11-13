// How Lombard's traffic has followed San Francisco's population, and what that implies for 2031.
// The finding the data gives: from 1996 to 2019 the city grew about 18% while daily traffic on
// this stretch stayed level or fell, because the street is full at the peak. Growth therefore
// shows up as longer busy periods, not as a bigger peak hour; the demo's "what if" levels
// stress-test the corridor instead of pretending to predict it.
import { CALTRANS_COUNTS, RHNA_HOMES_2031, SFMTA_LOMBARD_COUNTS, SF_POPULATION } from "./data.ts";

export interface TrendPoint { year: number; population: number; daily: number; source: "SFMTA" | "Caltrans" }

export function populationIn(year: number): number {
  const exact = SF_POPULATION.find((p) => p.year === year);
  if (exact) return exact.population;
  const sorted = [...SF_POPULATION].sort((p, q) => p.year - q.year);
  const after = sorted.find((p) => p.year > year), before = [...sorted].reverse().find((p) => p.year < year);
  if (!before) return sorted[0]!.population;
  if (!after) return before.population;
  return before.population + (after.population - before.population) * (year - before.year) / (after.year - before.year);
}

/**
 * Daily two-way traffic on the western (Broderick St) half of the corridor, where SFMTA counted
 * and Caltrans counts: SFMTA weekday counts 1996-2015, Caltrans AADT 2013-2024.
 */
export function lombardTrend(): TrendPoint[] {
  const pts: TrendPoint[] = SFMTA_LOMBARD_COUNTS
    .filter((c) => !c.at.includes("Steiner"))
    .map((c) => { const year = Number(c.date.slice(0, 4)); return { year, population: populationIn(year), daily: c.daily, source: "SFMTA" as const }; });
  for (const c of CALTRANS_COUNTS) {
    if (c.year === 2024) continue; // repeats 2023
    pts.push({ year: c.year, population: populationIn(c.year), daily: c.broderickAadt, source: "Caltrans" });
  }
  return pts.sort((p, q) => p.year - q.year);
}

/**
 * Elasticity of traffic to population: the slope of log(daily) on log(population), least
 * squares, over the years before the pandemic (2020 and 2021 are left out).
 */
export function populationElasticity(points = lombardTrend()): number {
  const pts = points.filter((p) => p.year < 2020 || p.year > 2021);
  const xs = pts.map((p) => Math.log(p.population)), ys = pts.map((p) => Math.log(p.daily));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

export interface Forecast {
  year: number;
  population: number;
  /** Peak-hour traffic relative to the latest count (1 = unchanged). */
  scale: number;
  note: string;
}

/**
 * 2031 if every home in the housing target is built and filled. `peoplePerHome` is an
 * assumption the caller states; the elasticity comes from the counts unless given.
 */
export function forecast2031(peoplePerHome = 2, elasticity = populationElasticity()): Forecast {
  const now = SF_POPULATION[SF_POPULATION.length - 1]!;
  const population = now.population + RHNA_HOMES_2031 * peoplePerHome;
  const growth = population / now.population;
  const scale = Math.exp(elasticity * Math.log(growth));
  return { year: 2031, population, scale,
    note: `${RHNA_HOMES_2031.toLocaleString("en-US")} homes x ${peoplePerHome} people = +${((growth - 1) * 100).toFixed(0)}% population; at the measured elasticity (${elasticity.toFixed(2)}) peak traffic changes ${((scale - 1) * 100).toFixed(1)}%.` };
}
