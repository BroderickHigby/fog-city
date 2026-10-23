// Weather (src/sim/fog): producers (seeded fog, rain, wet roads, puddles, the King tide, shelter)
// and their consumers through the composed game (perception, observation, heat, rust, refills,
// car traction, bad-robot refuge). docs/design.md "Day, night and weather".
import { describe, it, expect } from "vitest";
import {
  Action, buildWorld, createClockSystem, createFogSystem, createGameSystems, createInitialState, dailyWeather, DAY_TICKS,
  floodDepthAt, fogDensity, gameTime, makeCar, makeFoot, promenadeAt, puddlesNear, rainDensity, roadWetness, shelteredAt,
  shelterPoint, step, stepCar, tideLevel, tractionAt, weatherRefuge, weatherView, TIDE_PROMENADE, WEATHER, type SimState, type World,
} from "../../src/sim/index.ts";
import { toLocal } from "../../src/geo/project.ts";
import { createMissions } from "../../src/sim/missions/system.ts";
import { createHeat, createHeatStatus } from "../../src/sim/heat/system.ts";
import { createAgentsRuntime } from "../../src/sim/agents/runtime.ts";
import { buildWorldWithRoads, loadWorldFiles } from "../helpers.ts";

const world = buildWorld([]);
const FOG = { version: 1 as const, missionCursor: 0, windows: [] };
/** A state `hour` o'clock on game day `day` (the clock starts at 08:00 on day 0). */
const at = (hour: number, day = 0, seed = 42, fog = true): SimState => {
  const state = createInitialState(world, seed, [], { x: 0, z: 0, heading: 0 });
  return { ...state, ext: { clock: { version: 1 as const, elapsedTicks: day * DAY_TICKS + (hour >= 8 ? hour - 8 : hour + 16) * 3600 }, ...(fog ? { fog: FOG } : {}) } };
};
const west = toLocal(37.76, -122.5), marina = toLocal(37.803, -122.435), east = toLocal(37.757, -122.39), fidi = toLocal(37.7935, -122.399);
const dogpatch = toLocal(37.7607, -122.385);
/** The first winter day (seed 42) with rain, and its shower's start hour. */
function rainyDay(seed = 42): { day: number; start: number } {
  for (let day = 28; day < 56; day++) for (let hour = 0; hour < 24; hour++) if (rainDensity(at(hour, day, seed)) > 0) return { day, start: hour };
  throw new Error("no rain");
}
function tideDay(seed = 42): number {
  for (let day = 0; day < 7; day++) if (dailyWeather(at(12, day, seed)).kingTide) return day;
  throw new Error("no tide");
}
const wall = buildWorld([{ tileId: "w", ground: null, buildings: [{ id: "shop", baseY: 0, topY: 8, footprint: [[10, -10], [20, -10], [20, 10], [10, 10]] }] }]);

describe("seeded per-position weather", () => {
  it("arrives from the west, reaches Marina later, thins by late morning and spares the sunny east", () => {
    expect(fogDensity(world, at(19), west.x, west.z)).toBeGreaterThan(0.6);
    expect(fogDensity(world, at(18), marina.x, marina.z)).toBeLessThan(fogDensity(world, at(22), marina.x, marina.z));
    expect(fogDensity(world, at(22), west.x, west.z)).toBeGreaterThan(fogDensity(world, at(22), east.x, east.z));
    expect(fogDensity(world, at(12), west.x, west.z)).toBe(0);
    // On a downtown-fog night FiDi is foggy at 23:00 and Dogpatch, in the sun belt, stays clear of the 0.4 "in fog" line.
    let checked = 0;
    for (let day = 0; day < 30; day++) {
      const late = at(23, day);
      if (fogDensity(world, late, fidi.x, fidi.z) < 0.3) continue;
      checked++;
      expect(fogDensity(world, late, dogpatch.x, dogpatch.z)).toBeLessThan(0.15);
    }
    expect(checked).toBeGreaterThan(3);
    expect(fogDensity(world, at(12), NaN, Infinity)).toBe(0);
  });

  it("keeps weather deterministic, winter-only rain and one tide day each week, without touching RNG", () => {
    let wet = 0, tides = 0;
    for (let day = 0; day < 28; day++) {
      const state = at(12, day), before = JSON.stringify(state);
      expect(dailyWeather(state)).toEqual(dailyWeather(at(12, day)));
      expect(dailyWeather(state).rain).toBe(false);
      if (dailyWeather(state).kingTide) tides++;
      expect(JSON.stringify(state)).toBe(before);
    }
    expect(tides).toBe(4);
    for (let day = 28; day < 56; day++) if (dailyWeather(at(12, day)).rain) wet++;
    expect(wet).toBeGreaterThan(3);
    expect(wet).toBeLessThan(17);
  });

  it("rains for six game hours, then the roads dry over two", () => {
    const { day, start } = rainyDay();
    const end = start + WEATHER.rainHours;
    expect(rainDensity(at(start, day))).toBe(1);
    expect(roadWetness(at(start + 1, day))).toBe(1);
    if (end + 1 < 24) {
      expect(rainDensity(at(end + 1, day))).toBe(0);
      expect(roadWetness(at(end + 1, day))).toBeCloseTo(0.5, 6);
    }
    if (end + 3 < 24) expect(roadWetness(at(end + 3, day))).toBe(0);
    if (start > 0) expect(roadWetness(at(start - 1, day))).toBe(dailyWeather(at(12, day - 1)).rain ? roadWetness(at(start - 1, day)) : 0);
  });

  it("records authored night windows once and expires them without host time", () => {
    let state = at(12);
    state = { ...state, ext: { ...state.ext, missions: { ...createMissions(), events: [{ id: 1, tick: 0, kind: "mission.weather-request", playerId: "p", targetId: "marine-layer", amount: 0, detail: JSON.stringify({ night: true, fog: 0.8, durationTicks: 10 }) }] } } };
    const systems = [createClockSystem(), createFogSystem()];
    state = step(world, state, {}, [], systems);
    expect(gameTime(state).hour).toBe(22);
    expect(state.ext.fog!.windows).toHaveLength(1);
    expect(fogDensity(world, state, east.x, east.z)).toBeGreaterThanOrEqual(0.8);
    const replay = state;
    state = step(world, state, {}, [], systems);
    expect(state.ext.fog!.windows).toEqual(replay.ext.fog!.windows);
    for (let tick = 0; tick < 11; tick++) state = step(world, state, {}, [], systems);
    expect(state.ext.fog!.windows).toHaveLength(0);
    expect(state.ext.fog!.missionCursor).toBe(1);
  });
});

describe("weather in the composed game", () => {
  it("is a wave-3 system: wave 2 never writes ext.fog and keeps dry roads", () => {
    let two = createInitialState(world, 42, ["p"], { x: west.x, z: west.z, heading: 0 }), three = two;
    for (let tick = 0; tick < 3; tick++) {
      two = step(world, two, {}, [], createGameSystems({ wave: 2 }));
      three = step(world, three, {}, [], createGameSystems({ wave: 3 }));
    }
    expect(two.ext.fog).toBeUndefined();
    expect(three.ext.fog).toEqual({ version: 1, missionCursor: 0, windows: [] });
    expect(tractionAt(world, two, 0, 0)).toBe(1);
    expect(weatherView(world, two, west.x, west.z)).toMatchObject({ fog: 0, rain: 0, wetness: 0, tide: 0 });
  });

  it("feeds each player's actual local fog into the composed heat reducer", () => {
    let state = createInitialState(world, 42, ["west", "east"], { x: 0, z: 0, heading: 0 });
    state = { ...state, tick: 1000, players: { west: { ...state.players.west!, car: { ...state.players.west!.car, ...west } }, east: { ...state.players.east!, car: { ...state.players.east!.car, ...east } } }, ext: { clock: { version: 1, elapsedTicks: 14 * 3600 } } };
    for (let day = 0; day < 20 && fogDensity(world, state, east.x, east.z) > 0.4; day++) state = { ...state, ext: { ...state.ext, clock: { version: 1, elapsedTicks: state.ext.clock!.elapsedTicks + DAY_TICKS } } };
    expect(fogDensity(world, state, west.x, west.z)).toBeGreaterThan(0.4);
    expect(fogDensity(world, state, east.x, east.z)).toBeLessThanOrEqual(0.4);
    state = { ...state, ext: { ...state.ext, heat: { ...createHeat(), players: { west: { ...createHeatStatus(100), threat: 2 }, east: { ...createHeatStatus(100), threat: 2 } } } } };
    const next = step(world, state, {}, [], createGameSystems({ wave: 3 }));
    expect(next.ext.heat!.players.west!.threat).toBe(1);
    expect(next.ext.heat!.players.east!.threat).toBe(2);
    // Wave 2 keeps clear skies: no fog-accelerated decay.
    expect(step(world, state, {}, [], createGameSystems({ wave: 2 })).ext.heat!.players.west!.threat).toBe(2);
  });

  it("lowers car grip and braking on wet roads only where the weather system runs", () => {
    const { day, start } = rainyDay();
    const wet = at(start + 1, day), dry = at(12, 0), noSystem = at(start + 1, day, 42, false);
    expect(tractionAt(world, wet, 0, 0)).toBeCloseTo(WEATHER.wetTraction, 9);
    expect(tractionAt(world, dry, 0, 0)).toBe(1);
    expect(tractionAt(world, noSystem, 0, 0)).toBe(1);
    const stopping = (traction: number): number => {
      let car = { ...makeCar(0, 0, 0), speed: 20 };
      let ticks = 0;
      while (car.speed > 0.05 && ticks < 2000) { car = stepCar(world, car, { throttle: 0, steer: 0, brake: 1, actions: 0 }, [], traction); ticks++; }
      return -car.z;
    };
    expect(stopping(WEATHER.wetTraction)).toBeGreaterThan(stopping(1) * 1.2);
    // Through step(): the same braking car travels farther on the rainy tick's state.
    const brakeRun = (state: SimState): number => {
      let s: SimState = { ...createInitialState(world, 42, ["p"], { x: 0, z: 0, heading: 0 }), ext: state.ext };
      s = { ...s, players: { p: { ...s.players.p!, car: { ...s.players.p!.car, speed: 20 } } } };
      for (let tick = 0; tick < 120; tick++) s = step(world, s, { p: { throttle: 0, steer: 0, brake: 1, actions: 0 } }, [], []);
      return -s.players.p!.car.z;
    };
    expect(brakeRun(wet)).toBeGreaterThan(brakeRun(dry) + 1);
    expect(brakeRun(noSystem)).toBe(brakeRun(dry));
  });

  it("places rain puddles off buildings, and a player can refill from one at half speed", () => {
    const { day, start } = rainyDay();
    const rainy = at(start + 1, day);
    expect(puddlesNear(wall, at(12, 0), 0, 0, 30)).toEqual([]);
    const puddles = puddlesNear(wall, rainy, 0, 0, 40);
    expect(puddles.length).toBeGreaterThan(3);
    for (const puddle of puddles) expect(puddle.x >= 10 - puddle.radius && puddle.x <= 20 + puddle.radius && Math.abs(puddle.z) <= 10 + puddle.radius).toBe(false);
    expect(puddlesNear(wall, rainy, 0, 0, 40)).toEqual(puddles);
    // Composed: stand in one with an empty tank and hold interact.
    const puddle = puddles[0]!;
    let state: SimState = { ...createInitialState(wall, 42, ["p"], { x: puddle.x + 20, z: puddle.z, heading: 0 }), ext: { clock: rainy.ext.clock! } };
    state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(puddle.x, 0, puddle.z, 0) } } };
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    state = step(wall, state, {}, [], systems);
    state = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, players: { p: { ...state.ext.combat!.players.p!, water: 1 } } } } };
    let doneAt = -1;
    for (let tick = 0; tick < 300 && doneAt < 0; tick++) {
      state = step(wall, state, { p: { throttle: 0, steer: 0, brake: 0, actions: Action.interact } }, [], systems);
      if (state.ext.combat!.events.some(e => e.kind === "refill.complete" && e.targetId === puddle.id)) doneAt = tick;
    }
    expect(doneAt).toBeGreaterThanOrEqual(239);
    expect(state.ext.combat!.players.p!.water).toBe(8);
    expect(state.ext.combat!.players.p!.salt).toBe(false);
  });

  it("finds shelter under awnings and at bus stops, and sends an idle bad robot to it in the rain", () => {
    expect(shelteredAt(wall, 9.5, 0)).toBe(true);
    expect(shelteredAt(wall, 0, 0)).toBe(false);
    const dry = shelterPoint(wall, 0, 0)!;
    expect(dry.x).toBeGreaterThan(8.5);
    expect(dry.x).toBeLessThan(10);
    expect(shelteredAt(wall, dry.x, dry.z)).toBe(true);
    const stops = { ...wall, transit: { version: 1, routes: [], stops: [{ id: "stop", x: -20, y: 0, z: 0, routes: [] }] } } as World;
    expect(shelteredAt(stops, -21, 1)).toBe(true);
    expect(shelterPoint(stops, -26, 0)).toEqual({ x: -20, z: 0 });
    const { day, start } = rainyDay();
    const rainy = at(start + 1, day);
    expect(weatherRefuge(wall, rainy, 0, 0)).toEqual(dry);
    expect(weatherRefuge(wall, rainy, dry.x, dry.z)).toEqual(dry);
    expect(weatherRefuge(wall, at(12, 0), 0, 0)).toBeNull();
    // Composed: an idle bad robot walks to the wall and waits there; a good one and an authored mission body do not.
    let sim: SimState = { ...createInitialState(wall, 42, ["p"], { x: -30, z: 30, heading: 0 }), ext: { clock: rainy.ext.clock! } };
    sim = { ...sim, players: { p: { ...sim.players.p!, mode: "foot", foot: makeFoot(-30, 0, 30, 0) } } };
    const spawns = [
      { id: "bad", numericId: 10, model: "footman" as const, firmware: "bad" as const, x: 0, y: 0, z: 0, heading: Math.PI / 2, radius: 0.4, height: 1.8 },
      { id: "good", numericId: 11, model: "footman" as const, firmware: "good" as const, x: -6, y: 0, z: 4, heading: Math.PI, radius: 0.4, height: 1.8 },
      { id: "staged", numericId: 12, model: "footman" as const, firmware: "bad" as const, x: -6, y: 0, z: -4, heading: Math.PI, radius: 0.4, height: 1.8, significant: true, posted: true },
    ];
    sim = { ...sim, ext: { ...sim.ext, robots: createAgentsRuntime(sim, { spawns }) as unknown as NonNullable<SimState["ext"]["robots"]> } };
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    const body = (id: string) => sim.ext.robots!.actors[id]!;
    for (let tick = 0; tick < 600; tick++) sim = step(wall, sim, {}, [], systems);
    expect(shelteredAt(wall, body("bad").x, body("bad").z)).toBe(true);
    const settled = { x: body("bad").x, z: body("bad").z };
    for (let tick = 0; tick < 120; tick++) sim = step(wall, sim, {}, [], systems);
    expect(Math.hypot(body("bad").x - settled.x, body("bad").z - settled.z)).toBeLessThan(0.5);
    expect(body("staged")).toMatchObject({ x: -6, z: -4 });
    expect(shelteredAt(wall, body("good").x, body("good").z) && body("good").x > 8).toBe(false);
  });

  it("rusts an exposed bad robot in the rain but not one sheltered against a wall", () => {
    const { day, start } = rainyDay();
    const rainy = at(start + 1, day);
    let sim: SimState = { ...createInitialState(wall, 42, ["p"], { x: -60, z: 40, heading: 0 }), ext: { clock: rainy.ext.clock! } };
    const spawns = [
      { id: "exposed", numericId: 10, model: "footman" as const, firmware: "bad" as const, x: -30, y: 0, z: 0, heading: 0, radius: 0.4, height: 1.8, significant: true, posted: true },
      { id: "dry", numericId: 11, model: "footman" as const, firmware: "bad" as const, x: 9.4, y: 0, z: 0, heading: 0, radius: 0.4, height: 1.8, significant: true, posted: true },
      { id: "caped", numericId: 12, model: "footman" as const, firmware: "good" as const, x: -30, y: 0, z: 6, heading: 0, radius: 0.4, height: 1.8, significant: true, posted: true },
    ];
    sim = { ...sim, ext: { ...sim.ext, robots: createAgentsRuntime(sim, { spawns }) as unknown as NonNullable<SimState["ext"]["robots"]> } };
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    for (let tick = 0; tick < 120; tick++) sim = step(wall, sim, {}, [], systems);
    const rust = (id: string) => sim.ext.combat?.targets[id]?.rust ?? 0;
    expect(rust("exposed")).toBeGreaterThan(0.005);
    expect(rust("dry")).toBe(0);
    expect(rust("caped")).toBe(0);
  });
});

describe("the King tide on the real Embarcadero", () => {
  const files = loadWorldFiles("sf");
  const sf = buildWorldWithRoads(files.tiles, files.roads, files.boundary, files);
  /** A point `offset` m bayward of the promenade line, part way `t` along segment i. */
  const along = (i: number, t: number, offset: number) => {
    const [ax, az] = TIDE_PROMENADE[i]!, [bx, bz] = TIDE_PROMENADE[i + 1]!;
    const ex = bx - ax, ez = bz - az, len = Math.sqrt(ex * ex + ez * ez);
    return { x: ax + ex * t + (ez / len) * offset, z: az + ez * t - (ex / len) * offset };
  };

  it("floods most of the bayward strip, never the Bay, a building or the inland side", () => {
    let samples = 0, flooded = 0;
    for (let i = 0; i + 1 < TIDE_PROMENADE.length; i++) for (let t = 0.05; t < 1; t += 0.1) for (let off = 10; off <= 30; off += 5) {
      const p = along(i, t, off);
      samples++;
      if (promenadeAt(sf, p.x, p.z)) flooded++;
      expect(promenadeAt(sf, along(i, t, -20).x, along(i, t, -20).z)).toBe(false);
    }
    expect(flooded / samples).toBeGreaterThan(0.7);
    // The Ferry Building itself is a building, not promenade.
    expect(promenadeAt(sf, 20, 0)).toBe(false);
  });

  it("rises on one seeded day a week, refills salt anywhere on the promenade and keeps bad robots inland", () => {
    const day = tideDay();
    let peak = 0, peakHour = -1;
    for (let hour = 0; hour < 24; hour++) { const level = tideLevel(at(hour, day)); if (level > peak) { peak = level; peakHour = hour; } }
    expect(peak).toBeCloseTo(WEATHER.tideDepthM, 9);
    expect(tideLevel(at(peakHour, (day + 1) % 7 === day ? day + 2 : day + 1))).toBe(0);
    const high = at(peakHour, day), spot = along(14, 0.5, 18);
    expect(promenadeAt(sf, spot.x, spot.z)).toBe(true);
    expect(floodDepthAt(sf, high, spot.x, spot.z)).toBeCloseTo(WEATHER.tideDepthM, 9);
    expect(floodDepthAt(sf, at(peakHour, day === 0 ? 1 : day - 1), spot.x, spot.z)).toBe(0);
    expect(tractionAt(sf, high, spot.x, spot.z)).toBe(WEATHER.floodTraction);
    expect(weatherView(sf, high, spot.x, spot.z)).toMatchObject({ tide: WEATHER.tideDepthM, kingTide: true });
    // Bad robots step inland off the waterfront all day.
    const refuge = weatherRefuge(sf, high, spot.x, spot.z)!;
    const inland = along(14, 0.5, -WEATHER.waterfrontAvoidM - 6);
    expect(refuge.x).toBeCloseTo(inland.x, 6);
    expect(refuge.z).toBeCloseTo(inland.z, 6);
    // Composed: a walker on the flooded promenade refills salt water with interact.
    let state: SimState = { ...createInitialState(sf, 42, ["p"], { x: spot.x, z: spot.z, heading: 0 }), ext: { clock: high.ext.clock! } };
    state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(spot.x, state.players.p!.car.y, spot.z, 0) } } };
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    state = step(sf, state, {}, [], systems);
    state = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, players: { p: { ...state.ext.combat!.players.p!, water: 1 } } } } };
    let refilled = false;
    for (let tick = 0; tick < 260 && !refilled; tick++) {
      state = step(sf, state, { p: { throttle: 0, steer: 0, brake: 0, actions: Action.interact } }, [], systems);
      refilled = state.ext.combat!.events.some(e => e.kind === "refill.complete" && e.targetId === "tide:p");
    }
    expect(refilled).toBe(true);
    expect(state.ext.combat!.players.p!.salt).toBe(true);
  }, 120_000);
});
