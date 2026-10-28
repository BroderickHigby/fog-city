// Distant lit-window clusters: the constants and a CPU reference of the shader math in
// node-materials.ts (distantWindowLight). Adapted from Slop New York's distantWindowLight
// (Mr.doob, MIT; js/tsl-materials.js:166-188, third-party notice in assets/imports/slop-new-york).
//
// Once a window shrinks below about three pixels it cannot be drawn as a window. Lighting every
// window to a flat mean glow reads as a dim wash, and testing one point per pixel against a hard
// cell grid aliases into white noise. Instead lit windows are grouped into world-anchored clusters
// two cells wide or more, whose lit core is box-filtered over the pixel footprint: the same lit
// area lands on the screen whichever way the camera moves, so the skyline sparkles without
// shimmering. Two neighbouring power-of-two cluster sizes cross-fade so a cluster never pops.
//
// This file has no three.js import: the unit tests (tests/render/window-clusters.test.ts) run
// the reference to check the two properties the shader relies on, that mean brightness equals the
// lit probability at every distance and that the output is continuous in camera position.

/** The lit core of a cluster cell along each axis: its middle half. */
export const CLUSTER_CORE_LO = 0.25;
export const CLUSTER_CORE_HI = 0.75;
/** Brightness gain that keeps the mean: 1 / (core width x core height). */
export const CLUSTER_GAIN = 4;
/** The smallest cluster, in window cells. */
export const CLUSTER_MIN_SCALE = 2;
/** Cluster size in cells is about this many pixels' footprint, rounded down to a power of two. */
export const CLUSTER_PIXELS = 4;
/** Pixel footprint (in window cells) over which the per-window room shading hands over to clusters. */
export const WINDOW_LOD_START = 0.28;
export const WINDOW_LOD_END = 0.8;
/** Share of lit clusters that fade on and off slowly; they are lit this share of the time overall. */
export const CLUSTER_SWITCHY = 0.22;
/** The slowest and fastest switching rate, radians per second. */
export const CLUSTER_SWITCH_RATE: readonly [number, number] = [0.05, 0.16];

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const fract = (x: number): number => x - Math.floor(x);
export const smoothstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** How far this pixel is into the cluster regime, 0 (window cells still resolve) to 1. */
export function windowLod(footprintX: number, footprintY: number): number {
  return smoothstep(WINDOW_LOD_START, WINDOW_LOD_END, Math.max(footprintX, footprintY));
}

/** Octave of the cluster size: the cluster is 2^floor(level) cells and cross-fades into the next. */
export function clusterLevel(footprintX: number, footprintY: number): number {
  return Math.log2(Math.max(Math.max(footprintX, footprintY) * CLUSTER_PIXELS, CLUSTER_MIN_SCALE));
}

/** Share of the interval [x - width/2, x + width/2] in which fract(t) lies in [a, b] (exact box filter). */
export function boxPulse(x: number, a: number, b: number, width: number): number {
  const hw = Math.max(width, 0.0001) * 0.5;
  const integral = (t: number): number => Math.floor(t) * (b - a) + clamp(fract(t), a, b) - a;
  return (integral(x + hw) - integral(x - hw)) / (hw * 2);
}

/** Per-cluster decision source: a number in [0, 1) for the cluster cell (ix, iy) of this size. */
export type ClusterHash = (ix: number, iy: number, size: number) => number;

function cluster(gx: number, gy: number, fx: number, fy: number, size: number, probability: number, hash: ClusterHash): number {
  const px = gx / size, py = gy / size;
  const lit = hash(Math.floor(px), Math.floor(py), size) >= 1 - probability ? 1 : 0;
  const coverage = boxPulse(fract(px), CLUSTER_CORE_LO, CLUSTER_CORE_HI, fx / size)
    * boxPulse(fract(py), CLUSTER_CORE_LO, CLUSTER_CORE_HI, fy / size);
  return lit * coverage * CLUSTER_GAIN;
}

/**
 * Lit-window brightness at window-grid position (gx, gy) for a pixel whose footprint is
 * (fx, fy) cells: the mean is `probability`, concentrated in clusters.
 */
export function clusterLight(gx: number, gy: number, fx: number, fy: number, probability: number, hash: ClusterHash): number {
  const level = clusterLevel(fx, fy), scale = 2 ** Math.floor(level);
  const t = smoothstep(0, 1, fract(level));
  return cluster(gx, gy, fx, fy, scale, probability, hash) * (1 - t) + cluster(gx, gy, fx, fy, scale * 2, probability, hash) * t;
}

/**
 * The slow on/off cycle of a switchy cluster: lit `probability` of the time, with a fade of a few
 * seconds at each edge. `phase` is the cluster's own offset in radians.
 */
export function switchLevel(timeSeconds: number, rate: number, phase: number, probability: number): number {
  // sin(theta) > cos(pi p) for a share p of a turn, so the cluster keeps its mean.
  const threshold = Math.cos(Math.PI * probability);
  return smoothstep(threshold - 0.12, threshold + 0.12, Math.sin(timeSeconds * rate + phase));
}
