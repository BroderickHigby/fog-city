// content/city-life.json (src/content/cityLife.ts): density by district and hour, director
// pacing and the street-incident cards stay consistent with the districts, the cards and the
// robot tables.
import { describe, expect, it } from "vitest";
import { CITY_DIRECTOR_CARDS, CITY_LIFE, POPULATION_KINDS, cardWeight, checkCityLife, populationScale } from "../../src/content/cityLife.ts";
import { DIRECTOR_CARDS } from "../../src/content/directorCards.ts";
import { toLatLon } from "../../src/geo/project.ts";

const at = (x: number, z: number) => { const p = toLatLon(x, z); return [p.lat, p.lon] as const; };

describe("content/city-life.json", () => {
  it("passes every rule beyond the schema", () => {
    expect(checkCityLife()).toEqual([]);
  });

  it("robots outnumber their old density everywhere by day, and never pass the cap", () => {
    for (const hour of [0, 3, 6, 9, 12, 17, 21]) {
      const s = populationScale(at(0, 0), hour);
      for (const k of POPULATION_KINDS) {
        expect(s[k]).toBeGreaterThan(0);
        expect(s[k]).toBeLessThanOrEqual(CITY_LIFE.population.maxScale);
      }
    }
    const noon = populationScale(at(0, 0), 12);
    expect(noon.errandRobot).toBeGreaterThanOrEqual(2);
    expect(noon.sidewalkBot).toBeGreaterThanOrEqual(2);
    expect(noon.person).toBe(1);
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
