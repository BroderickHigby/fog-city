// The player's on-foot gait as one phase-locked blend of the Mixamo walk, jog and run
// (public/models/mixamo-motion.json, assets/imports/mixamo/build.ts), for player-body.ts.
//
// Each clip is measured, not assumed (tests/render/gait.test.ts measures the shipped bank):
// its ground speed is how fast its planted foot moves back under the hip at mid-stance, its
// cycle is one stride (left and right step), and its anchor is where in the clip the left foot
// is at mid-stance. The clips are blended by ground speed (walk, then the jog, then the run)
// and all play at one shared stride phase, so a blend never mixes a left step with a right one
// and a change of blend never pops a foot. The phase advances at the ground speed over the
// blended stride, so a planted foot keeps pace with the ground, up to a cadence cap: past it
// (the sprint) the stride stays at the cap and the feet slip rather than flutter.
//
// The run clip (natural pace 3.66 m/s) carries the default on-foot pace (3.5 m/s). Its swing
// knee peaks near 110 degrees, a sprinter's heel kick; at a jog real runners peak near 90-100,
// so `limitKnee` softens swing flexion above KNEE_SOFT_RAD at jogging speeds and fades out
// toward the sprint. Stance and the walk are never touched.
import * as THREE from "three";

export type GaitClip = "walk" | "jog" | "run";
export const GAIT_CLIPS: readonly GaitClip[] = ["walk", "jog", "run"];

export interface GaitCycle {
  /** Ground speed the clip's planted foot keeps at rate 1, m/s. */
  speed: number;
  /** Strides (left + right step) in the clip. */
  cycles: number;
  /** Fraction of a stride into the clip at which the left foot is at mid-stance. */
  anchor: number;
  /** Slowest and fastest playback rate the clip is drawn at (beyond them the feet slip). */
  minRate: number;
  maxRate: number;
}

/** The shipped Mixamo bank's walk, jog and run, measured (gait.test.ts re-measures them). */
export const MIXAMO_GAIT: Readonly<Record<GaitClip, Readonly<GaitCycle>>> = {
  walk: { speed: 1.53, cycles: 1, anchor: 0.484, minRate: 0.6, maxRate: 1.5 },
  jog: { speed: 1.77, cycles: 3, anchor: 0.336, minRate: 0.7, maxRate: 1.3 },
  run: { speed: 3.66, cycles: 1, anchor: 0.428, minRate: 0.7, maxRate: 1.2 },
};

/** Ground speeds (m/s) over which the walk hands over to the jog, and the jog to the run. */
export const WALK_TO_JOG: readonly [number, number] = [1.7, 2.2];
export const JOG_TO_RUN: readonly [number, number] = [2.2, 3.4];
/** The blend follows the ground speed at this rate, 1/s: a hitch in speed never jerks the legs. */
export const GAIT_SPEED_RATE = 12;

/** Swing knee flexion above this angle (from the bind pose) is softened at a jog, radians. */
export const KNEE_SOFT_RAD = (50 * Math.PI) / 180;
/** At full strength, flexion above KNEE_SOFT_RAD is kept at this fraction. */
export const KNEE_GAIN = 0.72;
/** Ground speeds (m/s): the knee softening fades in over the first pair and out over the second. */
export const KNEE_FADE_IN: readonly [number, number] = [1.7, 2.2];
export const KNEE_FADE_OUT: readonly [number, number] = [4.4, 6.5];

function smooth(u: number): number {
  return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
}
function ramp(v: number, [a, b]: readonly [number, number]): number {
  return smooth((v - a) / (b - a));
}

export type GaitWeights = Record<GaitClip, number>;

/** Each clip's share of the blend at a ground speed; they sum to 1 and change continuously. */
export function gaitWeights(speed: number, out: GaitWeights = { walk: 0, jog: 0, run: 0 }): GaitWeights {
  const v = Math.abs(speed);
  const toJog = ramp(v, WALK_TO_JOG), toRun = ramp(v, JOG_TO_RUN);
  out.walk = 1 - toJog;
  out.jog = toJog * (1 - toRun);
  out.run = toJog * toRun;
  return out;
}

/** Strides per second at a ground speed: the planted foot keeps pace with the ground, within each clip's rate limits. */
export function gaitFrequency(speed: number, weights: Readonly<GaitWeights>, durations: Readonly<Record<GaitClip, number>>, gait: Readonly<Record<GaitClip, Readonly<GaitCycle>>> = MIXAMO_GAIT): number {
  let stride = 0, lo = 0, hi = 0;
  for (const clip of GAIT_CLIPS) {
    const w = weights[clip];
    if (!(w > 0)) continue;
    const g = gait[clip], period = durations[clip] / g.cycles;
    stride += w * g.speed * period;
    lo += (w * g.minRate) / period;
    hi += (w * g.maxRate) / period;
  }
  if (!(stride > 0)) return 0;
  return Math.max(lo, Math.min(hi, Math.abs(speed) / stride));
}

/** A clip's time at a shared stride phase (strides since the left foot's mid-stance). */
export function gaitClipTime(clip: GaitClip, phase: number, duration: number, gait: Readonly<Record<GaitClip, Readonly<GaitCycle>>> = MIXAMO_GAIT): number {
  const g = gait[clip];
  const u = (((phase + g.anchor) % g.cycles) + g.cycles) % g.cycles;
  return (u / g.cycles) * duration;
}

/** Phase wraps here: a whole number of strides of every clip (the jog holds 3). */
export const GAIT_PHASE_WRAP = 3;

/** How strongly the swing knee is softened at a ground speed, 0..1. */
export function kneeLimitStrength(speed: number): number {
  const v = Math.abs(speed);
  return ramp(v, KNEE_FADE_IN) * (1 - ramp(v, KNEE_FADE_OUT));
}

/** Knee flexion (radians from the bind pose) after softening at `strength`. */
export function limitKnee(angle: number, strength: number): number {
  if (!(angle > KNEE_SOFT_RAD) || !(strength > 0)) return angle;
  const gain = 1 - (1 - KNEE_GAIN) * Math.min(1, strength);
  return KNEE_SOFT_RAD + (angle - KNEE_SOFT_RAD) * gain;
}

const _delta = new THREE.Quaternion();
const _posed = new THREE.Quaternion();

/** One knee: the calf bone and its bind-pose rotation. */
export interface Knee { bone: THREE.Object3D; rest: THREE.Quaternion }

/** Soften each knee's posed flexion in place (call after the mixer has posed the skeleton). */
export function softenKnees(knees: readonly Knee[], strength: number): void {
  if (!(strength > 0)) return;
  for (const { bone, rest } of knees) {
    _delta.copy(rest).invert().multiply(bone.quaternion);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_delta.w)));
    const limited = limitKnee(angle, strength);
    if (!(angle > 0) || limited === angle) continue;
    _posed.copy(bone.quaternion);
    bone.quaternion.copy(rest).slerp(_posed, limited / angle);
  }
}
