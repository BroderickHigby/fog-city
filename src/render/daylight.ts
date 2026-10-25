// Daylight from the sim's game clock (src/sim/clock/calendar.ts gameTime): the sun's path over
// San Francisco for the game date and hour, and the lighting presets (sky.ts) blended by the
// sun's elevation, so the sky, fog, IBL and grade follow one continuous day. A game day is 24
// real minutes. Render-only: the sim's clock is read, never written.
//
// The game clock reads as local time; daylight-saving months shift solar noon to about 13:10.
// Below the horizon the key light turns into the night preset's moon.
import * as THREE from "three";
import { presentationLook, type PresentationLook } from "./quality.ts";
import { GOLDEN, NIGHT, NOON, TWILIGHT, sunDirection, type LightingPreset } from "./sky.ts";

export const SF_LATITUDE_DEG = 37.78;

/** Presets keyed by the sun's elevation (degrees): night below the first, noon above the last. */
export const DAYLIGHT_KEYS: readonly (readonly [number, LightingPreset])[] = [
  [-9, NIGHT],
  [1, TWILIGHT],
  [14, GOLDEN],
  [45, NOON],
];

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const RAD = Math.PI / 180;

/** The sun's compass azimuth and elevation (degrees) at a local clock hour on a date. */
export function sunPosition(month: number, day: number, hour: number): { azimuthDeg: number; elevationDeg: number } {
  const n = (MONTH_START[Math.min(11, Math.max(0, month - 1))] ?? 0) + day;
  const declination = 23.44 * Math.sin((2 * Math.PI * (284 + n)) / 365) * RAD;
  const solarHour = hour - (month >= 3 && month <= 10 ? 1.17 : 0.17);
  const h = (solarHour - 12) * 15 * RAD;
  const lat = SF_LATITUDE_DEG * RAD;
  const sinEl = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(h);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // Compass bearing: 0 north, 90 east; afternoon (h > 0) is west of south.
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) / RAD + 180;
  return { azimuthDeg: ((az % 360) + 360) % 360, elevationDeg: elevation / RAD };
}

const _a = new THREE.Color();
const _b = new THREE.Color();
const lerpHex = (a: number, b: number, t: number): number => _a.setHex(a).lerp(_b.setHex(b), t).getHex();
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Two presets mixed at t (0 = a): numbers linearly, colours in linear RGB. Named after the nearer. */
export function blendPresets(a: LightingPreset, b: LightingPreset, t: number): LightingPreset {
  const out = { ...(t < 0.5 ? a : b) } as LightingPreset;
  const mutable = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(a) as (keyof LightingPreset)[]) {
    const x = a[key], y = b[key];
    if (typeof x !== "number" || typeof y !== "number") continue;
    mutable[key] = /color|zenith|horizon|hemi(Sky|Ground)$/i.test(key) ? lerpHex(x, y, t) : lerp(x, y, t);
  }
  out.fog = { density: lerp(a.fog.density, b.fog.density, t), falloff: lerp(a.fog.falloff, b.fog.falloff, t),
    baseY: lerp(a.fog.baseY, b.fog.baseY, t), distK: lerp(a.fog.distK, b.fog.distK, t) };
  out.cloudCoverage = lerp(a.cloudCoverage ?? 0, b.cloudCoverage ?? 0, t);
  out.cloudOpacity = lerp(a.cloudOpacity ?? 0, b.cloudOpacity ?? 0, t);
  out.nightFactor = lerp(a.nightFactor ?? (a.name === "night" ? 1 : 0), b.nightFactor ?? (b.name === "night" ? 1 : 0), t);
  return out;
}

export function blendLooks(a: PresentationLook, b: PresentationLook, t: number): PresentationLook {
  return {
    contrast: lerp(a.contrast, b.contrast, t),
    saturation: lerp(a.saturation, b.saturation, t),
    balance: [lerp(a.balance[0], b.balance[0], t), lerp(a.balance[1], b.balance[1], t), lerp(a.balance[2], b.balance[2], t)],
    bloom: lerp(a.bloom, b.bloom, t),
    bloomThreshold: lerp(a.bloomThreshold, b.bloomThreshold, t),
  };
}

export interface Daylight {
  preset: LightingPreset;
  look: PresentationLook;
  /** The sun's own elevation, degrees (negative at night). */
  sunElevationDeg: number;
  /** Changes when the sky differs enough to need a new environment map (3 degrees of sun, 10 of azimuth). */
  envKey: string;
}

const _sun = new THREE.Vector3();
const _moon = new THREE.Vector3();

/** The lighting for a local clock hour on a game date. */
export function daylightAt(month: number, day: number, hour: number): Daylight {
  const sun = sunPosition(month, day, hour);
  const e = sun.elevationDeg;
  let i = 0;
  while (i < DAYLIGHT_KEYS.length - 1 && e > DAYLIGHT_KEYS[i + 1]![0]) i++;
  const [e0, p0] = DAYLIGHT_KEYS[i]!;
  const [e1, p1] = DAYLIGHT_KEYS[Math.min(i + 1, DAYLIGHT_KEYS.length - 1)]!;
  const t = e1 > e0 ? Math.max(0, Math.min(1, (e - e0) / (e1 - e0))) : 0;
  const preset = blendPresets(p0, p1, t);
  const look = blendLooks(presentationLook(p0.name), presentationLook(p1.name), t);
  // The key light: the sun itself above the twilight key, turning into the moon below it.
  const twilightE = DAYLIGHT_KEYS[1]![0];
  sunDirection({ sunAzimuthDeg: sun.azimuthDeg, sunElevationDeg: Math.max(e, twilightE + 1) }, _sun);
  const moonward = Math.max(0, Math.min(1, (twilightE - e) / (twilightE - DAYLIGHT_KEYS[0]![0])));
  if (moonward > 0) _sun.lerp(sunDirection(NIGHT, _moon), moonward).normalize();
  preset.sunAzimuthDeg = ((Math.atan2(_sun.x, -_sun.z) / RAD) + 360) % 360;
  preset.sunElevationDeg = Math.asin(Math.max(-1, Math.min(1, _sun.y))) / RAD;
  const envKey = `sim:${Math.round(e / 3)}:${Math.round(preset.sunAzimuthDeg / 10) % 36}`;
  return { preset, look, sunElevationDeg: e, envKey };
}
