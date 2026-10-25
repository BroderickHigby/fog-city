// City ambience: districts from the content polygons, layer levels from traffic, crowds,
// weather, time and the car shell, and foghorns and gulls only where and when they belong.
import { describe, expect, it } from "vitest";
import { AmbientEventClock, FOGHORN_MAX_S, FOGHORN_MIN_S, GULL_MAX_S, GULL_MIN_S, IN_CAR, WATERFRONT_DISTRICTS, ambienceLevels, districtAt, type AmbienceInput } from "../../src/audio/ambience.ts";
import { toLocal } from "../../src/geo/project.ts";
import { readJson } from "../helpers.ts";

const input = (o: Partial<AmbienceInput> = {}): AmbienceInput => ({ vehiclesNear: [], peopleNear: [], district: "soma", weather: { fog: 0, rain: 0, sheltered: false, hour: 12 }, inCar: false, ...o });

describe("districts", () => {
  it("finds each district at its hub, and none out in the bay", () => {
    const districts = readJson<{ districts: Array<{ id: string; hub: { lat: number; lon: number } }> }>("content/districts.json").districts;
    let found = 0;
    for (const d of districts) {
      const p = toLocal(d.hub.lat, d.hub.lon);
      if (districtAt(p.x, p.z) === d.id) found++;
    }
    expect(found).toBeGreaterThanOrEqual(districts.length - 1);
    const bay = toLocal(37.81, -122.36);
    expect(districtAt(bay.x, bay.z)).toBeNull();
    for (const id of WATERFRONT_DISTRICTS) expect(districts.some((d) => d.id === id), id).toBe(true);
  });
});

describe("ambience levels", () => {
  it("traffic and crowd grow with what is near, and a car shell muffles the outside", () => {
    const quiet = ambienceLevels(input());
    const busy = ambienceLevels(input({ vehiclesNear: [10, 20, 30, 40], peopleNear: [3, 5, 8, 12, 15] }));
    expect(busy.traffic).toBeGreaterThan(quiet.traffic);
    expect(busy.crowd).toBeGreaterThan(quiet.crowd);
    const inCar = ambienceLevels(input({ vehiclesNear: [10, 20, 30, 40], peopleNear: [3, 5], inCar: true }));
    expect(inCar.traffic).toBeCloseTo(ambienceLevels(input({ vehiclesNear: [10, 20, 30, 40], peopleNear: [3, 5] })).traffic * IN_CAR, 9);
    for (const v of Object.values(busy)) if (typeof v === "number") { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });

  it("rain follows the weather and is softer under shelter; the waterfront and fog are windier", () => {
    expect(ambienceLevels(input()).rain).toBe(0);
    const rain = ambienceLevels(input({ weather: { fog: 0, rain: 1, sheltered: false, hour: 12 } })).rain;
    const sheltered = ambienceLevels(input({ weather: { fog: 0, rain: 1, sheltered: true, hour: 12 } })).rain;
    expect(rain).toBeGreaterThan(sheltered);
    expect(sheltered).toBeGreaterThan(0);
    const inland = ambienceLevels(input({ district: "soma" })).wind;
    const bay = ambienceLevels(input({ district: "embarcadero" })).wind;
    const foggyBay = ambienceLevels(input({ district: "embarcadero", weather: { fog: 1, rain: 0, sheltered: false, hour: 12 } })).wind;
    expect(bay).toBeGreaterThan(inland);
    expect(foggyBay).toBeGreaterThan(bay);
  });

  it("is quieter at night: less traffic, no daytime crowd baseline", () => {
    const day = ambienceLevels(input({ district: "downtown" }));
    const night = ambienceLevels(input({ district: "downtown", weather: { fog: 0, rain: 0, sheltered: false, hour: 2 } }));
    expect(night.night).toBe(true);
    expect(night.traffic).toBeLessThan(day.traffic);
    expect(night.crowd).toBeLessThan(day.crowd);
  });
});

describe("foghorns and gulls", () => {
  const run = (o: Partial<AmbienceInput>, fog: number, seconds = 600) => {
    const clock = new AmbientEventClock(7);
    const levels = ambienceLevels(input(o));
    const events: Array<{ kind: string; t: number }> = [];
    for (let t = 0; t < seconds; t += 0.1) for (const e of clock.update(levels, fog, t)) events.push({ kind: e.kind, t });
    return events;
  };

  it("foghorns sound across the bay in fog, at a 40 to 75 s rhythm, never in clear weather", () => {
    const foggy = run({ district: "embarcadero" }, 0.8).filter((e) => e.kind === "foghorn");
    expect(foggy.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < foggy.length; i++) {
      expect(foggy[i]!.t - foggy[i - 1]!.t).toBeGreaterThanOrEqual(FOGHORN_MIN_S - 0.2);
      expect(foggy[i]!.t - foggy[i - 1]!.t).toBeLessThanOrEqual(FOGHORN_MAX_S + 0.2);
    }
    expect(run({ district: "embarcadero" }, 0).filter((e) => e.kind === "foghorn")).toEqual([]);
  });

  it("gulls call on the waterfront by day only", () => {
    const wharf = run({ district: "fishermans-wharf" }, 0).filter((e) => e.kind === "gull");
    expect(wharf.length).toBeGreaterThanOrEqual(600 / GULL_MAX_S - 2);
    expect(wharf.length).toBeLessThanOrEqual(600 / GULL_MIN_S + 2);
    expect(run({ district: "soma" }, 0).filter((e) => e.kind === "gull")).toEqual([]);
    expect(run({ district: "fishermans-wharf", weather: { fog: 0, rain: 0, sheltered: false, hour: 23 } }, 0).filter((e) => e.kind === "gull")).toEqual([]);
  });
});
