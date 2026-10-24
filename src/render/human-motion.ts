// How a human body is drawn getting out of a car's way (the sim's dodge, src/sim/dodge.ts), for
// every renderer that draws people: the player's avatar (player-body.ts), the placeholder crowd
// (agent-layer.ts, person.ts) and any skinned crowd built on the same Rocketbox skeleton.
//  - motionFor: which clip plays (clip names as in public/models/generic-player.glb and
//    public/models/anim/dodge-clips.glb).
//  - leapDrawOffset: the clearance override puts a body somewhere at once (the hard guarantee: it
//    must be out of the vehicle's reach this tick); it is drawn as a shove aside over the leap's
//    ticks instead, eased, never faster than the sim's OVERRIDE_DRAW_MPS and never off the ground.
import type { DodgeState } from "../sim/contract.ts";
import { OVERRIDE_DRAW_MPS } from "../sim/dodge.ts";

/** Clips a human body plays. idle/walk/run: generic-player.glb; the rest: anim/dodge-clips.glb. */
export type Motion = "idle" | "walk" | "run" | "sprint" | "runStart" | "runStop" | "recover" | "stumble" | "flinch";
export const MOTIONS: readonly Motion[] = ["idle", "walk", "run", "sprint", "runStart", "runStop", "recover", "stumble", "flinch"];
/** Played once and held, not looped. */
export const ONCE: ReadonlySet<Motion> = new Set(["runStart", "runStop", "stumble", "flinch"]);
/** A dive no longer than this is a sidestep (sim/dodge.ts SIDESTEP_M): it flinches rather than runs. */
const SIDESTEP_M = 1.4;
/** The startle at the start of a dodge, seconds (person.ts STARTLE_S). */
const STARTLE_S = 0.25;

/**
 * Which clip a body plays: walking or standing by its speed; dodging by its phase (a startle,
 * then a run, sprint or sidestep by speed; the override's leap as a stumble; recovering, brushing
 * off). `speed` is how fast it is drawn moving (whichever way: a sidestep moves sideways); `have`
 * says which clips loaded (a missing one falls back to the plain locomotion).
 */
export function motionFor(speed: number, dodge: Readonly<DodgeState> | null, have: (m: Motion) => boolean): Motion {
  const v = Math.abs(speed);
  const locomotion: Motion = v >= 4.2 && have("sprint") ? "sprint" : v >= 2.4 && have("run") ? "run" : v >= 0.2 && have("walk") ? "walk" : "idle";
  if (!dodge) return locomotion;
  if (dodge.phase === "recover") return have("recover") ? "recover" : "idle";
  if (dodge.leap) return have("stumble") ? "stumble" : "idle";
  const len = Math.hypot(dodge.tx - dodge.sx, dodge.tz - dodge.sz);
  if (len <= SIDESTEP_M && have("flinch")) return "flinch";
  if (dodge.t / 60 < STARTLE_S && have("runStart")) return "runStart";
  return locomotion === "idle" || locomotion === "walk" ? (have("run") ? "run" : locomotion) : locomotion;
}

/** Smoothstep: eases in and out; its steepest slope is 1.5. */
function ease(u: number): number {
  return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
}

/**
 * Where to draw a body the override has just moved, relative to where the sim has it: from
 * where it was (sx, sz) to where it is (tx, tz), eased over the leap's ticks. `alpha` is the
 * fraction of a tick since the state the dodge comes from. Fills `out` with the offset to add to
 * the sim's position (0, 0 for anything but an override's leap, or once it is over); y is never
 * touched. When the leap is too long to draw at OVERRIDE_DRAW_MPS over its ticks (never in
 * practice: the sim gives a leap the ticks it needs, dodge.ts leapShape), it is drawn where it is.
 */
export function leapDrawOffset(dodge: Readonly<DodgeState> | null | undefined, alpha: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = 0;
  out.z = 0;
  if (!dodge || !dodge.leap || dodge.phase !== "dive" || dodge.dur <= 0) return out;
  const dx = dodge.sx - dodge.tx;
  const dz = dodge.sz - dodge.tz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist * 1.5 > OVERRIDE_DRAW_MPS * (dodge.dur / 60) + 1e-9) return out;
  const k = 1 - ease((dodge.t + alpha) / dodge.dur);
  out.x = dx * k;
  out.z = dz * k;
  return out;
}
