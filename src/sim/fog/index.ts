// Weather: the marine layer, winter rain, wet roads, rain puddles and the King tide.
// docs/design.md "Day, night and weather" and "Public events". Everything here is a pure
// function of the seed, the saved calendar (ext.clock) and recorded mission requests
// (ext.fog.windows): reading weather never consumes simulation RNG. createGameSystems
// registers the reducer from wave 3; without it ext.fog is absent and nothing here changes
// how a body moves (tractionAt returns 1).
import type { SimState } from "../contract.ts";
import type { SimSystem } from "../system-contract.ts";
import { circleBlocked, groundHeight, nearbyBuildings, type World } from "../world.ts";
import { onWater } from "../boundary.ts";
import { gameTime, DAY_TICKS } from "../clock/calendar.ts";
import { clamp } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { toLatLon } from "../../geo/project.ts";

export interface WeatherWindow { id: string; startTick: number; untilTick: number; density: number }
/** ext.fog: recorded mission fog windows and the mission-event cursor. Everything else is derived. */
export interface FogState { version: 1; missionCursor: number; windows: WeatherWindow[] }
export interface DailyWeather {
  /** Marine-layer strength for the day, 0.65..1. */
  strength: number;
  rain: boolean;
  kingTide: boolean;
}

/** Tunables (docs/design.md marks them *(tune)*). */
export const WEATHER = {
  /** A rainy day's shower lasts this many game hours, starting at a seeded hour 0..17. */
  rainHours: 6,
  /** Roads and puddles dry over this many game hours after the rain stops. */
  dryHours: 2,
  /** Car grip and braking on a fully wet road (1 = dry). */
  wetTraction: 0.72,
  /** ... and through the King tide's 10 cm of water on the promenade. */
  floodTraction: 0.6,
  /** King tide: water depth on the promenade at high tide, metres. */
  tideDepthM: 0.1,
  /** High tide lasts this many game hours at full depth, with one-hour rise and fall. */
  tideHours: 4,
  /** The flooded promenade: this far bayward of the Embarcadero's centre line, metres. */
  promenadeNearM: 8,
  promenadeFarM: 34,
  /** Bad robots keep at least this far inland of the centre line on a King-tide day. */
  waterfrontAvoidM: 12,
  /** Rain puddles: one cell in PUDDLE_ODDS of a PUDDLE_CELL_M grid holds one. */
  puddleCellM: 10,
  puddleOdds: 6,
  puddleRadiusM: 1.2,
  /** A bus shelter covers this far around its stop; an awning this far off a building's wall. */
  shelterStopM: 2.5,
  awningM: 1.2,
} as const;

/**
 * The Embarcadero's centre line from Pier 39 to China Basin, local metres (decimated from the
 * pipeline's roads.json "The Embarcadero" edges). The Bay lies on the left of travel along
 * it, so the promenade the King tide floods is the strip promenadeNearM..promenadeFarM to the
 * left. The renderer draws its water from the same line (weatherView / TIDE_PROMENADE).
 */
export const TIDE_PROMENADE: readonly (readonly [number, number])[] = Object.freeze([
  [-2077, -1521], [-1950, -1500], [-1660, -1465], [-1480, -1416], [-1352, -1400], [-1215, -1333],
  [-1053, -1240], [-857, -1075], [-708, -940], [-495, -601], [-350, -414], [-146, -150],
  [-105, -37], [-44, 70], [103, 176], [150, 259], [276, 393], [354, 568], [508, 732],
  [503, 923], [489, 1120], [505, 1331], [494, 1508],
].map(p => Object.freeze(p) as readonly [number, number]));

/** The Ferry Building's arcade along its land-side face (the clock tower stands at the origin): a capsule, local metres. */
const ARCADE = { ax: -58, az: -82, bx: 41, bz: 92, r: 8 } as const;

/** One state's derived weather, computed once per state object. */
interface Snapshot {
  hour: number;
  dayIndex: number;
  forecast: DailyWeather;
  downtownNight: boolean;
  /** Strongest active recorded window. */
  windowDensity: number;
  rain: number;
  wetness: number;
  tide: number;
  microclimates: readonly { x: number; z: number; r2: number }[];
}
const snapshots = new WeakMap<object, Snapshot>();

function daily(seed: number, dayIndex: number, season: "summer" | "winter"): DailyWeather {
  const h = hash32(seed, dayIndex, 0x57454154);
  return {
    strength: 0.65 + (h % 351) / 1000,
    rain: season === "winter" && h % 3 === 0,
    kingTide: dayIndex % 7 === hash32(seed, Math.floor(dayIndex / 7), 0x54494445) % 7,
  };
}

function rainStart(seed: number, dayIndex: number): number { return hash32(seed, dayIndex, 0x5241494e) % 18; }

/** Hours since the end of the most recent shower that started on `dayIndex` or the day before, or -1 while it rains. */
function sinceRain(seed: number, dayIndex: number, hour: number, season: "summer" | "winter", prevSeason: "summer" | "winter"): number {
  if (daily(seed, dayIndex, season).rain) {
    const start = rainStart(seed, dayIndex);
    if (hour >= start && hour < start + WEATHER.rainHours) return -1;
    if (hour >= start + WEATHER.rainHours) return hour - start - WEATHER.rainHours;
  }
  if (dayIndex > 0 && daily(seed, dayIndex - 1, prevSeason).rain) {
    const end = rainStart(seed, dayIndex - 1) + WEATHER.rainHours;
    // A late shower runs past midnight into this day.
    if (end > 24 && hour < end - 24) return -1;
    return hour + 24 - end;
  }
  return Infinity;
}

function tideDepth(seed: number, dayIndex: number, hour: number, kingTide: boolean): number {
  if (!kingTide) return 0;
  const start = 8 + hash32(seed, dayIndex, 0x48494748) % 6;
  const rise = clamp(hour - (start - 1), 0, 1), fall = clamp(start + WEATHER.tideHours + 1 - hour, 0, 1);
  return WEATHER.tideDepthM * Math.min(rise, fall);
}

function snapshot(state: Readonly<SimState>): Snapshot {
  const cached = snapshots.get(state);
  if (cached) return cached;
  const time = gameTime(state), hour = time.hour + time.minute / 60 + time.second / 3600;
  const forecast = daily(state.seed, time.dayIndex, time.season);
  // Seasons alternate every four game weeks: the day before a week's first day may be the other one.
  const prevSeason = time.dayIndex % 28 === 0 && time.dayIndex > 0 ? (time.season === "summer" ? "winter" : "summer") : time.season;
  const since = sinceRain(state.seed, time.dayIndex, hour, time.season, prevSeason);
  let windowDensity = 0;
  const fog = state.ext.fog;
  for (const front of Array.isArray(fog?.windows) ? fog.windows : []) {
    if (Number.isFinite(front.density) && front.startTick <= state.tick && front.untilTick > state.tick) windowDensity = Math.max(windowDensity, clamp(front.density, 0, 1));
  }
  const microclimates: { x: number; z: number; r2: number }[] = [];
  for (const zone of state.ext.combat?.gadgets ?? []) {
    if (zone.kind === "microclimate" && zone.untilTick > state.tick && [zone.x, zone.z, zone.radius].every(Number.isFinite)) microclimates.push({ x: zone.x, z: zone.z, r2: zone.radius * zone.radius });
  }
  const value: Snapshot = {
    hour, dayIndex: time.dayIndex, forecast,
    downtownNight: hash32(state.seed, time.dayIndex, 0x444f574e) % 3 === 0,
    windowDensity,
    rain: since < 0 ? 1 : 0,
    wetness: since < 0 ? 1 : clamp(1 - since / WEATHER.dryHours, 0, 1),
    tide: tideDepth(state.seed, time.dayIndex, hour, forecast.kingTide),
    microclimates,
  };
  snapshots.set(state, value);
  return value;
}

/** A day gets one seeded forecast. Reading weather never advances simulation RNG. */
export function dailyWeather(state: Readonly<SimState>): DailyWeather { return snapshot(state).forecast; }

/** 0 before `start`'s ramp, 1 overnight, thinning to 0 between 09:00 and 11:00. */
function overnight(hour: number, start: number): number {
  if (hour >= start) return clamp((hour - start) / 2, 0, 1);
  if (hour < 9) return 1;
  return clamp((11 - hour) / 2, 0, 1);
}

/**
 * Fog density 0..1 at (x, z): the marine layer arrives in the west around 17:00, reaches the
 * Marina by 19:00 and downtown on some nights, and thins by 11:00; the east side (Dogpatch,
 * Mission Bay, Potrero Hill) stays sunnier.
 * Recorded mission windows and Microclimate-as-a-Service spheres raise it.
 */
export function fogDensity(_world: World, state: Readonly<SimState>, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const w = snapshot(state), p = toLatLon(x, z);
  const west = clamp((-122.425 - p.lon) / 0.028, 0, 1);
  const marina = clamp((p.lat - 37.787) / 0.018, 0, 1) * clamp((-122.41 - p.lon) / 0.015, 0, 1);
  // Dogpatch, Mission Bay and Potrero Hill sit in the sun belt: the layer rarely gets that far.
  const sunny = clamp((p.lon + 122.41) / 0.012, 0, 1) * clamp((37.78 - p.lat) / 0.008, 0, 1);
  const downtown = w.downtownNight ? overnight(w.hour, 21) * 0.7 : 0;
  let density = Math.max(west * overnight(w.hour, 17), marina * overnight(w.hour, 19), downtown * (1 - west) * 0.8) * w.forecast.strength * (1 - 0.85 * sunny);
  density = Math.max(density, w.windowDensity);
  for (const zone of w.microclimates) {
    const dx = x - zone.x, dz = z - zone.z;
    if (dx * dx + dz * dz <= zone.r2) density = 1;
  }
  return clamp(density, 0, 1);
}

/** 1 while it rains (citywide), else 0. */
export function rainDensity(state: Readonly<SimState>): number { return snapshot(state).rain; }
/** Road wetness 0..1: 1 in the rain, drying to 0 over WEATHER.dryHours. */
export function roadWetness(state: Readonly<SimState>): number { return snapshot(state).wetness; }
/** The King tide's water depth on the promenade now, metres (0 on other days). */
export function tideLevel(state: Readonly<SimState>): number { return snapshot(state).tide; }

/** Signed offset of (x, z) to the left (bayward) of the promenade line, or null beyond its ends. */
function promenadeOffset(x: number, z: number): number | null {
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i + 1 < TIDE_PROMENADE.length; i++) {
    const [ax, az] = TIDE_PROMENADE[i]!, [bx, bz] = TIDE_PROMENADE[i + 1]!;
    const ex = bx - ax, ez = bz - az, len2 = ex * ex + ez * ez;
    const t = ((x - ax) * ex + (z - az) * ez) / len2;
    if (t < 0 || t > 1) continue;
    const len = Math.sqrt(len2), side = ((x - ax) * ez - (z - az) * ex) / len;
    const d = side < 0 ? -side : side;
    if (d < bestD) { bestD = d; best = side; }
  }
  return best;
}

/** Is (x, z) on the King tide's promenade (dry land; never in a building)? Geometry only. */
export function promenadeAt(world: World, x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const side = promenadeOffset(x, z);
  if (side === null || side < WEATHER.promenadeNearM || side > WEATHER.promenadeFarM) return false;
  if (world.walls && onWater(world.walls.shore, x, z)) return false;
  return !circleBlocked(world, x, z, 0.1);
}

/** Water depth over the ground at (x, z) from the King tide, metres. */
export function floodDepthAt(world: World, state: Readonly<SimState>, x: number, z: number): number {
  const tide = snapshot(state).tide;
  return tide > 0 && promenadeAt(world, x, z) ? tide : 0;
}

interface StopIndex { cells: Map<string, { x: number; z: number }[]> }
const stopIndexes = new WeakMap<World, StopIndex>();
const STOP_CELL = 50;
function stopIndex(world: World): StopIndex {
  let index = stopIndexes.get(world);
  if (index) return index;
  const cells = new Map<string, { x: number; z: number }[]>();
  for (const stop of world.transit?.stops ?? []) {
    if (!Number.isFinite(stop.x) || !Number.isFinite(stop.z)) continue;
    const key = `${Math.floor(stop.x / STOP_CELL)},${Math.floor(stop.z / STOP_CELL)}`;
    const list = cells.get(key) ?? [];
    list.push({ x: stop.x, z: stop.z });
    cells.set(key, list);
  }
  index = { cells };
  stopIndexes.set(world, index);
  return index;
}
function stopsNear(world: World, x: number, z: number, r: number): { x: number; z: number }[] {
  const index = stopIndex(world), out: { x: number; z: number }[] = [];
  for (let cx = Math.floor((x - r) / STOP_CELL); cx <= Math.floor((x + r) / STOP_CELL); cx++) {
    for (let cz = Math.floor((z - r) / STOP_CELL); cz <= Math.floor((z + r) / STOP_CELL); cz++) {
      for (const stop of index.cells.get(`${cx},${cz}`) ?? []) {
        const dx = stop.x - x, dz = stop.z - z;
        if (dx * dx + dz * dz <= r * r) out.push(stop);
      }
    }
  }
  return out;
}
function inArcade(x: number, z: number): boolean {
  const ex = ARCADE.bx - ARCADE.ax, ez = ARCADE.bz - ARCADE.az;
  const t = clamp(((x - ARCADE.ax) * ex + (z - ARCADE.az) * ez) / (ex * ex + ez * ez), 0, 1);
  const dx = ARCADE.ax + ex * t - x, dz = ARCADE.az + ez * t - z;
  return dx * dx + dz * dz <= ARCADE.r * ARCADE.r;
}

/** Out of the rain at (x, z): a Muni shelter, the Ferry Building arcade or under an awning (beside a wall). */
export function shelteredAt(world: World, x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (inArcade(x, z)) return true;
  if (stopsNear(world, x, z, WEATHER.shelterStopM).length > 0) return true;
  return circleBlocked(world, x, z, WEATHER.awningM);
}

/** The nearest dry spot within `radius` of (x, z): a bus stop, or a point just off the nearest wall. Null when none. */
export function shelterPoint(world: World, x: number, z: number, radius = 30): { x: number; z: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let best: { x: number; z: number } | null = null, bestD = radius * radius;
  for (const stop of stopsNear(world, x, z, radius)) {
    const d = (stop.x - x) * (stop.x - x) + (stop.z - z) * (stop.z - z);
    if (d < bestD) { bestD = d; best = { x: stop.x, z: stop.z }; }
  }
  for (const b of nearbyBuildings(world, x, z, radius)) {
    if (b.topY <= b.baseY) continue;
    const f = b.footprint;
    let cx = 0, cz = 0;
    for (const [px, pz] of f) { cx += px; cz += pz; }
    cx /= f.length; cz /= f.length;
    for (let i = 0; i < f.length; i++) {
      const [ax, az] = f[i]!, [bx, bz] = f[(i + 1) % f.length]!;
      const ex = bx - ax, ez = bz - az, len2 = ex * ex + ez * ez;
      if (len2 < 1e-6) continue;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0.05, 0.95);
      const len = Math.sqrt(len2);
      // Step off the wall away from the footprint's centre, inside the awning's reach.
      let nx = -ez / len, nz = ex / len;
      const mx = ax + ex * t, mz = az + ez * t;
      if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
      const px = mx + nx * WEATHER.awningM * 0.6, pz = mz + nz * WEATHER.awningM * 0.6;
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
    }
  }
  return best;
}

export interface Puddle { id: string; x: number; y: number; z: number; radius: number }
/** Rain puddles within `radius` of (x, z): seeded per day on a grid, never in a building or the Bay. Empty while roads are dry. */
export function puddlesNear(world: World, state: Readonly<SimState>, x: number, z: number, radius: number): Puddle[] {
  const w = snapshot(state);
  if (w.wetness < 0.3 || !Number.isFinite(x) || !Number.isFinite(z) || !(radius > 0)) return [];
  const C = WEATHER.puddleCellM, out: Puddle[] = [];
  for (let cx = Math.floor((x - radius) / C); cx <= Math.floor((x + radius) / C); cx++) {
    for (let cz = Math.floor((z - radius) / C); cz <= Math.floor((z + radius) / C); cz++) {
      const h = hash32(state.seed, w.dayIndex, cx, cz, 0x50554444);
      if (h % WEATHER.puddleOdds !== 0) continue;
      const px = cx * C + 1 + ((h >>> 4) % 8), pz = cz * C + 1 + ((h >>> 8) % 8);
      if ((px - x) * (px - x) + (pz - z) * (pz - z) > radius * radius) continue;
      if (circleBlocked(world, px, pz, WEATHER.puddleRadiusM) || world.walls && onWater(world.walls.shore, px, pz)) continue;
      out.push({ id: `puddle:${w.dayIndex}:${cx}:${cz}`, x: px, y: groundHeight(world, px, pz), z: pz, radius: WEATHER.puddleRadiusM });
    }
  }
  return out;
}

/**
 * Tyre grip and braking scale for a car at (x, z), 1 when dry. Only a state the weather
 * reducer has run on (ext.fog present: wave 3 and later) has wet roads.
 */
export function tractionAt(world: World, state: Readonly<SimState>, x: number, z: number): number {
  if (!state.ext.fog) return 1;
  const w = snapshot(state);
  let traction = 1 - (1 - WEATHER.wetTraction) * w.wetness;
  if (w.tide > 0 && promenadeAt(world, x, z)) traction = Math.min(traction, WEATHER.floodTraction);
  return traction;
}

/**
 * Where weather sends a bad robot at (x, z), or null: under shelter in the rain, inland off the
 * promenade on a King-tide day. Good robots wear rain capes and keep their errands.
 */
export function weatherRefuge(world: World, state: Readonly<SimState>, x: number, z: number): { x: number; z: number } | null {
  const w = snapshot(state);
  if (w.forecast.kingTide) {
    const side = promenadeOffset(x, z);
    if (side !== null && side > -WEATHER.waterfrontAvoidM && side < WEATHER.promenadeFarM + 20) {
      // Step straight inland along the line's right-hand normal.
      let best: { x: number; z: number } | null = null, bestD = Infinity;
      for (let i = 0; i + 1 < TIDE_PROMENADE.length; i++) {
        const [ax, az] = TIDE_PROMENADE[i]!, [bx, bz] = TIDE_PROMENADE[i + 1]!;
        const ex = bx - ax, ez = bz - az, len2 = ex * ex + ez * ez, t = ((x - ax) * ex + (z - az) * ez) / len2;
        if (t < 0 || t > 1) continue;
        const len = Math.sqrt(len2), px = ax + ex * t, pz = az + ez * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < bestD) { bestD = d; best = { x: px - (ez / len) * (WEATHER.waterfrontAvoidM + 6), z: pz + (ex / len) * (WEATHER.waterfrontAvoidM + 6) }; }
      }
      if (best) return best;
    }
  }
  // Already dry: stay put until the rain stops.
  if (w.rain > 0) return shelteredAt(world, x, z) ? { x, z } : shelterPoint(world, x, z);
  return null;
}

/** What the renderer and HUD read: the weather at one point (the camera's or the player's). */
export interface WeatherView {
  fog: number;
  rain: number;
  wetness: number;
  /** King-tide depth on the promenade, metres; the flooded strip is TIDE_PROMENADE offset promenadeNearM..promenadeFarM to its left. */
  tide: number;
  kingTide: boolean;
  sheltered: boolean;
  /** Rain puddles within 40 m. */
  puddles: Puddle[];
  /** Hours since midnight, game time. */
  hour: number;
}
export function weatherView(world: World, state: Readonly<SimState>, x: number, z: number): WeatherView {
  if (!state.ext.fog) return { fog: 0, rain: 0, wetness: 0, tide: 0, kingTide: false, sheltered: false, puddles: [], hour: snapshot(state).hour };
  const w = snapshot(state);
  return { fog: fogDensity(world, state, x, z), rain: w.rain, wetness: w.wetness, tide: w.tide, kingTide: w.forecast.kingTide,
    sheltered: shelteredAt(world, x, z), puddles: puddlesNear(world, state, x, z, 40), hour: w.hour };
}

/** The saved weather extension, or a fresh one when absent or malformed. */
export function fogStateOf(state: Readonly<SimState>): FogState {
  const raw = state.ext.fog as Partial<FogState> | undefined;
  return raw?.version === 1 && Array.isArray(raw.windows) && Number.isSafeInteger(raw.missionCursor) ? raw as FogState : { version: 1, missionCursor: 0, windows: [] };
}

/** Consumes authored weather requests once (Marine Layer's night fog); daylight skips are part of the saved clock. */
export function createFogSystem(): SimSystem {
  return { key: "fog", step: ({ state }) => {
    const old = fogStateOf(state);
    let cursor = old.missionCursor, next = state;
    const windows = old.windows.filter(front => typeof front.id === "string" && Number.isFinite(front.density) && Number.isSafeInteger(front.startTick) && Number.isSafeInteger(front.untilTick) && front.untilTick > state.tick);
    for (const event of [...state.ext.missions?.events ?? []].sort((a, b) => a.id - b.id)) {
      if (event.id <= cursor) continue;
      cursor = event.id;
      if (event.kind !== "mission.weather-request") continue;
      let value: unknown;
      try { value = JSON.parse(event.detail); } catch { continue; }
      if (!value || typeof value !== "object") continue;
      const request = value as { fog?: unknown; durationTicks?: unknown; night?: unknown };
      if (typeof request.fog !== "number" || !Number.isFinite(request.fog) || typeof request.durationTicks !== "number" ||
        !Number.isSafeInteger(request.durationTicks) || request.durationTicks < 1 || request.durationTicks > 7 * DAY_TICKS) continue;
      windows.push({ id: `${event.targetId}:${event.id}`, startTick: state.tick, untilTick: state.tick + request.durationTicks, density: clamp(request.fog, 0, 1) });
      if (request.night === true) {
        const time = gameTime(next);
        if (time.hour >= 6 && time.hour < 19) {
          const skip = 22 * 3600 - (time.hour * 3600 + time.minute * 60 + time.second);
          next = { ...next, ext: { ...next.ext, clock: { version: 1, elapsedTicks: (next.ext.clock?.elapsedTicks ?? next.tick) + skip } } };
        }
      }
    }
    if (windows.length > 64) windows.splice(0, windows.length - 64);
    return { ...next, ext: { ...next.ext, fog: { version: 1, missionCursor: cursor, windows } } };
  } };
}
