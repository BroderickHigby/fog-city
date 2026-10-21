// How a dodge (src/sim/dodge.ts: a dive out of a vehicle's way, then a moment to recover) is
// drawn. Pure: no three.js, so tests/render/dodge-pose.test.ts checks it without WebGL. The sim
// says where the body is and how high it hops (its y includes the hop); this says how it looks.
//
// People (the procedural person, person.ts; the player's walker too):
//  - dive: they turn into the dive and leap, body pitching forward to a flat "superman" stretch
//    with both arms thrown out ahead and the legs kicked back, then tuck and land in a forward
//    roll, coming up crouched.
//  - the clearance override's leap (dodge.leap): a big arc from where they were to where the sim
//    put them, drawn along it (the sim has them at the landing at once), with a tucked front flip
//    at the top.
//  - recover: up from a crouch, then a startled pose (arms flung up, a little shake), then
//    brushing themselves off, then back to their walk's heading. Comic, never hurt-looking: no
//    lying still, no limp limbs.
// Robots: the Footman (errand robot) hops aside leaning into it with its arms out; the Trundle
// (sidewalk bot) skids, its body swinging round and tipping toward the dive with a small hop,
// then rocks back level. Both are upright again before they move on.

/** The parts of a DodgeState the renderer reads (src/sim/contract.ts DodgeState). */
export interface DodgeLike {
  phase: "dive" | "recover";
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  t: number;
  dur: number;
  hop: number;
  leap: boolean;
}

export interface PersonPose {
  /** Draw at (x, z) instead of the sim's position (a leap, along its arc), or null to use the sim's. */
  x: number | null;
  z: number | null;
  /** Compass bearing to face (renderer: rotation.y = -heading). */
  heading: number;
  /** Lean about the body's right axis, rad (- = forward), turning about a point `pivot` metres above the feet. */
  pitch: number;
  pivot: number;
  /** Lean to the side, rad (+ = right side down). */
  roll: number;
  /** Lift above the drawn feet, metres (on top of the sim's hop; - = down into a crouch). */
  lift: number;
  /** Height squash 0..1 (1 = none): the curl of a roll or a crouch. */
  squash: number;
  /** Arms: [forward swing, outward swing] rad, left and right; legs: forward swing rad. (+ swings forward / out.) */
  armL: [number, number];
  armR: [number, number];
  legL: number;
  legR: number;
}

export interface RobotPose {
  /** Draw at (x, z) instead of the sim's position, or null. */
  x: number | null;
  z: number | null;
  /** Yaw to draw with (the skid swings it), compass bearing. */
  heading: number;
  /** Nose-up pitch and right-down roll, rad. */
  pitch: number;
  roll: number;
  /** Limb swing for the Footman's arms and legs (-1..1, times its gait gain). */
  swing: number;
}

const TAU = Math.PI * 2;

function wrap(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smoothstep from 0 at a to 1 at b. */
function ease(v: number, a: number, b: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The compass bearing of a dive (from its start to its landing), or `fallback` for one that does not move. */
export function diveBearing(d: Readonly<DodgeLike>, fallback: number): number {
  const dx = d.tx - d.sx;
  const dz = d.tz - d.sz;
  return dx * dx + dz * dz > 1e-8 ? Math.atan2(dx, -dz) : fallback;
}

/**
 * The phase's progress 0..1 at render time. The renderer draws between the previous tick's state
 * (alpha 0) and this one's (alpha 1), so the moment drawn is t - 1 + alpha ticks into the phase.
 */
export function progress(d: Readonly<DodgeLike>, alpha: number): number {
  return d.dur > 0 ? clamp01((d.t - 1 + alpha) / d.dur) : 1;
}

/**
 * A person's pose in a dodge. `walk` is the heading they had (the sim keeps it through the
 * dodge), `alpha` how far the frame is from the previous tick to this one (progress), `time` a
 * running clock (s, for the startled shake). Fills and returns `out`.
 */
export function personDodgePose(d: Readonly<DodgeLike>, walk: number, alpha: number, time: number, out: PersonPose): PersonPose {
  const dive = diveBearing(d, walk);
  const u = progress(d, alpha);
  out.x = null;
  out.z = null;
  out.roll = 0;
  out.lift = 0;
  out.squash = 1;
  out.pivot = 0.95;
  if (d.phase === "dive" && d.leap) {
    // The override's leap: along the arc, a tucked front flip at the top.
    out.x = lerp(d.sx, d.tx, u);
    out.z = lerp(d.sz, d.tz, u);
    out.heading = dive;
    out.pivot = 0.9;
    out.pitch = -TAU * ease(u, 0.15, 0.85);
    const tuck = Math.sin(Math.PI * u);
    out.squash = 1 - 0.3 * tuck;
    out.armL = [2.4 * tuck, -0.5 * tuck];
    out.armR = [2.4 * tuck, 0.5 * tuck];
    out.legL = 1.3 * tuck;
    out.legR = 1.3 * tuck;
    return out;
  }
  if (d.phase === "dive") {
    out.heading = walk + wrap(dive - walk) * ease(u, 0, 0.2);
    if (u < 0.55) {
      // Launch to a flat stretch: arms out ahead, legs kicked back.
      const k = ease(u, 0, 0.45);
      out.pitch = -1.35 * k;
      out.armL = [2.9 * k, -0.25 * k];
      out.armR = [2.9 * k, 0.25 * k];
      out.legL = -0.35 * k;
      out.legR = -0.15 * k;
      return out;
    }
    // Tuck and roll: a curled forward roll about the middle of the body, landing crouched.
    const k = (u - 0.55) / 0.45;
    out.pivot = 0.9;
    // (A full turn and on to the crouch's lean: -TAU - 0.35, the same pose as -0.35.)
    out.pitch = -1.35 - (TAU - 1.0) * ease(k, 0, 0.9);
    const tuck = Math.sin(Math.PI * clamp01(k * 1.2));
    out.squash = 1 - 0.35 * tuck;
    out.lift = -0.25 * ease(k, 0.6, 1);
    out.armL = [lerp(2.9, 1.2, ease(k, 0, 0.3)), -0.2];
    out.armR = [lerp(2.9, 1.2, ease(k, 0, 0.3)), 0.2];
    out.legL = Math.max(1.4 * tuck, 0.9 * ease(k, 0.7, 1));
    out.legR = out.legL;
    return out;
  }
  // Recover: up from a crouch, startled, brush off, back to the walk.
  out.heading = dive + wrap(walk - dive) * ease(u, 0.75, 1);
  const up = ease(u, 0, 0.3);
  out.pitch = -0.35 * (1 - up);
  out.pivot = 0.9;
  out.lift = -0.25 * (1 - up);
  out.legL = 0.9 * (1 - up);
  out.legR = 0.9 * (1 - up);
  if (u < 0.3) {
    out.armL = [1.2 * (1 - up), -0.2 * (1 - up)];
    out.armR = [1.2 * (1 - up), 0.2 * (1 - up)];
    return out;
  }
  if (u < 0.65) {
    // Startled: arms flung up and out, a quick shake.
    const k = ease(u, 0.3, 0.38) * (1 - ease(u, 0.58, 0.65));
    const shake = Math.sin(time * 38) * 0.08 * k;
    out.armL = [2.7 * k, -0.6 * k + shake];
    out.armR = [2.7 * k, 0.6 * k - shake];
    out.roll = shake * 0.5;
    return out;
  }
  // Brushing off: the right hand swipes down the front, twice.
  const k = (1 - ease(u, 0.9, 1)) * ease(u, 0.65, 0.7);
  out.armL = [0.2 * k, -0.1 * k];
  out.armR = [(0.9 + 0.5 * Math.sin((u - 0.65) * 4 * TAU)) * k, (-0.35 + 0.15 * Math.sin((u - 0.65) * 4 * TAU)) * k];
  return out;
}

/** A robot's pose in a dodge: the Footman hops aside, the Trundle skids. Fills and returns `out`. */
export function robotDodgePose(kind: "errandRobot" | "sidewalkBot", d: Readonly<DodgeLike>, walk: number, alpha: number, out: RobotPose): RobotPose {
  const dive = diveBearing(d, walk);
  const u = progress(d, alpha);
  out.x = null;
  out.z = null;
  out.pitch = 0;
  out.roll = 0;
  out.swing = 0;
  out.heading = walk;
  // Which way the dive goes relative to the body: + = to its right.
  const side = Math.sin(wrap(dive - walk));
  if (d.phase === "dive" && d.leap) {
    out.x = lerp(d.sx, d.tx, u);
    out.z = lerp(d.sz, d.tz, u);
  }
  if (kind === "sidewalkBot") {
    if (d.phase === "dive") {
      // Skid: swing round a quarter turn and back, tipping onto the outside wheels.
      const k = Math.sin(Math.PI * u);
      out.heading = walk + (side >= 0 ? 1 : -1) * 0.9 * k;
      out.roll = (side >= 0 ? -1 : 1) * 0.3 * k;
    } else {
      // Rock back level.
      const k = 1 - ease(u, 0, 0.6);
      out.roll = Math.sin(u * TAU * 2) * 0.08 * k;
    }
    return out;
  }
  if (d.phase === "dive") {
    // The Footman hops aside, leaning into it, arms out.
    const k = Math.sin(Math.PI * u);
    out.roll = (side >= 0 ? 1 : -1) * 0.35 * k * Math.abs(side);
    out.pitch = -0.25 * k * Math.cos(wrap(dive - walk));
    out.swing = k;
  } else {
    // Lands, steadies itself.
    const k = 1 - ease(u, 0, 0.5);
    out.swing = Math.sin(u * TAU * 3) * 0.4 * k;
  }
  return out;
}

export function newPersonPose(): PersonPose {
  return { x: null, z: null, heading: 0, pitch: 0, pivot: 0.95, roll: 0, lift: 0, squash: 1, armL: [0, 0], armR: [0, 0], legL: 0, legR: 0 };
}

export function newRobotPose(): RobotPose {
  return { x: null, z: null, heading: 0, pitch: 0, roll: 0, swing: 0 };
}
