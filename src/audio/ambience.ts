// City ambience: what the air around the player sounds like. Pure and read-only.
//
// Layers (continuous, procedural in ambience-synth.ts):
//   traffic : distant road rumble, from vehicles within TRAFFIC_M (louder in busy districts)
//   crowd   : a murmur from people within CROWD_M (and a busy-district baseline by day)
//   wind    : stronger on the waterfront and in the fog
//   rain    : from the weather; muffled under shelter
// Events: foghorns across the bay in fog on the waterfront; gulls on the waterfront by day.
// Inside a car everything outside is quieter (the car shell).

import districtsFile from "../../content/districts.json" with { type: "json" };
import { toLocal } from "../geo/project.ts";

export const TRAFFIC_M = 90;
export const CROWD_M = 30;
export const WATERFRONT_DISTRICTS: ReadonlySet<string> = new Set(["embarcadero", "fishermans-wharf", "marina", "mission-bay", "dogpatch", "bay-bridge-approach"]);
export const BUSY_DISTRICTS: ReadonlySet<string> = new Set(["downtown", "fidi", "embarcadero", "fishermans-wharf", "soma", "north-beach"]);
/** Everything outside, heard from inside a car. */
export const IN_CAR = 0.45;

interface District { id: string; polygon: number[][] }
const DISTRICTS: Array<{ id: string; local: Array<{ x: number; z: number }> }> = (districtsFile.districts as District[]).map((d) => ({
  id: d.id,
  // Polygon vertices are [lat, lon].
  local: d.polygon.map((p) => toLocal(p[0]!, p[1]!)),
}));

/** The district at a point (world metres), or null outside every district polygon. */
export function districtAt(x: number, z: number): string | null {
  for (const d of DISTRICTS) {
    let inside = false;
    for (let i = 0, j = d.local.length - 1; i < d.local.length; j = i++) {
      const a = d.local[i]!, b = d.local[j]!;
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    if (inside) return d.id;
  }
  return null;
}

export interface AmbienceInput {
  /** Vehicles (cars, taxis, vans, buses) within TRAFFIC_M, with their distances. */
  vehiclesNear: readonly number[];
  /** People within CROWD_M, with their distances. */
  peopleNear: readonly number[];
  district: string | null;
  /** From the sim's weather view at the player; null when unknown. */
  weather: { fog: number; rain: number; sheltered: boolean; hour: number } | null;
  inCar: boolean;
}

export interface AmbienceLevels {
  traffic: number;
  crowd: number;
  wind: number;
  rain: number;
  /** 0..1: how much of the bay is in earshot (foghorns, gulls). */
  waterfront: number;
  night: boolean;
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

export function ambienceLevels(i: AmbienceInput): AmbienceLevels {
  const hour = i.weather?.hour ?? 12;
  const night = hour < 6 || hour >= 21;
  const busy = i.district !== null && BUSY_DISTRICTS.has(i.district);
  const waterfront = i.district !== null && WATERFRONT_DISTRICTS.has(i.district) ? 1 : 0;
  // Nearer vehicles count more; a few close ones are as loud as a busy street.
  const traffic = clamp01(i.vehiclesNear.reduce((s, d) => s + (1 - d / TRAFFIC_M), 0) / 6) * 0.22 + (busy ? 0.04 : 0.015);
  const crowdBase = busy && !night ? 0.03 : 0;
  const crowd = clamp01(i.peopleNear.reduce((s, d) => s + (1 - d / CROWD_M), 0) / 8) * 0.16 + crowdBase;
  const fog = i.weather?.fog ?? 0;
  const wind = 0.02 + 0.06 * waterfront + 0.05 * fog;
  const rain = (i.weather?.rain ?? 0) * (i.weather?.sheltered ? 0.35 : 1) * 0.3;
  const shell = i.inCar ? IN_CAR : 1;
  return {
    traffic: traffic * shell * (night ? 0.6 : 1),
    crowd: crowd * shell,
    wind: wind * shell,
    rain: rain * (i.inCar ? 0.7 : 1),
    waterfront,
    night,
  };
}

export const FOGHORN_MIN_S = 40;
export const FOGHORN_MAX_S = 75;
export const GULL_MIN_S = 7;
export const GULL_MAX_S = 22;

export interface AmbientEvent { kind: "foghorn" | "gull"; gain: number; pan: number }

/** Foghorns and gulls on their own rhythms (a fixed seeded sequence, so tests are stable). */
export class AmbientEventClock {
  private seed: number;
  private nextFoghorn = 0;
  private nextGull = 0;
  private started = false;

  constructor(seed = 0x5eed) {
    this.seed = seed >>> 0;
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  update(levels: AmbienceLevels, fog: number, nowS: number): AmbientEvent[] {
    if (!this.started) {
      this.started = true;
      this.nextFoghorn = nowS + 8 + this.rand() * 20;
      this.nextGull = nowS + 3 + this.rand() * 8;
    }
    const out: AmbientEvent[] = [];
    if (nowS >= this.nextFoghorn) {
      this.nextFoghorn = nowS + FOGHORN_MIN_S + this.rand() * (FOGHORN_MAX_S - FOGHORN_MIN_S);
      // Heard across the bay in fog; faint inland, silent in clear weather.
      const g = fog > 0.3 ? (0.15 + 0.35 * levels.waterfront) * Math.min(1, fog) : 0;
      if (g > 0) out.push({ kind: "foghorn", gain: g, pan: this.rand() * 1.2 - 0.6 });
    }
    if (nowS >= this.nextGull) {
      this.nextGull = nowS + GULL_MIN_S + this.rand() * (GULL_MAX_S - GULL_MIN_S);
      if (levels.waterfront > 0 && !levels.night) out.push({ kind: "gull", gain: 0.18 + this.rand() * 0.14, pan: this.rand() * 1.6 - 0.8 });
    }
    return out;
  }

  reset(): void {
    this.started = false;
  }
}
