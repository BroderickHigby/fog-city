// Road water: the constants and a CPU reference of the shader math in node-materials.ts
// (puddleField, waterMasks, the Fresnel metalness). Adapted from Slop New York's road wetness
// (Mr.doob, MIT; js/tsl-materials.js:1580-1609 the three-scale field and the water line,
// 1622-1710 the road material, 1755-1758 the paint; third-party notice in assets/imports/slop-new-york).
//
// Wetness (0 = bone dry, 1 = just after a downpour) is a look. It comes from the lighting preset
// by time of day (sky.ts roadSheen: dry at noon, slick at night) or from the sim's rain, and is
// read only by materials. Nothing here is read by src/sim, so it never reaches traction.
//
// Water collects in the highest values of a three-scale noise field first, so as wetness rises the
// water line sinks and pools appear, grow and merge. Water's Fresnel (F0 0.02) rides on metalness,
// so a pool mirrors the street at grazing angles and only darkens the asphalt seen from above.
// No three.js import: tests/render/road-water.test.ts runs the reference.

/** The field's three scales: noise frequency along x and z, its offset, and its weight (they sum to 1). */
export const PUDDLE_SCALES: readonly { freq: readonly [number, number]; offset: readonly [number, number]; weight: number }[] = [
  { freq: [0.095, 0.075], offset: [0, 0], weight: 0.52 },
  { freq: [0.25, 0.22], offset: [19.4, 11.8], weight: 0.34 },
  { freq: [0.68, 0.68], offset: [-7.3, 29.1], weight: 0.14 },
];
/** Pixel footprint (metres) over which the middle and fine scales settle to their mean, so far roads do not shimmer. */
export const PUDDLE_MID_FADE: readonly [number, number] = [1.1, 3];
export const PUDDLE_FINE_FADE: readonly [number, number] = [0.35, 1];
/** The water line: the field value above which standing water sits, dry and fully wet. */
export const WATER_LEVEL_DRY = 0.86;
export const WATER_LEVEL_WET = 0.56;
/** Wetness at which the line starts to sink, and the span it sinks over. */
export const WATER_RISE_FROM = 0.1;
export const WATER_RISE_SPAN = 0.55;
/** Damp stains start this far below the line, pools start at it with a soft edge this wide. */
export const DAMP_BELOW: readonly [number, number] = [0.09, 0.015];
export const POOL_EDGE = 0.022;
/**
 * Damp stains, then pools, need wetness to appear (ramps), and the wet film covers everything over its
 * ramp. Slop leaves damp stains ungated, so its noon road keeps faint stains in the field's highest
 * spots; here a dry preset (noon, 0.08) leaves the asphalt exactly as it was before the sheen.
 */
export const DAMP_WETNESS: readonly [number, number] = [0.08, 0.2];
export const POOL_WETNESS: readonly [number, number] = [0.1, 0.22];
export const FILM_WETNESS: readonly [number, number] = [0.2, 0.8];
/** Albedo multipliers: damp stains, pools, and the film over everything. */
export const DAMP_ALBEDO = 0.72;
export const POOL_ALBEDO = 0.6;
export const FILM_ALBEDO = 0.8;
/** Lane paint in water: it darkens less than asphalt, and stays glossier than dry paint. */
export const PAINT_POOL_ALBEDO = 0.72;
export const PAINT_FILM_ALBEDO = 0.86;
export const PAINT_ROUGHNESS = { dry: 0.62, film: 0.42, pool: 0.2 } as const;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const fract = (x: number): number => x - Math.floor(x);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Where the water line sits at this wetness, plus a surface's own `drainage` (a crowned, better drained surface is higher). */
export function waterLevel(wetness: number, drainage = 0): number {
  return mix(WATER_LEVEL_DRY, WATER_LEVEL_WET, clamp((wetness - WATER_RISE_FROM) / WATER_RISE_SPAN, 0, 1)) + drainage;
}

export interface WetMasks { damp: number; puddle: number; film: number }

/**
 * Damp stains, standing water and the wet film at a field value. `softness` widens the edges by the
 * field's change across a pixel, so a pool's edge is filtered rather than aliased.
 */
export function wetMasks(field: number, wetness: number, drainage = 0, softness = 0): WetMasks {
  const level = waterLevel(wetness, drainage);
  return {
    damp: smoothstep(level - DAMP_BELOW[0] - softness, level - DAMP_BELOW[1] + softness, field) * smoothstep(DAMP_WETNESS[0], DAMP_WETNESS[1], wetness),
    puddle: smoothstep(level - softness * 0.5, level + POOL_EDGE + softness, field) * smoothstep(POOL_WETNESS[0], POOL_WETNESS[1], wetness),
    film: smoothstep(FILM_WETNESS[0], FILM_WETNESS[1], wetness),
  };
}

/** Albedo multiplier of wet asphalt. */
export function wetAlbedo(m: WetMasks): number {
  return mix(mix(1, DAMP_ALBEDO, m.damp), POOL_ALBEDO, m.puddle) * mix(1, FILM_ALBEDO, m.film);
}

/** Water's Fresnel (F0 0.02) from the cosine of the view angle to the surface normal. */
export function waterFresnel(cosView: number): number {
  return Math.pow(1 - clamp(cosView, 0, 1), 5) * 0.98 + 0.02;
}

/** Metalness that carries water's Fresnel to the reflection pass: pools fully, the film partly, nothing when dry. */
export function waterMetalness(cosView: number, m: WetMasks): number {
  return clamp(waterFresnel(cosView) * 1.6, 0, 0.85) * Math.max(m.puddle, m.film * 0.6);
}

/** Roughness: dry, a satin film or damp stain, and mirror-smooth standing water. */
export function wetRoughness(dry: number, m: WetMasks): number {
  return mix(mix(dry, 0.38, Math.max(m.film * 0.9, m.damp * 0.8)), 0.1, m.puddle);
}

/** Value noise on the same hash as the shader's noise2, for the reference field. */
export function noise2(x: number, y: number): number {
  const hash = (ix: number, iy: number): number => fract(Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy);
}

/** The three-scale field at a world position; `pixel` is the pixel footprint in metres. */
export function puddleField(x: number, z: number, pixel = 0): number {
  let sum = 0;
  PUDDLE_SCALES.forEach((s, i) => {
    const n = noise2(x * s.freq[0] + s.offset[0], z * s.freq[1] + s.offset[1]);
    const fade = i === 1 ? PUDDLE_MID_FADE : i === 2 ? PUDDLE_FINE_FADE : null;
    sum += s.weight * (fade ? mix(0.5, n, 1 - smoothstep(fade[0], fade[1], pixel)) : n);
  });
  return sum;
}
