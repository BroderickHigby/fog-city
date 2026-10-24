// content/city-life.json (src/content/cityLife.ts): density by district and hour, director
// pacing and the street-incident cards stay consistent with the districts, the cards and the
// robot tables.
import { describe, expect, it } from "vitest";
import { CITY_DIRECTOR_CARDS, CITY_LIFE, cardWeight, checkCityLife, cityBadRate, populationScale } from "../../src/content/cityLife.ts";
import { DISTRICTS, badRobotRate } from "../../src/content/places.ts";
import { AGENT_SPEC } from "../../src/sim/agents.ts";
import { DIRECTOR_CARDS } from "../../src/content/directorCards.ts";
import { toLatLon } from "../../src/geo/project.ts";

const at = (x: number, z: number) => { const p = toLatLon(x, z); return [p.lat, p.lon] as const; };

describe("content/city-life.json", () => {
  it("passes every rule beyond the schema", () => {
    expect(checkCityLife()).toEqual([]);
  });

  it("more robots, fewer people, and never more bodies than the base densities (the sim is at its frame budget)", () => {
    const base = (["robotaxi", "errandRobot", "sidewalkBot", "person"] as const);
    const walkers = (["errandRobot", "sidewalkBot", "person"] as const);
    const total = (scale: Record<string, number>, kinds: readonly string[]) => kinds.reduce((n, k) => n + AGENT_SPEC[k as "person"].perKm * scale[k]!, 0);
    const ones = Object.fromEntries(base.map((k) => [k, 1]));
    for (const d of [null, ...DISTRICTS.map((x) => x.id)]) {
      for (const h of CITY_LIFE.population.hours) {
        const s = { ...ones } as Record<string, number>;
        for (const k of base) s[k] = Math.min(CITY_LIFE.population.maxScale, CITY_LIFE.population.base[k] * h.scale[k] * ((d ? CITY_LIFE.population.districts[d]?.[k] : undefined) ?? 1));
        expect(total(s, walkers), `${d} ${h.from}-${h.to}`).toBeLessThanOrEqual(total(ones, walkers) + 1e-9);
        expect(s.robotaxi, `${d} ${h.from}-${h.to}`).toBeLessThanOrEqual(1);
      }
    }
    const noon = populationScale(at(0, 0), 12);
    expect(noon.errandRobot).toBeGreaterThanOrEqual(1.3);
    expect(noon.sidewalkBot).toBeGreaterThanOrEqual(1.3);
    expect(noon.person).toBeLessThan(1);
  });

  it("the bad share: the design's rate scaled by badScale, never above 30%, the baseline in protected areas", () => {
    expect(CITY_LIFE.population.badScale).toBeGreaterThanOrEqual(1);
    expect(cityBadRate(at(0, 0))).toBeCloseTo(Math.min(0.3, badRobotRate(at(0, 0)) * CITY_LIFE.population.badScale), 12);
  });

  it("night shifts the mix toward Trundles (design: The living city, Routines)", () => {
    const night = populationScale(at(0, 0), 2), noon = populationScale(at(0, 0), 12);
    expect(night.sidewalkBot / night.errandRobot).toBeGreaterThan(noon.sidewalkBot / noon.errandRobot);
    expect(night.person).toBeLessThan(noon.person);
  });

  it("districts differ: SoMa (Moat Labs) busier with robots than the Marina", () => {
    const district = (id: string) => CITY_LIFE.population.districts[id]!;
    expect(district("soma").sidewalkBot!).toBeGreaterThan(district("marina").sidewalkBot!);
  });

  it("the director picks from the cards plus the incidents, weighting the street incidents up", () => {
    expect(CITY_DIRECTOR_CARDS.length).toBe(DIRECTOR_CARDS.cards.length + CITY_LIFE.incidents.length);
    for (const id of ["crosswalk-squatter", "robotaxi-standoff", "malfunction-spree", "snatch-in-progress"]) {
      expect(CITY_DIRECTOR_CARDS.some((c) => c.id === id)).toBe(true);
      expect(cardWeight(id)).toBeGreaterThan(1);
    }
    const [lo, hi] = CITY_LIFE.director.idleWindowS;
    expect(lo).toBeGreaterThanOrEqual(20);
    expect(hi).toBeLessThanOrEqual(75);
  });
});
